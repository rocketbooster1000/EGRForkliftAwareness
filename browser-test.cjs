'use strict';
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const base = 'http://127.0.0.1:4318';
const server = spawn(process.execPath, ['server.cjs'], { cwd: __dirname, env: { ...process.env, PORT: '4318' }, stdio: 'pipe' });
let browser;
async function waitForServer() {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(base)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Test server did not start');
}
(async () => {
  await waitForServer();
  const options = { headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] };
  if (process.env.BROWSER_PATH) options.executablePath = process.env.BROWSER_PATH;
  browser = await chromium.launch(options);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1150 }, permissions: ['camera'] });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let bridge;
  await page.routeWebSocket(/.*/, ws => { bridge = ws; });
  await page.goto(base);
  assert.equal(await page.title(), 'Telehandler · Surround');
  assert.equal(await page.locator('#camera-front').count(), 0);
  assert.equal(await page.locator('#sensorList input[type=range]').count(), 8);
  await page.locator('#single').click(); assert.equal(await page.locator('.camera:visible').count(), 1); assert.equal(await page.locator('#camera-boom').isVisible(), true);
  await page.locator('#multi').click(); assert.equal(await page.locator('.camera:visible').count(), 4);
  for (const id of ['boom', 'rear', 'left', 'right']) { await page.locator('#demoSensor').selectOption(id); await page.locator('#obstacle').fill('9'); }
  await page.locator('#demoSensor').selectOption('rear');
  await page.locator('#obstacle').fill('2.5');
  const far = await page.evaluate(() => L.alertProfile(sensors.rear.distance, sensors.rear));
  await page.locator('#audio').click();
  assert.equal(await page.locator('#soundStatus').innerText(), 'ENABLED');
  await page.locator('#obstacle').fill('1.5');
  const near = await page.evaluate(() => audio.profile);
  assert.ok(near.frequencyHz > far.frequencyHz); assert.ok(near.periodSeconds < far.periodSeconds);
  await page.locator('#obstacle').fill('0.1');
  assert.equal(await page.evaluate(() => audio.profile.continuous), true);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => audio.context.state), 'running');
  await page.locator('#audio').click(); await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => audio.profile), null);
  const renderedAudio = await page.evaluate(async () => {
    async function render(mute) {
      const offline = new OfflineAudioContext(1, 48000 / 2, 48000);
      const engine = new ProximityAudio();
      // The real Windows test environment has no output device; render its actual envelope offline.
      engine.context = { currentTime: 0, state: 'running' };
      engine.oscillator = offline.createOscillator(); engine.gain = offline.createGain(); engine.gain.gain.value = 0;
      engine.oscillator.connect(engine.gain); engine.gain.connect(offline.destination); engine.oscillator.start();
      engine.setProfile(L.alertProfile(0.1, { maxRange: 3, fullTone: 0.5 })); engine.tick();
      if (mute) engine.stop();
      const rendered = await offline.startRendering(), values = rendered.getChannelData(0).slice(12000);
      return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
    }
    return { active: await render(false), muted: await render(true) };
  });
  assert.ok(renderedAudio.active > 0.01); assert.ok(renderedAudio.muted < 0.00001);
  await page.locator('#maxRange-rear').fill('4'); await page.locator('#fullTone-rear').fill('1');
  await page.reload(); assert.equal(await page.locator('#maxRange-rear').inputValue(), '4'); assert.equal(await page.locator('#fullTone-rear').inputValue(), '1');
  await page.locator('#maxRange-rear').fill('0.3'); assert.ok(Number(await page.locator('#fullTone-rear').inputValue()) < 0.3);
  await page.locator('#fullTone-rear').fill('2'); assert.ok(Number(await page.locator('#maxRange-rear').inputValue()) > 2);
  await page.locator('#settingsButton').click();
  await page.locator('#connect-boom').click(); await page.waitForFunction(() => document.getElementById('cameraCount').textContent === '1 connected');
  await page.locator('#remove-boom').click(); assert.equal(await page.locator('#cameraCount').innerText(), '0 connected');
  await page.locator('#sensorUrl').fill('ws://localhost:8765'); await page.locator('#connectSensors').click();
  await page.waitForFunction(() => document.getElementById('connectionStatus').textContent.includes('Waiting'));
  assert.equal(await page.locator('#mapPoints circle').count(), 0);
  const send = message => bridge.send(JSON.stringify(message));
  send({ type: 'frame', measurements: [
    { sensor: 'boom', points: [{ distance_m: 1, bearing_deg: 0 }], pose: { x_m: 0.03, y_m: 0, yaw_deg: 0 } },
    { sensor: 'right', points: [{ distance_m: 1, bearing_deg: 0 }], pose: { x_m: 0.06, y_m: 0, yaw_deg: 0 } },
    { sensor: 'left', distance_m: 1.7 },
    { sensor: 'rear', distance_m: 2, pose: { x_m: 0, y_m: -2.2, yaw_deg: 180 } }
  ] });
  await page.waitForFunction(() => document.querySelector('[data-sources="boom,right"]'));
  assert.equal(await page.locator('#mapPoints circle').count(), 2);
  assert.ok((await page.locator('#mapSummary').innerText()).includes('Unplaced: Left'));
  assert.equal(await page.locator('#obstacle').isDisabled(), true);
  send({ sensor: 'boom', distance_m: 1, pose: { x_m: 0.03, y_m: 4, yaw_deg: 0 } });
  await page.waitForFunction(() => document.querySelector('[data-sources="boom"]')?.getAttribute('cy') === '-5');
  send({ sensor: 'rear', distance_m: 'bad' });
  await page.waitForFunction(() => document.getElementById('connectionStatus').textContent.includes('Ignored'));
  await page.waitForFunction(() => document.getElementById('sensor-boom').classList.contains('stale'), {}, { timeout: 5000 });
  assert.equal(await page.locator('#mapPoints circle').count(), 0);
  send({ sensor: 'boom', distance_m: 0.2 });
  await page.waitForFunction(() => document.getElementById('sensor-boom').classList.contains('close'));
  bridge.close(); await page.waitForFunction(() => document.getElementById('sensor-boom').classList.contains('stale'));
  await page.locator('#disconnectSensors').click(); await page.getByRole('button', { name: 'Close device setup' }).click();
  await page.locator('#maxRange-rear').fill('3'); await page.locator('#fullTone-rear').fill('0.5');
  const results = path.join(__dirname, 'test-results'); await fs.mkdir(results, { recursive: true });
  await page.screenshot({ path: path.join(results, 'dashboard-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(results, 'dashboard-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: telehandler/boom layout; continuous pitch/rate and sustained audio; mute; two sliders and persistence; USB; multi-sensor fusion; moving boom; missing poses; stale/invalid readings; disconnect; demo recovery; mobile width.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); server.kill(); });
