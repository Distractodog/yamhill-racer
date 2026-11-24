// Director: serve game/ at YR_URL (default http://127.0.0.1:8173/), then run through the heavy gate:
//   node tools/headlight_shots.mjs --out /tmp/yr-headlights [--only race,dirt] [--no-bench]
// Headlights at night in the real game (lights.js): every car type (race, sports, hatch, SUV, truck), both bikes and
// the aircraft with a landing light, parked on a McMinnville road (the lights_shots.mjs spot) with physics frozen,
// night preset. Per type: from behind (the road pool), a front 3/4 close-up of the lamps (lenses + glow) and a low
// side view of the beam on the road; plus the car with the lights off (L) for contrast. Then: shader programs must
// not change while switching through every type again (no recompiles), and a McMinnville night A/B/A: frame times
// with the beam and lenses hidden / shown / hidden (the extra median must be <= 1 ms).
// Writes <out>/<type>-<view>.png and <out>/report.json. Fails on page errors, a missing beam, new shader programs
// or the cost limit. Review the PNGs: lenses on the drawn lamps, a wide even warm-white pool 5-25 m ahead fading by
// ~50-60 m, nothing lit on the car itself, nothing above the lamps' height far ahead.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import { GAME_URL, startGame, holdCar, watchErrors } from './lib/startgame.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' }, only: { type: 'string' }, 'no-bench': { type: 'boolean' } } });
const out = values.out || '/tmp/yr-headlights', only = values.only?.split(',');
const SPOT = { x: 19451, z: -11032, yaw: -1.573 };              // a straight McMinnville road (tools/lights_shots.mjs)
const TYPES = [['car', 'race'], ['car', 'sports'], ['car', 'hatch'], ['car', 'suv'], ['car', 'truck'], ['bike', 'dirt'], ['bike', 'sport'],
  ['jet', 'prop'], ['jet', 'stunt'], ['jet', 'stealth'], ['jet', 'blackbird'], ['jet', 'heli']].filter(([, t]) => !only || only.includes(t));
