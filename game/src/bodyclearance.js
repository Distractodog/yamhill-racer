// Drawing only: keeps the drawn body above the road. The body's show motion — the car body's roll / squat / dive on
// userData.bodyPivot, the bike's lean on userData.lean — is scaled back where it would bring the underside within
// BODY_CLEAR of the ground; if even the unrotated body is too low there (a sharp crest, a ramp lip under the nose) the
// pivot is lifted the rest (the whole model, when a crash has it far from upright). Physics is never touched (car.js syncMesh also draws the whole car higher, tyres on the
// road, when downforce or a landing has pushed the springs past full travel).
// The underside is sampled once per model: every face (≤ 0.3 m apart) bucketed into 0.4 m cells, keeping in each cell
// the points that are lowest for any tilt in the pose's range. Cosmetic add-ons, wheels and a glider don't count.
// Per frame: the ground on a 3 × 4 grid under the body (exact heights), interpolated with a margin that bounds how far a
// crease between the grid points can rise above it; the exact height is looked up only under points that come within
// 1 cm of the limit on that estimate.
// Upright, the body is never lifted further off its wheels than the caller allows (maxLift: a car's springs' travel left,
// at least its type's small cap, bodyLiftCap: from its ride height, 12–25 cm); any more (a ramp's face or a landing slope
// under the nose) lifts the whole model, wheels and all, as a wreck far from upright is. And only ground near the plane
// through the wheels' contacts counts: a bank or cutting rising steeply beside the road would otherwise lift the body
// metres off its wheels (the race car's arms drawn as long sticks). Ground up to `reach` (the cap plus the ride height)
// above that plane counts in full (past the axles, a ramp-like slope more), then less, and none from twice that: the
// bank meets the body's edge instead. Landing or tumbling all the ground counts, as before (the excess over maxLift
// then lifts the whole model).
import * as THREE from 'three';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';
import { wheelArch } from './wheeltravel.js';

