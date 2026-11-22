'use strict';
const $ = id => document.getElementById(id);
const L = SurroundLogic, ids = L.IDS;
const formatDistance = (meters, digits = 2) => L.metersToFeet(meters).toFixed(digits) + ' ft';
const title = id => id === 'boom' ? 'Boom arm' : id.charAt(0).toUpperCase() + id.slice(1);
// All four start at 15 ft, past the default 10 ft max range. Sound and buzz stay
// quiet until an obstacle moves inside the range set on the Settings page.
const demoDistances = [15, 15, 15, 15].map(L.feetToMeters);
const GEAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="8.4" stroke-width="3" stroke-dasharray="3.3 3.3"/><circle cx="12" cy="12" r="6.2" stroke-width="1.8"/><circle cx="12" cy="12" r="2.3" stroke-width="1.8"/></svg>';
let stored = {};
try { stored = JSON.parse(localStorage.getItem('surround-settings-v2') || localStorage.getItem('surround-settings') || '{}') || {}; } catch {}
const sensors = Object.fromEntries(ids.map((id, i) => {
  const pref = stored[id] || (id === 'boom' ? stored.front : null) || {};
  return [id, { ...L.normalizeSettings({ maxRange: pref.maxRange ?? pref.warning, fullTone: pref.fullTone ?? pref.critical }), distance: demoDistances[i], updated: Date.now(), pose: L.DEMO_POSES[id], points: null, status: 'clear' }];
}));
let sharedRanges = stored.sharedRanges !== false;
let sharedSettings = L.normalizeSettings(stored.sharedSettings || sensors.boom);
if (sharedRanges) ids.forEach(id => Object.assign(sensors[id], sharedSettings));
function applyDistanceSettings(target, key, maxFeet, toneFeet) {
  if (key === 'maxRange') toneFeet = Math.min(toneFeet, Math.round((maxFeet - 0.1) * 10) / 10);
  else maxFeet = Math.max(maxFeet, Math.round((toneFeet + 0.1) * 10) / 10);
  Object.assign(target, L.normalizeSettings({ maxRange: L.feetToMeters(maxFeet), fullTone: L.feetToMeters(toneFeet) }));
}
function syncRangeControls() {
  $('sharedRanges').checked = sharedRanges;
  $('sharedRangeControls').hidden = !sharedRanges;
  ids.forEach(id => {
    $('ranges-' + id).hidden = sharedRanges;
    ['maxRange', 'fullTone'].forEach(key => $(key + '-' + id).value = L.metersToFeet(sensors[id][key]).toFixed(1));
  });
  ['maxRange', 'fullTone'].forEach(key => {
    $(key + '-all').value = L.metersToFeet(sharedSettings[key]).toFixed(1);
    $(key + 'Value-all').textContent = formatDistance(sharedSettings[key], 1);
  });
}
function distanceSettingsChanged() {
  syncRangeControls(); save(); renderSensors();
  window.dispatchEvent(new Event('surround-distance-settings'));
}
const cameras = Object.fromEntries(ids.map(id => [id, { kind: 'demo', stream: null, token: 0 }]));
const audio = new ProximityAudio();
let mode = 'demo', socket = null, soundOn = false, layout = stored.layout === 1 ? 1 : 4, userCameras = [];
function save() {
  try { localStorage.setItem('surround-settings-v2', JSON.stringify({ ...Object.fromEntries(ids.map(id => [id, { maxRange: sensors[id].maxRange, fullTone: sensors[id].fullTone }])), layout, sharedRanges, sharedSettings })); }
  catch { $('footerStatus').textContent = 'Settings cannot be saved in this browser.'; }
}
function log(message, level = 'clear') {
  const row = document.createElement('div'); row.className = 'event ' + level;
  const time = document.createElement('time'); time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  row.append(time, document.createTextNode(message)); $('log').prepend(row);
  while ($('log').children.length > 35) $('log').lastChild.remove();
}
function buildSensors() {
  // Each row shows its zones on a 0–15 ft strip, so range changes are visible immediately.
  $('sensorList').innerHTML = ids.map(id => `<div class="sensor" id="sensor-${id}" tabindex="-1"><div class="sensor-head"><span class="sensor-name">${title(id)} sensor</span><span class="reading" id="reading-${id}">—</span></div><div class="sensor-status" id="status-${id}"></div><p class="hardware-meta" id="hardware-${id}" hidden></p><div class="range-strip" aria-hidden="true"><span class="zone tone" id="zoneTone-${id}"></span><span class="zone beep" id="zoneBeep-${id}"></span><i class="strip-light" id="lightTick-${id}" hidden></i><i class="strip-marker" id="marker-${id}" hidden></i></div><div class="strip-scale" aria-hidden="true"><span>0</span><span>5</span><span>10</span><span>15 ft</span></div><div id="ranges-${id}" class="sensor-range-controls range-pair"><div><label class="range-label" for="maxRange-${id}">Max range <output id="maxRangeValue-${id}"></output></label><input type="range" id="maxRange-${id}" min="1" max="15" step="0.1" value="${L.metersToFeet(sensors[id].maxRange).toFixed(1)}"></div><div><label class="range-label" for="fullTone-${id}">Full tone at <output id="fullToneValue-${id}"></output></label><input class="critical-range" type="range" id="fullTone-${id}" min="0.1" max="14.9" step="0.1" value="${L.metersToFeet(sensors[id].fullTone).toFixed(1)}"></div></div></div>`).join('');
  ids.forEach(id => ['maxRange', 'fullTone'].forEach(key => $(`${key}-${id}`).addEventListener('input', e => {
    if (sharedRanges) return;
    applyDistanceSettings(sensors[id], key, Number($('maxRange-' + id).value), Number($('fullTone-' + id).value));
    distanceSettingsChanged();
  })));
  $('sharedRanges').onchange = () => {
    sharedRanges = $('sharedRanges').checked;
    if (sharedRanges) ids.forEach(id => Object.assign(sensors[id], sharedSettings));
    distanceSettingsChanged();
  };
  ['maxRange', 'fullTone'].forEach(key => $(key + '-all').oninput = () => {
    applyDistanceSettings(sharedSettings, key, Number($('maxRange-all').value), Number($('fullTone-all').value));
    if (sharedRanges) ids.forEach(id => Object.assign(sensors[id], sharedSettings));
    distanceSettingsChanged();
  });
  syncRangeControls();
  $('mapReadouts').innerHTML = ids.map(id => `<button type="button" id="map-${id}" class="map-readout" title="${title(id)} sensor settings"><span>${title(id)}</span><strong>—</strong></button>`).join('');
  ids.forEach(id => $('map-' + id).onclick = event => { event.stopPropagation(); openQuick('sensor', id); });
}
function demoPoints(distance) { return L.demoScan(distance); }
function renderSensors() {
  const now = Date.now();
  let winner = null;
  ids.forEach(id => {
    const s = sensors[id];
    if (mode === 'demo') { s.updated = now; s.points = demoPoints(s.distance); }
    const fresh = now - s.updated < L.STALE_MS;
    const profile = L.alertProfile(fresh ? s.distance : NaN, s), next = profile.state;
    if (s.status !== next) {
      log(`${title(id)}: ${{ stale: 'no fresh sensor data', clear: 'outside alert range', approaching: 'distance-scaled beeps', close: 'full tone' }[next]}${mode === 'demo' ? ' (demo)' : ''}.`, next); s.status = next;
    }
    // Toggle only state classes so the Settings highlight (flash) is not wiped every frame.
    ['stale', 'clear', 'approaching', 'close'].forEach(state => $(`sensor-${id}`).classList.toggle(state, state === next));
    $(`reading-${id}`).innerHTML = next === 'stale' ? '— <small>ft</small>' : `${L.metersToFeet(s.distance).toFixed(2)} <small>ft</small>`;
    $(`status-${id}`).textContent = (mode === 'demo' ? 'SIMULATED · ' : 'LIVE · ') + ({ clear: 'OUTSIDE ALERT RANGE', approaching: 'INTENSITY ' + Math.round(profile.progress * 100) + '%', close: 'FULL TONE', stale: 'NO FRESH DATA' }[next]);
    const hardware = s.hardware, hardwareFresh = hardware && now - hardware.updated < L.STALE_MS;
    const metadata = $('hardware-' + id); metadata.hidden = !hardware;
    if (hardwareFresh) {
      metadata.textContent = 'Ultrasonic · limit ' + formatDistance(hardware.maxRange) + ' · ' + (hardware.people === null ? 'people detection unavailable' : hardware.people + ' people detected') + (hardware.newObject ? ' · NEW OBJECT' : '');
      if (hardware.rangeStatus === 'at_limit') $('status-' + id).textContent = 'LIVE · AT SENSOR LIMIT / NO EXACT DISTANCE';
    } else if (hardware) metadata.textContent = 'Hardware feed unavailable';
    // Keep Pi detections visible on the dashboard camera card as well.
    const note = cameras[id].piBase && $('camera-' + id).querySelector('.cam-note');
    if (note) note.textContent = hardwareFresh ? (hardware.people === null ? 'People detection unavailable' : hardware.people + ' people detected') + (hardware.newObject ? ' · NEW OBJECT' : '') : 'Camera + calibrated ultrasonic sensor';
    ['maxRange', 'fullTone'].forEach(key => $(`${key}Value-${id}`).textContent = formatDistance(s[key], 1));
    renderRangeStrip(id, next);
    $(`map-${id}`).className = 'map-readout ' + next;
    $(`map-${id}`).querySelector('strong').textContent = next === 'stale' ? 'No data' : formatDistance(s.distance);
    if (profile.active && (!winner || profile.progress > winner.progress)) winner = { ...profile, sensor: id };
  });
  audio.setProfile(soundOn ? winner : null);
  const soundText = winner ? `${title(winner.sensor)} · ${Math.round(winner.frequencyHz)} Hz · ${winner.continuous ? 'sustained tone' : (1 / winner.periodSeconds).toFixed(1) + ' beeps / sec'}${soundOn ? '' : ' · muted'}` : 'No fresh readings inside an alert range.';
  ['audioSummary', 'audioSummaryDemo'].forEach(target => { if ($(target).textContent !== soundText) $(target).textContent = soundText; });
  renderMap(now);
  drawDemos();
  renderDemoStatus();
  if ($('quick').open) renderQuick();
}
const STRIP_METERS = L.feetToMeters(L.MAX_RANGE_FT);
const stripPercent = meters => Math.max(0, Math.min(100, meters / STRIP_METERS * 100)) + '%';
function renderRangeStrip(id, state) {
  const s = sensors[id];
  $('zoneTone-' + id).style.width = stripPercent(s.fullTone);
  const beep = $('zoneBeep-' + id);
  beep.style.left = stripPercent(s.fullTone); beep.style.width = stripPercent(s.maxRange - s.fullTone);
  const marker = $('marker-' + id);
  marker.hidden = state === 'stale';
  if (!marker.hidden) { marker.style.left = stripPercent(s.distance); marker.className = 'strip-marker ' + state; }
  // light.js loads after this file; the tick appears once it is ready.
  const tick = $('lightTick-' + id), lightReady = typeof lightThresholdMeters === 'function';
  tick.hidden = !lightReady || $('lightSensor').value !== id;
  if (!tick.hidden) { tick.style.left = stripPercent(lightThresholdMeters()); tick.classList.toggle('off', !$('lightEnabled').checked); }
}
function renderMap(now) {
  const fused = L.fuseReadings(sensors, now);
  const extent = Math.max(8, ...fused.points.flatMap(p => [Math.abs(p.x_m) + 1, Math.abs(p.y_m) + 1]));
  const bounds = [-extent, -extent, extent * 2, extent * 2];
  const rays = [], mounts = [];
  ids.forEach(id => {
    const s = sensors[id]; if (now - s.updated >= L.STALE_MS || !s.pose || !Number.isFinite(s.distance)) return;
    const p = s.pose;
    mounts.push(`<circle cx="${p.x_m}" cy="${-p.y_m}" r=".1" fill="#c4ed8c"><title>${title(id)} sensor</title></circle>`);
    (s.points || [{ distance_m: s.distance, bearing_deg: 0 }]).forEach(ray => {
      const point = L.projectPoint(p, ray);
      rays.push(`<line x1="${p.x_m}" y1="${-p.y_m}" x2="${point.x_m}" y2="${-point.y_m}" stroke="#a6c18c" opacity=".17" stroke-width=".025"/>`);
    });
  });
  const points = fused.points.map(p => `<circle cx="${p.x_m}" cy="${-p.y_m}" r="${p.sources.length > 1 ? '.15' : '.11'}" fill="hsl(${95 - p.urgency * 85} 70% 68%)" stroke="#17221a" stroke-width=".035"><title>${p.sources.map(title).join(' + ')} · ${L.metersToFeet(p.x_m).toFixed(2)}, ${L.metersToFeet(p.y_m).toFixed(2)} ft · ${p.count} returns</title></circle>`);
  mapTargets.forEach(target => {
    target.svg.setAttribute('viewBox', bounds.join(' '));
    ['x', 'y', 'width', 'height'].forEach((key, i) => target.grid.setAttribute(key, bounds[i]));
    target.rays.innerHTML = rays.join(''); target.sensors.innerHTML = mounts.join('');
    // Only the dashboard map carries source IDs, so lookups by data-sources stay unambiguous.
    target.points.innerHTML = target.main ? points.map((markup, i) => markup.replace('<circle ', `<circle data-sources="${fused.points[i].sources.join(',')}" `)).join('') : points.join('');
  });
  $('mapBadge').textContent = mode === 'demo' ? 'DEMO GEOMETRY' : fused.unplaced.length ? 'NEEDS SENSOR POSES' : 'LIVE COORDINATES';
  $('mapSummary').textContent = `${fused.freshSensors}/4 fresh sensors · ${fused.points.length} combined points${fused.unplaced.length ? ' · Unplaced: ' + fused.unplaced.map(title).join(', ') : ''}${mode === 'demo' ? ' · demo mounts and distances' : ''}`;
}
// The dashboard map plus read-only copies shown as previews on the Settings and Demo tabs.
const mapTargets = [{ main: true, svg: $('proximityMap'), grid: $('gridBackground'), rays: $('mapRays'), sensors: $('mapSensors'), points: $('mapPoints') }];
function addMapPreview(containerId) {
  const prefix = containerId + '-', svg = $('proximityMap').cloneNode(true);
  svg.removeAttribute('id'); svg.removeAttribute('aria-labelledby'); svg.setAttribute('aria-label', 'Proximity map preview');
  svg.querySelectorAll('title[id], desc[id]').forEach(node => node.remove());
  svg.querySelectorAll('[id]').forEach(node => node.id = prefix + node.id);
  const part = name => svg.querySelector('#' + prefix + name);
  part('gridBackground').setAttribute('fill', `url(#${prefix}grid)`);
  $(containerId).append(svg);
  mapTargets.push({ svg, grid: part('gridBackground'), rays: part('mapRays'), sensors: part('mapSensors'), points: part('mapPoints') });
}
function cameraElement(id){
 const card=document.createElement('article');card.className='camera';card.id='camera-'+id;
 card.innerHTML=`<canvas aria-label="Illustrated demo view, not a live camera feed"></canvas><div class="cam-top"><span class="cam-label">${title(id).toUpperCase()} <span style="opacity:.5">/ 0${ids.indexOf(id)+1}</span></span><span class="cam-top-right"><span class="cam-status">ILLUSTRATED DEMO</span><button type="button" class="adjust-button cam-adjust" aria-label="${title(id)} sensor settings">${GEAR_ICON}</button></span></div><div class="cam-bottom"><span class="cam-note">No camera connected</span><button type="button" class="cam-connect">Connect camera ↗</button></div>`;
 card.querySelector('.cam-connect').onclick=()=>openDevices(id);
 card.querySelector('.cam-adjust').onclick=()=>openQuick('sensor',id);
 // Clicking the picture opens the same summary; video controls and buttons keep their own behavior.
 card.addEventListener('click',event=>{if(!event.target.closest('button, a, video, input, select'))openQuick('sensor',id);});
 return card;
}
function openDevices(id){$('quick').close();$('devices').showModal();if(id)$(`source-${id}`).focus();}
function renderCameras(){
 const grid=$('cameraGrid');
 // Keep live video elements and MediaStreams mounted when changing layouts.
 if(!grid.children.length)ids.forEach(id=>grid.append(cameraElement(id)));
 ids.forEach((id,i)=>$('camera-'+id).hidden=layout===1&&i>0);
 grid.classList.toggle('single',layout===1);$('single').classList.toggle('selected',layout===1);$('multi').classList.toggle('selected',layout===4);
 requestAnimationFrame(drawDemos);
}
function drawDemos() {
  ids.forEach(id => {
    const card = $('camera-' + id), canvas = card.querySelector('canvas');
    if (canvas && !card.hidden) drawScene(canvas, id);
  });
  drawScene($('demoView'), $('demoSensor').value);
}
function drawScene(canvas, id) {
  const simulated = mode === 'demo', distance = sensors[id].distance;
  const key = id + ':' + simulated + ':' + distance;
  if (canvas.dataset.renderKey === key) return;
  canvas.dataset.renderKey = key;
  const w = canvas.width = 800, h = canvas.height = 470, c = canvas.getContext('2d');
  const van = { x: 400, y: 185 };
  const grad = c.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#26323a'); grad.addColorStop(1, '#11191f');
  c.fillStyle = grad; c.fillRect(0, 0, w, h);
  c.strokeStyle = '#7b928528'; c.lineWidth = 1;
  for (let x = -900; x < 1800; x += 100) { c.beginPath(); c.moveTo(van.x, van.y); c.lineTo(x, h); c.stroke(); }
  for (let y = 195; y < h; y += Math.max(14, (y - 150) * 0.22)) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  for (const side of [0, 1]) {
    c.fillStyle = side ? '#1d2930' : '#243139'; c.beginPath(); c.moveTo(side ? 800 : 0, 0); c.lineTo(side ? 530 : 270, 130); c.lineTo(side ? 530 : 270, 280); c.lineTo(side ? 800 : 0, 470); c.fill();
    c.strokeStyle = '#6f8d713b'; c.lineWidth = 4;
    for (let i = 0; i < 4; i++) { const x = side ? 800 - i * 85 : i * 85; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h - i * 52); c.stroke(); }
    for (let j = 0; j < 3; j++) { c.beginPath(); c.moveTo(side ? 800 : 0, 85 + j * 105); c.lineTo(side ? 530 : 270, 145 + j * 49); c.stroke(); }
  }
  c.strokeStyle = '#d3df9d66'; c.lineWidth = 3; c.beginPath(); c.moveTo(195, h); c.lineTo(350, 225); c.moveTo(605, h); c.lineTo(450, 225); c.stroke();
  if (simulated) {
    // One fixed-size obstacle, projected using the same metric distance/width as the map scan.
    const depth = Math.max(0.05, distance), focal = 335;
    const width = focal * L.DEMO_OBSTACLE.width_m / depth;
    const height = focal * L.DEMO_OBSTACLE.height_m / depth;
    const bottom = van.y + focal * L.DEMO_OBSTACLE.camera_height_m / depth;
    const left = van.x - width / 2, top = bottom - height;
    c.fillStyle = '#7f8c6d'; c.fillRect(left, top, width, height);
    c.fillStyle = '#9aa886'; c.fillRect(left, top, Math.min(6, width * 0.07), height);
    c.strokeStyle = '#d0dda4'; c.lineWidth = 2; c.strokeRect(left - 5, top - 5, width + 10, height + 10);
    const labelY = Math.max(85, Math.min(345, top - 20));
    c.font = '600 16px Segoe UI'; c.textAlign = 'center';
    const label = 'SIMULATED · ' + formatDistance(distance);
    const labelWidth = c.measureText(label).width;
    c.fillStyle = '#101b16eb'; c.fillRect(van.x - labelWidth / 2 - 10, labelY - 18, labelWidth + 20, 26);
    c.fillStyle = '#dfebc7'; c.fillText(label, van.x, labelY);
    canvas.setAttribute('aria-label', title(id) + ' simulated view: obstacle ' + L.metersToFeet(distance).toFixed(2) + ' feet away');
  } else {
    canvas.setAttribute('aria-label', title(id) + ' camera placeholder. No simulated obstacle in live sensor mode.');
  }
  c.fillStyle = '#d4e2d166'; c.font = '12px Segoe UI'; c.textAlign = 'center';
  c.fillText('ILLUSTRATED CAMERA PLACEHOLDER', 400, 402);
}

