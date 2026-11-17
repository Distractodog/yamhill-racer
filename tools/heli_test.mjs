// Helicopter flight test (game/src/heli.js), Node only. Flat-world checks first (lift-off, hover, climb, top speed,
// hands-off stop, banked turn, pedal turn, landing, slope, crashes, wreck + respawn, Garage type swap), then the real
// map (take-off and landing on a field and on Hwy 18, a bot flying each jet race through its rings).
//   node tools/heli_test.mjs            everything (loads ~60 tiles: run it through the heavy-check gate)
//   node tools/heli_test.mjs --flat     flat-world checks only (a few seconds)
// Every state is checked finite on every step. Exits non-zero on any failure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { Heli, HELI } from '../game/src/heli.js';
import { Jet } from '../game/src/jet.js';

const DT = 1 / 120, up = new THREE.Vector3(), results = [];
const kmh = h => Math.hypot(h.vel.x, h.vel.z) * 3.6;
const flat = (o = {}) => ({ extent: [-1e5, -1e5, 1e5, 1e5], spawn: [0, 0], heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0,
  surfaceAt: () => 0, normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0), waterLevelAt: () => -Infinity,
  loadedAt: () => true, mapContains: () => true, treesNear() {}, buildingsNear: () => [], ...o });
const input = () => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, jet: { thr: 0, pitch: 0, roll: 0, yaw: 0 } });
// step for `secs` with ctl(t, J, h) before each step; every step is checked finite. Returns per-run stats.
function fly(h, inp, secs, ctl = () => {}) {
  const st = { modes: [], minAgl: Infinity, maxAgl: -Infinity, maxKmh: 0, landed: null, crashed: null };
  let last = h.mode;
  for (let i = 0; i < secs / DT; i++) {
    const t = i * DT;
    const J = inp.jet; J.thr = J.pitch = J.roll = J.yaw = 0;      // hands off unless ctl says otherwise
    ctl(t, J, h);
    h.savePrev(); h.step(DT, inp); h.interpolate(1); h.syncMesh(DT);
    assert([...h.pos, ...h.vel, ...h.quat, ...h.ang, h.rotor, h.agl].every(Number.isFinite), `non-finite state at ${t.toFixed(2)} s`);
    if (h.mode !== last) {
      st.modes.push(`${h.mode}@${t.toFixed(1)}`);
      if (h.mode === 'ground' && last === 'air') st.landed = { t, sink: -h._prevVel.y, kmh: kmh(h) };
      if (h.mode === 'crashed') st.crashed = { t, mode: h.mode };
      last = h.mode;
    }
    if (h.mode === 'air') { st.minAgl = Math.min(st.minAgl, h.agl); st.maxAgl = Math.max(st.maxAgl, h.agl); }
    st.maxKmh = Math.max(st.maxKmh, kmh(h));
  }
  return st;
}
function check(name, fn) {
  try { const note = fn(); results.push([name, 'pass', note || '']); console.log(`PASS ${name}${note ? ' · ' + note : ''}`); }
  catch (e) { results.push([name, 'FAIL', e.message]); console.log(`FAIL ${name}: ${e.message}`); }
}
const airborne = (h, inp, y = 40) => { h.reset(0, 0, 0); fly(h, inp, 12, (t, J, k) => { J.thr = k.agl < y ? 1 : 0; }); fly(h, inp, 3); };

