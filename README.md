# Awarely.ai · Telehandler

A camera and distance dashboard for the EGR 101 telehandler prototype. Four positions: **boom arm**, **rear**, **left**, and **right**. The one-camera layout shows the boom-arm camera. The plan-view telehandler has a telescopic boom, offset cab, fork attachment, and four wheels.

The left rail has three tabs:

- **Dashboard** — camera feeds, the proximity map, the warning light, the driver buzz, and activity. Click a camera, map reading, the map, the warning light, or the driver buzz (or its gear icon) for a short summary and a shortcut to its settings.
- **Settings** — proximity distances, alert sound, the warning light, and the driver buzz, with a live preview beside them.
- **Demo** — simulated obstacles for each side, with the matching camera view and map.

## Run locally

On Windows, double-click **Start-Awarely.cmd** to start the website. It also finds the bundled Node runtime on this computer. In VS Code, Ctrl+Shift+B runs the same launcher.

With Node.js 20 or newer installed, you can also run:

    npm start

Open **http://awarely.localhost:4317** in Chrome or Edge. No application dependencies are needed to run the dashboard. Stop with Ctrl+C. In VS Code, F5 opens the dashboard in Edge after the server has started.

## Named local address

`awarely.localhost` is the local hostname; `4317` is the numeric port. A port cannot be called `awarely`. Chrome and Edge resolve `.localhost` names to this computer, so no hosts-file edit is needed. See [Microsoft’s localhost-name documentation](https://learn.microsoft.com/en-us/aspnet/core/test/localhost-tld).

The original http://localhost:4317 address also serves the dashboard. Browsers store preferences and device permissions separately for each address; use that original address if you want to retain its saved settings. The `awarely.localhost` address is local to your computer and does not publish a public `awarely.ai` website.

## Distance-scaled audio

All distance controls and displayed readings use feet, with a **15 ft maximum** for alert ranges and demo obstacles. Existing saved meter settings are converted for display and capped at 15 ft. The sensor protocol and geometry calculations continue to use meters internally.

Each sensor has two sliders:

- **Max range:** the distance at which slow, low-pitched beeps begin.
- **Full tone at:** the near distance where the scale finishes in a sustained tone at the upper end of the lower pitch range.

Between those distances, pitch rises continuously through a low, compact 240–480 Hz range, the pulse period falls from 1.2 seconds to 0.12 seconds, and pulse duty rises from 10% to 95%. The final 2% of the curve transitions to a sustained tone. At or below Full tone at, sound stays at the high end. Outside Max range, that sensor is silent.

The most urgent normalized sensor controls one tone so multiple views do not produce overlapping beeps. Volume is separate. Click Enable beeps to allow browser audio, then use the **Demo** tab to move an obstacle on any side. Each simulated camera uses that same sensor distance: the obstacle grows as it gets closer and shrinks as it moves away. A shared 0.8 m obstacle width drives both its camera projection and map returns. Settings are saved in this browser; version-one front settings migrate to boom settings.

## Connect your Pi camera and ultrasonic API

The supplied API is integrated through `hardware/pi_bridge.py`. Open **Connect devices → Your Raspberry Pi setup** and enter the Pi address and its connection key. This connects annotated video, calibrated ultrasonic readings, person detections, and new-object events together. See [the Pi setup guide](docs/pi-setup.md) for the exact Pi command and calibration steps.

## Cameras and live distances

Connect devices supports USB webcams and browser-compatible image/MJPEG or video URLs. Connect one USB camera to grant access and populate the device selectors; then choose distinct devices for the other positions. Reset stops the camera tracks. No recording or video upload is implemented.

Your camera/ultrasonic adapter is included in `hardware/`. Other depth cameras or distance sensors can also use the generic WebSocket interface. Connect its WebSocket URL. RTSP streams also need a browser-compatible bridge. See [the sensor protocol](docs/sensor-protocol.md) for scalar readings, scans, poses, and synchronized frames.

## Combined proximity map

All fresh, calibrated measurements project into vehicle-relative metric coordinates. A 15 cm grid merges overlapping returns and retains which sensors contributed. Each sensor can supply multiple distance/bearing rays; frames can update multiple sensors together. A moving boom can supply an updated pose on every reading. Hover a point to see its sources and coordinates.

The demo uses illustrative mounts and an illustrative telehandler footprint. Live mode requires explicit calibrated poses to place measurements. Readings without poses still drive alerts and appear as unplaced. Expired data and closed connections remove points and silence those sensors. The map shows observed returns; it does not certify an empty region as clear.

## Verify

    npm test

Browser tests and screenshots:

    npm install
    npx playwright install chromium
    npm run test:browser

Browser tests start their own temporary server on port 4318, use a simulated webcam, and mock the sensor bridge. They cover both layouts, range persistence, sound progression, USB connect/reset, scan fusion, boom pose changes, missing poses, invalid messages, stale data, disconnects, and mobile width. CI runs the same checks. Optionally set BROWSER_PATH to a local Chromium executable and PLAYWRIGHT_MODULE_PATH to an installed Playwright module.

## Current scope

This classroom prototype plays alerts in the browser and can pulse a Bluetooth XIAO-BUZZ motor on the same distance curve. The board has to be flashed with the XIAO-BUZZ firmware and advertising as `XIAO-BUZZ`. The supplied Picamera2/ultrasonic API and its HOG person detection are connected through the Pi bridge. Measured vehicle geometry and actual sensor/boom calibration still depend on your hardware setup. The map is a 2D projection; the adapter must select relevant height slices before sending depth rays. This prototype is not a vehicle safety system, and browser audio/timers can pause in the background.


## Driver warning light

The dashboard shows the **Warning light** status; its sensor selector, adjustable distance in feet, enable/apply controls, and two-second test are under **Settings → Warning light**, next to the Pi-reported status. In demo mode it previews an amber indicator only. With the optional Pi LED configured, the Pi handles flashing locally even when the browser closes. See [LED wiring and setup](docs/pi-setup.md#driver-facing-amber-warning-led). Physical wiring and output still require testing on the actual Pi.

Distance controls default to one shared Max range / Full tone at pair for all four sides. Turn off **Use the same distances for all sides** to adjust each side separately. The driver light follows its selected sensor’s Full tone at by default; **Set light distance manually** reveals its independent slider. Physical light changes still require **Apply to Pi**.

## Driver buzz

The dashboard **Driver buzz** card and **Settings → Driver buzz** pulse a XIAO-BUZZ wristband: stronger and faster as the obstacle gets closer, matching the alert sound. The browser that is showing the dashboard holds the Bluetooth connection. It writes one pulse when that pulse is due, including for demo obstacles, and writes nothing while every obstacle is outside max range. The Pi sends distance and video only.

Flash the Seeed XIAO ESP32-C3 with the `ble_buzz_pio` firmware so it advertises as `XIAO-BUZZ`. Open the site in Chrome or Edge at `http://localhost:4317`, choose **Connect wristband**, then **Enable driver buzz**. See [Bluetooth buzz setup](docs/pi-setup.md#bluetooth-xiao-buzz).
