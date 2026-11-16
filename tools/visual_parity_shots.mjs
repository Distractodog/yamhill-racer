// Before / after screenshots from the same spots and cameras, to show a lag change draws the same picture.
//   python3 tools/serve.py 8173 game                     (this branch)
//   python3 tools/serve.py 8174 <checkout of the old code>/game   (another terminal)
//   node tools/visual_parity_shots.mjs --out <dir> [--before http://127.0.0.1:8174/] [--only words] [--tolerance %]
// Each shot: an atmosphere preset; the car driven along a road at 150 km/h (McMinnville NE 3rd St, a forest gravel
// track) or the fighter flown straight at 600 km/h 150 m / 800 m above the forest or McMinnville. The vehicle is moved
// along its path inside its own physics step (camera, streaming, LOD, shadows run as in play), stops at the end, and
// the game's camera there is held still (position, orientation, field of view, set before world.updateLOD so the
// streaming and fog decisions see the same camera that draws) with the wind / water / scenery clock fixed. When no
// tile or road level is left to build, the HUD is hidden and the picture taken. With --before the same is done on the
// old code, and each pair is compared in the browser: % of pixels differing (any channel > 8 of 255), the largest
// difference, and <name>.diff.png (red = differs). The dusk / misty-morning shots have the closest fog.
// Also per shot (after): far tree chunks left out as the fog hides them (fogcull.js), road near levels built at once
// (roadnear.js) and frames on the way in drawn with a road block's near level missing within its drawing distance.
// Fails on page errors, late road levels, a flight / drive that did not complete, and pairs differing in more than
// --tolerance % of pixels (default 0.05). A heavy run: use the gate.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startGame, watchErrors, GAME_URL } from './lib/startgame.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out'), BEFORE = arg('--before'), TOL = +arg('--tolerance', 0.05);
if (!OUT) { console.log('usage: node tools/visual_parity_shots.mjs --out <dir> [--before <url>] [--only words] [--tolerance %]'); process.exit(2); }

// paths: [x, z] points (metres), flown / driven at kmh; alt: m above the ground (null: on the road)
const MCM_ROAD = [[19661, -11032], [19451, -11032]];                       // McMinnville NE 3rd St, westbound (tools/bench.mjs)
const FOREST_ROAD = [[-397, -20252], [-356, -20250], [-315, -20244], [-275, -20239], [-234, -20234], [-193, -20231], [-153, -20226],
  [-113, -20221], [-72, -20215], [-32, -20209], [9, -20212]];               // a gravel track in the north woods (tile 0_-10)
