// Car bodies must never be drawn under the road. Real car/bike physics + every type's real model, no renderer: each
// physics step is drawn (interpolate + syncMesh) and the lowest drawn body point (every vertex, plus points across every
// face, both LOD levels, rider included; tyres/rims are not body) is compared with heightAt under it.
// Places: flat asphalt (steady, slalom, full braking, standing start), the crests and dips of Hwy 18 between Sheridan and
// Bellevue, and the Hwy 18 jump ramp (assets/ramps.json), at 100 / 300 / 600 / 1000 km/h. The car is held on the road's
// centre line at the test speed ("rail": heading + horizontal speed set each step); everything vertical (springs,
// downforce, pitch, roll, launches, landings) is the real physics. Also prints the physics chassis (the car's ground
// box, the bike's body floor) so physics and drawing can be told apart.
//   node tools/body_clip_test.mjs            all types, asserts (run through the heavy gate: several minutes)
//   node tools/body_clip_test.mjs suv flat   only these types / places (race sports hatch suv truck dirt sport; flat hwy ramp jitter)
//   node tools/body_clip_test.mjs flat jitter --quick   all types, 100/300 km/h + standing start, 60 Hz lift jitter
//   REPORT=1 ...                             print the table without failing
import fs from 'fs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { Bike, BIKE } from '../game/src/bike.js';
import { VEHICLE_TYPES, applyVehicleType } from '../game/src/vehicletypes.js';
import { buildCarModel } from '../game/src/carmodel.js';
import { keepBodyAboveGround } from '../game/src/bodyclearance.js';

const DT = 1 / 120, SPEEDS = [100, 300, 600, 1000];
// --quick limits speed coverage; jitter checks 60 Hz drawing on real campus/town asphalt and open fields.
const args = process.argv.slice(2).filter(a => a !== '--quick'), PLACES = ['flat', 'hwy', 'ramp', 'jitter'];
if (process.argv.includes('--quick')) SPEEDS.splice(2);
const onlyPlaces = args.filter(a => PLACES.includes(a)), onlyTypes = args.filter(a => !PLACES.includes(a));
const place = p => !onlyPlaces.length || onlyPlaces.includes(p);
const A = (process.env.YR_ASSETS || 'game/assets').replace(/\/?$/, '/');

