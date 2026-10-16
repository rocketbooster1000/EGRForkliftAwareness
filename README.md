# Surround · Telehandler

A camera and distance dashboard for the EGR 101 telehandler prototype. Four positions: **boom arm**, **rear**, **left**, and **right**. The one-camera layout shows the boom-arm camera. The plan-view telehandler has a telescopic boom, offset cab, fork attachment, and four wheels.

## Run locally

On Windows, double-click **Start-Surround.cmd** to start the website. It also finds the bundled Node runtime on this computer. In VS Code, Ctrl+Shift+B runs the same launcher.

With Node.js 20 or newer installed, you can also run:

    npm start

Open http://localhost:4317. No application dependencies are needed to run the dashboard. Stop with Ctrl+C. In VS Code, F5 opens the dashboard in Edge after the server has started.

## Distance-scaled audio

All distance controls and displayed readings use feet, with a **15 ft maximum** for alert ranges and demo obstacles. Existing saved meter settings are converted for display and capped at 15 ft. The sensor protocol and geometry calculations continue to use meters internally.

Each sensor has two sliders:

- **Max range:** the distance at which slow, low-pitched beeps begin.
- **Full tone at:** the near distance where the scale finishes in a sustained tone at the upper end of the lower pitch range.

Between those distances, pitch rises continuously through a low, compact 240–480 Hz range, the pulse period falls from 1.2 seconds to 0.12 seconds, and pulse duty rises from 10% to 95%. The final 2% of the curve transitions to a sustained tone. At or below Full tone at, sound stays at the high end. Outside Max range, that sensor is silent.

The most urgent normalized sensor controls one tone so multiple views do not produce overlapping beeps. Volume is separate. Click Enable beeps to allow browser audio, then use Try a scenario to move an obstacle on any side. Each simulated camera uses that same sensor distance: the obstacle grows as it gets closer and shrinks as it moves away. A shared 0.8 m obstacle width drives both its camera projection and map returns. Settings are saved in this browser; version-one front settings migrate to boom settings.

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

This classroom prototype plays alerts in the browser. The supplied Picamera2/ultrasonic API and its HOG person detection are connected through the Pi bridge. Physical buzzer firmware, measured vehicle geometry, and actual sensor/boom calibration still depend on your hardware setup. The map is a 2D projection; the adapter must select relevant height slices before sending depth rays. This prototype is not a vehicle safety system, and browser audio/timers can pause in the background.
