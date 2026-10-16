'use strict';
// One authenticated polling source per Pi; different Pis can supply different sides.
const piSources = new Map();
function piMessage(text) { $('piStatus').textContent = text; }
function detachPiSensor(sensor) {
  for (const bridge of piSources.values()) if (bridge.sensor === sensor) stopPiSource(bridge);
}
function stopPiSource(bridge) {
  bridge.stopped = true; clearTimeout(bridge.timer); bridge.abort?.abort();
  piSources.delete(bridge.base);
  if (bridge.sensor) {
    const s = sensors[bridge.sensor]; s.distance = NaN; s.updated = 0; s.hardware = null; s.points = null; s.pose = null;
  }
}
function closePiSources() {
  for (const bridge of [...piSources.values()]) {
    stopPiSource(bridge);
    if (bridge.sensor && cameras[bridge.sensor].piBase === bridge.base) stopCamera(bridge.sensor, true);
  }
  piMessage('No Pi connected.');
}
function piUnavailable(bridge, message) {
  if (bridge.stopped) return;
  if (bridge.sensor) {
    const s = sensors[bridge.sensor]; s.distance = NaN; s.updated = 0; s.points = null; s.pose = null; if (s.hardware) s.hardware.updated = 0;
    const card = $('camera-' + bridge.sensor);
    card.classList.add('stale-video'); card.querySelector('.cam-status').textContent = 'PI FEED UNAVAILABLE';
    if (cameras[bridge.sensor].piBase === bridge.base) cameras[bridge.sensor].kind = 'error';
    renderSensors(); updateCameraCount();
  }
  piMessage(message);
}
function attachPiVideo(bridge) {
  const id = bridge.sensor;
  stopCamera(id, true);
  const cam = cameras[id], card = $('camera-' + id), token = cam.token;
  const image = document.createElement('img'); image.alt = title(id) + ' Pi camera with person boxes and ultrasonic target';
  image.referrerPolicy = 'no-referrer';
  const url = new URL('/video.mjpg', bridge.base); url.searchParams.set('key', bridge.key);
  cam.kind = 'connecting'; cam.piBase = bridge.base;
  card.querySelector('.cam-status').textContent = 'CONNECTING PI VIDEO';
  card.querySelector('.cam-note').textContent = 'Camera + calibrated ultrasonic sensor';
  image.onload = () => { if (cam.token !== token || bridge.stopped) return; bridge.videoLoaded = true; cam.kind = 'live'; card.classList.remove('stale-video'); card.querySelector('.cam-status').textContent = 'PI CAMERA'; updateCameraCount(); };
  image.onerror = () => { if (cam.token !== token || bridge.stopped) return; bridge.videoLoaded = false; bridge.retryVideoAt = performance.now() + 3000; cam.kind = 'error'; card.querySelector('.cam-status').textContent = 'VIDEO UNAVAILABLE'; updateCameraCount(); };
  card.querySelector('canvas').replaceWith(image); image.src = url.href; bridge.videoAttached = true;
}
async function pollPi(bridge) {
  if (bridge.stopped) return;
  const started = performance.now();
  const abort = bridge.abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 2000);
  try {
    const response = await fetch(new URL('/api/reading', bridge.base), { signal: abort.signal, cache: 'no-store', headers: { Authorization: 'Bearer ' + bridge.key }, referrerPolicy: 'no-referrer' });
    if (bridge.stopped) return;
    if (response.status === 401) { piUnavailable(bridge, 'Connection key rejected. Check the key on your Pi.'); stopPiSource(bridge); return; }
    if (!response.ok) throw new Error('Pi request failed (' + response.status + ').');
    const data = await response.json();
    if (bridge.stopped) return;
    if (!data.ready) throw new Error(String(data.error || 'Pi is waiting for its first camera frame.'));
    if (data.error) throw new Error('Pi capture stopped: ' + String(data.error));
    if (!ids.includes(data.sensor) || !Number.isSafeInteger(data.sequence) || data.sequence < 1 || !Number.isFinite(data.age_ms) || data.age_ms < 0 || !Number.isFinite(data.sensor_max_m) || data.sensor_max_m <= 0 || data.sensor_max_m > 100 || !['valid', 'at_limit', 'invalid'].includes(data.range_status)) throw new Error('Pi returned an invalid reading.');
    const age = data.age_ms + performance.now() - started;
    if (age >= L.STALE_MS) throw new Error('Pi readings are stale. Check camera capture on the Pi.');
    if (bridge.sensor && bridge.sensor !== data.sensor) throw new Error('Pi sensor position changed. Disconnect and reconnect this Pi.');
    if (data.sequence === bridge.sequence) {
      if (Date.now() - bridge.lastSampleAt >= L.STALE_MS) throw new Error('Pi is not producing new frames.');
      return; // Repeated HTTP responses cannot keep a frozen sample alive.
    }
    const reading = data.range_status === 'valid' ? L.parseMeasurement({ sensor: data.sensor, distance_m: data.distance_m, ...(data.pose ? { pose: data.pose } : {}) }) : null;
    if (data.range_status === 'valid' && !reading) throw new Error('Pi distance or sensor pose is invalid.');
    if (!bridge.sensor) {
      detachPiSensor(data.sensor); bridge.sensor = data.sensor;
    }
    bridge.sequence = data.sequence; bridge.lastSampleAt = Date.now() - age;
    const s = sensors[bridge.sensor];
    s.distance = reading ? reading.distance_m : NaN; s.updated = reading ? Date.now() - age : 0;
    s.points = null; s.pose = reading?.pose || null;
    s.hardware = { updated: Date.now() - age, maxRange: data.sensor_max_m, rangeStatus: data.range_status,
      people: Array.isArray(data.detections?.people) ? Math.min(data.detections.people.length, 500) : null, newObject: data.detections?.new_object === true };
    const card = $('camera-' + bridge.sensor); card.classList.remove('stale-video');
    if (!bridge.videoAttached || (bridge.retryVideoAt && performance.now() >= bridge.retryVideoAt)) { bridge.retryVideoAt = null; attachPiVideo(bridge); }
    else if (bridge.videoLoaded) { cameras[bridge.sensor].kind = 'live'; card.querySelector('.cam-status').textContent = 'PI CAMERA'; }
    piMessage('Connected: ' + [...piSources.values()].filter(b => b.sensor).map(b => title(b.sensor)).join(', ') + '. Video and ultrasonic data are live.');
    renderSensors(); updateCameraCount();
  } catch (error) {
    if (!bridge.stopped) piUnavailable(bridge, error.name === 'AbortError' ? 'Pi did not respond. Retrying…' : error.message + ' Retrying…');
  } finally {
    clearTimeout(timeout);
    if (!bridge.stopped) bridge.timer = setTimeout(() => pollPi(bridge), 250);
  }
}
$('connectPi').onclick = () => {
  let base;
  try {
    const url = new URL($('piUrl').value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Use the Pi origin, for example http://192.168.1.25:8080.');
    if (location.protocol === 'https:' && url.protocol !== 'https:') throw new Error('Open this dashboard over HTTP on localhost or the Pi to connect to an HTTP bridge.');
    base = url.origin;
  } catch (error) { piMessage(error.message); return; }
  const key = $('piKey').value.trim();
  if (key.length < 24) { piMessage('Enter the connection key from hardware/bridge-token.txt on the Pi.'); return; }
  if (socket) { socket.onclose = null; socket.close(); socket = null; invalidateReadings(); }
  if (mode === 'demo') { setMode('live'); invalidateReadings(); }
  const old = piSources.get(base); if (old) { stopPiSource(old); if (old.sensor) stopCamera(old.sensor, true); }
  const bridge = { base, key, sequence: -1, sensor: null, stopped: false, videoAttached: false };
  piSources.set(base, bridge); $('piKey').value = ''; piMessage('Connecting to Pi…'); pollPi(bridge);
};
$('disconnectPi').onclick = () => { closePiSources(); renderSensors(); piMessage('Pi devices disconnected. Choose Use demo to return to simulation.'); };
if (location.port === '8080') $('piUrl').value = location.origin;