const FOREST_AIR = [[-1800, -20000], [-500, -20000]], MCM_AIR = [[20400, -11000], [19100, -11000]];
const SHOTS = [
  { name: 'mcminnville-ground-150-midday', kind: 'car', pts: MCM_ROAD, kmh: 150, alt: null, preset: 'midday' },
  { name: 'forest-road-150-midday', kind: 'car', pts: FOREST_ROAD, kmh: 150, alt: null, preset: 'midday' },
  { name: 'forest-air-150m-midday', kind: 'jet', pts: FOREST_AIR, kmh: 600, alt: 150, preset: 'midday' },
  { name: 'forest-air-800m-midday', kind: 'jet', pts: FOREST_AIR, kmh: 600, alt: 800, preset: 'midday' },
  { name: 'mcminnville-air-150m-midday', kind: 'jet', pts: MCM_AIR, kmh: 600, alt: 150, preset: 'midday' },
  { name: 'mcminnville-air-800m-midday', kind: 'jet', pts: MCM_AIR, kmh: 600, alt: 800, preset: 'midday' },
  { name: 'mcminnville-ground-150-dusk', kind: 'car', pts: MCM_ROAD, kmh: 150, alt: null, preset: 'dusk' },
  { name: 'forest-road-150-dusk', kind: 'car', pts: FOREST_ROAD, kmh: 150, alt: null, preset: 'dusk' },
  { name: 'forest-air-150m-dusk', kind: 'jet', pts: FOREST_AIR, kmh: 600, alt: 150, preset: 'dusk' },
  { name: 'forest-air-800m-dusk', kind: 'jet', pts: FOREST_AIR, kmh: 600, alt: 800, preset: 'dusk' },
  { name: 'mcminnville-air-800m-dusk', kind: 'jet', pts: MCM_AIR, kmh: 600, alt: 800, preset: 'dusk' },
  { name: 'forest-air-800m-morning', kind: 'jet', pts: FOREST_AIR, kmh: 600, alt: 800, preset: 'morning' },
];
const only = arg('--only')?.split(',').map(w => w.trim()).filter(Boolean) || null;
const LIST = SHOTS.filter(s => !only || only.every(w => s.name.includes(w)));
if (!LIST.length) { console.log(`FAIL --only ${only.join(',')}: no shot matches. Shots:\n  ${SHOTS.map(s => s.name).join('\n  ')}`); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

// ---- in the page: drive / fly the path, hold the camera at its end, wait until nothing is left to build
async function approach(spec) {
  const g = game, sleep = ms => new Promise(r => setTimeout(r, ms));
  g.atmosphere.setPreset(spec.preset, false);
  g.vehicles.switchTo(spec.kind);
  if (spec.kind === 'jet' && g.vehicles.getType?.('jet') !== 'fighter') g.vehicles.setType('jet', 'fighter');
  const v = g.vehicles.current, step = v.step, Q = v.quat.constructor, yq = new Q(), up = { x: 0, y: 1, z: 0 };
  // the path: distance along the polyline → point and heading (forward = (sin yaw, cos yaw))
  const P = spec.pts, cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const len = cum.at(-1), V = spec.kmh / 3.6, duration = len / V;
  const at = d => {
    let i = 1; while (i < P.length - 1 && cum[i] < d) i++;
    const a = P[i - 1], b = P[i], f = Math.max(0, Math.min(1, (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)));
    return { x: a[0] + (b[0] - a[0]) * f, z: a[1] + (b[1] - a[1]) * f, yaw: Math.atan2(b[0] - a[0], b[1] - a[1]) };
  };
  let t = 0, run = false, moving = true, ride = 0.5;
  const put = () => {
    const s = at(Math.min(len, V * t)), fx = Math.sin(s.yaw) * (moving ? V : 0), fz = Math.cos(s.yaw) * (moving ? V : 0);
    const y = g.world.heightAt(s.x, s.z) + (spec.alt ?? ride);
    if (spec.kind === 'jet') { v.mode = 'air'; v.agl = spec.alt; v.throttle = 1; v.gear = 0; }
    v.pos.set(s.x, y, s.z); v.vel.set(fx, 0, fz); v.yaw = s.yaw;
    v.quat.copy(yq.setFromAxisAngle(up, s.yaw)); v._lastLoaded = null;
  };
  // frames drawn on the way in with a road block's near level missing inside its drawing distance (roadnear.js)
  const render = g.renderer.render.bind(g.renderer), cam = g.camera;
  let late = 0;
  g.renderer.render = (scene, camera) => {
    for (const tile of g.world.group.children) if (tile.visible) for (const o of tile.children)
      if (o.isLOD && o.userData.near && Math.hypot(cam.position.x - o.position.x, cam.position.y - o.position.y, cam.position.z - o.position.z) < o.userData.near.show) { late++; break; }
    return render(scene, camera);
  };
  const forced0 = g.world.stream?.roadNear?.forced ?? null;
  window.__parity = { restore() { g.renderer.render = render; if (v.step !== step) { delete v.step; if (v.step !== step) v.step = step; } } };
  // hold at the start (moving, as fly_lag_test does) until the ground there is built; then place the vehicle on it
  const s0 = at(0);
  v.step = function () { if (run) t += 1 / 120; put(); };
  put(); v.afterReset?.();
  const end = performance.now() + 120000;
  await sleep(500);
  while ((!g.world.loadedAt(s0.x, s0.z) || g.world.pendingTiles() > 0) && performance.now() < end) await sleep(100);
  if (spec.kind === 'jet') v.placeInAir(s0.x, g.world.heightAt(s0.x, s0.z) + spec.alt, s0.z, s0.yaw, spec.kmh);
  else { v.reset(s0.x, s0.z, s0.yaw); ride = v.pos.y - g.world.heightAt(s0.x, s0.z); }
  put(); v.afterReset?.();
  await sleep(1000);
  run = true;
  const stop = performance.now() + duration * 4000 + 30000;
  while (t < duration && performance.now() < stop) await sleep(30);
  const done = t >= duration;
  // at the end: hold the camera as it is now, stop moving, fix the clock
  await new Promise(r => requestAnimationFrame(r));
  const pose = { p: cam.position.clone(), q: cam.quaternion.clone(), u: cam.up.clone(), fov: cam.fov };
  const updateLOD = g.world.updateLOD;
  g.world.updateLOD = function (...a) {
    cam.position.copy(pose.p); cam.quaternion.copy(pose.q); cam.up.copy(pose.u); cam.fov = pose.fov; cam.updateProjectionMatrix();
    g.world.tick?.(1000);
    return updateLOD.apply(this, a);
  };
  const restore = window.__parity.restore;
  window.__parity.restore = () => { restore(); g.world.updateLOD = updateLOD; };
  moving = false; run = false;
  const lateWay = late;
  const settle = performance.now() + 60000;
  while ((g.world.pendingTiles() > 0 || (g.world.stream?.roadNear?.waiting ?? 0) > 0) && performance.now() < settle) await sleep(100);
  await sleep(2500);                                    // particles fade, the last levels show
  for (const el of document.querySelectorAll('body > *:not(canvas)')) el.style.visibility = 'hidden';
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const info = g.renderer.info.render;
  return { done, flown: +t.toFixed(2), duration: +duration.toFixed(2), late: lateWay, lateAll: late, calls: info.calls, tris: info.triangles,
    fogHidden: g.world.stream?.fogHidden ?? null, roadForced: forced0 === null ? null : g.world.stream.roadNear.forced - forced0,
    pending: g.world.pendingTiles(), cam: [pose.p.x, pose.p.y, pose.p.z].map(Math.round) };
}
function cleanup() {
  window.__parity?.restore(); window.__parity = null;
  for (const el of document.querySelectorAll('body > *:not(canvas)')) el.style.visibility = '';
}

async function shoot(url, label) {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: process.argv.includes('--headful') ? false : 'new', args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
  const errors = [], res = {};
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 760 });
    watchErrors(page, label, errors); page.setDefaultTimeout(0);
    await startGame(page, { url });
    for (const spec of LIST) {
      const r = await page.evaluate(approach, spec).catch(e => ({ done: false, error: String(e.message || e).split('\n')[0] }));
      const file = path.join(OUT, `${spec.name}.${label}.png`);
      if (!r.error) await page.screenshot({ path: file });
      await page.evaluate(cleanup).catch(() => {});
      res[spec.name] = { ...r, file };
      console.log(`${label.padEnd(6)} ${spec.name.padEnd(30)} ${r.error ? `ERROR ${r.error}` : `cam ${r.cam}  ${r.calls} calls ${(r.tris / 1e6).toFixed(2)} M tris  fog-hidden ${r.fogHidden ?? 'n/a'}  road at once ${r.roadForced ?? 'n/a'}  late ${r.late}${r.done ? '' : `  NOT COMPLETED (${r.flown}/${r.duration} s)`}`}`);
    }
  } finally { await browser.close(); }
  return { res, errors };
}

