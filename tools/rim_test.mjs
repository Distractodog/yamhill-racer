// Optional circular boundary regression. Node runs real vehicle physics; no tiles rebuilt.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { makeRim } from '../game/src/rim.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { Bike } from '../game/src/bike.js';
import { Jet } from '../game/src/jet.js';
import { Glider, BIKE_GLIDER } from '../game/src/glider.js';
import { makeTrack } from '../game/src/track.js';

const circle = { cx: 0, cz: 0, r: 3000 }, rim = makeRim(circle), DT = 1 / 120;
const world = () => ({ heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3,
  waterLevelAt: () => -Infinity, normalAt: (_x, _z, n) => n.set(0, 1, 0),
  treesNear() {}, buildingsNear: () => [], loadedAt: () => true,
  mapContains: () => true, extent: [-100000, -100000, 100000, 100000], spawn: [0, 0], rampAt: () => null });
const create = (kind, W = world()) => kind === 'car' ? new Car(W, { ...TUNING_DEFAULTS }) : kind === 'bike' ? new Bike(W) : new Jet(W);
const input = { throttle: 1, brake: 0, steer: 0, handbrake: false, lean: false,
  jet: { thr: 0, pitch: 0, roll: 0, yaw: 0, hold: false } };
assert.equal(makeRim(undefined), null); assert.equal(makeRim(null), null);
for (const bad of [{}, { cx: 0, cz: 0, r: 0 }, { cx: NaN, cz: 0, r: 3 }, { cx: 0, cz: Infinity, r: 3 }]) {
  assert.throws(() => makeRim(bad), RangeError);
}
let trials = 0;
for (const kind of ['car', 'bike', 'jet', 'car-glider', 'bike-glider']) {
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    const base = kind.split('-')[0], v = create(base), flying = kind.includes('glider') || kind === 'jet';
    const nx = Math.sin(angle), nz = Math.cos(angle), tx = nz, tz = -nx;
    const yaw = Math.atan2(nx + tx * 3, nz + tz * 3), speed = (kind === 'jet' ? 1200 : flying ? 150 : 300) / 3.6;
    if (kind === 'jet') v.placeInAir(nx * 2975, 2000, nz * 2975, yaw, speed * 3.6);
    else {
      v.reset(nx * 2975, nz * 2975, yaw);
      v.vel.set(Math.sin(yaw) * speed, 0, Math.cos(yaw) * speed);
      if (flying) {
        v.pos.y = 2000; v.grounded = false; v.airTime = 1;
        new Glider(v, base === 'bike' ? BIKE_GLIDER : {}).deploy();
      }
    }
    let hits = 0, maxRadius = 0;
    for (let i = 0; i < 360; i++) {
      v.step(DT, input);
      const before = v.quat.toArray(), vertical = v.vel.y;
      if (rim.constrain(v) > 0) hits++;
      assert.deepEqual(v.quat.toArray(), before, 'rim must not rotate/flip the vehicle');
      assert.equal(v.vel.y, vertical, 'rim must preserve vertical speed');
      const radius = Math.hypot(v.pos.x, v.pos.z); maxRadius = Math.max(maxRadius, radius);
      assert(radius <= circle.r && Number.isFinite(radius), `${kind} escaped rim`);
      if (!flying) assert(1 - 2 * (v.quat.x ** 2 + v.quat.z ** 2) > 0, `${kind} flipped`);
      if (kind.includes('glider')) assert(v.glide.active, 'glider must remain flying');
    }
    assert(hits > 0, `${kind} fixture must actually hit wall`);
    const radius = Math.hypot(v.pos.x, v.pos.z), tangential = Math.abs(v.vel.x * v.pos.z / radius - v.vel.z * v.pos.x / radius);
    if (!flying) assert(tangential > 1, `${kind} stopped instead of sliding`);
    console.log(`PASS ${kind} ${(angle * 180 / Math.PI).toFixed(0)}deg: ${hits} wall contacts, max r=${maxRadius.toFixed(3)}, tangent=${tangential.toFixed(2)} m/s`);
    trials++;
  }
}
// Production-size translated circle uses the same code, without enabling it in the map manifest.
const production = makeRim({ cx: 9000, cz: -5000, r: 17200 }), translated = create('car');
translated.pos.set(30000, 100, -5000); translated.vel.set(1000 / 3.6, 0, 30);
production.constrain(translated);
assert(production.contains(translated.pos.x, translated.pos.z));
assert.equal(translated.pos.z, -5000); assert.equal(translated.vel.x, 0); assert.equal(translated.vel.z, 30);
// Exact impact decomposition, including an inward-moving outside save.
const v = create('car'); v.pos.set(3100, 500, 0); v.vel.set(20, -3, 40);
assert.equal(rim.constrain(v), 20); assert.equal(v.vel.x, 0); assert.equal(v.vel.z, 40); assert.equal(v.pos.y, 500);
v.pos.x = 3100; v.vel.x = -20; rim.constrain(v); assert.equal(v.vel.x, -20);
// Old safe spots, last-loaded recovery, home and interpolation cannot reintroduce outside points.
for (const kind of ['car', 'bike', 'jet']) {
  const v = create(kind); v.reset(0, 0, 0);
  v.safe = [[5000, 0, 0], [0, -5000, Math.PI]]; v._lastLoaded = [5000, 0]; v.world.spawn = [5000, 0];
  v.prevPos.set(5000, 10, 0); v.renderPos.set(0, 10, 5000); rim.constrain(v);
  for (const p of [...v.safe, v._lastLoaded, v.world.spawn]) assert(rim.contains(p[0], p[1]));
  assert(rim.contains(v.prevPos.x, v.prevPos.z)); assert(rim.contains(v.renderPos.x, v.renderPos.z));
  v.resetToSafe(); assert(rim.contains(v.pos.x, v.pos.z));
  v.reset(...v.world.spawn, 0); assert(rim.contains(v.pos.x, v.pos.z));
}
const racer = create('car'); racer.reset(2970, 0, Math.PI / 4); racer.vel.set(40, 0, 40);
const track = makeTrack(Array.from({ length: 101 }, (_, i) => [2970, -200 + i * 4, 8]));
for (let i = 0; i < 360; i++) {
  racer.step(DT, input); track.constrain(racer); rim.constrain(racer);
  assert(rim.contains(racer.pos.x, racer.pos.z)); assert(Math.abs(racer.pos.x - 2970) <= 9.5);
}
// Measure enabled wall+safe-list overhead only; this is NOT a browser FPS claim.
const bench = create('car'); bench.reset(0, 0, 0); bench.safe = Array.from({ length: 200 }, () => [0, 0, 0]);
for (let i = 0; i < 10000; i++) rim.constrain(bench);
const n = 100000, start = performance.now();
for (let i = 0; i < n; i++) rim.constrain(bench);
const ms = (performance.now() - start) / n;
const hitStart = performance.now();
for (let i = 0; i < n; i++) { bench.pos.x = 3100; bench.vel.x = 100; rim.constrain(bench); }
const hitMs = (performance.now() - hitStart) / n;
assert(Math.max(ms, hitMs) <= 0.05, `Node rim overhead exceeds 0.05 ms`);
console.log(`PASS ${trials} real-vehicle circle fixtures, safe/home/interpolation recovery, challenge walls; Node mean inside=${ms.toFixed(6)}, impact=${hitMs.toFixed(6)} ms/step (browser FPS not measured)`);
