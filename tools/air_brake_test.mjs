// node tools/air_brake_test.mjs — fixed-wing speed brakes, flat-world physics + model/network contracts.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Jet, JET } from '../game/src/jet.js';
import { applyVehicleType } from '../game/src/vehicletypes.js';
import { disposeCosmeticPreview } from '../game/src/cosmetics.js';
import { speedBrakeDrag } from '../game/src/speedbrakes.js';
import { animState } from '../game/src/mp/net.js';
import { parseAnim, animAt, animate, bakeParts } from '../game/src/mp/remotes.js';

const world = {
  heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3,
  normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0), waterLevelAt: () => -Infinity,
  treesNear: () => {}, buildingsNear: () => [], loadedAt: () => true, extent: [-1e6, -1e6, 1e6, 1e6], spawn: [0, 0],
};
const dt = 1 / 120;
function make(type) {
  const j = new Jet(world, { ...JET }); disposeCosmeticPreview(applyVehicleType(j, type));
  j.input = { handbrake: false, jet: { thr: 0, pitch: 0, roll: 0, yaw: 0 } };
  return j;
}
function sane(j) {
  assert([...j.pos, ...j.vel, ...j.quat].every(Number.isFinite), 'finite state');
  assert.equal(j.mode, 'air', 'no crash at altitude');
}
function coast(type, brake, start, target) {
  const j = make(type); j.placeInAir(0, 5000, 0, 0, start); j.vel.set(0, 0, start / 3.6); j.throttle = 0;
  j.input.handbrake = brake;
  let reached = null;
  for (let n = 0; n < (type === 'blackbird' ? 600 : 120) / dt; n++) {
    j.step(dt, j.input); sane(j);
    if (reached === null && j.vel.length() * 3.6 <= target) reached = (n + 1) * dt;
    if (brake && j.vel.length() > Math.sqrt(j.t.gravity / (j.t.liftK * (j.t.cl0 + j.t.clA * j.t.stallA))) * 1.35) assert(!j.stall, 'brakes do not cause an above-stall-speed stall');
    if (reached !== null) break;
  }
  return { j, time: reached ?? Infinity };
}
function roll(type, spoilers) {
  const j = make(type); j.reset(0, 0, 0); j.v = Math.min(j.t.rotateKmh * 1.4, j.t.landKmh * .65) / 3.6; j.throttle = 0;
  j.input.handbrake = true;
  if (!spoilers) {
    j.stepGround = function (...args) { this.speedBrake = 0; return Jet.prototype.stepGround.apply(this, args); };
  }
  for (let n = 0; n < 30 / dt && j.v > .05; n++) {
    j.step(dt, j.input);
    assert.equal(j.mode, 'ground'); assert(Number.isFinite(j.v));
  }
  assert(j.v < .05, 'stopped on runway');
  return j.pos.z;
}
for (const [type, top, target] of [['fighter', 1700, 600], ['stealth', 1700, 600], ['blackbird', 3500, 600], ['prop', 250, 100], ['stunt', 400, 150]]) {
  const clean = coast(type, false, top, target), braked = coast(type, true, top, target);
  console.log(`${type}: ${top} → ${target} km/h clean ${clean.time.toFixed(2)} s, brakes ${braked.time.toFixed(2)} s`);
  assert(Number.isFinite(clean.time), 'idle coasting reaches the comparison speed');
  if (type === 'blackbird') assert(braked.time >= 9 && braked.time <= 12, 'Mach-3 deceleration in 9–12 seconds');
  else assert(braked.time >= 6 && braked.time <= 8, 'proportional deceleration in 6–8 seconds');
  assert(braked.time < clean.time * .5, 'brakes substantially faster than idle drag');
  // At the same attitude/speed, deployment adds a small nose-up tendency.
  const pitchClean = make(type), pitchBrake = make(type);
  for (const plane of [pitchClean, pitchBrake]) {
    plane.placeInAir(0, 5000, 0, 0, target); plane.throttle = 0;
  }
  pitchBrake.speedBrake = 1;
  pitchClean.stepAir(dt, pitchClean.input.jet, pitchClean.input);
  pitchBrake.stepAir(dt, pitchBrake.input.jet, pitchBrake.input);
  assert(pitchBrake.ang.x < pitchClean.ang.x, 'slight nose-up tendency');
  assert(pitchClean.ang.x - pitchBrake.ang.x < .01, 'pitch tendency remains slight');
  const j = braked.j;
  assert(j.hudInfo().includes('AIR BRAKE'));
  const brakeKey = make(type); brakeKey.reset(0, 0, 0); brakeKey.input.jet.brake = true;
  brakeKey.step(dt, brakeKey.input); assert(brakeKey.braking, 'existing jet brake input also deploys');
  const stall = Math.sqrt(j.t.gravity / (j.t.liftK * (j.t.cl0 + j.t.clA * j.t.stallA)));
  assert.equal(speedBrakeDrag(j.t, stall * 1.35), 0, 'no extra drag near stall');
  const full = coast(type, true, top, target).j;
  const dragOn = speedBrakeDrag(j.t, top / 3.6), dragHalf = speedBrakeDrag(j.t, top / 7.2);
  assert(dragOn >= dragHalf * 4 - 1e-9, 'drag scales with speed squared');
  const state = parseAnim(animState(full)); assert(state.ab, 'network flag sent');
  const off = parseAnim({ ...animState(full), ab: 0 });
  assert(animAt([{ t: 0, a: state }, { t: 100, a: off }], 10).ab);
  assert(!animAt([{ t: 0, a: state }, { t: 100, a: off }], 90).ab);
  const remote = make(type);
  const decoded = animAt([{ t: 0, a: state }], 0);
  animate(remote, decoded, { vf: 0, yawRate: 0 }, new THREE.Vector3(0, 0, 100), new THREE.Vector3(0, 0, 1), .4);
  assert.equal(remote.speedBrake, 1, 'remote deployment');
  bakeParts(remote.mesh); remote.interpolate(1); remote.syncMesh(dt);
  let open = 0; remote.mesh.traverse(o => { if (o.name === 'speed-brake' && (Math.abs(o.rotation.x) > .5 || Math.abs(o.rotation.z) > .5)) open++; });
  assert(open >= 2, 'hinged panels animate after multiplayer geometry batching');
  for (let n = 0; n < 60; n++) { j.input.handbrake = false; j.step(dt, j.input); }
  assert.equal(j.speedBrake, 0, 'release retracts'); assert(!j.hudInfo().includes('AIR BRAKE'));
  j.reset(0, 0, 0); assert.equal(j.speedBrake, 0);
  const cleanRoll = roll(type, false), brakeRoll = roll(type, true);
  console.log(`  landing roll wheel brakes ${cleanRoll.toFixed(1)} m, with spoilers ${brakeRoll.toFixed(1)} m`);
  assert(brakeRoll < cleanRoll * .95, 'spoilers shorten landing roll');
}
const stealthTop = coast('stealth', true, 2170, 760);
console.log(`stealth: 2170 → 760 km/h brakes ${stealthTop.time.toFixed(2)} s`);
assert(stealthTop.time > 4 && stealthTop.time < 8, 'stealth top-speed deceleration');
assert(!parseAnim({ w: [0] }).ab, 'older clients default retracted');
console.log('PASS: fixed-wing air brakes');
