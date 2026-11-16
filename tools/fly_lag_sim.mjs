// Fly-lag measurement without a browser: runs the game's real tile streaming (world.js loadWorld: fetch, decode, tile
// data, meshes, LOD, shadow casters) in Node with a stub renderer, flying the camera along the paths of
// tools/lib/flypaths.mjs at a steady 60 frames per second, and records the main-thread time world.updateLOD +
// updateShadows take each frame, what the tile builds spent it on (by step label), garbage collection, how many
// tiles were requested, built, dropped and built again, and frames with no ground under the plane. Every 20th frame it
// also counts what a 1280×760 chase camera at --alt metres would draw of the world (meshes in the view frustum, their
// triangles): the renderer's own numbers, texture uploads and the shadow map need the browser (tools/fly_lag_test.mjs).
//   node --expose-gc --max-old-space-size=8192 tools/fly_lag_sim.mjs [--src <dir>/game/src] [--only words] [--out f.json]
//     [--latency ms (per file, default 120)] [--speeds 600,1000,max] [--paths straight,circle,sturn] [--places a,b]
//     [--alt 150] [--stream (only tools/stream_test.mjs's run: the car at 1000 km/h across the map)]
//     [--unpaced: frames back to back, not 60 a second. Steps then run at full CPU speed for every build (paced, macOS
//      runs short bursts with idle time between them slower), but downloads race behind, so ignore "noGround"]
//   node tools/fly_lag_sim.mjs --compare before.json after.json          (V=1: a progress line every 0.5 s of flight)
// Run it through the heavy gate (it builds dozens of tiles). Tiles come from this checkout's game/assets; --src picks
// the code (e.g. an unchanged copy of game/src for a before/after table).
import fs from 'node:fs';
import path from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import * as THREE from 'three';
import { makePath, scenarios, PLACES, STREAM_RUN } from './lib/flypaths.mjs';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0;

if (args[0] === '--compare') { compare(JSON.parse(fs.readFileSync(args[1])), JSON.parse(fs.readFileSync(args[2]))); process.exit(0); }

const SRC = path.resolve(opt('src', 'game/src')), GAME = path.resolve('game');      // code from --src, tiles from here
const LATENCY = +opt('latency', 120), ALT = +opt('alt', 150), FPS = 60, DT = 1 / FPS, UNPACED = args.includes('--unpaced');
const list = args.includes('--stream') ? [STREAM_RUN] : scenarios({
  places: opt('places', '') ? opt('places').split(',') : undefined,
  paths: opt('paths', '') ? opt('paths').split(',') : undefined,
  speeds: opt('speeds', '') ? opt('speeds').split(',').map(s => s === 'max' ? s : +s) : undefined,
}).filter(s => !opt('only') || opt('only').split(',').every(w => s.name.includes(w)));

// ---- the browser bits world.js touches, stubbed
let frameNo = 0, starting = true;         // start-up load (loadWorld's own await): no frames run, no latency
const waiters = [];
const untilFrame = n => new Promise(r => waiters.push([n, r]));
const ctx2d = () => new Proxy({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), measureText: () => ({ width: 10 }) },
  { get: (o, k) => k in o ? o[k] : () => {}, set: (o, k, v) => (o[k] = v, true) });      // any other 2D call: a no-op
globalThis.document = { createElement: () => ({ width: 0, height: 0, style: {}, getContext: ctx2d }) };
globalThis.createImageBitmap = async () => ({ width: 1024, height: 1024, close() {} });
globalThis.fetch = async url => {
  if (!starting) await untilFrame(frameNo + Math.round(LATENCY / 1000 * FPS));       // the network: LATENCY ms per file
  return new Response(await fs.promises.readFile(path.join(GAME, String(url))));
};
const renderer = { initTexture() {}, properties: { get: () => ({}) }, info: { render: { calls: 0, triangles: 0 } } };
const { loadWorld } = await import(path.join(SRC, 'world.js'));

const gcs = [];
new PerformanceObserver(l => { for (const e of l.getEntries()) gcs.push([e.startTime, e.duration]); }).observe({ entryTypes: ['gc'] });
const tick = () => new Promise(r => setImmediate(r));
let frameAt = 0;
// frames are paced to real time (60 a second), as in the browser: unpaced, a frame with nothing to build took ~0.1 ms,
// the jet raced ahead of the real downloads / unzips and "ran out of ground" depending on the machine's load
async function nextFrame() {
  frameNo++;
  for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i][0] <= frameNo) { waiters[i][1](); waiters.splice(i, 1); }
  await tick(); await tick();             // let finished reads / unzips land, like the browser between frames
  const wait = frameAt + 1000 / FPS - performance.now();
  if (wait > 1 && !UNPACED) await new Promise(r => setTimeout(r, wait));
  frameAt = performance.now();
}

