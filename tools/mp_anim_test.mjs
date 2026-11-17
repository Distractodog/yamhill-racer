// Multiplayer animation (MP-4) without a renderer: net.js animState → the wire → remotes.js parseAnim / animAt → the
// remote's model moved by the vehicle's own syncMesh. Each manoeuvre (accelerate, turn, drift, brake; bike lean +
// wheelie; jet taxi, flight, crash) is played on a "local" vehicle model through Car / Bike / Jet syncMesh exactly as
// main.js does for yours, and sent at 15 Hz to a remote; the remote's wheels, steering, springs, body roll / pitch,
// lean, bars, rider, gear, flame and control surfaces must end up where the local ones are, also with the guest's own
// tuning (spring length, steering lock, bike travel: sent in the skin, not every state), and a crashed jet is
// blackened with its canopy gone like the local wreck. Also: tyre marks, smoke, dust, splashes (still fading after
// the last remote leaves) and the glider through effects.js / drivingfx.js / glider.js, an older client without the fields,
// predictedState, the 4 nearest engine voices (fake AudioContext), and 16 animated remotes' cost.
//   node tools/mp_anim_test.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { animState, animTuning, Net } from '../game/src/mp/net.js';
import { parseAnim, parseState, parseTune, animAt, makeRemotes, predictedState, pickVoices, voiceLevel, DELAY, VOICES, VOICE_RANGE, FX_RANGE } from '../game/src/mp/remotes.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { buildCarModel, WHEEL_POS } from '../game/src/carmodel.js';
import { Bike, BIKE, buildBikeModel } from '../game/src/bike.js';
import { Jet, buildJetModel } from '../game/src/jet.js';
import { primeWheelArch } from '../game/src/wheeltravel.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (±${eps})`);
const V3 = THREE.Vector3;

// ---------------------------------------------------------------- animState: compact, rounded, zeros left out
{
  const car = { kind: 'car', steer: -0.4234, slip: 0.31234, drifting: true, latAcc: -12.345, lonAcc: 0, surface: 3, onWater: false, waterDepth: 0,
    input: { throttle: 1, brake: 0, handbrake: true },
    wheels: [{ contact: true, comp: 0.0912, surf: 3 }, { contact: true, comp: 0.1, surf: 3 }, { contact: false, comp: 0, surf: 3 }, { contact: true, comp: 0.2, surf: 3 }] };
  const a = animState(car);
  assert.deepEqual(a, { st: -0.42, th: 1, hb: 1, dr: 1, sl: 0.31, la: -12.3, sf: 3, w: [9, 10, -1, 20] }, 'car fields');
  car.wheels[1].surf = 4; assert.deepEqual(animState(car).ws, [3, 4, 3, 3], 'per-wheel surface only when one differs');
  const bike = { kind: 'bike', lean: 0.6123, pitchRate: -1.26, wheelie: true, steer: 0.2, surface: 2, input: { throttle: 0.5 }, wheels: [{ contact: true, comp: 0.1, surf: 2 }, { contact: true, comp: 0.08, surf: 2 }] };
  assert.deepEqual(animState(bike), { st: 0.2, th: 0.5, sf: 2, w: [10, 8], ln: 0.61, pr: -1.3, wl: 1 }, 'bike fields');
  const jet = { kind: 'jet', mode: 'air', throttle: 0.873, gear: 0, steer: 0, surface: 0, input: { throttle: 1, jet: { pitch: 1, roll: -0.5, yaw: 0 } },
    wheels: [{ contact: false }, { contact: false }, { contact: false }] };
  assert.deepEqual(animState(jet), { th: 0.87, w: [-1, -1, -1], md: 'a', jc: [1, -0.5, 0] }, 'jet fields');
  assert.deepEqual(animState({ kind: 'car', steer: NaN, wheels: [] }), {}, 'NaN and empty dropped');
  const impact = parseAnim({ ...animState({ ...car, hit: 12.34, landing: .678 }) });
  assert.equal(impact.hi, 12.3); assert.equal(impact.ld, .68);
  assert.equal(parseAnim({ w: [0], hi: Infinity, ld: -2 }).hi, 0);
  assert.equal(parseAnim({ w: [0], hi: Infinity, ld: -2 }).ld, 0);
  const bytes = JSON.stringify(animState(car)).length;
  assert.ok(bytes < 110, `compact: ${bytes} bytes`);
  console.log(`animState: car ${bytes} B, bike ${JSON.stringify(animState(bike)).length} B, jet ${JSON.stringify(animState(jet)).length} B extra per state`);
}