function updateCameraCount(){$('cameraCount').textContent=ids.filter(id=>cameras[id].kind==='live').length+' connected';}
function stopCamera(id, keepPi = false){
 if (!keepPi && typeof detachPiSensor === 'function') detachPiSensor(id);
 const cam=cameras[id];cam.token++;if(cam.stream)cam.stream.getTracks().forEach(t=>t.stop());cam.stream=null;cam.kind='demo';cam.piBase=null;
 const old=$('camera-'+id);old.querySelectorAll('video').forEach(v=>{v.pause();v.srcObject=null;v.removeAttribute('src');v.load();});old.querySelectorAll('img').forEach(i=>i.removeAttribute('src'));
 old.replaceWith(cameraElement(id));renderCameras();updateCameraCount();
}
async function refreshUsbOptions(){
 userCameras=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
 ids.forEach(id=>{const select=$('usb-'+id),old=select.value;select.replaceChildren(new Option('Default webcam',''));userCameras.forEach((d,i)=>select.add(new Option(d.label||'Camera '+(i+1),d.deviceId)));if(userCameras.some(d=>d.deviceId===old))select.value=old;});
}
function buildSetup(){
 $('cameraSetup').innerHTML=ids.map(id=>`<div class="setup-row"><label for="source-${id}">${title(id)} camera</label><div class="setup-inputs"><select id="source-${id}" aria-label="${title(id)} camera source"><option value="usb">USB webcam</option><option value="mjpeg">MJPEG / image</option><option value="video">Video URL</option></select><select id="usb-${id}" aria-label="${title(id)} USB device"><option value="">Default webcam</option></select><input hidden type="url" id="url-${id}" placeholder="http://camera/stream" aria-label="${title(id)} stream URL"><button id="connect-${id}">Connect</button><button id="remove-${id}" aria-label="Disconnect ${id} camera">Reset</button></div><p class="section-copy" id="cameraMessage-${id}">USB requires camera permission. Network feeds must be browser-compatible.</p></div>`).join('');
 ids.forEach(id=>{
  $('source-'+id).onchange=e=>{const usb=e.target.value==='usb';$('usb-'+id).hidden=!usb;$('url-'+id).hidden=usb;};
  $('remove-'+id).onclick=()=>{stopCamera(id);$('cameraMessage-'+id).textContent='Camera disconnected. Demo illustration restored.';};
  $('connect-'+id).onclick=()=>connectCamera(id);
 });
}
async function connectCamera(id){
 const type=$('source-'+id).value,deviceId=$('usb-'+id).value;
 stopCamera(id);const cam=cameras[id],token=cam.token,card=$('camera-'+id);cam.kind='connecting';
 const status=card.querySelector('.cam-status'),note=card.querySelector('.cam-note');status.textContent='CONNECTING';
 const fail=message=>{if(cam.token!==token)return;cam.kind='error';status.textContent='UNAVAILABLE';note.textContent='No confirmed live feed';$('cameraMessage-'+id).textContent=message;updateCameraCount();};
 const ready=()=>{if(cam.token!==token)return;cam.kind='live';status.textContent=type==='mjpeg'?'IMAGE STREAM':'VIDEO CONNECTED';note.textContent=type==='mjpeg'?'Image endpoint · freshness unverified':'Distance uses separate sensor data';$('cameraMessage-'+id).textContent='Connected. Video alone does not measure distance.';updateCameraCount();};
 try{
  let media;
  if(type==='usb'){
   if(!navigator.mediaDevices?.getUserMedia)throw new Error('Open on localhost or HTTPS to use USB cameras.');
   const stream=await navigator.mediaDevices.getUserMedia({video:deviceId?{deviceId:{exact:deviceId}}:true,audio:false});
   if(cam.token!==token){stream.getTracks().forEach(t=>t.stop());return;}
   cam.stream=stream;media=document.createElement('video');media.muted=true;media.autoplay=true;media.playsInline=true;media.srcObject=stream;
   stream.getVideoTracks().forEach(t=>t.onended=()=>fail('Camera disconnected. Reconnect it to restore video.'));
   media.onplaying=ready;card.querySelector('canvas').replaceWith(media);await media.play();await refreshUsbOptions();
  }else{
   const url=new URL($('url-'+id).value);if(!['http:','https:'].includes(url.protocol))throw new Error('Use an HTTP or HTTPS browser-compatible stream. RTSP needs a local bridge.');
   if(location.protocol==='https:'&&url.protocol==='http:')throw new Error('HTTPS pages need HTTPS camera streams, or run this dashboard on localhost.');
   media=document.createElement(type==='mjpeg'?'img':'video');
   if(type==='mjpeg'){media.alt=title(id)+' network camera';media.onload=ready;}else{media.muted=true;media.autoplay=true;media.playsInline=true;media.controls=true;media.onplaying=ready;media.onwaiting=()=>{if(cam.token===token){cam.kind='buffering';status.textContent='BUFFERING';updateCameraCount();}};media.onended=()=>fail('Video has ended.');}
   media.onerror=()=>fail('Cannot load stream. Check the URL, network, browser format, and camera permissions.');card.querySelector('canvas').replaceWith(media);media.src=url.href;
   if(type==='video')await media.play();
  }
 }catch(error){fail(error.message);}
}

