'use strict';
// Hardware settings apply explicitly to one selected Pi; demo never sends commands.
let lightBusy = false, lightPollBusy = false, lightRevision = 0, demoLightTestUntil = 0;
let lightReported = null, lightReportedAt = 0, lightReportedBase = null;
try {
  const pref = JSON.parse(localStorage.getItem('surround-driver-light') || '{}');
  $('lightManual').checked = pref.manual === true;
  if (ids.includes(pref.sensor)) $('lightSensor').value = pref.sensor;
  if (Number.isFinite(pref.feet) && pref.feet >= 0.1 && pref.feet <= 15) $('lightDistance').value = pref.feet;
} catch {}
function selectedLightBridge() {
  if (mode === 'demo') return null;
  return [...piSources.values()].find(b => !b.stopped && b.sensor === $('lightSensor').value);
}
function lightThresholdMeters() {
  return $('lightManual').checked ? L.feetToMeters(Number($('lightDistance').value)) : sensors[$('lightSensor').value].fullTone;
}
function lightPrefsChanged() {
  lightRevision++;
  demoLightTestUntil = 0;
  try { localStorage.setItem('surround-driver-light', JSON.stringify({ sensor: $('lightSensor').value, feet: Number($('lightDistance').value), manual: $('lightManual').checked })); } catch {}
  $('lightMessage').textContent = mode === 'demo' ? 'Demo preview only. No hardware commands are sent.' : 'Changes are not applied. Choose Apply to Pi.';
  renderDriverLight();
}
async function lightRequest(bridge, path, value) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(new URL(path, bridge.base), { method: value === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + bridge.key, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: controller.signal, cache: 'no-store', referrerPolicy: 'no-referrer' });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'Light request failed (' + response.status + ').');
    if (typeof data.available !== 'boolean' || (data.available && (typeof data.enabled !== 'boolean' || !Number.isFinite(data.threshold_m)))) throw new Error('Pi light response is invalid.');
    return data;
  } finally { clearTimeout(timeout); }
}
function rememberLight(bridge, data) { lightReported = data; lightReportedAt = Date.now(); lightReportedBase = bridge.base; }
async function changeDriverLight(test) {
  if (mode === 'demo') {
    if (test) demoLightTestUntil = Date.now() + 2000;
    renderDriverLight(); return;
  }
  const bridge = selectedLightBridge();
  if (!bridge || lightBusy) return;
  lightBusy = true;
  const revision = ++lightRevision;
  renderDriverLight();
  try {
    const data = await lightRequest(bridge, test ? '/api/light/test' : '/api/light', test ? {} : { enabled: $('lightEnabled').checked, threshold_m: lightThresholdMeters() });
    if (selectedLightBridge() !== bridge || revision !== lightRevision) return;
    rememberLight(bridge, data);
    $('lightMessage').textContent = test ? 'Two-second physical light test requested. Check the LED.' : 'Applied to ' + title(bridge.sensor) + ' Pi. Its local controller now handles the light.';
  } catch (error) {
    if (selectedLightBridge() === bridge && revision === lightRevision) {
      lightReportedAt = 0;
      $('lightMessage').textContent = (error.name === 'AbortError' ? 'Pi did not respond.' : error.message) + ' State is unconfirmed; reconnect and check the light.';
    }
  } finally { lightBusy = false; renderDriverLight(); }
}
function renderDriverLight() {
  const demo = mode === 'demo', bridge = selectedLightBridge(), feet = L.metersToFeet(lightThresholdMeters());
  $('lightManualControls').hidden = !$('lightManual').checked;
  $('lightLinkedSummary').hidden = $('lightManual').checked;
  $('lightLinkedSummary').textContent = 'Synced to ' + title($('lightSensor').value) + ' Full tone at · ' + feet.toFixed(1) + ' ft. Apply to Pi to update the physical light.';
  $('lightDistanceValue').textContent = feet.toFixed(1) + ' ft';
  $('lightMode').textContent = demo ? 'DEMO' : 'PHYSICAL LED';
  $('applyLight').disabled = demo || !bridge || lightBusy;
  $('testLight').disabled = !demo && (!bridge || lightBusy);
  let active = false, lit = false, status;
  if (demo) {
    const sensor = sensors[$('lightSensor').value];
    active = Date.now() < demoLightTestUntil || ($('lightEnabled').checked && Number.isFinite(sensor.distance) && sensor.distance <= L.feetToMeters(feet));
    lit = active && Date.now() % 500 < 250;
    status = active ? 'DEMO · Flashing warning' : $('lightEnabled').checked ? 'DEMO · Outside selected distance' : 'DEMO · Light disabled';
  } else if (!bridge) status = 'No Pi connected for this sensor.';
  else if (lightReportedBase !== bridge.base || Date.now() - lightReportedAt >= 3000) status = 'Physical light status unavailable.';
  else if (!lightReported.available) status = 'No LED configured on this Pi. Start with --light-pin 23.';
  else {
    active = lightReported.active; lit = lightReported.lit;
    status = ({ warning: 'Flashing warning', testing: 'Testing light', disabled: 'Light disabled', sensor_unavailable: 'No fresh sensor reading · light off', outside_range: 'Outside warning distance', output_error: 'LED output error' })[lightReported.reason] || 'Light status unknown';
    status += ' · Pi threshold ' + formatDistance(lightReported.threshold_m, 1);
  }
  $('driverLight').classList.toggle('lit', !!lit);
  $('driverLight').setAttribute('aria-label', demo ? 'Simulated warning light ' + (active ? 'flashing' : 'off') : 'Pi reports warning light ' + (active ? 'flashing' : 'off or unavailable'));
  if ($('lightStatus').textContent !== status) $('lightStatus').textContent = status;
}
async function pollDriverLight() {
  const bridge = selectedLightBridge();
  if (!bridge || lightBusy || lightPollBusy) return;
  lightPollBusy = true;
  const revision = lightRevision;
  try {
    const data = await lightRequest(bridge, '/api/light');
    if (selectedLightBridge() === bridge && revision === lightRevision && !lightBusy) rememberLight(bridge, data);
  } catch { if (selectedLightBridge() === bridge && revision === lightRevision) lightReportedAt = 0; }
  finally { lightPollBusy = false; renderDriverLight(); }
}
$('lightDistance').oninput = lightPrefsChanged;
$('lightManual').onchange = lightPrefsChanged;
window.addEventListener('surround-distance-settings', () => { if (!$('lightManual').checked) lightPrefsChanged(); });
$('lightSensor').onchange = () => { lightReportedAt = 0; lightPrefsChanged(); pollDriverLight(); };
$('lightEnabled').onchange = lightPrefsChanged;
$('applyLight').onclick = () => changeDriverLight(false);
$('testLight').onclick = () => changeDriverLight(true);
renderDriverLight();
setInterval(renderDriverLight, 100);
setInterval(pollDriverLight, 1000);
