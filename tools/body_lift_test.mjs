// The drawn body must stay on its wheels (bodyclearance.js): every car / bike type driven along road edges right next to
// the steepest banks and cuttings on the real tiles (a scan of every tile's asphalt for ground ≥ 1.2 m above the lane
// within 1.1 m of the road's edge), over the sharpest crests and across bridge ends near them, real physics, drawn at
// 60 Hz exactly as the game does (interpolate + syncMesh). Per run: the drawn lift (userData.bodyLift) settled on the
// road and tilted (see run()), how far that lift floats the drawn tyres off the road while settled (≤ FLOAT_MAX), the
// largest drop of a car's hub below its parked place in the body frame (how far the wheels hang off the body: ≤ the
// springs' droop from parked + the cap, bodyLiftCap, + body roll / dive), the race car's suspension arms (largest swing
// and stretch the wheels asked for, within models/racecar.js ARM_SWING / ARM_STRETCH, and as drawn), and the lowest
// drawn body point over the road (diagnostic: beside a bank the bank may meet the body's edge). Frames where the rail
// runs the vehicle into the bank (up it, or crashed: the whole model may be lifted) are counted apart.
// Owner screenshot: the race car beside a steep dirt bank, its body drawn 2–3 m up the bank, arms as long sticks.
//   node tools/body_lift_test.mjs [types] [bank|crest|bridge]      (heavy gate: ~6 min)
//   --report (or REPORT=1): print without failing; --v (or V=1): every run; TRACE=<run name part>: frame by frame
import fs from 'fs';
import * as THREE from 'three';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { Bike, BIKE } from '../game/src/bike.js';
import { VEHICLE_TYPES, applyVehicleType } from '../game/src/vehicletypes.js';
import * as clearance from '../game/src/bodyclearance.js';
import * as racecar from '../game/src/models/racecar.js';

const DT = 1 / 120, PLACES = ['bank', 'crest', 'bridge'];
const FLAGS = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const REPORT = !!process.env.REPORT || FLAGS.has('--report'), VERBOSE = !!process.env.V || FLAGS.has('--v');
const args = process.argv.slice(2).filter(a => !a.startsWith('--')), onlyPlaces = args.filter(a => PLACES.includes(a)), onlyTypes = args.filter(a => !PLACES.includes(a));
const place = p => !onlyPlaces.length || onlyPlaces.includes(p);
const A = (process.env.YR_ASSETS || 'game/assets').replace(/\/?$/, '/');
// (also runs on the code before the fix, with no cap: reported against the requested limits)
const capOf = clearance.bodyLiftCap ?? (() => 0.25);
const ARM_SWING = racecar.ARM_SWING ?? 0.6, ARM_STRETCH = racecar.ARM_STRETCH ?? 1.2;
const FLOAT_MAX = 0.15;     // m: settled on the road, the lift floats the lowest drawn tyre at most this far above it (a
                            // car with a wheel in the gutter lifts its body ~25 cm over the road's raised edge)

// ---------------------------------------------------------------- world: the tiles round each site
const WJ = JSON.parse(fs.readFileSync(A + 'world.json'));
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const readTile = async (tx, tz) => readTileData(async f => ab(`${A}tiles/${tx}_${tz}/${f}`), WJ.packed);
const T = WJ.tile, tileOf = v => Math.floor((v + T / 2) / T), have = new Set(WJ.tiles.map(([x, z]) => `${x},${z}`));
const W = makeWorld(WJ), raw = new Map();
async function load(x, z, pad = 300) {
  for (const dx of [-pad, 0, pad]) for (const dz of [-pad, 0, pad]) {
    const tx = tileOf(x + dx), tz = tileOf(z + dz), k = `${tx},${tz}`;
    if (raw.has(k) || !have.has(k)) continue;
    const td = await readTile(tx, tz); raw.set(k, td); W.add(makeTileData(WJ, tx, tz, td));
  }
}
// the steepest banks beside asphalt (x, z), one per area: a road through a cutting, a lane under a dirt bank, Hwy 18
const BANKS = [[-4102.6, 6265], [-2130.4, 16176.2], [9422.2, -27955], [394.9, -1114.4], [28310.2, -12719.1],
  [18148.5, -8831.9], [-10236.9, 5484.5], [5446, 1730.3], [22137.5, 2364.8], [8704.1, 402.3]];
