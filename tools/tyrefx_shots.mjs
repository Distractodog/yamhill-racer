// Director: serve game/ at YR_URL (default http://127.0.0.1:8173/), then run through the heavy gate:
//   node tools/tyrefx_shots.mjs --out /tmp/yr-tyrefx [--only drift-side,water] [--no-bench]
//   node tools/tyrefx_shots.mjs --sites          (no browser: print the spots, paths and cameras it picked)
// Tyre effects (effects.js) in the real game. Every shot is deterministic: near campus a straight run is found (in
// Node, committed tiles) on asphalt / dirt trail / gravel road / open grass, clear of buildings and trees, also on the
// camera's side; the real car (or bike) and model are placed there and moved along a scripted path (its physics
// step is replaced for the shot: drifting, braking, standing burnout, wheels turning in place; physics code untouched),
// the effects read it like a real drive. A fixed camera aims where the car is at the capture time; then the scene is
// frozen (car and effects clock) and captured.
//   drift-side, drift-behind  asphalt drift (white-grey billowing smoke, dark marks)
//   burnout                   gas + brake standing still (dense smoke behind the rear tyres, rear wheels blurred)
//   dirt, gravel, bike-dirt   a slide on a dirt trail / gravel road (brown / grey dust, flying chips, ruts)
//   grass                     a slide on an open field (green clippings, light dust, light ruts)
//   water, water-rings        across the deepest campus pond (spray arcs, then splash rings)
//   marks                     hard stop then a drift on asphalt, seen from 55 m up (joined marks, darker where braking)
//   blur                      wheels turning at 200 km/h in place, low side view: discs over the rims, no spokes
//   night-behind, night-front the asphalt drift at night with headlights
// Then: shader programs after warm-up vs after every shot (must not grow: no recompiles), and unless --no-bench, 4 cars
// drifting in circles on the asphalt run (the player + 3 more cars through game.effects): the effects' CPU ms a frame
// (update incl. all 4 cars) and their GPU ms (frames alternately drawn with / without the effects, each timed through a
// 1-pixel read-back so the GPU work is inside; median difference). Limit: CPU + GPU <= 1 ms.
// Writes <out>/<shot>.png and <out>/report.json; fails on page errors, a missing effect, new programs or the limit.
// Review the PNGs: the car in frame; soft round puffs (no squares / hard edges / lines where they meet the ground) that
// hang and fade; dust tinted by the ground; tiny chips; continuous soft-edged marks; discs sitting on the wheels.
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { deepestPond } from './lib/water.mjs';
import { GAME_URL, CAMPUS, startGame, holdCar, watchErrors } from './lib/startgame.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' }, only: { type: 'string' }, 'no-bench': { type: 'boolean' }, sites: { type: 'boolean' } } });
const out = values.out || '/tmp/yr-tyrefx', only = values.only?.split(',');

