"""Host API for the XIAO-BUZZ motor.

Other projects add this folder to sys.path and import buzz_api:

    from buzz_api import BuzzClient

    async with BuzzClient() as motor:
        await motor.buzz()
        await motor.click()
        await motor.alert()
        await motor.buzz(strength=0.4, duration_ms=200)

Install bleak from requirements.txt in this folder. Bluetooth has to be on,
and the board has to be advertising as XIAO-BUZZ.
"""

import asyncio
import math

from bleak import BleakClient, BleakScanner

DEVICE_NAME = "XIAO-BUZZ"
SERVICE_UUID = "7a3e0001-6c4b-4d2f-8e19-1f2a3b4c5d01"
CHAR_UUID = "7a3e0002-6c4b-4d2f-8e19-1f2a3b4c5d01"
SCAN_SECONDS = 10.0
ACK_SECONDS = 5.0
STRENGTH_MIN = 0.0
STRENGTH_MAX = 1.0
DURATION_MIN_MS = 1
DURATION_MAX_MS = 5000


class BuzzError(Exception):
    """The board is missing, the ack timed out, or the board returned err."""


def _canonical(strength, duration_ms):
    strength = float(strength)
    duration_ms = int(duration_ms)
    if not math.isfinite(strength):
        raise BuzzError("strength must be finite")
    if strength < STRENGTH_MIN:
        strength = STRENGTH_MIN
    elif strength > STRENGTH_MAX:
        strength = STRENGTH_MAX
    if duration_ms < DURATION_MIN_MS:
        duration_ms = DURATION_MIN_MS
    elif duration_ms > DURATION_MAX_MS:
        duration_ms = DURATION_MAX_MS
    command = f"b,{strength:.2f},{duration_ms}"
    expected = f"ok,{strength:.2f},{duration_ms}"
    return command, expected, duration_ms


class BuzzClient:
    """One BLE session with XIAO-BUZZ.

    Use it as an async context manager. buzz, click, and alert each write
    one command, wait up to 5 seconds for the matching ok notify, then wait
    out the duration so the next call does not cut the motor off.
    """

    def __init__(self, device_name=DEVICE_NAME):
        self.device_name = device_name
        self._client = None
        self._characteristic = None
        self._incoming = None

    async def __aenter__(self):
        device = await BleakScanner.find_device_by_name(
            self.device_name, timeout=SCAN_SECONDS
        )
        if device is None:
            raise BuzzError(f"{self.device_name} not found")

        loop = asyncio.get_running_loop()
        self._incoming = asyncio.Queue()

        def on_notify(_characteristic, data):
            loop.call_soon_threadsafe(self._incoming.put_nowait, bytes(data))

        self._client = BleakClient(device)
        await self._client.__aenter__()
        try:
            service = self._client.services.get_service(SERVICE_UUID)
            if service is None:
                raise BuzzError(f"service {SERVICE_UUID} not found")
            characteristic = service.get_characteristic(CHAR_UUID)
            if characteristic is None:
                raise BuzzError(f"characteristic {CHAR_UUID} not found")
            self._characteristic = characteristic
            await self._client.start_notify(characteristic, on_notify)
        except Exception:
            await self._client.__aexit__(None, None, None)
            self._client = None
            self._characteristic = None
            raise
        return self

    async def __aexit__(self, exc_type, exc, tb):
        client = self._client
        self._client = None
        self._characteristic = None
        if client is None:
            return False
        return await client.__aexit__(exc_type, exc, tb)

    async def buzz(self, strength=0.7, duration_ms=400):
        await self._command(strength, duration_ms)

    async def click(self, strength=1.0, duration_ms=80):
        await self._command(strength, duration_ms)

    async def alert(self, strength=0.85, duration_ms=750):
        await self._command(strength, duration_ms)

    def _drain(self):
        while True:
            try:
                self._incoming.get_nowait()
            except asyncio.QueueEmpty:
                return

    async def _command(self, strength, duration_ms):
        if self._client is None or self._characteristic is None:
            raise BuzzError("not connected")
        command, expected, duration_ms = _canonical(strength, duration_ms)
        self._drain()
        await self._client.write_gatt_char(
            self._characteristic, command.encode("utf-8"), response=True
        )
        try:
            data = await asyncio.wait_for(
                self._incoming.get(), timeout=ACK_SECONDS
            )
        except TimeoutError as exc:
            raise BuzzError("timed out waiting for acknowledgement") from exc
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise BuzzError("acknowledgement was not UTF-8") from exc
        if text == "err":
            raise BuzzError("device returned err")
        if text != expected:
            raise BuzzError(f"expected {expected}, got {text}")
        await asyncio.sleep(duration_ms / 1000.0)
