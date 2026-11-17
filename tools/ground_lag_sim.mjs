// Ground / air lag and pop-in without a browser: the game's real tile streaming (world.js loadWorld with a stub
// renderer, as tools/fly_lag_sim.mjs) with the real car (physics at 120 Hz on a rail, interpolate, syncMesh) or, with
// --alt, a plane's camera that high, along straight lines at a fixed speed.
// Time is VIRTUAL so a busy machine does not change the result: the clock the game reads (performance.now) is this
// thread's CPU time, and a frame lasts max(vsync period, the CPU it used + --render-ms (busy-waited, like the render
// call), --gpu-ms (a GPU-bound frame: a Retina screen at full resolution)). Downloads take --latency ms of frames.
// Per run: frame CPU (median / p95 / worst), of it physics, the car's drawing, world.updateLOD + updateShadows (full-detail
// terrain, road near levels, tile build steps), what a chase camera would draw (meshes in the frustum, triangles), the
// drawn body's smoothness (second difference of its height relative to the physics height, mm) and POP-IN: every
// building whose tile finished building (a tile's buildings are drawn once its whole build is done) while the building
// was already within view distance (900 m flat: townmodel.js townRange.far) and in front of the camera, with how long
// it had been within view distance (virtual s).
//   node --expose-gc --max-old-space-size=8192 tools/ground_lag_sim.mjs [--src <dir>/game/src] [--routes campus,town,forest,hwy]
//     [--speeds 100,300,1000] [--secs 12] [--alt m] [--latency 120] [--render-ms 3] [--gpu-ms 0] [--hz 60] [--out f.json]
//   node tools/ground_lag_sim.mjs --compare a.json b.json
// Run it through the heavy gate (it builds tiles). Tiles come from this checkout's game/assets; --src picks the code
// (an older commit's game/src, extracted with `git archive`, for a before / after table).
import fs from 'node:fs';
import path from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import * as THREE from 'three';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0;
if (args[0] === '--compare') { compare(JSON.parse(fs.readFileSync(args[1])), JSON.parse(fs.readFileSync(args[2]))); process.exit(0); }

// straight lines (x, z, yaw: forward = (sin, cos)); the bench spots of tools/bench.mjs where there is one
const ROUTES = {
  campus: { x: -542, z: 440, yaw: 1.8, label: 'campus Main Building drive' },
  town: { x: 19451, z: -11032, yaw: -1.573, label: 'McMinnville NE 3rd St, west' },
  towneast: { x: 13000, z: -11000, yaw: Math.PI / 2, label: 'into McMinnville from the west' },
  forest: { x: 0, z: -20000, yaw: Math.PI / 2, label: 'forest (N woods)' },
  sheridan: { x: -1500, z: 1400, yaw: Math.PI / 2, label: 'campus → Sheridan → east' },
};
const SRC = path.resolve(opt('src', 'game/src')), GAME = path.resolve('game');
const HZ = +opt('hz', 60), PERIOD = 1000 / HZ, LATENCY = +opt('latency', 120), STEP = 1 / 120, SECS = +opt('secs', 12);
const routes = opt('routes', 'campus,town,forest').split(','), speeds = opt('speeds', '100,300,1000').split(',').map(Number);
// --teleport: from the start-up tiles round the spawn, the camera jumps to each route's start (standing, 3 m up): virtual
// seconds until the ground under it is built and until every wanted tile is, tiles built per second, the world update's
// main-thread time per frame (median / p95 / worst) and frames over 20 ms in all (render included)
const TELEPORT = args.includes('--teleport');
const ALT = opt('alt') ? +opt('alt') : null, RENDER_MS = +opt('render-ms', 3), GPU_MS = +opt('gpu-ms', 0), VIEW = 900;

// ---- virtual clock: base + this thread's CPU time; nextFrame moves the base to the frame's end
const cpu = () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; };
let vBase = 0, cpu0 = cpu();
const vnow = () => vBase + cpu() - cpu0;
const setNow = t => { vBase = t - (cpu() - cpu0); };
Object.defineProperty(performance, 'now', { value: vnow, configurable: true, writable: true });

// ---- the browser bits world.js touches, stubbed (as tools/fly_lag_sim.mjs)
let frameNo = 0, starting = true;
const waiters = [];
const untilFrame = n => new Promise(r => waiters.push([n, r]));
const ctx2d = () => new Proxy({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), measureText: () => ({ width: 10 }) },
  { get: (o, k) => k in o ? o[k] : () => {}, set: (o, k, v) => (o[k] = v, true) });
