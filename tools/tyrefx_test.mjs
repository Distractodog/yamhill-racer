// Tyre effects (effects.js + fxpool.js) in Node, no browser: the pools' hard caps, reuse and lifetimes, the mark
// ribbon (joined at any speed, broken on a jump), and the real car / bike on flat worlds: drift smoke on asphalt,
// burnout, dirt / gravel dust + chips, grass clippings, water spray + rings, wheel blur at speed, 4 cars drifting at
// once (cap held, per-frame cost). Run: node tools/tyrefx_test.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PuffPool, ChipPool, MarkStrip, PUFF_A, RING, DROP } from '../game/src/fxpool.js';
import { Effects, FX_CAPS } from '../game/src/effects.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { Bike, BIKE } from '../game/src/bike.js';

const fin = a => Array.prototype.every.call(a, Number.isFinite);
const base = { y: 0, vx: 0, vy: 0, vz: 0, size: 1, grow: 1, rot: 0, spin: 0, alpha: 0.5, r: 1, g: 1, b: 1, ground: 0, drag: 1, lift: 0.3, kind: PUFF_A };

// ---------------------------------------------------------------- PuffPool: cap, reuse, lifetimes, alpha, sort
{
  const P = new PuffPool(100);
  for (let i = 0; i < 250; i++) P.spawn({ ...base, x: i, z: 0, life: 1 + (i % 10) * 0.2 });
  assert.equal(P.n, 100, 'never more than the cap alive'); assert.equal(P.reused, 150, 'past the cap: live ones reused');
  assert.equal(new Set(P.alive.subarray(0, P.n)).size, 100, 'each slot listed once');
  let maxA = 0, steps = 0;
  const size0 = P.size[P.alive[0]];
  while (P.n && steps < 1000) {
    P.step(1 / 60); steps++;
    for (let k = 0; k < P.n; k++) { const a = P.alpha(P.alive[k]); assert.ok(a >= 0 && a <= 0.5 + 1e-6); maxA = Math.max(maxA, a); }
    if (steps === 30) assert.ok(P.size[P.alive[0]] > size0, 'puffs grow');
  }
  assert.ok(steps <= Math.ceil(2.8 * 60) + 1, `all gone by their longest life (${steps} frames)`);
  assert.equal(P.nFree, 100, 'every slot back in the free list');
  assert.ok(maxA > 0.3, 'faded in');
  for (let i = 0; i < 50; i++) P.spawn({ ...base, x: Math.random() * 100, z: Math.random() * 100, life: 2 });
  P.sort(50, 0, 50);
  const d = k => { const i = P.alive[k]; return (P.x[i] - 50) ** 2 + P.y[i] ** 2 + (P.z[i] - 50) ** 2; };
  for (let k = 1; k < P.n; k++) assert.ok(d(k - 1) >= d(k) - 1e-6, 'sorted back to front');
  // smoke settles on its ground; drops land (callback) and die; rings stay flat where they are
  P.clear(); const landed = [];
  const s = P.spawn({ ...base, x: 0, z: 0, y: 0.1, vy: -5, life: 2 }), dr = P.spawn({ ...base, x: 1, z: 0, y: 0.5, vy: 3, lift: -16, life: 3, kind: DROP });
  const rg = P.spawn({ ...base, x: 2, z: 0, y: 0.03, drag: 0, lift: 0, life: 1, kind: RING });
  for (let i = 0; i < 60; i++) P.step(1 / 60, i => landed.push(i));
  assert.ok(P.y[s] >= P.size[s] * 0.2 - 1e-6, 'smoke never sinks into the ground');
  assert.deepEqual(landed, [dr], 'the drop landed once'); assert.ok(P.life[dr] <= 0, 'and is gone');
  assert.ok(Math.abs(P.y[rg] - 0.03) < 1e-6, 'ring stays on the water');
  console.log(`PuffPool: cap 100 held over 250 spawns (${P.reused} reused), gone after ${steps} frames, sorted, drops land`);
}

