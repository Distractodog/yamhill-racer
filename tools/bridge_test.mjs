// Synthetic bridge/underpass regression: real tile queries and vehicle physics, no assets or browser.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeTileData, makeWorld, BRIDGE_CLIMB } from '../game/src/data.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';

const DT = 1 / 120, T = 256, TX = 100, TZ = 100, X = TX * T, Z = TZ * T;
const input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
const deck = (x, z) => 12 + 0.02 * (z - Z) + 0.03 * (x - X);
function fixture(bridge = true) {
  const W = { tile: T, hstep: 2, hn: T / 2 + 1, hm: 2, tiles: [[TX, TZ]],
    extent: [X - T / 2, Z - T / 2, X + T / 2, Z + T / 2], spawn: [X, Z] };
  const N = W.hn + 2 * W.hm, H = new Float32Array(N * N), P = new Uint16Array(N * N);
  const S = new Uint8Array(T * T);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const z = -T / 2 - W.hm * W.hstep + i * W.hstep;
    if (Math.abs(z - 40) <= 12) { H[i * N + j] = -2; P[i * N + j] = 1; }
  }
  for (let i = 0; i < T; i++) if (Math.abs(i - T / 2 - 40) <= 12) S.fill(5, i * T, (i + 1) * T);
  const paths = [
    { kind: 'gravel', w: 14, pts: [[X - 110, Z - 40], [X + 110, Z - 40]], yc: [[0, 0], [0, 0]] },
    { kind: 'asphalt', w: 14, bridge, pts: [[X, Z - 110], [X, Z + 110]], yc: [[9.8, 0.03], [14.2, 0.03]] },
  ];
  const td = makeTileData(W, TX, TZ, { hbuf: H.buffer, pbuf: P.buffer, sbuf: S.buffer,
    tbuf: new ArrayBuffer(0), tile: { paths, physPaths: paths, rivers: { 1: 0.5 } } });
  const world = makeWorld(W); world.add(td); return world;
}
const near = (actual, expected, label, eps = 1e-8) => assert.ok(Math.abs(actual - expected) < eps, `${label}: ${actual} vs ${expected}`);
function queries(world) {
  const x = X + 4, z = Z - 40, h = deck(x, z);
  near(world.heightAt(x, z), h, 'placement uses highest deck');
  near(world.heightAt(x, z, h - BRIDGE_CLIMB), h, 'climb threshold inclusive');
  near(world.heightAt(x, z, h - BRIDGE_CLIMB - 0.001), 0, 'below local cross-sloped deck');
  near(world.groundAt(x, z, 0), 0, 'groundAt forwards height');
  assert.equal(world.surfaceAt(x, z, 0), 4, 'lower road surface');
  assert.equal(world.surfaceAt(x, z, h), 3, 'deck surface');
  assert.equal(world.surfaceAt(X, Z + 40, 0), 5, 'river surface under deck');
  near(world.heightAt(X, Z + 40, 0), -2, 'river bed under deck');
  near(world.waterLevelAt(X, Z + 40), 0.5, 'river water preserved');
  const n = world.normalAt(x, z, new THREE.Vector3(), h);
  assert.ok(n.distanceTo(new THREE.Vector3(-0.03, 1, -0.02).normalize()) < 1e-8, 'deck normal includes both slopes');
  assert.ok(world.normalAt(x, z).distanceTo(n) < 1e-8, 'highest deck normal without y');
  assert.ok(world.normalAt(x, z, new THREE.Vector3(), 0).distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-8, 'terrain normal below deck');
  // Check the derivative away from the centreline, and next to the river bank below it.
  for (const dz of [-40, 27, 40]) {
    const px = X + 3, pz = Z + dz, py = deck(px, pz), e = 0.001;
    const expected = new THREE.Vector3(
      (world.heightAt(px - e, pz, py) - world.heightAt(px + e, pz, py)) / (2 * e), 1,
      (world.heightAt(px, pz - e, py) - world.heightAt(px, pz + e, py)) / (2 * e)).normalize();
    assert.ok(world.normalAt(px, pz, new THREE.Vector3(), py).distanceTo(expected) < 1e-7, 'normal matches deck height derivative');
  }
}
function carAt(world, x, z, yaw) {
  const car = new Car(world, { ...TUNING_DEFAULTS }); car.reset(x, z, yaw); return car;
}
function finite(car) {
  assert.ok([...car.pos, ...car.vel, ...car.quat].every(Number.isFinite), 'finite vehicle state');
  assert.ok(new THREE.Vector3(0, 1, 0).applyQuaternion(car.quat).y > 0.9, 'upright');
}
function underpass(world) {
  const car = carAt(world, X - 45, Z - 40, Math.PI / 2);
  for (let i = 0; i < 240; i++) car.step(DT, input);
  car.vel.set(100 / 3.6, 0, 0);
  let jump = 0, peak = car.pos.y, prev = car.pos.y, steps = 0;
  while (car.pos.x < X + 45 && steps++ < 720) {
    car.step(DT, { ...input, throttle: car.vel.length() * 3.6 < 100 ? 1 : 0 }); finite(car);
    jump = Math.max(jump, Math.abs(car.pos.y - prev)); prev = car.pos.y; peak = Math.max(peak, prev);
    assert.equal(world.heightAt(car.pos.x, car.pos.z, car.pos.y), 0, 'remains over lower road');
  }
  assert.ok(car.pos.x >= X + 45, 'crossed under entire deck');
  assert.ok(jump < 0.5 && peak < 1.5, `underpass: jump ${jump}, peak ${peak}`);
  console.log(`underpass at 100 km/h: max height jump ${jump.toFixed(4)} m, peak ${peak.toFixed(3)} m`);
}
function overpass(world) {
  const car = carAt(world, X, Z - 90, 0);
  for (let i = 0; i < 240; i++) car.step(DT, input);
  car.vel.set(0, 0, 100 / 3.6);
  let min = Infinity, max = -Infinity, steps = 0;
  while (car.pos.z < Z + 85 && steps++ < 1200) {
    car.step(DT, { ...input, throttle: car.vel.length() * 3.6 < 100 ? 1 : 0 }); finite(car);
    const clearance = car.pos.y - deck(car.pos.x, car.pos.z);
    min = Math.min(min, clearance); max = Math.max(max, clearance);
    assert.ok(Math.abs(car.pos.x - X) < 6, 'stays inside deck width');
    assert.ok(clearance > 0 && clearance < 1.5, `stays on deck: clearance ${clearance}`);
  }
  assert.ok(car.pos.z >= Z + 85, 'crossed lower road and river on deck');
  console.log(`over deck at 100 km/h: body clearance ${min.toFixed(3)}–${max.toFixed(3)} m`);
}
function river(world) {
  const car = carAt(world, X, Z + 40, 0); car.pos.y = 4; car.vel.set(0, -1, 0);
  let peak = car.pos.y, wet = false;
  for (let i = 0; i < 600; i++) {
    car.step(DT, input); finite(car); peak = Math.max(peak, car.pos.y); wet ||= car.waterDepth > 0;
    assert.ok(car.pos.y < deck(car.pos.x, car.pos.z) - BRIDGE_CLIMB, 'never snapped onto deck');
  }
  assert.ok(wet && car.waterDepth > 0 && car.pos.y < world.waterLevelAt(car.pos.x, car.pos.z), 'stays submerged in river');
  assert.ok(peak <= 4, 'drop did not launch upward');
  console.log(`river drop: final body y ${car.pos.y.toFixed(3)} m, water depth ${car.waterDepth.toFixed(3)} m`);
}
const worlds = [true, 'truss'].map(bridge => {
  const world = fixture(bridge); queries(world);
  console.log(`PASS: bridge=${JSON.stringify(bridge)} query thresholds, surfaces, water and normals`);
  return world;
});
for (const world of worlds) { underpass(world); overpass(world); river(world); }
console.log('PASS: bridge queries and car physics');