// ------------------------------------------------------------------------------------------------- flat world
check('idle on the ground: rotor idles, stays put', () => {
  const h = new Heli(flat()), inp = input(); h.reset(0, 0, 0);
  const st = fly(h, inp, 5);
  assert.equal(h.mode, 'ground'); assert(Math.abs(h.pos.y - 1.6) < 1e-6); assert(h.rotor <= HELI.idle + 1e-9);
  assert.equal(st.modes.length, 0);
  return `rotor ${(h.rotor * 100).toFixed(0)}%, y ${h.pos.y.toFixed(2)} m`;
});
check('lift-off + climb: W spools the rotor, lifts, climbs ~10 m/s', () => {
  const h = new Heli(flat()), inp = input(); h.reset(0, 0, 0);
  let lift = null;
  fly(h, inp, 6, (t, J, k) => { J.thr = 1; if (lift === null && k.mode === 'air') lift = t; });
  assert(lift !== null && lift < 2, `lift-off at ${lift}`);
  assert(h.vel.y > 9 && h.vel.y < 11, `climb ${h.vel.y.toFixed(2)} m/s`);
  return `lift-off after ${lift.toFixed(2)} s, climbing ${h.vel.y.toFixed(1)} m/s at ${h.agl.toFixed(0)} m`;
});
check('hover hands off: holds height and position for 15 s', () => {
  const h = new Heli(flat()), inp = input(); airborne(h, inp);
  const p0 = h.pos.clone();
  fly(h, inp, 15);
  const drift = Math.hypot(h.pos.x - p0.x, h.pos.z - p0.z), dy = Math.abs(h.pos.y - p0.y);
  assert(drift < 0.5 && dy < 0.3, `drift ${drift.toFixed(2)} m, height change ${dy.toFixed(2)} m`);
  up.set(0, 1, 0).applyQuaternion(h.quat); assert(up.y > 0.9999, 'level');
  return `drift ${drift.toFixed(3)} m, height change ${dy.toFixed(3)} m`;
});
check('forward flight: ↑ held reaches ~250 km/h and keeps its height', () => {
  const h = new Heli(flat()), inp = input(); airborne(h, inp);
  const y0 = h.pos.y; let t200 = null;
  const st = fly(h, inp, 45, (t, J, k) => { J.pitch = -1; if (t200 === null && kmh(k) >= 200) t200 = t; });
  assert(st.maxKmh > 235 && st.maxKmh < 265, `top ${st.maxKmh.toFixed(0)} km/h`);
  assert(Math.abs(h.pos.y - y0) < 1.5, `height change ${(h.pos.y - y0).toFixed(2)} m`);
  const fw = new THREE.Vector3(0, 0, 1).applyQuaternion(h.quat);
  assert(h.vel.dot(fw) > 0 && fw.y < -0.1 && fw.y > -0.3, `flies nose-first, nose a little down (${fw.y.toFixed(2)})`);
  return `top ${st.maxKmh.toFixed(0)} km/h, 0–200 in ${t200.toFixed(1)} s, height held within ${Math.abs(h.pos.y - y0).toFixed(2)} m`;
});
check('hands off at speed: levels itself and slows to a hover', () => {
  const h = new Heli(flat()), inp = input(); airborne(h, inp);
  fly(h, inp, 30, (t, J) => { J.pitch = -1; });
  let stop = null;
  fly(h, inp, 25, (t, J, k) => { if (stop === null && kmh(k) < 2) stop = t; });
  assert(stop !== null && stop < 16, `stopped after ${stop}`);
  assert(Math.abs(h.pitch) < 0.01 && Math.abs(h.roll) < 0.01 && kmh(h) < 0.5, `pitch ${h.pitch.toFixed(3)} roll ${h.roll.toFixed(3)} ${kmh(h).toFixed(2)} km/h`);
  return `250 → hover in ${stop.toFixed(1)} s, level`;
});
check('tilt: ↓ flies backwards, ← / → slide sideways at a hover', () => {
  const h = new Heli(flat()), inp = input(); airborne(h, inp);
  const fx = () => h.vel.x * Math.sin(h.yaw) + h.vel.z * Math.cos(h.yaw), lx = () => h.vel.x * Math.cos(h.yaw) - h.vel.z * Math.sin(h.yaw);
  fly(h, inp, 3, (t, J) => { J.pitch = 1; }); const back = fx(); fly(h, inp, 8);
  fly(h, inp, 1.5, (t, J) => { J.roll = 1; }); const right = lx(); fly(h, inp, 8);
  fly(h, inp, 1.5, (t, J) => { J.roll = -1; }); const left = lx();
  assert(back < -5 && right < -2 && left > 2, `back ${back.toFixed(1)} right ${right.toFixed(1)} left ${left.toFixed(1)} m/s`);
  return `back ${back.toFixed(1)} m/s, right ${(-right).toFixed(1)} m/s, left ${left.toFixed(1)} m/s`;
});
check('banked turn at speed: → turns right, flight path follows', () => {
  const h = new Heli(flat()), inp = input(); airborne(h, inp);
  fly(h, inp, 20, (t, J) => { J.pitch = -1; });
  const y0 = h.yaw, v0 = Math.atan2(h.vel.x, h.vel.z); let turned = 0, prev = h.yaw;
  fly(h, inp, 6, (t, J, k) => { J.pitch = -1; J.roll = 1; let d = k.yaw - prev; d = Math.atan2(Math.sin(d), Math.cos(d)); turned += d; prev = k.yaw; });
  const slip = Math.atan2(Math.sin(Math.atan2(h.vel.x, h.vel.z) - h.yaw), Math.cos(Math.atan2(h.vel.x, h.vel.z) - h.yaw));
  assert(turned < -2.5, `turned ${turned.toFixed(2)} rad`);
  assert(Math.abs(slip) < 0.35, `flight path ${slip.toFixed(2)} rad off the nose`);
  assert(kmh(h) > 180, `kept speed ${kmh(h).toFixed(0)}`);
  return `${(-turned * 57.3).toFixed(0)}° right in 6 s at ${kmh(h).toFixed(0)} km/h, path within ${(Math.abs(slip) * 57.3).toFixed(0)}° of the nose`;
});
check('pedal turn at a hover: A / D yaw on the spot', () => {
  const h = new Heli(flat()), inp = input(); airborne(h, inp);
  const p0 = h.pos.clone(), y0 = h.yaw;
  fly(h, inp, 1, (t, J) => { J.yaw = 1; });
  const right = Math.atan2(Math.sin(h.yaw - y0), Math.cos(h.yaw - y0));
  const y1 = h.yaw; fly(h, inp, 1, (t, J) => { J.yaw = -1; });
  const left = Math.atan2(Math.sin(h.yaw - y1), Math.cos(h.yaw - y1));
  assert(right < -1.2 && left > 1.2 && h.pos.distanceTo(p0) < 0.3, `D ${right.toFixed(2)} A ${left.toFixed(2)} moved ${h.pos.distanceTo(p0).toFixed(2)}`);
  return `D ${(right * 57.3).toFixed(0)}°/s, A ${(left * 57.3).toFixed(0)}°/s, moved ${h.pos.distanceTo(p0).toFixed(2)} m`;
});
check('landing: hold S from 40 m, gentle touchdown on the skids, rotor winds down', () => {
  const h = new Heli(flat()), inp = input(); airborne(h, inp);
  const st = fly(h, inp, 20, (t, J, k) => { J.thr = k.mode === 'air' ? -1 : 0; });
  assert(st.landed && !st.crashed, `modes ${st.modes}`);
  assert(st.landed.sink < 2.5, `sink ${st.landed.sink.toFixed(2)} m/s`);
  assert.equal(h.mode, 'ground'); assert(Math.abs(h.pos.y - 1.6) < 1e-6, `on skids y ${h.pos.y}`);
  fly(h, inp, 6);
  assert(h.rotor < HELI.idle + 0.05, `rotor ${h.rotor.toFixed(2)}`);
  return `touchdown at ${st.landed.sink.toFixed(2)} m/s, rotor back to ${(h.rotor * 100).toFixed(0)}%`;
});
check('landing with some forward speed: skids slide to a stop', () => {
  const h = new Heli(flat()), inp = input(); airborne(h, inp, 6);
  fly(h, inp, 2.5, (t, J) => { J.pitch = -0.6; });
  const st = fly(h, inp, 12, (t, J, k) => { J.pitch = 0; J.thr = k.mode === 'air' ? -1 : 0; });
  assert(st.landed && !st.crashed && st.landed.kmh > 5, `modes ${st.modes} ${JSON.stringify(st.landed)}`);
  assert.equal(h.mode, 'ground'); assert(kmh(h) === 0);
  return `touchdown at ${st.landed.kmh.toFixed(0)} km/h, ${st.landed.sink.toFixed(2)} m/s sink, stopped`;
});
check('too steep: a 30° hillside bumps it off, no landing, no crash; flat ground lands', () => {
  const slope = Math.tan(30 / 57.3), W = flat({ heightAt: x => x > 0 ? x * slope : 0, terrainAt: x => x > 0 ? x * slope : 0 });
  const h = new Heli(W), inp = input(); h.reset(-50, 0, 0);
  fly(h, inp, 8, (t, J, k) => { J.thr = k.agl < 30 ? 1 : 0; });
  h.pos.x = 40; h.savePrev();
  const st = fly(h, inp, 6, (t, J) => { J.thr = -1; });
  assert(!st.landed && !st.crashed && h.mode === 'air', `modes ${st.modes}`);
  assert(h.steep, 'HUD warns: too steep');
  assert(/too steep/.test(h.hudInfo()));
  fly(h, inp, 3, (t, J) => { J.thr = 1; }); h.pos.x = -40; h.savePrev();
  const st2 = fly(h, inp, 15, (t, J, k) => { J.thr = k.mode === 'air' ? -1 : 0; });
  assert(st2.landed && h.mode === 'ground', `modes ${st2.modes}`);
  return `bumped along the slope at agl ${st.minAgl.toFixed(2)}…, then landed on the flat`;
});
check('crash: coming down too hard (12 m/s sink)', () => {
  const h = new Heli(flat()), inp = input(); airborne(h, inp, 10);
  h.vel.y = -12; h.rotor = 0.2;
  const st = fly(h, inp, 3);
  assert(st.crashed?.mode === 'crashed', JSON.stringify(st));
  assert.equal(h.mesh.scale.y, 0.7); assert(!h.mesh.userData.canopy.visible);
  return st.modes.join(' → ');
});
check('crash: flying into the ground at speed', () => {
  const h = new Heli(flat()), inp = input(); airborne(h, inp, 20);
  fly(h, inp, 20, (t, J) => { J.pitch = -1; });
  const st = fly(h, inp, 10, (t, J) => { J.pitch = -1; J.thr = -1; });
  // the sink eases near the ground, so dive with the collective down hard
  assert(st.crashed, `modes ${st.modes} ${JSON.stringify(st.landed)} agl ${st.minAgl}`);
  return h.mode;
});
check('crash: tipped past 60°', () => {
  const h = new Heli(flat()), inp = input(); airborne(h, inp);
  h.pitch = 2.6; h.setPose();          // (the stick stops well short of this: knocked over, e.g. in a collision)
  h.step(DT, inp);
  assert.equal(h.mode, 'crashed');
  return h.mode;
});
check('crash: rotor into a cliff while sliding sideways', () => {
  const W = flat({ heightAt: x => x < -12 ? 60 : 0, terrainAt: x => x < -12 ? 60 : 0 });
  const h = new Heli(W), inp = input(); airborne(h, inp, 20);
  const st = fly(h, inp, 6, (t, J) => { J.roll = 1; });
  assert(st.crashed?.mode === 'crashed', JSON.stringify(st));
  return st.modes.join(' → ');
});
check('crash: water under the skids, trees, buildings', () => {
  const wet = new Heli(flat({ waterLevelAt: () => 0.5 })), inp = input();
  wet.reset(0, 0, 0); wet.placeInAir(0, 20, 0, 0, 0);
  const a = fly(wet, inp, 15, (t, J) => { J.thr = -1; });
  assert(a.crashed?.mode === 'crashed', JSON.stringify(a));
  const trees = new Heli(flat({ treesNear(x, z, r, cb) { cb(0, 60, 0.4, 25, 1); } })), inp2 = input();
  airborne(trees, inp2, 10);
  const b = fly(trees, inp2, 10, (t, J) => { J.pitch = -1; });
  assert(b.crashed?.mode === 'crashed', JSON.stringify(b));
  const box = { pts: [[-20, 50], [20, 50], [20, 70], [-20, 70]], h: 30, top: 30 };
  const bld = new Heli(flat({ buildingsNear: () => [box] })), inp3 = input();
  airborne(bld, inp3, 10);
  const c = fly(bld, inp3, 10, (t, J) => { J.pitch = -1; });
  assert(c.crashed?.mode === 'crashed', JSON.stringify(c));
  return `${a.crashed.mode} / ${b.crashed.mode} / ${c.crashed.mode}`;
});
check('wreck: tumbles with its momentum, bounces, then back at the last safe spot', () => {
  const h = new Heli(flat()), inp = input(); airborne(h, inp, 15);
  fly(h, inp, 6, (t, J) => { J.pitch = -1; });
  const start = h.pos.clone(); h.vel.y = -14; h.rotor = 0.1;
  let bounces = 0, prev = 0, crashedAt = null;
  fly(h, inp, 7, (t, J, k) => { if (k.mode === 'crashed') { if (crashedAt === null) crashedAt = t; if (prev < 0 && k.vel.y > 0) bounces++; prev = k.vel.y; } });
  assert(crashedAt !== null && bounces >= 1, `crash ${crashedAt} bounces ${bounces}`);
  assert.equal(h.mode, 'ground'); assert.equal(h.mesh.scale.y, 1); assert(h.mesh.userData.canopy.visible);
  assert(Math.hypot(h.pos.x, h.pos.z) < 10, `respawned at ${h.pos.x.toFixed(1)}, ${h.pos.z.toFixed(1)}`);
  return `${bounces} bounces, respawned on its skids where it took off (${start.distanceTo(h.pos).toFixed(0)} m back)`;
});
check('race respawn: a crash puts it back in the air at the last ring', () => {
  const h = new Heli(flat()), inp = input(); airborne(h, inp, 10);
  let calls = 0; h.respawn = () => { calls++; return [500, 200, 300, 1, 450]; };
  h.crash('impact'); fly(h, inp, 5);
  assert.equal(calls, 1); assert.equal(h.mode, 'air'); assert(Math.abs(h.pos.y - 200) < 2 && Math.abs(h.pos.x - 500) < 20);
  assert(kmh(h) <= 151, `respawn speed ${kmh(h).toFixed(0)}`);
  return `respawned flying at ${kmh(h).toFixed(0)} km/h`;
});
check('mesh: rotors spin with power; wreck stops them; F levels it', () => {
  const h = new Heli(flat()), inp = input(); h.reset(0, 0, 0);
  const ud = h.mesh.userData;
  fly(h, inp, 1); const idle = ud.spin; fly(h, inp, 0.5); const idleRate = ((ud.spin - idle + 2 * Math.PI) % (2 * Math.PI)) * 2;
  airborne(h, inp, 10); const a = ud.spin; fly(h, inp, 0.1); const fullRate = ((ud.spin - a + 2 * Math.PI) % (2 * Math.PI)) * 10;
  assert(fullRate > idleRate * 3 && ud.disc.visible, `idle ${idleRate.toFixed(2)} full ${fullRate.toFixed(2)} rad/s`);
  h.roll = 0.4; h.pitch = 0.3; h.setPose(); h.flipUpright(); up.set(0, 1, 0).applyQuaternion(h.quat); assert(up.y > 0.9999);
  return `rotor ${idleRate.toFixed(1)} rad/s at idle, ${fullRate.toFixed(1)} rad/s flying`;
});
{
  // vehicles.js in Node: no DOM; the jet slot follows the type
  const { createVehicles } = await import('../game/src/vehicles.js');
  const { TUNING_DEFAULTS } = await import('../game/src/car.js');
  const { VEHICLE_TYPES } = await import('../game/src/vehicletypes.js');
  check('Garage: the Helicopter type swaps the jet slot to heli.js and back, in place', () => {
    const scene = new THREE.Scene(), W = flat();
    const v = createVehicles({ scene, world: W, tuning: { ...TUNING_DEFAULTS } });
    assert(v.jet instanceof Jet && v.all.jet === v.jet);
    v.switchTo('jet'); const jet = v.current; assert(jet instanceof Jet);
    jet.placeInAir(100, 300, 100, 0, 500);
    v.setType('jet', 'heli');
    assert(v.jet instanceof Heli && v.all.jet === v.jet && v.current === v.jet, 'current vehicle is the helicopter');
    assert(v.current.mode === 'air' && Math.abs(v.current.pos.x - 100) < 1, 'kept flying where the jet was');
    assert(scene.children.includes(v.current.mesh) && !scene.children.includes(jet.mesh), 'model swapped in the scene');
    assert.equal(v.current.mesh.name, 'heli'); assert.equal(v.current.name, 'Helicopter');
    v.setType('jet', 'fighter');
    assert(v.current instanceof Jet && v.current === jet && v.jet === jet && scene.children.includes(jet.mesh));
    v.setType('jet', 'heli'); v.switchTo('car'); v.switchTo('jet');
    assert(v.current instanceof Heli, 'V → jet picks the helicopter while that type is chosen');
    v.setType('jet', 'fighter');
    return 'jet ⇄ helicopter, current vehicle and scene model follow';
  });
  check('Garage: swapping aircraft type while flying low keeps it in the air at the same height (any height)', () => {
    const v = createVehicles({ scene: new THREE.Scene(), world: flat(), tuning: { ...TUNING_DEFAULTS } }), inp = input(), notes = [];
    v.switchTo('jet'); v.setType('jet', 'heli');
    const h = v.current; assert(h instanceof Heli);
    for (const want of [3, 0.6]) {
      // the helicopter hovering low → Fighter jet: still flying, same spot, same height
      fly(h, inp, 12, (t, J, k) => { J.thr = k.agl < want - 0.05 ? 0.3 : k.agl > want + 0.05 ? -0.3 : 0; });
      assert(h.mode === 'air' && Math.abs(h.agl - want) < 0.3, `hovering at ${h.agl.toFixed(2)} m`);
      const p = h.pos.clone();
      v.setType('jet', 'fighter');
      const j = v.current;
      assert(j instanceof Jet && j.mode === 'air', `jet ${j.mode} after the swap at ${want} m`);
      assert(Math.abs(j.pos.y - p.y) < 1e-9 && Math.hypot(j.pos.x - p.x, j.pos.z - p.z) < 1e-9, `jet at ${j.pos.y.toFixed(2)} vs ${p.y.toFixed(2)}`);
      assert(Math.abs(j.heading() - h.yaw) < 1e-6, 'facing the way the helicopter faced');
      // and back: the jet low over the ground → Helicopter, still flying at that height
      const q = j.pos.clone();
      v.setType('jet', 'heli');
      assert(v.current === h && h.mode === 'air' && Math.abs(h.pos.y - q.y) < 1e-9 && Math.hypot(h.pos.x - q.x, h.pos.z - q.z) < 1e-9, `helicopter ${h.mode} at ${h.pos.y.toFixed(2)}`);
      fly(h, inp, 6);
      assert(h.mode === 'air', `the helicopter flies on after the swap (${h.mode}, ${h.msg})`);
      notes.push(`${want} m`);
    }
    // on the ground it stays on the ground
    fly(h, inp, 10, (t, J, k) => { J.thr = k.mode === 'air' ? -1 : 0; });
    assert.equal(h.mode, 'ground');
    v.setType('jet', 'fighter'); assert(v.current instanceof Jet && v.current.mode === 'ground', 'parked swap stays parked');
    return `heli ⇄ jet in the air at ${notes.join(' and ')} above the ground, parked swap stays on the ground`;
  });
  check('Garage: every aircraft type ⇄ every other in flight keeps flying at the same spot and height (planes too)', () => {
    const v =createVehicles({ scene: new THREE.Scene(), world: flat(), tuning: { ...TUNING_DEFAULTS } }), ids = VEHICLE_TYPES.jet.map(t => t.id);
    v.switchTo('jet'); v.current.placeInAir(0, 40, 0, 0, 300);
    let swaps = 0;
    for (const from of ids) for (const to of ids) {
      if (from === to) continue;
      v.setType('jet', from); assert.equal(v.current.mode, 'air', `${from} in the air`);
      for (const y of [60, 2]) {
        v.current.pos.y = y; v.current.afterReset();
        const p = v.current.pos.clone();
        v.setType('jet', to);
        const c = v.current;
        assert(c === v.jet && c.type === to, `${from} → ${to}: flying the ${to} (${c.type})`);
        assert(c.mode === 'air' && Math.abs(c.pos.y - p.y) < 1e-9 && Math.hypot(c.pos.x - p.x, c.pos.z - p.z) < 1e-9,
          `${from} → ${to} at ${y} m: ${c.mode} at ${c.pos.y.toFixed(2)}`);
        assert([...c.pos, ...c.vel, ...c.quat].every(Number.isFinite), `${from} → ${to}: finite`);
        v.setType('jet', from); swaps += 2;
      }
    }
    v.setType('jet', 'fighter');
    return `${swaps} swaps between ${ids.join(', ')} at 60 m and 2 m`;
  });
  const { createCollisions } = await import('../game/src/mp/collide.js');
  check('multiplayer respawn protection covers both aircraft, whichever type is chosen', () => {
    const v = createVehicles({ scene: new THREE.Scene(), world: flat(), tuning: { ...TUNING_DEFAULTS } });
    const ls = new Map(), now = 10000;
    const mp = { inGame: true, now: () => now, me: { id: 'me' }, players: new Map(),
      on(t, f) { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t).add(f); }, off(t, f) { ls.get(t)?.delete(f); } };
    // the list main.js hands createCollisions (checked against main.js below)
    const col = createCollisions({ mp, player: () => v.current, vehicles: [v.car, v.bike, ...v.aircraft], predictedState: () => null });
    assert(v.aircraft.length === 2 && v.aircraft.some(a => a instanceof Jet) && v.aircraft.includes(v.heli), 'both aircraft listed');
    const protectedBy = (a, fn) => { a.ghostUntil = 0; fn(a); return a.ghostUntil > now; };
    v.switchTo('jet');
    const jet = v.current;
    assert(protectedBy(jet, a => a.resetToSafe()) && protectedBy(jet, a => a.placeInAir(0, 200, 0, 0, 500)), 'fighter: R / air respawn');
    v.setType('jet', 'heli');
    const h = v.current; assert(h instanceof Heli);
    assert(protectedBy(h, a => a.resetToSafe()), 'helicopter: R');
    assert(protectedBy(h, a => a.placeInAir(0, 200, 0, 0, 450)), 'helicopter: race air respawn');
    assert(protectedBy(h, a => a.flipUpright()), 'helicopter: F');
    assert(protectedBy(h, a => { a.crash('impact'); fly(a, input(), 5); }), 'helicopter: automatic respawn after a crash');
    // the swap itself places the new aircraft through reset / placeInAir: protected too
    h.ghostUntil = 0; jet.ghostUntil = 0; v.setType('jet', 'fighter'); assert(jet.ghostUntil > now, 'swap to the fighter');
    v.setType('jet', 'heli'); assert(h.ghostUntil > now, 'swap to the helicopter');
    col.dispose();
    assert(!protectedBy(h, a => a.resetToSafe()), 'unwrapped after dispose');
    const main = fs.readFileSync(new URL('../game/src/main.js', import.meta.url), 'utf8');
    assert(/createCollisions\(\{[^}]*vehicles: \[[^\]]*\.\.\.vehicles\.aircraft/.test(main), 'main.js registers vehicles.aircraft with createCollisions');
    return 'fighter + helicopter both wrapped: R, F, race respawn, crash respawn, type swaps';
  });
}
{
  // the rotor sound (audio/engines.js) on a stub audio context: chop rate and level follow rotor power; only the
  // helicopter builds it, and a vehicle switch stops it (tools/engine_sound_test.mjs checks every other engine)
  const { CarAudio } = await import('../game/src/audio.js');
  const param = () => ({ value: 0, last: 0, setTargetAtTime(v) { this.last = v; }, setValueAtTime() {}, cancelScheduledValues() {} });
  let sources = 0, stopped = 0;
  const node = extra => ({ connect: n => n, disconnect() {}, ...extra });
  const ctx = { currentTime: 0, sampleRate: 8000, destination: node(), resume() {},
    createGain: () => node({ gain: param() }), createBiquadFilter: () => node({ frequency: param(), Q: param(), gain: param() }),
    createWaveShaper: () => node({ curve: null }), createBuffer: (c, n) => ({ duration: 1, getChannelData: () => new Float32Array(n) }),
    createBufferSource: () => { sources++; return node({ playbackRate: param(), start() {}, stop() { stopped++; } }); },
    createOscillator: () => { sources++; return node({ frequency: param(), start() {}, stop() { stopped++; } }); },
    decodeAudioData: async () => ({ duration: 1 }) };
  globalThis.fetch = async () => ({ arrayBuffer: async () => new ArrayBuffer(4) });
  check('sound: the rotor chop speeds up and gets louder with power, winds down after a crash, off in the car', () => {
    const a = new CarAudio({ ctx }); a.start();
    const car = { kind: 'car', vel: new THREE.Vector3(), mesh: { userData: {} }, surface: 3, slip: 0, grounded: true, hit: 0, landing: 0 };
    const keys = input();
    a.update(car, keys, DT); assert(!a.engine.part.rotorGain, 'car: no rotor sound');
    a.update(new Jet(flat()), keys, DT); assert(!a.engine.part.rotorGain && a.engine.part.roar, 'jet: its turbine, no rotor');
    const h = new Heli(flat()); h.reset(0, 0, 0);
    const base = sources;
    a.update(h, keys, DT);
    const rotor = a.engine.part;
    assert(rotor.rotorGain && sources > base, `rotor sound built on first use (${sources - base} sources)`);
    const idle = [rotor.rotorLfo.frequency.last, rotor.rotorGain.gain.last];
    h.throttle = 1; h.mode = 'air'; a.update(h, keys, DT);
    const full = [rotor.rotorLfo.frequency.last, rotor.rotorGain.gain.last];
    assert(full[0] > idle[0] * 2 && full[1] > idle[1] * 3, `chop ${idle[0].toFixed(1)} → ${full[0].toFixed(1)} Hz, level ${idle[1].toFixed(2)} → ${full[1].toFixed(2)}`);
    assert(!rotor.roar && rotor.whine.gain.last > 0, 'no jet roar; a turbine whine under the rotor');
    h.mode = 'crashed'; h.throttle = 0.5; a.update(h, keys, DT); const winding = rotor.rotorGain.gain.last;
    h.throttle = 0; a.update(h, keys, DT);
    assert(winding > 0 && rotor.rotorGain.gain.last === 0 && rotor.whine.gain.last === 0, 'crashed: winds down to silence');
    const stoppedBefore = stopped;
    a.update(car, keys, DT);
    assert(a.engine.part !== rotor && stopped - stoppedBefore === rotor.sources.length, 'switched to the car: rotor sources stopped');
    a.update(h, keys, DT); assert(a.engine.part.rotorGain, 'back in the helicopter: rotor again');
    a.stop();
    return `chop ${idle[0].toFixed(1)} Hz at idle → ${full[0].toFixed(1)} Hz flying, level ${idle[1].toFixed(2)} → ${full[1].toFixed(2)}`;
  });
}
{
  // multiplayer: another player in the helicopter is drawn as one (their type in the skin), rotors spinning, wreck look
  const { animState } = await import('../game/src/mp/net.js');
  const { makeRemotes } = await import('../game/src/mp/remotes.js');
  check('multiplayer: a remote helicopter is the heli model, rotor spinning, wrecks like yours', () => {
    const ls = new Map(); let now = 50000;
    const mp = { me: { id: 'me', code: 'ABCDE', name: 'Me' }, inGame: true, isHost: false, players: new Map(), now: () => now,
      on(t, f) { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t).add(f); }, off(t, f) { ls.get(t)?.delete(f); }, emit(t, m) { for (const f of ls.get(t) || []) f(m); }, send() {} };
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.3, 2200), R = makeRemotes({ scene: new THREE.Scene(), camera, mp, world: { heightAt: () => 0 }, fx: false });
    mp.emit('roster', { t: 'roster', players: [{ id: 'g', name: 'Gus', skin: { vehicle: 'jet', type: 'heli', colors: {} } }] });
    const h = new Heli(flat()), inp = input(); h.reset(0, 0, 0); h.input = inp;
    let sendT = 0, spins = [];
    const frames = (n, ctl) => { for (let f = 0; f < n; f++) {
      fly(h, inp, 1 / 60, ctl); now += 1000 / 60; sendT += 1000 / 60;
      if (sendT >= 66) { sendT -= 66; mp.emit('state', { t: 'state', from: 'g', srvT: now, v: 'jet', p: h.pos.toArray(), q: h.quat.toArray(), vel: h.vel.toArray(), ts: now, ...animState(h) }); }
      camera.position.copy(h.pos).add(new THREE.Vector3(0, 3, -12)); camera.updateMatrixWorld(); R.update(1 / 60);
    } };
    frames(240, (t, J, k) => { J.thr = k.agl < 20 ? 1 : 0; J.pitch = k.agl > 10 ? -1 : 0; });
    const r = R.list()[0];
    assert.equal(r.kind, 'jet'); assert.equal(r.type, 'heli'); assert.equal(r.model, 'heli');
    const a = r.anim.rotor; frames(6, (t, J) => { J.pitch = -1; }); const b = R.list()[0].anim.rotor;
    const turn = ((b - a) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);   // over 0.1 s, wrapped
    assert(a !== null && turn > 0.5 && turn < 3, `remote rotor ${a} → ${b}`);
    h.crash('impact'); frames(30);
    const m = R.model('g');
    assert(m.scale.y < 0.8 && !m.userData.canopy.visible, 'remote wreck look');
    R.dispose();
    return `remote model "${r.model}", rotor turning ${(turn * 10).toFixed(1)} rad/s, wreck look on a crash`;
  });
}

