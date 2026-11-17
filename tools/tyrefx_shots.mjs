// Director: serve game/ at YR_URL (default http://127.0.0.1:8173/), then run through the heavy gate:
//   node tools/tyrefx_shots.mjs --out /tmp/yr-tyrefx [--only drift-side,water] [--no-bench]
//   node tools/tyrefx_shots.mjs --sites          (no browser: print the dirt / gravel / grass / pond spots it picked)
// Tyre effects (effects.js) in the real game, driven with the real keys (game.keys), camera placed per shot:
//   drift-side, drift-behind  asphalt drift on a straight McMinnville road (white-grey billowing smoke, dark marks)
//   burnout                   W + S held standing still (dense smoke behind the rear tyres, rear wheels blurred)
//   dirt, gravel, bike-dirt   a slide on a dirt trail / gravel road near campus (brown / grey dust, flying chips, ruts)
//   grass                     a slide on an open field (green clippings, light dust, flattened-grass ruts)
//   water, water-rings        into the deepest campus pond at speed (spray arcs, then splash rings)
//   marks                     hard stop + drift on asphalt, seen from 45 m up (joined marks, darker where braking)
//   blur                      wheels turning at 200 km/h (the car's step replaced by a steady 200 km/h roll in
//                             place; physics code untouched), low side view: discs over the rims, no spokes
//   night-behind, night-front the drift at night with headlights (smoke dim, lit where it drifts into the beams)
// Then: shader programs after warm-up vs after every shot (must not grow: no recompiles) and, unless --no-bench, an
// A/B/A at the road spot with 4 cars doing donuts (the player + 3 extra cars driven through game.effects): effects
// update ms (median / p95) and frame ms with the 3 extras' effects off / on / off (the extra median must be <= 1 ms).
// Writes <out>/<shot>.png and <out>/report.json; fails on page errors, a missing effect or the limits. Review the PNGs:
// soft round puffs (no squares / hard edges / lines where they meet the ground), smoke hangs and fades, dust tinted
// by the ground, chips tiny, marks continuous and soft-edged, discs sit on the wheels.
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { deepestPond, approach } from './lib/water.mjs';
import { GAME_URL, CAMPUS, startGame, holdCar, watchErrors } from './lib/startgame.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' }, only: { type: 'string' }, 'no-bench': { type: 'boolean' }, sites: { type: 'boolean' } } });
const out = values.out || '/tmp/yr-tyrefx', only = values.only?.split(',');
const ROAD = { x: 19451, z: -11032, yaw: -1.573 };             // a straight McMinnville road (tools/lights_shots.mjs)