globalThis.document = { createElement: () => ({ width: 0, height: 0, style: {}, getContext: ctx2d }) };
globalThis.createImageBitmap = async () => ({ width: 1024, height: 1024, close() {} });
globalThis.fetch = async url => {
  if (!starting) await untilFrame(frameNo + Math.max(1, Math.round(LATENCY / PERIOD)));
  return new Response(await fs.promises.readFile(path.join(GAME, String(url))));
};
const renderer = { initTexture() {}, properties: { get: () => ({}) }, info: { render: { calls: 0, triangles: 0 } } };
const { loadWorld } = await import(path.join(SRC, 'world.js'));
const { Car, TUNING_DEFAULTS } = await import(path.join(SRC, 'car.js'));

let gcMsTotal = 0;
new PerformanceObserver(l => { for (const e of l.getEntries()) gcMsTotal += e.duration; }).observe({ entryTypes: ['gc'] });
const tick = () => new Promise(r => setImmediate(r));
// finished downloads land between frames; the frame then lasts at least the vsync period (virtual)
let frameAt = 0;
async function nextFrame(minMs = PERIOD) {
  frameNo++;
  for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i][0] <= frameNo) { waiters[i][1](); waiters.splice(i, 1); }
  for (let i = 0; i < 4; i++) await tick();
  // a real file read / unzip can take a few more ms: let them land (they don't count as main-thread time here)
  await new Promise(r => setTimeout(r, 1));
  const end = Math.max(vnow(), frameAt + minMs);
  setNow(end); const dt = end - frameAt; frameAt = end;
  return dt;
}

// what the renderer would draw of a group from the view (three.js projectObject's rules: visible, frustum, LOD)
const view = new THREE.PerspectiveCamera(70, 1280 / 760, 0.3, 2200), frustum = new THREE.Frustum(), pv = new THREE.Matrix4();
function drawn(group, cam, look) {
  view.position.copy(cam); view.lookAt(look); view.updateMatrixWorld();
  frustum.setFromProjectionMatrix(pv.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse));
  const out = { calls: 0, tris: 0, terrain: 0, instanced: 0, other: 0 };
  group.updateMatrixWorld(true);
  (function walk(o) {
    if (o.isLOD) o.update(view);
    if (!o.visible) return;
    if (o.isMesh && (!o.frustumCulled || frustum.intersectsObject(o))) {
      const g = o.geometry, n = (g.index ? g.index.count : g.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1);
      if (n > 0) { out.calls++; out.tris += n; out[o.isInstancedMesh ? 'instanced' : o.material.map ? 'terrain' : 'other'] += n; }
    }
    for (const c of o.children) walk(c);
  })(group);
  return out;
}
function modelTris(m) {
  let tris = 0, calls = 0;
  (function walk(o) {
    if (!o.visible) return;
    if (o.isMesh) { const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; calls++; }
    for (const c of o.children) walk(c);
  })(m);
  return { tris, calls };
}
// in front of the camera (horizontal field of view ~100° at 1280×760)
const COS_HALF = Math.cos(55 * Math.PI / 180);
const inView = (c, x, z) => { const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz) || 1; return (dx * c.fx + dz * c.fz) / d > COS_HALF; };
const busyWait = ms => { const t = vnow(); while (vnow() - t < ms); };

