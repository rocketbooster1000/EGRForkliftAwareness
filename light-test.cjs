const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const L = require('./logic.js');
function fixture(fetcher) {
  const nodes = new Map(), calls = [];
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { value: id === 'lightSensor' ? 'boom' : id === 'lightDistance' ? '3' : '', checked: false, textContent: '', classList: { toggle() {} }, setAttribute() {} });
    return nodes.get(id);
  };
  const context = vm.createContext({ window:{addEventListener(){}}, $, L, ids: L.IDS, mode:'demo', piSources:new Map(), sensors:{boom:{distance:.5,fullTone:.9144000000000001},rear:{distance:2,fullTone:.3048}}, Date, Number, JSON, Map, URL, AbortController, setTimeout, clearTimeout, setInterval() {}, localStorage:{getItem(){return null;},setItem(){}}, title:id=>id, formatDistance:m=>(m/.3048).toFixed(1)+' ft', fetch:async (...args)=>{calls.push(args);return fetcher(...args);} });
  vm.runInContext(fs.readFileSync('light.js','utf8'),context);
  return { context, $, calls, run:code=>vm.runInContext(code,context) };
}
const good = {available:true,enabled:true,threshold_m:.9144,active:true,lit:true,reason:'warning'};
test('demo crossing and light test never send a physical command', async ()=>{
  const f=fixture(()=>{throw Error('Unexpected network');});
  f.$('lightEnabled').checked=true; f.run('renderDriverLight()');
  assert.match(f.$('lightStatus').textContent,/Flashing/);
  f.context.sensors.boom.distance=2; f.run('renderDriverLight()');
  assert.match(f.$('lightStatus').textContent,/Outside/);
  await f.run('changeDriverLight(true)'); assert.equal(f.calls.length,0);
  assert.equal(f.$('applyLight').disabled,true);
});
test('live apply sends converted threshold only to selected authenticated Pi',async()=>{
  const f=fixture(async()=>({ok:true,json:async()=>good}));
  f.context.mode='live';f.context.piSources.set('pi',{base:'http://pi:8080',key:'fixture-key',sensor:'boom'});
  f.$('lightEnabled').checked=true;
  await f.run('changeDriverLight(false)');
  assert.equal(f.calls[0][0].href,'http://pi:8080/api/light');
  assert.equal(f.calls[0][1].headers.Authorization,'Bearer fixture-key');
  assert.deepEqual(JSON.parse(f.calls[0][1].body),{enabled:true,threshold_m:.9144000000000001});
  assert.match(f.$('lightStatus').textContent,/Flashing warning/);
  f.context.mode='demo';await f.run('changeDriverLight(false)');assert.equal(f.calls.length,1);
});
test('missing Pi and failed request do not claim physical success',async()=>{
  const f=fixture(async()=>({ok:false,json:async()=>({error:'Not configured'})}));
  f.context.mode='live';f.run('renderDriverLight()');assert.equal(f.$('applyLight').disabled,true);
  f.context.piSources.set('pi',{base:'http://pi:8080',key:'fixture-key',sensor:'boom'});
  await f.run('changeDriverLight(false)');
  assert.match(f.$('lightMessage').textContent,/unconfirmed/);
  assert.match(f.$('lightStatus').textContent,/unavailable/);
});
test('response from a previously selected Pi is ignored',async()=>{
  let release;const f=fixture(()=>new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>good});}));
  f.context.mode='live';f.context.piSources.set('pi',{base:'http://pi:8080',key:'fixture-key',sensor:'boom'});
  const pending=f.run('changeDriverLight(false)');
  f.$('lightSensor').value='rear';f.run('lightPrefsChanged()');release();await pending;
  assert.doesNotMatch(f.$('lightMessage').textContent,/Applied to/);
});

test('light follows selected full tone by default and manual override is independent',()=>{
  const f=fixture(()=>{throw Error('Unexpected network');});
  assert.ok(Math.abs(f.run('lightThresholdMeters()')-.9144)<1e-9);
  f.context.sensors.boom.fullTone=.6096;
  assert.equal(f.run('lightThresholdMeters()'),.6096);
  f.$('lightSensor').value='rear'; assert.equal(f.run('lightThresholdMeters()'),.3048);
  f.$('lightManual').checked=true;f.$('lightDistance').value='5';
  assert.equal(f.run('lightThresholdMeters()'),1.524);
  f.context.sensors.rear.fullTone=.7; assert.equal(f.run('lightThresholdMeters()'),1.524);
  f.$('lightManual').checked=false; assert.equal(f.run('lightThresholdMeters()'),.7);
});
