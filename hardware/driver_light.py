"""Driver-facing LED controller. GPIO is opt-in; tests use an injected output."""
import math
import threading
import time


class DriverLight:
    def __init__(self, state, output=None, clock=time.monotonic):
        self.state, self.output, self.clock = state, output, clock
        self.lock = threading.RLock()
        self.enabled, self.threshold_m = False, 0.9144  # 3 ft
        self.active, self.lit = False, False
        self.test_until = 0.0
        self.phase_start = None
        self.reason = "disabled"
        self.error = None
        self.stop = threading.Event()
        self.thread = None

    def configure(self, value):
        if not isinstance(value, dict) or set(value) != {"enabled", "threshold_m"}:
            raise ValueError("Supply enabled and threshold_m")
        enabled, threshold = value["enabled"], value["threshold_m"]
        if type(enabled) is not bool or isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not math.isfinite(threshold) or not 0.03048 <= threshold <= 4.572:
            raise ValueError("Distance must be between 0.1 and 15 ft")
        if self.output is None:
            raise ValueError("Physical light is not configured; start the bridge with --light-pin")
        with self.lock:
            self.enabled, self.threshold_m = enabled, float(threshold)
            self.test_until = 0
            self.active, self.phase_start = False, None
            self.tick()
            return self.status()

    def test(self):
        with self.lock:
            if self.output is None:
                raise ValueError("Physical light is not configured")
            self.test_until = self.clock() + 2
            self.phase_start = None
            self.tick()
            return self.status()

    def tick(self):
        with self.lock:
            now = self.clock()
            packet = self.state.snapshot()
            distance = packet.get("distance_m")
            valid = (packet.get("ready") and not packet.get("error") and packet.get("age_ms", 3000) < 3000
                     and packet.get("range_status") == "valid" and isinstance(distance, (int, float))
                     and not isinstance(distance, bool) and math.isfinite(distance) and distance >= 0)
            if self.output is None:
                self.active, self.reason = False, "not_configured"
            elif now < self.test_until:
                self.active, self.reason = True, "testing"
            elif not self.enabled:
                self.active, self.reason = False, "disabled"
            elif not valid:
                self.active, self.reason = False, "sensor_unavailable"
            else:
                # Clear 5 cm beyond the threshold to prevent boundary flickering.
                limit = self.threshold_m + (0.05 if self.active else 0)
                self.active = distance <= limit
                self.reason = "warning" if self.active else "outside_range"
            if self.active and self.phase_start is None:
                self.phase_start = now
            elif not self.active:
                self.phase_start = None
            lit = self.active and (now - self.phase_start) % 0.5 < 0.25
            try:
                if self.output is not None:
                    self.output.on() if lit else self.output.off()
                self.lit, self.error = bool(lit), None
            except Exception:
                self.lit, self.active, self.enabled = False, False, False
                self.reason, self.error = "output_error", "Check the LED wiring and restart the Pi bridge"
                try:
                    self.output.off()
                except Exception:
                    pass

    def status(self):
        with self.lock:
            return {"available": self.output is not None, "enabled": self.enabled,
                    "threshold_m": self.threshold_m, "active": self.active,
                    "lit": self.lit, "reason": self.reason, "error": self.error}

    def start(self):
        def run():
            while not self.stop.wait(0.05):
                self.tick()
        self.tick()
        self.thread = threading.Thread(target=run, name="driver-light", daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(2)
        if self.output is not None:
            try:
                self.output.off()
            finally:
                self.output.close()