const results = [], _fw = new THREE.Vector3(), _q = new THREE.Quaternion(), _Y = new THREE.Vector3(0, 1, 0), _bp = new THREE.Vector3();
const camPos = new THREE.Vector3(), look = new THREE.Vector3();
for (const rn of routes) {
  const R = ROUTES[rn];
  globalThis.gc?.();
  starting = true;
  const world = await loadWorld(renderer);
  starting = false;
  // pop-in: on world.add (a tile's build done), each of its buildings already within VIEW of the camera
  const camHist = [], pop = { late: [], tiles: [] };
  let recording = false;
  const add = world.add;
  world.add = td => {
    if (recording && camHist.length) {
      const c = camHist.at(-1);
      let tileLate = 0;
      for (const b of td.buildings || []) {
        const p = b.pts?.[0]; if (!p || Math.hypot(p[0] - c.x, p[1] - c.z) >= VIEW) continue;
        let f = camHist.length - 1; while (f > 0 && Math.hypot(p[0] - camHist[f - 1].x, p[1] - camHist[f - 1].z) < VIEW) f--;
        const late = (c.t - camHist[f].t) / 1000;
        tileLate = Math.max(tileLate, late);
        if (inView(c, p[0], p[1])) pop.late.push(late);
      }
      if (tileLate > 0) pop.tiles.push(tileLate);
    }
    return add(td);
  };
  const car = new Car(world, { ...TUNING_DEFAULTS });
  if (TELEPORT) { results.push(await teleport(world, R, rn)); world.group.clear(); continue; }
  const fx = Math.sin(R.yaw), fz = Math.cos(R.yaw);
  const input = { throttle: 1, brake: 0, steer: 0, handbrake: false };
  // rail: heading and horizontal velocity held, x / z on the line at distance s
  const rail = s => {
    car.pos.x = R.x + fx * s; car.pos.z = R.z + fz * s;
    _fw.set(0, 0, 1).applyQuaternion(car.quat);
    const d = R.yaw - Math.atan2(_fw.x, _fw.z);
    if (Math.abs(d) > 1e-6) car.quat.premultiply(_q.setFromAxisAngle(_Y, d));
  };
  for (const kmh of speeds) {
    const v = kmh / 3.6;
    // warm-up at the start, parked, until nothing is pending (the tiles round the start are built)
    car.reset(R.x, R.z, R.yaw); car.vel.set(0, 0, 0);
    for (let i = 0; i < 20000 && (i < 30 || world.pendingTiles() > 0); i++) {
      camPos.set(R.x - fx * 7, car.pos.y + (ALT ?? 2.6), R.z - fz * 7);
      const f0 = vnow();
      world.updateLOD(camPos, car.vel, 0, { frameStart: f0, renderMs: RENDER_MS }); world.updateShadows(car.pos);
      if (!world.loadedAt(R.x, R.z)) car.reset(R.x, R.z, R.yaw);
      await nextFrame();
    }
    car.reset(R.x, R.z, R.yaw);
    for (let i = 0; i < 60; i++) { car.savePrev(); car.step(STEP, input); rail(0); car.vel.set(0, car.vel.y, 0); }   // settle on the springs
    car.vel.x = fx * v; car.vel.z = fz * v;
    const trace = world.buildStep ? (world.buildStep.trace = []) : null;
    camHist.length = 0; pop.late = []; pop.tiles = []; recording = true;
    const frames = [], draws = [], road0 = { ...(world.stream?.roadNear || {}) }, gc0 = gcMsTotal;
    let s = 0, acc = 0, prevRel = null, prevD = null, noGround = 0, carDraw = null, dt = PERIOD / 1000, t = 0;
    const jerk = [];
    while (t < SECS) {
      if (trace) trace.length = 0;
      const t0 = vnow();
      acc += dt;
      while (acc >= STEP) {
        s += v * STEP; acc -= STEP;
        if (ALT !== null) { car.savePrev(); rail(s); car.pos.y = (world.loadedAt(car.pos.x, car.pos.z) ? world.heightAt(car.pos.x, car.pos.z) : car.pos.y - ALT) + ALT; continue; }
        car.savePrev(); car.step(STEP, input);
        rail(s); car.vel.x = fx * v; car.vel.z = fz * v;
      }
      const t1 = vnow();
      car.interpolate(acc / STEP); car.input = input; car.syncMesh(dt); car.mesh.updateMatrixWorld(true);
      const t2 = vnow();
      // chase camera ~ main.js updateCamera (mode 0): behind and above the drawn car, looking 5 m ahead
      const rp = car.renderPos, dist = 5.4 + Math.min(v, 75) * 0.022;
      camPos.set(rp.x - fx * dist, rp.y + 1.85, rp.z - fz * dist);
      look.set(rp.x + fx * 5, rp.y + 0.9, rp.z + fz * 5);
      camHist.push({ x: camPos.x, z: camPos.z, fx, fz, t: t0 });
      world.updateLOD(camPos, car.vel, 0, { frameStart: t0, renderMs: RENDER_MS }); world.updateShadows(rp);
      const t3 = vnow();
      busyWait(RENDER_MS);
      if (!world.loadedAt(car.pos.x, car.pos.z)) noGround++;
      const st = world.stream || {};
      let tileMs = 0;
      if (trace) for (let i = 0; i < trace.length; i += 2) tileMs += trace[i + 1];
      frames.push({ budget: st.budget || 0, phys: t1 - t0, draw: t2 - t1, world: t3 - t2, total: t3 - t0, detail: st.detailMs || 0, road: st.roadMs || 0, tile: tileMs,
        slow: `${(st.detailMs || 0) > 1 ? `detail ${st.detailMs.toFixed(1)} ` : ''}${(st.roadMs || 0) > 1 ? `road ${st.roadMs.toFixed(1)} ` : ''}${world.buildStep?.label || ''} ${world.buildStep?.ms?.toFixed?.(1) ?? ''}` });
      // drawn body height relative to the interpolated physics height: its frame-to-frame second difference
      // (only what the drawing adds: the whole car drawn higher (car.js syncMesh) + the body pivot's lift (bodyclearance.js))
      const pivot = car.mesh.userData.bodyPivot;
      const rel = car.mesh.position.y - rp.y + (pivot ? pivot.position.y : 0);
      if (frames.length < +opt('trace-lift', 0)) console.log(`  f ${frames.length} rise ${((car.mesh.position.y - rp.y) * 1000).toFixed(0)} mm pivot ${pivot ? (pivot.position.y * 1000).toFixed(0) : '-'} mm`
        + ` grounded ${car.grounded} comps ${car.wheels.map(w => w.comp.toFixed(2)).join(' ')} surf ${car.surface} y ${car.pos.y.toFixed(2)} vy ${car.vel.y.toFixed(2)}`);
      if (prevRel !== null) { const d = rel - prevRel; if (prevD !== null) jerk.push(Math.abs(d - prevD)); prevD = d; }
      prevRel = rel;
      if (frames.length % 20 === 1) { draws.push(drawn(world.group, camPos, look)); carDraw ||= modelTris(car.mesh); }
      dt = Math.min(0.1, await nextFrame(Math.max(PERIOD, GPU_MS)) / 1000); t += dt;
    }
    recording = false;
    const n = frames.length;
    const col = k => frames.map(fr => fr[k]).sort((a, b) => a - b), sum = k => frames.reduce((a, fr) => a + fr[k], 0);
    const tot = col('total'), worst = frames.reduce((a, fr) => fr.total > a.total ? fr : a, frames[0]);
    const avg = k => Math.round(draws.reduce((a, d) => a + d[k], 0) / draws.length);
    const js = jerk.sort((a, b) => a - b), pl = pop.late.sort((a, b) => a - b);
    const r = { name: `${rn} ${kmh}${ALT !== null ? ` @${ALT}` : ''}`, route: rn, kmh, alt: ALT, frames: n,
      median: +pct(tot, .5).toFixed(2), p95: +pct(tot, .95).toFixed(2), p99: +pct(tot, .99).toFixed(2), worst: +worst.total.toFixed(1),
      over8: +(100 * tot.filter(x => x > 8).length / n).toFixed(1), over12: +(100 * tot.filter(x => x > 12).length / n).toFixed(1),
      physMed: +pct(col('phys'), .5).toFixed(2), physP95: +pct(col('phys'), .95).toFixed(2),
      drawMed: +pct(col('draw'), .5).toFixed(2), drawP95: +pct(col('draw'), .95).toFixed(2),
      worldMed: +pct(col('world'), .5).toFixed(2), worldP95: +pct(col('world'), .95).toFixed(2), worldMax: +pct(col('world'), 1).toFixed(1),
      detailMs: +sum('detail').toFixed(0), roadMs: +sum('road').toFixed(0), tileMs: +sum('tile').toFixed(0), gcMs: +(gcMsTotal - gc0).toFixed(0),
      roadForced: (world.stream?.roadNear?.forced ?? 0) - (road0.forced ?? 0), roadBuilt: (world.stream?.roadNear?.built ?? 0) - (road0.built ?? 0),
      noGround, worstSlow: worst.slow, calls: avg('calls'), tris: avg('tris'), trisTerrain: avg('terrain'), trisInstanced: avg('instanced'), trisOther: avg('other'),
      carTris: carDraw?.tris ?? 0, carCalls: carDraw?.calls ?? 0, budgetMed: +pct(col('budget'), .5).toFixed(1),
      popN: pl.length, popMean: +(pl.reduce((a, x) => a + x, 0) / (pl.length || 1)).toFixed(2), popP95: +pct(pl, .95).toFixed(2), popMax: +pct(pl, 1).toFixed(2),
      tilesLate: pop.tiles.length,
      jerkMed: +(pct(js, .5) * 1000).toFixed(2), jerkP95: +(pct(js, .95) * 1000).toFixed(2), jerkMax: +(pct(js, 1) * 1000).toFixed(1) };
    results.push(r);
    console.log(`${r.name.padEnd(16)} POP-IN ${r.popN} buildings late in view (mean ${r.popMean} s, p95 ${r.popP95}, max ${r.popMax}), tiles late ${r.tilesLate}`
      + ` | frame cpu med ${r.median} p95 ${r.p95} p99 ${r.p99} worst ${r.worst} >12ms ${r.over12}% | budget med ${r.budgetMed}`
      + `\n                 phys ${r.physMed}/${r.physP95} draw ${r.drawMed}/${r.drawP95} world ${r.worldMed}/${r.worldP95}/${r.worldMax}`
      + ` · detail ${r.detailMs} ms road ${r.roadMs} ms (built ${r.roadBuilt}, at once ${r.roadForced}) tiles ${r.tileMs} ms gc ${r.gcMs} noGround ${noGround} frames ${n}`
      + `\n                 world drawn ${r.calls} calls ${(r.tris / 1e6).toFixed(3)} M tris (terrain ${(r.trisTerrain / 1e6).toFixed(3)} inst ${(r.trisInstanced / 1e6).toFixed(3)} other ${(r.trisOther / 1e6).toFixed(3)})`
      + ` car ${r.carCalls} meshes ${r.carTris} tris | body jerk mm p95 ${r.jerkP95} max ${r.jerkMax} | worst: ${worst.slow}`);
  }
  world.group.clear();
}
async function teleport(world, R, rn) {
  let adds = 0; const add = world.add; world.add = td => { adds++; return add(td); };
  const cam = new THREE.Vector3(R.x, 0, R.z), still = new THREE.Vector3();
  const t0 = vnow(), world0 = [];
  let tGround = null, tAll = null, frames = 0, over20 = 0, f0 = t0;
  while (vnow() - t0 < 120000) {
    const fs0 = vnow();
    cam.y = (world.loadedAt(R.x, R.z) ? world.heightAt(R.x, R.z) : 0) + 3;
    world.updateLOD(cam, still, 0, { frameStart: fs0, renderMs: RENDER_MS }); world.updateShadows(cam);
    world0.push(vnow() - fs0);
    busyWait(RENDER_MS);
    if (tGround === null && world.loadedAt(R.x, R.z)) tGround = (vnow() - t0) / 1000;
    if (tGround !== null && frames > 30 && world.pendingTiles() === 0) { tAll = (vnow() - t0) / 1000; break; }
    const dt = await nextFrame(Math.max(PERIOD, GPU_MS)); frames++; if (dt > 20) over20++;
  }
  const w = world0.sort((a, b) => a - b);
  const r = { name: `teleport ${rn}`, route: rn, tGround: +(tGround ?? NaN).toFixed(2), tAll: +(tAll ?? NaN).toFixed(2), tiles: adds,
    tilesPerS: +(adds / ((tAll ?? (vnow() - t0) / 1000) || 1)).toFixed(2), frames, over20, over20pct: +(100 * over20 / (frames || 1)).toFixed(1),
    worldMed: +pct(w, .5).toFixed(2), worldP95: +pct(w, .95).toFixed(2), worst: +pct(w, 1).toFixed(1), worldTotal: +w.reduce((a, x) => a + x, 0).toFixed(0) };
  console.log(`${r.name.padEnd(18)} ground under in ${r.tGround} s, all ${r.tiles} tiles in ${r.tAll} s (${r.tilesPerS}/s) | frames ${frames}, >20 ms ${r.over20pct}%`
    + ` | world update med ${r.worldMed} p95 ${r.worldP95} worst ${r.worst} ms, total ${r.worldTotal} ms`);
  return r;
}
if (opt('out')) fs.writeFileSync(opt('out'), JSON.stringify({ src: SRC, args, results }, null, 1));
process.exit(0);