export const BODY_CLEAR = 0.003;              // only reserve a few mm above the actual ground
const FALL_TIME = 0.4;                       // seconds: immediate rise, exponential release
const CELL = 0.4, STEP = 0.3, NEAR = 0.01;      // m: NEAR = how close to the limit (estimated) a point is looked up
const GX = 3, GZ = 4;
const CAP_MIN = 0.12, CAP_MAX = 0.25;          // m: an upright body's largest lift (half its ride height + 8 cm, within these)
const FOOT_SIDE = 0.4;                          // m: a bike's two contacts are widened sideways to span a plane
const UPRIGHT_MAX = 1;                          // m: driving (not landing), a vehicle is never drawn higher than this
const AHEAD_SLOPE = 0.35;                       // rise per m past the axles that still counts (ramps 0.2; banks: steeper)
const TILT_OFF = 0.35;                          // rise per m the wheels' ground may tilt off the physics' stance
const RESAMPLE = 0.25;   // m: points this close to the limit get their ground again after the body moved (≤ a few cm sideways)
// tilts (rise per m of x, per m of z) a cell's candidates must be lowest for: a car's roll and pitch, a bike's lean
const CAR_TILTS = [[0, 0], [-0.3, 0], [0.3, 0], [0, -0.3], [0, 0.3]];
const BIKE_TILTS = [-1.8, -0.9, -0.4, 0, 0.4, 0.9, 1.8].flatMap(a => [[a, -0.3], [a, 0], [a, 0.3]]);
const cache = new WeakMap();
const _m = new THREE.Matrix4(), _mm = new THREE.Matrix4(), _p0 = new THREE.Matrix4(), _p1 = new THREE.Matrix4(),
  _e = new THREE.Euler(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _a = new THREE.Vector3(),
  _b = new THREE.Vector3(), _c = new THREE.Vector3();

function skipped(o, root, holders) {
  for (let q = o; q && q !== root; q = q.parent) {
    if (holders.has(q) || q.name === 'glider' || q.name.startsWith('cosmetic-') || q.userData.cosmetic) return true;
  }
  return false;
}
function isUnder(o, root) { for (let q = o.parent; q; q = q.parent) if (q === root) return true; return false; }
// a moving part under the pivot (bike rider, handlebars) keeps its points in its own frame; they're moved live
function build(model, pivot) {
  const ud = model.userData, holders = new Set((ud.wheels || []).map(w => w.holder));
  const movers = [ud.rider, ud.bars].filter(g => g && g !== pivot && isUnder(g, pivot));
  const TILTS = pivot === ud.lean ? BIKE_TILTS : CAR_TILTS;
  model.updateMatrixWorld(true);
  // per cell and tilt: [score, x, y, z] of the lowest point so far (flat arrays; built once, keep it cheap)
  const T = TILTS.length, out = [pivot, ...movers].map(root => ({ root, cells: new Map(), best: [] }));
  const corners = new Map();                                       // the static body's vertices, for its hull
  pivot.traverse(o => {
    if (!o.isMesh || skipped(o, pivot, holders)) return;          // hidden LOD levels too: any can be drawn
    let set = out[0];
    for (let q = o; q && q !== pivot; q = q.parent) { const s = out.find(s => s.root === q); if (s) { set = s; break; } }
    _m.copy(set.root.matrixWorld).invert().multiply(o.matrixWorld);
    const pos = o.geometry.attributes.position, idx = o.geometry.index, { cells, best } = set;
    const add = (x, y, z) => {
      const key = (Math.floor(x / CELL) + 4096) * 8192 + Math.floor(z / CELL) + 4096;
      let c = cells.get(key);
      if (c === undefined) { c = best.length; cells.set(key, c); for (let i = 0; i < T; i++) best.push(Infinity, 0, 0, 0); }
      for (let i = 0; i < T; i++) {
        const s = y + TILTS[i][0] * x + TILTS[i][1] * z, o = c + 4 * i;
        if (s < best[o]) { best[o] = s; best[o + 1] = x; best[o + 2] = y; best[o + 3] = z; }
      }
    };
    for (let j = 0; j < (idx ? idx.count : pos.count); j += 3) {
      const g = k => idx ? idx.getX(j + k) : j + k;
      _a.fromBufferAttribute(pos, g(0)).applyMatrix4(_m); _b.fromBufferAttribute(pos, g(1)).applyMatrix4(_m);
      _c.fromBufferAttribute(pos, g(2)).applyMatrix4(_m);
      if (set === out[0]) for (const v of [_a, _b, _c]) {
        const key = ((Math.round(v.x * 500) + 4096) * 8192 + Math.round(v.y * 500) + 4096) * 8192 + Math.round(v.z * 500) + 4096;
        if (!corners.has(key)) corners.set(key, v.clone());
      }
      const n = Math.max(1, Math.ceil(Math.max(_a.distanceTo(_b), _b.distanceTo(_c), _c.distanceTo(_a)) / STEP));
      for (let u = 0; u <= n; u++) for (let v = 0; u + v <= n; v++) {
        const f = u / n, h = v / n, e = 1 - f - h;
        add(_a.x * f + _b.x * h + _c.x * e, _a.y * f + _b.y * h + _c.y * e, _a.z * f + _b.z * h + _c.z * e);
      }
    }
  });
  let bodyLow = Infinity;
  const sets = out.map(({ root, best }) => {
    const pts = [];
    for (let c = 0; c < best.length; c += 4 * T) {               // each cell's distinct lowest points
      const seen = new Set();
      for (let i = c; i < c + 4 * T; i += 4) {
        const k = `${best[i + 1]},${best[i + 2]},${best[i + 3]}`;
        if (!seen.has(k)) { seen.add(k); pts.push(best[i + 1], best[i + 2], best[i + 3]); }
        if (root === pivot) bodyLow = Math.min(bodyLow, best[i + 2]);
      }
    }
    // a car's wheels hang from the model and its arches tilt with the body: an arch must stay a tyre (and drawnWheelY's
    // easing: 2 cm, or half the parked room) above the road, or drawnWheelY would push the tyre down into it
    if (root === pivot) (ud.wheels || []).forEach((w, i) => {
      if (isUnder(w.holder, pivot)) return;
      const arch = wheelArch(model, i), ease = Math.min(0.02, Math.max(0, (arch - w.r - w.holder.position.y) / 2));
      pts.push(w.holder.position.x, arch - 2 * w.r - ease + BODY_CLEAR, w.holder.position.z);
    });
    return { root, pts: new Float32Array(pts) };
  }).filter(s => s.pts.length);
  // any tilt (a crash): over a flat-ish road the lowest point is a corner of the body's convex hull
  if (corners.size >= 4) {
    const hull = new ConvexHull().setFromPoints([...corners.values()]), on = new Set();
    for (const face of hull.faces) { let e = face.edge; do { on.add(e.head().point); e = e.next; } while (e !== face.edge); }
    sets.push({ root: pivot, exactOnly: true, pts: new Float32Array([...on].flatMap(p => [p.x, p.y, p.z])) });
  }
  // the ground grid: over the body's footprint (pivot frame), wider for a bike's lean
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const p = sets[0].pts, pad = pivot === ud.lean ? 0.6 : 0.3;
  for (let j = 0; j < p.length; j += 3) { x0 = Math.min(x0, p[j]); x1 = Math.max(x1, p[j]); z0 = Math.min(z0, p[j + 2]); z1 = Math.max(z1, p[j + 2]); }
  const n = sets.reduce((n, s) => n + s.pts.length / 3, 0);
  // a box (pivot frame) round every point; a moving part's points as built, padded for how far it moves
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const s of sets) {
    const pad = s.root === pivot ? 0 : 0.4;
    _m.copy(pivot.matrixWorld).invert().multiply(s.root.matrixWorld);
    for (let j = 0; j < s.pts.length; j += 3) {
      _v.set(s.pts[j], s.pts[j + 1], s.pts[j + 2]).applyMatrix4(_m);
      for (let c = 0; c < 3; c++) { box[c] = Math.min(box[c], _v.getComponent(c) - pad); box[c + 3] = Math.max(box[c + 3], _v.getComponent(c) + pad); }
    }
  }
  // the wheels' contacts (level pivot frame: a car's wheels hang from the model, a bike's lean with the body) and the
  // ride height, the body's lowest point over the parked tyres' bottoms: the lift cap and how far ground above the
  // wheels' plane still counts
  const feet = [];
  let tyreLow = Infinity, axleBack = Infinity, axleFront = -Infinity;
  for (const w of ud.wheels || []) {
    if (isUnder(w.holder, pivot)) _m.copy(pivot.matrixWorld).invert().multiply(w.holder.matrixWorld);
    else _m.copy(model.matrixWorld).invert().multiply(w.holder.matrixWorld);
    _v.setFromMatrixPosition(_m);
    if (!isUnder(w.holder, pivot)) _v.sub(pivot.position);
    tyreLow = Math.min(tyreLow, _v.y - w.r);
    axleBack = Math.min(axleBack, _v.z); axleFront = Math.max(axleFront, _v.z);
    for (const s of ud.wheels.length < 3 ? [-FOOT_SIDE, 0, FOOT_SIDE] : [0]) feet.push(_v.x + s, _v.y - w.r, _v.z);
  }
  const ride = Number.isFinite(tyreLow) && Number.isFinite(bodyLow) ? Math.max(0, bodyLow - tyreLow) : 0;
  const cap = Math.min(CAP_MAX, Math.max(CAP_MIN, ride / 2 + 0.08));
  return { base: pivot.position.y, sets, box, grid: [x0 - pad, x1 + pad, z0 - pad, z1 + pad], gh: new Float32Array(GX * GZ),
    rise: new Float32Array((GX - 1) * (GZ - 1)), cand: new Float32Array(n * 4),
    feet: feet.length >= 9 ? new Float32Array(feet) : null, cap, reach: cap + ride, axles: [axleBack, axleFront] };
}
// the most an upright body is drawn lifted off its wheels (m)
export function bodyLiftCap(model, pivot = model.userData.bodyPivot || model.userData.lean) {
  let entry = cache.get(pivot);
  if (!entry) cache.set(pivot, entry = build(model, pivot));
  return entry.cap;
}
// The wheels' plane (world): h = a + b·(x − cx) + c·(z − cz), fitted to the ground under the wheels' contacts. A contact
// whose ground is more than `reach` above the median (offsets from the parked tyres' bottoms at the model's pose) is
// left out: a wheel pressed into a cutting's wall, the ground under its centre the bank's top. If fewer than three are
// left, or the fitted tilt is more than TILT_OFF from how the physics stands (wheels pushed into a wall), the plane is
// tilted as the physics stands, at the second lowest offset.
const plane = { a: 0, b: 0, c: 0, cx: 0, cz: 0 };
let _fp = new Float64Array(0), _fo = new Float64Array(0), _fs = new Float64Array(0);
function fitPlane(P, n, Y, use) {         // least squares through P[3i], P[3i + Y], P[3i + 2] where use(i): false if < 3
  let k = 0, cx = 0, cz = 0, a = 0;
  for (let i = 0; i < n; i++) if (use(i)) { cx += P[3 * i]; cz += P[3 * i + 2]; a += P[3 * i + Y]; k++; }
  if (k < 3) return false;
  cx /= k; cz /= k; a /= k;
  let xx = 0, xz = 0, zz = 0, xy = 0, zy = 0;
  for (let i = 0; i < n; i++) if (use(i)) {
    const x = P[3 * i] - cx, z = P[3 * i + 2] - cz, y = P[3 * i + Y] - a;
    xx += x * x; xz += x * z; zz += z * z; xy += x * y; zy += z * y;
  }
  const det = xx * zz - xz * xz;
  if (!(det > 1e-6)) return false;
  plane.a = a; plane.cx = cx; plane.cz = cz; plane.b = (xy * zz - zy * xz) / det; plane.c = (zy * xx - xy * xz) / det;
  return true;
}
function wheelPlane(entry, m, ground) {
  const f = entry.feet, e = m.elements, n = f.length / 3;
  if (_fp.length < f.length) { _fp = new Float64Array(f.length); _fo = new Float64Array(n); }
  const P = _fp, O = _fo;                // per contact: x, y (the stance, then the ground under it), z; ground − stance
  for (let j = 0, i = 0; j < f.length; j += 3, i++) {
    const x = P[j] = e[0] * f[j] + e[4] * f[j + 1] + e[8] * f[j + 2] + e[12], y = P[j + 1] = e[1] * f[j] + e[5] * f[j + 1] + e[9] * f[j + 2] + e[13];
    const z = P[j + 2] = e[2] * f[j] + e[6] * f[j + 1] + e[10] * f[j + 2] + e[14];
    O[i] = ground(x, z) - y;
  }
  const S = _fs.length < n ? (_fs = new Float64Array(n)) : _fs;
  for (let i = 0; i < n; i++) S[i] = O[i];
  const sorted = S.subarray(0, n).sort(), lo2 = sorted[1], mid = (sorted[(n - 1) >> 1] + sorted[n >> 1]) / 2;
  if (!Number.isFinite(lo2) || !Number.isFinite(mid)) return false;
  // as the physics stands
  if (!fitPlane(P, n, 1, () => true)) { plane.b = plane.c = 0; plane.cx = P[0]; plane.cz = P[2]; plane.a = P[1]; }
  const sb = plane.b, sc = plane.c, sa = plane.a, scx = plane.cx, scz = plane.cz;
  // the ground under the contacts (stance y + offset), but those far above the rest
  for (let i = 0; i < n; i++) P[3 * i + 1] += O[i];
  const used = i => O[i] <= mid + entry.reach;
  if (fitPlane(P, n, 1, used) && Math.hypot(plane.b - sb, plane.c - sc) <= TILT_OFF) return true;
  plane.b = sb; plane.c = sc; plane.a = sa + lo2; plane.cx = scx; plane.cz = scz;
  return true;
}
// how far the ground can rise above the bilinear estimate inside each grid cell: for ground made of flat pieces a
// crease in a cell lifts it above the chord by at most the convex second difference at either neighbouring grid point
function rises(entry) {
  const h = entry.gh, at = (i, j) => h[j * GX + i];
  const dz = (i, j) => j > 0 && j < GZ - 1 ? Math.max(0, 2 * at(i, j) - at(i, j - 1) - at(i, j + 1)) : 0;
  const dx = (i, j) => i > 0 && i < GX - 1 ? Math.max(0, 2 * at(i, j) - at(i - 1, j) - at(i + 1, j)) : 0;
  for (let j = 0; j < GZ - 1; j++) for (let i = 0; i < GX - 1; i++) {
    entry.rise[j * (GX - 1) + i] = Math.max(dz(i, j), dz(i, j + 1), dz(i + 1, j), dz(i + 1, j + 1))
      + Math.max(dx(i, j), dx(i + 1, j), dx(i, j + 1), dx(i + 1, j + 1));
  }
}

