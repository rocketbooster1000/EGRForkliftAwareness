const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./logic.js');
const settings = { maxRange: 3, fullTone: 0.5 };
test('sound increases continuously with decreasing distance and ends in sustained tone', () => {
  let previous = null;
  for (let distance = 3; distance >= 0.5; distance -= 0.05) {
    const p = L.alertProfile(distance, settings);
    assert.equal(p.active, true);
    if (previous) { assert.ok(p.frequencyHz > previous.frequencyHz); assert.ok(p.periodSeconds < previous.periodSeconds); assert.ok(p.duty > previous.duty); }
    previous = p;
  }
  assert.equal(L.alertProfile(0.5, settings).continuous, true);
  assert.equal(L.alertProfile(0, settings).frequencyHz, 2000);
  assert.equal(L.alertProfile(3.001, settings).active, false);
  assert.equal(L.alertProfile(NaN, settings).state, 'stale');
  assert.equal(L.alertProfile(-1, settings).state, 'stale');
});
test('range settings cannot invert or create a zero width scale', () => {
  assert.deepEqual(L.normalizeSettings({ maxRange: 1, fullTone: 5 }), { maxRange: 1, fullTone: 0.9 });
  assert.equal(L.normalizeSettings({ maxRange: 100 }).maxRange, 10);
  assert.equal(L.normalizeSettings({ maxRange: 0 }).maxRange, 0.3);
});
test('invalid messages and obsolete front ID are rejected', () => {
  for (const input of ['bad', 'null', '{}', '{"sensor":"front","distance_m":1}', '{"sensor":"rear","distance_m":"1"}', '{"sensor":"rear","distance_m":-1}', '{"sensor":"rear","distance_m":101}', '{"sensor":"boom","points":[]}', '{"sensor":"boom","points":[{"distance_m":1,"bearing_deg":181}]}', '{"sensor":"boom","distance_m":1,"pose":{"x_m":0,"y_m":0,"yaw_deg":"0"}}']) assert.equal(L.parseFrame(input), null);
});
test('scan nearest return controls sound, and frames validate atomically', () => {
  const readings = L.parseFrame({ type: 'frame', measurements: [{ sensor: 'boom', points: [{ distance_m: 2, bearing_deg: -10 }, { distance_m: 0.4, bearing_deg: 10 }] }, { sensor: 'rear', distance_m: 1.2 }] });
  assert.equal(readings[0].distance_m, 0.4);
  assert.equal(readings[1].distance_m, 1.2);
  assert.equal(L.parseFrame({ type: 'frame', measurements: [{ sensor: 'boom', distance_m: 1 }, { sensor: 'boom', distance_m: 2 }] }), null);
  assert.equal(L.parseFrame({ type: 'frame', measurements: [{ sensor: 'boom', distance_m: 1 }, { sensor: 'rear', distance_m: 'bad' }] }), null);
});
test('mount yaw and ray bearing transform into shared vehicle coordinates', () => {
  const p = L.projectPoint({ x_m: 1, y_m: 2, yaw_deg: 90 }, { distance_m: 2, bearing_deg: 0 });
  assert.ok(Math.abs(p.x_m - 3) < 1e-9); assert.ok(Math.abs(p.y_m - 2) < 1e-9);
  const q = L.projectPoint({ x_m: 0, y_m: 0, yaw_deg: 90 }, { distance_m: 2, bearing_deg: -90 });
  assert.equal(q.x_m, 0); assert.equal(q.y_m, 2);
});
test('overlapping returns fuse, retain contributors, and stale readings disappear', () => {
  const readings = {
    boom: { ...settings, distance: 1, updated: 1000, pose: { x_m: 0.03, y_m: 0, yaw_deg: 0 } },
    right: { ...settings, distance: 1, updated: 1000, pose: { x_m: 0.06, y_m: 0, yaw_deg: 0 } },
    rear: { ...settings, distance: 1, updated: 1000, pose: null }
  };
  const fused = L.fuseReadings(readings, 1001);
  assert.equal(fused.points.length, 1); assert.equal(fused.points[0].count, 2);
  assert.deepEqual(fused.points[0].sources, ['boom', 'right']); assert.deepEqual(fused.unplaced, ['rear']);
  assert.equal(L.fuseReadings(readings, 4000).points.length, 0);
  assert.equal(L.fuseReadings(readings, 4000).freshSensors, 0);
});
test('moving boom pose changes projection without reusing an old pose', () => {
  const before = L.parseFrame({ sensor: 'boom', distance_m: 1, pose: { x_m: 0, y_m: 2, yaw_deg: 0 } })[0];
  const after = L.parseFrame({ sensor: 'boom', distance_m: 1, pose: { x_m: 0, y_m: 4, yaw_deg: 0 } })[0];
  assert.equal(L.projectPoint(before.pose, { distance_m: 1, bearing_deg: 0 }).y_m, 3);
  assert.equal(L.projectPoint(after.pose, { distance_m: 1, bearing_deg: 0 }).y_m, 5);
  assert.equal(L.parseFrame({ sensor: 'boom', distance_m: 1 })[0].pose, null);
});
