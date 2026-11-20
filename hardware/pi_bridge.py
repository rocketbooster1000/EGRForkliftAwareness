"""Authenticated HTTP adapter for the supplied DepthCamera API.

Local-only by default. LAN binding is an explicit startup option. Camera/GPIO
imports are delayed so protocol tests do not require Raspberry Pi hardware.
"""
from __future__ import annotations
import argparse
import json
import logging
import math
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from driver_buzz import BleBuzzMotor, DriverBuzz
from driver_light import DriverLight

STALE_SECONDS = 3.0
SENSOR_IDS = ("boom", "rear", "left", "right")
STATIC_FILES = {"/": "index.html", **{f"/{name}": name for name in (
    "index.html", "styles.css", "logic.js", "audio.js", "app.js", "pi.js", "light.js", "buzz.js"
)}}
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"}


def validate_pose(value):
    if not isinstance(value, dict):
        raise ValueError("Pose must contain x_m, y_m and yaw_deg")
    result = {}
    for key, maximum in (("x_m", 100), ("y_m", 100), ("yaw_deg", 360)):
        number = value.get(key)
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number) or abs(number) > maximum:
            raise ValueError(f"Invalid pose {key}")
        result[key] = float(number)
    return result


def measurement(sensor, distance_cm, max_distance_m, scale=1.0, pose=None):
    """The input is calibrated centimeters from DepthCamera.get_distance()."""
    valid = (not isinstance(distance_cm, bool) and isinstance(distance_cm, (int, float))
             and math.isfinite(distance_cm) and distance_cm >= 0)
    meters = distance_cm / 100.0 if valid else None
    limit = max_distance_m * scale
    status = "valid" if valid else "invalid"
    # gpiozero's saturated maximum is ambiguous; do not invent a precise distance.
    if valid and meters >= limit * 0.999:
        meters, status = None, "at_limit"
    elif valid and meters > 100:
        meters, status = None, "invalid"
    packet = {"sensor": sensor, "source": "ultrasonic", "distance_m": meters,
              "range_status": status, "sensor_max_m": limit}
    if pose is not None:
        packet["pose"] = validate_pose(pose)
    return packet


class StreamState:
    def __init__(self):
        self.condition = threading.Condition()
        self.packet = self.jpeg = None
        self.updated = 0.0
        self.sequence = 0
        self.error = None
        self.stop = threading.Event()

    def publish(self, packet, jpeg):
        with self.condition:
            self.sequence += 1
            self.packet = {**packet, "sequence": self.sequence}
            self.jpeg = jpeg
            self.updated = time.monotonic()
            self.error = None
            self.condition.notify_all()

    def snapshot(self):
        with self.condition:
            if self.packet is None:
                return {"ready": False, "error": self.error or "Waiting for the first camera frame"}
            packet = dict(self.packet)
            age = packet.get("capture_age_ms", 0) + (time.monotonic() - self.updated) * 1000
            packet.update(ready=True, age_ms=round(age), error=self.error)
            return packet

    def fail(self, error):
        with self.condition:
            self.error = str(error)
            self.condition.notify_all()