// the CPU's speed right now (ms for a fixed piece of work, untimed): macOS runs a thread that is busy only part of each
// frame on slower cores / clocks, so a build that leaves more idle time can show slower steps for the same work
let calSink = 0;
function calibrate() {
  const t = performance.now(); let s = 0;
  for (let i = 1; i < 200000; i++) s += Math.sqrt(i) % 7;
  calSink += s; return performance.now() - t;
}

// what the renderer would draw of the world: visible meshes inside the camera's frustum (three.js projectObject's rules)
const view = new THREE.PerspectiveCamera(70, 1280 / 760, 0.3, 2200), frustum = new THREE.Frustum(), pv = new THREE.Matrix4();
function drawn(group, s, y) {
  view.position.set(s.x - Math.sin(s.yaw) * 30, y + 8, s.z - Math.cos(s.yaw) * 30);
  view.lookAt(s.x + Math.sin(s.yaw) * 60, y - 4, s.z + Math.cos(s.yaw) * 60); view.updateMatrixWorld();
  frustum.setFromProjectionMatrix(pv.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse));
  const out = { calls: 0, tris: 0, terrain: 0, instanced: 0, other: 0 };
  group.updateMatrixWorld(true);
  (function walk(o) {
    if (o.isLOD) o.update(view);            // as the renderer does (road blocks, bridges): one level visible
    if (!o.visible) return;
    if (o.isMesh && (!o.frustumCulled || frustum.intersectsObject(o))) {
      const g = o.geometry, n = (g.index ? g.index.count : g.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1);
      if (n > 0) { out.calls++; out.tris += n; out[o.isInstancedMesh ? 'instanced' : o.material.map ? 'terrain' : 'other'] += n; }
    }
    for (const c of o.children) walk(c);
  })(group);
  return out;
}