function compare(a, b) {
  const by = new Map(a.results.map(r => [r.name, r]));
  if (b.results[0]?.tGround !== undefined) {
    for (const r of b.results) { const o = by.get(r.name); if (o) console.log(r.name.padEnd(18), ['tGround', 'tAll', 'tiles', 'tilesPerS', 'over20pct', 'worldP95', 'worst', 'worldTotal'].map(k => `${k} ${o[k]}→${r[k]}`).join('  ')); }
    return;
  }
  const K = [['popN', 'pop n'], ['popMean', 'pop mean s'], ['popMax', 'pop max s'], ['tilesLate', 'tiles late'], ['median', 'cpu med'], ['p95', 'cpu p95'],
    ['worst', 'worst'], ['physMed', 'phys'], ['worldP95', 'world p95'], ['tris', 'M tris', x => (x / 1e6).toFixed(2)], ['calls', 'calls'], ['jerkP95', 'jerk p95']];
  console.log('run'.padEnd(18), K.map(k => k[1].padStart(13)).join(''));
  for (const r of b.results) {
    const o = by.get(r.name); if (!o) continue;
    console.log(r.name.padEnd(18), K.map(([k, , f = x => x]) => `${f(o[k])}→${f(r[k])}`.padStart(13)).join(''));
  }
}