// ---------------------------------------------------------------- ChipPool: gravity, one bounce, rest, shrink, cap
{
  const C = new ChipPool(50, 20);
  for (let i = 0; i < 80; i++) C.spawn({ x: 0, y: 0.1, z: 0, vx: 3, vy: 5, vz: 0, life: 1.4, size: 0.05, flat: 0.5, ax: 0, ay: 0, wx: 10, wy: 10, r: 1, g: 1, b: 1, ground: 0, drag: 0.3 });
  assert.equal(C.n, 50); assert.equal(C.reused, 30);
  let top = 0, bounced = 0;
  for (let f = 0; f < 120 && C.n; f++) {
    C.step(1 / 60);
    for (let k = 0; k < C.n; k++) { const i = C.alive[k]; top = Math.max(top, C.y[i]); assert.ok(C.y[i] >= 0, 'never under the ground'); bounced += C.bounced[i]; }
  }
  assert.ok(top > 0.5 && top < 1.0, `thrown up and falls back (top ${top.toFixed(2)} m)`);
  assert.ok(bounced > 0, 'bounces'); assert.equal(C.n, 0, 'settle and vanish within their life');
  console.log(`ChipPool: cap 50 held, up ${top.toFixed(2)} m, bounce, settle, gone`);
}

// ---------------------------------------------------------------- MarkStrip: one joined ribbon at any speed
{
  const M = new MarkStrip(1000), t = MarkStrip.trail();
  const at = (s, v) => [...M.pos.subarray(s * 12 + v * 3, s * 12 + v * 3 + 3)];
  // a 30 m-radius arc at 200 km/h and 30 fps (1.85 m a frame): every quad starts exactly where the last one ended
  const R = 30, step = 55.5 / 30 / R;
  for (let k = 0; k < 40; k++) M.add(t, R * Math.sin(k * step), 0.04, R - R * Math.cos(k * step), 0.15, 0.9, 0, 0, 0, k, 0, 0.35, 55.5 / 30 * 2.5 + 1);
  assert.equal(M.total, 39, 'one quad per frame, no frame skipped');
  for (let s = 1; s < M.total; s++) {
    assert.deepEqual(at(s, 0), at(s - 1, 2), 'joined (left)'); assert.deepEqual(at(s, 1), at(s - 1, 3), 'joined (right)');
    const w = Math.hypot(at(s, 0)[0] - at(s, 1)[0], at(s, 0)[2] - at(s, 1)[2]);
    assert.ok(w > 0.29 && w < 0.3 + 1e-4, `even width at the corners (${w.toFixed(3)})`);
  }
  assert.equal(M.info[0], 0, 'a new mark starts at alpha 0 (tapers in)'); assert.ok(Math.abs(M.info[8] - 0.9) < 1e-6, 'then full');
  const before = M.total;
  M.add(t, 500, 0.04, 500, 0.15, 0.9, 0, 0, 0, 50, 0);              // teleport / jump: a new mark, nothing drawn across
  M.add(t, 500.2, 0.04, 500, 0.15, 0.9, 0, 0, 0, 50, 0);            // too short a step: waits
  assert.equal(M.total, before, 'no quad across the gap, none for a tiny step');
  const W = new MarkStrip(10), u = MarkStrip.trail();
  for (let k = 0; k < 30; k++) W.add(u, k, 0, 0, 0.1, 1, 0, 0, 0, k, 0);
  assert.equal(W.total, 29); assert.ok(fin(W.pos), 'ring buffer wraps');
  const d = W.takeDirty(); assert.ok(d && d[0] >= 0 && d[0] + d[1] <= 10); assert.equal(W.takeDirty(), null);
  console.log('MarkStrip: joined at 200 km/h / 30 fps, even width, taper, breaks on a jump, wraps');
}

// ---------------------------------------------------------------- real vehicles on flat worlds through Effects
const flat = (surface = 3) => ({ heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => surface,
  normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0), waterLevelAt: () => -Infinity,
  treesNear: () => {}, buildingsNear: () => [], loadedAt: () => true, extent: [-1e7, -1e7, 1e7, 1e7] });
