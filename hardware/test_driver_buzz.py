"""Hardware-free checks for the XIAO-BUZZ pulse schedule and its HTTP bridges."""
import http.client
import json
import threading
import unittest
from pathlib import Path
from http.server import ThreadingHTTPServer
from driver_buzz import DriverBuzz, InjectedState, haptic_pulse
from buzz_bridge import make_buzz_handler, parse_args
from pi_bridge import StreamState, make_handler, measurement


class Motor:
    def __init__(self):
        self.pulses = []
        self.connected = True
        self.busy = False
        self.error = None

    def pulse(self, strength, duration_ms):
        self.pulses.append((strength, duration_ms))
        return True


class RaisingMotor(Motor):
    def pulse(self, strength, duration_ms):
        raise RuntimeError("radio")


class BuzzTests(unittest.TestCase):
    def setUp(self):
        self.now = 10
        self.state = StreamState()
        self.motor = Motor()
        self.buzz = DriverBuzz(self.state, self.motor, lambda: self.now)
        self.publish(50)

    def publish(self, cm):
        self.state.publish(measurement("boom", cm, 4), b"jpeg")

    def reading(self, **extra):
        body = {"enabled": True, "max_range_m": 3, "full_tone_m": 0.5}
        body.update(extra)
        return body

    def test_curve_matches_the_alert_endpoints(self):
        self.assertEqual(haptic_pulse(0), (0.35, 120, 1.2))
        self.assertEqual(haptic_pulse(1), (0.85, 400, 0.48))
        self.assertIsNone(haptic_pulse(float("nan")))
        far, mid = haptic_pulse(0), haptic_pulse(0.5)
        self.assertGreater(mid[0], far[0])
        self.assertLess(mid[2], far[2])

    def test_distance_scales_pulses_and_holds_past_the_edge(self):
        self.publish(100)
        self.buzz.configure(self.reading(max_range_m=1, full_tone_m=0.3))
        self.assertEqual(self.motor.pulses, [(0.35, 120)])
        self.assertEqual(self.buzz.reason, "approaching")
        self.now = self.buzz.next_at - 0.01
        self.buzz.tick()
        self.assertEqual(len(self.motor.pulses), 1)
        self.now = self.buzz.next_at
        self.buzz.tick()
        self.assertEqual(len(self.motor.pulses), 2)
        self.publish(30)
        self.now = self.buzz.next_at
        self.buzz.tick()
        self.assertEqual(self.buzz.reason, "close")
        self.assertEqual(self.motor.pulses[-1], (0.85, 400))
        self.publish(103)
        self.buzz.tick()
        self.assertTrue(self.buzz.active)
        self.publish(106)
        self.buzz.tick()
        self.assertFalse(self.buzz.active)
        self.assertEqual(self.buzz.reason, "outside_range")
        self.publish(102)
        self.buzz.tick()
        self.assertFalse(self.buzz.active)
        self.publish(100)
        self.buzz.tick()
        self.assertTrue(self.buzz.active)

    def test_invalid_and_disconnected_motors_do_not_pulse(self):
        self.buzz.configure(self.reading())
        sent = len(self.motor.pulses)
        for value in (None, 400, -1):
            self.publish(value)
            self.buzz.tick()
            self.assertEqual(self.buzz.reason, "sensor_unavailable")
        self.publish(50)
        self.state.updated -= 4
        self.buzz.tick()
        self.assertEqual(self.buzz.reason, "sensor_unavailable")
        self.publish(50)
        self.motor.connected = False
        self.buzz.tick()
        self.assertEqual(len(self.motor.pulses), sent)
        self.assertFalse(self.buzz.status()["connected"])
        self.assertIn(self.buzz.reason, ("approaching", "close"))

    def test_failure_latches_until_switch_off_and_validation(self):
        broken = DriverBuzz(self.state, RaisingMotor(), lambda: self.now)
        broken.configure(self.reading())
        self.assertEqual(broken.reason, "output_error")
        self.assertFalse(broken.enabled)
        broken.tick()
        self.assertEqual(broken.reason, "output_error")
        state = InjectedState()
        motor = RaisingMotor()
        fed = DriverBuzz(state, motor, lambda: self.now)
        fed.apply_reading({**self.reading(), "distance_m": 0.4})
        self.assertEqual(fed.reason, "output_error")
        fed.apply_reading({**self.reading(), "distance_m": 0.4})
        self.assertEqual(fed.reason, "output_error")
        fed.apply_reading({**self.reading(enabled=False), "distance_m": None})
        self.assertEqual(fed.reason, "disabled")
        fed.motor = Motor()
        fed.apply_reading({**self.reading(), "distance_m": 0.4})
        self.assertTrue(fed.motor.pulses)
        for value in ({}, {"enabled": 1, "max_range_m": 1, "full_tone_m": 0.3},
                      {"enabled": True, "max_range_m": 1, "full_tone_m": 1},
                      {"enabled": True, "max_range_m": 5, "full_tone_m": 0.3}):
            with self.assertRaises(ValueError):
                self.buzz.configure(value)
        self.assertFalse(parse_args([]).host != "127.0.0.1")
        with self.assertRaises(SystemExit):
            parse_args(["--host", "0.0.0.0"])

    def test_two_second_test_and_pi_route_auth(self):
        self.buzz.configure({"enabled": False, "max_range_m": 1, "full_tone_m": 0.3})
        self.buzz.test()
        self.assertEqual(self.motor.pulses[-1], (0.85, 400))
        self.assertEqual(self.buzz.reason, "testing")
        self.now += 2.1
        self.buzz.tick()
        self.assertEqual(self.buzz.reason, "disabled")
        token = "fixture-buzz-key"
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.state, Path("."), token, ["http://localhost:4317"], None, self.buzz))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def request(path, body, headers, method="POST"):
            connection = http.client.HTTPConnection(*server.server_address, timeout=3)
            connection.request(method, path, json.dumps(body) if body is not None else None, headers)
            response = connection.getresponse()
            result = response.status, json.loads(response.read())
            connection.close()
            return result

        try:
            self.assertEqual(request("/api/buzz", None, {}, "GET")[0], 401)
            auth = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
            self.assertEqual(request("/api/buzz", self.reading(), {**auth, "Origin": "https://bad.example"})[0], 403)
            code, data = request("/api/buzz", self.reading(), {**auth, "Origin": "http://localhost:4317"})
            self.assertEqual(code, 200)
            self.assertTrue(data["active"])
            self.assertEqual(request("/api/buzz/test", {}, auth)[1]["reason"], "testing")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(3)

    def test_local_bridge_accepts_dashboard_readings_only_from_allowed_origins(self):
        state = InjectedState()
        buzz = DriverBuzz(state, self.motor, lambda: self.now)
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_buzz_handler(buzz, ("http://localhost:4317",)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def request(path, body, origin=None):
            connection = http.client.HTTPConnection(*server.server_address, timeout=3)
            headers = {"Content-Type": "application/json"}
            if origin:
                headers["Origin"] = origin
            connection.request("POST", path, json.dumps(body), headers)
            response = connection.getresponse()
            result = response.status, json.loads(response.read())
            connection.close()
            return result

        try:
            self.assertEqual(request("/api/buzz/reading", {**self.reading(), "distance_m": 0.4}, "https://bad.example")[0], 403)
            code, data = request("/api/buzz/reading", {**self.reading(), "distance_m": 0.4}, "http://localhost:4317")
            self.assertEqual(code, 200)
            self.assertEqual(data["reason"], "close")
            self.assertTrue(self.motor.pulses)
            self.assertEqual(request("/api/buzz/reading", {"enabled": True}, "http://localhost:4317")[0], 400)
            state.updated -= 4
            buzz.tick()
            self.assertEqual(buzz.reason, "sensor_unavailable")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(3)


if __name__ == "__main__":
    unittest.main()