// ---- compare a pair in a browser page: % pixels differing, the largest difference, a diff picture
async function compare(pairs) {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
  const out = {};
  try {
    const page = await browser.newPage();
    for (const [name, a, b] of pairs) {
      out[name] = await page.evaluate(async (A, B) => {
        const load = async s => { const im = await createImageBitmap(await (await fetch('data:image/png;base64,' + s)).blob()); const c = new OffscreenCanvas(im.width, im.height), x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, im.width, im.height); };
        const p = await load(A), q = await load(B);
        if (p.width !== q.width || p.height !== q.height) return { error: 'sizes differ' };
        const c = new OffscreenCanvas(p.width, p.height), x = c.getContext('2d'), d = x.createImageData(p.width, p.height);
        let n = 0, max = 0;
        for (let i = 0; i < p.data.length; i += 4) {
          const m = Math.max(Math.abs(p.data[i] - q.data[i]), Math.abs(p.data[i + 1] - q.data[i + 1]), Math.abs(p.data[i + 2] - q.data[i + 2]));
          max = Math.max(max, m);
          const grey = (q.data[i] + q.data[i + 1] + q.data[i + 2]) / 9;
          if (m > 8) { n++; d.data[i] = 255; d.data[i + 1] = 0; d.data[i + 2] = 0; } else { d.data[i] = d.data[i + 1] = d.data[i + 2] = grey; }
          d.data[i + 3] = 255;
        }
        x.putImageData(d, 0, 0);
        const blob = await c.convertToBlob({ type: 'image/png' }), buf = new Uint8Array(await blob.arrayBuffer());
        let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { pct: 100 * n / (p.width * p.height), max, png: btoa(bin) };
      }, fs.readFileSync(a).toString('base64'), fs.readFileSync(b).toString('base64'));
      if (out[name].png) { fs.writeFileSync(path.join(OUT, `${name}.diff.png`), Buffer.from(out[name].png, 'base64')); delete out[name].png; }
    }
  } finally { await browser.close(); }
  return out;
}

