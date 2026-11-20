# Connect your Raspberry Pi camera and ultrasonic setup

The repository now contains your supplied `DepthCamera` API in `hardware/depth_camera.py` and a headless web adapter in `hardware/pi_bridge.py`. Your original Downloads file has not been changed. The copy accepts an optional frame in `new_object()` so video, motion detection, and person detection use one capture rather than taking a second frame. The desktop GUI still works when Tk is installed; the bridge itself needs no desktop.

## Start on the Pi

Use the Raspberry Pi OS environment where your script already works. The bridge uses the same `picamera2`, `gpiozero`, `lgpio`, `numpy`, and `cv2` packages. It adds no Flask, WebSocket, or other web-framework dependency. If needed, install the system packages:

```sh
sudo apt update
sudo apt install python3-picamera2 python3-gpiozero python3-lgpio python3-opencv python3-numpy
```

Raspberry Pi recommends installing Picamera2 through apt: [official installation instructions](https://github.com/raspberrypi/picamera2/blob/main/README.md). Keep the original GUI closed while the bridge uses the camera.

From the cloned repository on your Pi:

```sh
git pull
python3 hardware/pi_bridge.py --host 0.0.0.0 --sensor boom --allow-origin http://awarely.localhost:4317 --allow-origin http://localhost:4317 --allow-origin http://127.0.0.1:4317
```

The default GPIO pins match your file: trigger BCM 17, echo BCM 18. Use `--sensor rear`, `--sensor left`, or `--sensor right` if that pair is mounted elsewhere. The bridge normally listens only on `127.0.0.1`; the explicit `--host` above enables laptop access on your local network. Every video and data request requires the connection key.

At first start the bridge creates `hardware/bridge-token.txt` on the Pi, with private file permissions. In a second Pi terminal, read your connection key and find the Pi address:

```sh
cat hardware/bridge-token.txt
hostname -I
```

Keep the key on your devices. It is ignored by Git and never saved in browser storage. Requests from other browser origins need an explicit additional `--allow-origin http://YOUR-WEBSITE-ORIGIN`. The local bridge uses HTTP, so use it on your trusted project network. The video image request carries the key as a query parameter because browser image elements cannot send bearer headers; the server omits those query strings from its logs.

## Connect the website

1. Start the website on your laptop as usual and open http://awarely.localhost:4317. Alternatively, the Pi bridge also serves the dashboard at `http://PI-IP:8080`.
2. Open **Connect devices**, then **Your Raspberry Pi setup**.
3. Enter `http://PI-IP:8080` and paste the connection key.
4. Click **Connect Pi**, then **Enable beeps**.

The Pi's `--sensor` setting selects the camera tile and sensor card automatically. More Pis can be connected by entering another address and key; use a different sensor position on each one. Click **Disconnect Pi devices** to stop them, or **Use demo** to return to simulation. A camera's Reset button disconnects that Pi's video and distance feed together.

The website shows feet while the adapter converts your API's centimeters into meters internally. Person boxes, the calibrated ultrasonic target, and a distance label are drawn on the streamed video. The sensor card shows person counts, new-object events, and the configured ultrasonic limit. Person boxes do not have individual distance estimates: the ultrasonic reading belongs to its beam target.

## Calibration and map placement

If you already calibrated your API, copy that `calibration.json` to `hardware/calibration.json` on the Pi. Otherwise the API uses its existing defaults: center target, distance scale 1. You can run the original desktop calibration from the hardware folder, close it, then restart the bridge:

```sh
cd hardware
python3 depth_camera.py
```

Without a vehicle-relative sensor pose, distance alerts work and the combined map explicitly lists the reading as **unplaced**. Once the actual mounting position is measured, append `--pose X_M Y_M YAW_DEG` to the bridge command. Coordinates are meters: x right, y forward, yaw clockwise from forward. Do not substitute the illustrative demo mounts for measurements.

For a moving boom, use `--pose-file hardware/pose.json` instead. Update this file atomically with the current ground-plane sensor pose:

```json
{"x_m": 0.45, "y_m": 3.1, "yaw_deg": 0}
```

Those numbers are an example format, not a measured mount. The bridge rereads the file each frame; an invalid or missing file leaves that sample unplaced instead of keeping the previous pose. Your current API does not measure boom articulation or angle, so those pose updates need a separate source. Each ultrasonic pair contributes one directional return to the shared map.

## Range and freshness

Your `Ultrasonic` class defaults to a configured maximum of 4 m, approximately 13.1 ft. This is below the website's 15 ft adjustment limit. At saturation the gpiozero sensor value may mean an object at/beyond the configured maximum rather than an exact measured distance; the bridge labels it **at sensor limit / no exact distance**, and does not turn it into a precise alert or map point. See the [gpiozero DistanceSensor reference](https://gpiozero.readthedocs.io/en/stable/api_input.html#distancesensor-hc-sr04).

The bridge uses one capture worker; every client reads that worker's latest data. The website polls about four times per second, requires a new sequence number to refresh a reading, and expires data after three seconds. Transport failure invalidates that Pi's distance immediately; video is labeled unavailable. Repeated copies of an old reading cannot keep the alert or map current.

## Endpoints

- `GET /api/reading`: latest distance, capture sequence/age, camera dimensions, detections, calibration target, configured limit, and optional pose. Send `Authorization: Bearer <connection-key>`.
- `GET /video.mjpg?key=<connection-key>`: annotated MJPEG camera stream.
- `GET /health`: capture health, requiring the same bearer key; returns 503 if capture is absent or stale.
- `GET /`: dashboard files only. No camera or calibration files are exposed as static files.

Capture defaults to 10 frames per second, with person detection every fifth frame. For slower boards, add `--no-people` or reduce `--fps`. Restart the bridge after changing the calibration file. Stop it with Ctrl+C.

## Checks and current limit

```sh
python3 -m unittest discover -s hardware -p 'test_*.py' -v
```

Transport, authentication, unit conversion, stale-sample handling, and browser ingestion can be checked without Pi hardware. Actual Picamera2/GPIO capture and the hardware wiring must still be verified on your Pi.


## Driver-facing amber warning LED

Use a regular amber LED (not a self-flashing LED), a **1 kΩ series resistor**, and ground. With the Pi shut down and unplugged, wire **BCM GPIO23 (physical pin 16) → resistor → LED anode (+)** and **LED cathode (−) → ground (physical pin 14)**. The cathode is normally the shorter leg / flat side; verify your component. Prototype on a breadboard before soldering, insulate joints, and use strain relief. GPIO23 must be unused; the ultrasonic defaults already occupy BCM17/18. Never connect a beacon or higher-current lamp directly to GPIO; those need a suitable driver and supply. The HC-SR04 echo must already have appropriate 5 V to 3.3 V level shifting.

Add `--light-pin 23` to your existing Pi bridge command. GPIO is optional: the normal bridge works without a light. It starts disabled every time the process restarts. No physical circuit has been verified by the software tests.

In **Settings → Warning light**, select the Pi's sensor, choose **Flash within** in feet, check **Enable driver light**, then **Apply to Pi**. The chosen threshold is separate from audio settings. **Test light** flashes for two seconds, even when warnings are disabled, then returns to the configured behavior. Demo mode only previews the amber indicator and never sends light commands. To turn a physical light off, uncheck Enable and Apply while connected; changing to demo or closing the page does not disable the Pi controller.

The Pi compares its own fresh ultrasonic distance against the applied threshold and flashes at 2 Hz (250 ms on / 250 ms off). It clears 5 cm past the selected threshold to avoid flicker near the boundary. Stale, invalid, saturated/no-exact-distance, or failed capture data turns the warning off and reports unavailable, rather than implying the area is clear. The configured 4 m sensor maximum still applies even though the UI allows 15 ft. Keep thresholds within the sensor's useful calibrated range. The local controller continues if the browser disconnects; settings are memory-only and reset to disabled on restart. The dashboard reports the last Pi status, not optical confirmation that an LED is lit.

Authenticated light routes: `GET /api/light`, `POST /api/light` with `{"enabled":true,"threshold_m":0.9144}`, and `POST /api/light/test` with `{}`. POST requires the bearer key, JSON, and an allowed browser origin (or the Pi's own origin). Query-string keys cannot control the light. The UI connection key stays in memory.

## Bluetooth XIAO-BUZZ

The motor is a Seeed XIAO ESP32-C3 with a DRV2605L, flashed from the `ble_buzz_pio` project so it advertises as `XIAO-BUZZ`. The host writes `b,<strength>,<duration_ms>` and waits for `ok,<strength>,<duration_ms>`. Strength is 0 to 1. Duration is 1 to 5000 ms. That client lives in `hardware/buzz_api.py`.

Install the Bluetooth library on the computer that will own the motor:

```sh
python3 -m pip install -r hardware/requirements-buzz.txt
```

On Windows, `py -m pip` and `py` work when `python3` is not on PATH.

### This computer

From the repository root, with Bluetooth on and the board advertising:

```sh
python3 hardware/buzz_bridge.py
```

The bridge listens only on `127.0.0.1:8091`. In **Settings → Driver buzz**, leave the host on **This computer**, check **Enable driver buzz**, and move a demo obstacle. **Test buzz** sends one strong pulse. The bridge stops pulsing if the page stops sending readings. Quit the bridge with Ctrl+C before using the Pi as the host.

### Raspberry Pi

Add `--buzz` to the bridge command. The Pi needs Bluetooth and the `bleak` package above. The buzz starts disabled on every restart.

```sh
python3 hardware/pi_bridge.py --host 0.0.0.0 --sensor boom --buzz --allow-origin http://awarely.localhost:4317 --allow-origin http://localhost:4317 --allow-origin http://127.0.0.1:4317
```

In **Settings → Driver buzz**, choose **Raspberry Pi**, select that Pi's sensor, check **Enable driver buzz**, then **Apply to Pi**. The Pi compares its own fresh ultrasonic distance with the applied max range and full-tone distance. It clears 5 cm past max range. Stale, invalid, or failed readings stop the motor. **Test buzz** runs for two seconds. To turn it off, uncheck Enable and Apply. Closing the page does not stop a Pi-owned buzz.

Authenticated Pi routes: `GET /api/buzz`, `POST /api/buzz` with `{"enabled":true,"max_range_m":3.048,"full_tone_m":0.6096}`, and `POST /api/buzz/test` with `{}`. POST requires the bearer key, JSON, and an allowed origin. The local bridge uses `POST /api/buzz/reading` with those fields plus `distance_m`, and it accepts only the dashboard origins on loopback.
