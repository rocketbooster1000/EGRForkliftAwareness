const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const L = require('./logic.js');
function fixture(fetcher) {
  const nodes = new Map(), calls = [];
  const now = Date.now();
  const sensor = (distance, updated = now) => ({ distance, maxRange: 3, fullTone: 0.5, updated });
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, hidden: false, textContent: '', classList: { toggle() {} }, setAttribute() {} });
    return nodes.get(id);
  };
  $('buzzHost').value = 'computer';
  $('buzzSensor').value = 'boom';
  const context = vm.createContext({ window: { addEventListener() {} }, $, L, ids: L.IDS, mode: 'demo', piSources: new Map(), sensors: { boom: sensor(0.4), rear: sensor(2), left: sensor(4, 0), right: sensor(4, 0) }, Date, Number, JSON, Map, URL, AbortController, setTimeout, clearTimeout, setInterval() {}, localStorage: { getItem() { return null; }, setItem() {} }, title: id => id, formatDistance: meters => (meters / 0.3048).toFixed(1) + ' ft', fetch: async (...args) => { calls.push(args); return fetcher(...args); } });
  vm.runInContext(fs.readFileSync('buzz.js', 'utf8'), context);
  return { context, $, calls, run: code => vm.runInContext(code, context) };
}
const good = { available: true, connected: true, enabled: true, max_range_m: 3, full_tone_m: 0.5, active: true, pulsing: true, strength: 0.85, duration_ms: 400, period_s: 0.48, reason: 'close', error: null };
test('pi demo previews the curve and never calls a host', async () => {
  const f = fixture(() => { throw new Error('Unexpected network'); });
  f.$('buzzHost').value = 'pi';
  f.$('buzzEnabled').checked = true;
  f.run('renderBuzz()');
  assert.match(f.$('buzzStatus').textContent, /DEMO · Strong buzz/);
  f.context.sensors.boom.distance = 4;
  f.run('renderBuzz()');
  assert.match(f.$('buzzStatus').textContent, /Outside/);
  await f.run('changeBuzz(true)');
  assert.equal(f.calls.length, 0);
  assert.equal(f.$('applyBuzz').disabled, true);
});
test('this computer posts the urgent distance and a test to the local bridge', async () => {
  const f = fixture(async () => ({ ok: true, json: async () => good }));
  f.$('buzzEnabled').checked = true;
  await f.run('pushBuzzReading()');
  assert.equal(f.calls[0][0].href, 'http://127.0.0.1:8091/api/buzz/reading');
  assert.equal(f.calls[0][1].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(f.calls[0][1].body), { enabled: true, distance_m: 0.4, max_range_m: 3, full_tone_m: 0.5 });
  assert.match(f.$('buzzStatus').textContent, /Strong buzz/);
  await f.run('changeBuzz(true)');
  assert.equal(f.calls[1][0].href, 'http://127.0.0.1:8091/api/buzz/test');
  assert.deepEqual(JSON.parse(f.calls[1][1].body), {});
});
test('live apply sends ranges only to the selected Pi', async () => {
  const f = fixture(async () => ({ ok: true, json: async () => good }));
  f.context.mode = 'live';
  f.$('buzzHost').value = 'pi';
  f.$('buzzEnabled').checked = true;
  f.context.piSources.set('pi', { base: 'http://pi:8080', key: 'fixture-key', sensor: 'boom' });
  await f.run('changeBuzz(false)');
  assert.equal(f.calls[0][0].href, 'http://pi:8080/api/buzz');
  assert.equal(f.calls[0][1].headers.Authorization, 'Bearer fixture-key');
  assert.deepEqual(JSON.parse(f.calls[0][1].body), { enabled: true, max_range_m: 3, full_tone_m: 0.5 });
  assert.match(f.$('buzzMessage').textContent, /Applied to/);
});
test('a dead bridge and a late response are not reported as success', async () => {
  const f = fixture(async () => { throw new TypeError('Failed to fetch'); });
  f.$('buzzEnabled').checked = true;
  await f.run('changeBuzz(true)');
  assert.match(f.$('buzzMessage').textContent, /buzz_bridge.py/);
  assert.match(f.$('buzzStatus').textContent, /not running/);
  let release;
  const late = fixture(() => new Promise(resolve => { release = () => resolve({ ok: true, json: async () => good }); }));
  late.context.mode = 'live';
  late.$('buzzHost').value = 'pi';
  late.$('buzzEnabled').checked = true;
  late.context.piSources.set('pi', { base: 'http://pi:8080', key: 'fixture-key', sensor: 'boom' });
  const pending = late.run('changeBuzz(false)');
  late.$('buzzHost').value = 'computer';
  late.run('buzzPrefsChanged()');
  release();
  await pending;
  assert.doesNotMatch(late.$('buzzMessage').textContent, /Applied to/);
});