for (const [x, z] of BANKS) await load(x, z);
const roadAt = (x, z) => W.heightAt(x, z, W.terrainAt(x, z) + 2);
const asphalt = () => [...raw.values()].flatMap(td => td.tile.physPaths.filter(p => p.kind === 'asphalt' && p.pts.length > 1));

// a polyline as a rail, shifted sideways by `off` (m, + = left of travel): position and heading at a distance along it
function rail(points, off = 0) {
  const pts = points.map((p, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [p[0] + (b[1] - a[1]) / L * off, p[1] - (b[0] - a[0]) / L * off];
  });
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const at = d => {
    d = Math.max(0, Math.min(s.at(-1), d));
    let lo = 0, hi = s.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= d) lo = m; else hi = m; }
    const u = (d - s[lo]) / ((s[hi] - s[lo]) || 1), [x0, z0] = pts[lo], [x1, z1] = pts[hi];
    return [x0 + (x1 - x0) * u, z0 + (z1 - z0) * u];
  };
  const yaw = d => { const [a, b] = at(d - 4), [c, e] = at(d + 4); return Math.atan2(c - a, e - b); };
  const near = (x, z) => { let best = Infinity, bd = 0; for (let d = 0; d <= s.at(-1); d += 1) { const [px, pz] = at(d), q = Math.hypot(px - x, pz - z); if (q < best) { best = q; bd = d; } } return [bd, best]; };
  return { length: s.at(-1), at, yaw, near };
}
// left normal of the polyline at distance d (unit, x / z)
const leftOf = (R, d) => { const y = R.yaw(d); return [Math.cos(y), -Math.sin(y)]; };

// bank runs: the path nearest each site, the bank's side (the side whose ground rises most within 1.1 m of the edge)
const bankRuns = [];
if (place('bank')) for (const [x, z] of BANKS) {
  let best = null;
  for (const p of asphalt()) {
    if (!p.pts.some(([px, pz]) => Math.abs(px - x) < 200 && Math.abs(pz - z) < 200)) continue;
    const R = rail(p.pts), [d, q] = R.near(x, z);
    if (q < 3 && (!best || q < best.q)) best = { R, d, q, p };
  }
  if (!best) { console.log(`bank ${x},${z}: no asphalt near`); continue; }
  const { R, d, p } = best, [px, pz] = R.at(d), [nx, nz] = leftOf(R, d), hw = p.w / 2;
  const rise = side => Math.max(...[0.2, 0.5, 0.8, 1.1].map(o => roadAt(px + nx * side * (hw + o), pz + nz * side * (hw + o)) - roadAt(px + nx * side * (hw - 1), pz + nz * side * (hw - 1))));
  const side = rise(1) >= rise(-1) ? 1 : -1;
  bankRuns.push({ name: `bank ${x.toFixed(0)},${z.toFixed(0)} (${Math.max(rise(1), rise(-1)).toFixed(1)} m)`, pts: p.pts, d, side, hw });
}
// the sharpest crests on these tiles' asphalt (centre line, height change across ±6 m), at least 300 m apart
const crestRuns = [], bridgeRuns = [];
if (place('crest')) {
  const c = [];
  for (const p of asphalt()) {
    const R = rail(p.pts);
    if (R.length < 80) continue;
    for (let d = 40; d < R.length - 40; d += 2) {
      const h = q => roadAt(...R.at(q)); c.push({ curve: 2 * h(d) - h(d - 6) - h(d + 6), d, p });
    }
  }
  c.sort((a, b) => b.curve - a.curve);
  for (const k of c) {
    if (crestRuns.length >= 6) break;
    const [x, z] = rail(k.p.pts).at(k.d);
    if (crestRuns.every(o => Math.hypot(o.x - x, o.z - z) > 300)) crestRuns.push({ name: `crest ${x.toFixed(0)},${z.toFixed(0)} (${k.curve.toFixed(2)} m)`, pts: k.p.pts, d: k.d, side: 0, hw: k.p.w / 2, x, z });
  }
}
// bridge ends: each bridge deck path on these tiles with the road beyond it (its end segments extended 50 m)
if (place('bridge')) for (const p of asphalt().filter(p => p.bridge)) {
  if (bridgeRuns.length >= 4) break;
  const ext = (a, b) => { const L = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; return [a[0] + (a[0] - b[0]) / L * 50, a[1] + (a[1] - b[1]) / L * 50]; };
  const pts = [ext(p.pts[0], p.pts[1]), ...p.pts, ext(p.pts.at(-1), p.pts.at(-2))];
  const R = rail(pts), [x, z] = R.at(50);
  if (R.length < 120 || bridgeRuns.some(o => Math.hypot(o.x - x, o.z - z) < 300)) continue;
  bridgeRuns.push({ name: `bridge ${x.toFixed(0)},${z.toFixed(0)} (${(R.length - 100).toFixed(0)} m deck)`, pts, d: 50, end: R.length - 50, side: 0, hw: p.w / 2, x, z });
}