// ---------------------------------------------------------------- tuning the animation reads: in the skin, not every state
{
  assert.deepEqual(animTuning({ kind: 'car', t: { ...TUNING_DEFAULTS, restLength: 0.6123 } }), { rl: 0.612, sl: 0.6 }, 'car: spring length + steering lock');
  assert.deepEqual(animTuning({ kind: 'bike', t: BIKE }), { tr: 0.32 }, 'bike: travel');
  assert.deepEqual([animTuning({ kind: 'jet', t: {} }), animTuning({ kind: 'car' })], [{}, {}], 'jet / no tuning: nothing');
  assert.deepEqual(parseTune({ rl: 5, sl: 'x' }, 'car'), { restLength: 0.9, steerLock: TUNING_DEFAULTS.steerLock, travel: BIKE.travel }, 'clamped, defaults');
  assert.equal(parseTune(null, 'bike').travel, BIKE.travel);
  // net.js: hello carries it, a change sends one skin message, state frames don't carry it
  class FakeWS { constructor() { this.readyState = 1; this.sent = []; FakeWS.last = this; } send(s) { this.sent.push(JSON.parse(s)); } close() {} }
  const store = new Map(), storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const timers = { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} };
  const vehicle = { kind: 'car', t: { ...TUNING_DEFAULTS }, pos: new V3(), quat: new THREE.Quaternion(), vel: new V3(), wheels: [], input: {} };
  const n = new Net({ WebSocketImpl: FakeWS, storage, relay: 'ws://test', timers });
  n.setVehicleSource(() => ({ vehicle, kind: 'car', colors: {}, glider: {} }));
  n.host().catch(() => {}); const ws = FakeWS.last; ws.onopen();
  assert.deepEqual(ws.sent[0].skin.tune, { rl: 0.42, sl: 0.6 }, 'hello skin carries the tuning');
  ws.onmessage({ data: JSON.stringify({ t: 'roster', players: [{ id: n.me.id }] }) });
  n._tick(); n._tick();
  const skins = () => ws.sent.filter(m => m.t === 'skin');
  assert.equal(skins().length, 0, 'unchanged tuning: no skin message');
  vehicle.t.restLength = 0.65; n._tick(); n._tick();
  assert.equal(skins().length, 1, 'changed tuning: one skin message'); assert.deepEqual(skins()[0].skin.tune, { rl: 0.65, sl: 0.6 });
  assert.ok(ws.sent.filter(m => m.t === 'state').every(m => !('tune' in m) && !('rl' in m)), 'states stay small');
  n.leave();
}

// ---------------------------------------------------------------- parseAnim / animAt
{
  assert.equal(parseAnim({ p: [0, 0, 0] }), null, 'older client: no fields');
  const a = parseAnim({ w: [5, 'x', -3, 400], st: 9, th: -1, la: NaN, sf: 99, md: 'zz', jc: [2, 'q'], ws: [1, 2] });
  assert.deepEqual([a.st, a.th, a.la, a.sf, a.md, a.w, a.ws, a.jc], [1, 0, 0, 0, 'g', [5, -1, -1, 100], [1, 2, 0, 0], [1, 0, 0]], 'junk clamped / defaulted');
  const st = (t, extra) => parseState({ p: [0, 0, 0], q: [0, 0, 0, 1], v: 'car', ...extra }, t);
  const buf = [st(0, { w: [10, 10, -1, 20], st: 0, la: 0, dr: 0, sf: 3 }), st(100, { w: [20, 10, 10, 20], st: 1, la: 10, dr: 1, sf: 4 })];
  const out = animAt(buf, 25);
  near(out.st, 0.25, 1e-9, 'steer blends'); near(out.la, 2.5, 1e-9, 'lat acc blends'); near(out.w[0], 12.5, 1e-9, 'spring blends');
  assert.deepEqual([out.w[2], out.dr, out.sf], [-1, false, 3], 'a wheel in the air does not sink halfway; flags from the nearer state');
  assert.deepEqual([animAt(buf, 75).w[2], animAt(buf, 75).dr], [10, true]);
  assert.equal(animAt([st(0), st(66)], 30), null, 'older client → null');
  assert.equal(animAt([st(0), st(66, { w: [1, 1, 1, 1], st: 0.5 })], 30).st, 0.5, 'one side only → that side');
  const impact = [st(0, { w: [10], hi: 0, ld: 0 }), st(100, { w: [10], hi: 12, ld: .6 })];
  assert.deepEqual([animAt(impact, 49).hi, animAt(impact, 49).ld], [0, 0]);
  assert.deepEqual([animAt(impact, 50).hi, animAt(impact, 50).ld], [12, .6], 'impact peaks retain a distinct onset at any render rate');
}