// model → world with the pivot tilted to (rx, rz)
function pose(out, model, pivot, rx, rz) {
  _e.set(rx, pivot.rotation.y, rz, pivot.rotation.order);
  return out.compose(pivot.position, _q.setFromEuler(_e), pivot.scale).premultiply(model.matrix);
}
// the lowest world y any point in the box can have under matrix m (column-major elements)
function boxLow(m, b) {
  const e = m.elements;
  return e[13] + Math.min(e[1] * b[0], e[1] * b[3]) + Math.min(e[5] * b[1], e[5] * b[4]) + Math.min(e[9] * b[2], e[9] * b[5]);
}
// the highest the ground can be under world (x, z) by the grid: bilinear over the cell it falls in (the grid is an
// affine image of the pivot's level x / z plane) plus that cell's rise; NaN outside the grid
let gox = 0, goz = 0, gux = 0, guz = 0, gwx = 0, gwz = 0, gdet = 1;
function gridGround(entry, x, z) {
  const dx = x - gox, dz = z - goz;
  const u = (dx * gwz - dz * gwx) / gdet, w = (gux * dz - guz * dx) / gdet;      // 0..GX-1, 0..GZ-1
  if (!(u >= 0 && u <= GX - 1 && w >= 0 && w <= GZ - 1)) return NaN;
  const i = Math.min(GX - 2, Math.floor(u)), j = Math.min(GZ - 2, Math.floor(w)), fu = u - i, fw = w - j, h = entry.gh;
  return (h[j * GX + i] * (1 - fu) + h[j * GX + i + 1] * fu) * (1 - fw)
    + (h[(j + 1) * GX + i] * (1 - fu) + h[(j + 1) * GX + i + 1] * fu) * fw + entry.rise[j * (GX - 1) + i];
}

