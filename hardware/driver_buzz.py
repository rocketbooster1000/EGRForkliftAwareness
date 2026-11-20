"""XIAO-BUZZ pulses that follow the same distance curve as the alert sound.

The motor speaks the ble_buzz_pio protocol: one UTF-8 write, b,<strength>,<duration_ms>,
then an ok,<strength>,<duration_ms> notify. BuzzClient in buzz_api.py owns that session.
This controller decides when to pulse. Tests inject a motor and never open Bluetooth.
"""
import asyncio
import math
import threading
import time

MIN_RANGE_M = 0.3048       # 1 ft
MAX_RANGE_M = 4.572        # 15 ft
MIN_TONE_M = 0.03048       # 0.1 ft


def haptic_pulse(progress):
    """Strength, duration, and period for one pulse. Matches logic.js hapticPulse."""
    if isinstance(progress, bool) or not isinstance(progress, (int, float)) or not math.isfinite(progress):
        return None
    progress = 0.0 if progress < 0 else 1.0 if progress > 1 else float(progress)
    if progress >= 0.98:
        return 0.85, 400, 0.48
    period = 0.12 + 1.08 * (1 - progress) ** 1.65
    duty = 0.1 + 0.85 * progress
    duration_ms = int(period * duty * 1000 + 0.5)
    cap = max(80, int(period * 1000 + 0.5) - 40)
    upper = min(400, cap)
    duration_ms = 80 if duration_ms < 80 else upper if duration_ms > upper else duration_ms
    strength = int((0.35 + 0.65 * progress) * 100 + 0.5) / 100
    period = max(period, duration_ms / 1000 + 0.04)
    return strength, duration_ms, int(period * 10000 + 0.5) / 10000