// ---------------------------------------------------------------- sites near campus (Node, committed tiles)
const A = 'game/assets/', WJ = JSON.parse(fs.readFileSync(A + 'world.json')), W = makeWorld(WJ);
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const have = new Set(WJ.tiles.map(([a, b]) => a + ',' + b));
{
  const cx = Math.floor((CAMPUS.x + 1000) / 2000), cz = Math.floor((CAMPUS.z + 1000) / 2000);
  for (let tz = cz - 1; tz <= cz + 1; tz++) for (let tx = cx - 1; tx <= cx + 1; tx++)
    if (have.has(tx + ',' + tz) && !W.has(tx, tz)) W.add(makeTileData(WJ, tx, tz, await readTileData(async f => ab(`${A}tiles/${tx}_${tz}/${f}`), WJ.packed)));
}
// a straight run of `len` m on surface `cls` (also `half` m to each side), gentle, no trunk within `clear` m:
// 60 m to speed up, the rest to slide. Nearest to campus first.
function findRun(cls, half, clear, len = 110, R = 1400) {
  const ok = (x, z) => W.loadedAt(x, z) && W.surfaceAt(x, z) === cls && W.waterLevelAt(x, z) === -Infinity && W.normalAt(x, z).y > 0.96;
  const cands = [];
  for (let dz = -R; dz <= R; dz += 10) for (let dx = -R; dx <= R; dx += 10) if (dx * dx + dz * dz < R * R) cands.push([dx * dx + dz * dz, CAMPUS.x + dx, CAMPUS.z + dz]);
  cands.sort((a, b) => a[0] - b[0]);
  for (const [, x, z] of cands) {
    if (!ok(x, z)) continue;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
      const sx = Math.sin(a), sz = Math.cos(a);
      let good = true;
      for (let r = 0; r <= len && good; r += 3) {
        const px = x + sx * r, pz = z + sz * r;
        good = ok(px, pz) && ok(px + sz * half, pz - sx * half) && ok(px - sz * half, pz + sx * half);
        if (good && r % 9 === 0) W.treesNear(px, pz, clear + 6, (tx, tz, tr) => { if (Math.hypot(tx - px, tz - pz) < clear + tr) good = false; });
        if (good && r % 15 === 0) for (const b of W.buildingsNear(px, pz, 30)) if (b.pts?.some(([bx, bz]) => Math.hypot(bx - px, bz - pz) < 25)) { good = false; break; }
      }
      if (good && Math.abs(W.heightAt(x + sx * len, z + sz * len) - W.heightAt(x, z)) < len * 0.06) return { x, z, yaw: a };
    }
  }
  return null;
}
const SITES = { dirt: findRun(2, 2.5, 4), gravel: findRun(4, 3, 4), grass: findRun(0, 14, 14) };
const pond = deepestPond(W, CAMPUS.x, CAMPUS.z), ap = pond && approach(W, [pond.x, pond.z]);
SITES.water = ap && { x: ap.x, z: ap.z, yaw: ap.yaw };
for (const [k, s] of Object.entries(SITES)) console.log(`${k}: ${s ? `${s.x.toFixed(0)}, ${s.z.toFixed(0)} heading ${(s.yaw * 57.3).toFixed(0)}°` : 'NONE FOUND'}`);
if (values.sites) process.exit(Object.values(SITES).every(Boolean) ? 0 : 1);