// ---------------------------------------------------------------- local vs remote, through the same syncMesh
function stubMp(id = 'me') {
  const ls = new Map(); let t = 50000;
  return { me: { id, code: 'ABCDE', name: 'Me' }, inGame: true, isHost: false, players: new Map(), now: () => t, advance(ms) { t += ms; },
    on(type, fn) { if (!ls.has(type)) ls.set(type, new Set()); ls.get(type).add(fn); }, off(type, fn) { ls.get(type)?.delete(fn); },
    emit(type, msg) { for (const f of ls.get(type) || []) f(msg); }, send() {} };
}
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.3, 2200);
// the road half a metre under the vehicles' centres (about where it is): syncMesh keeps bodies above it (bodyclearance.js)
const world = { heightAt: () => -0.5 };
const mp = stubMp(), R = makeRemotes({ scene, camera, mp, world });
mp.emit('roster', { t: 'roster', players: [{ id: 'g', name: 'Gus', skin: { vehicle: 'car', colors: {} } }] });

const SYNC = { car: Car.prototype.syncMesh, bike: Bike.prototype.syncMesh, jet: Jet.prototype.syncMesh };
const RAD = { car: 0.38, bike: 0.34, jet: 0.35 };
function local(kind) {
  // wheel arches are resolved at build time, as Car / Bike do for their own meshes
  const mesh = primeWheelArch(kind === 'car' ? buildCarModel() : kind === 'bike' ? buildBikeModel() : buildJetModel());
  const pos = new V3(), quat = new THREE.Quaternion();
  return { kind, mesh, t: kind === 'car' ? TUNING_DEFAULTS : BIKE, pos, quat, renderPos: pos, renderQuat: quat, vel: new V3(), world,
    wheels: mesh.userData.wheels.map(g => ({ front: g.front, comp: 0, contact: true, surf: 3, contactPoint: new V3(), spin: 0 })),
    steer: 0, latAcc: 0, lonAcc: 0, slip: 0, drifting: false, surface: 3, onWater: false, waterDepth: 0, lean: 0, pitchRate: 0, wheelie: false,
    throttle: 0, gear: 1, mode: 'ground', input: { throttle: 0, brake: 0, handbrake: false, jet: { pitch: 0, roll: 0, yaw: 0 } } };
}
const L = { car: local('car'), bike: local('bike'), jet: local('jet') };
let z = 0, sendT = 0;
// play one manoeuvre for `secs` with constant read-outs on the local vehicle and on the wire; returns spin rates
function play(kind, secs, set, { speed = 20, glide = false, y = 0 } = {}) {
  const lv = L[kind], dt = 1 / 60; set(lv);
  let localSpin0 = 0, remoteSpin0 = 0;
  const frames = Math.round(secs * 60);
  for (let f = 0; f < frames; f++) {
    z += speed * dt; mp.advance(1000 / 60); sendT += 1000 / 60;
    for (const wh of lv.wheels) wh.spin += (kind === 'jet' && lv.mode !== 'ground' ? 0 : speed * dt / RAD[kind] * (kind === 'car' && lv.input.handbrake && !wh.front ? 0 : 1));
    SYNC[kind].call(lv, dt);
    if (sendT >= 66) {
      sendT -= 66;
      mp.emit('state', { t: 'state', from: 'g', srvT: mp.now(), v: kind, p: [0, y, z], q: [0, 0, 0, 1], vel: [0, 0, speed], glide, ts: mp.now(), ...animState(lv) });
    }
    camera.position.set(0, 3, z - 8); camera.updateMatrixWorld();
    R.update(dt);
    if (f === frames - 31) { localSpin0 = lv.wheels[0].spin; remoteSpin0 = R.list()[0].anim.spin[0]; }
  }
  return { local: lv.wheels[0].spin - localSpin0, remote: R.list()[0].anim.spin[0] - remoteSpin0 };
}
function compare(kind, label, spins) {
  const lm = L[kind].mesh.userData, rm = R.model('g').userData;
  for (const [i, g] of lm.wheels.entries()) {
    near(rm.wheels[i].holder.position.y, g.holder.position.y, 0.006, `${label}: wheel ${i} spring`);
    near(rm.wheels[i].holder.rotation.y, g.holder.rotation.y, 0.006, `${label}: wheel ${i} steer`);
  }
  if (spins) near(spins.remote, spins.local, Math.abs(spins.local) * 0.03 + 0.02, `${label}: wheel spin over 0.5 s`);
  for (const part of ['bodyPivot', 'lean', 'bars', 'rider', 'elevator', 'rudder', 'aileronL', 'aileronR', 'noseWheel']) {
    if (!lm[part]) continue;
    for (const ax of ['x', 'y', 'z']) near(rm[part].rotation[ax], lm[part].rotation[ax], 0.004, `${label}: ${part}.rotation.${ax}`);
  }
  if (kind === 'jet') {
    assert.equal(rm.flame.visible, lm.flame.visible, `${label}: flame shown`);
    near(rm.flame.scale.z, lm.flame.scale.z, 0.02, `${label}: flame length`); near(rm.flame.material.opacity, lm.flame.material.opacity, 0.01, `${label}: flame opacity`);
    for (const [i, g] of lm.wheels.entries()) { near(rm.wheels[i].leg.scale.y, g.leg.scale.y, 0.006, `${label}: gear leg ${i}`); assert.equal(rm.wheels[i].leg.visible, g.leg.visible); }
  }
}
const setCar = (st, th, br, hb, dr, sl, la, lo, comp) => lv => {
  Object.assign(lv, { steer: st, drifting: dr, slip: sl, latAcc: la, lonAcc: lo }); Object.assign(lv.input, { throttle: th, brake: br, handbrake: hb });
  lv.wheels.forEach((w, i) => { w.contact = comp[i] >= 0; w.comp = Math.max(0, comp[i]); });
};
const car = [
  ['car: accelerate', setCar(0, 1, 0, false, false, 0, 0, 22, [0.06, 0.06, 0.13, 0.13])],
  ['car: turn right', setCar(0.8, 1, 0, false, false, 0.1, -24, 2, [0.05, 0.12, 0.06, 0.13])],
  ['car: drift (handbrake)', setCar(-1, 1, 0, true, true, 0.6, 18, -3, [0.12, 0.04, 0.13, 0.05])],
  ['car: brake', setCar(0, 0, 1, false, false, 0, 0, -40, [0.15, 0.15, 0.04, 0.04])],
  ['car: in the air', setCar(0.3, 1, 0, false, false, 0, 0, 0, [-1, -1, -1, -1])],
];
for (const [label, set] of car) { const spins = play('car', 1.5, set); compare('car', label, spins); }
console.log('car: accelerate / turn / drift / brake / air match the local syncMesh (wheels, steer, springs, spin, roll, pitch)');
const anim = R.list()[0].anim;
assert.ok(anim.comp.every(c => c === -1), 'car in the air: wheels hang');
// the guest's own tuning: longer springs, more steering lock. Without it the remote's wheels sit and steer differently;
// with it (one skin message) they match, and the model isn't rebuilt for a tuning change
{
  L.car.t = { ...TUNING_DEFAULTS, restLength: 0.62, steerLock: 0.85 };
  const turn = setCar(0.8, 1, 0, false, false, 0.1, -24, 2, [0.05, 0.12, 0.06, 0.13]);
  play('car', 1, turn);
  const lw = L.car.mesh.userData.wheels[0].holder, rw = () => R.model('g').userData.wheels[0].holder, model = R.model('g');
  assert.ok(Math.abs(rw().position.y - lw.position.y) > 0.15 && Math.abs(rw().rotation.y - lw.rotation.y) > 0.1, 'without the tuning the remote differs (sanity)');
  mp.emit('skin', { t: 'skin', from: 'g', skin: { vehicle: 'car', colors: {}, tune: animTuning(L.car) } });
  play('car', 1, turn); compare('car', 'car: own tuning (springs 0.62 m, lock 0.85)');
  assert.equal(R.model('g'), model, 'tuning only: same model');
  L.car.t = TUNING_DEFAULTS;
  mp.emit('skin', { t: 'skin', from: 'g', skin: { vehicle: 'car', colors: {}, tune: animTuning(L.car) } });
  play('car', 1, turn); compare('car', 'car: back to default tuning');
  console.log('car tuning: spring length and steering lock from the skin message match the local syncMesh');
}

