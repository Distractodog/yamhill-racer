// Prop plane + stunt plane (vehicletypes.js jet types 'prop' and 'stunt', flown by jet.js): headless flight test.
//   node tools/prop_flight_test.mjs [prop|stunt] [--flat]      (--flat: skip the real-map part; run through the heavy gate)
// Flat ground: take-off on asphalt + grass, climb, top speed, turn, roll rate, loop, stall + recovery, slowest level
// flight, landing + roll-out, crashes (dive, hard landing, wing in the ground, water) + wreck + respawn, taxi circle,
// the tail-wheel sitting pose, model parts (lights, propeller spin). Real map: take-off from Hwy 18 and a field, landing
// on Hwy 18 and on the field, a dive into the ground, and a bot flying each jet race through every ring.
// Every run: no NaN, never upside down on the ground. Prints numbers; exits non-zero on any failed check.
import fs from 'node:fs';
import * as THREE from 'three';
import { Jet, JET, FIGHTER_AIRFRAME } from '../game/src/jet.js';
import { VEHICLE_TYPES, applyVehicleType, typeInfo } from '../game/src/vehicletypes.js';
import { disposeCosmeticPreview, paintedModel } from '../game/src/cosmetics.js';
import { bakeParts } from '../game/src/mp/remotes.js';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';

const DT = 1 / 120, KMH = 3.6;
const only = process.argv.slice(2).find(a => !a.startsWith('--')), FLAT_ONLY = process.argv.includes('--flat');
const TYPES = ['prop', 'stunt'].filter(t => !only || t === only);
// what each type must do (km/h, m, s)
const SPEC = {
  prop: { liftoffKmh: [55, 100], roll: 160, grassRoll: 260, top: [225, 275], stallKmh: [55, 95], landRoll: 300, approach: 115, maxG: 4.7, climb: 4 },
  stunt: { liftoffKmh: [85, 140], roll: 260, grassRoll: 360, top: [370, 430], stallKmh: [80, 125], landRoll: 420, approach: 165, maxG: 9.5, climb: 8, roll360: 1.6, loopR: 140 },
};
let failures = 0;
const check = (ok, what) => { console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };
const angle = a => Math.atan2(Math.sin(a), Math.cos(a));

// ---------------------------------------------------------------- worlds
const flat = ({ surface = 3, water = -Infinity, h = 0 } = {}) => ({
  heightAt: () => h, terrainAt: () => h, groundAt: () => h, surfaceAt: () => surface,
  normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0), waterLevelAt: () => water,
  treesNear: () => {}, buildingsNear: () => [], loadedAt: () => true, extent: [-1e6, -1e6, 1e6, 1e6], spawn: [0, 0],
});
function make(type, world) {
  const j = new Jet(world, { ...JET });
  disposeCosmeticPreview(applyVehicleType(j, type));
  return j;
}