$('audio').onclick = async () => {
  try {
    if (!soundOn) await audio.start(); soundOn = !soundOn;
    if (!soundOn) audio.stop();
    $('audio').textContent = soundOn ? 'Mute beeps' : 'Enable beeps'; $('soundStatus').textContent = soundOn ? 'ENABLED' : 'MUTED';
    log(soundOn ? 'Distance-scaled audio enabled.' : 'Browser beeps muted.'); renderSensors();
  } catch (error) { log('Audio could not start: ' + error.message, 'approaching'); }
};
$('testSound').onclick = () => audio.test().catch(error => log(error.message, 'approaching'));
$('volume').oninput = e => { audio.volume = Number(e.target.value) / 100; $('volumeValue').textContent = e.target.value + '%'; };
$('single').onclick = () => { layout = 1; save(); renderCameras(); }; $('multi').onclick = () => { layout = 4; save(); renderCameras(); };
$('settingsButton').onclick = () => openDevices(); $('clearLog').onclick = () => $('log').replaceChildren();
// The Demo tab and the Settings preview share one simulated obstacle per side.
const demoControls = [['demoSensor', 'obstacle', 'obstacleValue'], ['previewSensor', 'previewObstacle', 'previewObstacleValue']];
function syncDemoControl() {
  const id = $('demoSensor').value, value = sensors[id].distance;
  demoControls.forEach(([select, slider, output]) => {
    $(select).value = id;
    if (Number.isFinite(value)) $(slider).value = L.metersToFeet(value);
    $(output).textContent = Number.isFinite(value) ? formatDistance(value) : '— ft';
  });
}
demoControls.forEach(([select, slider]) => {
  $(select).onchange = () => { $('demoSensor').value = $(select).value; syncDemoControl(); drawDemos(); renderDemoStatus(); };
  $(slider).oninput = e => { if (mode !== 'demo') return; sensors[$('demoSensor').value].distance = L.feetToMeters(Number(e.target.value)); syncDemoControl(); renderSensors(); };
});
function renderDemoStatus() {
  const id = $('demoSensor').value, s = sensors[id];
  const heading = title(id) + ' camera';
  const text = mode === 'demo' ? `${title(id)} obstacle at ${formatDistance(s.distance)} · ${STATE_TEXT[s.status] || ''}` : 'Live sensor mode. Simulated obstacles are off.';
  if ($('demoViewTitle').textContent !== heading) $('demoViewTitle').textContent = heading;
  if ($('demoViewStatus').textContent !== text) $('demoViewStatus').textContent = text;
}
function resetDemo() {
  ids.forEach((id, i) => Object.assign(sensors[id], { distance: demoDistances[i], updated: Date.now(), pose: L.DEMO_POSES[id], points: demoPoints(demoDistances[i]), hardware: null })); syncDemoControl(); renderSensors();
}
$('resetDemo').onclick = () => { if (mode === 'demo') resetDemo(); };
function setMode(next) {
  mode = next; const demo = next === 'demo';
  $('modeBadge').textContent = demo ? '● DEMO MODE' : '● LIVE SENSOR MODE';
  ['obstacle', 'demoSensor', 'resetDemo', 'previewSensor', 'previewObstacle'].forEach(id => $(id).disabled = !demo);
  $('previewMode').textContent = demo ? 'DEMO' : 'LIVE';
  $('previewModeNote').textContent = demo ? 'Alerts begin at max range. Sound and buzz follow the closest obstacle inside that range.' : 'Showing live readings. Test distance works in demo mode.';
  $('demoModeNote').hidden = demo;
  $('demoModeNote').textContent = demo ? '' : 'Live sensors are connected. Choose Use demo in Connect devices to return to simulation.';
  $('footerStatus').textContent = (demo ? '4 simulated sensors' : 'Live sensor input · stale after 3 seconds') + ' · settings saved on this browser';
}

