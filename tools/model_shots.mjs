// Director: every car and bike type model in the real game. Run through the heavy gate with the no-cache server on
// 127.0.0.1:8173 (Chrome with a GPU, like tools/lights_shots.mjs):
//   /Users/ethanbristol/argus-runs/.heavy/heavy node tools/model_shots.mjs --out /tmp/yr-models [--only sports,truck]
// For each car type (race, sports, hatch, suv, truck) and bike type (dirt, sport) it writes, as <type>-<shot>.png:
//   garage (the Garage preview, as opened), front34, rear34, side, top (parked at midday), drive150 (chase camera at
//   ~150 km/h), night-front34 / night-rear34 (lights on); and per CAR type wheelclip-side / wheelclip-front34, the car
//   held at 1000 km/h on the spot (the wheel-clip check: no tyre through the body). Plus report.json (model name,
//   speeds, lights state, triangles, draw calls, finite checks). Needs a human look at the PNGs; fails on page errors.
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GAME_URL, startGame, holdCar, watchErrors } from './lib/startgame.mjs';

const args = process.argv.slice(2), opt = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
const out = opt('--out', args.find(a => !a.startsWith('--')) || '/tmp/yr-models');
const only = opt('--only', '') ? opt('--only', '').split(',') : null;
const TYPES = [['car', 'race'], ['car', 'sports'], ['car', 'hatch'], ['car', 'suv'], ['car', 'truck'], ['bike', 'dirt'], ['bike', 'sport']]
  .filter(([, type]) => !only || only.includes(type));