// ---------------------------------------------------------------- browser
const { default: puppeteer } = await import('puppeteer-core');
await mkdir(out, { recursive: true });
const report = { url: GAME_URL, sites: SITES, shots: [], errors: [], consoleErrors: [], status: 'running', visualReview: 'NOT REVIEWED' };
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
});
const wait = ms => new Promise(r => setTimeout(r, ms));
const DRIFT = [[3200, ['KeyW']], [450, ['KeyW', 'KeyD', 'Space']], [550, ['KeyW', 'KeyD']]];
const SLIDE = [[3000, ['KeyW']], [450, ['KeyW', 'KeyD', 'Space']], [450, ['KeyW', 'KeyD']]];
// name: where, vehicle, look, keys ([ms, codes] in turn; the last stay held for the picture), camera view, checks
const SHOTS = [
  { name: 'drift-side', at: ROAD, seq: DRIFT, view: 'side', want: s => s.puffs > 40 && s.marks > 20 },
  { name: 'drift-behind', at: ROAD, seq: DRIFT, view: 'behind', want: s => s.puffs > 40 },
  { name: 'burnout', at: ROAD, seq: [[1700, ['KeyW', 'KeyS']]], view: 'burnout', want: s => s.puffs > 80 && s.discs >= 4 },
  { name: 'dirt', at: SITES.dirt, seq: SLIDE, view: 'side', want: s => s.puffs > 20 && s.chips > 10 },
  { name: 'gravel', at: SITES.gravel, seq: SLIDE, view: 'side', want: s => s.puffs > 20 && s.chips > 10 },
  { name: 'bike-dirt', at: SITES.dirt, kind: 'bike', seq: SLIDE, view: 'side', want: s => s.puffs > 5 && s.chips > 5 },
  { name: 'grass', at: SITES.grass, seq: SLIDE, view: 'side', want: s => s.chips > 10 },
  { name: 'water', at: SITES.water, seq: [[9000, ['KeyW']]], untilWet: 350, view: 'side', want: s => s.puffs > 30 },
  { name: 'water-rings', at: SITES.water, seq: [[9000, ['KeyW']]], untilWet: 1100, view: 'behind', want: s => s.puffs > 5 },
  { name: 'marks', at: ROAD, seq: [[3000, ['KeyW']], [800, ['KeyS']], [400, ['KeyW']], [1400, ['KeyW', 'KeyD', 'Space']], [900, []]], view: 'above', want: s => s.marks > 60 },
  { name: 'blur', at: ROAD, roll: 200 / 3.6, seq: [[1500, []]], view: 'wheel', want: s => s.discs >= 8 },
  { name: 'night-behind', at: ROAD, night: true, seq: DRIFT, view: 'behind', want: s => s.puffs > 40 },
  { name: 'night-front', at: ROAD, night: true, seq: DRIFT, view: 'front', want: s => s.puffs > 40 },
].filter(s => !only || only.includes(s.name));
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 760 });
  page.setDefaultTimeout(120000);
  watchErrors(page, 'tyrefx', report.errors);
  page.on('console', m => { if (m.type() === 'error' && !m.location().url?.endsWith('/favicon.ico')) report.consoleErrors.push(m.text()); });
  await startGame(page, { hold: { ...ROAD, kind: 'car' } });
  await page.waitForFunction(() => game.warmup.done, { timeout: 90000 });
  await page.evaluate(() => {
    const g = game; g.atmosphere.setPreset('midday', false); g.setCam(0);
    window.tfx = { view: null, fxMs: [], frameMs: [], extras: null, extrasFx: true };
    // effects cost: effects.update + drivingFX.update (+ the extra cars' drive when the bench runs)
    const upd = g.effects.update.bind(g.effects), dupd = g.drivingFX.update.bind(g.drivingFX);
    g.effects.update = (dt, car) => {
      const t0 = performance.now();
      if (tfx.extras && tfx.extrasFx) for (const e of tfx.extras) {          // other cars: their own state swapped in
        const keep = {}; for (const k in e.st) { keep[k] = g.effects[k]; g.effects[k] = e.st[k]; }
        g.effects.drive(dt, e.v); for (const k in e.st) { e.st[k] = g.effects[k]; g.effects[k] = keep[k]; }
      }
      upd(dt, car); tfx.fxMs.push(performance.now() - t0);
    };
    g.drivingFX.update = (dt, car) => { const t0 = performance.now(); dupd(dt, car); tfx.fxMs[tfx.fxMs.length - 1] += performance.now() - t0; };
    const render = g.renderer.render.bind(g.renderer), V = g.camera.position.constructor;
    g.renderer.render = (scene, camera) => {
      const v = g.vehicles.current, view = tfx.view;
      if (view) {
        const p = v.renderPos.clone(), f = new V(0, 0, 1).applyQuaternion(v.renderQuat); f.y = 0; f.normalize();
        const tr = v.vel.clone(); tr.y = 0; if (tr.lengthSq() < 4) tr.copy(f); tr.normalize();
        const l = new V(tr.z, 0, -tr.x), lf = new V(f.z, 0, -f.x), h = g.world.heightAt(p.x, p.z), look = p.clone();
        if (view === 'side') { camera.position.copy(p).addScaledVector(l, -13).addScaledVector(tr, -4).setY(h + 3.5); look.addScaledVector(tr, -3).setY(h + 0.8); }
        else if (view === 'behind') { camera.position.copy(p).addScaledVector(tr, -11).setY(h + 3.2); look.addScaledVector(tr, 4).setY(h + 0.6); }
        else if (view === 'burnout') { camera.position.copy(p).addScaledVector(f, -7).addScaledVector(lf, 4).setY(h + 2.2); look.addScaledVector(f, -1.5).setY(h + 0.7); }
        else if (view === 'above') { camera.position.copy(p).addScaledVector(tr, -16).addScaledVector(l, 0.5).setY(h + 45); look.addScaledVector(tr, -15).setY(h); }
        else if (view === 'wheel') { camera.position.copy(p).addScaledVector(lf, -4.2).addScaledVector(f, 0.4).setY(h + 0.9); look.setY(h + 0.45); }
        else if (view === 'front') { camera.position.copy(p).addScaledVector(f, 7).addScaledVector(lf, 5).setY(h + 1.8); look.addScaledVector(f, -2).setY(h + 0.8); }
        camera.lookAt(look); camera.updateMatrixWorld();
      }
      render(scene, camera);
    };
    let last = performance.now();
    requestAnimationFrame(function tick(now) { tfx.frameMs.push(now - last); last = now; requestAnimationFrame(tick); });
  });
  report.programsAfterWarmup = await page.evaluate(() => game.renderer.info.programs.length);

  for (const s of SHOTS) {
    if (!s.at) { report.shots.push({ name: s.name, skipped: 'no site found' }); console.log(s.name, 'SKIPPED: no site'); continue; }
    await page.evaluate(n => { game.atmosphere.setPreset(n ? 'night' : 'midday', false); game.keys.clear(); tfx.view = null; }, !!s.night);
    await holdCar(page, { x: s.at.x, z: s.at.z, yaw: s.at.yaw, kind: s.kind || 'car' });
    await page.waitForFunction(() => game.world.pendingTiles() === 0);
    await wait(s.night ? 1500 : 300);                         // headlights fade in at night
    if (s.roll) await page.evaluate(speed => {               // wheels turning at `speed` m/s in place: the blur alone
      const v = game.vehicles.current, F = v.vel.constructor; v._realStep = v.step;
      v.step = function (dt) { const f = new F(0, 0, 1).applyQuaternion(this.quat); f.y = 0; f.normalize(); this.vel.copy(f).multiplyScalar(speed); for (const w of this.wheels) w.spin += speed * dt / 0.36; };
    }, s.roll);
    const state = await page.evaluate(async (seq, untilWet) => {
      const g = game, sleep = ms => new Promise(r => setTimeout(r, ms)), v = g.vehicles.current;
      let wetAt = null;
      for (const [ms, keys] of seq) {
        g.keys.clear(); for (const k of keys) g.keys.add(k);
        const end = performance.now() + ms;
        while (performance.now() < end) {
          await sleep(50);
          if (untilWet && wetAt === null && (v.onWater || v.waterDepth > 0)) wetAt = performance.now();
          if (wetAt !== null && performance.now() - wetAt > untilWet) break;
        }
        if (wetAt !== null) break;
      }
      return { wet: wetAt !== null, kmh: Math.round(v.vel.length() * 3.6), drifting: !!v.drifting, slip: +(v.slip || 0).toFixed(2) };
    }, s.seq, s.untilWet || 0);
    await page.evaluate(view => { tfx.view = view; }, s.view); await wait(120);
    await page.screenshot({ path: join(out, `${s.name}.png`) });
    const st = await page.evaluate(() => ({ ...game.effects.stats(), programs: game.renderer.info.programs.length, night: game.atmosphere.night }));
    await page.evaluate(() => { game.keys.clear(); const v = game.vehicles.current; if (v._realStep) { v.step = v._realStep; delete v._realStep; } });
    const row = { name: s.name, view: s.view, ...state, ...st, ok: s.want(st) && (!s.untilWet || state.wet) };
    report.shots.push(row); console.log(`${s.name}.png`, JSON.stringify(row));
    if (!row.ok) report.missing = [...(report.missing || []), s.name];
  }
  report.programsAfterShots = await page.evaluate(() => game.renderer.info.programs.length);
  console.log('shader programs: after warm-up', report.programsAfterWarmup, '→ after all shots', report.programsAfterShots);

  // 4 cars doing donuts at the road spot: effects cost and frame time, the 3 extras' effects off / on / off
  if (!values['no-bench']) {
    await page.evaluate(() => { game.atmosphere.setPreset('midday', false); tfx.view = null; game.setCam(0); });
    await holdCar(page, { ...ROAD, kind: 'car' });
    await page.evaluate(async yaw => {
      const g = game, { Car, TUNING_DEFAULTS } = await import('./src/car.js'), { Effects } = await import('./src/effects.js');
      const p = g.vehicles.current.pos;
      tfx.extras = [1, 2, 3].map(k => {
        const v = new Car(g.world, { ...TUNING_DEFAULTS }); g.scene.add(v.mesh);
        v.reset(p.x + Math.sin(yaw) * 22 * k, p.z + Math.cos(yaw) * 22 * k, yaw); v.input = { throttle: 1, brake: 0, steer: 1, handbrake: false };
        return { v, st: Effects.vehicleState() };
      });
      let acc = 0, last = performance.now();
      (function step(now) {                                   // the extras' own physics (not counted as effects)
        const dt = Math.min(0.1, (now - last) / 1000); last = now; acc += dt;
        for (const { v } of tfx.extras) v.input.handbrake = v.vel.length() > 13 && !v.drifting;
        while (acc >= 1 / 120) { for (const { v } of tfx.extras) { v.savePrev(); v.step(1 / 120, v.input); } acc -= 1 / 120; }
        for (const { v } of tfx.extras) { v.interpolate(1); v.syncMesh(dt); v.mesh.updateMatrixWorld(true); }
        requestAnimationFrame(step);
      })(last);
    }, ROAD.yaw);
    report.bench = [];
    for (const on of [false, true, false]) {
      const row = await page.evaluate(async on => {
        tfx.extrasFx = on; game.keys.clear(); ['KeyW', 'KeyD'].forEach(k => game.keys.add(k));
        await new Promise(r => setTimeout(r, 2500));
        tfx.fxMs.length = 0; tfx.frameMs.length = 0;
        const t0 = performance.now(), v = game.vehicles.current;
        while (performance.now() - t0 < 12000) {               // the player's donut: handbrake taps keep it sliding
          if (v.vel.length() > 13 && !v.drifting) game.keys.add('Space'); else game.keys.delete('Space');
          await new Promise(r => setTimeout(r, 100));
        }
        const q = (a, f) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * f)];
        return { extrasFx: on, fxMedianMs: q(tfx.fxMs, 0.5), fxP95Ms: q(tfx.fxMs, 0.95), frameMedianMs: q(tfx.frameMs, 0.5), frameP95Ms: q(tfx.frameMs, 0.95),
          puffs: game.effects.stats().puffs, chips: game.effects.stats().chips, samples: tfx.frameMs.length };
      }, on);
      report.bench.push(row); console.log('4 cars donuts', JSON.stringify(row));
    }
    const base = (report.bench[0].frameMedianMs + report.bench[2].frameMedianMs) / 2;
    report.extraFrameMedianMs = +(report.bench[1].frameMedianMs - base).toFixed(3);
    report.fxMedianMs4Cars = +report.bench[1].fxMedianMs.toFixed(3);
    console.log('4 cars: effects update', report.fxMedianMs4Cars, 'ms median; 3 extras\' effects add', report.extraFrameMedianMs, 'ms to the median frame');
    if (report.fxMedianMs4Cars > 1) throw new Error(`effects update ${report.fxMedianMs4Cars} ms with 4 cars (limit 1)`);
    if (report.extraFrameMedianMs > 1) throw new Error(`3 more cars' effects cost ${report.extraFrameMedianMs} ms a frame (limit 1)`);
  }
  if (report.programsAfterShots !== report.programsAfterWarmup) throw new Error(`new shader programs during the shots: ${report.programsAfterWarmup} → ${report.programsAfterShots}`);
  if (report.missing?.length) throw new Error(`effect missing in: ${report.missing.join(', ')}`);
  if (report.errors.length || report.consoleErrors.length) throw new Error('page errors');
  report.status = 'pass';
} catch (e) {
  report.status = 'fail'; report.failure = e.message; console.error('FAIL', e.message); process.exitCode = 1;
} finally {
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
