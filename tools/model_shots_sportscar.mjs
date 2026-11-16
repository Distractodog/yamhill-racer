// Director: the Sports car (Lamborghini-style model, game/src/models/sportscar.js) in the real game. Run through the
// heavy gate with the no-cache server on 127.0.0.1:8173:
//   node tools/model_shots_sportscar.mjs --out /tmp/yr-sportscar
// Writes PNGs + report.json: Garage preview (two angles), parked on a road at midday from front 3/4, rear 3/4, side,
// top and low front, driving at speed (chase camera + a side pass), and at night (front, rear, braking). Requires
// visual review; fails on page errors. Shapes can also be checked without a browser: node tools/model_raster_sportscar.mjs.
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GAME_URL, startGame, watchErrors } from './lib/startgame.mjs';

const args = process.argv.slice(2), out = args.includes('--out') ? args[args.indexOf('--out') + 1] : (args[0] || '/tmp/yr-sportscar');
await mkdir(out, { recursive: true });
const SPOT = { x: 19451, z: -11032, yaw: -1.573 };          // a road (tools/lights_shots.mjs)
const report = { pageErrors: [], consoleErrors: [], shots: [], visualReview: 'NOT REVIEWED' };
const wait = ms => new Promise(r => setTimeout(r, ms));
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
  await startGame(page, { url: process.env.GAME_URL || GAME_URL, storage: { 'yr-vtype-1': JSON.stringify({ car: 'sports', bike: 'dirt' }) },
    hold: { ...SPOT, kind: 'car' } });
  await page.evaluate(() => {
    const g = game; g.vehicles.setType?.('car', 'sports'); g.vehicles.switchTo('car'); g.challenges.quit?.();
    // camera views relative to the car, applied just before each render (null = the game's own camera)
    window.sportsShot = { view: null, frames: [] };
    const VIEWS = {
      front34: [[4.6, 1.5, 5.2], [0, .45, .3]], rear34: [[-4.4, 1.7, -5.4], [0, .45, -.3]], side: [[7.5, .8, 0], [0, .45, 0]],
      top: [[0, 9, .01], [0, 0, 0]], lowfront: [[2.6, .45, 4.4], [0, .45, .6]], front: [[0, 1.0, 7.5], [0, .5, 0]], rear: [[0, 1.2, -7.5], [0, .5, 0]],
    };
    const original = g.renderer.render.bind(g.renderer);
    g.renderer.render = (scene, camera) => {
      const s = window.sportsShot, v = g.vehicles.current;
      if (s.view && VIEWS[s.view]) {
        const [eye, at] = VIEWS[s.view], m = v.mesh;
        camera.position.copy(m.localToWorld(new (m.position.constructor)(...eye)));
        camera.lookAt(m.localToWorld(new (m.position.constructor)(...at))); camera.updateMatrixWorld();
      }
      const t = performance.now(); original(scene, camera); s.frames.push(performance.now() - t);
    };
  });
  const state = () => page.evaluate(() => {
    const g = game, v = g.vehicles.current, info = g.renderer.info.render, f = window.sportsShot.frames.slice(-60).sort((a, b) => a - b);
    return { kind: v.kind, type: v.type, model: v.mesh.name, trim: g.cosmetics.get('car').trim, kmh: Math.round(v.vel.length() * 3.6), lightsOn: g.vehicleLights?.on,
      triangles: info.triangles, calls: info.calls, renderMsMedian: +(f[f.length >> 1] || 0).toFixed(2),
      finite: [...v.pos, ...v.vel, ...v.quat].every(Number.isFinite) };
  });
  async function shot(name, view, settle = 700) {
    await page.evaluate(view => { window.sportsShot.view = view; }, view);
    await wait(settle);
    await page.screenshot({ path: join(out, `${name}.png`) });
    const s = await state(); report.shots.push({ file: `${name}.png`, view, ...s }); console.log(name, s);
    if (!s.finite) throw new Error(`${name}: non-finite car state`);
    if (s.model !== 'car-sports') throw new Error(`${name}: wrong model ${s.model}`);
  }
  const park = () => page.evaluate(({ x, z, yaw }) => {
    const g = game, v = g.vehicles.current; delete v.step; v.reset(x, z, yaw); v.vel.set(0, 0, 0); g.keys.clear();
  }, SPOT);
  const freeze = () => page.evaluate(() => { const v = game.vehicles.current; v.step = () => {}; });

  // Garage preview: as opened, then turned by a drag on the preview
  await page.evaluate(() => { game.garage.show(); });
  await page.click('#cosmetic-garage [data-kind="car"]').catch(() => {});
  await wait(800);
  await page.screenshot({ path: join(out, 'garage.png') }); report.shots.push({ file: 'garage.png' });
  const canvas = await page.$('.garage-canvas canvas');
  if (canvas) {
    const b = await canvas.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 220, b.y + b.height / 2, { steps: 12 }); await page.mouse.up(); await wait(500);
    await page.screenshot({ path: join(out, 'garage-turned.png') }); report.shots.push({ file: 'garage-turned.png' });
  }
  await page.evaluate(() => game.garage.close());

  // parked at midday
  await page.evaluate(() => game.atmosphere?.setPreset('midday', false));
  await park(); await wait(1200); await freeze();
  for (const view of ['front34', 'rear34', 'side', 'top', 'lowfront', 'front', 'rear']) await shot(`day-${view}`, view);

  // driving at speed: chase camera, then a side pass (wheels spinning, body lean)
  await park(); await page.evaluate(() => { window.sportsShot.view = null; game.setCam(0); game.keys.add('KeyW'); });
  await wait(2600); await shot('drive-chase', null, 0);
  await shot('drive-side', 'side', 250);
  await shot('drive-front34', 'front34', 250);
  await page.evaluate(() => game.keys.clear());

  // night: lenses and beams on, then braking
  await page.evaluate(() => game.atmosphere?.setPreset('night', false));
  await park(); await wait(1200); await freeze();
  for (const view of ['front34', 'rear34', 'front']) await shot(`night-${view}`, view, 900);
  await park(); await page.evaluate(() => { game.keys.add('KeyS'); }); await wait(500);
  await shot('night-rear-braking', 'rear', 300);
  await page.evaluate(() => game.keys.clear());
  if (report.pageErrors.length) throw new Error(`${report.pageErrors.length} page errors`);
} catch (e) { failed = e; report.error = e.message; console.error(e); }
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
await browser.close();
console.log(`${report.shots.length} shots in ${out}${failed ? ' — FAILED' : ''}`);
process.exit(failed ? 1 : 0);