L.bike.t = { ...BIKE, travel: 0.45 };                  // longer travel: the wheels hang lower
mp.emit('skin', { t: 'skin', from: 'g', skin: { vehicle: 'bike', colors: {}, tune: animTuning(L.bike) } });
play('bike', 1.5, lv => { Object.assign(lv, { steer: 0.5, lean: 0.62, pitchRate: 0.8, wheelie: false }); lv.input.throttle = 1; lv.wheels[0].comp = 0.1; lv.wheels[1].comp = 0.07; });
compare('bike', 'bike: leaned turn');
play('bike', 1.5, lv => { Object.assign(lv, { steer: -0.2, lean: -0.3, pitchRate: -1.5, wheelie: true }); lv.wheels[0].contact = false; lv.wheels[1].comp = 0.2; });
compare('bike', 'bike: wheelie', null);
console.log('bike: lean, bars, rider, wheel springs and spin match');

play('jet', 1.5, lv => { Object.assign(lv, { mode: 'ground', gear: 1, throttle: 0.55, steer: 0.4 }); lv.input.jet = { pitch: 0, roll: 0, yaw: 0.4 }; lv.wheels.forEach(w => { w.contact = true; w.comp = 0.2; }); });
compare('jet', 'jet: taxi');
play('jet', 1.5, lv => { Object.assign(lv, { mode: 'air', gear: 0.3, throttle: 1, steer: 0 }); lv.input.jet = { pitch: 1, roll: -1, yaw: 0.5 }; lv.wheels.forEach(w => { w.contact = false; }); }, { speed: 120, y: 200 });
compare('jet', 'jet: flying, gear folding');
play('jet', 1.5, lv => { Object.assign(lv, { mode: 'crashed', gear: 0, throttle: 0 }); lv.mesh.userData.wreck(true); lv.input.jet = { pitch: 0, roll: 0, yaw: 0 }; }, { speed: 5, y: 2 });
compare('jet', 'jet: crashed');
near(R.model('g').scale.y, 0.65, 1e-9, 'crashed jet: wreck look'); assert.equal(R.model('g').userData.flame.visible, false);
// wreck paint + canopy: blackened like the local one (its white / orange materials turn 0x3a3a3a), canopy hidden
const colourCount = (model, hex) => {
  const c = new THREE.Color(hex); let n = 0;
  model.traverseVisible(o => { const a = o.isMesh && o.material.vertexColors && o.geometry.attributes.color; if (a) for (let i = 0; i < a.count; i++) if (Math.abs(a.getX(i) - c.r) + Math.abs(a.getY(i) - c.g) + Math.abs(a.getZ(i) - c.b) < 1e-4) n++; });
  return n;
};
const BODY = '#eef0f2', TRIM = '#ff6a1a', WRECK = L.jet.mesh.userData.wreckColor;
{
  const lu = L.jet.mesh.userData, ru = R.model('g').userData;
  assert.equal(L.jet.mesh.userData.wreckMats[0].color.getHex(), WRECK, 'local: blackened');
  assert.ok(colourCount(R.model('g'), WRECK) > 100 && colourCount(R.model('g'), BODY) === 0 && colourCount(R.model('g'), TRIM) === 0, `remote: blackened too (${colourCount(R.model('g'), WRECK)} wreck-grey vertices, no white / orange)`);
  assert.ok(ru.canopy.parent && ru.canopy.visible === false && lu.canopy.visible === false, 'canopy gone on both');
  play('jet', 1.5, lv => { Object.assign(lv, { mode: 'ground', gear: 1, throttle: 0.3, steer: 0 }); lv.mesh.userData.wreck(false); lv.wheels.forEach(w => { w.contact = true; w.comp = 0.2; }); }, { speed: 3, y: 1.6 });
  compare('jet', 'jet: respawned');
  assert.ok(colourCount(R.model('g'), WRECK) === 0 && colourCount(R.model('g'), BODY) > 100 && colourCount(R.model('g'), TRIM) > 0, 'respawned: own paint back');
  assert.ok(ru.canopy.visible && lu.canopy.visible && R.model('g').scale.y === 1, 'canopy and shape back');
}
console.log('jet: gear legs, flame, nose wheel, elevator / rudder / ailerons and wreck match');