class CaptureWorker(threading.Thread):
    def __init__(self, state, args):
        super().__init__(name="pi-camera-capture", daemon=True)
        self.state, self.args = state, args

    def pose(self):
        if self.args.pose_file:
            try:
                return validate_pose(json.loads(Path(self.args.pose_file).read_text()))
            except (OSError, ValueError, TypeError):
                return None
        return validate_pose(dict(zip(("x_m", "y_m", "yaw_deg"), self.args.pose))) if self.args.pose else None

    def run(self):
        camera = sensor = dc = None
        try:
            import cv2
            from depth_camera import Camera, DepthCamera, Ultrasonic
            camera = Camera(size=(640, 480))
            sensor = Ultrasonic(trigger=self.args.trigger, echo=self.args.echo, max_distance=self.args.max_distance)
            dc = DepthCamera(camera=camera, sensor=sensor, cal_file=self.args.cal_file)
            scale = dc.cal.get("scale", 1.0)
            if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not math.isfinite(scale) or scale <= 0:
                raise ValueError("Calibration scale must be a positive finite number")
            people, people_at, new_until, n = None, 0.0, 0.0, 0
            while not self.state.stop.is_set():
                started = time.monotonic()
                frame, distance_cm = dc.frame(), dc.get_distance()
                packet = measurement(self.args.sensor, distance_cm, self.args.max_distance, scale, self.pose())
                if dc.new_object(frame=frame):
                    new_until = time.monotonic() + 1.0
                if not self.args.no_people and n % self.args.people_every == 0:
                    people, people_at = dc.detect_people(frame), time.monotonic()
                n += 1
                fresh_people = people if people is not None and time.monotonic() - people_at < 1.5 else None
                target = {"x": int(dc.cal["x"]), "y": int(dc.cal["y"])}
                packet.update(
                    detections={"people": [list(box) for box in fresh_people] if fresh_people is not None else None,
                                "new_object": time.monotonic() < new_until},
                    calibration={"target": target, "scale": scale},
                    camera={"width": int(frame.shape[1]), "height": int(frame.shape[0])})
                image = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
                for x, y, width, height in fresh_people or []:
                    cv2.rectangle(image, (x, y), (x + width, y + height), (255, 255, 0), 2)
                    cv2.putText(image, "person", (x, max(15, y - 5)), cv2.FONT_HERSHEY_SIMPLEX, .5, (255, 255, 0), 1)
                cv2.drawMarker(image, (target["x"], target["y"]), (120, 240, 170), cv2.MARKER_CROSS, 30, 2)
                label = (f"Ultrasonic: {packet['distance_m'] / 0.3048:.2f} ft" if packet["distance_m"] is not None
                         else "Ultrasonic: at limit / unavailable")
                cv2.putText(image, label, (12, image.shape[0] - 18), cv2.FONT_HERSHEY_SIMPLEX, .6, (120, 240, 170), 2)
                if packet["detections"]["new_object"]:
                    cv2.putText(image, "NEW OBJECT", (12, 30), cv2.FONT_HERSHEY_SIMPLEX, .7, (0, 230, 255), 2)
                ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 80])
                if not ok:
                    raise RuntimeError("Camera frame could not be encoded")
                packet["capture_age_ms"] = round((time.monotonic() - started) * 1000)
                self.state.publish(packet, encoded.tobytes())
                self.state.stop.wait(max(0, 1 / self.args.fps - (time.monotonic() - started)))
        except Exception as error:
            logging.exception("Camera capture stopped")
            self.state.fail(error)
        finally:
            if dc is not None:
                dc.close()
            else:
                if camera is not None:
                    camera.close()
                if sensor is not None:
                    sensor.close()