const STEP = 1 / 120, FRAME = 1 / 60;
function vehicle(kind = 'car', surface = 3) {
  const v = kind === 'car' ? new Car(flat(surface), { ...TUNING_DEFAULTS }) : new Bike(flat(surface), { ...BIKE });
  v.reset(0, 0, 0); v.input = { throttle: 0, brake: 0, steer: 0, handbrake: false, lean: false }; return v;
}
// one frame: two physics steps, draw, effects; control(t, input, v) sets the input
function frame(fx, v, control, t) {
  control(t, v.input, v);
  for (let k = 0; k < 2; k++) { v.savePrev?.(); v.step(STEP, v.input); }
  v.interpolate?.(1); v.syncMesh(FRAME); v.mesh.updateMatrixWorld(true);
  fx.drive(FRAME, v);
}
function run(fx, v, seconds, control, t0 = 0) { for (let t = 0; t < seconds; t += FRAME) { frame(fx, v, control, t0 + t); fx.advance(FRAME); } }
const kind = (fx, k) => { const P = fx.puffs; let n = 0; for (let j = 0; j < P.n; j++) if (P.kind[P.alive[j]] === k || (k === PUFF_A && P.kind[P.alive[j]] === 1)) n++; return n; };
const speedUp = (s, u) => (t, i, v) => { i.throttle = v.vel.length() < s ? 1 : 0; i.steer = 0; i.handbrake = false; i.brake = 0; void u; };
const drift = (t, i) => { i.throttle = 1; i.steer = 0.8; i.handbrake = t < 0.6; i.brake = 0; };

{ // asphalt: a handbrake drift lays dark marks and white-grey smoke that hangs 1.5–3 s, then fades away
  const scene = new THREE.Scene(), fx = new Effects(scene, { shadows: false }), v = vehicle('car', 3);
  run(fx, v, 0.6, speedUp(30)); const launch = fx.stats().puffs;
  run(fx, v, 3.2, speedUp(30));
  assert.ok(launch > 0, `a hard launch smokes a little (${launch})`);
  assert.equal(fx.stats().puffs, 0, 'cruising straight on asphalt: no smoke');
  const m0 = fx.stats().marks;
  run(fx, v, 1.5, drift);
  const smoke = kind(fx, PUFF_A), marks = fx.stats().marks - m0;
  assert.ok(v.drifting || v.slip > 0.2, 'the car really slid');
  assert.ok(smoke > 30, `drift smoke (${smoke} puffs)`); assert.ok(marks > 20, `drift marks (${marks} quads)`);
  const P = fx.puffs; let grey = true;
  for (let j = 0; j < P.n; j++) { const i = P.alive[j]; if (Math.abs(P.r[i] - P.b[i]) > 0.05 || P.r[i] < 0.6) grey = false; }
  assert.ok(grey, 'white-grey on asphalt');
  const markA = Math.max(...Array.from({ length: marks }, (_, k) => fx.marksBuf.info[((m0 + k) % FX_CAPS.marks) * 16 + 8]));
  assert.ok(markA > 0.7, `dark drift marks (alpha ${markA.toFixed(2)})`);
  const coast = (t, i) => { i.throttle = 0; i.steer = 0; i.handbrake = false; i.brake = 0; };
  run(fx, v, 1.3, coast);
  const hanging = kind(fx, PUFF_A);
  run(fx, v, 2.5, coast);
  assert.ok(hanging > 10, `smoke still hangs 1.3 s later (${hanging})`); assert.equal(kind(fx, PUFF_A), 0, 'all faded 3.8 s later');
  assert.ok(fin(fx.iA.array) && fin(fx.iB.array) && fin(fx.iC.array) && fin(fx.marksBuf.pos), 'no NaN');
  // a stop from speed marks all four tyres, darker the harder you brake
  const stop = pedal => {
    const v2 = vehicle('car', 3), fx2 = new Effects(new THREE.Scene(), { shadows: false });
    run(fx2, v2, 3, speedUp(35)); const b0 = fx2.stats().marks;
    run(fx2, v2, 0.6, (t, i) => { i.throttle = 0; i.brake = pedal; });
    const n = fx2.stats().marks - b0;
    return { n, a: Math.max(...Array.from({ length: n }, (_, k) => fx2.marksBuf.info[(b0 + k) * 16 + 8])) };
  };
  const hard = stop(1), soft = stop(0.3);
  assert.ok(hard.n > 8 && soft.n > 8, `braking marks (${hard.n} / ${soft.n} quads)`);
  assert.ok(hard.a > 0.85 && hard.a > soft.a + 0.15, `darker when braking hard (${hard.a.toFixed(2)} vs ${soft.a.toFixed(2)})`);
  console.log(`asphalt: drift ${smoke} puffs + ${marks} mark quads (alpha ${markA.toFixed(2)}), ${hanging} hang 1.3 s on, all gone by 3.8 s; braking marks alpha ${hard.a.toFixed(2)} hard / ${soft.a.toFixed(2)} light`);
}

