// Lag when flying fast and turning, measured in the real game (headless Chrome).
//   python3 tools/serve.py 8173 game            (this branch; another terminal)
//   python3 tools/serve.py 8174 <main checkout>/game   (optional: the code before, for a before/after table)
//   node tools/fly_lag_test.mjs [--before http://127.0.0.1:8174/] [--full] [--only words]     (a heavy run: use the gate)
//     [--out after.json] [--compare before.json after.json] [--headful]
// The fighter (and the stealth, the fastest) flies the paths of tools/lib/flypaths.mjs — straight, a 360° circle,
// S-turns, pulling 5 g — over McMinnville, Sheridan, forest and farmland at 600 / 1000 / top speed, 150 m and 800 m
// above the ground. The jet is moved along the path inside its own physics step (so the camera, streaming, shadows,
// minimap and drawing all run as in play; collisions are off). Default: 8 runs per place (32, ~20 min a build);
// --full: every combination (96). Before each run the jet holds at the start, moving, until the tiles there are built.
// --before: the old code has no build-step trace (world.buildStep.trace / .total are new), so its slow-frame list
// shows the whole of updateLOD as "lod".
// Per frame it records: the time between frames (what a player sees), the game's frame callback (main thread),
// split into renderer.render, world.updateLOD (tile builds: their step labels and ms), updateShadows, minimap,
// the slowest 2D-canvas call; triangles and draw calls; a JS-heap drop (a garbage collection) between frames; and
// frames with no ground under the jet. Prints per run: median / p95 / worst frame and % over 33 ms (before → after
// with --before or --compare), and what ran in the slow frames.
// Fails on page errors, and if any run (of the code under test) has frames with no ground under the jet.
// Headless Chrome is slower than a real browser: compare before/after on the same machine, not to 16.7 ms.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { startGame, watchErrors, GAME_URL } from './lib/startgame.mjs';
import { makePath, scenarios, PLACES, TURN_ACC } from './lib/flypaths.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0;

if (process.argv.includes('--compare')) {
  const i = process.argv.indexOf('--compare');
  table(JSON.parse(fs.readFileSync(process.argv[i + 1])).runs, JSON.parse(fs.readFileSync(process.argv[i + 2])).runs);
  process.exit(0);
}

// the runs: --full = everything; default = a spread that covers every suspect in ~15 min per build
function runList() {
  if (process.argv.includes('--full')) return [150, 800].flatMap(alt => scenarios().map(s => ({ ...s, alt, name: `${s.name} @${alt}` })));
  const pick = [['straight', 1000, 'fighter', 150], ['circle', 1000, 'fighter', 150], ['sturn', 1000, 'fighter', 150], ['circle', 600, 'fighter', 150],
    ['circle', 'max', 'fighter', 150], ['sturn', 'max', 'stealth', 150], ['circle', 1000, 'fighter', 800], ['straight', 'max', 'stealth', 800]];
  const all = scenarios();
  return Object.keys(PLACES).flatMap(place => pick.map(([path, sp, type, alt]) => {
    const s = all.find(s => s.place === place && s.path === path && s.type === type && (sp === 'max' ? s.kmh > 1500 : s.kmh === sp));
    return { ...s, alt, name: `${s.name} @${alt}` };
  }));
}
const only = arg('--only')?.split(',') || null;
const RUNS = runList().filter(r => !only || only.every(w => r.name.includes(w)));

