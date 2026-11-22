"""Localhost bridge from the Awarely dashboard to a Bluetooth XIAO-BUZZ.

Run this on the computer that should own the motor:

    python3 -m pip install -r hardware/requirements-buzz.txt
    python3 hardware/buzz_bridge.py

Bluetooth has to be on, and the board has to be advertising as XIAO-BUZZ.
The dashboard connects from the browser instead. Run this bridge only when
that browser cannot use Web Bluetooth. Only one host can hold the link.
"""
import argparse
import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from driver_buzz import BleBuzzMotor, DriverBuzz, InjectedState

DEFAULT_ORIGINS = (
    "http://localhost:4317", "http://127.0.0.1:4317", "http://awarely.localhost:4317",
    "http://localhost:8080", "http://127.0.0.1:8080",
)


def make_buzz_handler(buzz, allowed_origins):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def origin_headers(self):
            origin = self.headers.get("Origin")
            if origin in allowed_origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

        def send_json(self, value, status=200):
            content = json.dumps(value, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.origin_headers()
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        def origin_allowed(self):
            origin = self.headers.get("Origin")
            return origin is None or origin in allowed_origins

        def do_OPTIONS(self):
            if not self.origin_allowed():
                self.send_json({"error": "Website origin is not allowed"}, 403)
                return
            self.send_response(204)
            self.origin_headers()
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            if urlsplit(self.path).path != "/api/buzz":
                self.send_json({"error": "Not found"}, 404)
                return
            self.send_json(buzz.status())

        def do_POST(self):
            self.close_connection = True
            route = urlsplit(self.path).path
            if route not in ("/api/buzz/reading", "/api/buzz/test"):
                self.send_json({"error": "Not found"}, 404)
                return
            if not self.origin_allowed():
                self.send_json({"error": "Website origin is not allowed"}, 403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1024 or self.headers.get_content_type() != "application/json":
                    raise ValueError("Send a small JSON request")
                self.connection.settimeout(3)
                value = json.loads(self.rfile.read(length))
                if route == "/api/buzz/test":
                    if value != {}:
                        raise ValueError("Test body must be an empty object")
                    result = buzz.test()
                else:
                    result = buzz.apply_reading(value)
                self.send_json(result)
            except (ValueError, TypeError, TimeoutError):
                self.send_json({"error": "Invalid buzz reading"}, 400)

        def log_message(self, fmt, *args):
            logging.info("%s %s", self.client_address[0], urlsplit(self.path).path)

    return Handler


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Drive a Bluetooth XIAO-BUZZ from the Awarely dashboard")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8091)
    parser.add_argument("--allow-origin", action="append", default=[])
    args = parser.parse_args(argv)
    if args.host != "127.0.0.1":
        parser.error("The buzz bridge stays on 127.0.0.1 so the motor is not exposed on the network")
    if not 1 <= args.port <= 65535:
        parser.error("Invalid port")
    origins = list(DEFAULT_ORIGINS)
    for origin in args.allow_origin:
        parsed = urlsplit(origin)
        if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
            parser.error("Allowed origins must be exact http(s) origins without paths")
        origins.append(origin)
    args.origins = tuple(dict.fromkeys(origins))
    return args


def main():
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    try:
        motor = BleBuzzMotor()
    except ImportError as error:
        raise SystemExit("Install bleak first: python3 -m pip install -r hardware/requirements-buzz.txt") from error
    buzz = DriverBuzz(InjectedState(), motor)
    server = ThreadingHTTPServer((args.host, args.port), make_buzz_handler(buzz, args.origins))
    server.daemon_threads = True
    motor.start()
    buzz.start()
    logging.info("XIAO-BUZZ bridge on http://%s:%s", args.host, args.port)
    try:
        server.serve_forever(poll_interval=.2)
    except KeyboardInterrupt:
        pass
    finally:
        buzz.close()
        motor.close()
        server.server_close()


if __name__ == "__main__":
    main()
