// Headless jet ski + speedboat drives (game/src/boat.js) on the committed tiles round Sheridan: the big pond south-east
// of town and the South Yamhill at Bridge Street. No rendering. Prints numbers, exits nonzero on a failed check.
//   node tools/boat_test.mjs            V=1 prints a line every 0.5 s of each run
// Checks per boat: floats and bobs at rest, accelerates to its top speed (jet ski ~100, speedboat ~120 km/h), gets on
// the plane (hull lifts, bow-up hump on the way), turns (jet ski: tighter and leans more), crosses its own wake, slows
// in shallow water, runs under the bridge, beaches on the bank (slides to a stop), pushes back in with S, R puts it
// back on the water, and reset() on land finds the nearest water. No NaN anywhere. Then: light anchors (lights.js
// format), leaving a boat for the car / bike / jet puts it on the nearest bank facing away from the water, a boat
// picked with no water loaded near goes to the nearest launch spot (held until its tiles load), switching straight
// back to a land vehicle before it gets there cancels that and puts it back where it was (waiting for that ground if
// it streamed out), and every launch spot is open water inside the map rim.
import fs from 'fs';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import * as THREE from 'three';
import { Boat, JETSKI, SPEEDBOAT, findWater, LAUNCH_SPOTS } from '../game/src/boat.js';
import { createVehicles } from '../game/src/vehicles.js';
import { TUNING_DEFAULTS } from '../game/src/car.js';