// ---------------------------------------------------------------- one flight: ctl(t, J, plane, input) every step
function fly(j, secs, ctl, setup = null) {
  const st = { liftoff: null, maxKmh: 0, maxAlt: -1e9, minAgl: 1e9, stallT: 0, firstStall: null, crashes: [], landed: null,
    maxG: 0, nan: false, modes: '', groundFlip: false, respawned: false, stoppedAt: null };
  const input = { throttle: 0, brake: 0, steer: 0, handbrake: false, jet: { thr: 0, pitch: 0, roll: 0, yaw: 0 } };
  j.input = input; setup?.(j);
  let last = j.mode, start = j.pos.clone();
  for (let i = 0; i < secs / DT; i++) {
    const t = i * DT;
    input.handbrake = false;
    if (ctl(t, input.jet, j, input) === false) break;                // the controller is done
    j.step(DT, input); j.interpolate(1); j.syncMesh(DT);
    const kmh = j.vel.length() * KMH;
    if (j.mode !== last) {
      st.modes += (st.modes ? '→' : '') + j.mode + '@' + t.toFixed(1);
      if (last === 'ground' && j.mode === 'air' && !st.liftoff) st.liftoff = { t, kmh, dist: Math.hypot(j.pos.x - start.x, j.pos.z - start.z) };
      if (j.mode === 'crashed') st.crashes.push(`${j.msg} (${j.pos.x.toFixed(0)}, ${j.pos.z.toFixed(0)})`);
      if (last === 'air' && j.mode === 'ground') st.landed = { t, sink: -j._prevVel.y, kmh, at: j.pos.clone() };
      if (last === 'crashed') st.respawned = true;
      last = j.mode;
    }
    if (st.landed && !st.stoppedAt && j.mode === 'ground' && kmh < 1) st.stoppedAt = j.pos.clone();
    st.maxKmh = Math.max(st.maxKmh, kmh);
    if (j.mode === 'air') {
      st.maxAlt = Math.max(st.maxAlt, j.agl); st.minAgl = Math.min(st.minAgl, j.agl); st.maxG = Math.max(st.maxG, j.gLoad);
      if (j.stall) { st.stallT += DT; if (!st.firstStall) st.firstStall = { t, kmh }; }
    }
    if (j.mode === 'ground' && new THREE.Vector3(0, 1, 0).applyQuaternion(j.quat).y < 0.5) st.groundFlip = true;
    if (![...j.pos, ...j.vel, ...j.quat, ...j.ang].every(Number.isFinite) || !Number.isFinite(j.throttle)) { st.nan = true; break; }
  }
  st.end = { mode: j.mode, kmh: j.vel.length() * KMH, agl: j.agl };
  return st;
}
const summary = st => `${st.modes || 'no mode change'} · top ${st.maxKmh.toFixed(0)} km/h${st.liftoff ? ` · lift-off ${st.liftoff.kmh.toFixed(0)} km/h after ${st.liftoff.dist.toFixed(0)} m` : ''}` +
  ` · max ${st.maxG.toFixed(1)} g · stalled ${st.stallT.toFixed(1)} s${st.landed ? ` · landed sink ${st.landed.sink.toFixed(1)} m/s at ${st.landed.kmh.toFixed(0)} km/h` : ''}` +
  `${st.crashes.length ? ' · crashes: ' + st.crashes.join(', ') : ''} · end ${st.end.mode}, ${st.end.kmh.toFixed(0)} km/h${st.nan ? ' · NaN!' : ''}`;
const sane = (st, what) => { check(!st.nan, `${what}: no NaN`); check(!st.groundFlip, `${what}: never tipped over on the ground`); };

// autopilot pieces
const holdVy = (j, vy, k = 0.06) => Math.max(-1, Math.min(1, (vy - j.vel.y) * k));
const climbTo = (j, h, vMax) => holdVy(j, Math.max(-vMax, Math.min(vMax, (h - j.agl) * 0.15)));
const holdHeading = (j, want) => Math.max(-1, Math.min(1, -angle(want - j.heading()) * 4));
const levelWings = (j, bank = 0) => Math.max(-1, Math.min(1, (bank - j.bank) * 3));
// approach + flare + roll-out on the line (x0, z0, yaw) from where the plane is; steep: over a tree line into a field
function landingCtl(spec, line, steep = false) {
  return (t, J, j, input) => {
    J.yaw = 0; J.roll = 0;
    if (j.mode === 'air') {
      let wantBank = 0;
      if (line) {
        const hx = Math.sin(line.yaw), hz = Math.cos(line.yaw), off = (j.pos.x - line.x) * hz - (j.pos.z - line.z) * hx;
        const d = angle(line.yaw - Math.atan2(j.vel.x, j.vel.z));
        wantBank = Math.max(-0.35, Math.min(0.35, -d * 3 + off * 0.01));
      }
      J.roll = levelWings(j, wantBank);
      const wantVy = steep ? (j.agl > 8 ? -3 : j.agl > 2 ? -1.2 : -0.6) : j.agl > 5 ? -Math.min(3, Math.max(1.5, j.agl / 15)) : -0.8;
      J.pitch = holdVy(j, wantVy, 0.25);
      J.thr = j.vel.length() * KMH > spec.approach ? -1 : 0.6;
    } else { J.thr = -1; J.pitch = 0; input.handbrake = j.mode === 'ground'; if (line) J.yaw = holdHeading(j, line.yaw); }
  };
}

