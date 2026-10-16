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
python3 hardware/pi_bridge.py --host 0.0.0.0 --sensor boom --allow-origin http://localhost:4317 --allow-origin http://127.0.0.1:4317
```

The default GPIO pins match your file: trigger BCM 17, echo BCM 18. Use `--sensor rear`, `--sensor left`, or `--sensor right` if that pair is mounted elsewhere. The bridge normally listens only on `127.0.0.1`; the explicit `--host` above enables laptop access on your local network. Every video and data request requires the connection key.

At first start the bridge creates `hardware/bridge-token.txt` on the Pi, with private file permissions. In a second Pi terminal, read your connection key and find the Pi address:

```sh
cat hardware/bridge-token.txt
hostname -I
```

Keep the key on your devices. It is ignored by Git and never saved in browser storage. Requests from other browser origins need an explicit additional `--allow-origin http://YOUR-WEBSITE-ORIGIN`. The local bridge uses HTTP, so use it on your trusted project network. The video image request carries the key as a query parameter because browser image elements cannot send bearer headers; the server omits those query strings from its logs.

## Connect the website

1. Start the website on your laptop as usual and open http://localhost:4317. Alternatively, the Pi bridge also serves the dashboard at `http://PI-IP:8080`.
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