// ------------------------------------------------------------------------------------------------- the real map
if (!process.argv.includes('--flat')) {
  const { makeWorld, makeTileData } = await import('../game/src/data.js');
  const { readTileData } = await import('../game/src/tilepack.js');
  const A = (process.env.YR_ASSETS || 'game/assets').replace(/\/?$/, '/');
  const WJ = JSON.parse(fs.readFileSync(A + 'world.json')), W = makeWorld(WJ), T = WJ.tile;
  const CH = JSON.parse(fs.readFileSync(A + 'challenges.json')).filter(c => c.vehicle === 'jet');
  const R0 = JSON.parse(fs.readFileSync(A + 'ramps.json'))[0], FIELD = [828, 480];
  const want = new Set(), have = new Set(WJ.tiles.map(t => t.join('_')));
  const around = (x, z, m = 1200) => { for (let tx = Math.floor((x - m + T / 2) / T); tx <= Math.floor((x + m + T / 2) / T); tx++) for (let tz = Math.floor((z - m + T / 2) / T); tz <= Math.floor((z + m + T / 2) / T); tz++) if (have.has(`${tx}_${tz}`)) want.add(`${tx}_${tz}`); };
  around(...FIELD); around(R0.x, R0.z, 2500);
  for (const c of CH) for (let i = 0; i < c.gates.length; i++) {
    const a = c.gates[i], b = c.gates[Math.min(i + 1, c.gates.length - 1)];
    for (let k = 0; k <= 10; k++) around(a.x + (b.x - a.x) * k / 10, a.z + (b.z - a.z) * k / 10, 1500);
  }
  const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  for (const id of want) { const [tx, tz] = id.split('_').map(Number); W.add(makeTileData(WJ, tx, tz, await readTileData(async f => ab(`${A}tiles/${id}/${f}`), WJ.packed))); }
  console.log(`(real map: ${want.size} tiles loaded)`);
  W.setFixedRamps?.([]);

  // take off, climb to 40 m, fly `dist` m along `yaw`, come back down on the spot below
  const hop = (x, z, yaw, dist) => {
    const h = new Heli(W), inp = input(); h.reset(x, z, yaw);
    const st = fly(h, inp, 60, (t, J, k) => {
      const gone = Math.hypot(k.pos.x - x, k.pos.z - z);
      J.pitch = 0; J.thr = 0;
      if (k.mode === 'ground' && t > 1 && gone > dist * 0.8) return;
      if (gone < dist && t < 40) { J.thr = k.agl < 40 ? 1 : 0; if (k.agl > 25) J.pitch = gone < dist - 120 ? -1 : 0; }
      else if (kmh(k) < 8) J.thr = -1;
    });
    return { h, st };
  };
  check('real map: take off from the farm field, fly 600 m, land on the field', () => {
    const { h, st } = hop(...FIELD, Math.PI / 2, 600);
    assert(!st.crashed && st.landed && h.mode === 'ground', `modes ${st.modes}`);
    return `modes ${st.modes.join(' → ')}, touchdown ${st.landed.sink.toFixed(2)} m/s on surface ${h.surface}`;
  });
  check('real map: take off from Hwy 18, fly along it, land on the road', () => {
    const hx = Math.sin(R0.yaw), hz = Math.cos(R0.yaw);
    const { h, st } = hop(R0.x - hx * 900, R0.z - hz * 900, R0.yaw, 700);
    assert(!st.crashed && st.landed && h.mode === 'ground', `modes ${st.modes}`);
    assert.equal(h.surface, 3, `landed on surface ${h.surface}`);
    return `modes ${st.modes.join(' → ')}, touchdown ${st.landed.sink.toFixed(2)} m/s on asphalt`;
  });
  // a race bot: lift off from the start, then fly at each ring's centre (approaching along its axis), at its height
  for (const c of CH) check(`real map: bot flies the ${c.name} jet race through every ring`, () => {
    const h = new Heli(W), inp = input(), G = c.gates;
    let next = 1, done = null, prev = null, rings = 0;
    h.reset(c.start.x, c.start.z, c.start.yaw);
    h.respawn = () => next >= 2 ? [G[next - 1].x, G[next - 1].y, G[next - 1].z, G[next - 1].yaw, 450] : null;
    const st = fly(h, inp, 900, (t, J, k) => {
      J.thr = J.pitch = J.roll = J.yaw = 0;
      if (done !== null || k.mode === 'crashed') return;
      const g = G[next], dist = Math.hypot(g.x - k.pos.x, g.z - k.pos.z), lead = dist > 180 ? Math.min(220, dist * 0.4) : 0;
      const ax = g.x - Math.sin(g.yaw) * lead, az = g.z - Math.cos(g.yaw) * lead;
      let d = Math.atan2(ax - k.pos.x, az - k.pos.z) - k.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      const floor = Math.max(W.heightAt(k.pos.x, k.pos.z), W.heightAt(k.pos.x + k.vel.x * 3, k.pos.z + k.vel.z * 3)) + 45;
      const wantY = dist > 250 ? Math.max(g.y, floor) : g.y;
      J.thr = Math.max(-1, Math.min(1, (wantY - k.pos.y) * 0.12));
      if (k.mode !== 'air' || k.agl < 15) return;
      J.yaw = Math.max(-1, Math.min(1, -d * 2)); J.roll = Math.abs(d) < 1 ? Math.max(-1, Math.min(1, -d * 2.5)) : 0;
      J.pitch = Math.abs(d) < 0.6 ? -1 : Math.abs(d) < 1.2 ? -0.4 : 0;
      const p = [k.pos.x, k.pos.y, k.pos.z];
      if (prev) {
        const fx = Math.sin(g.yaw), fz = Math.cos(g.yaw), d0 = (prev[0] - g.x) * fx + (prev[2] - g.z) * fz, d1 = (p[0] - g.x) * fx + (p[2] - g.z) * fz;
        if (d0 <= 0 && d1 > 0) {
          const u = -d0 / (d1 - d0), ix = prev[0] + (p[0] - prev[0]) * u, iy = prev[1] + (p[1] - prev[1]) * u, iz = prev[2] + (p[2] - prev[2]) * u;
          const lat = (ix - g.x) * Math.cos(g.yaw) - (iz - g.z) * Math.sin(g.yaw);
          if (Math.hypot(lat, iy - g.y) <= g.r + 1) { rings++; next++; if (next >= G.length) done = t; }
        }
      }
      prev = p;
    });
    assert(done !== null, `${rings}/${G.length - 1} rings, modes ${st.modes.slice(0, 6)}`);
    assert(!st.crashed, `crashed: ${JSON.stringify(st.crashed)}`);
    return `all ${rings} rings in ${(done / 60).toFixed(0)}:${String(Math.round(done % 60)).padStart(2, '0')}, top ${st.maxKmh.toFixed(0)} km/h, lowest ${st.minAgl.toFixed(0)} m`;
  });
}

const failed = results.filter(r => r[1] !== 'pass');
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ' · FAILED: ' + failed.map(f => f[0]).join('; ') : ''}`);
process.exit(failed.length ? 1 : 0);