// ---------------------------------------------------------------- sites near campus (Node, committed tiles)
const A = 'game/assets/', WJ = JSON.parse(fs.readFileSync(A + 'world.json')), W = makeWorld(WJ);
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const have = new Set(WJ.tiles.map(([a, b]) => a + ',' + b));
{
  const cx = Math.floor((CAMPUS.x + 1000) / 2000), cz = Math.floor((CAMPUS.z + 1000) / 2000);
  for (let tz = cz - 1; tz <= cz + 1; tz++) for (let tx = cx - 1; tx <= cx + 1; tx++)
    if (have.has(tx + ',' + tz) && !W.has(tx, tz)) W.add(makeTileData(WJ, tx, tz, await readTileData(async f => ab(`${A}tiles/${tx}_${tz}/${f}`), WJ.packed)));
}
const wet = (x, z) => W.waterLevelAt(x, z) > -Infinity;
const gy = (x, z) => Math.max(W.heightAt(x, z), W.waterLevelAt(x, z));
const treeNear = (x, z, r) => { let hit = false; W.treesNear(x, z, r + 6, (tx, tz, tr) => { if (Math.hypot(tx - x, tz - z) < r + tr) hit = true; }); return hit; };
const buildingNear = (x, z, r) => { for (const b of W.buildingsNear(x, z, r + 30)) if (b.pts?.some(([bx, bz]) => Math.hypot(bx - x, bz - z) < r)) return true; return false; };
// the side camera (SIDE m off the run, ~45 m along) is clear: no trunk at it, nothing on its sight lines to the run
const SIDE = 14;
function sideClear(x, z, yaw, len, sgn) {
  const dx = Math.sin(yaw), dz = Math.cos(yaw), lx = dz * sgn, lz = -dx * sgn, p = (s, l) => [x + dx * s + lx * l, z + dz * s + lz * l];
  const [cx, cz] = p(45, SIDE);
  if (!W.loadedAt(cx, cz) || treeNear(cx, cz, 3) || buildingNear(cx, cz, 8)) return false;
  for (const s1 of [35, 45, 55]) for (let k = 1; k < 10; k++) {
    const f = k / 10, [ax, az] = p(45 + (s1 - 45) * f, SIDE + (1.5 - SIDE) * f), ry = gy(...p(s1, 0));
    if (treeNear(ax, az, 1) || buildingNear(ax, az, 4) || gy(ax, az) > ry + 2.5) return false;
  }
  return true;
}
// a straight run of `len` m on surface `cls` (also `half` m to each side), gentle, no trunk within `clear` m, no wall
// within 25 m, a clear camera side: { x, z, yaw, side }. Nearest to campus first.
function findRun(cls, half, clear, len = 110, R = 2400) {
  const ok = (x, z) => W.loadedAt(x, z) && W.surfaceAt(x, z) === cls && !wet(x, z) && W.normalAt(x, z).y > 0.96;
  const cands = [];
  for (let dz = -R; dz <= R; dz += 10) for (let dx = -R; dx <= R; dx += 10) if (dx * dx + dz * dz < R * R) cands.push([dx * dx + dz * dz, CAMPUS.x + dx, CAMPUS.z + dz]);
  cands.sort((a, b) => a[0] - b[0]);
  let fallback = null;
  for (const [, x, z] of cands) {
    if (!ok(x, z)) continue;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
      const sx = Math.sin(a), sz = Math.cos(a);
      let good = true;
      for (let r = 0; r <= len && good; r += 3) {
        const px = x + sx * r, pz = z + sz * r;
        good = ok(px, pz) && ok(px + sz * half, pz - sx * half) && ok(px - sz * half, pz + sx * half);
        if (good && r % 9 === 0) good = !treeNear(px, pz, clear);
        if (good && r % 15 === 0) good = !buildingNear(px, pz, 25);
      }
      if (!good || Math.abs(W.heightAt(x + sx * len, z + sz * len) - W.heightAt(x, z)) > len * 0.06) continue;
      const side = sideClear(x, z, a, len, 1) ? 1 : sideClear(x, z, a, len, -1) ? -1 : 0;
      if (side) return { x, z, yaw: a, side };
      fallback ||= { x, z, yaw: a, side: 0 };              // e.g. a forest trail: the camera rides the run itself
    }
  }
  return fallback;
}
// across the deepest campus pond: from its deepest point the heading with the longest water ahead
function pondRun() {
  const p = deepestPond(W, CAMPUS.x, CAMPUS.z); if (!p) return null;
  let best = null;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 18) {
    let r = 0; while (r < 60 && wet(p.x + Math.sin(a) * r, p.z + Math.cos(a) * r)) r += 1;
    let back = 0; while (back < 15 && wet(p.x - Math.sin(a) * back, p.z - Math.cos(a) * back)) back += 1;
    if (!best || r + Math.min(back, 6) > best.score) best = { score: r + Math.min(back, 6), a, back: Math.min(back, 6), run: r };
  }
  return { x: p.x - Math.sin(best.a) * best.back, z: p.z - Math.cos(best.a) * best.back, yaw: best.a, side: 1, run: best.run + best.back, level: W.waterLevelAt(p.x, p.z) };
}
const SITES = { asphalt: findRun(3, 4, 5), dirt: findRun(2, 2.5, 4), gravel: findRun(4, 3, 4), grass: findRun(0, 14, 14), water: pondRun() };