{ // burnout: gas + brake standing still: denser smoke than the drift, the rear wheels blur
  const fx = new Effects(new THREE.Scene(), { shadows: false }), v = vehicle('car', 3);
  run(fx, v, 1.5, (t, i) => { i.throttle = 1; i.brake = 1; i.steer = 0; });
  const smoke = kind(fx, PUFF_A), speed = v.vel.length();
  assert.ok(speed < 7, `held nearly still (${speed.toFixed(1)} m/s)`);
  assert.ok(smoke > 120, `burnout smoke (${smoke} puffs in 1.5 s)`);
  frame(fx, v, (t, i) => { i.throttle = 1; i.brake = 1; }, 2);
  assert.ok(fx.discN >= 4, `spinning rear wheels blur (${fx.discN} discs)`); fx.advance(FRAME);
  console.log(`burnout: ${smoke} puffs in 1.5 s at ${speed.toFixed(1)} m/s, ${fx.discs.count} blur discs`);
}

{ // dirt and gravel: brown / grey dust clouds and flying chips; grass: green clippings + light dust
  const out = {};
  for (const [name, surf] of [['dirt', 2], ['gravel', 4], ['grass', 0]]) {
    const fx = new Effects(new THREE.Scene(), { shadows: false }), v = vehicle('car', surf);
    run(fx, v, 3, speedUp(25)); run(fx, v, 1, drift);
    const P = fx.puffs, C = fx.chips; let r = 0, g = 0, b = 0;
    for (let j = 0; j < P.n; j++) { const i = P.alive[j]; r += P.r[i]; g += P.g[i]; b += P.b[i]; }
    let cg = 0; for (let j = 0; j < C.n; j++) { const i = C.alive[j]; cg += C.g[i] > C.r[i] ? 1 : 0; }
    out[name] = { dust: P.n, chips: C.n, warm: r > b * 1.15, green: C.n && cg / C.n > 0.6, marks: fx.stats().marks };
    assert.ok(P.n > 20 && C.n > 15, `${name}: dust ${P.n}, chips ${C.n}`);
    assert.ok(out[name].marks > 30, `${name}: ruts (${out[name].marks})`);
    assert.ok(fin(fx.chipMesh.instanceMatrix.array.subarray(0, C.n * 16)), 'chip matrices finite');
  }
  assert.ok(out.dirt.warm && out.gravel.warm, 'dirt / gravel dust is tinted, not white');
  assert.ok(out.grass.green && !out.dirt.green, 'grass throws green clippings');
  assert.ok(out.grass.dust < out.dirt.dust, 'less dust on grass');
  console.log('loose ground:', JSON.stringify(out));
}

{ // water: skimming throws spray drops, landing drops and the entry leave splash rings
  const fx = new Effects(new THREE.Scene(), { shadows: false }), v = vehicle('car', 3);
  run(fx, v, 2, speedUp(25));
  const wet = () => { v.onWater = true; v.waterDepth = 0.2; v.wheels.forEach(w => { w.surf = 5; w.contact = true; }); };
  for (let t = 0; t < 0.6; t += FRAME) { v.pos.addScaledVector(v.vel, FRAME); v.renderPos.copy(v.pos); wet(); fx.drive(FRAME, v); fx.advance(FRAME); }
  const drops = kind(fx, DROP), rings = kind(fx, RING);
  assert.ok(drops > 30, `spray (${drops} drops)`); assert.ok(rings >= 3, `splash rings (${rings})`);
  console.log(`water: ${drops} drops, ${rings} rings`);
}