// ---- in the page: instrument once, then fly one run and return its frames
function instrument() {
  if (window.__fly) return;
  const g = game, r = g.renderer, info = r.info.render, raf = window.requestAnimationFrame.bind(window);
  const F = window.__fly = { log: null, frame: null, last: 0 };
  const timed = (obj, name, key) => {
    const f = obj?.[name]; if (typeof f !== 'function') return;
    obj[name] = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { if (F.frame) F.frame[key] = (F.frame[key] || 0) + performance.now() - t; } };
  };
  const render = r.render.bind(r);
  r.render = (s, c) => { const t = performance.now(); render(s, c); if (F.frame) { F.frame.render = performance.now() - t; F.frame.calls = info.calls; F.frame.tris = info.triangles; } };
  timed(g.world, 'updateLOD', 'lod'); timed(g.world, 'updateShadows', 'shadows'); timed(g.minimap, 'update', 'minimap');
  timed(g.effects, 'update', 'effects'); timed(g.directions, 'update', 'directions'); timed(g.atmosphere, 'update', 'atmosphere');
  const proto = CanvasRenderingContext2D.prototype;          // 2D canvas (the minimaps): the slowest call of a frame
  for (const name of Object.getOwnPropertyNames(proto)) {
    const f = Object.getOwnPropertyDescriptor(proto, name).value;
    if (typeof f !== 'function' || name === 'constructor') continue;
    proto[name] = function (...a) { const t = performance.now(); const out = f.apply(this, a); const ms = performance.now() - t; if (F.frame && ms > (F.frame.draw2d || 0)) { F.frame.draw2d = ms; F.frame.draw2dWhat = name; } return out; };
  }
  window.requestAnimationFrame = cb => raf(t => {
    const fr = F.frame = { raf: F.last ? t - F.last : 0 }; F.last = t;
    const trace = g.world.buildStep.trace = F.log ? [] : null;
    const heap = performance.memory?.usedJSHeapSize || 0;
    const s = performance.now(); cb(t); fr.cb = performance.now() - s;
    const h2 = performance.memory?.usedJSHeapSize || 0;
    if (F.log) {
      const det = g.world.stream?.detailMs || 0;
      fr.build = (g.world.buildStep.total || 0) + det; fr.budget = g.world.stream?.budget; fr.urgent = g.world.stream?.urgent;
      if (trace?.length || det) { fr.steps = {}; for (let i = 0; i < (trace?.length || 0); i += 2) fr.steps[trace[i]] = (fr.steps[trace[i]] || 0) + trace[i + 1]; if (det) fr.steps['terrain detail'] = det; }
      if (heap && h2 < heap - 1e6) fr.gcMB = (heap - h2) / 1e6;                // the heap shrank: a collection ran in this frame
      const v = g.vehicles.current; fr.noGround = !g.world.loadedAt(v.pos.x, v.pos.z);
      F.log.push(fr);
    }
    F.frame = null;
  });
}
async function flyRun(spec, makePathSrc, places, turnAcc) {
  const g = game, sleep = ms => new Promise(r => setTimeout(r, ms));
  const makePath = (0, eval)(`(${makePathSrc})`), p = makePath(spec, places, turnAcc);
  g.vehicles.switchTo('jet'); if (g.vehicles.getType?.('jet') !== spec.type) g.vehicles.setType('jet', spec.type);
  const jet = g.vehicles.current, step = jet.step, fwd = new jet.quat.constructor(), roll = new jet.quat.constructor();
  let t = 0, run = false;
  const ground = (x, z) => g.world.heightAt(x, z);
  const put = () => {
    const s = p.at(t), y = ground(s.x, s.z) + spec.alt;
    jet.mode = 'air'; jet.pos.set(s.x, y, s.z); jet.vel.set(s.vx, 0, s.vz); jet.yaw = s.yaw; jet.agl = spec.alt;
    fwd.setFromAxisAngle({ x: 0, y: 1, z: 0 }, s.yaw); roll.setFromAxisAngle({ x: 0, y: 0, z: 1 }, -s.bank); jet.quat.copy(fwd).multiply(roll);
    jet.throttle = 1; jet.gear = 0; jet._lastLoaded = null;
  };
  jet.step = function (dt) { if (run) t += dt; put(); };     // the path, inside the 120 Hz physics loop
  try {
    const s0 = p.at(0);
    jet.placeInAir(s0.x, ground(s0.x, s0.z) + spec.alt, s0.z, s0.yaw, spec.kmh); put(); jet.afterReset();
    const end = performance.now() + 120000;                   // hold at the start, moving, until the tiles there are built
    await sleep(500);
    while ((!g.world.loadedAt(s0.x, s0.z) || g.world.pendingTiles() > 0) && performance.now() < end) await sleep(100);
    await sleep(1500);
    window.__fly.log = []; run = true;
    const stop = performance.now() + p.duration * 4000 + 30000;          // physics paused (a hold, a menu): give up
    while (t < p.duration && performance.now() < stop) await sleep(50);
    const frames = window.__fly.log; window.__fly.log = null;
    return { frames, pendingEnd: g.world.pendingTiles(), loaded: g.world.loadedTiles(), flown: t, duration: p.duration };
  } finally { if (Object.hasOwn(jet, 'step') && jet.step !== step) delete jet.step; if (jet.step !== step) jet.step = step; window.__fly.log = null; }
}

