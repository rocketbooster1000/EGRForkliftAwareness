# Sensor bridge protocol · v2

The interface displays feet and caps adjustable alert ranges at 15 ft. This protocol continues to accept meters; send real meter measurements without converting them to feet. Readings beyond the adjustable alert range remain valid for display and mapping.

The dashboard receives JSON text over a user-selected WebSocket. Supported positions are `boom`, `rear`, `left`, and `right`; the earlier `front` ID is retired. The browser sends no buzzer or vehicle commands.

## Single distance

```json
{"sensor":"rear","distance_m":1.25}
```

Numbers are meters. Only finite numeric distances from 0 to 100 are accepted. Strings, negative values, unknown sensors, and malformed JSON are ignored. Distance alone drives sound and the numeric readout. It is **unplaced** on the combined map until this same measurement includes a pose.

## Calibrated pose

```json
{
  "sensor":"rear",
  "distance_m":1.25,
  "pose":{"x_m":0,"y_m":-2.2,"yaw_deg":180}
}
```

Choose a consistent vehicle origin, such as the chassis center. Axes: x right, y forward, meters. Yaw is clockwise degrees from forward: 0 forward, 90 right, 180 rear, -90 left. The displayed footprint is illustrative and is not calibration evidence. Pose x/y are limited to ±100 m and yaw to ±360 degrees. Each message must include the current pose if its data is to be placed; old poses are never silently reused. This supports an articulated or extended boom without assuming it remains fixed.

The sample pose above is illustrative. Measure the actual mount and orientation before using live map positions. For the boom, the adapter must transform sensor readings into the same ground-plane vehicle frame using the current boom articulation. Height filtering and tilt compensation belong in the adapter; this dashboard is 2D.

## Scan rays

```json
{
  "sensor":"boom",
  "pose":{"x_m":0.45,"y_m":3.1,"yaw_deg":0},
  "points":[
    {"distance_m":2.0,"bearing_deg":-15},
    {"distance_m":1.3,"bearing_deg":0},
    {"distance_m":2.1,"bearing_deg":15}
  ]
}
```

Up to 512 rays per sensor update. Bearing rotates clockwise relative to that sensor's yaw and is limited to ±180 degrees. If `distance_m` is omitted at the top level, the nearest ray controls audio. If both are supplied, the nearest of the scalar and all scan rays controls audio; the scan rays are plotted on the map. A scalar-only reading plots one point along the sensor's forward axis.

Every reading replaces the previous scan for that sensor, so old obstacles do not linger alongside new returns. Empty scans are rejected: they do not imply free space. The bridge can stop sending a sensor when it has no valid return; the dashboard expires its last reading after 3 seconds.

## Atomic multi-sensor frame

```json
{
  "type":"frame",
  "measurements":[
    {"sensor":"boom","distance_m":1.3,"pose":{"x_m":0.45,"y_m":3.1,"yaw_deg":0}},
    {"sensor":"rear","distance_m":1.5,"pose":{"x_m":0,"y_m":-2.2,"yaw_deg":180}},
    {"sensor":"left","distance_m":2.0,"pose":{"x_m":-1.2,"y_m":0,"yaw_deg":-90}},
    {"sensor":"right","distance_m":2.5,"pose":{"x_m":1.2,"y_m":0,"yaw_deg":90}}
  ]
}
```

One to four unique sensor IDs. Each item accepts the single-reading fields above, including `points`. A malformed item rejects the whole frame. All items get one browser receive time; omitted sensors retain their previous reading only until it expires.

The adapter must synchronize acquisitions and discard old queued samples before transmission. Receive time is used for expiration; it cannot establish physical acquisition simultaneity. This is spatial aggregation, not motion compensation, object tracking, or probabilistic sensor fusion.

## Shared map

For each ray, with angles in radians:

    angle = yaw + bearing
    x = mount_x + distance * sin(angle)
    y = mount_y + distance * cos(angle)

The renderer inverts y to draw forward upward. Returns in the same 15 cm spatial grid cell are averaged for display. Contributors, return count, and maximum urgency are retained. This proximity grouping is a visualization convenience, not proof that two sensors observed the same object. Alerts use raw nearest distances, so averaging cannot soften an alert.

Send fresh readings at least once per second. At 3 seconds without an update, that sensor's sound contribution and map points expire. A socket closure invalidates all live readings immediately. Live mode never automatically falls back to simulation. No demo poses are applied to live data.