// ---------------------------------------------------------------- effects through effects.js / drivingfx.js, glider
const fx = R.fx; assert.ok(fx?.effects && fx.driving, 'shared remote effects made');
const alive = (life, pred = () => true) => { let n = 0; for (let i = 0; i < life.length; i++) if (life[i] > 0 && pred(i)) n++; return n; };
mp.emit('skin', { t: 'skin', from: 'g', skin: { vehicle: 'car', colors: {} } });
play('car', 0.5, setCar(0, 1, 0, false, false, 0, 0, 0, [0.09, 0.09, 0.09, 0.09]), { speed: 25 });
const marks0 = fx.effects.markI;
for (let i = 0; i < 300; i++) { fx.effects.advance(1 / 60); fx.driving.advance(1 / 60); }    // nothing left from before
L.car.surface = 4; L.car.wheels.forEach(w => { w.surf = 4; });    // a gravel drift: marks + smoke (asphalt throws none, as yours)
play('car', 1.2, setCar(-1, 1, 0, true, true, 0.6, 18, 0, [0.09, 0.09, 0.09, 0.09]), { speed: 25 });
const marks = fx.effects.markI - marks0;
assert.ok(marks >= 6, `drift lays tyre marks (${marks} quads)`);
const markY = fx.effects.markPos[(fx.effects.markI - 1) * 18 + 1];
near(markY, world.heightAt() + 0.04, 1e-6, 'marks sit on the ground');
const smoke = alive(fx.effects.pLife); assert.ok(smoke > 20, `drift smoke (${smoke} particles)`);
L.car.surface = 4; L.car.wheels.forEach(w => { w.surf = 4; });
for (let i = 0; i < 90; i++) { fx.effects.advance(1 / 60); fx.driving.advance(1 / 60); }    // let the smoke fade
play('car', 1, setCar(0, 1, 0, false, false, 0, 0, 0, [0.09, 0.09, 0.09, 0.09]), { speed: 30 });
const dust = alive(fx.effects.pLife), gravel = alive(fx.driving.life);
assert.ok(dust > 10 && gravel > 10, `gravel road: dust (${dust}) and thrown gravel (${gravel})`);
L.car.surface = 5; L.car.onWater = true; L.car.wheels.forEach(w => { w.surf = 5; });
play('car', 0.6, setCar(0, 1, 0, false, false, 0, 0, 0, [0.05, 0.05, 0.05, 0.05]), { speed: 30 });
const spray = alive(fx.effects.pLife, i => fx.effects.pGrav[i] === 1);
assert.ok(spray > 20, `skimming water: splashes (${spray})`);
L.car.surface = 3; L.car.onWater = false; L.car.wheels.forEach(w => { w.surf = 3; });
play('car', 1.0, setCar(0, 1, 0, false, false, 0, 0, 0, [-1, -1, -1, -1]), { speed: 20, glide: true, y: 30 });
const wing = R.model('g').children.find(o => o.isMesh && o.material.side === THREE.DoubleSide);
assert.ok(wing?.visible && R.list()[0].anim.glider > 0.99, 'glider unfolds');
play('car', 1.0, setCar(0, 1, 0, false, false, 0, 0, 0, [-1, -1, -1, -1]), { speed: 20, glide: false, y: 30 });
assert.ok(!wing.visible && R.list()[0].anim.glider === 0, 'glider folds away');
console.log(`effects: drift marks ${marks} + smoke ${smoke}, gravel dust ${dust} + stones ${gravel}, water spray ${spray}; glider opens / folds`);
// the last remote leaves mid-drift on gravel: its smoke, dust and stones keep fading until nothing is left drawn
{
  L.car.surface = 4; L.car.wheels.forEach(w => { w.surf = 4; });
  play('car', 0.8, setCar(-1, 1, 0, true, true, 0.6, 18, 0, [0.09, 0.09, 0.09, 0.09]), { speed: 30 });
  const shown = () => [fx.effects.pAlpha, fx.driving.alpha].map(a => a.filter(x => x > 0).length);
  const [smoke0, stones0] = shown();
  assert.ok(smoke0 > 10 && stones0 > 5, `in the air when they leave (${smoke0} smoke, ${stones0} stones)`);
  mp.emit('left', { t: 'left', id: 'g' }); assert.equal(R.count, 0);
  for (let i = 0; i < 30; i++) { mp.advance(1000 / 60); R.update(1 / 60); }
  const [smoke1] = shown(); assert.ok(smoke1 < smoke0 || smoke1 === 0, 'still fading after they left');
  for (let i = 0; i < 300; i++) { mp.advance(1000 / 60); R.update(1 / 60); }
  assert.deepEqual(shown(), [0, 0], 'all faded: nothing frozen in the air');
  assert.ok(fx.driving.trailA.every(a => a === 0), 'no trails left either');
  L.car.surface = 3; L.car.wheels.forEach(w => { w.surf = 3; });
  console.log(`after the last remote leaves: ${smoke0} smoke + ${stones0} stones fade to 0`);
}