{ // wheel blur: none at 30 km/h, all wheels (two sides each) at 200 km/h; a bike too
  const fx = new Effects(new THREE.Scene(), { shadows: false }), v = vehicle('car', 3);
  run(fx, v, 1.5, speedUp(30 / 3.6));
  frame(fx, v, speedUp(30 / 3.6), 0); const slow = fx.discN; fx.advance(FRAME);
  run(fx, v, 12, speedUp(200 / 3.6));
  frame(fx, v, speedUp(200 / 3.6), 0); const fast = fx.discN, alpha = fx.discA.array[0]; fx.advance(FRAME);
  assert.equal(slow, 0, 'no blur at 30 km/h'); assert.equal(fast, 8, `4 wheels × 2 sides blurred at ${(v.vel.length() * 3.6).toFixed(0)} km/h`);
  assert.ok(alpha > 0.8, `nearly opaque (${alpha.toFixed(2)})`); assert.equal(fx.discs.count, 8);
  const b = vehicle('bike', 3), fb = new Effects(new THREE.Scene(), { shadows: false });
  run(fb, b, 10, speedUp(200 / 3.6)); frame(fb, b, speedUp(200 / 3.6), 0);
  assert.equal(fb.discN, 4, `bike: 2 wheels × 2 sides (${(b.vel.length() * 3.6).toFixed(0)} km/h)`); fb.advance(FRAME);
  run(fb, b, 1, drift);
  assert.ok(fb.stats().marks > 5 && kind(fb, PUFF_A) > 5, `bike rear slide: marks ${fb.stats().marks}, smoke ${kind(fb, PUFF_A)}`);
  console.log(`wheel blur: ${slow} discs at 30 km/h, ${fast} at 200 (alpha ${alpha.toFixed(2)}); bike ${fb.discs.count}`);
}

{ // 4 cars drifting at once through one Effects (like mp/remotes.js): cap held, cost per frame
  const scene = new THREE.Scene(), fx = new Effects(scene, { shadows: false });
  const cars = [0, 1, 2, 3].map(k => { const v = vehicle('car', k % 2 ? 4 : 3); v.reset(k * 40, 0, 0); return { v, st: Effects.vehicleState() }; });
  const control = (t, i, v) => { const fast = v.vel.length() > 22; i.throttle = 1; i.steer = fast || v.drifting ? 0.9 : 0; i.handbrake = fast && !v.drifting; i.brake = 0; };
  const ms = []; let maxPuffs = 0, maxChips = 0;
  for (let f = 0; f < 900; f++) {
    for (const { v } of cars) { control(f * FRAME, v.input, v); for (let k = 0; k < 2; k++) { v.savePrev?.(); v.step(STEP, v.input); } v.interpolate?.(1); v.syncMesh(FRAME); v.mesh.updateMatrixWorld(true); }
    const t0 = performance.now();                             // timed: the effects only (physics is not theirs)
    for (const c of cars) { const keep = {}; for (const k in c.st) { keep[k] = fx[k]; fx[k] = c.st[k]; } fx.drive(FRAME, c.v); for (const k in c.st) { c.st[k] = fx[k]; fx[k] = keep[k]; } }
    fx.advance(FRAME); ms.push(performance.now() - t0);
    maxPuffs = Math.max(maxPuffs, fx.puffs.n); maxChips = Math.max(maxChips, fx.chips.n);
  }
  const fxMs = ms.slice(300).sort((x, y) => x - y)[300];
  assert.ok(cars.every(c => c.v.drifting || c.v.slip > 0.2), 'all four drifting');
  assert.ok(maxPuffs <= FX_CAPS.puffs && maxChips <= FX_CAPS.chips, `caps held (${maxPuffs}/${FX_CAPS.puffs} puffs, ${maxChips}/${FX_CAPS.chips} chips)`);
  assert.ok(maxPuffs > 300, `plenty of smoke (${maxPuffs})`);
  assert.ok(fxMs < 1, `effects cost ${fxMs.toFixed(3)} ms a frame for 4 drifting cars (Node; limit 1 ms)`);
  assert.ok(fin(fx.iA.array) && fin(fx.iB.array) && fin(fx.iC.array) && fin(fx.marksBuf.pos), 'no NaN');
  fx.dispose(); assert.equal(scene.children.length, 0, 'dispose removes everything');
  console.log(`4 cars drifting: peak ${maxPuffs} puffs / ${maxChips} chips, effects ${fxMs.toFixed(3)} ms a frame (median, Node)`);
}
console.log('PASS tyrefx: pools capped with lifetimes, joined marks, drift / burnout / dirt / gravel / grass / water, wheel blur, 4-car cost');
