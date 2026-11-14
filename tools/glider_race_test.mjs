// BUG-2 option A. --node tests real challenge/glider/vehicle code with a flat world and DOM shim.
// Default tests real keyboard input in Chrome against tools/serve.py 8173 game.
import assert from 'node:assert/strict';

if (process.argv.includes('--node')) await nodeChecks();
else await browserChecks();

async function nodeChecks() {
  const THREE = await import('three');
  const { Car, TUNING_DEFAULTS } = await import('../game/src/car.js');
  const { Bike } = await import('../game/src/bike.js');
  const { Glider, BIKE_GLIDER } = await import('../game/src/glider.js');
  const { createChallenges } = await import('../game/src/challenges.js');
  const canvas = { fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, fill() {} };
  const element = () => ({ style: {}, append() {}, querySelectorAll: () => [], getContext: () => canvas });
  globalThis.document = { createElement: element, head: element(), body: element() };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  let handler;
  globalThis.addEventListener = (type, fn) => { if (type === 'keydown') handler = fn; };
  const points = [];
  for (let z = 0; z <= 200; z += 4) points.push([0, z, 8]);
  for (let x = 4; x <= 200; x += 4) points.push([x, 200, 8]);
  const race = { id: 'test-bend', name: 'Test bend', start: { x: 0, z: 0, yaw: 0 }, track: points,
    route: points, gates: [{ x: 0, z: 0, yaw: 0, w: 16 }, { x: 200, z: 200, yaw: Math.PI / 2, w: 16 }] };
  globalThis.fetch = async url => ({ ok: true, json: async () => url.endsWith('challenges.json') ? [race] : [] });
  const world = { heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3,
    waterLevelAt: () => -Infinity, normalAt: (_x, _z, n) => n.set(0, 1, 0),
    treesNear() {}, buildingsNear: () => [], loadedAt: () => true, pendingTiles: () => 0,
    extent: [-10000, -10000, 10000, 10000], rampAt: () => null };
  for (const kind of ['car', 'bike']) {
    const v = kind === 'car' ? new Car(world, { ...TUNING_DEFAULTS }) : new Bike(world);
    const g = new Glider(v, kind === 'bike' ? BIKE_GLIDER : {});
    const ch = await createChallenges({ scene: new THREE.Scene(), world, car: v, minimap: { open: false } });
    const pressG = () => {
      let stopped = false;
      handler({ code: 'KeyG', repeat: false, preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
      // Mirrors main.js's bubble listener only when the actual capture listener allows it through.
      if (!stopped) g.toggle();
      return stopped;
    };
    v.pos.y = 100; v.grounded = false; v.airTime = 1; g.deploy();
    const starting = ch.start(0);
    assert.equal(ch.state, 'placing'); assert(pressG());
    await starting; assert.equal(g.active, false);
    console.log(`PASS ${kind} placing and pre-race wing cancellation`);
    for (const phase of ['countdown', 'running']) for (const airborne of [false, true]) {
      await ch.start(0);
      if (phase === 'running') ch.update(3.01);
      assert.equal(ch.state, phase);
      v.pos.y = airborne ? 100 : 0.75; v.grounded = !airborne; v.airTime = airborne ? 1 : 0;
      v.vel.set(0, 0, 150 / 3.6);
      assert(pressG(), `${kind}/${phase}: G must be consumed`);
      assert.equal(g.active, false); assert.equal(g.msg, 'No glider in races');
      g.deploy(); ch.constrain(); assert.equal(g.active, false, 'pre-existing wing must fold');
      console.log(`PASS ${kind} ${phase} ${airborne ? 'air' : 'ground'} 150 km/h`);
    }
    await ch.start(0); ch.update(3.01);
    v.pos.set(0, 2000, 10); v.quat.identity(); v.grounded = false; v.airTime = 1;
    v.vel.set(150 / 3.6 / Math.sqrt(2), 0, 150 / 3.6 / Math.sqrt(2));
    let maxOutside = 0;
    for (let i = 0; i < 1200; i++) {
      if (i % 30 === 0) pressG();
      v.step(1 / 120, { throttle: 0, brake: 0, steer: 0, handbrake: false, lean: false });
      ch.constrain();
      assert.equal(g.active, false);
      const outside = corridorOutside(v.pos, points);
      maxOutside = Math.max(maxOutside, outside);
      assert(Number.isFinite(outside) && outside <= 1.5, `${kind} escaped corridor by ${outside} m`);
    }
    console.log(`PASS ${kind} shortcut bot: max outside ${maxOutside.toFixed(4)} m`);
    ch.quit(); v.pos.y = 100; v.grounded = false; v.airTime = 1;
    assert.equal(pressG(), false); assert.equal(g.active, true, 'free-roam G must open');
    pressG(); assert.equal(g.active, false, 'free-roam G must fold');
    console.log(`PASS ${kind} free roam restored`);
  }
  console.log('PASS Node challenge integration (DOM shim; browser rendering not verified)');
}

function corridorOutside(p, points) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.z - a[1]) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(p.x - a[0] - dx * t, p.z - a[1] - dz * t) - a[2] - (b[2] - a[2]) * t);
  }
  return best;
}

