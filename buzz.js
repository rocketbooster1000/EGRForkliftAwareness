'use strict';
// The wristband connects to this browser. One BLE write is one pulse, so the page
// writes again only when the next pulse is due. Outside max range it writes nothing.
const BUZZ_NAME = 'XIAO-BUZZ';
const BUZZ_SERVICE = '7a3e0001-6c4b-4d2f-8e19-1f2a3b4c5d01';
const BUZZ_CHAR = '7a3e0002-6c4b-4d2f-8e19-1f2a3b4c5d01';
let buzzDevice = null, buzzChar = null, buzzWriting = false, buzzNextAt = 0, buzzTestUntil = 0, buzzLinkError = '';
function freshSensor(id) {
  const sensor = sensors[id];
  if (!sensor || Date.now() - sensor.updated >= L.STALE_MS || !Number.isFinite(sensor.distance)) return null;
  return { id, distance: sensor.distance, maxRange: sensor.maxRange, fullTone: sensor.fullTone };
}
function localBuzz() {
  if (!$('buzzEnabled').checked) return { active: false, label: 'Buzz disabled' };
  let winner = null, fresh = false;
  for (const id of ids) {
    const row = freshSensor(id);
    if (!row) continue;
    fresh = true;
    const profile = L.alertProfile(row.distance, row);
    if (profile.active && (!winner || profile.progress > winner.progress)) winner = { id, profile };
  }
  if (!fresh) return { active: false, label: 'No fresh sensor reading · buzz off' };
  if (!winner) return { active: false, label: 'Outside alert range' };
  const pulse = L.hapticPulse(winner.profile.progress);
  return { active: true, label: (winner.profile.continuous ? 'Strong buzz' : 'Pulsing · strength ' + pulse.strength.toFixed(2)) + ' · ' + title(winner.id), ...pulse };
}
function buzzPlan(now) {
  if (now < buzzTestUntil) return { active: true, label: 'Testing buzz', strength: 0.85, durationMs: 400, periodSeconds: 0.9 };
  return localBuzz();
}
function dueBuzzWrite(now) {
  const plan = buzzPlan(now);
  if (!buzzChar || buzzWriting || !plan.active || now < buzzNextAt) return null;
  return plan;
}
function encodeBuzzCommand(strength, durationMs) {
  return 'b,' + Number(strength).toFixed(2) + ',' + Math.round(durationMs);
}
function buzzBytes(command) {
  return typeof TextEncoder === 'undefined' ? command : new TextEncoder().encode(command);
}
function buzzConnected() { return !!(buzzDevice && buzzDevice.gatt && buzzDevice.gatt.connected && buzzChar); }
function useBuzzLink(characteristic) {
  buzzChar = characteristic;
  buzzDevice = characteristic ? { gatt: { connected: true, disconnect() {} } } : null;
}
function armBuzzWrite() { buzzNextAt = 0; }
function onBuzzDisconnect() {
  buzzChar = null;
  buzzWriting = false;
  buzzNextAt = 0;
  renderBuzz();
}
async function attachBuzz(device) {
  buzzDevice = device;
  device.addEventListener('gattserverdisconnected', onBuzzDisconnect);
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(BUZZ_SERVICE);
  const characteristic = await service.getCharacteristic(BUZZ_CHAR);
  try { await characteristic.startNotifications(); } catch {}
  buzzChar = characteristic;
  buzzLinkError = '';
  buzzNextAt = 0;
  $('buzzMessage').textContent = 'Wristband connected. Pulses are sent only while an obstacle is inside max range.';
  renderBuzz();
}
async function connectBuzz() {
  const bluetooth = navigator.bluetooth;
  if (!bluetooth) {
    $('buzzMessage').textContent = 'This browser cannot open Bluetooth. Use Chrome or Edge at http://localhost:4317.';
    return;
  }
  try {
    const device = await bluetooth.requestDevice({ filters: [{ name: BUZZ_NAME }], optionalServices: [BUZZ_SERVICE] });
    $('buzzMessage').textContent = 'Connecting to ' + BUZZ_NAME + '…';
    await attachBuzz(device);
  } catch (error) {
    buzzLinkError = error.name === 'NotFoundError' ? 'No wristband selected.' : error.message;
    $('buzzMessage').textContent = buzzLinkError;
    renderBuzz();
  }
}
async function sendBuzzPulse(plan) {
  const started = Date.now();
  buzzWriting = true;
  buzzNextAt = started + plan.periodSeconds * 1000;
  try {
    await buzzChar.writeValue(buzzBytes(encodeBuzzCommand(plan.strength, plan.durationMs)));
  } catch (error) {
    buzzNextAt = 0;
    buzzLinkError = error.message || 'Wristband write failed.';
    $('buzzMessage').textContent = buzzLinkError;
    if (!buzzConnected()) onBuzzDisconnect();
  } finally {
    buzzWriting = false;
  }
}
async function tickBuzz() {
  const plan = dueBuzzWrite(Date.now());
  if (plan) await sendBuzzPulse(plan);
}
function renderBuzz() {
  const now = Date.now(), plan = buzzPlan(now), connected = buzzConnected();
  $('buzzMode').textContent = connected ? 'WRISTBAND' : 'NOT CONNECTED';
  $('connectBuzz').disabled = false;
  $('testBuzz').disabled = !connected;
  let status = plan.label;
  if (!connected) status = $('buzzEnabled').checked || now < buzzTestUntil ? plan.label + ' · wristband not connected' : 'Buzz disabled.';
  const pulsing = connected && plan.active && now % (plan.periodSeconds * 1000) < plan.durationMs;
  const label = pulsing ? 'Driver buzz pulsing' : 'Driver buzz off';
  ['buzzMark', 'buzzMarkPreview', 'buzzMarkDemo'].forEach(id => { $(id).classList.toggle('on', !!pulsing); $(id).setAttribute('aria-label', label); });
  ['buzzStatus', 'buzzStatusPreview', 'buzzStatusDemo'].forEach(id => { if ($(id).textContent !== status) $(id).textContent = status; });
  const summary = 'Most urgent sensor · this browser writes one pulse when it is due';
  if ($('buzzSummary').textContent !== summary) $('buzzSummary').textContent = summary;
}
$('connectBuzz').onclick = () => connectBuzz();
$('buzzEnabled').onchange = () => { buzzTestUntil = 0; buzzNextAt = 0; $('buzzMessage').textContent = $('buzzEnabled').checked ? (buzzConnected() ? 'Wristband connected. Pulses are sent only while an obstacle is inside max range.' : 'Connect the wristband, then bring an obstacle inside max range.') : 'Driver buzz is off.'; renderBuzz(); };
$('testBuzz').onclick = () => { if (!buzzConnected()) { $('buzzMessage').textContent = 'Connect the wristband first.'; return; } buzzTestUntil = Date.now() + 900; buzzNextAt = 0; renderBuzz(); };
window.addEventListener('pagehide', () => { if (buzzDevice && buzzDevice.gatt && buzzDevice.gatt.connected) buzzDevice.gatt.disconnect(); });
renderBuzz();
setInterval(renderBuzz, 100);
setInterval(() => { tickBuzz(); }, 50);
