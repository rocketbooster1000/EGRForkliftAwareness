"""Hardware-free checks for the Pi bridge protocol and protected HTTP routes."""
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from http.server import ThreadingHTTPServer
from pi_bridge import StreamState, connection_key, make_handler, measurement, parse_args, validate_pose

KEY = "fixture-key-for-loopback-tests-only"
ORIGIN = "http://127.0.0.1:4318"


class BridgeTests(unittest.TestCase):
    def test_centimeters_convert_and_sensor_limit_is_not_a_precise_measurement(self):
        self.assertEqual(measurement("boom", 125, 4)["distance_m"], 1.25)
        self.assertEqual(measurement("boom", 0, 4)["distance_m"], 0)
        self.assertEqual(measurement("boom", 600, 4, scale=2)["distance_m"], 6)
        self.assertEqual(measurement("boom", 400, 4)["range_status"], "at_limit")
        self.assertIsNone(measurement("boom", 400, 4)["distance_m"])
        for invalid in (float("nan"), float("inf"), -1, "125", True, None):
            self.assertEqual(measurement("boom", invalid, 4)["range_status"], "invalid")

    def test_pose_validation_and_local_only_default(self):
        self.assertEqual(parse_args([]).host, "127.0.0.1")
        self.assertEqual(validate_pose({"x_m": 1, "y_m": 2, "yaw_deg": 90})["yaw_deg"], 90)
        for pose in ({}, {"x_m": True, "y_m": 0, "yaw_deg": 0}, {"x_m": 0, "y_m": float("nan"), "yaw_deg": 0}):
            with self.assertRaises(ValueError):
                validate_pose(pose)

    def test_generated_key_is_reused(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / "key.txt"
            key = connection_key(file)
            self.assertGreaterEqual(len(key), 24)
            self.assertEqual(key, connection_key(file))

    def test_snapshot_ages_instead_of_restamping_old_samples(self):
        state = StreamState()
        self.assertFalse(state.snapshot()["ready"])
        state.publish({**measurement("boom", 100, 4), "capture_age_ms": 25}, b"jpeg")
        sequence = state.snapshot()["sequence"]
        state.updated -= 4
        self.assertGreaterEqual(state.snapshot()["age_ms"], 4025)
        self.assertEqual(state.snapshot()["sequence"], sequence)

    def test_authenticated_routes_origins_and_video(self):
        state = StreamState()
        packet = {**measurement("boom", 125, 4), "capture_age_ms": 0,
                  "detections": {"people": [[1, 2, 30, 40]], "new_object": True}}
        state.publish(packet, b"\xff\xd8fixture-jpeg\xff\xd9")
        root = Path(__file__).resolve().parent.parent
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(state, root, KEY, [ORIGIN]))
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def request(path, headers=None, method="GET"):
            connection = http.client.HTTPConnection(*server.server_address, timeout=3)
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            return connection, response
        try:
            connection, response = request("/api/reading")
            self.assertEqual(response.status, 401)
            response.read(); connection.close()
            connection, response = request("/api/reading", {"Authorization": "Bearer " + KEY, "Origin": ORIGIN})
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Access-Control-Allow-Origin"), ORIGIN)
            self.assertEqual(json.loads(response.read())["distance_m"], 1.25)
            connection.close()
            connection, response = request("/api/reading", {"Authorization": "Bearer " + KEY, "Origin": "https://untrusted.example"})
            self.assertIsNone(response.getheader("Access-Control-Allow-Origin"))
            response.read(); connection.close()
            connection, response = request("/api/reading", {"Origin": ORIGIN}, "OPTIONS")
            self.assertEqual(response.status, 204)
            self.assertEqual(response.getheader("Access-Control-Allow-Headers"), "Authorization, Content-Type")
            response.read(); connection.close()
            connection, response = request("/video.mjpg?key=" + KEY)
            self.assertEqual(response.status, 200)
            self.assertIn("multipart/x-mixed-replace", response.getheader("Content-Type"))
            self.assertEqual(response.readline().strip(), b"--frame")
            connection.close()
            state.updated -= 4
            connection, response = request("/health", {"Authorization": "Bearer " + KEY})
            self.assertEqual(response.status, 503)
            response.read(); connection.close()
            connection, response = request("/pi.js")
            self.assertEqual(response.status, 200)
            response.read(); connection.close()
        finally:
            state.stop.set()
            with state.condition:
                state.condition.notify_all()
            server.shutdown(); server.server_close(); thread.join(3)


if __name__ == "__main__":
    unittest.main()