// ---------------------------------------------------------------- world: only the tiles along Hwy 18 and the ramp
const WJ = JSON.parse(fs.readFileSync(A + 'world.json'));
const RAMP0 = JSON.parse(fs.readFileSync(A + 'ramps.json'))[0];
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const readTile = async (tx, tz) => readTileData(async f => ab(`${A}tiles/${tx}_${tz}/${f}`), WJ.packed);
const T = WJ.tile, tileOf = v => Math.floor((v + T / 2) / T), have = new Set(WJ.tiles.map(([x, z]) => `${x},${z}`));
const W = makeWorld(WJ), loaded = new Set();
async function load(points, pad) {
  for (const [x, z] of points) for (const dx of [-pad, 0, pad]) for (const dz of [-pad, 0, pad]) {
    const tx = tileOf(x + dx), tz = tileOf(z + dz), k = `${tx},${tz}`;
    if (loaded.has(k) || !have.has(k)) continue;
    loaded.add(k); W.add(makeTileData(WJ, tx, tz, await readTile(tx, tz)));
  }
}
// Hwy 18 Sheridan → Bellevue: the 17 m asphalt strips east of Sheridan (x 4650…10500), in order along the road
let ROUTE = [];
if (place('hwy')) {
  const pts = [];
  for (const [tx, tz] of [[2, 1], [3, 1], [4, 1], [4, 0], [5, 0], [5, -1]]) {
    for (const p of (await readTile(tx, tz)).tile.physPaths) if (p.kind === 'asphalt' && p.w === 17)
      for (const [x, z] of p.pts) if (x > 4650 && x < 10500) pts.push([x, z]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  for (const p of pts) if (!ROUTE.length || Math.hypot(p[0] - ROUTE.at(-1)[0], p[1] - ROUTE.at(-1)[1]) > 2) ROUTE.push(p);
  await load(ROUTE, 300);
}
const rampLine = [], RF = [Math.sin(RAMP0.yaw), Math.cos(RAMP0.yaw)];
for (let s = -700; s <= 2600; s += 100) rampLine.push([RAMP0.x + RF[0] * s, RAMP0.z + RF[1] * s]);
if (place('ramp')) await load(rampLine, 300);

// Real routes for lift jitter: choose the nearby asphalt strip with enough run-up and coverage.
const JITTER = [];
if (place('jitter')) {
  for (const [name, x, z] of [['campus', WJ.spawn[0], WJ.spawn[1]], ['town', 19451, -11032]]) {
    const td = await readTile(tileOf(x), tileOf(z));
    const paths = td.tile.physPaths.filter(p => p.kind === 'asphalt' && p.pts.length > 1)
      .map(p => ({ pts: p.pts, length: p.pts.slice(1).reduce((n, v, i) => n + Math.hypot(v[0] - p.pts[i][0], v[1] - p.pts[i][1]), 0),
        dist: Math.min(...p.pts.map(p => Math.hypot(p[0] - x, p[1] - z))) }))
      .filter(p => p.length > 350).sort((a, b) => a.dist - b.dist);
    if (!paths.length) throw new Error(`No jitter route for ${name}`);
    JITTER.push([name, paths[0].pts]);
  }
  JITTER.push(['off-road', [[828, 480], [1228, 480]]]);
  for (const [, points] of JITTER) await load(points, 300);
}

// a polyline as a rail: arc-length table, position and heading at a distance along it
function rail(points) {
  const s = [0];
  for (let i = 1; i < points.length; i++) s.push(s[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const at = d => {
    d = Math.max(0, Math.min(s.at(-1), d));
    let lo = 0, hi = s.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= d) lo = m; else hi = m; }
    const u = (d - s[lo]) / ((s[hi] - s[lo]) || 1), [x0, z0] = points[lo], [x1, z1] = points[hi];
    return [x0 + (x1 - x0) * u, z0 + (z1 - z0) * u];
  };
  // heading from a chord ±12 m: smooth enough not to jerk the car at 1000 km/h
  const yaw = d => { const [a, b] = at(d - 12), [c, e] = at(d + 12); return Math.atan2(c - a, e - b); };
  return { length: s.at(-1), at, yaw };
}
// the road's sharpest crests and dips (height change across ±25 m), at least 400 m apart
function features(R, n) {
  const prof = []; for (let d = 30; d < R.length - 30; d += 5) { const h = p => W.heightAt(...R.at(p)); prof.push([d, h(d - 25) + h(d + 25) - 2 * h(d)]); }
  const pick = sign => {
    const out = [];
    for (const [d, c] of [...prof].sort((a, b) => sign * (b[1] - a[1]))) if (out.every(o => Math.abs(o[0] - d) > 400) && out.length < n) out.push([d, c]);
    return out;
  };
  return { crests: pick(-1), dips: pick(1) };
}

// ---------------------------------------------------------------- the drawn body as points (model frame of each mesh)
const _p = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3();
function bodyPoints(model) {
  const ud = model.userData, skip = new Set((ud.wheels || []).map(w => w.holder)), parts = [];
  model.traverse(o => {
    if (!o.isMesh) return;
    for (let q = o; q && q !== model; q = q.parent) if (skip.has(q) || q.name === 'glider' || q.userData.glider) return;
    const pos = o.geometry.attributes.position, idx = o.geometry.index, pts = [], seen = new Set();
    for (let i = 0; i < pos.count; i++) {
      const k = `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`;
      if (!seen.has(k)) { seen.add(k); pts.push(pos.getX(i), pos.getY(i), pos.getZ(i)); }
    }
    // points across each face (≤ 0.3 m apart): a face can cross a crest between its corners
    for (let j = 0; j < (idx ? idx.count : pos.count); j += 3) {
      const g = k => idx ? idx.getX(j + k) : j + k;
      _a.fromBufferAttribute(pos, g(0)); _b.fromBufferAttribute(pos, g(1)); _c.fromBufferAttribute(pos, g(2));
      const L = Math.max(_a.distanceTo(_b), _b.distanceTo(_c), _c.distanceTo(_a)), m = Math.ceil(L / 0.3);
      if (m < 2) continue;
      for (let u = 0; u <= m; u++) for (let v = 0; u + v <= m; v++) {
        if ((u === 0 && v === 0) || (u === m) || (v === m)) continue;
        const w = m - u - v;
        pts.push((_a.x * u + _b.x * v + _c.x * w) / m, (_a.y * u + _b.y * v + _c.y * w) / m, (_a.z * u + _b.z * v + _c.z * w) / m);
      }
    }
    const path = []; for (let q = o; q && q !== model; q = q.parent) if (q.name) path.unshift(q.name);
    parts.push({ o, pts: new Float32Array(pts), name: path.join('/') || o.type });
  });
  return parts;
}
const cache = new WeakMap();
let W3 = new Float32Array(0), PL = new Float32Array(0);
// lowest drawn body point above the ground (m; negative = under the road), and where. Every point is placed; the exact
// ground is looked up for those within CULL of the lowest over the ground's tangent plane at the car (the road can't
// rise that far above the plane under a car: ramps rise 0.2 m per m)
const CULL = 1.5;
function bodyClearance(v) {
  const model = v.mesh;
  if (!cache.has(model)) { const parts = bodyPoints(model); parts.n = parts.reduce((n, p) => n + p.pts.length, 0); cache.set(model, parts); }
  const parts = cache.get(model);
  if (W3.length < parts.n) { W3 = new Float32Array(parts.n); PL = new Float32Array(parts.n / 3); }
  model.updateMatrixWorld(true);
  const cx = v.renderPos.x, cz = v.renderPos.z, ref = v.renderPos.y + 1;
  const h0 = v.world.heightAt(cx, cz, ref); v.world.normalAt(cx, cz, _n, ref);
  let low = Infinity, k = 0;
  for (const { o, pts } of parts) {
    const e = o.matrixWorld.elements;
    for (let i = 0; i < pts.length; i += 3, k += 3) {
      const x = pts[i], y = pts[i + 1], z = pts[i + 2];
      const wx = W3[k] = e[0] * x + e[4] * y + e[8] * z + e[12], wy = W3[k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      const wz = W3[k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      low = Math.min(low, PL[k / 3] = wy - (h0 - (_n.x * (wx - cx) + _n.z * (wz - cz)) / _n.y));
    }
  }
  let best = Infinity, where = '';
  k = 0;
  for (const { pts, name } of parts) for (let i = 0; i < pts.length; i += 3, k += 3) {
    if (PL[k / 3] > low + CULL) continue;
    const c = W3[k + 1] - v.world.heightAt(W3[k], W3[k + 2], ref);
    if (c < best) { best = c; where = `${name} (${pts[i].toFixed(2)},${pts[i + 1].toFixed(2)},${pts[i + 2].toFixed(2)})`; }
  }
  return [best, where];
}
// the physics' own body: the car's ground box (car.js collideGround), the bike's body floor (pos.y − 0.25)
const BOX = [];
for (const sx of [-1, 1]) for (const sz of [-1, 1]) BOX.push([sx * 0.8, -0.1, -0.1 + sz * 1.85]);
function chassisClearance(v) {
  if (v.kind === 'bike') return v.pos.y - 0.25 - v.world.heightAt(v.pos.x, v.pos.z, v.pos.y);
  const w = v.typePhysics?.width ?? 1, l = v.typePhysics?.length ?? 1;
  let best = Infinity;
  for (const [x, y, z] of BOX) { _p.set(x * w, y, z * l).applyQuaternion(v.quat).add(v.pos); best = Math.min(best, _p.y - v.world.heightAt(_p.x, _p.z, v.pos.y + 1)); }
  return best;
}
// drawn tyres: every vertex of each tyre mesh (its first mesh) vs the ground under it (call after bodyClearance, which
// brings the world matrices up to date)
function tyreClearance(v) {
  let best = Infinity;
  for (const g of v.mesh.userData.wheels) {
    const tyre = g.spin.children.find(o => o.isMesh), pos = tyre.geometry.attributes.position, e = tyre.matrixWorld.elements;
    let lowY = Infinity;
    for (let i = 0; i < pos.count; i++) lowY = Math.min(lowY, e[1] * pos.getX(i) + e[5] * pos.getY(i) + e[9] * pos.getZ(i) + e[13]);
    for (let i = 0; i < pos.count; i++) {
      _p.fromBufferAttribute(pos, i).applyMatrix4(tyre.matrixWorld);
      if (_p.y < lowY + 0.05) best = Math.min(best, _p.y - v.world.heightAt(_p.x, _p.z, v.pos.y + 1));
    }
  }
  return best;
}

// ---------------------------------------------------------------- driving
const flatWorld = () => ({ heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3,
  normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0), waterLevelAt: () => -Infinity,
  treesNear: () => {}, buildingsNear: () => [], loadedAt: () => true, extent: [-1e7, -1e7, 1e7, 1e7] });
function make(kind, id, world) {
  const v = kind === 'car' ? new Car(world, { ...TUNING_DEFAULTS }) : new Bike(world, { ...BIKE });
  applyVehicleType(v, id); return v;
}
const _q = new THREE.Quaternion(), _Y = new THREE.Vector3(0, 1, 0), _f = new THREE.Vector3();
// hold heading (and horizontal speed when kmh is set) on a rail: the rest is the real physics
function hold(v, yaw, kmh, x, z) {
  if (v.kind === 'bike') { v.yaw = yaw; v.yawRate = 0; v.setQuat(); }
  else {
    _f.set(0, 0, 1).applyQuaternion(v.quat);
    _q.setFromAxisAngle(_Y, yaw - Math.atan2(_f.x, _f.z)); v.quat.premultiply(_q).normalize();
    v.ang.y = 0;
  }
  if (x !== undefined) { v.pos.x = x; v.pos.z = z; }
  const hs = kmh === null ? Math.hypot(v.vel.x, v.vel.z) : kmh / 3.6;
  v.vel.x = Math.sin(yaw) * hs; v.vel.z = Math.cos(yaw) * hs;
}
function stats() { return { body: Infinity, where: '', chassis: Infinity, tyre: Infinity, comp: 0, frames: 0, air: 0 }; }
function sample(v, s) {
  v.interpolate(1); v.syncMesh(DT);
  const [b, where] = bodyClearance(v);
  if (b < s.body) { s.body = b; s.where = where; }
  s.chassis = Math.min(s.chassis, chassisClearance(v));
  s.tyre = Math.min(s.tyre, tyreClearance(v));
  const travel = v.kind === 'bike' ? v.t.travel : v.t.restLength;
  for (const w of v.wheels) if (w.contact) s.comp = Math.max(s.comp, w.comp / travel);
  s.frames++; s.air = Math.max(s.air, v.airTime);
  if (!Number.isFinite(v.pos.y)) throw new Error('NaN');
}
const input = (o = {}) => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, lean: false, ...o });

// flat asphalt: hold the speed 1.5 s, slalom 1.5 s (roll, lean), full braking 1 s (dive); 0 = standing start, 3 s
function flat(kind, id, kmh) {
  const v = make(kind, id, flatWorld()), s = stats();
  v.reset(0, 0, 0); v.vel.set(0, 0, kmh / 3.6);
  const steps = kmh ? 4 / DT : 3 / DT;
  for (let i = 0; i < steps; i++) {
    const t = i * DT, slalom = kmh && t > 1.5 && t < 3, brake = kmh && t >= 3;
    v.step(DT, input({ throttle: brake ? 0 : 1, brake: brake ? 1 : 0, steer: slalom ? Math.sign(Math.sin(t * 5)) : 0 }));
    if (kmh && !slalom && !brake) hold(v, 0, kmh);
    if (slalom) { const hs = Math.hypot(v.vel.x, v.vel.z); v.vel.multiplyScalar(kmh / 3.6 / Math.max(hs, 1e-6)); }
    sample(v, s);
  }
  return s;
}
// on a rail: the car starts `lead` m before `from`, runs to `to` (distances along the rail) at a held speed
function onRail(kind, id, R, from, to, kmh) {
  const v = make(kind, id, W), s = stats(), lead = 60 + kmh * 0.5;
  let d = from - lead;
  const [x0, z0] = R.at(d); v.reset(x0, z0, R.yaw(d)); hold(v, R.yaw(d), kmh);
  for (let i = 0; d < to && i < 60 / DT; i++) {
    v.step(DT, input({ throttle: 1 }));
    d += kmh / 3.6 * DT;
    const [x, z] = R.at(d); hold(v, R.yaw(d), kmh, x, z);
    if (d > from - 20) sample(v, s);
  }
  return s;
}
// the Hwy 18 ramp along its heading: run-up, flight, landing and 1.5 s after it
function ramp(kind, id, kmh) {
  const v = make(kind, id, W), s = stats(), yaw = RAMP0.yaw, back = 120 + kmh * 0.4;
  W.setFixedRamps([RAMP0]);
  v.reset(RAMP0.x - RF[0] * back, RAMP0.z - RF[1] * back, yaw); hold(v, yaw, kmh);
  let flew = false, after = 0, d = -back;
  for (let i = 0; i < 12 / DT && after < 1.5; i++) {
    v.step(DT, input({ throttle: 1 }));
    d += kmh / 3.6 * DT; hold(v, yaw, kmh, RAMP0.x + RF[0] * d, RAMP0.z + RF[1] * d);
    if (v.airTime > 0.3) flew = true;
    if (flew && v.grounded) after += DT;
    if (d > -20) sample(v, s);
  }
  W.setFixedRamps([]);
  s.flew = flew; s.landed = after > 0;
  return s;
}

// 120 Hz physics, 60 Hz drawing: p95 absolute frame-to-frame lift change, including immediate safety rises.
// This checks body clearance; the original flat/road/ramp runs below retain their tyre checks. Rough ground beside
// a tyre can rise above its centre contact, so the road tyre tolerance is not applied to these field samples.
function jitter(kind, id, points, kmh) {
  const R = rail(points), v = make(kind, id, W), s = stats(), changes = [], lifts = [];
  v.reset(...R.at(0), R.yaw(0));
  for (let i = 0, d = 0; d < Math.min(R.length - 20, 350); i++) {
    v.step(DT, input({ throttle: 1 }));
    d += kmh / 3.6 * DT;
    hold(v, R.yaw(d), kmh, ...R.at(d));
    if (i % 2) continue;
    v.interpolate(1); v.syncMesh(2 * DT);
    const lift = v.mesh.userData.bodyLift;
    // Ignore spawn settling (first second), but include air/landing and every later frame.
    if (i * DT >= 1) {
      if (lifts.length) changes.push(Math.abs(lift - lifts.at(-1)));
      lifts.push(lift);
      const [b, where] = bodyClearance(v);
      if (b < s.body) { s.body = b; s.where = where; }
    }
  }
  if (changes.length < 60 || lifts.some(n => !Number.isFinite(n))) throw new Error('Incomplete jitter coverage');
  const percentile = (a, p) => [...a].sort((a, b) => a - b)[Math.floor((a.length - 1) * p)];
  s.jitter = percentile(changes, 0.95); s.lift = percentile(lifts, 0.95);
  return s;
}

// ---------------------------------------------------------------- run
const rows = [], fails = [];
const cm = x => Number.isFinite(x) ? (x * 100).toFixed(1).padStart(6) : '     –';
const BIKES = new Set(VEHICLE_TYPES.bike.map(t => t.id)), BIKE_TYRE = 0.015;
// Falling lift must survive the cheap clear-ground exit and release in seconds, independently of drawing rate.
for (const hz of [30, 60, 120]) {
  const model = buildCarModel(), pivot = model.userData.bodyPivot;
  model.position.y = 0.12;
  const initial = keepBodyAboveGround(model, pivot, () => 0.2, false, 1 / hz);
  assert.ok(initial > 0.1, 'ground penetration is corrected immediately');
  let lift;
  for (let frame = 0; frame < hz * 0.4; frame++) lift = keepBodyAboveGround(model, pivot, () => -10, false, 1 / hz);
  assert.ok(Math.abs(lift - initial / Math.E) < 1e-8, `${hz} Hz: release time is 0.4 s, including clear-ground frames`);
  const other = buildCarModel(); other.position.y = 1;
  assert.equal(keepBodyAboveGround(other, other.userData.bodyPivot, () => 0), 0, 'a different model has no retained lift');
  assert.equal(keepBodyAboveGround(model, pivot, null), 0, 'missing ground clears stale lift');
}
console.log('guard: immediate rise, 0.4 s release at 30/60/120 Hz, independent models, missing-ground reset');
// the guard itself (bodyclearance.js), a pitched race car on a slope: lifting along the tilted up moves every point's
// x / z, so the ground must be looked up again where the points end up (review repro)
for (const slope of [0.2, 0.4]) {
  const model = buildCarModel(), pivot = model.userData.bodyPivot, ground = (x, z) => slope * z;
  model.position.set(0, 0.12, 0); model.rotation.set(0.25, 0, 0); pivot.rotation.set(0.06, 0, -0.09);
  keepBodyAboveGround(model, pivot, ground, true);
  model.updateMatrixWorld(true);
  let low = Infinity, where = '';
  pivot.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      _p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      const c = _p.y - ground(_p.x, _p.z);
      if (c < low) { low = c; where = _p.toArray().map(n => n.toFixed(2)).join(','); }
    }
  });
  console.log(`guard: race car pitched 0.25 rad, 12 cm up, on a ${slope} slope: lowest body vertex ${cm(low)} cm over the ground (${where})`);
  if (!(low >= 0)) fails.push(`guard on a ${slope} slope: body vertex ${cm(low)} cm under the ground at ${where}`);
}
function report(type, name, s) {
  rows.push(`${type.padEnd(7)}${name.padEnd(26)}body${cm(s.body)} cm  chassis${cm(s.chassis)} cm  tyre${cm(s.tyre)} cm  comp ${(s.comp * 100).toFixed(0).padStart(3)}%  air ${s.air.toFixed(1)}s  ${s.body < 0 ? '<< UNDER: ' + s.where : ''}`);
  if (s.jitter !== undefined) rows[rows.length - 1] += ` lift p95 ${(s.lift * 1000).toFixed(1)} mm  change p95 ${(s.jitter * 1000).toFixed(1)} mm`;
  console.log(rows.at(-1));
  if (s.jitter >= 0.01) fails.push(`${type} ${name}: lift jitter p95 ${(s.jitter * 1000).toFixed(1)} mm >= 10 mm`);
  if (!(s.body >= 0)) fails.push(`${type} ${name}: drawn body ${cm(s.body)} cm under the ground (${s.where})`);
  // bikes' tyres too (held on the road under the hub: a round tyre on a ramp's slope can dip ~1 cm beside it)
  if (BIKES.has(type) && !(s.tyre >= -BIKE_TYRE)) fails.push(`${type} ${name}: drawn tyre ${cm(s.tyre)} cm in the road`);
  if (s.flew === false || s.landed === false) fails.push(`${type} ${name}: ramp jump must fly and land`);
}
const R = place('hwy') ? rail(ROUTE) : null, F = R ? features(R, 3) : null;
if (R) console.log(`Hwy 18 Sheridan → Bellevue: ${(R.length / 1000).toFixed(1)} km; crests at ${F.crests.map(([d, c]) => `${d} m (${c.toFixed(2)})`).join(', ')}; dips at ${F.dips.map(([d, c]) => `${d} m (+${c.toFixed(2)})`).join(', ')}`);
const t0 = Date.now();
for (const [kind, types] of Object.entries(VEHICLE_TYPES).filter(([k]) => k !== 'jet')) for (const { id } of types) {
  if (onlyTypes.length && !onlyTypes.includes(id)) continue;
  if (place('flat')) for (const kmh of [0, ...SPEEDS]) report(id, kmh ? `flat ${kmh} km/h` : 'flat standing start', flat(kind, id, kmh));
  if (R) for (const kmh of SPEEDS) {
    // the whole road at 600 and 1000; its sharpest crests and dips at every speed
    if (kmh >= 600) report(id, `Hwy 18 all ${kmh} km/h`, onRail(kind, id, R, 30, R.length - 30, kmh));
    const s = stats();
    for (const [d] of [...F.crests, ...F.dips]) {
      const r = onRail(kind, id, R, d - 60, d + 60, kmh);
      if (r.body < s.body) { s.body = r.body; s.where = r.where; }
      s.chassis = Math.min(s.chassis, r.chassis); s.tyre = Math.min(s.tyre, r.tyre); s.comp = Math.max(s.comp, r.comp); s.air = Math.max(s.air, r.air);
    }
    report(id, `Hwy 18 crests+dips ${kmh}`, s);
  }
  if (place('jitter')) for (const [name, points] of JITTER) for (const kmh of [100, 300]) report(id, `${name} jitter ${kmh}`, jitter(kind, id, points, kmh));
  if (place('ramp')) for (const kmh of SPEEDS) report(id, `Hwy 18 ramp ${kmh} km/h`, ramp(kind, id, kmh));
}
console.log(`\n${rows.length} runs in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
if (fails.length) {
  console.log(`\n${fails.length} FAIL\n  ` + fails.join('\n  '));
  if (!process.env.REPORT) process.exit(1);
} else console.log('PASS body clip: no drawn body point under the ground');
