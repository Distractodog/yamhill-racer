// Real vehicle physics on an isolated flat road: no scenery or driver corrections hide grip changes.
// Run through the heavy gate; all car/bike types, both speeds, all surface classes, aircraft and host weather.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { Bike, BIKE } from '../game/src/bike.js';
import { Jet, JET } from '../game/src/jet.js';
import { VEHICLE_TYPES, applyVehicleType } from '../game/src/vehicletypes.js';
import { disposeCosmeticPreview } from '../game/src/cosmetics.js';
import { makeWorld } from '../game/src/data.js';
import { createAtmosphere } from '../game/src/atmosphere.js';
import { wetGrip, wetBraking } from '../game/src/wetgrip.js';
const DT = 1 / 120, up = new THREE.Vector3();
const input = extra => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, lean: false, ...extra });
function world(surface = 3, wetness = 0) {
  const w = makeWorld({ tile: 2000, hstep: 4, tiles: [], extent: [-1e7, -1e7, 1e7, 1e7], spawn: [0, 0] });
  Object.assign(w, { heightAt: () => 0, groundAt: () => 0, terrainAt: () => 0, surfaceAt: () => surface,
    normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0), loadedAt: () => true, mapContains: () => true });
  w.setWetness(wetness); return w;
}
function make(kind, type, wetness, speed = 0, surface = 3) {
  const w = world(surface, wetness);
  const v = kind === 'car' ? new Car(w, { ...TUNING_DEFAULTS }) : kind === 'bike' ? new Bike(w, { ...BIKE }) : new Jet(w, { ...JET });
  disposeCosmeticPreview(applyVehicleType(v, type));
  if (v.bail) v.bail = () => assert.fail(`${type}: bailed`);
  v.reset(0, 0, 0);
  for (let i = 0; i < 240; i++) v.step(DT, input());
  v.vel.set(0, 0, speed / 3.6); if (kind === 'jet') v.v = speed / 3.6;
  return v;
}
function step(v, controls) {
  v.step(DT, controls);
  assert([...v.pos, ...v.vel, ...v.quat, ...v.ang].every(Number.isFinite), `${v.type}: nonfinite state`);
  assert(up.set(0, 1, 0).applyQuaternion(v.quat).y > 0, `${v.type}: flip`);
  assert(v.mode !== 'crashed', `${v.type}: crash`);
  assert(Math.abs(v.slip || 0) < .8, `${v.type}: spin (slip ${v.slip})`);
}
function corner(kind, type, speed, wetness, surface = 3) {
  const v = make(kind, type, wetness, speed, surface), start = v.pos.clone();
  // Hold horizontal speed to isolate lateral grip from the bike's washout speed scrub.
  // Direction, suspension, yaw, lean and tyre forces still come from the real physics.
  for (let i = 0; i < (kind === 'bike' ? 240 : 120); i++) {
    const scale = speed / 3.6 / Math.hypot(v.vel.x, v.vel.z); v.vel.x *= scale; v.vel.z *= scale;
    step(v, input({ steer: .95 }));
  }
  const turn = Math.abs(Math.atan2(v.vel.x, v.vel.z));
  const radius = Math.hypot(v.pos.x - start.x, v.pos.z - start.z) / (2 * Math.sin(turn / 2));
  assert(turn > .02 && turn < 2, `${type}: uncontrolled turn ${turn}`);
  for (let i = 0; i < 360; i++) step(v, input()); // releasing the bars must recover safely
  disposeCosmeticPreview(v.mesh); return radius;
}
function brake(kind, type, speed, wetness, surface = 3) {
  const v = make(kind, type, wetness, speed, surface), start = v.pos.z;
  let stopped = false;
  for (let i = 0; i < 2400; i++) {
    step(v, input(kind === 'jet' ? { handbrake: true } : { brake: 1 }));
    if (Math.hypot(v.vel.x, v.vel.z) < 1) { stopped = true; break; }
  }
  assert(stopped, `${type}: did not stop`);
  const distance = v.pos.z - start; disposeCosmeticPreview(v.mesh); return distance;
}
function straight(kind, type, wetness, surface = 3) {
  const v = make(kind, type, wetness, 0, surface);
  for (let i = 0; i < 960; i++) step(v, input({ throttle: 1, jet: { thr: 1, pitch: 0, roll: 0, yaw: 0 } }));
  assert(Math.abs(v.pos.x) < .1, `${type}: veered on straight road ${v.pos.x}`);
  const state = [...v.pos, ...v.vel, ...v.quat, ...v.ang]; disposeCosmeticPreview(v.mesh); return state;
}
const rows = [];
for (const kind of ['car', 'bike']) for (const { id } of VEHICLE_TYPES[kind]) {
  const wetStraight = straight(kind, id, 1), dryStraight = straight(kind, id, 0);
  assert(wetStraight.every((n, i) => Math.abs(n - dryStraight[i]) < .1), `${id}: unstable wet straight acceleration`);
  for (const speed of [100, 200]) {
    const dry = corner(kind, id, speed, 0), half = corner(kind, id, speed, .5), wet = corner(kind, id, speed, 1);
    assert(wet > dry * 1.06 && half > dry && half < wet, `${id} ${speed}: corner radii ${dry}, ${half}, ${wet}`);
    const stopDry = brake(kind, id, speed, 0), stopWet = brake(kind, id, speed, 1), ratio = stopWet / stopDry;
    assert(ratio > 1.11 && ratio < 1.19, `${id} ${speed}: stopping ratio ${ratio}`);
    rows.push({ type: id, speed, 'radius dry/half/wet': [dry, half, wet].map(n => n.toFixed(1)).join('/'), 'braking +%': ((ratio - 1) * 100).toFixed(1) });
  }
}
console.table(rows);
// The same moderate sideways slip starts a wet car drift earlier, then remains controllable.
for (const { id } of VEHICLE_TYPES.car) {
  const dry = make('car', id, 0, 100), wet = make('car', id, 1, 100);
  for (const v of [dry, wet]) { v.vel.set(Math.sin(.36) * 100 / 3.6, 0, Math.cos(.36) * 100 / 3.6); step(v, input()); }
  assert(!dry.drifting && wet.drifting, `${id}: wet drift should begin earlier`);
  for (let i = 0; i < 240; i++) { step(dry, input()); step(wet, input({ steer: wet.drifting ? -wet.driftDir * .5 : 0 })); }
  assert(!wet.drifting, `${id}: wet drift did not recover`);
  disposeCosmeticPreview(dry.mesh); disposeCosmeticPreview(wet.mesh);
}
// Surface classification and live moisture inherited through each vehicle's roof wrapper.
for (const surface of [0, 1, 2, 3, 4, 5, 6, 7]) {
  const w = world(surface), v = new Car(w, { ...TUNING_DEFAULTS });
  assert.equal(w.wetness, 0); assert.equal(wetGrip(v.world, surface), 1);
  w.setWetness(1); assert.equal(v.world.wetness, 1);
  const loss = 1 - wetGrip(v.world, surface);
  assert(Math.abs(loss - (surface === 5 ? 0 : [3, 6, 7].includes(surface) ? .23 : .08)) < 1e-9);
  // A dry water-bed class is intentionally remapped to grass by the vehicles.
  for (const [kind, type] of surface === 5 ? [] : [['car', 'race'], ['bike', 'dirt']]) {
    const ratio = brake(kind, type, 100, 1, surface) / brake(kind, type, 100, 0, surface);
    assert(ratio > 1.03 && ratio < ([3, 6, 7].includes(surface) ? 1.19 : 1.10), `surface ${surface}: braking ${ratio}`);
  }
  disposeCosmeticPreview(v.mesh);
}
assert.equal(wetGrip({}, 3), 1); assert.equal(wetBraking({}, 3), 1);
// Fixed-wing aircraft: moisture changes wheel braking only; runway thrust, steering and flight stay identical.
for (const { id } of VEHICLE_TYPES.jet.filter(t => t.id !== 'heli')) {
  assert.deepEqual(straight('jet', id, 1), straight('jet', id, 0), `${id}: wet runway acceleration changed`);
  const dry = make('jet', id, 0, 100), wet = make('jet', id, 1, 100);
  for (let i = 0; i < 120; i++) {
    const controls = input({ jet: { thr: 0, yaw: .2, pitch: 0, roll: 0 } });
    step(dry, controls); step(wet, controls);
    assert.deepEqual([...wet.pos, ...wet.vel, ...wet.quat], [...dry.pos, ...dry.vel, ...dry.quat], `${id}: wet steering changed`);
  }
  disposeCosmeticPreview(dry.mesh); disposeCosmeticPreview(wet.mesh);
  const ratio = brake('jet', id, 100, 1) / brake('jet', id, 100, 0);
  assert(ratio > 1.10 && ratio < 1.19, `${id}: wet runway braking ${ratio}`);
}
function atmosphere() {
  const scene = new THREE.Scene(), sun = new THREE.DirectionalLight(); scene.background = new THREE.Color(); scene.add(sun);
  const w = world(); return { w, a: createAtmosphere({ scene, sun, world: w, storage: null, seed: 42 }) };
}
const host = atmosphere(), guest = atmosphere();
assert.equal(host.w.wetness, 0);
host.a.set({ weather: 'rain' });
for (let i = 0; i < 8 * 60; i++) host.a.update(1 / 60);
assert.equal(host.w.wetness, 1, 'full rain wets the road');
host.a.set({ weather: 'clear' });
for (let i = 0; i < 30 * 60; i++) host.a.update(1 / 60);
assert(Math.abs(host.w.wetness - .6) < .011, 'road stays wet after rain');
guest.a.follow({ ...host.a.shared(), ...host.a.clock() });
assert.equal(guest.w.wetness, host.w.wetness, 'late guest inherits drying road');
for (let i = 0; i < 46 * 60; i++) { host.a.update(1 / 60); guest.a.update(1 / 60); }
assert.equal(host.w.wetness, 0, 'road dry after 75 seconds'); assert.equal(guest.w.wetness, 0);
guest.a.set({ weather: 'rain' }); guest.a.update(1); assert.equal(guest.w.wetness, 0, 'guest follows host weather');
guest.a.unfollow(); for (let i = 0; i < 31; i++) guest.a.update(1); assert.equal(guest.w.wetness, 1);
host.a.dispose(); guest.a.dispose();
console.log('PASS: all ground types, progressive wet corners, braking, stable acceleration, surfaces, aircraft, drying and host follow');