// ---------------------------------------------------------------- an older client (no animation fields): still animated
{
  const m2 = stubMp(), R2 = makeRemotes({ scene: new THREE.Scene(), camera, mp: m2, fx: false });
  camera.position.set(0, 3, -10); camera.updateMatrixWorld();
  const Rad = 30, w = 15 / Rad;
  for (let f = 0; f < 120; f++) {
    const t = f / 60, a = w * t;
    if (f % 4 === 0) m2.emit('state', { t: 'state', from: 'o', srvT: m2.now(), v: 'car', p: [Rad - Rad * Math.cos(a), 0, Rad * Math.sin(a)],
      q: new THREE.Quaternion().setFromAxisAngle(new V3(0, 1, 0), a).toArray(), vel: [15 * Math.sin(a), 0, 15 * Math.cos(a)] });
    m2.advance(1000 / 60); R2.update(1 / 60);
  }
  const o = R2.list()[0].anim;
  assert.ok(o.spin[0] > 10 && o.comp.every(c => c > 0), `wheels roll and sit on their springs (${o.spin[0]})`);
  assert.ok(Math.abs(o.steer) > 0.1 && Math.abs(o.frontYaw) > 0.05, `front wheels steer into the turn (${o.steer})`);
  assert.ok([o.steer, o.roll, o.pitch, ...o.spin].every(Number.isFinite), 'no NaN');
  R2.dispose();
  console.log(`older client: steer ${o.steer}, front wheel yaw ${o.frontYaw}, roll ${o.roll}, spin ${o.spin[0]}`);
}