// ---------------------------------------------------------------- flat-ground tests
function flatTests(type) {
  const S = SPEC[type], info = typeInfo('jet', type);
  console.log(`\n== ${info.name} (${type}) on flat ground`);
  // model: lights, wheels, propeller, paint roles
  {
    const j = make(type, flat()); j.reset(0, 0, 0);
    const ud = j.mesh.userData, nav = ud.lights?.nav || {};
    check(['left', 'right', 'tail'].every(k => nav[k]?.isVector3) && ud.lights.head?.length === 1 && ud.landingLight, 'model: nav lights left/right/tail + a landing light');
    check(nav.left.x > 3 && nav.right.x < -3, 'model: red nav light on the left (+x) tip, green on the right');
    check(ud.wheels.length === 3 && j.wheels.length === 3 && ['elevator', 'rudder', 'aileronL', 'aileronR', 'canopy', 'propeller'].every(k => ud[k]), 'model: 3 wheels, control surfaces, canopy, propeller');
    let paint = 0; j.mesh.traverse(o => { if (o.material?.userData?.cosmeticRole) paint++; });
    check(paint >= 2, 'model: body + trim paint for the Garage');
    const hub = ud.propeller.hub, r0 = hub.rotation.z;
    const st = fly(j, 3, (t, J) => { J.thr = 1; J.pitch = 0; }, k => { k.throttle = 0; });
    for (let i = 0; i < 4; i++) j.syncMesh(1 / 60);
    check(hub.rotation.z !== r0 && ud.propeller.disc.visible, 'propeller spins with the throttle (blurred disc at full power)');
    j.crash('impact'); for (let i = 0; i < 300; i++) { j.step(DT, { jet: {} }); j.syncMesh(DT); }
    check(!ud.propeller.disc.visible && j.mesh.scale.y < 1, 'wreck: crumpled, propeller stopped');
    j.reset(0, 0, 0); j.syncMesh(DT);
    check(j.mesh.scale.y === 1 && ud.canopy.visible, 'reset: wreck look removed');
    sane(st, 'run-up');
  }
  // another player's copy (mp/remotes.js): their type's model, merged per part, moved by Jet.syncMesh on a puppet
  {
    const model = paintedModel('jet', {}, type), ud = model.userData;
    bakeParts(model, undefined, { keep: new Set([ud.canopy]), recolor: { mats: new Set(ud.wreckMats), color: new THREE.Color(ud.wreckColor) } });
    const pz = { kind: 'jet', mesh: model, renderPos: new THREE.Vector3(), renderQuat: new THREE.Quaternion(), steer: 0, throttle: 1, gear: 1, mode: 'air',
      wheels: ud.wheels.map(() => ({ spin: 0 })), input: { jet: { pitch: 0, roll: 1, yaw: 0 } }, typePhysics: typeInfo('jet', type).physics };
    for (let i = 0; i < 90; i++) Jet.prototype.syncMesh.call(pz, 1 / 60);
    let meshes = 0; model.traverse(o => { if (o.isMesh) meshes++; });
    check(model.name === `jet-${type}` && ud.propeller.disc.visible && ud.aileronL.rotation.x > 0.3 && meshes < 40,
      `other players see the ${type}: propeller spinning, ailerons moving (${meshes} meshes after merging)`);
    ud.wreck(true); check(!ud.canopy.visible && model.scale.y < 1, "other players' copy: wreck look");
  }
  // sitting pose: every wheel on the ground (tail wheel too)
  {
    const j = make(type, flat()); j.reset(0, 0, 0);
    const low = j.wheels.map(({ x, z, h }) => new THREE.Vector3(x, -h, z).applyQuaternion(j.quat).add(j.pos).y);
    const nose = Math.asin(new THREE.Vector3(0, 0, 1).applyQuaternion(j.quat).y);
    console.log(`   at rest: wheel bottoms ${low.map(y => y.toFixed(2)).join(' / ')} m, nose ${(nose * 57.3).toFixed(1)}°`);
    check(low.every(y => Math.abs(y) < 0.05), 'at rest: all three wheels on the ground');
    if (j.air.tail) check(nose > 0.15, 'tail wheel: sits nose up');
  }
  // take-off on asphalt and grass
  for (const [surface, name, maxRoll] of [[3, 'asphalt', S.roll], [0, 'grass', S.grassRoll]]) {
    const j = make(type, flat({ surface })); j.reset(0, 0, 0);
    const st = fly(j, 40, (t, J, k) => { J.thr = 1; J.pitch = k.mode === 'ground' ? (k.v * KMH > k.t.rotateKmh + 10 ? 1 : 0) : climbTo(k, 150, S.climb); });
    console.log(`   take-off (${name}): ${summary(st)}`);
    check(st.liftoff && st.liftoff.kmh >= S.liftoffKmh[0] && st.liftoff.kmh <= S.liftoffKmh[1], `take-off (${name}): lift-off speed within ${S.liftoffKmh.join('–')} km/h`);
    check(st.liftoff && st.liftoff.dist < maxRoll, `take-off (${name}): ground roll under ${maxRoll} m`);
    check(st.end.mode === 'air' && st.maxAlt > 100 && !st.crashes.length, `take-off (${name}): climbs away to 100+ m`);
    sane(st, `take-off (${name})`);
  }
  // climb rate at full throttle
  {
    const j = make(type, flat()); j.reset(0, 0, 0); j.placeInAir(0, 300, 0, 0, S.approach + 30);
    let best = 0;
    const st = fly(j, 30, (t, J, k) => { J.thr = 1; J.roll = levelWings(k); J.pitch = holdVy(k, S.climb * 1.6); if (t > 10) best = Math.max(best, k.vel.y); });
    console.log(`   climb: ${best.toFixed(1)} m/s · ${summary(st)}`);
    check(best > S.climb * 0.8 && !st.crashes.length, `climb: at least ${(S.climb * 0.8).toFixed(1)} m/s`);
    sane(st, 'climb');
  }
  // top speed, level at 800 m
  {
    const j = make(type, flat()); j.reset(0, 0, 0); j.placeInAir(0, 800, 0, 0, 150);
    const st = fly(j, 90, (t, J, k) => { J.thr = 1; J.roll = levelWings(k); J.pitch = Math.max(-1, Math.min(1, (800 - k.agl) * 0.01 - k.vel.y * 0.05)); });
    console.log(`   flat out: ${summary(st)}`);
    check(st.end.kmh >= S.top[0] && st.end.kmh <= S.top[1], `top speed ${st.end.kmh.toFixed(0)} km/h within ${S.top.join('–')}`);
    check(st.maxG <= S.maxG, `never over ${S.maxG} g`);
    sane(st, 'flat out');
  }
  // hands off at cruise: stays up, wings level
  {
    const j = make(type, flat()); j.reset(0, 0, 0); j.placeInAir(0, 500, 0, 0, S.approach + 50);
    const st = fly(j, 30, (t, J) => { J.thr = 0.6; });
    console.log(`   hands off 30 s: ${summary(st)} · bank ${(j.bank * 57.3).toFixed(0)}°`);
    check(st.end.mode === 'air' && Math.abs(j.bank) < 0.2 && st.minAgl > 300, 'hands off: stays up with the wings level');
    sane(st, 'hands off');
  }
  // 360° turn: bank and pull
  {
    const j = make(type, flat()); j.reset(0, 0, 0); j.placeInAir(0, 600, 0, 0, S.approach + 60);
    let turned = 0, prev = 0, done = null;
    const st = fly(j, 60, (t, J, k) => {
      J.thr = 1; J.roll = levelWings(k, 1.0); J.pitch = 0;          // the fly-by-wire holds height in the bank
      const h = Math.atan2(k.vel.x, k.vel.z); if (t > 0) turned += angle(h - prev); prev = h;
      if (!done && Math.abs(turned) > Math.PI * 2) done = t;
    });
    console.log(`   360° turn: ${done ? done.toFixed(1) + ' s' : 'not completed'} · ${summary(st)}`);
    check(done && st.end.mode === 'air', '360° turn completed, still flying');
    sane(st, 'turn');
  }
  // roll rate: full stick for one full roll
  {
    const j = make(type, flat()); j.reset(0, 0, 0); j.placeInAir(0, 900, 0, 0, S.approach + 80);
    let rolled = 0, prev = 0, done = null;
    const st = fly(j, 8, (t, J, k) => {
      J.thr = 1; J.roll = done ? 0 : 1; J.pitch = 0;
      if (t > 0) rolled += angle(k.bank - prev); prev = k.bank;
      if (!done && Math.abs(rolled) > Math.PI * 2) done = t;
    });
    console.log(`   full roll: ${done ? done.toFixed(2) + ' s' : 'not completed'} · ${summary(st)}`);
    check(done && (!S.roll360 || done < S.roll360), `full aileron roll${S.roll360 ? ` in under ${S.roll360} s` : ''}`);
    check(st.end.mode === 'air' && st.minAgl > 700, 'roll: still flying after');
    sane(st, 'roll');
  }
  // loop: full back stick from cruise
  {
    const j = make(type, flat()); j.reset(0, 0, 0); j.placeInAir(0, 1000, 0, 0, type === 'stunt' ? 330 : 240);
    let pitched = 0, prev = 0, done = null, top = -1e9, bottom = 1e9;
    const st = fly(j, 40, (t, J, k) => {
      J.thr = 1; J.roll = 0; J.pitch = done ? holdVy(k, 0) : 1;
      const fw = new THREE.Vector3(0, 0, 1).applyQuaternion(k.quat), up = new THREE.Vector3(0, 1, 0).applyQuaternion(k.quat);
      const p = Math.atan2(fw.y, Math.hypot(fw.x, fw.z) * Math.sign(up.y || 1));
      if (t > 0) pitched += angle(p - prev); prev = p;
      if (!done) { top = Math.max(top, k.pos.y); bottom = Math.min(bottom, k.pos.y); }
      if (!done && pitched > Math.PI * 2) done = t;
    });
    const r = (top - bottom) / 2;
    console.log(`   loop: ${done ? `${done.toFixed(1)} s, ~${r.toFixed(0)} m radius` : 'not completed'} · ${summary(st)}`);
    if (type === 'stunt') check(done && r < S.loopR, `loop completed, radius under ${S.loopR} m`);
    check(st.end.mode === 'air', 'loop: still flying after');
    sane(st, 'loop');
  }
  // stall: power off, stick held back; then let go + full power
  {
    const j = make(type, flat()); j.reset(0, 0, 0); j.placeInAir(0, 1500, 0, 0, S.approach + 30);
    let atRelease = null, low = 1e9;
    const st = fly(j, 40, (t, J, k) => {
      const holding = t < 15; J.thr = holding ? -1 : 1; J.pitch = holding ? 1 : t < 17 ? 0 : holdVy(k, 0, 0.03); J.roll = holding ? 0 : levelWings(k);
      if (!holding) { atRelease ??= k.pos.y; low = Math.min(low, k.pos.y); }
    });
    const lost = atRelease - low;
    console.log(`   stall + recover: lost ${lost.toFixed(0)} m after letting go · ${summary(st)}`);
    check(st.stallT > 0.5, 'stall: it stalls with the stick held back, power off');
    check(st.end.mode === 'air' && !j.stall && lost < 200, 'stall: recovers within 200 m (let go, full power, then ease out of the dive)');
    sane(st, 'stall');
  }
  // slowest level flight: hold height while the power comes off
  {
    const j = make(type, flat()); j.reset(0, 0, 0); j.placeInAir(0, 800, 0, 0, S.approach);
    const st = fly(j, 60, (t, J, k) => { J.thr = t < 5 ? 0 : -1; J.roll = levelWings(k); J.pitch = Math.max(-1, Math.min(1, (800 - k.agl) * 0.02 - k.vel.y * 0.1)); });
    const v = st.firstStall?.kmh;
    console.log(`   slow flight: first stall at ${v ? v.toFixed(0) : '-'} km/h · ${summary(st)}`);
    check(v >= S.stallKmh[0] && v <= S.stallKmh[1], `stall speed within ${S.stallKmh.join('–')} km/h`);
    sane(st, 'slow flight');
  }
  // landing from 60 m: touch down gently, roll out on the brakes
  {
    const j = make(type, flat()); j.reset(0, 0, 0); j.placeInAir(0, 60, 0, 0, S.approach);
    const st = fly(j, 90, landingCtl(S, { x: 0, z: 0, yaw: 0 }));
    const roll = st.landed && st.stoppedAt ? st.stoppedAt.distanceTo(st.landed.at) : Infinity;
    console.log(`   landing: roll-out ${roll.toFixed(0)} m · ${summary(st)}`);
    check(st.landed && !st.crashes.length && st.end.mode === 'ground', 'landing: lands on its wheels');
    check(roll < S.landRoll, `landing: stops within ${S.landRoll} m`);
    sane(st, 'landing');
  }
  // crashes: dive in, too hard, wing in the ground, water
  {
    const j = make(type, flat()); j.reset(0, 0, 0); j.safe = [[0, 0, 0]]; j.placeInAir(0, 150, 0, 0, 200);
    const st = fly(j, 12, (t, J) => { J.thr = 1; J.pitch = -1; });
    console.log(`   dive: ${summary(st)}`);
    check(st.crashes.length === 1 && st.respawned && st.end.mode === 'ground' && j.mesh.scale.y === 1, 'dive: crash, wreck, then back on the ground');
    sane(st, 'dive');
    const hard = make(type, flat()); hard.reset(0, 0, 0); hard.placeInAir(0, 30, 0, 0, S.approach);
    const st2 = fly(hard, 6, (t, J, k) => { J.thr = 0; J.roll = levelWings(k); J.pitch = holdVy(k, -14, 0.3); });
    check(st2.crashes.some(m => /too hard/.test(m)), `hard landing (14 m/s down): crash (${st2.crashes.join(', ')})`);
    const wing = make(type, flat()); wing.reset(0, 0, 0); wing.placeInAir(0, 40, 0, 0, S.approach + 20);
    const st3 = fly(wing, 20, (t, J, k) => { J.thr = 0.5; J.roll = levelWings(k, 1.2); J.pitch = holdVy(k, -5, 0.2); });
    check(st3.crashes.length > 0, `steep bank into the ground: crash (${st3.crashes.join(', ')})`);
    const wet = make(type, flat({ water: 0.5, h: 0 })); wet.reset(0, 0, 0); wet.placeInAir(0, 30, 0, 0, S.approach);
    const st4 = fly(wet, 50, landingCtl(S));
    check(st4.crashes.some(m => /water/i.test(m)), `landing on water: crash (${st4.crashes.join(', ')})`);
    for (const s of [st2, st3, st4]) sane(s, 'crash');
  }
  // taxi: slow full-rudder circle
  {
    const j = make(type, flat({ surface: 0 })); j.reset(0, 0, 0);
    let turned = 0, prev = 0;
    const st = fly(j, 25, (t, J, k) => { J.thr = k.v * KMH < 25 ? 0.4 : -1; J.yaw = 1; const h = k.heading(); if (t > 0) turned += angle(h - prev); prev = h; });
    console.log(`   taxi: turned ${(Math.abs(turned) * 57.3).toFixed(0)}° · ${summary(st)}`);
    check(Math.abs(turned) > Math.PI * 2 && st.end.mode === 'ground', 'taxi: full circle on the ground');
    sane(st, 'taxi');
  }
}