def _number(value, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= float(value) <= high:
        raise ValueError("Distance is out of range")
    return float(value)


def _ranges(enabled, max_range, full_tone):
    if type(enabled) is not bool:
        raise ValueError("enabled must be true or false")
    max_range = _number(max_range, MIN_RANGE_M, MAX_RANGE_M)
    full_tone = _number(full_tone, MIN_TONE_M, MAX_RANGE_M)
    if full_tone > max_range - MIN_TONE_M:
        raise ValueError("Full tone must be below max range")
    return enabled, max_range, full_tone


class InjectedState:
    """Distance supplied by the dashboard instead of the Pi camera."""

    def __init__(self):
        self.lock = threading.Lock()
        self.ready = False
        self.distance = None
        self.updated = 0.0

    def publish(self, distance):
        with self.lock:
            self.ready = True
            self.distance = distance
            self.updated = time.monotonic()

    def snapshot(self):
        with self.lock:
            if not self.ready:
                return {"ready": False, "error": "Waiting for a dashboard reading"}
            age = (time.monotonic() - self.updated) * 1000
            if self.distance is None:
                return {"ready": True, "age_ms": age, "range_status": "invalid", "distance_m": None, "error": None}
            return {"ready": True, "age_ms": age, "range_status": "valid", "distance_m": self.distance, "error": None}


class DriverBuzz:
    def __init__(self, state, motor=None, clock=time.monotonic):
        self.state, self.motor, self.clock = state, motor, clock
        self.lock = threading.RLock()
        self.enabled = False
        self.max_range_m, self.full_tone_m = 3.048, 0.6096  # 10 ft, 2 ft
        self.active = self.pulsing = self.failed = False
        self.test_until = self.next_at = 0.0
        self.strength = self.duration_ms = self.period_s = None
        self.reason = "not_configured" if motor is None else "disabled"
        self.error = None
        self.stop = threading.Event()
        self.thread = None

    def _require_motor(self):
        if self.motor is None:
            raise ValueError("Bluetooth buzz is not configured; start the bridge with --buzz")

    def configure(self, value):
        if not isinstance(value, dict) or set(value) != {"enabled", "max_range_m", "full_tone_m"}:
            raise ValueError("Supply enabled, max_range_m, and full_tone_m")
        enabled, max_range, full_tone = _ranges(value["enabled"], value["max_range_m"], value["full_tone_m"])
        self._require_motor()
        with self.lock:
            self.failed = False
            self.error = None
            self.enabled, self.max_range_m, self.full_tone_m = enabled, max_range, full_tone
            self.test_until = self.next_at = 0
            self.active = False
            self.tick()
            return self.status()

    def apply_reading(self, value):
        """Dashboard update: ranges plus the current distance. Does not cancel a test."""
        if not isinstance(value, dict) or set(value) != {"enabled", "max_range_m", "full_tone_m", "distance_m"}:
            raise ValueError("Supply enabled, ranges, and distance_m")
        enabled, max_range, full_tone = _ranges(value["enabled"], value["max_range_m"], value["full_tone_m"])
        distance = value["distance_m"]
        if distance is not None:
            distance = _number(distance, 0, 100)
        self._require_motor()
        with self.lock:
            if self.failed:
                if not enabled:
                    self.failed = False
                    self.error = None
                    self.enabled = False
            else:
                self.enabled = enabled
            self.max_range_m, self.full_tone_m = max_range, full_tone
            self.state.publish(distance)
            self.tick()
            return self.status()

    def test(self):
        with self.lock:
            self._require_motor()
            self.failed = False
            self.error = None
            self.test_until = self.clock() + 2
            self.next_at = 0
            self.tick()
            return self.status()

    def _distance(self):
        packet = self.state.snapshot()
        distance = packet.get("distance_m")
        valid = (packet.get("ready") and not packet.get("error") and packet.get("age_ms", 3000) < 3000
                 and packet.get("range_status") == "valid" and isinstance(distance, (int, float))
                 and not isinstance(distance, bool) and math.isfinite(distance) and distance >= 0)
        return distance if valid else None

    def _fail(self):
        self.failed = True
        self.enabled = self.active = self.pulsing = False
        self.strength = self.duration_ms = self.period_s = None
        self.reason = "output_error"
        self.error = "Check Bluetooth and the XIAO-BUZZ, then turn the buzz off and on"

    def _progress(self, distance):
        span = self.max_range_m - self.full_tone_m
        if span <= 0:
            return 1.0
        progress = (self.max_range_m - distance) / span
        return 0.0 if progress < 0 else 1.0 if progress > 1 else progress

    def tick(self):
        with self.lock:
            now = self.clock()
            motor = self.motor
            if motor is None:
                self.active = self.pulsing = False
                self.reason = "not_configured"
                return
            if self.failed:
                self.active = self.pulsing = False
                self.reason = "output_error"
                return
            was_active = self.active
            distance = self._distance()
            if now < self.test_until:
                plan, self.active, self.reason = (0.85, 400, 0.9), True, "testing"
            elif not self.enabled:
                plan, self.active, self.reason = None, False, "disabled"
            elif distance is None:
                plan, self.active, self.reason = None, False, "sensor_unavailable"
            else:
                limit = self.max_range_m + (0.05 if was_active else 0)
                self.active = distance <= limit
                if self.active:
                    progress = self._progress(distance)
                    plan = haptic_pulse(progress)
                    self.reason = "close" if progress >= 0.98 else "approaching"
                else:
                    plan, self.reason = None, "outside_range"
            if plan is None:
                self.strength = self.duration_ms = self.period_s = None
                self.pulsing = False
                self.next_at = 0
                return
            strength, duration_ms, period = plan
            self.strength, self.duration_ms, self.period_s = strength, duration_ms, period
            connected = bool(getattr(motor, "connected", False))
            self.pulsing = connected
            if not connected or getattr(motor, "busy", False) or now < self.next_at:
                return
            try:
                started = motor.pulse(strength, duration_ms)
            except Exception:
                self._fail()
                return
            if started:
                self.next_at = now + period

    def status(self):
        with self.lock:
            motor = self.motor
            return {"available": motor is not None, "connected": bool(motor and getattr(motor, "connected", False)),
                    "enabled": self.enabled, "max_range_m": self.max_range_m, "full_tone_m": self.full_tone_m,
                    "active": self.active, "pulsing": self.pulsing, "strength": self.strength,
                    "duration_ms": self.duration_ms, "period_s": self.period_s, "reason": self.reason, "error": self.error}

    def start(self):
        def run():
            while not self.stop.wait(0.05):
                self.tick()
        self.tick()
        self.thread = threading.Thread(target=run, name="driver-buzz", daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(2)


def _detail(exc):
    return str(exc).strip() or exc.__class__.__name__


class BleBuzzMotor:
    """One background Bluetooth session. pulse() only queues; the loop waits out each buzz."""

    def __init__(self):
        from buzz_api import BuzzClient
        self._factory = BuzzClient
        self.connected = False
        self.busy = False
        self.error = None
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._loop = None
        self._queue = None
        self._thread = None

    def start(self):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run, name="ble-buzz", daemon=True)
        self._thread.start()
        self._ready.wait(5)

    def _run(self):
        asyncio.set_event_loop(self._loop)
        self._queue = asyncio.Queue()
        self._ready.set()
        try:
            self._loop.run_until_complete(self._session())
        finally:
            self.connected = False
            self.busy = False
            self._loop.close()

    def _drain(self):
        while True:
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                return

    async def _session(self):
        while not self._stop.is_set():
            try:
                async with self._factory() as client:
                    self.connected = True
                    self.error = None
                    while not self._stop.is_set():
                        try:
                            item = await asyncio.wait_for(self._queue.get(), 0.25)
                        except TimeoutError:
                            continue
                        self.busy = True
                        try:
                            await client.buzz(*item)
                            self.error = None
                        except Exception as exc:
                            self.error = _detail(exc)
                            self.connected = False
                            raise
                        finally:
                            self.busy = False
            except Exception as exc:
                self.connected = False
                self.busy = False
                if not self.error:
                    self.error = _detail(exc)
            self._drain()
            for _ in range(20):
                if self._stop.is_set():
                    return
                await asyncio.sleep(0.1)

    def pulse(self, strength, duration_ms):
        if not self.connected or self.busy or self._loop is None or self._queue is None:
            return False
        self.busy = True
        try:
            self._loop.call_soon_threadsafe(self._queue.put_nowait, (float(strength), int(duration_ms)))
        except Exception:
            self.busy = False
            return False
        return True

    def close(self):
        self._stop.set()
        if self._thread:
            self._thread.join(3)
