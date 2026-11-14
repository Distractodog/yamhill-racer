// node tools/checkpoint_respawn_test.mjs --node
// Browser mode: start tools/serve.py 8173 game, then pass an optional screenshot directory.
import assert from 'node:assert/strict';
import { checkpointStart, drivingWrongWay } from '../game/src/raceguidance.js';
if (process.argv.includes('--node')) await nodeChecks(); else await browserChecks();

async function nodeChecks() {
  const THREE = await import('three');
  const { Car, TUNING_DEFAULTS } = await import('../game/src/car.js');
  const { Bike } = await import('../game/src/bike.js');
  const { Jet } = await import('../game/src/jet.js');
  const { createChallenges } = await import('../game/src/challenges.js');
  const elements = new Map();
  const canvas = { fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, fill() {} };
  const element = () => ({ style: {}, append(e) { if (e.id) elements.set(e.id, e); }, querySelectorAll: () => [], getContext: () => canvas });
  globalThis.document = { createElement: element, head: element(), body: element() };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  let handler;
  globalThis.addEventListener = (type, fn) => { if (type === 'keydown') handler = fn; };
  const points = Array.from({ length: 76 }, (_, i) => [0, i * 4, 8]);
  const race = { id: 'checkpoints', name: 'Checkpoints', start: { x: 0, z: 0, yaw: 0 }, track: points,
    route: points, gates: [0, 100, 200, 300].map(z => ({ x: 0, z, yaw: 0, w: 16 })) };
  const jetRace = { ...race, id: 'rings', vehicle: 'jet', track: undefined,
    gates: race.gates.map(g => ({ ...g, y: 100, r: 20 })) };
  globalThis.fetch = async url => ({ ok: true, json: async () => url.endsWith('challenges.json') ? [race, jetRace] : [] });
  const world = { heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3,
    waterLevelAt: () => -Infinity, normalAt: (_x, _z, n) => n.set(0, 1, 0),
    treesNear() {}, buildingsNear: () => [], loadedAt: () => true, pendingTiles: () => 0,
    extent: [-10000, -10000, 10000, 10000], rampAt: () => null };
  const pressR = (repeat = false) => {
    let stopped = false;
    handler({ code: 'KeyR', repeat, preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
    return stopped;
  };
  for (const kind of ['car', 'bike']) {
    const v = kind === 'car' ? new Car(world, { ...TUNING_DEFAULTS }) : new Bike(world);
    const ch = await createChallenges({ scene: new THREE.Scene(), world, car: v, minimap: { open: false } });
    assert.equal(pressR(), false, 'free-roam R must remain with main.js');
    await ch.start(0); assert.equal(pressR(), false, 'countdown R unchanged');
    ch.update(3.01);
    v.pos.set(6, 1, 40); v.vel.set(0, 0, 20);
    assert(pressR()); assert(pressR(true), 'repeat must not fall through to safe reset');
    await Promise.resolve();
    assert.equal(v.pos.x, 0); assert.equal(v.pos.z, 0); assert.equal(ch.next, 1);
    // Move across the first checkpoint, then respawn from a different position.
    v.pos.set(0, 1, 99); ch.update(0.1); v.pos.z = 101; ch.update(0.1);
    assert.equal(ch.next, 2);
    const elapsed = ch.time;
    v.pos.set(6, 1, 150); assert(pressR()); await Promise.resolve();
    assert.equal(v.pos.x, 0); assert.equal(v.pos.z, 100); assert.equal(v.vel.length(), 0);
    assert.equal(ch.next, 2); assert.equal(ch.time, elapsed); assert.equal(ch.state, 'running');
    ch.update(0.01); assert.equal(ch.next, 2, 'reset must not count as crossing the next gate');
    v.pos.z = 150; v.vel.set(0, 0, -20); ch.constrain();
    for (let i = 0; i < 12; i++) ch.update(0.1);
    assert.match(elements.get('ch-hud').innerHTML, /WRONG WAY/);
    v.vel.set(0, 0, 0); ch.update(0.1);
    assert.doesNotMatch(elements.get('ch-hud').innerHTML, /WRONG WAY/);
    v.vel.set(0, 0, 20); ch.update(0.1);
    assert.doesNotMatch(elements.get('ch-hud').innerHTML, /WRONG WAY/);
    // A pending tile load must not teleport the vehicle after the race is cancelled.
    world.loadedAt = () => false; assert(pressR());
    ch.quit(); v.pos.set(500, 20, 500); world.loadedAt = () => true;
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(v.pos.x, 500); assert.equal(v.pos.z, 500);
    assert.equal(pressR(), false);
    console.log(`PASS ${kind}: start/checkpoint R, repeat, timer/progress, wrong-way/stop/forward, free roam`);
  }
  const jet = new Jet(world);
  const ch = await createChallenges({ scene: new THREE.Scene(), world, car: jet, minimap: { open: false },
    vehicles: { jet, switchTo() {} } });
  await ch.start(1); ch.update(3.01);
  assert.equal(pressR(), false, 'jet keeps its existing R handler');
  jet.pos.set(0, 100, 99); ch.update(0.1); jet.pos.z = 101; ch.update(0.1);
  assert.equal(ch.next, 2); jet.resetToSafe();
  assert.equal(jet.pos.z, 100); assert.equal(jet.pos.y, 100); assert.equal(jet.mode, 'air');
  assert(Math.abs(jet.vel.length() * 3.6 - 450) < 1e-8);
  ch.quit(); assert.equal(jet.respawn, null);
  assert.deepEqual(checkpointStart(race, 1), race.start);
  assert.deepEqual(checkpointStart(race, 3), { x: 0, z: 200, yaw: 0 });
  assert.equal(drivingWrongWay({ x: -20, z: 0 }, [[0, 0], [100, 0]], 0), true);
  assert.equal(drivingWrongWay({ x: 0, z: -20 }, [[0, 0], [100, 0]], 0), false, 'sideways is not backwards');
  assert.equal(drivingWrongWay({ x: -2, z: 0 }, [[0, 0], [100, 0]], 0), false);
  console.log('PASS jet air respawn preserved and guidance geometry; browser rendering not verified');
}

async function browserChecks() {
  const fs = await import('node:fs/promises');
  const { default: puppeteer } = await import('puppeteer-core');
  const out = process.argv[2] || '/tmp/yr-checkpoint-respawn'; await fs.mkdir(out, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
  try {
    const page = await browser.newPage(), errors = [];
    await page.setViewport({ width: 1280, height: 760 });
    page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR', e.message); });
    await page.evaluateOnNewDocument(() => localStorage.setItem('yr-welcome-hidden-1', '1'));
    await page.goto(process.env.YR_URL || 'http://127.0.0.1:8173/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.game, { timeout: 120000 });
    for (const kind of ['car', 'bike']) {
      await page.evaluate(async kind => {
        const points = Array.from({ length: 76 }, (_, i) => [0, i * 4, 8]);
        game.challenges.list.push({ id: `checkpoint-test-${kind}`, name: 'Checkpoint test', vehicle: kind,
          start: { x: 0, z: 0, yaw: 0 }, track: points, route: points,
          gates: [0, 100, 200, 300].map(z => ({ x: 0, z, yaw: 0, w: 16 })) });
        await game.challenges.start(game.challenges.list.length - 1);
      }, kind);
      await page.waitForFunction(() => game.challenges.state === 'running', { timeout: 10000 });
      await page.evaluate(() => {
        const v = game.vehicles.current;
        v.pos.set(0, game.world.heightAt(0, 99) + 1, 99); game.challenges.update(0.01);
        v.pos.z = 101; game.challenges.update(0.01); v.pos.z = 150;
      });
      assert.equal(await page.evaluate(() => game.challenges.next), 2);
      await page.keyboard.press('KeyR');
      await page.waitForFunction(() => Math.abs(game.vehicles.current.pos.z - 100) < 2, { timeout: 15000 });
      assert.equal(await page.evaluate(() => game.challenges.next), 2);
      await page.screenshot({ path: `${out}/${kind}-checkpoint.png` });
      await page.evaluate(() => {
        const v = game.vehicles.current;
        v.pos.z = 150; v.vel.set(0, 0, -20); game.challenges.constrain();
        game.challenges.update(1.1);
      });
      assert(await page.evaluate(() => document.getElementById('ch-hud').textContent.includes('WRONG WAY')));
      await page.screenshot({ path: `${out}/${kind}-wrong-way.png` });
      console.log(`PASS browser ${kind} checkpoint respawn and wrong-way hint`);
    }
    assert.deepEqual(errors, []); console.log('PASS PAGEERR');
  } finally { await browser.close(); }
}