// ---------------------------------------------------------------- real map
async function loadWorld() {
  const A = (process.env.YR_ASSETS || 'game/assets').replace(/\/?$/, '/');
  const WJ = JSON.parse(fs.readFileSync(A + 'world.json')), W = makeWorld(WJ);
  const CH = JSON.parse(fs.readFileSync(A + 'challenges.json')).filter(c => c.vehicle === 'jet');
  const R0 = JSON.parse(fs.readFileSync(A + 'ramps.json'))[0];
  // the tiles under the race courses (+1 around) and the test spots, not the whole map
  const want = new Set(), T = WJ.tile;
  const box = (x0, z0, x1, z1) => { for (let tx = Math.floor((x0 + T / 2) / T) - 1; tx <= Math.floor((x1 + T / 2) / T) + 1; tx++) for (let tz = Math.floor((z0 + T / 2) / T) - 1; tz <= Math.floor((z1 + T / 2) / T) + 1; tz++) want.add(`${tx}_${tz}`); };
  for (const c of CH) { const xs = c.gates.map(g => g.x), zs = c.gates.map(g => g.z); box(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)); }
  box(R0.x - 2500, R0.z - 2500, R0.x + 2500, R0.z + 2500);
  const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  let n = 0;
  for (const [tx, tz] of WJ.tiles) {
    if (!want.has(`${tx}_${tz}`)) continue;
    const d = `${A}tiles/${tx}_${tz}/`;
    W.add(makeTileData(WJ, tx, tz, await readTileData(async f => ab(d + f), WJ.packed))); n++;
  }
  console.log(`\nloaded ${n} tiles`);
  W.setFixedRamps([]);
  return { W, CH, R0 };
}
const FIELD = [828, 480];        // open farm fields east of campus (drive.mjs)