const results = [];
for (const sc of list) {
  globalThis.gc?.();
  starting = true;
  const world = await loadWorld(renderer);
  starting = false;
  const p = makePath(sc, sc.places || PLACES), s0 = p.at(0);
  // instrument: tiles added / removed (world.add / world.remove are looked up at call time)
  const ev = { adds: 0, drops: 0, rebuilds: 0, seen: new Set(), dropped: new Set(), maxLoaded: 0 };
  const add = world.add, remove = world.remove;
  world.add = t => { const k = world.key(t.tx, t.tz); ev.adds++; if (ev.dropped.has(k)) ev.rebuilds++; ev.seen.add(k); return add(t); };
  world.remove = (tx, tz) => { ev.drops++; ev.dropped.add(world.key(tx, tz)); return remove(tx, tz); };
  // warm up like a jet that has been flying this way: hold at the start, moving, until nothing is pending
  const cam = { x: s0.x, y: 300, z: s0.z }, vel = { x: s0.vx, y: 0, z: s0.vz };
  for (let i = 0; i < 4000 && (i < 30 || world.pendingTiles() > 0); i++) { world.updateLOD(cam, vel); world.updateShadows(cam); await nextFrame(); }
  Object.assign(ev, { adds: 0, drops: 0, rebuilds: 0, dropped: new Set() });
  const trace = world.buildStep.trace = [], labels = {};
  const frames = [], g0 = gcs.length, draws = [], cal = [];
  let noGround = 0, offMap = 0, urgent = 0, maxShown = 0;
  const n = Math.ceil(p.duration * FPS);
  for (let f = 0; f < n; f++) {
    const s = p.at(f * DT);
    const ground = world.loadedAt(s.x, s.z) ? world.heightAt(s.x, s.z) : 0;
    cam.x = s.x - Math.sin(s.yaw) * 30; cam.y = ground + ALT + 8; cam.z = s.z - Math.cos(s.yaw) * 30; vel.x = s.vx; vel.z = s.vz;
    if (!world.mapContains(s.x, s.z)) offMap++;
    else if (!world.loadedAt(s.x, s.z)) noGround++;
    trace.length = 0;
    const t0 = performance.now();
    world.updateLOD(cam, vel); world.updateShadows({ x: s.x, y: ground + ALT, z: s.z });
    const t1 = performance.now();
    const step = world.buildStep;
    for (let i = 0; i < trace.length; i += 2) { const l = labels[trace[i]] ||= { n: 0, ms: 0, max: 0 }; l.n++; l.ms += trace[i + 1]; l.max = Math.max(l.max, trace[i + 1]); }
    const det = world.stream?.detailMs || 0;
    frames.push({ t0, ms: t1 - t0, build: (step.total ?? step.ms) + det, steps: step.n ?? 0, slow: det > step.ms && det > 1 ? `terrain detail ${det.toFixed(1)}` : step.ms > 1 ? `${step.label} ${step.ms.toFixed(1)}` : '' });
    if (det) { const l = labels['terrain detail'] ||= { n: 0, ms: 0, max: 0 }; l.n++; l.ms += det; l.max = Math.max(l.max, det); }
    if (world.stream?.urgent) urgent++;
    ev.maxLoaded = Math.max(ev.maxLoaded, world.loadedTiles());
    maxShown = Math.max(maxShown, world.loadedTiles() - (world.stream?.hidden || 0));
    if (f % 20 === 0) draws.push(drawn(world.group, s, ground + ALT));
    if (f % 10 === 0) cal.push(calibrate());
    if (process.env.V && f % 30 === 0) console.log(`  t ${(f * DT).toFixed(1)} at ${s.x.toFixed(0)},${s.z.toFixed(0)} tile ${world.tileIndex(s.x, s.z)} ground ${world.loadedAt(s.x, s.z) ? 'yes' : 'NO'}`
      + `  pending ${world.pendingTiles()} built ${world.loadedTiles()} hidden ${world.stream?.hidden} urgent ${world.stream?.urgent} budget ${world.stream?.budget?.toFixed(1)} build ${frames.at(-1).build.toFixed(1)}`);
    await nextFrame();
  }
  // GC pauses inside a measured frame's update
  let gcMs = 0, gcN = 0;
  for (const [st, d] of gcs.slice(g0)) { const fr = frames.find(fr => st >= fr.t0 && st < fr.t0 + fr.ms); if (fr) { fr.gc = (fr.gc || 0) + d; gcMs += d; gcN++; } }
  const ms = frames.map(f => f.ms).sort((a, b) => a - b), worst = frames.reduce((a, f) => f.ms > a.ms ? f : a, frames[0]);
  const top = Object.entries(labels).sort((a, b) => b[1].ms - a[1].ms).slice(0, 5).map(([k, v]) => `${k} ${v.ms.toFixed(0)}/${v.max.toFixed(1)}`).join(', ');
  const avg = k => Math.round(draws.reduce((a, d) => a + d[k], 0) / draws.length);
  const r = { name: sc.name, secs: +p.duration.toFixed(1), frames: n, median: +pct(ms, .5).toFixed(2), p95: +pct(ms, .95).toFixed(2), worst: +worst.ms.toFixed(1),
    over4: +(100 * ms.filter(x => x > 4).length / n).toFixed(1), over8: +(100 * ms.filter(x => x > 8).length / n).toFixed(1), over16: +(100 * ms.filter(x => x > 16).length / n).toFixed(1),
    buildTotal: +frames.reduce((a, f) => a + f.build, 0).toFixed(0), worstSlow: worst.slow, worstGc: +(worst.gc || 0).toFixed(1), gcMs: +gcMs.toFixed(1), gcN,
    adds: ev.adds, drops: ev.drops, rebuilds: ev.rebuilds, maxLoaded: ev.maxLoaded, maxShown, urgent, pendingEnd: world.pendingTiles(), noGround, offMap,
    cpuMs: +pct(cal.sort((a, b) => a - b), .5).toFixed(3), calls: avg('calls'), tris: avg('tris'), trisTerrain: avg('terrain'), trisInstanced: avg('instanced'), trisOther: avg('other'), top, labels };
  results.push(r);
  console.log(`${r.name.padEnd(34)} med ${r.median.toFixed(2).padStart(5)}  p95 ${r.p95.toFixed(2).padStart(5)}  worst ${String(r.worst).padStart(5)}  >8ms ${String(r.over8).padStart(4)}%  >16 ${String(r.over16).padStart(4)}%`
    + `  build ${r.buildTotal} ms  tiles +${r.adds} -${r.drops} rebuilt ${r.rebuilds} max ${r.maxLoaded}/${maxShown} shown  urgent ${urgent}  gc ${r.gcMs}  noGround ${noGround}${offMap ? ` OFFMAP ${offMap}` : ''}  cpu ${r.cpuMs}`
    + `\n    draw @${ALT} m: ${r.calls} calls ${(r.tris / 1e6).toFixed(2)} M tris (terrain ${(r.trisTerrain / 1e6).toFixed(2)}, instanced ${(r.trisInstanced / 1e6).toFixed(2)}, other ${(r.trisOther / 1e6).toFixed(2)})`
    + `\n    top: ${top}  worst frame: ${worst.slow}${worst.gc ? ` (gc ${worst.gc.toFixed(1)})` : ''}`);
  world.group.clear();
}
if (opt('out')) fs.writeFileSync(opt('out'), JSON.stringify({ src: SRC, latency: LATENCY, alt: ALT, results }, null, 1));

function compare(a, b) {
  const by = new Map(a.results.map(r => [r.name, r]));
  console.log('scenario'.padEnd(34), 'median ms ', '  p95 ms   ', ' worst ms   ', '% >8 ms  ', '% >16 ms ', 'rebuilt', ' tiles built', ' no ground', '  M tris');
  for (const r of b.results) {
    const o = by.get(r.name); if (!o) continue;
    const c = (k, w = 5, f = x => x) => `${String(f(o[k])).padStart(w)}→${String(f(r[k])).padEnd(w)}`;
    console.log(r.name.padEnd(34), c('median'), c('p95'), c('worst'), c('over8', 4), c('over16', 4), c('rebuilds', 2), c('adds', 4), c('noGround', 4), c('tris', 4, x => (x / 1e6).toFixed(2)));
  }
}