// pivot's rotation.x / .z are the wanted show pose; ground(x, z) = the road height (world). Sets the pivot's rotation
// (scaled back) and position.y (its parked height + any lift up to maxLift), and raises model.position by the rest (all
// of it when far from upright). Returns how far the body was lifted in all (m), 0 normally. exact: landing or tumbling
// (the grid estimate assumes a body over the road, level-ish): every point near the road gets its exact ground.
// maxLift: the most an upright body may be lifted off its wheels (m; car.js: what its springs have left to extend, at
// least bodyLiftCap; bike.js: bodyLiftCap); what's needed beyond it raises model.position too.
export function keepBodyAboveGround(model, pivot, ground, exact = false, dt = 1 / 60, maxLift = Infinity) {
  let entry = cache.get(pivot);
  if (!entry) cache.set(pivot, entry = build(model, pivot));
  pivot.position.y = entry.base;
  if (!ground) { entry.lift = 0; return 0; }
  model.updateMatrix();
  const upY = model.matrix.elements[5], whole = upY < 0.7;
  // Retain the falling envelope before testing clearance, so the final pose (including sideways motion along the
  // model's tilted up) is checked against the ground as usual. Each model owns its history, including remote puppets.
  // Switching to/from a wreck's whole-model lift starts fresh; it uses a different direction and contact surface.
  let retained = entry.whole === whole ? (entry.lift || 0) * Math.exp(-Math.max(0, dt) / FALL_TIME) : 0;
  if (retained < 1e-5) retained = 0;
  let lifted = 0;
  entry.whole = whole;
  // upright, the body is lifted off its wheels up to maxLift; the rest (a ramp's face or a landing under the nose) lifts
  // the whole model, wheels and all, so the suspension is never drawn longer than it is
  const cap = whole ? 0 : Math.max(0, maxLift);
  const lift = need => {
    if (!whole && !exact) need = Math.min(need, UPRIGHT_MAX - lifted);
    if (!(need > 0)) return;
    const body = Math.min(need, Math.max(0, cap - lifted));
    if (body > 0) pivot.position.y += body / upY;
    if (need > body) { model.position.y += need - body; model.updateMatrix(); }
    entry.lift = lifted += need;
  };
  entry.lift = 0;
  lift(retained);
  const rx = pivot.rotation.x, rz = pivot.rotation.z;
  pose(_p1, model, pivot, rx, rz); pose(_p0, model, pivot, 0, 0);
  // driving (not landing or tumbling: then all of it), the ground counts by how far it is above the wheels' plane: in
  // full up to `reach` (and ahead of the front axle or behind the rear one, AHEAD_SLOPE more per m: a ramp's face under
  // the nose), then less (continuous, so a bank coming under the body's edge doesn't pop it), and from twice that not at all
  if (!whole && !exact && entry.feet && wheelPlane(entry, _p0, ground)) {
    const raw = ground, { a, b, c, cx, cz } = plane, reach = entry.reach, [back, front] = entry.axles, e = _p0.elements;
    const fl = Math.hypot(e[8], e[10]) || 1, fx = e[8] / fl, fz = e[10] / fl, oz = (e[14] * fz + e[12] * fx);
    ground = (x, z) => {
      const along = x * fx + z * fz - oz, beyond = Math.max(0, along - front, back - along);
      const g = raw(x, z), over = g - (a + b * (x - cx) + c * (z - cz)) - reach - AHEAD_SLOPE * beyond;
      return over > 0 ? g - 2 * over : g;
    };
  }
  // the coarse ground: GX × GZ exact heights under the level body's footprint
  const [x0, x1, z0, z1] = entry.grid;
  _a.set(x0, 0, z0).applyMatrix4(_p0); gox = _a.x; goz = _a.z;
  _b.set(x0 + (x1 - x0) / (GX - 1), 0, z0).applyMatrix4(_p0); gux = _b.x - gox; guz = _b.z - goz;
  _b.set(x0, 0, z0 + (z1 - z0) / (GZ - 1)).applyMatrix4(_p0); gwx = _b.x - gox; gwz = _b.z - goz;
  gdet = gux * gwz - guz * gwx;
  for (let j = 0; j < GZ; j++) for (let i = 0; i < GX; i++) {
    _a.set(x0 + (x1 - x0) * i / (GX - 1), 0, z0 + (z1 - z0) * j / (GZ - 1)).applyMatrix4(_p0);
    entry.gh[j * GX + i] = ground(_a.x, _a.z);
  }
  rises(entry);
  // nothing near the road at all (the usual case): the body's box, tilted or level, clears the highest the grid allows
  let top = -Infinity;
  for (let i = 0; i < GX * GZ; i++) top = Math.max(top, entry.gh[i]);
  let riseMax = 0;
  for (let i = 0; i < entry.rise.length; i++) riseMax = Math.max(riseMax, entry.rise[i]);
  if (Math.min(boxLow(_p1, entry.box), boxLow(_p0, entry.box)) - top >= (exact ? 1.5 : riseMax + BODY_CLEAR + NEAR)) return lifted;
  // tilted (c1) and level (c0) clearance of each point; the exact ground only where the grid can't rule out the limit.
  // Those points are kept (pivot frame + ground) for the lift. The tilt is scaled by k so no point comes within BODY_CLEAR.
  let k = 1, nc = 0;
  const C = entry.cand, a = _p1.elements, b = _p0.elements, M = _mm.elements;
  for (const s of entry.sets) {
    if (s.exactOnly && !exact) continue;
    const moving = s.root !== pivot;
    if (moving) { _mm.identity(); for (let q = s.root; q && q !== pivot; q = q.parent) { q.updateMatrix(); _mm.premultiply(q.matrix); } }
    const p = s.pts;
    for (let j = 0; j < p.length; j += 3) {
      let x = p[j], y = p[j + 1], z = p[j + 2];
      if (moving) { const X = x, Y = y; x = M[0] * X + M[4] * Y + M[8] * z + M[12]; y = M[1] * X + M[5] * Y + M[9] * z + M[13]; z = M[2] * X + M[6] * Y + M[10] * z + M[14]; }
      const ax = a[0] * x + a[4] * y + a[8] * z + a[12], ay = a[1] * x + a[5] * y + a[9] * z + a[13], az = a[2] * x + a[6] * y + a[10] * z + a[14];
      const by = b[1] * x + b[5] * y + b[9] * z + b[13];
      if (!exact && Math.min(ay, by) - gridGround(entry, ax, az) >= BODY_CLEAR + NEAR) continue;
      const g = ground(ax, az), c1 = ay - g, c0 = by - g;
      if (c1 < BODY_CLEAR) k = Math.min(k, c0 > BODY_CLEAR ? (c0 - BODY_CLEAR) / (c0 - c1) : 0);
      C[nc++] = x; C[nc++] = y; C[nc++] = z; C[nc++] = g;
    }
  }
  pivot.rotation.x = rx * k; pivot.rotation.z = rz * k;
  // what is still too low at that exact pose is lifted: upright (a crest or ramp lip under the body, an arch on a tyre)
  // the body, along the model's up; tumbling, nose- or tail-first or on its roof (the physics box is smaller than the
  // drawn body) the whole model, straight up: it rests on its bodywork
  // Scaling the tilt and lifting along a tilted up move the points sideways too, so each pass looks the ground up again
  // where the points near the road are now, until nothing is left to lift.
  if (!nc) return lifted;
  for (let pass = 0; pass < 4; pass++) {
    pose(_p1, model, pivot, rx * k, rz * k);
    let low = Infinity;
    for (let j = 0; j < nc; j += 4) {
      const x = C[j], y = C[j + 1], z = C[j + 2], wy = a[1] * x + a[5] * y + a[9] * z + a[13];
      if ((k < 1 || pass) && wy - C[j + 3] < BODY_CLEAR + RESAMPLE)
        C[j + 3] = ground(a[0] * x + a[4] * y + a[8] * z + a[12], a[2] * x + a[6] * y + a[10] * z + a[14]);
      low = Math.min(low, wy - C[j + 3]);
    }
    if (!(low < BODY_CLEAR - 1e-4)) break;
    lift(BODY_CLEAR - low);
  }
  return lifted;
}