def make_handler(state, site_root, token, allowed_origins=(), light=None, buzz=None):
    if not token:
        raise ValueError("A connection key is required")

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def origin_headers(self):
            origin = self.headers.get("Origin")
            if origin in allowed_origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

        def send_headers(self, status, content_type, length=None):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.origin_headers()
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            if length is not None:
                self.send_header("Content-Length", str(length))
            self.end_headers()

        def authorized(self):
            # Image elements cannot send an Authorization header; their key is query-only.
            supplied = self.headers.get("Authorization", "").removeprefix("Bearer ")
            if not supplied:
                supplied = parse_qs(urlsplit(self.path).query).get("key", [""])[0]
            return secrets.compare_digest(supplied.encode(), token.encode())

        def send_json(self, value, status=200):
            content = json.dumps(value, allow_nan=False).encode()
            self.send_headers(status, "application/json", len(content))
            self.wfile.write(content)

        def do_OPTIONS(self):
            origin = self.headers.get("Origin")
            if origin not in allowed_origins:
                self.send_json({"error": "Website origin is not allowed"}, 403)
                return
            self.send_response(204)
            self.origin_headers()
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            route = urlsplit(self.path).path
            try:
                if route in ("/api/reading", "/api/light", "/api/buzz", "/health", "/video.mjpg") and not self.authorized():
                    self.send_json({"error": "A valid Pi connection key is required"}, 401)
                    return
                if route == "/api/reading":
                    self.send_json(state.snapshot())
                elif route == "/api/light":
                    self.send_json(light.status() if light else {"available": False, "reason": "not_configured"})
                elif route == "/api/buzz":
                    self.send_json(buzz.status() if buzz else {"available": False, "reason": "not_configured"})
                elif route == "/health":
                    packet = state.snapshot()
                    healthy = packet.get("ready") and packet.get("age_ms", 3000) < 3000 and not packet.get("error")
                    self.send_json({"healthy": bool(healthy), **packet}, 200 if healthy else 503)
                elif route == "/video.mjpg":
                    self.stream_video()
                elif route in STATIC_FILES:
                    file = site_root / STATIC_FILES[route]
                    if not file.is_file():
                        self.send_json({"error": "Dashboard file missing"}, 404)
                        return
                    content = file.read_bytes()
                    self.send_headers(200, CONTENT_TYPES[file.suffix], len(content))
                    self.wfile.write(content)
                else:
                    self.send_json({"error": "Not found"}, 404)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

        def do_POST(self):
            # Mutations require a bearer header, never an image query-string key.
            self.close_connection = True
            supplied = self.headers.get("Authorization", "").removeprefix("Bearer ")
            if not secrets.compare_digest(supplied.encode(), token.encode()):
                self.send_json({"error": "A valid Pi connection key is required"}, 401)
                return
            origin = self.headers.get("Origin")
            same_origin = "http://" + self.headers.get("Host", "")
            if origin and origin != same_origin and origin not in allowed_origins:
                self.send_json({"error": "Website origin is not allowed"}, 403)
                return
            route = urlsplit(self.path).path
            routes = {"/api/light": light, "/api/light/test": light, "/api/buzz": buzz, "/api/buzz/test": buzz}
            if route not in routes:
                self.send_json({"error": "Not found"}, 404)
                return
            controller = routes[route]
            if controller is None or not controller.status()["available"]:
                message = "Start the Pi bridge with --buzz to use the Bluetooth motor" if route.startswith("/api/buzz") else "Start the Pi bridge with --light-pin to use the physical light"
                self.send_json({"error": message}, 409)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1024 or self.headers.get_content_type() != "application/json":
                    raise ValueError("Send a small JSON request")
                self.connection.settimeout(3)
                value = json.loads(self.rfile.read(length))
                if route.endswith("/test"):
                    if value != {}:
                        raise ValueError("Test body must be an empty object")
                    result = controller.test()
                else:
                    result = controller.configure(value)
                self.send_json(result)
            except (ValueError, TypeError, TimeoutError):
                message = "Invalid buzz settings: use enabled true/false and distances between 0.1 and 15 ft" if route.startswith("/api/buzz") else "Invalid light settings: use enabled true/false and a distance of 0.1–15 ft"
                self.send_json({"error": message}, 400)

        def stream_video(self):
            if not state.snapshot().get("ready"):
                self.send_json({"error": "Camera has no frame yet"}, 503)
                return
            self.send_headers(200, "multipart/x-mixed-replace; boundary=frame")
            self.connection.settimeout(5)
            sequence = 0
            while not state.stop.is_set():
                with state.condition:
                    state.condition.wait_for(lambda: state.sequence != sequence or state.stop.is_set(), timeout=1)
                    packet = state.snapshot()
                    if packet.get("age_ms", 3000) >= 3000 or state.stop.is_set():
                        break
                    if state.sequence == sequence:
                        continue
                    jpeg, sequence = state.jpeg, state.sequence
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n")
                self.wfile.flush()
            self.close_connection = True

        def log_message(self, fmt, *args):
            # Deliberately omit query strings so image connection keys never enter logs.
            if not self.path.startswith("/api/reading"):
                logging.info("%s %s", self.client_address[0], urlsplit(self.path).path)

    return Handler


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Stream your DepthCamera API into the Awarely.ai website")
    parser.add_argument("--host", default="127.0.0.1", help="Default: local-only. Use a LAN address explicitly for laptop access")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--sensor", choices=SENSOR_IDS, default="boom")
    parser.add_argument("--trigger", type=int, default=17, help="BCM trigger pin")
    parser.add_argument("--light-pin", type=int, help="Optional BCM GPIO for a driver LED; disabled until enabled in the UI")
    parser.add_argument("--buzz", action="store_true", help="Connect to a Bluetooth XIAO-BUZZ motor; disabled until enabled in the UI")
    parser.add_argument("--echo", type=int, default=18, help="BCM echo pin")
    parser.add_argument("--max-distance", type=float, default=4.0, help="Configured ultrasonic maximum in meters")
    parser.add_argument("--fps", type=float, default=10)
    parser.add_argument("--people-every", type=int, default=5)
    parser.add_argument("--no-people", action="store_true")
    parser.add_argument("--cal-file", default=str(Path(__file__).with_name("calibration.json")))
    parser.add_argument("--token-file", default=str(Path(__file__).with_name("bridge-token.txt")))
    parser.add_argument("--allow-origin", action="append", default=[], help="Additional exact website origin, e.g. http://localhost:4317")
    poses = parser.add_mutually_exclusive_group()
    poses.add_argument("--pose", type=float, nargs=3, metavar=("X_M", "Y_M", "YAW_DEG"))
    poses.add_argument("--pose-file", help="JSON pose file reread each frame for a moving boom")
    args = parser.parse_args(argv)
    if not (1 <= args.port <= 65535 and math.isfinite(args.fps) and 0 < args.fps <= 30 and args.people_every >= 1
            and math.isfinite(args.max_distance) and 0 < args.max_distance <= 100):
        parser.error("Invalid port, FPS, detection interval, or maximum distance")
    if args.light_pin is not None and (args.light_pin not in range(2, 28) or args.light_pin in (args.trigger, args.echo)):
        parser.error("Light pin must be an unused BCM GPIO between 2 and 27")
    if args.pose:
        try:
            validate_pose(dict(zip(("x_m", "y_m", "yaw_deg"), args.pose)))
        except ValueError as error:
            parser.error(str(error))
    for origin in args.allow_origin:
        parsed = urlsplit(origin)
        if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
            parser.error("Allowed origins must be exact http(s) origins without paths")
    return args


