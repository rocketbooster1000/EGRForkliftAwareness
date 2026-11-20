'use strict';
// XIAO-BUZZ follows the alert curve. This computer sends the winning distance to a
// local bridge; a Pi uses its own ultrasonic reading after Apply.
const BUZZ_BRIDGE = 'http://127.0.0.1:8091';
let buzzBusy = false, buzzPollBusy = false, buzzPushBusy = false, buzzRevision = 0, buzzStopPending = false, demoBuzzTestUntil = 0;
let buzzReported = null, buzzReportedAt = 0, buzzReportedBase = null;
try {
  const pref = JSON.parse(localStorage.getItem('surround-driver-buzz') || '{}');
  if (pref.host === 'pi' || pref.host === 'computer') $('buzzHost').value = pref.host;
  if (ids.includes(pref.sensor)) $('buzzSensor').value = pref.sensor;
} catch {}
function buzzComputer() { return $('buzzHost').value !== 'pi'; }
function selectedBuzzBridge() {
  if (mode === 'demo') return null;
  return [...piSources.values()].find(bridge => !bridge.stopped && bridge.sensor === $('buzzSensor').value) || null;
}
function buzzTarget() {
  if (buzzComputer()) return { base: BUZZ_BRIDGE, key: '', local: true };
  const bridge = selectedBuzzBridge();
  return bridge ? { base: bridge.base, key: bridge.key, local: false, sensor: bridge.sensor } : null;
}
function saveBuzzPrefs() {
  try { localStorage.setItem('surround-driver-buzz', JSON.stringify({ host: $('buzzHost').value, sensor: $('buzzSensor').value })); } catch {}
}
function freshSensor(id) {
  const sensor = sensors[id];
  if (!sensor || Date.now() - sensor.updated >= L.STALE_MS || !Number.isFinite(sensor.distance)) return null;
  return { id, distance: sensor.distance, maxRange: sensor.maxRange, fullTone: sensor.fullTone };
}
function urgentSensor() {
  let active = null, nearest = null;
  for (const id of ids) {
    const row = freshSensor(id);
    if (!row) continue;
    const profile = L.alertProfile(row.distance, row);
    row.progress = profile.progress;
    row.active = profile.active;
    if (profile.active && (!active || profile.progress > active.progress)) active = row;
    if (!nearest || row.distance < nearest.distance) nearest = row;
  }
  return active || nearest;
}
function buzzReadingBody(enabled) {
  const row = urgentSensor() || freshSensor('boom') || { distance: null, maxRange: sensors.boom.maxRange, fullTone: sensors.boom.fullTone };
  return { enabled, distance_m: enabled ? (urgentSensor() ? urgentSensor().distance : null) : null, max_range_m: row.maxRange, full_tone_m: row.fullTone };
}
function localBuzz() {
  if (Date.now() < demoBuzzTestUntil) return { active: true, label: 'Testing buzz', strength: 0.85, durationMs: 400, periodSeconds: 0.9 };
  if (!$('buzzEnabled').checked) return { active: false, label: 'Buzz disabled' };
  const row = buzzComputer() ? urgentSensor() : freshSensor($('buzzSensor').value);
  if (!row) return { active: false, label: 'No fresh sensor reading · buzz off' };
  const profile = L.alertProfile(row.distance, row);
  if (!profile.active) return { active: false, label: 'Outside alert range' };
  const pulse = L.hapticPulse(profile.progress);
  return { active: true, label: profile.continuous ? 'Strong buzz' : 'Pulsing · strength ' + pulse.strength.toFixed(2), ...pulse };
}
function deviceBuzzText(data) {
  if (!data.available) return 'No buzz configured on this Pi. Start with --buzz.';
  if (!data.connected && data.reason !== 'disabled' && data.reason !== 'output_error') return 'XIAO-BUZZ not connected';
  if (data.reason === 'disabled') return data.connected ? 'Buzz disabled · XIAO-BUZZ connected' : 'Buzz disabled' + (data.error ? ' · ' + data.error : ' · looking for XIAO-BUZZ');
  const text = ({ approaching: 'Pulsing' + (Number.isFinite(data.strength) ? ' · strength ' + Number(data.strength).toFixed(2) : ''), close: 'Strong buzz', testing: 'Testing buzz', sensor_unavailable: 'No fresh sensor reading · buzz off', outside_range: 'Outside alert range', output_error: data.error || 'Buzz output error' })[data.reason] || 'Buzz status unknown';
  return text + (data.reason === 'output_error' ? '' : ' · full at ' + formatDistance(data.full_tone_m, 1));
}
async function buzzRequest(target, path, value) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const headers = {};
    if (target.key) headers.Authorization = 'Bearer ' + target.key;
    if (value !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(new URL(path, target.base), { method: value === undefined ? 'GET' : 'POST', headers, ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: controller.signal, cache: 'no-store', referrerPolicy: 'no-referrer' });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'Buzz request failed (' + response.status + ').');
    if (typeof data.available !== 'boolean' || (data.available && (typeof data.enabled !== 'boolean' || typeof data.connected !== 'boolean' || typeof data.active !== 'boolean' || typeof data.reason !== 'string' || !Number.isFinite(data.max_range_m) || !Number.isFinite(data.full_tone_m)))) throw new Error('Buzz response is invalid.');
    return data;
  } finally { clearTimeout(timeout); }
}
function rememberBuzz(target, data) { buzzReported = data; buzzReportedAt = Date.now(); buzzReportedBase = target.base; }
function buzzPrefsChanged() {
  buzzRevision++;
  demoBuzzTestUntil = 0;
  saveBuzzPrefs();
  if (buzzComputer()) {
    if (!$('buzzEnabled').checked) buzzStopPending = true;
    $('buzzMessage').textContent = $('buzzEnabled').checked ? 'Sending alerts to the buzz bridge on this computer.' : 'Driver buzz is off.';
  } else $('buzzMessage').textContent = mode === 'demo' ? 'Demo preview only. No Pi commands are sent.' : 'Stop the buzz bridge on this computer, then choose Apply to Pi.';
  renderBuzz();
}
async function pushBuzzReading() {
  if (buzzPushBusy) return;
  const enabled = buzzComputer() && $('buzzEnabled').checked;
  if (!enabled && !buzzStopPending) return;
  buzzPushBusy = true;
  const revision = buzzRevision;
  try {
    const data = await buzzRequest({ base: BUZZ_BRIDGE, key: '', local: true }, '/api/buzz/reading', buzzReadingBody(enabled));
    if (!enabled) buzzStopPending = false;
    if (buzzComputer() && revision === buzzRevision && !buzzBusy) rememberBuzz({ base: BUZZ_BRIDGE }, data);
  } catch { if (buzzComputer() && revision === buzzRevision) buzzReportedAt = 0; }
  finally { buzzPushBusy = false; renderBuzz(); }
}
async function changeBuzz(test) {
  const computer = buzzComputer();
  if (!computer && mode === 'demo') {
    if (test) demoBuzzTestUntil = Date.now() + 2000;
    renderBuzz(); return;
  }
  const target = computer ? { base: BUZZ_BRIDGE, key: '', local: true } : selectedBuzzBridge();
  if (!target || buzzBusy) return;
  buzzBusy = true;
  const revision = ++buzzRevision;
  renderBuzz();
  try {
    const sensor = $('buzzSensor').value;
    const body = test ? {} : { enabled: $('buzzEnabled').checked, max_range_m: sensors[sensor].maxRange, full_tone_m: sensors[sensor].fullTone };
    const data = await buzzRequest(target, test ? '/api/buzz/test' : (computer ? '/api/buzz/reading' : '/api/buzz'), test ? {} : body);
    if ((computer ? !buzzComputer() : selectedBuzzBridge() !== target) || revision !== buzzRevision) return;
    rememberBuzz(target, data);
    $('buzzMessage').textContent = test ? 'Test sent to XIAO-BUZZ.' : 'Applied to ' + title(target.sensor) + ' Pi. Its local controller now handles the buzz.';
  } catch (error) {
    if (revision === buzzRevision) {
      buzzReportedAt = 0;
      const down = computer && (error.name === 'TypeError' || error.name === 'AbortError');
      $('buzzMessage').textContent = (down ? 'Buzz bridge is not running. Start python hardware/buzz_bridge.py.' : (error.name === 'AbortError' ? 'Buzz host did not respond.' : error.message)) + (computer ? '' : ' State is unconfirmed; reconnect and check the motor.');
    }
  } finally { buzzBusy = false; renderBuzz(); }
}
function renderBuzz() {
  const computer = buzzComputer(), bridge = selectedBuzzBridge(), local = localBuzz();
  $('buzzPiControls').hidden = computer;
  $('buzzMode').textContent = computer ? 'THIS COMPUTER' : (mode === 'demo' ? 'DEMO' : 'PI BLUETOOTH');
  if ($('applyBuzz')) $('applyBuzz').disabled = computer || mode === 'demo' || !bridge || buzzBusy;
  $('testBuzz').disabled = buzzBusy || (!computer && mode !== 'demo' && !bridge);
  const target = buzzTarget();
  const fresh = buzzReported && target && buzzReportedBase === target.base && Date.now() - buzzReportedAt < 3000;
  let status, pulsing = false;
  if (computer && !fresh) {
    status = $('buzzEnabled').checked || Date.now() < demoBuzzTestUntil ? local.label + ' · buzz bridge is not running' : 'Buzz disabled.';
    pulsing = ($('buzzEnabled').checked || Date.now() < demoBuzzTestUntil) && local.active && Date.now() % (local.periodSeconds * 1000) < local.durationMs;
  } else if (!computer && mode === 'demo') {
    status = 'DEMO · ' + local.label;
    pulsing = local.active && Date.now() % (local.periodSeconds * 1000) < local.durationMs;
  } else if (!target) status = 'No Pi connected for this sensor.';
  else if (!fresh) status = 'Buzz status unavailable.';
  else {
    status = deviceBuzzText(buzzReported);
    pulsing = buzzReported.active && buzzReported.connected && Number.isFinite(buzzReported.period_s) && Number.isFinite(buzzReported.duration_ms) && Date.now() % (buzzReported.period_s * 1000) < buzzReported.duration_ms;
  }
  const label = pulsing ? 'Driver buzz pulsing' : 'Driver buzz off';
  ['buzzMark', 'buzzMarkPreview', 'buzzMarkDemo'].forEach(id => { $(id).classList.toggle('on', !!pulsing); $(id).setAttribute('aria-label', label); });
  ['buzzStatus', 'buzzStatusPreview', 'buzzStatusDemo'].forEach(id => { if ($(id).textContent !== status) $(id).textContent = status; });
  const summary = computer ? 'Most urgent sensor · same curve as the alert sound' : title($('buzzSensor').value) + ' Pi · full buzz at ' + formatDistance(sensors[$('buzzSensor').value].fullTone, 1);
  if ($('buzzSummary').textContent !== summary) $('buzzSummary').textContent = summary;
}
async function pollBuzz() {
  const target = buzzTarget();
  if (!target || buzzBusy || buzzPollBusy || buzzPushBusy) return;
  buzzPollBusy = true;
  const revision = buzzRevision;
  try {
    const data = await buzzRequest(target, '/api/buzz');
    if (buzzTarget()?.base === target.base && revision === buzzRevision && !buzzBusy) rememberBuzz(target, data);
  } catch { if (buzzTarget()?.base === target.base && revision === buzzRevision) buzzReportedAt = 0; }
  finally { buzzPollBusy = false; renderBuzz(); }
}
$('buzzHost').onchange = () => { if (!buzzComputer()) buzzStopPending = true; buzzPrefsChanged(); };
$('buzzSensor').onchange = () => { buzzReportedAt = 0; buzzPrefsChanged(); pollBuzz(); };
$('buzzEnabled').onchange = buzzPrefsChanged;
$('applyBuzz').onclick = () => changeBuzz(false);
$('testBuzz').onclick = () => changeBuzz(true);
window.addEventListener('surround-distance-settings', () => {
  if (!buzzComputer()) {
    buzzRevision++;
    $('buzzMessage').textContent = mode === 'demo' ? 'Demo preview only. No Pi commands are sent.' : 'Changes are not applied. Choose Apply to Pi.';
  }
  renderBuzz();
});
renderBuzz();
setInterval(renderBuzz, 100);
setInterval(pollBuzz, 1000);
setInterval(pushBuzzReading, 250);