const before = BEFORE ? await shoot(BEFORE, 'before') : null;
const after = await shoot(GAME_URL, before ? 'after' : 'shot');
const fails = [...(before?.errors || []), ...after.errors].map(e => `page error ${e}`);
let diffs = {};
if (before) diffs = await compare(LIST.filter(s => before.res[s.name]?.file && !before.res[s.name].error && !after.res[s.name].error)
  .map(s => [s.name, before.res[s.name].file, after.res[s.name].file]));
console.log(`\n${'shot'.padEnd(30)} ${'% px differ'.padStart(11)} ${'max'.padStart(4)}  ${'M tris'.padEnd(13)} fog-hidden  road at once  late`);
for (const s of LIST) {
  const a = after.res[s.name], o = before?.res[s.name], d = diffs[s.name];
  console.log(`${s.name.padEnd(30)} ${d ? (d.error || d.pct.toFixed(3)).toString().padStart(11) : '-'.padStart(11)} ${d && !d.error ? String(d.max).padStart(4) : '   -'}  `
    + `${o?.tris ? `${(o.tris / 1e6).toFixed(2)} → ` : ''}${a.tris ? (a.tris / 1e6).toFixed(2) : '-'}`.padEnd(13) + ` ${String(a.fogHidden ?? 'n/a').padStart(10)}  ${String(a.roadForced ?? 'n/a').padStart(12)}  ${a.late ?? '-'}`);
  for (const [l, r] of [['before', o], ['after', a]]) if (r && (r.error || !r.done)) fails.push(`${l} ${s.name}: ${r.error || `did not complete (${r.flown}/${r.duration} s)`}`);
  if (a.late > 0) fails.push(`${s.name}: ${a.late} frames with a road near level missing within its drawing distance`);
  if (d && (d.error || d.pct > TOL)) fails.push(`${s.name}: ${d.error || `${d.pct.toFixed(3)}% of pixels differ (> ${TOL}%): see ${s.name}.diff.png`}`);
}
fs.writeFileSync(path.join(OUT, 'parity.json'), JSON.stringify({ when: new Date().toISOString(), before: before?.res || null, after: after.res, diffs }, null, 1));
for (const f of fails) console.log(`FAIL ${f}`);
console.log(fails.length ? `${fails.length} failure(s); pictures in ${OUT}` : `PASS ${LIST.length} shot(s)${before ? ' match before → after' : ''}; pictures in ${OUT}`);
process.exit(fails.length ? 1 : 0);