def connection_key(file):
    file = Path(file)
    if file.exists():
        key = file.read_text().strip()
        if len(key) < 24:
            raise ValueError("Connection key file must contain at least 24 characters")
        return key
    key = secrets.token_urlsafe(24)
    descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(key + "\n")
    return key


def main():
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    token = connection_key(args.token_file)
    state = StreamState()
    output = None
    if args.light_pin is not None:
        from gpiozero import LED
        output = LED(args.light_pin, initial_value=False)
    light = DriverLight(state, output)
    buzz_motor = None
    if args.buzz:
        try:
            buzz_motor = BleBuzzMotor()
            buzz_motor.start()
        except ImportError as error:
            raise SystemExit("Install bleak to use --buzz: python3 -m pip install -r hardware/requirements-buzz.txt") from error
    buzz = DriverBuzz(state, buzz_motor)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(state, Path(__file__).resolve().parent.parent, token, args.allow_origin, light, buzz))
    light.start()
    buzz.start()
    server.daemon_threads = True
    worker = CaptureWorker(state, args)
    worker.start()
    logging.info("Awarely.ai Pi bridge on %s:%s; connection key is in %s", args.host, args.port, args.token_file)
    try:
        server.serve_forever(poll_interval=.2)
    except KeyboardInterrupt:
        pass
    finally:
        state.stop.set()
        with state.condition:
            state.condition.notify_all()
        light.close()
        buzz.close()
        if buzz_motor is not None:
            buzz_motor.close()
        server.server_close()
        worker.join(timeout=5)


if __name__ == "__main__":
    main()