// ---------------------------------------------------------------- driving
function make(kind, id) {
  const v = kind === 'car' ? new Car(W, { ...TUNING_DEFAULTS }) : new Bike(W, { ...BIKE });
  applyVehicleType(v, id); return v;
}
const _q = new THREE.Quaternion(), _Y = new THREE.Vector3(0, 1, 0), _f = new THREE.Vector3(), _h = new THREE.Vector3(), _inv = new THREE.Matrix4();
function hold(v, yaw, kmh, x, z) {
  if (v.kind === 'bike') { v.yaw = yaw; v.yawRate = 0; v.setQuat(); }
  else {
    _f.set(0, 0, 1).applyQuaternion(v.quat);
    _q.setFromAxisAngle(_Y, yaw - Math.atan2(_f.x, _f.z)); v.quat.premultiply(_q).normalize();
    v.ang.y = 0;
  }
  v.pos.x = x; v.pos.z = z;
  v.vel.x = Math.sin(yaw) * kmh / 3.6; v.vel.z = Math.cos(yaw) * kmh / 3.6;
}
// half the vehicle's track (outer tyre faces) from its model
function halfTrack(v) {
  const box = new THREE.Box3(), m = v.mesh;
  m.updateMatrixWorld(true);
  const inv = m.matrixWorld.clone().invert();
  for (const w of m.userData.wheels) for (const o of w.spin.children) if (o.isMesh) {
    o.geometry.computeBoundingBox();
    box.union(o.geometry.boundingBox.clone().applyMatrix4(inv.clone().multiply(o.matrixWorld)));
  }
  return Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
}
// parked on flat ground, settled
function parkedOnFlat(kind, id) {
  const flat = { heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3, normalAt: (x, z, o = new THREE.Vector3()) => o.set(0, 1, 0),
    waterLevelAt: () => -Infinity, treesNear: () => {}, buildingsNear: () => [], loadedAt: () => true, extent: [-1e7, -1e7, 1e7, 1e7] };
  const v = kind === 'car' ? new Car(flat, { ...TUNING_DEFAULTS }) : new Bike(flat, { ...BIKE }); applyVehicleType(v, id); v.reset(0, 0, 0);
  for (let i = 0; i < 360; i++) { v.step(DT, { throttle: 0, brake: 0, steer: 0 }); if (i % 2) { v.interpolate(1); v.syncMesh(2 * DT); } }
  return v;
}
// a car's hub heights in the body frame parked, and its springs' droop from there (m)
function parkedHubs(kind, id) {
  if (kind !== 'car') return null;
  const v = parkedOnFlat(kind, id), hubs = hubsInBody(v), lean = v.typePhysics?.lean ?? 1;
  // the springs' droop from parked, and the body's largest roll / dive (car.js syncMesh) swinging it over a hub
  hubs.droop = Math.max(...v.wheels.map(w => w.comp));
  hubs.swing = Math.max(...v.mesh.userData.wheels.map(w => 0.09 * lean * Math.abs(w.holder.position.x) + 0.06 * lean * Math.abs(w.holder.position.z)));
  return hubs;
}
function hubsInBody(v) {
  const ud = v.mesh.userData; ud.bodyPivot.updateMatrix(); _inv.copy(ud.bodyPivot.matrix).invert();
  return ud.wheels.map(w => _h.copy(w.holder.position).applyMatrix4(_inv).y);
}
const _p = new THREE.Vector3();
// how far the drawn vehicle floats: the lowest drawn tyre's bottom (hub − radius) over the road under it
function tyreFloat(v) {
  v.mesh.updateMatrixWorld(true);
  let low = Infinity;
  for (const w of v.mesh.userData.wheels) {
    w.holder.getWorldPosition(_p);
    low = Math.min(low, _p.y - w.r - W.heightAt(_p.x, _p.z, _p.y + 1));
  }
  return low;
}
// lowest drawn body vertex over the road under it (diagnostic)
function bodyLow(v) {
  const m = v.mesh, ud = m.userData, skip = new Set(ud.wheels.map(w => w.holder)), ref = v.renderPos.y + 1;
  m.updateMatrixWorld(true);
  let low = Infinity;
  (ud.bodyPivot || ud.lean).traverse(o => {
    if (!o.isMesh || !o.visible) return;
    for (let q = o; q && q !== m; q = q.parent) if (skip.has(q) || q.name === 'glider' || !q.visible) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 3) { _p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); low = Math.min(low, _p.y - W.heightAt(_p.x, _p.z, ref)); }
  });
  return low;
}
// drive one rail: from `d - lead` to `end` at kmh (≥ 5); every second step drawn. `lift`: frames with the physics
// settled on the road for 0.5 s before and after (up within 25° of vertical, every wheel touching, its centre within
// 40 cm of its parked height over the road's centre line beside it, R0); `tilted`: upright but not settled (a wheel up
// the bank, airborne, landing, or hitting a step the physics then launches off: the whole model may be lifted then).
// Where the rail runs it into the bank (or over a drop) the physics climbs onto it, or falls off the road (`off`), or
// tumbles (`wreck`): counted apart. `float`: the lift's share of how far the lowest drawn tyre is off the road (car.js
// syncMesh also draws the whole car up to a tyre radius higher where a wheel's mount is under the ground, pressed into
// the bank's wall: `rawFloat`, shown apart).
const CALM = 30;            // drawn frames (0.5 s)
function run(kind, id, R, R0, from, to, kmh, parked, rest, trace = false) {
  const v = make(kind, id), s = { lift: 0, tilted: 0, float: 0, rawFloat: 0, swing: 0, stretch: 0, wantSwing: 0, wantStretch: 0, droop: 0, low: Infinity, frames: 0, wreck: 0, off: 0 };
  let d = Math.max(0, from);
  const F = [];             // drawn frames on the road, upright: [settled, lift, float]
  const judge = () => {     // each settled stretch, but its first and last CALM frames
    for (let a = 0; a < F.length;) {
      if (!F[a][0]) { if (F[a][1] !== null) s.tilted = Math.max(s.tilted, F[a][1]); a++; continue; }
      let b = a; while (b < F.length && F[b][0]) b++;
      for (let k = a; k < b; k++) {
        if (k - a < CALM || b - k <= CALM) { s.tilted = Math.max(s.tilted, F[k][1]); continue; }
        s.lift = Math.max(s.lift, F[k][1]); s.float = Math.max(s.float, Math.min(F[k][2], F[k][1])); s.rawFloat = Math.max(s.rawFloat, F[k][2]);
      }
      a = b;
    }
  };
  v.reset(...R.at(d), R.yaw(d)); hold(v, R.yaw(d), kmh, ...R.at(d));
  const ud = v.mesh.userData;
  for (let i = 0; d < to && i < 60 / DT; i++) {
    v.step(DT, { throttle: 1, brake: 0, steer: 0, handbrake: false, lean: false });
    d += kmh / 3.6 * DT; hold(v, R.yaw(d), kmh, ...R.at(d));
    if (i % 2 || i * DT < 0.5) continue;
    v.interpolate(1); v.syncMesh(2 * DT);
    if (!Number.isFinite(v.pos.y) || !Number.isFinite(ud.bodyLift)) throw new Error(`${id}: NaN`);
    _f.set(0, 1, 0).applyQuaternion(v.renderQuat);
    const over = v.renderPos.y - W.heightAt(...R0.at(d), v.renderPos.y + 1);
    const onRoad = Math.abs(over - rest) <= 0.4, settled = _f.y > 0.9 && onRoad && v.wheels.every(w => w.contact);
    if (_f.y < 0.7) { s.wreck++; F.push([false, null, 0]); }
    else if (!onRoad) { s.off++; F.push([false, null, 0]); }
    else F.push([settled, ud.bodyLift, settled ? tyreFloat(v) : 0]);
    s.frames++;
    if (trace && (i % 8 === 0 || ud.bodyLift > 0.3 || tyreFloat(v) > FLOAT_MAX)) {
      console.log(`    t ${(i * DT).toFixed(2)}  lift${cm(ud.bodyLift)}  float${cm(tyreFloat(v))}  up.y ${_f.y.toFixed(2)}  pivot.y${cm(ud.bodyPivot?.position.y ?? ud.lean.position.y)}  drawn-physics${cm(v.mesh.position.y - v.renderPos.y)}  over road${cm(over)}  contacts ${v.wheels.map(w => w.contact ? 1 : 0).join('')}`);
    }
    if (ud.linkage?.extent) {
      const e = ud.linkage.extent();
      s.swing = Math.max(s.swing, e.swing); s.stretch = Math.max(s.stretch, e.stretch);
      s.wantSwing = Math.max(s.wantSwing, e.wantSwing); s.wantStretch = Math.max(s.wantStretch, e.wantStretch);
    }
    if (parked) hubsInBody(v).forEach((y, k) => { s.droop = Math.max(s.droop, parked[k] - y); });
    if (i % 8 === 0) s.low = Math.min(s.low, bodyLow(v));
  }
  judge();
  return s;
}