async function measure(url, label) {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: process.argv.includes('--headful') ? false : 'new', args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--enable-precise-memory-info'] });
  const errors = [], runs = [];
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 760 });
    watchErrors(page, label, errors);
    page.setDefaultTimeout(0);
    await startGame(page, { url });
    await page.evaluate(instrument);
    for (const spec of RUNS) {
      const r = await page.evaluate(flyRun, spec, makePath.toString(), PLACES, TURN_ACC);
      runs.push(summarise(spec, r));
      const s = runs.at(-1);
      console.log(`${label.padEnd(6)} ${s.name.padEnd(38)} median ${s.median.toFixed(1).padStart(5)}  p95 ${s.p95.toFixed(1).padStart(5)}  worst ${s.worst.toFixed(0).padStart(4)}  >33ms ${s.over33.toFixed(1).padStart(4)}%`
        + `  main p95 ${s.cbP95.toFixed(1)}  lod p95 ${s.lodP95.toFixed(1)}  ${s.calls} calls ${(s.tris / 1e6).toFixed(2)} M tris  noGround ${s.noGround}\n         slow frames: ${s.slow}`);
    }
  } finally { await browser.close(); }
  return { url, runs, errors };
}
function summarise(spec, { frames, pendingEnd, loaded, flown, duration }) {
  if (flown < duration) console.log(`  ${spec.name}: flew only ${flown.toFixed(1)} of ${duration.toFixed(1)} s (physics paused?)`);
  const f = frames.slice(1), raf = f.map(x => x.raf).sort((a, b) => a - b), cb = f.map(x => x.cb).sort((a, b) => a - b), lod = f.map(x => x.lod || 0).sort((a, b) => a - b);
  // what ran in frames over 33 ms: the parts' totals, biggest first
  const parts = {}, slow = f.filter(x => x.raf > 33 || x.cb > 25);
  for (const x of slow) {
    const add = (k, v) => { if (v > 0.5) parts[k] = (parts[k] || 0) + v; };
    add('render', x.render); add('shadows', x.shadows); add('minimap', x.minimap); add('effects', x.effects); add('2d ' + (x.draw2dWhat || ''), x.draw2d);
    for (const [k, v] of Object.entries(x.steps || {})) add('build ' + k, v);
    add('lod (not building)', (x.lod || 0) - (x.build || 0)); if (x.gcMB) add('gc frames', 1);
  }
  const avg = k => f.reduce((a, x) => a + (x[k] || 0), 0) / (f.length || 1);
  return { name: spec.name, place: spec.place, path: spec.path, kmh: spec.kmh, type: spec.type, alt: spec.alt, frames: f.length,
    median: pct(raf, .5), p95: pct(raf, .95), worst: raf.at(-1) || 0, over33: 100 * raf.filter(x => x > 33).length / (raf.length || 1),
    cbMedian: pct(cb, .5), cbP95: pct(cb, .95), lodP95: pct(lod, .95), buildPerFrame: avg('build'), urgent: f.filter(x => x.urgent).length,
    calls: Math.round(avg('calls')), tris: Math.round(avg('tris')), gcFrames: f.filter(x => x.gcMB).length, noGround: f.filter(x => x.noGround).length,
    pendingEnd, loaded, slowFrames: slow.length,
    slow: Object.entries(parts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k === 'gc frames' ? `gc in ${v}` : `${k} ${v.toFixed(0)}`).join(', ') || '-' };
}
function table(before, after) {
  const by = new Map((before || []).map(r => [r.name, r]));
  const c = (o, r, k, d = 1) => o ? `${o[k].toFixed(d).padStart(5)} → ${r[k].toFixed(d).padEnd(5)}` : r[k].toFixed(d).padStart(5);
  console.log(`\n${'run'.padEnd(38)} ${'median ms'.padEnd(13)} ${'p95 ms'.padEnd(13)} ${'worst ms'.padEnd(13)} ${'% > 33 ms'.padEnd(13)} ${'M tris'.padEnd(13)} calls`);
  for (const r of after) {
    const o = by.get(r.name);
    console.log(`${r.name.padEnd(38)} ${c(o, r, 'median')} ${c(o, r, 'p95')} ${c(o, r, 'worst', 0)} ${c(o, r, 'over33')} ${o ? `${(o.tris / 1e6).toFixed(2).padStart(5)} → ${(r.tris / 1e6).toFixed(2).padEnd(5)}` : (r.tris / 1e6).toFixed(2)} ${o ? `${o.calls} → ${r.calls}` : r.calls}`);
  }
}

const before = arg('--before') ? await measure(arg('--before'), 'before') : null;
const after = await measure(GAME_URL, before ? 'after' : 'run');
if (arg('--out')) fs.writeFileSync(arg('--out'), JSON.stringify({ when: new Date().toISOString(), before, after, runs: after.runs }, null, 1));
table(before?.runs, after.runs);
const errors = [...(before?.errors || []), ...after.errors], missing = after.runs.filter(r => r.noGround > 0);
for (const r of missing) console.log(`FAIL ${r.name}: ${r.noGround} frames with no ground under the jet`);
if (errors.length) console.log(`FAIL page errors:\n  ${errors.join('\n  ')}`);
process.exit(errors.length || missing.length ? 1 : 0);