const A = (process.env.YR_ASSETS || 'game/assets').replace(/\/?$/, '/');
const WJ = JSON.parse(fs.readFileSync(A + 'world.json'));
const W = makeWorld(WJ);
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
for (const [tx, tz] of [[1, 1], [2, 1], [3, 1], [2, 0], [2, 2]]) {        // Sheridan and round it (memory: a few tiles only)
  if (!WJ.tiles.some(([a, b]) => a === tx && b === tz)) continue;
  const d = `${A}tiles/${tx}_${tz}/`;
  W.add(makeTileData(WJ, tx, tz, await readTileData(async f => ab(d + f), WJ.packed)));
}
const DT = 1 / 120, POND = [4640, 2290], RIVER = [3700, 1344], LAND = [3694, 1230];
const water = (x, z) => { const w = W.waterLevelAt(x, z); return w > W.terrainAt(x, z) ? w : -Infinity; };
const depth = (x, z) => water(x, z) - W.terrainAt(x, z);
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' — ' + detail : ''}`); if (!ok) failed++; };
const finite = b => [b.pos.x, b.pos.y, b.pos.z, b.vel.x, b.vel.y, b.vel.z, b.quat.x, b.quat.y, b.quat.z, b.quat.w].every(Number.isFinite);
const kmh = b => Math.hypot(b.vel.x, b.vel.z) * 3.6;

// drive `secs` (or until ctl returns true); per step ctl(t, input, boat). Returns stats.
function drive(b, secs, ctl, label = '') {
  const inp = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  const st = { nan: false, maxKmh: 0, t: 0, maxVy: 0, ys: [], maxLean: 0, maxPitch: 0, minYawRate: 0, maxYawRate: 0, maxAbove: -9, stopped: false };
  for (let i = 0; i < secs / DT; i++) {
    const t = i * DT; st.t = t;
    if (ctl(t, inp, b, st)) break;
    b.savePrev(); b.step(DT, inp);
    if (!finite(b)) { st.nan = true; console.log('  NaN at', t.toFixed(2), label); break; }
    st.maxKmh = Math.max(st.maxKmh, kmh(b)); st.maxVy = Math.max(st.maxVy, Math.abs(b.vel.y));
    st.maxLean = Math.max(st.maxLean, Math.abs(b.lean)); st.maxPitch = Math.max(st.maxPitch, b.pitch);
    const lv = water(b.pos.x, b.pos.z); if (lv > -Infinity) st.maxAbove = Math.max(st.maxAbove, b.pos.y - lv);
    if (process.env.V && i % 60 === 0) console.log(`    ${label} ${t.toFixed(1).padStart(5)}s ${kmh(b).toFixed(0).padStart(4)} km/h ${b.mode} sup${b.onWater ? 'W' : '-'}${b.grounded ? 'G' : 'a'} y-lvl ${(b.pos.y - lv).toFixed(2)} pitch ${(b.pitch * 57.3).toFixed(1)}° lean ${(b.lean * 57.3).toFixed(1)}° yawRate ${b.yawRate.toFixed(2)} shallow ${b.shallow.toFixed(2)} at ${b.pos.x.toFixed(0)},${b.pos.z.toFixed(0)}`);
  }
  return st;
}
// from a water spot, a heading that crosses 25–120 m of water and then climbs a low bank (not a cliff, not off the map)
function beachHeading(x, z, lv) {
  let best = null;
  for (let a = 0; a < Math.PI * 2; a += 0.05) {
    let r = 0; while (r < 200 && water(x + Math.sin(a) * r, z + Math.cos(a) * r) > -Infinity) r += 1;
    if (r < 25 || r > 120) continue;
    const bx = x + Math.sin(a) * (r + 12), bz = z + Math.cos(a) * (r + 12), rise = W.heightAt(bx, bz) - lv;
    let trees = 0; for (let k = 0; k <= 16; k += 4) W.treesNear(x + Math.sin(a) * (r + k), z + Math.cos(a) * (r + k), 4, () => trees++);
    const houses = W.buildingsNear(bx, bz, 30).some(h => h.pts.some(([px, pz]) => Math.hypot(px - bx, pz - bz) < 30));
    if (!W.loadedAt(bx, bz) || rise > 2.5 || trees || houses) continue;
    if (!best || r > best[1]) best = [a, r, rise];
  }
  return best;
}

for (const P of [JETSKI, SPEEDBOAT]) {
  console.log(`\n== ${P.name}`);
  const b = new Boat(W, P), out = {};

  // ---- at rest on the pond: floats on the water, bobs gently, stays put
  b.reset(...POND);
  const lv0 = water(b.pos.x, b.pos.z);
  check(lv0 > -Infinity && depth(b.pos.x, b.pos.z) >= P.minDepth, 'reset on the pond puts it on open water', `at ${b.pos.x.toFixed(0)},${b.pos.z.toFixed(0)} depth ${depth(b.pos.x, b.pos.z).toFixed(2)} m`);
  const x0 = b.pos.x, z0 = b.pos.z;
  const rest = drive(b, 6, (t, i, bb, s) => { if (t > 1) s.ys.push(bb.pos.y - lv0); }, 'rest');
  const mean = rest.ys.reduce((a, c) => a + c, 0) / rest.ys.length, sd = Math.sqrt(rest.ys.reduce((a, c) => a + (c - mean) ** 2, 0) / rest.ys.length);
  check(Math.abs(mean) < 0.12 && sd > 0.003 && sd < 0.1, 'floats on the waterline and bobs gently', `mean ${mean.toFixed(3)} m, bob sd ${(sd * 100).toFixed(1)} cm`);
  check(Math.hypot(b.pos.x - x0, b.pos.z - z0) < 1 && b.onWater, 'stays put at rest', `${Math.hypot(b.pos.x - x0, b.pos.z - z0).toFixed(2)} m`);

  // ---- full throttle across the pond: top speed, on the plane, hump
  b.reset(...POND);
  let t80 = null, rise = 0, hump = 0;
  const acc = drive(b, 14, (t, i, bb) => {
    i.throttle = 1;
    if (t80 === null && kmh(bb) >= 80) t80 = t;
    if (kmh(bb) < P.planeKmh) hump = Math.max(hump, bb.pitch);
    if (t > 8 && water(bb.pos.x, bb.pos.z) > -Infinity) rise = Math.max(rise, bb.pos.y - water(bb.pos.x, bb.pos.z));
    return bb.mode !== 'water';
  }, 'accel');
  out.top = acc.maxKmh;
  check(!acc.nan, 'no NaN accelerating');
  check(Math.abs(acc.maxKmh - P.topSpeed) < P.topSpeed * 0.06, `top speed ~${P.topSpeed} km/h`, `${acc.maxKmh.toFixed(1)} km/h, 0–80 in ${t80?.toFixed(1)} s`);
  check(hump > 0.04 && rise > P.rise * 0.6, 'bow comes up getting on the plane, hull lifts at speed', `hump ${(hump * 57.3).toFixed(1)}°, rise ${rise.toFixed(2)} m`);

  // ---- full right lock at speed: turn radius, lean / bank, keeps some speed
  b.reset(...POND);
  let radius = [], spd = [];
  const turn = drive(b, 12, (t, i, bb) => {
    i.throttle = 1; i.steer = t > 3 ? 1 : 0;
    if (t > 5) { radius.push(Math.hypot(bb.vel.x, bb.vel.z) / Math.max(1e-3, Math.abs(bb.yawRate))); spd.push(kmh(bb)); }
    return bb.mode !== 'water';
  }, 'turn');
  const R = radius.reduce((a, c) => a + c, 0) / Math.max(1, radius.length), V = spd.reduce((a, c) => a + c, 0) / Math.max(1, spd.length);
  out.radius = R; out.lean = turn.maxLean;
  check(!turn.nan && radius.length > 240, 'turns on the pond without NaN (2 s+ of steady turn measured)', `${(radius.length * DT).toFixed(1)} s measured`);
  check(b.yawRate < 0, 'D (steer right) turns right (yaw rate < 0)', `yaw rate ${b.yawRate.toFixed(2)} rad/s`);
  console.log(`     radius ${R.toFixed(1)} m at ${V.toFixed(0)} km/h, max lean ${(turn.maxLean * 57.3).toFixed(1)}°`);

  // ---- tight circles at medium speed: crosses its own wake (bumps), stays finite
  b.reset(...POND);
  const circ = drive(b, 14, (t, i, bb) => { i.throttle = kmh(bb) < 45 ? 1 : 0.3; i.steer = t > 2 ? -1 : 0; return bb.mode !== 'water'; }, 'circle');
  b.reset(...POND);
  const straight = drive(b, 6, (t, i, bb) => { i.throttle = kmh(bb) < 45 ? 1 : 0.3; return bb.mode !== 'water'; }, 'straight');
  check(!circ.nan && circ.maxVy > straight.maxVy * 1.2, 'crossing its own wake bumps the hull', `max |vy| circling ${circ.maxVy.toFixed(2)} vs straight ${straight.maxVy.toFixed(2)} m/s`);

  // ---- shallow water: hold it over a shallow spot (treadmill) and compare with deep water
  let shallowAt = null;
  for (let r = 0; r < 300 && !shallowAt; r += 2) for (let a = 0; a < 6.28 && !shallowAt; a += 0.1) {
    const x = RIVER[0] + Math.sin(a) * r, z = RIVER[1] + Math.cos(a) * r, d = depth(x, z);
    if (d > 0.12 && d < P.minDepth * 0.55) shallowAt = [x, z, d];
  }
  const tread = (x, z) => {
    b.reset(...RIVER, -Math.PI / 2);
    return drive(b, 8, (t, i, bb) => { i.throttle = 1; bb.pos.x = x; bb.pos.z = z; bb._lastLoaded = null; }, 'tread').maxKmh;
  };
  if (shallowAt) {
    const deepKmh = tread(b.pos.x, b.pos.z), shallowKmh = tread(shallowAt[0], shallowAt[1]);
    check(shallowKmh < deepKmh * 0.6, 'shallow water slows it', `${shallowKmh.toFixed(0)} km/h over ${shallowAt[2].toFixed(2)} m of water vs ${deepKmh.toFixed(0)} km/h in deep`);
  } else check(false, 'found a shallow spot near the river');

  // ---- along the South Yamhill under the Bridge Street deck (x ≈ 3590): stays on the water
  b.reset(...RIVER, -Math.PI / 2);
  check(Math.hypot(b.pos.x - RIVER[0], b.pos.z - RIVER[1]) < 30, 'reset on the South Yamhill keeps it there', `at ${b.pos.x.toFixed(0)},${b.pos.z.toFixed(0)}`);
  b.reset(RIVER[0], RIVER[1], -Math.PI / 2);
  b.yaw = -Math.PI / 2; b.pos.set(RIVER[0], water(...RIVER), RIVER[1]); b.setQuat(); b.afterReset();
  const br = drive(b, 7, (t, i, bb) => { i.throttle = 1; return bb.pos.x < 3540 || bb.mode !== 'water'; }, 'bridge');
  check(!br.nan && b.pos.x < 3580 && br.maxAbove < 0.8, 'runs under the Bridge Street deck on the water', `reached x ${b.pos.x.toFixed(0)}, max ${br.maxAbove.toFixed(2)} m above the water, ${br.maxKmh.toFixed(0)} km/h`);

  // ---- beach it on the river bank, slide to a stop, push back in with S, R back to the water
  b.reset(...RIVER, 0);
  const lvR = water(b.pos.x, b.pos.z), bh = beachHeading(b.pos.x, b.pos.z, lvR);
  if (!bh) { check(false, 'found a low bank to beach on'); continue; }
  b.yaw = bh[0]; b.setQuat(); b.afterReset();
  let beachKmh = null, beachAt = null;
  const bch = drive(b, 20, (t, i, bb) => {
    if (beachKmh === null && bb.mode === 'land') { beachKmh = kmh(bb); beachAt = [bb.pos.x, bb.pos.z, t]; }
    i.throttle = beachKmh === null ? 1 : 0;
    return beachKmh !== null && kmh(bb) < 0.2 && t - beachAt[2] > 0.5;
  }, 'beach');
  const slid = beachAt ? Math.hypot(b.pos.x - beachAt[0], b.pos.z - beachAt[1]) : 0;
  check(!bch.nan && beachKmh !== null, 'drives up the bank and beaches', `${bh[1]} m run, bank ${bh[2].toFixed(1)} m up, beached at ${beachKmh?.toFixed(0)} km/h`);
  check(beachAt && kmh(b) < 0.2 && b.mode === 'land' && b.grounded, 'slides to a stop on land', `slid ${slid.toFixed(1)} m in ${beachAt ? (bch.t - beachAt[2]).toFixed(1) : '-'} s, ${b.hudInfo()}`);
  const settled = drive(b, 2, () => false, 'parked');
  check(kmh(b) < 0.5 && !settled.nan, 'stays beached with no input', `${kmh(b).toFixed(2)} km/h`);
  const back = drive(b, 25, (t, i, bb) => { i.brake = 1; return bb.onWater && bb.mode === 'water'; }, 'reverse');
  check(!back.nan && b.onWater, 'S pushes it back into the water', `after ${back.t.toFixed(1)} s`);
  // back out a bit more, swing round, go
  let waterKmh = 0;
  const away = drive(b, 12, (t, i, bb) => {
    const out = t < 3; i.brake = out ? 1 : 0; i.throttle = out ? 0 : 1; i.steer = out ? 0 : t < 5 ? 1 : 0;
    if (bb.onWater && bb.mode === 'water') waterKmh = Math.max(waterKmh, kmh(bb));
    return t > 4 && bb.mode === 'land';                         // the river is narrow: stop when it reaches a bank again
  }, 'relaunch');
  check(!away.nan && waterKmh > 25, 'backs out, swings round and drives off again on the water', `${waterKmh.toFixed(0)} km/h on the water`);
  // beach it again, then R
  b.reset(...RIVER, 0); b.yaw = bh[0]; b.setQuat(); b.afterReset();
  drive(b, 20, (t, i, bb) => { i.throttle = 1; return bb.mode === 'land' && kmh(bb) < 3; }, 'beach2');
  b.waterSafe.push([RIVER[0], RIVER[1], 0]);
  b.resetToSafe(); drive(b, 1, () => false);
  check(b.onWater && depth(b.pos.x, b.pos.z) >= P.minDepth, 'R puts it back on the water', `at ${b.pos.x.toFixed(0)},${b.pos.z.toFixed(0)}`);

  // ---- picking it on land: starts on the nearest water that is big enough
  b.reset(...LAND, 0);
  const dLand = Math.hypot(b.pos.x - LAND[0], b.pos.z - LAND[1]);
  drive(b, 1, () => false);
  check(b.onWater && depth(b.pos.x, b.pos.z) >= P.minDepth && dLand < 200, 'reset on land starts it on the nearest open water', `${dLand.toFixed(0)} m away, depth ${depth(b.pos.x, b.pos.z).toFixed(2)} m`);
  const t0 = performance.now(); const none = findWater(W, -9000, -9000, { radius: 1400 });
  check(none === null, 'no water loaded nearby: findWater gives up cleanly', `${(performance.now() - t0).toFixed(0)} ms`);
  P._out = out;
}
const [J, S] = [JETSKI._out, SPEEDBOAT._out];
if (J && S) {
  console.log('\n== jet ski vs speedboat');
  check(J.radius < S.radius * 0.75, 'jet ski turns much tighter than the speedboat', `radius ${J.radius.toFixed(0)} vs ${S.radius.toFixed(0)} m`);
  check(J.lean > S.lean * 2, 'jet ski leans into turns, speedboat banks a little', `${(J.lean * 57.3).toFixed(0)}° vs ${(S.lean * 57.3).toFixed(0)}°`);
  check(S.top > J.top, 'speedboat is faster flat out', `${S.top.toFixed(0)} vs ${J.top.toFixed(0)} km/h`);
}

// ---- light anchors in lights.js's format (nav left = port = +x, right = starboard, tail)
console.log('\n== light anchors');
for (const P of [JETSKI, SPEEDBOAT]) {
  const L = new Boat(W, P).mesh.userData.lights, arr = a => Array.isArray(a) && a.length && a.every(v => v.isVector3);
  check(arr(L.head) && arr(L.tail) && L.nav?.left?.isVector3 && L.nav?.right?.isVector3 && L.nav?.tail?.isVector3 && L.nav.left.x > 0 && L.nav.right.x < 0,
    `${P.name}: head / tail / nav {left, right, tail} anchors`, `${L.head.length} head, ${L.tail.length} tail`);
}

// ---- leaving a boat for a land vehicle: nearest bank, facing away from the water, stays dry
console.log('\n== boat → land vehicle');
const veh = createVehicles({ scene: new THREE.Scene(), world: W, tuning: { ...TUNING_DEFAULTS } });
const dryAround = (x, z, r) => [...Array(8)].every((_, a) => water(x + Math.sin(a * Math.PI / 4) * r, z + Math.cos(a * Math.PI / 4) * r) === -Infinity);
for (const boatKind of ['jetski', 'boat']) for (const landKind of ['car', 'bike', 'jet']) {
  const from = landKind === 'bike' ? POND : RIVER;
  veh.car.reset(...LAND, 0); veh.switchTo('car');
  veh.switchTo(boatKind); const b = veh.current; b.reset(...from); drive(b, 1, () => false);
  const bx = b.pos.x, bz = b.pos.z;
  // A saved return point can itself be wet (e.g. a car was moved to the river before picking a boat).
  // Being at that point must not bypass the nearest-bank search.
  b.cameFrom = [bx, bz, b.heading(), b.pos.y];
  veh.switchTo(landKind); const v = veh.current;
  const d = Math.hypot(v.pos.x - bx, v.pos.z - bz), h = v.heading(), ax = v.pos.x + Math.sin(h) * 8, az = v.pos.z + Math.cos(h) * 8;
  const away = Math.hypot(ax - bx, az - bz) > d, sx = v.pos.x, sz = v.pos.z;
  check(water(v.pos.x, v.pos.z) === -Infinity && dryAround(v.pos.x, v.pos.z, 3.5) && d < 80 && away,
    `${boatKind} → ${landKind}: on the nearest bank, facing away from the water`, `${d.toFixed(0)} m from the boat, 8 m ahead is ${Math.hypot(ax - bx, az - bz).toFixed(0)} m from it`);
  let ok = true; const inp = { throttle: 0, brake: 0, steer: 0, handbrake: false, lean: false, jet: { thr: 0, pitch: 0, roll: 0, yaw: 0 } };
  for (let i = 0; i < 240; i++) { v.savePrev(); v.step(DT, inp); ok &&= [v.pos.x, v.pos.y, v.pos.z].every(Number.isFinite); }
  check(ok && !v.onWater && !(v.waterDepth > 0) && water(v.pos.x, v.pos.z) === -Infinity, `${landKind} sits on dry ground for 2 s`, `moved ${Math.hypot(v.pos.x - sx, v.pos.z - sz).toFixed(2)} m`);
}

// The same wet return point after its tile has streamed out: hold first, then search for a dry bank once loaded.
{
  const w = makeWorld(WJ), tile = [...W.tiles.values()].find(t => t.tx === 2 && t.tz === 1);
  w.add(tile);
  const v = createVehicles({ scene: new THREE.Scene(), world: w, tuning: { ...TUNING_DEFAULTS } });
  for (const boatKind of ['jetski', 'boat']) for (const landKind of ['car', 'bike', 'jet']) {
    v.switchTo('car'); v.car.reset(...RIVER, 0); v.switchTo(boatKind);
    const b = v.current;
    b.cameFrom = [b.pos.x, b.pos.z, b.heading(), b.pos.y];
    w.remove(tile.tx, tile.tz);
    v.switchTo(landKind);
    check(v.current === b && b.launching?.away, `${boatKind} → ${landKind}: unloaded return point is held while streaming`);
    w.add(tile); await b.launchDone;
    const c = v.current, wl = w.waterLevelAt(c.pos.x, c.pos.z);
    check(c.kind === landKind && !(wl > w.terrainAt(c.pos.x, c.pos.z)) &&
      c._lastLoaded[0] === c.pos.x && c.safe[0][0] === c.pos.x,
      `${boatKind} → ${landKind}: wet return point becomes a dry bank after streaming`);
  }
}

// ---- no water loaded near: off to the nearest launch spot, held there until it's loaded, then on the water
console.log('\n== launch spots');
const tileWorld = async (tx, tz) => {
  const w = makeWorld(WJ), d = `${A}tiles/${tx}_${tz}/`;
  w.add(makeTileData(WJ, tx, tz, await readTileData(async f => ab(d + f), WJ.packed))); return w;
};
{
  const patience = Boat.holdPatience; Boat.holdPatience = 200;   // shorten the 30 s wait for the test
  const W2 = makeWorld(WJ), b = new Boat(W2, JETSKI);            // nothing streamed in yet
  let busy = 1; W2.pendingTiles = () => busy;                    // and the game's streamer never reports idle
  b.reset(3694, -1500, 0);
  const L = b.launching;
  check(L && L.x === LAUNCH_SPOTS[0].x && L.z === LAUNCH_SPOTS[0].z && b.pos.x === L.x && b.pos.z === L.z, 'no water loaded near: holds it at the nearest launch spot', `"${b.msg}"`);
  const y0 = b.pos.y; b.step(DT, { throttle: 1, brake: 0, steer: 1 });
  check(b.pos.x === L.x && b.pos.y === y0 && b.vel.length() === 0, 'held still while it loads');
  let settled = false; b.launchDone.then(() => { settled = true; });
  await new Promise(r => setTimeout(r, 700));                     // past the (shortened) deadline, destination still missing
  b.step(DT, { throttle: 1, brake: 0, steer: 1 });
  check(!settled && b.launching === L && b.pos.x === L.x && b.pos.y === y0 && b.vel.length() === 0 && b.msg.startsWith('Still loading'),
    'past the deadline with the spot still unloaded: keeps holding, never released onto missing ground', `"${b.msg}"`);
  W2.add((await tileWorld(2, 1)).tiles.values().next().value);  // the tile streams in (other tiles still "pending")
  await b.launchDone;
  Boat.holdPatience = patience; busy = 0;
  const lv = W2.waterLevelAt(b.pos.x, b.pos.z);
  drive(b, 1, () => false);
  check(!b.launching && b.onWater && Math.hypot(b.pos.x - L.x, b.pos.z - L.z) < 60, 'then on the water there', `at ${b.pos.x.toFixed(0)},${b.pos.z.toFixed(0)}, level ${lv.toFixed(1)}`);
}
// ---- picking a boat with no water loaded near, then straight back to a land vehicle before the launch spot loads:
// the launch is cancelled and the land vehicle goes back where it was (dry); if that ground streamed out meanwhile,
// the switch waits (boat hidden and held there) until it's loaded again
{
  console.log('\n== boat picked far from water, then back to land at once');
  const W3 = await tileWorld(2, 0), tile = W3.tiles.values().next().value;   // dry hills; nearest launch spot is unloaded
  const v3 = createVehicles({ scene: new THREE.Scene(), world: W3, tuning: { ...TUNING_DEFAULTS } });
  const [sx, sz, syaw] = W3.placeOn(4000, 0, 3, 400);
  const dryHere = (w, c) => !(w.waterLevelAt(c.pos.x, c.pos.z) > w.terrainAt(c.pos.x, c.pos.z));
  const sitStill = (v) => { const y0 = v.pos.y, x0 = v.pos.x, z0 = v.pos.z; let ok = true;
    const inp = { throttle: 0, brake: 0, steer: 0, handbrake: false, lean: false, jet: { thr: 0, pitch: 0, roll: 0, yaw: 0 } };
    for (let i = 0; i < 240; i++) { v.savePrev(); v.step(DT, inp); ok &&= [v.pos.x, v.pos.y, v.pos.z].every(Number.isFinite); }
    return { ok, moved: Math.hypot(v.pos.x - x0, v.pos.z - z0), dy: v.pos.y - y0, above: v.pos.y - W3.heightAt(v.pos.x, v.pos.z) }; };
  v3.car.reset(sx, sz, syaw); v3.car.safe = [];
  const precondition = findWater(W3, sx, sz, { minDepth: JETSKI.minDepth, clear: JETSKI.beam * 2.6 }) === null;
  for (const landKind of ['car', 'bike', 'jet']) {
    v3.switchTo('car'); v3.car.reset(sx, sz, syaw);
    v3.switchTo('jetski'); const ski = v3.current, L = ski.launching;
    check(precondition && L && !W3.loadedAt(L.x, L.z), `jet ski picked at ${sx.toFixed(0)},${sz.toFixed(0)} heads for an unloaded launch spot`, L ? `${L.x},${L.z}` : 'no launch');
    v3.switchTo(landKind); const v = v3.current;
    const st = sitStill(v);
    check(v.kind === landKind && !ski.launching && Math.hypot(v.pos.x - sx, v.pos.z - sz) < 3 && dryHere(W3, v) && st.ok && st.above > -0.5,
      `…straight back to the ${landKind}: launch cancelled, back where it was, on dry ground`, `${Math.hypot(v.pos.x - sx, v.pos.z - sz).toFixed(1)} m from the start, ${st.above.toFixed(2)} m above the ground after 2 s`);
    await ski.launchDone;                                         // the cancelled launch must not move anything later
    check(v3.current === v && Math.hypot(v.pos.x - sx, v.pos.z - sz) < 3, `…the cancelled launch doesn't come back`);
  }
  // the start's ground streams out while the boat is away: the switch back waits for it
  v3.switchTo('car'); v3.car.reset(sx, sz, syaw);
  v3.switchTo('boat'); const boat = v3.current;
  W3.remove(tile.tx, tile.tz);
  v3.switchTo('car');
  check(v3.current === boat && boat.launching?.away && boat.pos.x === sx && boat.pos.z === sz && (boat.syncMesh(0), !boat.mesh.visible),
    'start ground unloaded: the switch waits, boat held (hidden) at the start', `${v3.current.kind}, held at ${boat.pos.x.toFixed(0)},${boat.pos.z.toFixed(0)}`);
  boat.step(DT, { throttle: 1, brake: 0, steer: 1 });
  check(boat.pos.x === sx && boat.vel.length() === 0, '…and held still meanwhile');
  W3.add(tile);
  await boat.launchDone;
  const c = v3.current, st = sitStill(c);
  check(c.kind === 'car' && Math.hypot(c.pos.x - sx, c.pos.z - sz) < 3 && Math.abs(c.heading() - syaw) < 0.3 && st.ok && st.above > -0.5 && dryHere(W3, c),
    '…then the car is placed there once loaded, facing the way it was', `${c.kind} ${Math.hypot(c.pos.x - sx, c.pos.z - sz).toFixed(1)} m from the start, ${st.above.toFixed(2)} m above the ground`);
}
for (const L of LAUNCH_SPOTS) {
  const [tx, tz] = W.tileIndex(L.x, L.z), Wt = await tileWorld(tx, tz);
  const s = findWater(Wt, L.x, L.z, { minDepth: SPEEDBOAT.minDepth, clear: SPEEDBOAT.beam * 2.6, radius: 60 });
  const inRim = Math.hypot(L.x - WJ.rim.cx, L.z - WJ.rim.cz) < WJ.rim.r - 300, lv = Wt.waterLevelAt(L.x, L.z);
  check(!!s && Math.hypot(s[0] - L.x, s[1] - L.z) < 40 && inRim && Math.abs(lv - L.y) < 1.5,
    `launch spot ${L.x},${L.z} (tile ${tx}_${tz}): open water for the speedboat, inside the rim`, s ? `water level ${lv.toFixed(1)} (list ${L.y})` : 'no water');
}
console.log(failed ? `\nFAIL boat_test: ${failed} check(s) failed` : '\nPASS boat_test');
process.exit(failed ? 1 : 0);