// ---------------------------------------------------------------- paths (piecewise: speed from v0 to v1 over dur s)
// phase: dur, v0, v1, yawOff (nose off the line of travel), drifting, slip, throttle, brake, handbrake, steer,
// spin (wheel surface speed when standing), water
const SLIDE = (yawOff = 0.55) => [
  { dur: 1.2, v0: 15, v1: 15, throttle: 0.4 },
  { dur: 0.4, v0: 15, v1: 14.6, yawOff, drifting: true, slip: 0.6, throttle: 1, steer: 0.8, handbrake: true },
  { dur: 2.4, v0: 14.6, v1: 12, yawOff, drifting: true, slip: 0.6, throttle: 1, steer: 0.8 }];
const MARKS = [
  { dur: 1.5, v0: 25, v1: 25, throttle: 0.5 },
  { dur: 0.7, v0: 25, v1: 16, brake: 1 },
  { dur: 0.4, v0: 16, v1: 15, yawOff: 0.5, drifting: true, slip: 0.6, throttle: 1, steer: 0.8, handbrake: true },
  { dur: 1.8, v0: 15, v1: 12, yawOff: 0.55, drifting: true, slip: 0.6, throttle: 1, steer: 0.8 },
  { dur: 1.2, v0: 12, v1: 0, brake: 0.3 }];