function mapTests(type, { W, CH, R0 }) {
  const S = SPEC[type], info = typeInfo('jet', type);
  console.log(`\n== ${info.name} (${type}) on the map`);
  const hx = Math.sin(R0.yaw), hz = Math.cos(R0.yaw);
  {
    const j = make(type, W), x = R0.x - hx * 600, z = R0.z - hz * 600; j.reset(x, z, R0.yaw);
    const st = fly(j, 40, (t, J, k) => { J.thr = 1; J.yaw = k.mode === 'ground' ? holdHeading(k, R0.yaw) : 0; J.pitch = k.mode === 'ground' ? (k.v * KMH > k.t.rotateKmh + 10 ? 1 : 0) : climbTo(k, 150, S.climb); J.roll = k.mode === 'air' ? levelWings(k) : 0; });
    console.log(`   take-off on Hwy 18: ${summary(st)}`);
    check(st.liftoff && st.liftoff.dist < S.roll * 1.3 && st.end.mode === 'air' && !st.crashes.length, 'take-off from Hwy 18');
    sane(st, 'Hwy 18 take-off');
  }
  {
    const j = make(type, W); j.reset(...FIELD, Math.PI / 2);
    const st = fly(j, 40, (t, J, k) => { J.thr = 1; J.pitch = k.mode === 'ground' ? (k.v * KMH > k.t.rotateKmh + 10 ? 1 : 0) : climbTo(k, 150, S.climb); J.roll = k.mode === 'air' ? levelWings(k) : 0; });
    console.log(`   take-off from the field: ${summary(st)}`);
    check(st.liftoff && st.end.mode === 'air' && !st.crashes.length, 'take-off from the field');
    sane(st, 'field take-off');
  }
  {
    const d = 1800, x = R0.x - hx * d, z = R0.z - hz * d, line = { x, z, yaw: R0.yaw };
    const j = make(type, W); j.reset(x, z, R0.yaw); j.placeInAir(x, W.heightAt(x, z) + 1.6 + 70, z, R0.yaw, S.approach);
    const st = fly(j, 120, landingCtl(S, line));
    const s = st.stoppedAt ? W.surfaceAt(st.stoppedAt.x, st.stoppedAt.z) : -1;
    console.log(`   landing on Hwy 18: ${summary(st)} · stopped on surface ${s}`);
    check(st.landed && !st.crashes.length && st.end.mode === 'ground' && s === 3, 'landing on Hwy 18: down and stopped on the asphalt');
    sane(st, 'Hwy 18 landing');
  }
  {
    // the field east of campus is open from x ≈ 600 to ≈ 1380 on this line, with tree rows at both ends: come in
    // over the western trees at ~20 m (start 40 m up, sinking 3 m/s) and touch down in the first half
    const [fx, fz] = FIELD, x = 580 - S.approach / KMH * 6.7, line = { x, z: fz, yaw: Math.PI / 2 };
    const j = make(type, W); j.reset(fx, fz, Math.PI / 2); j.placeInAir(x, W.heightAt(x, fz) + 40, fz, Math.PI / 2, S.approach);
    const st = fly(j, 90, landingCtl(S, line, true));
    console.log(`   landing on the field: ${summary(st)}`);
    check(st.landed && !st.crashes.length && st.end.mode === 'ground', 'landing on the field');
    sane(st, 'field landing');
  }
  {
    const j = make(type, W); j.reset(...FIELD, 0); j.safe = [[...FIELD, 0]]; j.placeInAir(FIELD[0], W.heightAt(...FIELD) + 120, FIELD[1], Math.PI / 2, 220);
    const st = fly(j, 10, (t, J) => { J.thr = 1; J.pitch = -1; });
    console.log(`   dive into the field: ${summary(st)}`);
    check(st.crashes.length === 1 && st.respawned && st.end.mode === 'ground', 'dive into the field: crash, then back on the ground');
    sane(st, 'map dive');
  }
  for (const c of CH) raceBot(type, W, c);
}

