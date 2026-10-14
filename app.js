'use strict';
const $ = id => document.getElementById(id);
const L = SurroundLogic, ids = L.IDS;
const title = id => id === 'boom' ? 'Boom arm' : id.charAt(0).toUpperCase() + id.slice(1);
const demoDistances = [3.2, 1.4, 2.8, 4.1];
let stored = {};
try { stored = JSON.parse(localStorage.getItem('surround-settings-v2') || localStorage.getItem('surround-settings') || '{}') || {}; } catch {}
const sensors = Object.fromEntries(ids.map((id, i) => {
  const pref = stored[id] || (id === 'boom' ? stored.front : null) || {};
  return [id, { ...L.normalizeSettings({ maxRange: pref.maxRange ?? pref.warning, fullTone: pref.fullTone ?? pref.critical }), distance: demoDistances[i], updated: Date.now(), pose: L.DEMO_POSES[id], points: null, status: 'clear' }];
}));
const cameras = Object.fromEntries(ids.map(id => [id, { kind: 'demo', stream: null, token: 0 }]));
const audio = new ProximityAudio();
let mode = 'demo', socket = null, soundOn = false, layout = stored.layout === 1 ? 1 : 4, userCameras = [];
function save() {
  try { localStorage.setItem('surround-settings-v2', JSON.stringify({ ...Object.fromEntries(ids.map(id => [id, { maxRange: sensors[id].maxRange, fullTone: sensors[id].fullTone }])), layout })); }
  catch { $('footerStatus').textContent = 'Settings cannot be saved in this browser.'; }
}
function log(message, level = 'clear') {
  const row = document.createElement('div'); row.className = 'event ' + level;
  const time = document.createElement('time'); time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  row.append(time, document.createTextNode(message)); $('log').prepend(row);
  while ($('log').children.length > 35) $('log').lastChild.remove();
}
function buildSensors() {
  $('sensorList').innerHTML = ids.map(id => `<div class="sensor" id="sensor-${id}"><div class="sensor-head"><span class="sensor-name">${title(id)} sensor</span><span class="reading" id="reading-${id}">—</span></div><div class="sensor-status" id="status-${id}"></div><label class="range-label" for="maxRange-${id}">Max range <output id="maxRangeValue-${id}"></output></label><input type="range" id="maxRange-${id}" min="0.3" max="10" step="0.1" value="${sensors[id].maxRange}"><label class="range-label" for="fullTone-${id}">Full tone at <output id="fullToneValue-${id}"></output></label><input class="critical-range" type="range" id="fullTone-${id}" min="0.1" max="9.9" step="0.1" value="${sensors[id].fullTone}"><div class="urgency-track"><span id="urgency-${id}"></span></div></div>`).join('');
  ids.forEach(id => ['maxRange', 'fullTone'].forEach(key => $(`${key}-${id}`).addEventListener('input', e => {
    const s = sensors[id]; s[key] = Number(e.target.value);
    if (key === 'maxRange') s.fullTone = Math.min(s.fullTone, Math.round((s.maxRange - 0.1) * 10) / 10);
    else s.maxRange = Math.max(s.maxRange, Math.round((s.fullTone + 0.1) * 10) / 10);
    ['maxRange', 'fullTone'].forEach(k => $(`${k}-${id}`).value = s[k]);
    save(); renderSensors();
  })));
  $('mapReadouts').innerHTML = ids.map(id => `<div id="map-${id}" class="map-readout"><span>${title(id)}</span><strong>—</strong></div>`).join('');
}
function demoPoints(distance) { return [-12, 0, 12].map((bearing, i) => ({ bearing_deg: bearing, distance_m: distance + (i === 1 ? 0 : 0.16) })); }
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
    $(`sensor-${id}`).className = 'sensor ' + next;
    $(`reading-${id}`).innerHTML = next === 'stale' ? '— <small>m</small>' : `${s.distance.toFixed(2)} <small>m</small>`;
    $(`status-${id}`).textContent = (mode === 'demo' ? 'SIMULATED · ' : 'LIVE · ') + ({ clear: 'OUTSIDE ALERT RANGE', approaching: 'INTENSITY ' + Math.round(profile.progress * 100) + '%', close: 'FULL TONE', stale: 'NO FRESH DATA' }[next]);
    ['maxRange', 'fullTone'].forEach(key => $(`${key}Value-${id}`).textContent = s[key].toFixed(1) + ' m');
    $(`urgency-${id}`).style.width = (profile.progress * 100) + '%';
    $(`map-${id}`).className = 'map-readout ' + next;
    $(`map-${id}`).querySelector('strong').textContent = next === 'stale' ? 'No data' : s.distance.toFixed(2) + ' m';
    if (profile.active && (!winner || profile.progress > winner.progress)) winner = { ...profile, sensor: id };
  });
  audio.setProfile(soundOn ? winner : null);
  $('audioSummary').textContent = winner ? `${title(winner.sensor)} · ${Math.round(winner.frequencyHz)} Hz · ${winner.continuous ? 'sustained tone' : (1 / winner.periodSeconds).toFixed(1) + ' beeps / sec'}${soundOn ? '' : ' · muted'}` : 'No fresh readings inside an alert range.';
  renderMap(now);
}
function renderMap(now) {
  const fused = L.fuseReadings(sensors, now);
  const extent = Math.max(8, ...fused.points.flatMap(p => [Math.abs(p.x_m) + 1, Math.abs(p.y_m) + 1]));
  const bounds = [-extent, -extent, extent * 2, extent * 2];
  $('proximityMap').setAttribute('viewBox', bounds.join(' '));
  ['x', 'y', 'width', 'height'].forEach((key, i) => $('gridBackground').setAttribute(key, bounds[i]));
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
  $('mapRays').innerHTML = rays.join(''); $('mapSensors').innerHTML = mounts.join('');
  $('mapPoints').innerHTML = fused.points.map(p => `<circle data-sources="${p.sources.join(',')}" cx="${p.x_m}" cy="${-p.y_m}" r="${p.sources.length > 1 ? '.15' : '.11'}" fill="hsl(${95 - p.urgency * 85} 70% 68%)" stroke="#17221a" stroke-width=".035"><title>${p.sources.map(title).join(' + ')} · ${p.x_m.toFixed(2)}, ${p.y_m.toFixed(2)} m · ${p.count} returns</title></circle>`).join('');
  $('mapBadge').textContent = mode === 'demo' ? 'DEMO GEOMETRY' : fused.unplaced.length ? 'NEEDS SENSOR POSES' : 'LIVE COORDINATES';
  $('mapSummary').textContent = `${fused.freshSensors}/4 fresh sensors · ${fused.points.length} combined points${fused.unplaced.length ? ' · Unplaced: ' + fused.unplaced.map(title).join(', ') : ''}${mode === 'demo' ? ' · demo mounts and distances' : ''}`;
}
function cameraElement(id){
 const card=document.createElement('article');card.className='camera';card.id='camera-'+id;
 card.innerHTML=`<canvas aria-label="Illustrated demo view, not a live camera feed"></canvas><div class="cam-top"><span class="cam-label">${title(id).toUpperCase()} <span style="opacity:.5">/ 0${ids.indexOf(id)+1}</span></span><span class="cam-status">ILLUSTRATED DEMO</span></div><div class="cam-bottom"><span class="cam-note">No camera connected</span><button type="button">Connect camera ↗</button></div>`;
 card.querySelector('button').onclick=()=>{$('devices').showModal();$(`source-${id}`).focus();};return card;
}
function renderCameras(){
 const grid=$('cameraGrid');
 // Keep live video elements and MediaStreams mounted when changing layouts.
 if(!grid.children.length)ids.forEach(id=>grid.append(cameraElement(id)));
 ids.forEach((id,i)=>$('camera-'+id).hidden=layout===1&&i>0);
 grid.classList.toggle('single',layout===1);$('single').classList.toggle('selected',layout===1);$('multi').classList.toggle('selected',layout===4);
 requestAnimationFrame(drawDemos);
}
function drawDemos(){
 ids.forEach((id,index)=>{
 const card=$('camera-'+id),canvas=card.querySelector('canvas');if(!canvas||card.hidden)return;
 const w=canvas.width=800,h=canvas.height=470,c=canvas.getContext('2d');
 c.fillStyle='#202c2b';c.fillRect(0,0,w,h);const grad=c.createLinearGradient(0,0,0,h);grad.addColorStop(0,'#344641');grad.addColorStop(1,'#152522');c.fillStyle=grad;c.fillRect(0,0,w,h);
 const van={x:400+index*10,y:185};
 c.strokeStyle='#7b928528';c.lineWidth=1;
 for(let x=-900;x<1800;x+=100){c.beginPath();c.moveTo(van.x,van.y);c.lineTo(x,h);c.stroke();}
 for(let y=195;y<h;y+=Math.max(14,(y-150)*.22)){c.beginPath();c.moveTo(0,y);c.lineTo(w,y);c.stroke();}
 // Stylized warehouse shelving, intentionally distinct from camera footage.
 for(const side of [0,1]){c.fillStyle=side?'#293c36':'#304038';c.beginPath();c.moveTo(side?800:0,0);c.lineTo(side?530:270,130);c.lineTo(side?530:270,280);c.lineTo(side?800:0,470);c.fill();
  c.strokeStyle='#6f8d713b';c.lineWidth=4;for(let i=0;i<4;i++){let x=side?800-i*85:i*85;c.beginPath();c.moveTo(x,0);c.lineTo(x,h-i*52);c.stroke();}
  for(let j=0;j<3;j++){c.beginPath();c.moveTo(side?800:0,85+j*105);c.lineTo(side?530:270,145+j*49);c.stroke();}
 }
 c.strokeStyle='#d3df9d66';c.lineWidth=3;c.beginPath();c.moveTo(195,h);c.lineTo(350,225);c.moveTo(605,h);c.lineTo(450,225);c.stroke();
 if(index===1){c.fillStyle='#7f8c6d';c.fillRect(363,250,76,93);c.strokeStyle='#c3d0a1';c.lineWidth=2;c.strokeRect(355,241,92,110);c.fillStyle='#d3dfb9';c.font='12px Segoe UI';c.fillText('SIMULATED OBSTACLE',338,231);}
 c.fillStyle='#d4e2d166';c.font='12px Segoe UI';c.textAlign='center';c.fillText('ILLUSTRATED CAMERA PLACEHOLDER',400,402);c.textAlign='left';
 });
}

