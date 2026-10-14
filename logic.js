(function (root) {
  'use strict';
  const IDS = ['boom', 'rear', 'left', 'right'];
  const STALE_MS = 3000;
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  // x points right, y points forward. Yaw/bearing rotate clockwise from forward.
  const DEMO_POSES = {
    boom: { x_m: 0.45, y_m: 3.1, yaw_deg: 0 },
    rear: { x_m: 0, y_m: -2.2, yaw_deg: 180 },
    left: { x_m: -1.2, y_m: 0, yaw_deg: -90 },
    right: { x_m: 1.2, y_m: 0, yaw_deg: 90 }
  };
  function normalizeSettings(input = {}) {
    const maxRange = finite(input.maxRange) ? clamp(input.maxRange, 0.3, 10) : 3;
    const fullTone = finite(input.fullTone) ? clamp(input.fullTone, 0.1, maxRange - 0.1) : Math.min(0.5, maxRange - 0.1);
    return { maxRange, fullTone };
  }
  function alertProfile(distance, settings) {
    const { maxRange, fullTone } = normalizeSettings(settings);
    if (!finite(distance) || distance < 0) return { state: 'stale', active: false, progress: 0 };
    if (distance > maxRange) return { state: 'clear', active: false, progress: 0 };
    const progress = clamp((maxRange - distance) / (maxRange - fullTone), 0, 1);
    return {
      state: progress >= 0.98 ? 'close' : 'approaching', active: true, progress,
      frequencyHz: 420 + 1580 * Math.pow(progress, 1.15),
      periodSeconds: 0.12 + 1.08 * Math.pow(1 - progress, 1.65),
      duty: 0.1 + 0.85 * progress,
      continuous: progress >= 0.98
    };
  }
  function parseMeasurement(raw) {
    let data;
    try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
    if (!data || typeof data !== 'object' || !IDS.includes(data.sensor)) return null;
    let points = null;
    if ('points' in data) {
      if (!Array.isArray(data.points) || data.points.length === 0 || data.points.length > 512) return null;
      if (!data.points.every(p => p && finite(p.distance_m) && p.distance_m >= 0 && p.distance_m <= 100 && finite(p.bearing_deg) && Math.abs(p.bearing_deg) <= 180)) return null;
      points = data.points.map(p => ({ distance_m: p.distance_m, bearing_deg: p.bearing_deg }));
    }
    if ('distance_m' in data && (!finite(data.distance_m) || data.distance_m < 0 || data.distance_m > 100)) return null;
    if (!points && !finite(data.distance_m)) return null;
    let pose = null;
    if ('pose' in data) {
      const p = data.pose;
      if (!p || !finite(p.x_m) || !finite(p.y_m) || !finite(p.yaw_deg) || Math.abs(p.x_m) > 100 || Math.abs(p.y_m) > 100 || Math.abs(p.yaw_deg) > 360) return null;
      pose = { x_m: p.x_m, y_m: p.y_m, yaw_deg: p.yaw_deg };
    }
    // A scalar may be nearer than the supplied scan; use the closest valid value for sound.
    const nearest = Math.min(finite(data.distance_m) ? data.distance_m : Infinity, ...(points || []).map(p => p.distance_m));
    return { sensor: data.sensor, distance_m: nearest, points, pose };
  }
  function parseFrame(raw) {
    let data;
    try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
    if (data?.type !== 'frame') {
      const single = parseMeasurement(data);
      return single ? [single] : null;
    }
    if (!Array.isArray(data.measurements) || !data.measurements.length || data.measurements.length > 4) return null;
    const result = data.measurements.map(parseMeasurement);
    if (result.some(x => !x) || new Set(result.map(x => x.sensor)).size !== result.length) return null;
    return result;
  }
  function projectPoint(pose, point) {
    const radians = (pose.yaw_deg + point.bearing_deg) * Math.PI / 180;
    return { x_m: pose.x_m + Math.sin(radians) * point.distance_m, y_m: pose.y_m + Math.cos(radians) * point.distance_m };
  }
  function fuseReadings(readings, now, cellSize = 0.15) {
    if (!finite(cellSize) || cellSize <= 0) throw new Error('Positive cell size required');
    const cells = new Map();
    const unplaced = [];
    let freshSensors = 0;
    for (const id of IDS) {
      const r = readings[id];
      if (!r || now - r.updated >= STALE_MS || !finite(r.distance)) continue;
      freshSensors++;
      if (!r.pose) { unplaced.push(id); continue; }
      const points = r.points?.length ? r.points : [{ distance_m: r.distance, bearing_deg: 0 }];
      for (const point of points) {
        const world = projectPoint(r.pose, point);
        const key = `${Math.floor(world.x_m / cellSize)},${Math.floor(world.y_m / cellSize)}`;
        let cell = cells.get(key);
        if (!cell) { cell = { x_m: 0, y_m: 0, count: 0, sources: new Set(), urgency: 0 }; cells.set(key, cell); }
        cell.x_m += world.x_m; cell.y_m += world.y_m; cell.count++;
        cell.sources.add(id);
        cell.urgency = Math.max(cell.urgency, alertProfile(point.distance_m, r).progress);
      }
    }
    return { points: [...cells.values()].map(c => ({ x_m: c.x_m / c.count, y_m: c.y_m / c.count, count: c.count, sources: [...c.sources], urgency: c.urgency })), unplaced, freshSensors };
  }
  const api = { IDS, STALE_MS, DEMO_POSES, normalizeSettings, alertProfile, parseMeasurement, parseFrame, projectPoint, fuseReadings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SurroundLogic = api;
})(globalThis);