async function browserChecks() {
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR', e.message); });
    await page.evaluateOnNewDocument(() => localStorage.setItem('yr-welcome-hidden-1', '1'));
    await page.goto(process.env.YR_URL || 'http://127.0.0.1:8173/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.game, { timeout: 120000 });
    for (const kind of ['car', 'bike']) {
      for (const phase of ['countdown', 'running']) for (const airborne of [false, true]) {
        await page.evaluate(async kind => {
          await game.challenges.start(game.challenges.list.findIndex(c => (c.vehicle || 'car') === kind));
        }, kind);
        if (phase === 'running') await page.waitForFunction(() => game.challenges.state === 'running', { timeout: 10000 });
        const result = await page.evaluate(({ airborne, phase }) => {
          const v = game.vehicles.current;
          v.pos.y = game.world.heightAt(v.pos.x, v.pos.z) + (airborne ? 100 : 0.75);
          v.grounded = !airborne; v.airTime = airborne ? 1 : 0; v.vel.set(0, 0, 150 / 3.6);
          const before = game.challenges.state;
          // Synchronous dispatch keeps the speed/height fixture exact at the moment G is handled.
          dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'g', bubbles: true, cancelable: true }));
          dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyG', key: 'g', bubbles: true }));
          return { before, expected: phase, active: v.glide.active, msg: v.glide.msg };
        }, { airborne, phase });
        assert.equal(result.before, result.expected); assert.equal(result.active, false); assert.equal(result.msg, 'No glider in races');
        console.log(`PASS browser ${kind} ${phase} ${airborne ? 'air' : 'ground'} 150 km/h`);
      }
      const maxOutside = await page.evaluate(async kind => {
        const points = [];
        for (let z = 0; z <= 200; z += 4) points.push([0, z, 8]);
        for (let x = 4; x <= 200; x += 4) points.push([x, 200, 8]);
        const list = game.challenges.list;
        list.push({ id: `test-bend-${kind}`, name: 'Test bend', vehicle: kind,
          start: { x: 0, z: 0, yaw: 0 }, track: points, route: points,
          gates: [{ x: 0, z: 0, yaw: 0, w: 16 }, { x: 200, z: 200, yaw: Math.PI / 2, w: 16 }] });
        await game.challenges.start(list.length - 1); game.challenges.update(3.01);
        const v = game.vehicles.current;
        v.pos.set(0, game.world.heightAt(0, 0) + 2000, 10); v.quat.identity();
        v.grounded = false; v.airTime = 1;
        v.vel.set(150 / 3.6 / Math.sqrt(2), 0, 150 / 3.6 / Math.sqrt(2));
        // Exercise cancellation of a pre-existing wing before the bot's shortcut attempt.
        v.glide.deploy(); game.challenges.constrain();
        if (v.glide.active) throw new Error('Pre-existing wing remained active');
        let worst = 0;
        for (let i = 0; i < 1200; i++) {
          if (i % 30 === 0) {
            dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'g', cancelable: true }));
            dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyG', key: 'g' }));
          }
          v.step(1 / 120, { throttle: 0, brake: 0, steer: 0, handbrake: false, lean: false });
          game.challenges.constrain();
          if (v.glide.active) throw new Error('Shortcut bot opened glider');
          let best = Infinity;
          for (let j = 1; j < points.length; j++) {
            const a = points[j - 1], b = points[j], dx = b[0] - a[0], dz = b[1] - a[1];
            const t = Math.max(0, Math.min(1, ((v.pos.x - a[0]) * dx + (v.pos.z - a[1]) * dz) / (dx * dx + dz * dz)));
            best = Math.min(best, Math.hypot(v.pos.x - a[0] - dx * t, v.pos.z - a[1] - dz * t) - 8);
          }
          if (!Number.isFinite(best) || best > 1.5) throw new Error(`Escaped corridor by ${best} m`);
          worst = Math.max(worst, best);
        }
        return worst;
      }, kind);
      console.log(`PASS browser ${kind} shortcut bot: max outside ${maxOutside.toFixed(4)} m`);
      await page.evaluate(() => {
        game.challenges.quit(); const v = game.vehicles.current;
        v.pos.y = game.world.heightAt(v.pos.x, v.pos.z) + 100; v.grounded = false; v.airTime = 1;
      });
      await page.keyboard.press('KeyG');
      assert(await page.evaluate(() => game.vehicles.current.glide.active), 'free-roam G must open');
      await page.keyboard.press('KeyG');
      assert.equal(await page.evaluate(() => game.vehicles.current.glide.active), false);
    }
    assert.deepEqual(errors, []); console.log('PASS browser input and PAGEERR');
  } finally { await browser.close(); }
}
