const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const L = require('./logic.js');
function fixture() {
  const nodes = new Map();
  const now = Date.now();
  const sensor = (distance, updated = now) => ({ distance, maxRange: 3, fullTone: 0.5, updated });
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, hidden: false, disabled: false, textContent: '', classList: { toggle() {} }, setAttribute() {}, addEventListener() {} });
    return nodes.get(id);
  };
  const context = vm.createContext({ window: { addEventListener() {} }, $, L, ids: L.IDS, mode: 'demo', sensors: { boom: sensor(0.4), rear: sensor(2), left: sensor(4, 0), right: sensor(4, 0) }, Date, Number, JSON, Math, TextEncoder, navigator: {}, localStorage: { getItem() { return null; }, setItem() {} }, title: id => id, formatDistance: meters => (meters / 0.3048).toFixed(1) + ' ft', setInterval() {}, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync('buzz.js', 'utf8'), context);
  return { context, $, run: code => vm.runInContext(code, context) };
}
test('preview follows the closest obstacle and stays quiet until a wristband is connected', () => {
  const f = fixture();
  f.$('buzzEnabled').checked = true;
  f.run('renderBuzz()');
  assert.match(f.$('buzzStatus').textContent, /Strong buzz/);
  assert.match(f.$('buzzStatus').textContent, /wristband not connected/);
  ['boom', 'rear', 'left', 'right'].forEach(id => { f.context.sensors[id].distance = 4; });
  f.run('renderBuzz()');
  assert.match(f.$('buzzStatus').textContent, /Outside alert range/);
  assert.equal(f.$('testBuzz').disabled, true);
});
test('a connected wristband is written once per pulse and not while outside range', async () => {
  const writes = [];
  const f = fixture();
  f.context.link = { writeValue: async bytes => { writes.push(new TextDecoder().decode(bytes)); } };
  f.$('buzzEnabled').checked = true;
  f.run('useBuzzLink(link)');
  await f.run('tickBuzz()');
  await f.run('tickBuzz()');
  assert.deepEqual(writes, ['b,0.85,400']);
  ['boom', 'rear', 'left', 'right'].forEach(id => { f.context.sensors[id].distance = 4; });
  f.run('armBuzzWrite()');
  await f.run('tickBuzz()');
  assert.deepEqual(writes, ['b,0.85,400']);
  f.context.sensors.boom.distance = 0.4;
  f.run('armBuzzWrite()');
  await f.run('tickBuzz()');
  assert.deepEqual(writes, ['b,0.85,400', 'b,0.85,400']);
});
test('test buzz sends one strong pulse without enabling alerts', async () => {
  const writes = [];
  const f = fixture();
  f.context.link = { writeValue: async bytes => { writes.push(new TextDecoder().decode(bytes)); } };
  f.run('useBuzzLink(link)');
  f.run('buzzTestUntil = Date.now() + 900; armBuzzWrite()');
  await f.run('tickBuzz()');
  await f.run('tickBuzz()');
  assert.deepEqual(writes, ['b,0.85,400']);
  assert.equal(f.$('buzzEnabled').checked, false);
});