// a bot flies one jet race through every ring in order (from drive.mjs, with this type's speeds and limits)
function raceBot(type, W, c) {
  const S = SPEC[type], G = c.gates, P = type === 'prop' ? { fast: 400, slow: 400, maxBank: 0.95, vy: 5 } : { fast: 380, slow: 300, maxBank: 1.25, vy: 14 };
  let next = 1, done = null, prev = null, rings = 0;
  const j = make(type, W); j.reset(c.start.x, c.start.z, c.start.yaw);
  j.respawn = () => next >= 2 ? [G[next - 1].x, G[next - 1].y, G[next - 1].z, G[next - 1].yaw, 450] : null;
  const st = fly(j, type === 'prop' ? 900 : 600, (t, J, k) => {
    if (done) return false;
    const g = G[next], kmh = k.vel.length() * KMH;
    if (k.mode === 'ground') { J.thr = 1; J.yaw = holdHeading(k, c.start.yaw); J.pitch = kmh > k.t.rotateKmh + 10 ? 1 : 0; J.roll = 0; }
    else if (k.mode === 'air') {
      const dist0 = Math.hypot(g.x - k.pos.x, g.z - k.pos.z), lead = Math.min(250, dist0 * 0.5);
      const ax = g.x - Math.sin(g.yaw) * lead, az = g.z - Math.cos(g.yaw) * lead;
      const head = Math.atan2(k.vel.x, k.vel.z), brg = Math.atan2(ax - k.pos.x, az - k.pos.z);
      const d = angle(brg - head), hd = Math.hypot(ax - k.pos.x, az - k.pos.z);
      const v = k.vel.length(), gr = k.t.gravity;
      const dB = k._brg === undefined ? 0 : angle(brg - k._brg); k._brg = brg;
      k._dB = (k._dB ?? 0) * 0.9 + 0.1 * dB / DT;
      const aLat = 3 * v * k._dB + 1.2 * v * d * 0.5;
      const R = v * v / (gr * Math.tan(P.maxBank));
      if (dist0 < 2.2 * R && Math.abs(d) > 1.2) k._extend = true;
      if (k._extend && (dist0 > 3 * R || Math.abs(d) < 0.25)) k._extend = false;
      let wantBank = k._extend ? 0 : Math.max(-P.maxBank, Math.min(P.maxBank, -Math.atan2(aLat, gr)));
      if (dist0 < 400 && !k._extend) { const dc = angle(Math.atan2(g.x - k.pos.x, g.z - k.pos.z) - head); wantBank = Math.max(-0.6, Math.min(0.6, -dc * 2.5)); }
      J.roll = levelWings(k, wantBank); J.yaw = 0;
      let wantVy = Math.max(-P.vy * 2, Math.min(P.vy, (g.y - k.pos.y) * Math.max(0.12, Math.min(0.6, 120 / Math.max(hd, 1)))));
      const floor = Math.max(W.heightAt(k.pos.x + k.vel.x * 3, k.pos.z + k.vel.z * 3), W.heightAt(k.pos.x, k.pos.z)) + 60;
      if (k.pos.y < floor && dist0 > 300) wantVy = Math.max(wantVy, Math.min(P.vy, (floor - k.pos.y) * 0.5));
      J.pitch = Math.max(-1, Math.min(1, (wantVy - k.vel.y) * 0.05 + (k._extend ? 0 : Math.min(0.6, Math.abs(d) * 1.5) * Math.abs(Math.sin(k.bank)))));
      J.thr = kmh < (Math.abs(d) > 0.3 ? P.slow : P.fast) ? 1 : -1;
    }
    const p = [k.pos.x, k.pos.y, k.pos.z];
    if (prev && k.mode !== 'crashed') {
      const fx = Math.sin(g.yaw), fz = Math.cos(g.yaw);
      const d0 = (prev[0] - g.x) * fx + (prev[2] - g.z) * fz, d1 = (p[0] - g.x) * fx + (p[2] - g.z) * fz;
      if (d0 <= 0 && d1 > 0) {
        const u = -d0 / (d1 - d0), ix = prev[0] + (p[0] - prev[0]) * u, iy = prev[1] + (p[1] - prev[1]) * u, iz = prev[2] + (p[2] - prev[2]) * u;
        const lat = (ix - g.x) * Math.cos(g.yaw) - (iz - g.z) * Math.sin(g.yaw);
        const ok = g.y === undefined ? Math.abs(lat) < g.w / 2 + 1.5 : Math.hypot(lat, iy - g.y) <= g.r + 1;
        if (process.env.JV) console.log('     cross ring', next, ok ? 'OK' : 'MISS', t.toFixed(1));
        if (ok) { rings++; next++; k._extend = false; k._dB = 0; k._brg = undefined; if (next >= G.length) done = t; }
      }
    }
    prev = p;
  });
  console.log(`   race ${c.name}: ${done ? `finished in ${done.toFixed(1)} s` : `DID NOT FINISH (${rings}/${G.length - 1} rings)`} · ${summary(st)}`);
  check(done && !st.crashes.length, `race ${c.name}: bot flies every ring without crashing`);
  sane(st, `race ${c.name}`);
}

// ---------------------------------------------------------------- run
// the fighter keeps the jet's own airframe and numbers (its flights are checked by drive.mjs jet)
{
  const j = make('fighter', flat());
  check(j.air.wb === FIGHTER_AIRFRAME.wb && j.t === j._typeBaseTuning && j.mesh.name === 'jet' && VEHICLE_TYPES.jet[0].id === 'fighter', 'Fighter jet: original tuning, airframe and model');
  disposeCosmeticPreview(applyVehicleType(j, 'prop')); disposeCosmeticPreview(applyVehicleType(j, 'fighter'));
  check(j.air.gearH === 1.6 && j.wheels[0].z === 3.6 && j.half.x === 4.9 && j.mesh.userData.flame, 'Fighter jet: restored after switching types');
}
for (const type of TYPES) flatTests(type);
if (!FLAT_ONLY) { const map = await loadWorld(); for (const type of TYPES) mapTests(type, map); }
console.log(failures ? `\nFAILED: ${failures} check(s)` : '\nPASS: all checks');
process.exit(failures ? 1 : 0);