const VIEWS = ['behind', 'front', 'side'];
await mkdir(out, { recursive: true });
const report = { url: GAME_URL, shots: [], errors: [], consoleErrors: [], status: 'running', visualReview: 'NOT REVIEWED' };
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
});
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 760 });
  page.setDefaultTimeout(120000);
  watchErrors(page, 'headlights', report.errors);
  page.on('console', m => { if (m.type() === 'error' && !m.location().url?.endsWith('/favicon.ico')) report.consoleErrors.push(m.text()); });
  page.on('console', m => { if (m.type() === 'warning' && /lights\.js/.test(m.text())) report.consoleErrors.push(m.text()); });
  await startGame(page, { hold: { ...SPOT, kind: 'car' } });
  await page.waitForFunction(() => game.warmup.done, { timeout: 90000 });
  await page.evaluate(() => {
    const g = game; g.atmosphere.setPreset('night', false); g.setCam(0);
    window.hl = { view: 'behind', enabled: true, renderMs: [], frozen: new WeakSet() };
    const render = g.renderer.render.bind(g.renderer), V = g.camera.position.constructor;
    // Each frame: the shot's camera from the parked vehicle (forward = its +z, left = its +x), then the normal render.
    g.renderer.render = (scene, camera) => {
      const v = g.vehicles.current, m = v.mesh, view = hl.view;
      if (view) {
        const p = m.position.clone(), f = new V(0, 0, 1).applyQuaternion(m.quaternion), l = new V(1, 0, 0).applyQuaternion(m.quaternion);
        f.y = 0; f.normalize(); l.y = 0; l.normalize();
        const ground = g.world.heightAt(p.x, p.z), air = v.kind === 'jet' && v.mode === 'air';
        const lights = g.vehicleLights, mount = m.userData.lightMount || m;
        const lamp = lights.shape ? mount.localToWorld(lights.shape.from.clone()) : p.clone();
        if (view === 'behind') {
          const back = v.kind === 'jet' ? 20 : 9;
          camera.position.copy(p).addScaledVector(f, -back).setY(Math.max(p.y, ground) + (v.kind === 'jet' ? 5 : 2.8));
          camera.lookAt(p.clone().addScaledVector(f, 14).setY(ground + .5));
        } else if (view === 'front') {          // front 3/4, close to the lamps, a little above them
          const r = v.kind === 'jet' ? 5 : 2.8;
          camera.position.copy(lamp).addScaledVector(f, r).addScaledVector(l, r * .6); camera.position.y += .45;
          camera.lookAt(lamp);
        } else {                                // low, off to the right of the pool, looking along it
          camera.position.copy(p).addScaledVector(f, 7).addScaledVector(l, -10).setY(ground + 1.1);
          camera.lookAt(p.clone().addScaledVector(f, 20).setY(ground + .2));
        }
        if (air) camera.position.y = Math.max(camera.position.y, ground + 2);
        camera.updateMatrixWorld();
      }
      // A/B benchmark only: the baseline hides the light (the game never does: off = intensity 0).
      g.vehicleLights.spot.visible = hl.enabled;
      for (const o of m.getObjectsByProperty('name', 'vehicle-lenses')) o.visible = hl.enabled;
      const t0 = performance.now(); render(scene, camera); hl.renderMs.push(performance.now() - t0);
    };
  });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // park one type at the spot, physics frozen, lights on (night)
  async function park(kind, type) {
    const ok = await page.evaluate(({ kind, type, s }) => {
      const g = game; if (!g.vehicles.choose(kind, type)) return false;
      const v = g.vehicles.current; v.reset(s.x, s.z, s.yaw); v.vel.set(0, 0, 0);
      g.keys.clear(); if (!hl.frozen.has(v)) { hl.frozen.add(v); v.step = () => {}; }
      return true;
    }, { kind, type, s: SPOT });
    if (!ok) throw new Error(`could not choose ${kind} ${type}`);
    await page.waitForFunction(() => game.world.pendingTiles() === 0);
    await wait(1500);                           // the beam fades in (lights.js HEADLIGHT_FADE)
  }
  async function shot(kind, type, view, name = `${type}-${view}.png`) {
    await page.evaluate(view => { hl.view = view; }, view); await wait(500);
    await page.screenshot({ path: join(out, name) });
    const state = await page.evaluate(() => {
      const g = game, v = g.vehicles.current, L = g.vehicleLights, m = v.mesh, mount = m.userData.lightMount || m;
      const lit = []; m.traverseVisible(o => { if (/^vehicle-(light|glow)/.test(o.name)) lit.push(o.name.replace('vehicle-', '')); });
      return { kind: v.kind, type: v.type || null, model: m.name, lightsOn: L.on, beam: L.beam, intensity: +L.spot.intensity.toFixed(1),
        angle: L.spot.angle, distance: L.spot.distance, decay: L.spot.decay, color: '#' + L.spot.color.getHexString(),
        beamFrom: mount.localToWorld(L.shape.from.clone()).toArray().map(n => +n.toFixed(2)),
        beamTo: mount.localToWorld(L.shape.to.clone()).toArray().map(n => +n.toFixed(2)),
        lampHeight: L.shape.height && +L.shape.height.toFixed(2), lit: lit.sort(), programs: g.renderer.info.programs.length };
    });
    report.shots.push({ file: name, view, ...state }); console.log(name, JSON.stringify(state));
    const wantBeam = kind !== 'jet' || state.model !== 'jet';      // the fighter has no landing light
    if (wantBeam && !state.beam) throw new Error(`${type}: no beam at night`);
  }
  for (const [kind, type] of TYPES) {
    await park(kind, type);
    for (const view of VIEWS) await shot(kind, type, view);
  }
  // contrast: the hatchback with its lights switched off (L)
  if (!only || only.includes('hatch')) {
    await park('car', 'hatch'); await page.keyboard.press('l'); await wait(1500);
    await shot('car', 'hatch', 'behind', 'hatch-behind-lights-off.png');
    await page.keyboard.press('l');
  }
  // no recompiles: switching through every type again at night adds no shader programs
  report.programs = await page.evaluate(async types => {
    const g = game, count = () => g.renderer.info.programs.length, before = count(), wait = ms => new Promise(r => setTimeout(r, ms));
    for (const [kind, type] of types) { g.vehicles.choose(kind, type); await wait(300); }
    g.atmosphere.setPreset('midday', false); await wait(500); g.atmosphere.setPreset('night', false); await wait(500);
    return { before, after: count() };
  }, TYPES);
  console.log('programs', report.programs);
  if (report.programs.after !== report.programs.before) throw new Error(`new shader programs: ${JSON.stringify(report.programs)}`);
  // McMinnville night A/B/A, chase camera, the hatchback (a mid-height car)
  if (!values['no-bench']) {
    await page.evaluate(() => { game.vehicles.choose('car', 'hatch'); hl.view = null; game.setCam(0); });
    await holdCar(page, { ...SPOT, kind: 'car' });
    report.bench = [];
    for (const enabled of [false, true, false]) {
      await page.evaluate(enabled => { hl.enabled = enabled; }, enabled);
      await wait(3000);                          // hiding / showing a light recompiles once: let it settle first
      const row = await page.evaluate(async enabled => {
        hl.renderMs.length = 0;
        const frames = []; let last = performance.now(); const start = last;
        await new Promise(done => requestAnimationFrame(function tick(now) {
          frames.push(now - last); last = now;
          if (now - start < 20000) requestAnimationFrame(tick); else done();
        }));
        const median = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
        return { enabled, medianMs: median(frames), renderMedianMs: median(hl.renderMs), p95Ms: frames.slice().sort((a, b) => a - b)[Math.floor(frames.length * .95)],
          slowPercent: 100 * frames.filter(t => t > 20).length / frames.length, samples: frames.length,
          calls: game.renderer.info.render.calls, pendingTiles: game.world.pendingTiles() };
      }, enabled);
      report.bench.push(row); console.log('McMinnville night', row);
    }
    const base = (report.bench[0].medianMs + report.bench[2].medianMs) / 2, baseRender = (report.bench[0].renderMedianMs + report.bench[2].renderMedianMs) / 2;
    report.extraMedianMs = +(report.bench[1].medianMs - base).toFixed(3);
    report.extraRenderMs = +(report.bench[1].renderMedianMs - baseRender).toFixed(3);
    console.log('extra median frame ms', report.extraMedianMs, 'extra render ms', report.extraRenderMs);
    if (report.extraMedianMs > 1) throw new Error(`beam + lenses cost ${report.extraMedianMs} ms (limit 1)`);
  }
  if (report.errors.length || report.consoleErrors.length) throw new Error('page errors');
  report.status = 'pass';
} catch (e) {
  report.status = 'fail'; report.failure = e.message; console.error('FAIL', e.message); process.exitCode = 1;
} finally {
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