// Tabs: Dashboard, Settings, Demo. The URL hash keeps the selected tab on reload.
const VIEWS = ['dashboard', 'settings', 'demo'];
let activeView = null;
function showView(view) {
  if (!VIEWS.includes(view)) view = 'dashboard';
  const changed = view !== activeView; activeView = view;
  VIEWS.forEach(v => $('view-' + v).hidden = v !== view);
  document.querySelectorAll('.rail-link').forEach(link => link.dataset.view === view ? link.setAttribute('aria-current', 'page') : link.removeAttribute('aria-current'));
  if (changed) { window.scrollTo(0, 0); requestAnimationFrame(drawDemos); }
}
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
function openSettings(targetId) {
  if (location.hash !== '#settings') history.pushState(null, '', '#settings');
  showView('settings');
  const target = $(targetId);
  target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  target.focus({ preventScroll: true });
  target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash');
}

// Dashboard popups: a short summary of the clicked item, with a shortcut to its settings.
const STATE_TEXT = { stale: 'No fresh data', clear: 'Outside alert range', approaching: 'Beeping', close: 'Full tone' };
const CAMERA_TEXT = { demo: 'Not connected · illustrated view', connecting: 'Connecting', live: 'Connected', buffering: 'Buffering', error: 'Unavailable' };
let quickState = null;
function openQuick(kind, id) {
  quickState = { kind, id }; $('quick').dataset.signature = '';
  renderQuick();
  if (!$('quick').open) $('quick').showModal();
}
function renderQuick() {
  const { kind, id } = quickState, rows = [];
  let eyebrow, heading, note, target, label, extra = null;
  if (kind === 'sensor') {
    const s = sensors[id], profile = L.alertProfile(Date.now() - s.updated < L.STALE_MS ? s.distance : NaN, s);
    eyebrow = 'SENSOR'; heading = title(id);
    rows.push(['Reading', profile.state === 'stale' ? 'No data' : formatDistance(s.distance)],
      ['Alert', profile.state === 'approaching' ? 'Beeping · ' + Math.round(profile.progress * 100) + '%' : STATE_TEXT[profile.state]],
      ['Max range', formatDistance(s.maxRange, 1)], ['Full tone at', formatDistance(s.fullTone, 1)],
      ['Camera', CAMERA_TEXT[cameras[id].kind] || cameras[id].kind]);
    note = sharedRanges ? 'All sides currently share the same distances.' : 'This side has its own distances.';
    target = sharedRanges ? 'settings-proximity' : 'sensor-' + id; label = 'Adjust distances';
    extra = { label: 'Camera setup ↗', run: () => openDevices(id) };
  } else if (kind === 'map') {
    eyebrow = 'PROXIMITY MAP'; heading = 'Alert distances';
    ids.forEach(sid => rows.push([title(sid), `Beeps from ${formatDistance(sensors[sid].maxRange, 1)} · full tone at ${formatDistance(sensors[sid].fullTone, 1)}`]));
    note = sharedRanges ? 'Same distances for all sides.' : 'Each side has its own distances.';
    target = 'settings-proximity'; label = 'Adjust distances';
  } else if (kind === 'light') {
    eyebrow = 'DRIVER WARNING LIGHT'; heading = 'Warning light';
    rows.push(['Sensor / Pi', title($('lightSensor').value)],
      ['Flashes within', formatDistance(lightThresholdMeters(), 1) + ($('lightManual').checked ? ' · set manually' : ' · synced to Full tone at')],
      ['Light setting', $('lightEnabled').checked ? 'Enabled' : 'Disabled'], ['Status', $('lightStatus').textContent]);
    note = mode === 'demo' ? 'Demo preview only. No hardware commands are sent.' : 'Changes reach the Pi only after Apply to Pi.';
    target = 'settings-light'; label = 'Adjust warning light';
  } else {
    eyebrow = 'DRIVER BUZZ'; heading = 'Driver buzz';
    rows.push(['Link', buzzConnected() ? 'This browser' : 'Not connected'],
      ['Follows', 'Most urgent sensor'],
      ['Buzz setting', $('buzzEnabled').checked ? 'Enabled' : 'Disabled'], ['Status', $('buzzStatus').textContent]);
    note = 'This browser writes a pulse only while an obstacle is inside max range.';
    target = 'settings-buzz'; label = 'Adjust driver buzz';
  }
  const signature = JSON.stringify([eyebrow, heading, note, label, rows]);
  if ($('quick').dataset.signature === signature) return;
  $('quick').dataset.signature = signature;
  $('quickEyebrow').textContent = eyebrow; $('quickTitle').textContent = heading; $('quickNote').textContent = note;
  $('quickDetails').replaceChildren(...rows.map(([name, value]) => {
    const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = name; dd.textContent = value; row.append(dt, dd); return row;
  }));
  $('quickGo').textContent = label;
  $('quickGo').onclick = () => { $('quick').close(); openSettings(target); };
  $('quickExtra').hidden = !extra;
  if (extra) { $('quickExtra').textContent = extra.label; $('quickExtra').onclick = extra.run; }
}
$('quick').addEventListener('click', event => {
  // Close when the backdrop (outside the dialog box) is clicked.
  const box = $('quick').getBoundingClientRect();
  if (event.target === $('quick') && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) $('quick').close();
});
$('mapAdjust').onclick = () => openQuick('map');
$('mapPanel').addEventListener('click', event => { if (!event.target.closest('button')) openQuick('map'); });
$('lightAdjust').onclick = () => openQuick('light');
$('lightCard').addEventListener('click', event => { if (!event.target.closest('button')) openQuick('light'); });
$('buzzAdjust').onclick = () => openQuick('buzz');
$('buzzCard').addEventListener('click', event => { if (!event.target.closest('button')) openQuick('buzz'); });
function invalidateReadings() { ids.forEach(id => Object.assign(sensors[id], { updated: 0, distance: NaN, points: null, pose: null })); renderSensors(); }
$('connectSensors').onclick = () => {
  let url;
  try {
    url = new URL($('sensorUrl').value);
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Use ws:// or wss://.');
    if (location.protocol === 'https:' && url.protocol !== 'wss:') throw new Error('HTTPS requires wss://, or use this app on localhost.');
  } catch (error) { $('connectionStatus').textContent = 'Invalid sensor URL: ' + error.message; return; }
  closePiSources();
  if (socket) { socket.onclose = null; socket.close(); }
  setMode('live'); invalidateReadings(); $('connectionStatus').textContent = 'Connecting…';
  let current;
  try { current = socket = new WebSocket(url.href); }
  catch (error) { $('connectionStatus').textContent = error.message; return; }
  current.onopen = () => { if (socket !== current) return; $('connectionStatus').textContent = 'Connected. Waiting for valid sensor messages.'; log('Sensor bridge connected.'); };
  current.onmessage = event => {
    if (socket !== current) return;
    const readings = L.parseFrame(event.data);
    if (!readings) { $('connectionStatus').textContent = 'Ignored invalid sensor message. Check the sensor protocol guide.'; return; }
    const now = Date.now();
    readings.forEach(r => Object.assign(sensors[r.sensor], { distance: r.distance_m, updated: now, points: r.points, pose: r.pose }));
    $('connectionStatus').textContent = 'Receiving live sensor readings.'; renderSensors();
  };
  current.onerror = () => { if (socket === current) $('connectionStatus').textContent = 'Connection failed. Check the bridge address and network.'; };
  current.onclose = () => {
    if (socket !== current) return;
    $('connectionStatus').textContent = 'Sensor connection closed. Readings unavailable. Reconnect or select Use demo.';
    invalidateReadings(); log('Sensor bridge disconnected.', 'approaching');
  };
};
$('disconnectSensors').onclick = () => {
  closePiSources();
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  setMode('demo'); resetDemo(); $('connectionStatus').textContent = 'Using simulated distance readings.';
};
window.addEventListener('beforeunload', () => { ids.forEach(id => cameras[id].stream?.getTracks().forEach(t => t.stop())); socket?.close(); closePiSources(); audio.close(); });
window.addEventListener('resize', drawDemos);
buildSensors(); buildSetup(); addMapPreview('settingsMap'); addMapPreview('demoMap');
['mapAdjust', 'lightAdjust', 'buzzAdjust'].forEach(id => $(id).innerHTML = GEAR_ICON);
renderCameras(); setMode(mode); showView(location.hash.slice(1)); syncDemoControl(); renderSensors();
log('Telehandler demo ready. Use the Demo tab to move obstacles.'); setInterval(renderSensors, 100);