const BURNOUT = [{ dur: 9, v0: 0, v1: 0, throttle: 1, brake: 1 }];
const SPIN = [{ dur: 9, v0: 0, v1: 0, spin: 200 / 3.6 }];
const SWIM = [{ dur: 9, v0: 14, v1: 9, water: true, throttle: 1 }];
function along(phases, T) {                  // metres travelled after T s
  let s = 0, t = 0;
  for (const p of phases) { const d = Math.min(p.dur, T - t); if (d <= 0) break; s += (p.v0 + (p.v0 + (p.v1 - p.v0) * d / p.dur)) / 2 * d; t += p.dur; }
  return s;
}
// point s m along the run, l m to its camera side, h m above the ground (or water) there
const at = (site, s, l = 0, h = 0) => {
  const dx = Math.sin(site.yaw), dz = Math.cos(site.yaw), x = site.x + dx * s + dz * l * site.side, z = site.z + dz * s - dx * l * site.side;
  return [x, gy(x, z) + h, z];
};
const views = {
  side: (site, s) => site.side ? { pos: at(site, s - 6, SIDE, 3.2), look: at(site, s - 6, 0, 0.9) }
    : { pos: at(site, s - 15, 0, 4.5), look: at(site, s, 0, 0.8) },         // no clear side: from behind, along the run
  behind: (site, s) => ({ pos: at(site, s - 17, 2, 3), look: at(site, s, 0, 0.8) }),
  front: (site, s) => ({ pos: at(site, s + 9, 3.5, 1.6), look: at(site, s - 1, 0, 0.8) }),
  burnout: (site, s) => ({ pos: at(site, s - 7, 4, 2.2), look: at(site, s - 1.5, 0, 0.7) }),
  wheel: (site, s) => ({ pos: at(site, s + 0.4, 4.2, 0.9), look: at(site, s, 0, 0.45) }),
  above: (site, s) => ({ pos: at(site, s, 0, 55), look: at(site, s, 0, 0), up: [Math.cos(site.yaw) * site.side, 0, -Math.sin(site.yaw) * site.side] }),   // the run across the picture
  water: (site, s) => ({ pos: at(site, s - 2, 12, 3.5), look: at(site, s - 1, 0, 0.6) }),
  rings: (site, s) => ({ pos: at(site, s - 2, 10, 9), look: at(site, s * 0.5, 0, 0) }),
};
const shot = (name, site, phases, T, view, want, o = {}) => {
  const s = site && along(phases, T), mid = name === 'marks' ? along(phases, 99) / 2 : s;
  return { name, site, phases, T, want, ...o, cam: site && views[view](site, view === 'above' ? mid : s), view, s };
};
const SHOTS = [
  shot('drift-side', SITES.asphalt, SLIDE(), 4, 'side', s => s.puffs > 30 && s.marks > 20),
  shot('drift-behind', SITES.asphalt, SLIDE(), 4, 'behind', s => s.puffs > 30),
  shot('burnout', SITES.asphalt, BURNOUT, 1.8, 'burnout', s => s.puffs > 50 && s.discs >= 4),
  shot('dirt', SITES.dirt, SLIDE(), 3.6, 'side', s => s.puffs > 15 && s.chips > 10),
  shot('gravel', SITES.gravel, SLIDE(), 3.6, 'side', s => s.puffs > 15 && s.chips > 10),
  shot('bike-dirt', SITES.dirt, SLIDE(0.35), 3.6, 'side', s => s.puffs > 5 && s.chips > 5, { kind: 'bike' }),
  shot('grass', SITES.grass, SLIDE(), 3.6, 'side', s => s.chips > 10),
  shot('water', SITES.water, SWIM, 0.45, 'water', s => s.puffs > 30),
  shot('water-rings', SITES.water, SWIM, 1.4, 'rings', s => s.puffs > 5),
  shot('marks', SITES.asphalt, MARKS, 6.2, 'above', s => s.marks > 60),
  shot('blur', SITES.asphalt, SPIN, 1.5, 'wheel', s => s.discs >= 8),
  shot('night-behind', SITES.asphalt, SLIDE(), 4, 'behind', s => s.puffs > 30, { night: true }),
  shot('night-front', SITES.asphalt, SLIDE(), 4, 'front', s => s.puffs > 30, { night: true }),
].filter(s => !only || only.includes(s.name));
const f1 = a => a.map(v => +v.toFixed(1));
for (const [k, s] of Object.entries(SITES)) console.log(`${k}: ${s ? `${s.x.toFixed(0)}, ${s.z.toFixed(0)} heading ${(s.yaw * 57.3).toFixed(0)}°, camera side ${s.side}` : 'NONE FOUND'}`);
for (const s of SHOTS) console.log(`  ${s.name}: ${s.site ? `car ${s.s.toFixed(1)} m along at ${s.T} s, camera ${f1(s.cam.pos)} → ${f1(s.cam.look)}` : 'no site'}`);
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
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 760 });
  page.setDefaultTimeout(120000);
  watchErrors(page, 'tyrefx', report.errors);
  page.on('console', m => { if (m.type() === 'error' && !m.location().url?.endsWith('/favicon.ico')) report.consoleErrors.push(m.text()); });
  const first = SHOTS.find(s => s.site)?.site || SITES.asphalt || CAMPUS;
  await startGame(page, { hold: { x: first.x, z: first.z, yaw: first.yaw || 0, kind: 'car' } });
  await page.waitForFunction(() => game.warmup.done, { timeout: 90000 });
  await page.evaluate(() => {
    const g = game, V = g.camera.position.constructor, UP = new V(0, 1, 0);
    g.atmosphere.setPreset('midday', false); g.setCam(0);
    window.tfx = { cam: null, freeze: false, fxMs: [], extras: null, probe: false, on: [], off: [], frame: 0 };
    // effects: frozen for a picture; timed (CPU); the extra bench cars driven through the same effects
    const upd = g.effects.update.bind(g.effects), dupd = g.drivingFX.update.bind(g.drivingFX);
    g.effects.update = (dt, car) => {
      if (tfx.freeze) dt = 0;
      const t0 = performance.now();
      if (tfx.extras) for (const e of tfx.extras) {
        const keep = {}; for (const k in e.st) { keep[k] = g.effects[k]; g.effects[k] = e.st[k]; }
        g.effects.drive(dt, e.v); for (const k in e.st) { e.st[k] = g.effects[k]; g.effects[k] = keep[k]; }
      }
      upd(dt, car); tfx.fxMs.push(performance.now() - t0);
    };
    g.drivingFX.update = (dt, car) => dupd(tfx.freeze ? 0 : dt, car);
    // the camera: fixed per shot; the GPU probe: every other frame without the effects, each timed with a read-back
    const render = g.renderer.render.bind(g.renderer), gl = g.renderer.getContext(), px = new Uint8Array(4);
    g.renderer.render = (scene, camera) => {
      if (tfx.cam) { camera.position.fromArray(tfx.cam.pos); camera.up.fromArray(tfx.cam.up || [0, 1, 0]); camera.lookAt(...tfx.cam.look); camera.up.set(0, 1, 0); camera.updateMatrixWorld(); }
      if (!tfx.probe) return render(scene, camera);
      const hide = ++tfx.frame % 2 === 0, objs = g.effects.objects, was = objs.map(o => o.visible);
      if (hide) objs.forEach(o => { o.visible = false; });
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);           // start with the GPU idle
      const t0 = performance.now(); render(scene, camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      (hide ? tfx.off : tfx.on).push(performance.now() - t0);
      if (hide) objs.forEach((o, k) => { o.visible = was[k]; });
    };
    // the scripted path: replaces the vehicle's step (restored after the shot); circle = { cx, cz, r } goes round
    const pose = (v, x, z, heading, yawOff, sp, ph, ride, dt, st) => {
      const W = g.world, level = W.waterLevelAt(x, z), ground = W.heightAt(x, z);
      const y = ph.water && level > -Infinity ? level - 0.15 + ride * 0.3 : ground + ride;
      v.pos.set(x, y, z); v.quat.setFromAxisAngle(UP, heading + (yawOff || 0)); v.ang.set(0, 0, 0);
      v.vel.set(Math.sin(heading) * sp, 0, Math.cos(heading) * sp);
      v.drifting = !!ph.drifting; v.slip = ph.slip || 0; v.latAcc = ph.drifting ? 20 : 0; v.lonAcc = dt ? (sp - st.lastSp) / dt : 0; st.lastSp = sp;
      v.onWater = !!ph.water; v.waterDepth = ph.water ? 0.25 : 0; v.grounded = true; v.airTime = 0;
      v.mesh.position.copy(v.pos); v.mesh.quaternion.copy(v.quat); v.mesh.updateMatrixWorld(true);
      v.wheels.forEach((wh, i) => {
        const h = v.mesh.userData.wheels?.[i]?.holder;
        if (h) h.getWorldPosition(wh.contactPoint); else wh.contactPoint.copy(v.pos);
        wh.contactPoint.y = ph.water && level > -Infinity ? level : W.heightAt(wh.contactPoint.x, wh.contactPoint.z);
        wh.contact = true; wh.surf = ph.water ? 5 : W.surfaceAt(wh.contactPoint.x, wh.contactPoint.z);
        wh.spin += (ph.spin ?? sp) * dt / 0.36;
      });
    };
    window.tfxPath = (spec, ride) => {
      const v = g.vehicles.current, st = { t: 0, s: 0, lastSp: 0 }; v._realStep = v.step;
      const dx = Math.sin(spec.yaw), dz = Math.cos(spec.yaw);
      v.step = function (dt, input) {
        if (tfx.freeze) dt = 0;
        st.t += dt;
        let t = st.t, ph = spec.phases[spec.phases.length - 1], f = 1;
        for (const p of spec.phases) { if (t <= p.dur) { ph = p; f = t / p.dur; break; } t -= p.dur; }
        const sp = ph.v0 + (ph.v1 - ph.v0) * f;
        st.s += sp * dt;
        input.throttle = ph.throttle || 0; input.brake = ph.brake || 0; input.handbrake = !!ph.handbrake; input.steer = ph.steer || 0;
        if (spec.circle) {
          const a = st.s / spec.circle.r;
          pose(this, spec.circle.cx + Math.cos(a) * spec.circle.r, spec.circle.cz - Math.sin(a) * spec.circle.r, Math.atan2(-Math.sin(a), -Math.cos(a)), ph.yawOff, sp, ph, ride, dt, st);
        } else pose(this, spec.x + dx * st.s, spec.z + dz * st.s, spec.yaw, ph.yawOff, sp, ph, ride, dt, st);
      };
      return st;
    };
  });
  report.programsAfterWarmup = await page.evaluate(() => game.renderer.info.programs.length);

  for (const s of SHOTS) {
    if (!s.site) { report.shots.push({ name: s.name, skipped: 'no site found' }); report.missing = [...(report.missing || []), s.name]; console.log(s.name, 'SKIPPED: no site'); continue; }
    await page.evaluate(n => { game.atmosphere.setPreset(n ? 'night' : 'midday', false); game.keys.clear(); tfx.cam = null; tfx.freeze = false; game.effects.wasWet = false; }, !!s.night);
    await holdCar(page, { x: s.site.x, z: s.site.z, yaw: s.site.yaw, kind: s.kind || 'car' });
    await page.waitForFunction(() => game.world.pendingTiles() === 0);
    await page.evaluate(cam => { tfx.cam = cam; }, s.cam);
    await wait(s.night ? 1500 : 400);                         // settle on the ground; headlights fade in at night
    const state = await page.evaluate(async (spec, T) => {
      const v = game.vehicles.current, ride = v.pos.y - game.world.heightAt(v.pos.x, v.pos.z);
      const st = tfxPath(spec, Math.max(0.2, Math.min(1.5, ride)));
      const t0 = performance.now();
      while (st.t < T && performance.now() - t0 < 60000) await new Promise(r => setTimeout(r, 16));
      tfx.freeze = true;                                     // car and effects stand still for the picture
      await new Promise(r => setTimeout(r, 250));
      return { t: +st.t.toFixed(2), along: +st.s.toFixed(1), kmh: Math.round(v.vel.length() * 3.6), drifting: v.drifting, ride: +ride.toFixed(2) };
    }, { x: s.site.x, z: s.site.z, yaw: s.site.yaw, phases: s.phases }, s.T);
    await page.screenshot({ path: join(out, `${s.name}.png`) });
    const st = await page.evaluate(() => ({ ...game.effects.stats(), programs: game.renderer.info.programs.length, night: game.atmosphere.night }));
    await page.evaluate(() => { tfx.freeze = false; tfx.cam = null; const v = game.vehicles.current; if (v._realStep) { v.step = v._realStep; delete v._realStep; } game.keys.clear(); });
    const row = { name: s.name, view: s.view, expectedAlong: +s.s.toFixed(1), ...state, ...st, ok: s.want(st) };
    report.shots.push(row); console.log(`${s.name}.png`, JSON.stringify(row));
    if (!row.ok) report.missing = [...(report.missing || []), s.name];
  }
  report.programsAfterShots = await page.evaluate(() => game.renderer.info.programs.length);
  console.log('shader programs: after warm-up', report.programsAfterWarmup, '→ after all shots', report.programsAfterShots);

  // 4 cars drifting in circles on the asphalt run: the effects' CPU and GPU cost a frame
  if (!values['no-bench'] && SITES.asphalt) {
    const site = SITES.asphalt, centre = k => at(site, 20 + 25 * k, 0, 0);
    const circles = [0, 1, 2, 3].map(k => ({ cx: centre(k)[0], cz: centre(k)[2], r: 6 }));
    await page.evaluate(() => { game.atmosphere.setPreset('midday', false); tfx.cam = null; tfx.freeze = false; });
    await holdCar(page, { x: site.x, z: site.z, yaw: site.yaw, kind: 'car' });
    await page.waitForFunction(() => game.world.pendingTiles() === 0);
    await page.evaluate(cam => { tfx.cam = cam; }, { pos: at(site, 57, 30, 10), look: at(site, 57, 0, 0.5) });
    const DRIFT = [{ dur: 99, v0: 12, v1: 12, yawOff: 0.6, drifting: true, slip: 0.6, throttle: 1, steer: 0.8 }];
    report.bench = await page.evaluate(async (circles, phases) => {
      const g = game, { Car, TUNING_DEFAULTS } = await import('./src/car.js'), { Effects } = await import('./src/effects.js');
      const v0 = g.vehicles.current, ride = Math.max(0.2, Math.min(1.5, v0.pos.y - g.world.heightAt(v0.pos.x, v0.pos.z)));
      tfxPath({ circle: circles[0], phases, x: 0, z: 0, yaw: 0 }, ride);          // the player's car
      // three more cars, each round its own circle, posed here every frame and driven through game.effects
      const UP = new v0.pos.constructor(0, 1, 0), W = g.world;
      tfx.extras = circles.slice(1).map(c => {
        const v = new Car(W, { ...TUNING_DEFAULTS }); g.scene.add(v.mesh); v.reset(c.cx, c.cz, 0);
        v.input = { throttle: 1, brake: 0, handbrake: false, steer: 0.8 };
        return { v, c, s: 0, st: Effects.vehicleState() };
      });
      const go = (e, dt) => {
        e.s += 12 * dt; const v = e.v, a = e.s / e.c.r, x = e.c.cx + Math.cos(a) * e.c.r, z = e.c.cz - Math.sin(a) * e.c.r;
        const heading = Math.atan2(-Math.sin(a), -Math.cos(a));                  // along the circle (fx = sin, fz = cos)
        v.savePrev(); v.pos.set(x, W.heightAt(x, z) + ride, z); v.quat.setFromAxisAngle(UP, heading + 0.6);
        v.vel.set(Math.sin(heading) * 12, 0, Math.cos(heading) * 12); v.drifting = true; v.slip = 0.6; v.latAcc = 20; v.lonAcc = 0;
        v.mesh.position.copy(v.pos); v.mesh.quaternion.copy(v.quat); v.mesh.updateMatrixWorld(true);
        v.wheels.forEach((wh, i) => {
          v.mesh.userData.wheels[i].holder.getWorldPosition(wh.contactPoint); wh.contactPoint.y = W.heightAt(wh.contactPoint.x, wh.contactPoint.z);
          wh.contact = true; wh.surf = W.surfaceAt(wh.contactPoint.x, wh.contactPoint.z); wh.spin += 12 * dt / 0.36;
        });
        v.interpolate(1); v.syncMesh(dt); v.mesh.updateMatrixWorld(true);
      };
      let last = performance.now();
      (function step(now) { const dt = Math.min(0.1, (now - last) / 1000); last = now; for (const e of tfx.extras) go(e, dt); requestAnimationFrame(step); })(last);
      await new Promise(r => setTimeout(r, 4000));             // the smoke builds up to its steady amount
      tfx.fxMs.length = 0; tfx.on.length = 0; tfx.off.length = 0; tfx.probe = true;
      await new Promise(r => setTimeout(r, 10000));
      tfx.probe = false;
      const q = (a, f) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length * f)] : NaN;
      const st = g.effects.stats();
      return { cpuMedianMs: q(tfx.fxMs, 0.5), cpuP95Ms: q(tfx.fxMs, 0.95), renderWithFxMs: q(tfx.on, 0.5), renderWithoutFxMs: q(tfx.off, 0.5),
        gpuMs: q(tfx.on, 0.5) - q(tfx.off, 0.5), frames: tfx.on.length + tfx.off.length, puffs: st.puffs, chips: st.chips, marks: st.marks };
    }, circles, DRIFT);
    await page.screenshot({ path: join(out, 'bench-4cars.png') });
    report.bench.totalMs = +(Math.max(0, report.bench.gpuMs) + report.bench.cpuMedianMs).toFixed(3);
    console.log('4 cars drifting:', JSON.stringify(report.bench));
    if (!(report.bench.totalMs <= 1)) throw new Error(`effects cost ${report.bench.totalMs} ms a frame with 4 cars drifting (CPU ${report.bench.cpuMedianMs?.toFixed(3)} + GPU ${report.bench.gpuMs?.toFixed(3)}; limit 1)`);
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