// ---------------------------------------------------------------- predictedState (for collisions)
{
  const m3 = stubMp(), R3 = makeRemotes({ scene: new THREE.Scene(), camera, mp: m3, fx: false });
  const t0 = m3.now();
  m3.emit('state', { t: 'state', from: 'p', srvT: t0, v: 'car', p: [0, 0, 0], q: [0, 0, 0, 1], vel: [0, 0, 20], w: [9, 9, 9, 9] });
  m3.advance(66); m3.emit('state', { t: 'state', from: 'p', srvT: t0 + 66, v: 'car', p: [0, 0, 1.32], q: [0, 0, 0, 1], vel: [0, 0, 20], w: [9, 9, 9, 9] });
  const ps = predictedState('p', t0 + 166);
  near(ps.p[2], 1.32 + 2, 1e-9, 'extrapolated 100 ms along vel'); assert.deepEqual([ps.v, ps.glide, ps.airborne, ps.vel], ['car', false, false, [0, 0, 20]]);
  near(predictedState('p', t0 + 33).p[2], 0.66, 1e-9, 'between states');
  m3.advance(10); m3.emit('state', { t: 'state', from: 'p', srvT: t0 + 76, v: 'car', p: [0, 3, 1.5], q: [0, 0, 0, 1], vel: [0, 2, 20], w: [-1, -1, -1, -1] });
  assert.equal(predictedState('p', t0 + 80).airborne, true, 'all wheels up → airborne');
  m3.advance(10); m3.emit('state', { t: 'state', from: 'p', srvT: t0 + 86, v: 'jet', p: [0, 3, 1.7], q: [0, 0, 0, 1], vel: [0, 0, 20], w: [20, 20, 20], md: 'g' });
  assert.equal(predictedState('p', t0 + 90).airborne, false, 'jet on its wheels');
  assert.equal(predictedState('nobody', t0), null); assert.equal(R3.predictedState('p', t0 + 90).v, 'jet');
  R3.dispose(); assert.equal(predictedState('p', t0 + 90), null, 'nothing after dispose');
  console.log('predictedState: interpolate / extrapolate / airborne / unknown');
}

// ---------------------------------------------------------------- engines: the 4 nearest, quiet, fading with distance
{
  assert.deepEqual(pickVoices([{ id: 'a', dist: 50 }, { id: 'b', dist: 5 }, { id: 'c', dist: 500 }, { id: 'd', dist: 20 }, { id: 'e', dist: 30 }, { id: 'f', dist: 40 }]), ['b', 'd', 'e', 'f']);
  assert.ok(voiceLevel(5) > voiceLevel(30) && voiceLevel(30) > voiceLevel(120) && voiceLevel(VOICE_RANGE) === 0 && voiceLevel(5) <= 0.4, 'quieter further off');
  const param = () => ({ value: 0, last: 0, setTargetAtTime(v) { this.last = v; }, setValueAtTime() {}, cancelScheduledValues() {} });
  const created = { sources: 0, stopped: 0 };
  const node = extra => ({ connect: n => n, disconnect() {}, ...extra });
  const ctx = { currentTime: 0, sampleRate: 8000, destination: node(), resume() {},
    createGain: () => node({ gain: param() }), createBiquadFilter: () => node({ frequency: param(), Q: param(), gain: param() }),
    createStereoPanner: () => node({ pan: param() }), createBuffer: (c, n) => ({ duration: 1, getChannelData: () => new Float32Array(n) }),
    createBufferSource: () => { created.sources++; return node({ playbackRate: param(), start() {}, stop() { created.stopped++; } }); },
    createOscillator: () => { created.sources++; return node({ frequency: param(), start() {}, stop() { created.stopped++; } }); },
    decodeAudioData: async () => ({ duration: 1 }) };
  globalThis.fetch = async () => ({ arrayBuffer: async () => new ArrayBuffer(4) });
  const m4 = stubMp(), R4 = makeRemotes({ scene: new THREE.Scene(), camera, mp: m4, fx: false, audio: { ctx } });
  camera.position.set(0, 2, 0); camera.lookAt(0, 0, 50); camera.updateMatrixWorld();
  const send = () => { for (let i = 0; i < 6; i++) m4.emit('state', { t: 'state', from: 'v' + i, srvT: m4.now(), v: i === 5 ? 'jet' : 'car', p: [0, 0, 10 + i * 25], q: [0, 0, 0, 1], vel: [0, 0, 10], w: [9, 9, 9, 9], th: 1, md: 'g' }); };
  for (let f = 0; f < 30; f++) { if (f % 4 === 0) send(); m4.advance(16); R4.update(0.016); }
  await new Promise(r => setTimeout(r, 0));
  assert.equal(R4.stats.voices, VOICES, `${VOICES} engines for 6 nearby players`);
  // each voice: 8 looped effect sources (tyres, gravel, wind, rain...) + the race car's engine loops (audio/engines.js)
  const { ENGINE_LOOPS } = await import('../game/src/audio/engineloops.js');
  assert.ok(R4.list().length === 6 && created.sources === VOICES * (8 + ENGINE_LOOPS.race.length), `voices built on your audio context (${created.sources} sources)`);
  for (let i = 0; i < 6; i++) m4.emit('left', { t: 'left', id: 'v' + i });
  for (let f = 0; f < 400; f++) { m4.advance(16); R4.update(0.016); }
  assert.ok(R4.stats.voices === 0 && created.stopped >= created.sources - 4 * 4, `silent voices stop their sources after 5 s (${created.stopped}/${created.sources})`);
  R4.dispose();
  console.log(`engines: ${VOICES} nearest of 6 get a voice; ${created.sources} sources started, ${created.stopped} stopped once everyone left`);
}