const SPOT = { x: 19451, z: -11032, yaw: -1.573 };          // a straight road (tools/lights_shots.mjs)
const report = { pageErrors: [], consoleErrors: [], shots: [], visualReview: 'NOT REVIEWED' };
const wait = ms => new Promise(r => setTimeout(r, ms));
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
});
let failed = null;
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 760 });
  page.setDefaultTimeout(120000);
  watchErrors(page, 'game', report.pageErrors);
  page.on('console', m => { if (m.type() === 'error' && !(m.location()?.url || '').includes('favicon')) report.consoleErrors.push(m.text()); });
  await startGame(page, { url: process.env.GAME_URL || GAME_URL, hold: { ...SPOT, kind: 'car' } });
  await page.evaluate(() => {
    game.challenges.quit?.();
    // camera views in the vehicle's frame (+z forward), eye and target scaled by the vehicle's size k; applied just
    // before each render of the world (view null = the game's own chase camera)
    window.shots = { view: null, k: 1, frames: [] };
    const VIEWS = {
      front34: [[4.6, 1.5, 5.2], [0, .45, .3]], rear34: [[-4.4, 1.7, -5.4], [0, .45, -.3]], side: [[7.5, .8, 0], [0, .45, 0]],
      top: [[0, 9, .01], [0, 0, 0]], wheelfront: [[3.2, .5, 2.6], [0, .35, .6]],
    };
    const original = game.renderer.render.bind(game.renderer);
    game.renderer.render = (scene, camera) => {
      const s = window.shots, m = game.vehicles.current.mesh;
      if (s.view && VIEWS[s.view] && scene === game.scene) {
        const [eye, at] = VIEWS[s.view], P = m.position.constructor;
        camera.position.copy(m.localToWorld(new P(...eye.map(v => v * s.k))));
        camera.lookAt(m.localToWorld(new P(...at.map(v => v * s.k)))); camera.updateMatrixWorld();
      }
      original(scene, camera);
    };
  });
  const state = () => page.evaluate(() => {
    const g = game, v = g.vehicles.current, info = g.renderer.info.render;
    return { kind: v.kind, type: v.type, model: v.mesh.name, kmh: Math.round(v.vel.length() * 3.6), night: g.atmosphere?.night, lightsOn: g.vehicleLights?.on,
      triangles: info.triangles, calls: info.calls, finite: [...v.pos, ...v.vel, ...v.quat].every(Number.isFinite) };
  });
  async function shot(type, name, view, settle = 600) {
    await page.evaluate(view => { window.shots.view = view; }, view);
    await wait(settle);
    const file = `${type}-${name}.png`;
    await page.screenshot({ path: join(out, file) });
    const s = await state(); report.shots.push({ file, view, ...s }); console.log(file, s);
    if (!s.finite) throw new Error(`${file}: non-finite vehicle state`);
  }
  const freeze = on => page.evaluate(on => {
    for (const v of Object.values(game.vehicles.all)) { v._step ??= v.step; v.step = on ? () => {} : v._step; }
  }, on);

  for (const [kind, type] of TYPES) {
    console.log(`== ${kind}/${type}`);
    await page.evaluate((kind, type) => {
      game.garage.close(); game.keys.clear(); window.shots.view = null; window.shots.k = kind === 'car' ? 1 : .45;
      game.vehicles.switchTo(kind); game.vehicles.setType(kind, type); game.atmosphere.setPreset('midday', false);
    }, kind, type);
    await freeze(false); await holdCar(page, { ...SPOT, kind }); await wait(900);

    // Garage preview: as opened for this kind and type
    await page.evaluate(() => game.garage.show());
    await page.click(`#cosmetic-garage [data-kind="${kind}"]`).catch(() => {});
    const select = '[role="dialog"][aria-labelledby="garage-title"] select[name="vehicleType"]';
    await page.waitForSelector(select, { visible: true }).then(() => page.select(select, type)).catch(() => {});
    await wait(900);
    await page.screenshot({ path: join(out, `${type}-garage.png`) }); report.shots.push({ file: `${type}-garage.png` });
    await page.evaluate(() => game.garage.close());

    // parked at midday
    await holdCar(page, { ...SPOT, kind }); await wait(500); await freeze(true);
    for (const view of ['front34', 'rear34', 'side', 'top']) await shot(type, view, view);

    // driving at ~150 km/h behind (the game's chase camera)
    await freeze(false);
    await page.evaluate(() => { const v = game.vehicles.current; game.setCam(0); v.vel.set(0, 0, 150 / 3.6).applyQuaternion(v.quat); game.keys.add('KeyW'); });
    await wait(1200);
    await page.evaluate(() => { const v = game.vehicles.current; if (v.vel.length() * 3.6 < 140) v.vel.set(0, 0, 150 / 3.6).applyQuaternion(v.quat); });
    await wait(150);
    await shot(type, 'drive150', null, 0);
    await page.evaluate(() => game.keys.clear());

    // night, lights on
    await holdCar(page, { ...SPOT, kind }); await freeze(true);
    await page.evaluate(() => { game.atmosphere.setPreset('night', false); });
    await wait(1500);
    // lights switch on by themselves at night (lights.js: on = night > 0); report.json records vehicleLights.on
    for (const view of ['front34', 'rear34']) await shot(type, `night-${view}`, view, 900);
    await page.evaluate(() => game.atmosphere.setPreset('midday', false));

    // 1000 km/h on the spot, cars only: the wheel-clip fix must keep tyres out of the body
    if (kind === 'car') {
      await freeze(false);
      await page.evaluate(({ x, z }) => {
        const v = game.vehicles.current; game.keys.add('KeyW');
        window.shots.fast = setInterval(() => {                     // hold the car on the spot at 1000 km/h
          v.pos.set(x, v.pos.y, z); v.vel.set(0, v.vel.y, 1000 / 3.6).applyQuaternion(v.quat);
        }, 16);
      }, SPOT);
      await wait(1500);
      await shot(type, 'wheelclip-side', 'side', 200);
      await shot(type, 'wheelclip-front34', 'wheelfront', 200);
      await page.evaluate(() => { clearInterval(window.shots.fast); game.keys.clear(); });
    }
  }
  if (report.pageErrors.length) throw new Error(`${report.pageErrors.length} page errors`);
} catch (e) { failed = e; report.error = e.message; console.error(e); }
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
await browser.close();
console.log(`${report.shots.length} shots in ${out}${failed ? ' — FAILED' : ''}`);
process.exit(failed ? 1 : 0);