// ---------------------------------------------------------------- run
const rows = [], fails = [];
const cm = x => Number.isFinite(x) ? (x * 100).toFixed(1).padStart(6) : '     –';
console.log(`sites: ${bankRuns.length} banks, ${crestRuns.length} crests, ${bridgeRuns.length} bridges`);
const t0 = Date.now(), worst = {};
for (const [kind, types] of Object.entries(VEHICLE_TYPES).filter(([k]) => k !== 'jet')) for (const { id } of types) {
  if (onlyTypes.length && !onlyTypes.includes(id)) continue;
  const probe = make(kind, id), track = halfTrack(probe), parked = parkedHubs(kind, id), rest = parkedOnFlat(kind, id).pos.y;
  probe.reset(0, 0, 0); probe.interpolate(1); probe.syncMesh(DT);
  const cap = capOf(probe.mesh);
  const jobs = [];
  // banks: outer tyre 10 cm inside the edge, and 30 cm over it; crawling, 40, 100 km/h, through 50 m either side
  for (const b of bankRuns) for (const gap of [0.1, -0.3]) for (const kmh of [5, 40, 100]) {
    const R = rail(b.pts, b.side * (b.hw - track - gap)), from = b.d - (kmh === 5 ? 12 : 50), to = b.d + (kmh === 5 ? 12 : 50);
    jobs.push([`${b.name} edge ${gap > 0 ? 'in' : 'over'} ${kmh}`, R, rail(b.pts), from, to, kmh]);
  }
  for (const c of crestRuns) for (const kmh of [60, 150]) {
    const R = rail(c.pts, -c.hw / 2);          // the right lane
    jobs.push([`${c.name} ${kmh}`, R, rail(c.pts), c.d - 60 - kmh / 4, c.d + 40, kmh]);
  }
  for (const b of bridgeRuns) for (const kmh of [60, 150]) jobs.push([`${b.name} ${kmh}`, rail(b.pts, -b.hw / 2), rail(b.pts), 0, rail(b.pts).length, kmh]);
  for (const [name, R, R0, from, to, kmh] of jobs) {
    const s = run(kind, id, R, R0, from, to, kmh, parked, rest, !!process.env.TRACE && name.includes(process.env.TRACE)), key = name.split(' ')[0];
    const w = worst[`${id} ${key}`] ??= { runs: 0, lift: 0, tilted: 0, float: 0, rawFloat: 0, swing: 0, stretch: 0, wantSwing: 0, wantStretch: 0, droop: 0, low: Infinity, wreck: 0, off: 0 };
    for (const k of ['lift', 'tilted', 'float', 'rawFloat', 'swing', 'stretch', 'wantSwing', 'wantStretch', 'droop']) w[k] = Math.max(w[k], s[k]);
    w.low = Math.min(w.low, s.low); w.wreck += s.wreck > 0; w.off += s.off > 0; w.runs++;
    // settled on the road beside the bank (the owner's screenshot): the drawn vehicle doesn't float off the road; a
    // car's hub is never further below its parked place on the body than the springs' droop from parked, the cap and
    // roll / dive
    if (s.float > FLOAT_MAX) fails.push(`${id} ${name}: settled on the road, the lift floats every drawn tyre ${cm(s.float)} cm or more above it`);
    if (parked && s.droop > parked.droop + cap + parked.swing) fails.push(`${id} ${name}: a wheel drawn ${cm(s.droop)} cm below its parked place on the body > ${cm(parked.droop + cap + parked.swing)} cm`);
    if (s.wantSwing > ARM_SWING || s.wantStretch > ARM_STRETCH || s.swing > ARM_SWING + 1e-6 || s.stretch > ARM_STRETCH + 1e-6)
      fails.push(`${id} ${name}: arms asked to swing ${s.wantSwing.toFixed(2)} rad, stretch ×${s.wantStretch.toFixed(2)} (limits ${ARM_SWING}, ×${ARM_STRETCH})`);
    if (VERBOSE) console.log(`  ${id.padEnd(7)}${name.padEnd(44)} lift${cm(s.lift)} cm (tilted${cm(s.tilted)})  float${cm(s.float)} cm (all${cm(s.rawFloat)})  droop${cm(s.droop)} cm${s.wantStretch ? `  arms ${s.wantSwing.toFixed(2)} rad ×${s.wantStretch.toFixed(2)}` : ''}  body over road${cm(s.low)} cm${s.wreck || s.off ? `  (frames apart: ${s.off} off the road, ${s.wreck} wrecked)` : ''}`);
  }
  for (const [k, w] of Object.entries(worst).filter(([k]) => k.startsWith(id + ' '))) {
    rows.push(`${k.padEnd(14)} ${String(w.runs).padStart(3)} runs  cap${cm(cap)} cm  max lift settled${cm(w.lift)} cm, tilted${cm(w.tilted)} cm  tyres floated by it${cm(w.float)} cm (in all${cm(w.rawFloat)})  max hub droop${cm(w.droop)} cm${parked ? ` (≤${cm(parked.droop + cap + parked.swing)})` : ''}` +
      `${w.wantStretch ? `  arms asked ${w.wantSwing.toFixed(2)} rad ×${w.wantStretch.toFixed(2)}, drawn ${w.swing.toFixed(2)} rad ×${w.stretch.toFixed(2)}` : ''}` +
      `  lowest body over road${cm(w.low)} cm${w.wreck || w.off ? `  (runs partly apart: ${w.off} off the road, ${w.wreck} wrecked)` : ''}`);
    console.log(rows.at(-1));
  }
}
console.log(`\n${Date.now() - t0 > 0 ? ((Date.now() - t0) / 1000).toFixed(0) : 0} s`);
if (fails.length) {
  console.log(`\n${fails.length} FAIL\n  ` + fails.slice(0, 40).join('\n  '));
  if (!REPORT) process.exit(1);
} else console.log('PASS body lift: every drawn body within its springs + cap of its wheels, race car arms within their limits');