// ---------------------------------------------------------------- 16 animated remotes with effects: per-frame cost
{
  const m5 = stubMp(), scene5 = new THREE.Scene(), R5 = makeRemotes({ scene: scene5, camera, mp: m5, world });
  camera.position.set(0, 3, -40); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const kinds = ['car', 'bike', 'jet'], ids = Array.from({ length: 16 }, (_, i) => 'p' + i);
  m5.emit('roster', { t: 'roster', players: ids.map((id, i) => ({ id, name: 'Racer' + (100 + i), skin: { vehicle: kinds[i % 3], colors: {} } })) });
  let t = 0;
  const tick = () => {
    for (const [i, id] of ids.entries()) {
      const a = t / 1000 * 0.5 + i, r = 12 + i * 6, k = kinds[i % 3];   // 12–102 m: all near, all inside the effects range
      m5.emit('state', { t: 'state', from: id, srvT: m5.now(), v: k, p: [r * Math.sin(a), k === 'jet' && i % 2 ? 60 : 0.5, r * Math.cos(a)],
        q: new THREE.Quaternion().setFromAxisAngle(new V3(0, 1, 0), a + Math.PI / 2).toArray(), vel: [r * 0.5 * Math.cos(a), 0, -r * 0.5 * Math.sin(a)],
        st: 0.6, th: 1, dr: i % 4 === 0 ? 1 : 0, hb: i % 4 === 0 ? 1 : 0, sl: i % 4 === 0 ? 0.5 : 0.1, la: 15, sf: i % 2 ? 4 : 3,
        w: k === 'jet' ? (i % 2 ? [-1, -1, -1] : [20, 20, 20]) : k === 'bike' ? [10, 8] : [9, 9, 9, 9], ln: k === 'bike' ? 0.5 : 0, md: i % 2 ? 'a' : 'g', jc: [0.3, 0.5, 0] });
    }
  };
  for (let f = 0; f < 120; f++) { if (f % 4 === 0) tick(); m5.advance(1000 / 60); t += 1000 / 60; R5.update(1 / 60); }
  const N = 1200, each = []; let total = 0, worst = 0;
  for (let f = 0; f < N; f++) {
    if (f % 4 === 0) tick();
    m5.advance(1000 / 60); t += 1000 / 60;
    const a = performance.now(); R5.update(1 / 60); const ms = performance.now() - a; total += ms; worst = Math.max(worst, ms); each.push(ms);
  }
  const median = each.sort((a, b) => a - b)[N >> 1];
  const all = R5.list();
  assert.equal(all.filter(r => r.visible && !r.far).length, 16, 'all 16 animated');
  assert.equal(R5.stats.fx, 16, 'all 16 drive the effects');
  assert.ok(all.every(r => r.anim.spin.every(Number.isFinite)), 'no NaN');
  console.log(`16 animated remotes with effects: update ${median.toFixed(3)} ms median, ${(total / N).toFixed(3)} ms avg, ${worst.toFixed(3)} ms worst (Node)`);
  // the median: a busy machine's GC / scheduling spikes inflate the average and worst, not the typical frame
  assert.ok(median < 0.5, `typical frame well under 1 ms in Node (${median.toFixed(3)} ms)`);
  R5.dispose();
  assert.equal(scene5.children.length, 0, 'dispose removes models, tags and effects');
}
R.dispose();
console.log(`PASS mp anim: animState wire fields, parse/interpolate, car/bike/jet = local syncMesh, tuning via skin, jet wreck look, effects (marks, smoke, dust, spray; fade after the last leaves), glider, older clients, predictedState, ${VOICES} engine voices, 16-remote cost (DELAY ${DELAY} ms, effects ≤ ${FX_RANGE} m)`);