function updateCameraCount(){$('cameraCount').textContent=ids.filter(id=>cameras[id].kind==='live').length+' connected';}
function stopCamera(id){
 const cam=cameras[id];cam.token++;if(cam.stream)cam.stream.getTracks().forEach(t=>t.stop());cam.stream=null;cam.kind='demo';
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
$('settingsButton').onclick = () => $('devices').showModal(); $('clearLog').onclick = () => $('log').replaceChildren();
function syncDemoControl() { const value = sensors[$('demoSensor').value].distance; $('obstacle').value = value; $('obstacleValue').textContent = value.toFixed(2) + ' m'; }
$('demoSensor').onchange = syncDemoControl;
$('obstacle').oninput = e => { if (mode !== 'demo') return; sensors[$('demoSensor').value].distance = Number(e.target.value); syncDemoControl(); renderSensors(); };
function resetDemo() {
  ids.forEach((id, i) => Object.assign(sensors[id], { distance: demoDistances[i], updated: Date.now(), pose: L.DEMO_POSES[id], points: demoPoints(demoDistances[i]) })); syncDemoControl(); renderSensors();
}
$('resetDemo').onclick = () => { if (mode === 'demo') resetDemo(); };
function setMode(next) {
  mode = next; $('modeBadge').textContent = next === 'demo' ? '● DEMO MODE' : '● LIVE SENSOR MODE';
  ['obstacle', 'demoSensor', 'resetDemo'].forEach(id => $(id).disabled = next !== 'demo');
  $('footerStatus').textContent = (next === 'demo' ? '4 simulated sensors' : 'Live sensor input · stale after 3 seconds') + ' · settings saved on this browser';
}
function invalidateReadings() { ids.forEach(id => Object.assign(sensors[id], { updated: 0, distance: NaN, points: null, pose: null })); renderSensors(); }
$('connectSensors').onclick = () => {
  let url;
  try {
    url = new URL($('sensorUrl').value);
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Use ws:// or wss://.');
    if (location.protocol === 'https:' && url.protocol !== 'wss:') throw new Error('HTTPS requires wss://, or use this app on localhost.');
  } catch (error) { $('connectionStatus').textContent = 'Invalid sensor URL: ' + error.message; return; }
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
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  setMode('demo'); resetDemo(); $('connectionStatus').textContent = 'Using simulated distance readings.';
};
window.addEventListener('beforeunload', () => { ids.forEach(id => cameras[id].stream?.getTracks().forEach(t => t.stop())); socket?.close(); audio.close(); });
window.addEventListener('resize', drawDemos);
buildSensors(); buildSetup(); renderCameras(); renderSensors(); log('Telehandler demo ready. Try each side and adjust the sound curve.'); setInterval(renderSensors, 100);
