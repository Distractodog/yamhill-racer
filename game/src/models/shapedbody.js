// Kit for the shaped road-car bodies (models/hatch.js, models/suv.js). Local axes as carmodel.js: +z forward, +y up,
// +x = the car's left. The body is a loft of cross-section rings from nose to tail with real wheel-arch cut-outs; lamps,
// grille, door lines and trim are flat overlay panels a few millimetres proud of it. Flat shaded. Fixed colours are
// sRGB hex turned into linear vertex colours (as campusmodel.js does); the Garage paint roles (body / trim / wheels)
// get their own materials tagged with cosmeticRole, so cosmetics.js repaints them.
import * as THREE from 'three';

const _c = new THREE.Color(), _lin = new Map();
// sRGB hex → linear rgb (THREE.Color converts sRGB input into the linear working space)
const lin = hex => { let v = _lin.get(hex); if (!v) { _c.set(hex); _lin.set(hex, v = [_c.r, _c.g, _c.b]); } return v; };
const ROLES = ['body', 'trim', 'wheels'];

// Triangle soup sorted by colour: a paint role ('body' | 'trim' | 'wheels') or an sRGB hex (fixed vertex colour).
export class Shape {
  constructor() { this.role = { body: [], trim: [], wheels: [] }; this.p = []; this.c = []; }
  // one triangle; `want` = any vector on the side it should face (winding is flipped to match)
  tri(a, b, c, col, want) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-12) return;              // collapsed band: skip
    if (want && nx * want[0] + ny * want[1] + nz * want[2] < 0) { const t = b; b = c; c = t; }
    const r = this.role[col];
    if (r) { r.push(...a, ...b, ...c); return; }
    const k = lin(col); this.p.push(...a, ...b, ...c); for (let i = 0; i < 3; i++) this.c.push(k[0], k[1], k[2]);
  }
  quad(a, b, c, d, col, want) { this.tri(a, b, c, col, want); this.tri(a, c, d, col, want); }
  poly(pts, col, want) { for (let i = 1; i < pts.length - 1; i++) this.tri(pts[0], pts[i], pts[i + 1], col, want); }
  // a three.js geometry (already facing outward), moved by `matrix`
  geo(g, col, matrix = null) {
    const src = g.index ? g.toNonIndexed() : g; if (matrix) src.applyMatrix4(matrix);
    const a = src.attributes.position.array;
    for (let i = 0; i < a.length; i += 9) this.tri([a[i], a[i + 1], a[i + 2]], [a[i + 3], a[i + 4], a[i + 5]], [a[i + 6], a[i + 7], a[i + 8]], col);
    if (src !== g) src.dispose(); g.dispose();
  }
  // axis-aligned box (centre, size), optionally pitched by rx about its centre
  box(x, y, z, w, h, d, col, rx = 0) {
    const m = new THREE.Matrix4().makeRotationX(rx).setPosition(x, y, z);
    this.geo(new THREE.BoxGeometry(w, h, d), col, m);
  }
  // the same box on both sides (x and -x)
  pair(x, y, z, w, h, d, col, rx = 0) { this.box(x, y, z, w, h, d, col, rx); this.box(-x, y, z, w, h, d, col, rx); }
  // both sides of a polygon given for +x (mirrored copy faces -x)
  mirror(pts, col, want) { this.poly(pts, col, want); this.poly(pts.map(([x, y, z]) => [-x, y, z]), col, [-want[0], want[1], want[2]]); }
  triangles() { return (this.p.length + ROLES.reduce((n, r) => n + this.role[r].length, 0)) / 9; }
  // one mesh per paint role in use plus one vertex-coloured mesh; mats = { body, trim, wheels, fixed }
  meshes(mats) {
    const out = [];
    const make = (p, mat, c) => {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      if (c) g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
      g.computeVertexNormals();           // not indexed: every triangle keeps its own face normal (flat shading)
      const m = new THREE.Mesh(g, mat); m.castShadow = true; out.push(m);
    };
    for (const r of ROLES) if (this.role[r].length) make(this.role[r], mats[r]);
    if (this.p.length) make(this.p, mats.fixed, this.c);
    return out;
  }
}

export function materials(rim) {
  const role = (color, r) => { const m = new THREE.MeshLambertMaterial({ color, flatShading: true }); m.userData.cosmeticRole = r; return m; };
  return { body: role('#e8402f', 'body'), trim: role('#ffffff', 'trim'), wheels: rim,
    fixed: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }) };
}

// ---- lofted body ------------------------------------------------------------------------------------------------
// Key stations (nose first, z falling), each { z, floor, xWell, xSill, xMax, lip, mid, sh, xB, yB, xG, yG, xR, yR, yC };
// stations in between are interpolated. Half ring, from the floor centre round the +x side to the roof centre:
//  0 (0, floor)  1 (xWell, floor)  2 (xWell, low)  3 (xSill, low)      floor, wheel-well wall, arch roof
//  4 (xMax, low + lip)  5 (xMax, mid)  6 (xMax, sh)                      body side: lower band, upper (lamp) band
//  7 (xB, yB) belt  8 (xG, yG) glass top  9 (xR, yR) roof edge  10 (0, yC) roof centre
// low = the floor, or the wheel-arch circle where it is higher. Ahead of the windscreen / behind the rear glass points
// 7–10 lie on the bonnet / tailgate top. Bands k (point k → k+1) are coloured by colour(k, zFront, zBack, i, last).
// blister = { out, reach }: the body side (points 3–6) swells out by `out` over each wheel arch and blends back to the
// key width over `reach` either side (blistered arches: the wide physics track looks meant, not boxed in). Optional
// steps = where along the blend extra stations go (0..1; fewer = cheaper, e.g. [1] for a far version).
const FIELDS = ['floor', 'xWell', 'xSill', 'xMax', 'lip', 'mid', 'sh', 'xB', 'yB', 'xG', 'yG', 'xR', 'yR', 'yC'];
export function loft(shape, { keys, arches, cuts = [], archSteps = 9, colour, cap = 'body', blister = null }) {
  const swell = z => {
    let s = 0;
    for (const a of arches) {
      const d = Math.abs(z - a.z) - a.r - .02;
      s = Math.max(s, d <= 0 ? 1 : d >= blister.reach ? 0 : .5 + .5 * Math.cos(Math.PI * d / blister.reach));
    }
    return s * blister.out;
  };
  const at = z => {
    let i = 0; while (i < keys.length - 2 && z < keys[i + 1].z) i++;
    const a = keys[i], b = keys[i + 1], t = THREE.MathUtils.clamp((a.z - z) / (a.z - b.z), 0, 1), f = { z };
    for (const k of FIELDS) f[k] = a[k] + (b[k] - a[k]) * t;
    if (blister) { const s = swell(z); f.xMax += s; f.xSill += s; }
    return f;
  };
  // arch = { z, y (circle centre), r }: an upper semicircle with straight legs down to the floor at z ± r
  const low = (z, f = at(z)) => {
    let y = f.floor;
    for (const a of arches) { const d = z - a.z; if (Math.abs(d) <= a.r) y = Math.max(y, a.y + Math.sqrt(a.r * a.r - d * d)); }
    return y;
  };
  const zs = [...keys.map(k => k.z), ...cuts];
  for (const a of arches) {
    zs.push(a.z + a.r + .003, a.z - a.r - .003);
    for (let i = 0; i < archSteps; i++) zs.push(a.z + a.r * Math.cos(Math.PI * i / (archSteps - 1)));
    if (blister) for (const k of blister.steps || [0, .35, .7, 1]) zs.push(a.z + a.r + .02 + k * blister.reach, a.z - a.r - .02 - k * blister.reach);
  }
  const zmax = Math.max(...keys.map(k => k.z)), zmin = Math.min(...keys.map(k => k.z));
  for (let i = zs.length - 1; i >= 0; i--) if (zs[i] > zmax || zs[i] < zmin) zs.splice(i, 1);
  zs.sort((a, b) => b - a);
  const stations = zs.filter((z, i) => i === 0 || zs[i - 1] - z > 1e-3);
  const ring = z => {
    const f = at(z), y = low(z, f), y4 = y + f.lip, y5 = Math.max(f.mid, y4), y6 = Math.max(f.sh, y5);
    const half = [[0, f.floor], [f.xWell, f.floor], [f.xWell, y], [f.xSill, y], [f.xMax, y4], [f.xMax, y5], [f.xMax, y6],
      [f.xB, f.yB], [f.xG, f.yG], [f.xR, f.yR], [0, f.yC]];
    const r = half.map(([x, yy]) => [x, yy, z]);
    for (let k = 9; k >= 1; k--) r.push([-half[k][0], half[k][1], z]);
    return r;
  };
  const rings = stations.map(ring), last = rings.length - 2;
  for (let i = 0; i <= last; i++) {
    const A = rings[i], B = rings[i + 1];
    for (let k = 0; k < 20; k++) {
      const k2 = (k + 1) % 20, col = colour(k < 10 ? k : 19 - k, stations[i], stations[i + 1], i, last);
      shape.tri(A[k], B[k], B[k2], col); shape.tri(A[k], B[k2], A[k2], col);     // ring order makes these face out
    }
  }
  for (const [R, want] of [[rings[0], [0, 0, 1]], [rings.at(-1), [0, 0, -1]]]) {
    const c = [0, R.reduce((s, p) => s + p[1], 0) / R.length, R[0][2]];
    for (let k = 0; k < 20; k++) shape.tri(c, R[k], R[(k + 1) % 20], typeof cap === 'function' ? cap(want[2]) : cap, want);
  }
  return { at, low, stations, nose: stations[0], tail: stations.at(-1) };
}

// Flared lip round each wheel arch on both sides (up the front leg, over the top, down the rear leg): t = how far it
// stands out from the side, w = its width away from the opening.
export function archFlares(shape, body, arch, { t, w, col, steps = 10, inner = '#202328' }) {
  const path = [], bottom = z => body.at(z).floor + .03;
  path.push([arch.z + arch.r, bottom(arch.z + arch.r), 1, 0]);
  for (let i = 0; i <= steps; i++) { const th = Math.PI * i / steps; path.push([arch.z + arch.r * Math.cos(th), arch.y + arch.r * Math.sin(th), Math.cos(th), Math.sin(th)]); }
  path.push([arch.z - arch.r, bottom(arch.z - arch.r), -1, 0]);
  for (const side of [1, -1]) {
    let prev = null;
    path.forEach(([z, y, nz, ny], i) => {
      const xm = body.at(z).xMax, P = (x, k) => [side * x, y + k * ny, z + k * nz];
      const cur = [P(xm - .05, 0), P(xm + t, 0), P(xm + t * .55, w * .55), P(xm + .004, w)];
      if (prev) {
        shape.quad(prev[0], prev[1], cur[1], cur[0], inner, [0, -ny, -nz]);                      // lip underside
        shape.quad(prev[3], prev[0], cur[0], cur[3], inner, [-side, 0, 0]);                      // inner side (closes the lip)
        shape.quad(prev[1], prev[2], cur[2], cur[1], col, [side, ny * .3, nz * .3]);             // lip face
        shape.quad(prev[2], prev[3], cur[3], cur[2], col, [side, ny, nz]);                       // blend onto the panel
      }
      if (i === 0) shape.poly(cur, col, [0, -1, 0]);
      if (i === path.length - 1) shape.poly(cur, col, [0, -1, 0]);
      prev = cur;
    });
  }
}

// Panels on the flat nose / tail faces (the loft caps). layer = millimetre-ish steps proud of the face, so stacked
// panels don't fight. pts are [x, y]; `pair` draws the +x shape and its mirror.
export const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
export const oct = (cx, cy, r) => Array.from({ length: 8 }, (_, i) => [cx + r * Math.cos((i + .5) * Math.PI / 4), cy + r * Math.sin((i + .5) * Math.PI / 4)]);
export function endPanels(shape, body) {
  const face = (z, dir) => {
    const at = (layer, pts) => pts.map(([x, y]) => [x, y, z + dir * .004 * layer]);
    return {
      one: (layer, pts, col) => shape.poly(at(layer, pts), col, [0, 0, dir]),
      pair: (layer, pts, col) => shape.mirror(at(layer, pts), col, [0, 0, dir]),
    };
  };
  return { front: face(body.nose, 1), rear: face(body.tail, -1) };
}
// userData.lights for lamps drawn with endPanels: head / tail = { at: [x, y], pts: [[x, y], …] } for the +x lamp, its
// lit lens (lights.js) on layer `layers[0]` / `[1]` (just above the lamp's own detail panels); both sides
export function panelLights(body, head, tail, layers) {
  const lamps = (z, { at, pts }) => [1, -1].map(s => ({
    at: new THREE.Vector3(s * at[0], at[1], z), outline: pts.map(([x, y]) => [s * x, y, z]) }));
  const h = lamps(body.nose + .004 * layers[0], head), t = lamps(body.tail - .004 * layers[1], tail);
  return { head: h.map(l => l.at), tail: t.map(l => l.at), lens: { head: h.map(l => l.outline), tail: t.map(l => l.outline) } };
}

// Panels lying on the flat body side (x = xMax(z)), split at the stations so they follow the side's facets.
export function sidePanel(shape, body, z0, z1, y0, y1, col, off = .004, sides = [1, -1]) {
  const cut = [z0, ...body.stations.filter(z => z < z0 && z > z1), z1];
  for (const s of sides) for (let i = 0; i < cut.length - 1; i++) {
    const za = cut[i], zb = cut[i + 1], xa = s * (body.at(za).xMax + off), xb = s * (body.at(zb).xMax + off);
    shape.quad([xa, y0, za], [xb, y0, zb], [xb, y1, zb], [xa, y1, za], col, [s, 0, 0]);
  }
}
// Side skirt along the sill from z0 to z1 (z0 > z1): a straight outer face at half-width xo (never inside the side),
// bevelled along its top edge, so it runs flush from one arch blister to the other.
export function sideSkirt(shape, body, z0, z1, y0, y1, xo, col) {
  const cut = [z0, ...body.stations.filter(z => z < z0 && z > z1), z1], bevel = Math.min(.03, (y1 - y0) / 3);
  for (const s of [1, -1]) {
    const sec = z => {
      const x = body.at(z).xMax, o = Math.max(x + .004, xo);
      return [[s * (x - .01), y0, z], [s * o, y0, z], [s * o, y1 - bevel, z], [s * (x + (o - x) * .4), y1, z], [s * (x - .01), y1, z]];
    };
    for (let i = 0; i < cut.length - 1; i++) {
      const A = sec(cut[i]), B = sec(cut[i + 1]);
      shape.quad(A[0], A[1], B[1], B[0], col, [0, -1, 0]);
      shape.quad(A[1], A[2], B[2], B[1], col, [s, 0, 0]);
      shape.quad(A[2], A[3], B[3], B[2], col, [s, 1, 0]);
      shape.quad(A[3], A[4], B[4], B[3], col, [0, 1, 0]);
    }
    shape.poly(sec(z0), col, [0, 0, 1]); shape.poly(sec(z1), col, [0, 0, -1]);
  }
}

// thin vertical shut line on the side, from just above the sill / arch to just below the belt
export function doorLine(shape, body, z, col = '#2a1c1c', top = null) {
  const f = body.at(z), y0 = body.low(z) + f.lip + .015, y1 = top ?? f.yB - .02;
  sidePanel(shape, body, z + .007, z - .007, y0, y1, col);
}

// ---- wheels -----------------------------------------------------------------------------------------------------
// Tyre (rounded tread + sidewalls, dark wheel face behind the spokes) and rim (lip, hub, spokes), outer face toward
// +x (side 1) or -x (side -1). Returns geometries for spin.children[0] (tyre) and [1] (rim: the Garage 'wheels' paint).
export function wheelGeometry(r, width, { rimR = r * .64, spokes = 5, segs = 16, side = 1, spokeW = .05 } = {}) {
  const hw = width / 2, V = (a, b) => new THREE.Vector2(a, b);
  const lathe = (pts, n = segs) => new THREE.LatheGeometry(pts, n).toNonIndexed();
  // lathe turns about +y: profile points (radius, axial). Order makes the surfaces face outward.
  const tyreParts = [
    lathe([V(rimR, -hw + .02), V(r - .045, -hw), V(r, -hw + .05), V(r, hw - .05), V(r - .045, hw), V(rimR, hw - .02)]),
    lathe([V(rimR, hw - .02), V(rimR * .84, hw - .072), V(.001, hw - .075)]),   // dark face behind the spokes
    lathe([V(.001, -hw + .02), V(rimR, -hw + .02)]),                          // inner side, closed
  ];
  const rimParts = [
    lathe([V(rimR * 1.015, hw - .005), V(rimR * .88, hw - .03), V(rimR * .86, hw - .07)]),  // rim lip
    lathe([V(rimR * .2, hw - .06), V(rimR * .2, hw - .012), V(rimR * .08, hw - .004), V(.001, hw - .004)], 8),
  ];
  for (let i = 0; i < spokes; i++) {
    const a = i / spokes * Math.PI * 2, len = rimR * .7, g = new THREE.BoxGeometry(spokeW, len, .025).toNonIndexed();
    // box in the wheel face plane (axial = y here, so the spoke runs in x/z), tapered back toward the face
    g.rotateX(Math.PI / 2).translate(0, hw - .03, 0); g.translate(0, 0, rimR * .18 + len / 2); g.rotateY(a);
    rimParts.push(g);
  }
  const join = parts => {
    const pos = [];
    for (const g of parts) { pos.push(...g.attributes.position.array); g.dispose(); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.rotateZ(-Math.PI / 2);               // lathe axis +y → +x (outer face)
    if (side < 0) g.rotateY(Math.PI);
    g.computeVertexNormals(); return g;
  };
  return { tyre: join(tyreParts), rim: join(rimParts) };
}

// Wheels at the physics mounts (carmodel.js WHEEL_POS scaled by the type), sat at the parked suspension stance.
// Returns userData.wheels entries { holder, spin, restY, r, front, hubWidth } (hubWidth: the Garage hub / disc wheel
// styles, cosmetics.js, sized to these tyres).
export function buildWheels(root, wheelPos, p, suspension, tyreMat, rimMat, opts) {
  const stance = .3 - suspension.restLength + p.mass * 24 / (4 * suspension.springK);
  return wheelPos.map(([x, y, z, front]) => {
    const holder = new THREE.Group(); holder.position.set(x * p.width, y + stance, z * p.length); root.add(holder);
    const spin = new THREE.Group(); holder.add(spin);
    const g = wheelGeometry(p.radius, opts.width, { ...opts, side: Math.sign(x) });
    const tyre = new THREE.Mesh(g.tyre, tyreMat), rim = new THREE.Mesh(g.rim, rimMat);
    tyre.castShadow = true; spin.add(tyre, rim);
    return { holder, spin, restY: y, r: p.radius, front, hubWidth: opts.width + .01 };
  });
}

// Near / far detail: two groups under one LOD in the body pivot (each group's meshes stay separate for mp/remotes.js
// bakeParts, which merges per group).
export function lodBody(bodyPivot, near, far, distance = 70) {
  const lod = new THREE.LOD(); lod.name = 'body-lod';
  const group = (meshes, name) => { const g = new THREE.Group(); g.name = name; g.add(...meshes); return g; };
  lod.addLevel(group(near, 'body-near'), 0); lod.addLevel(group(far, 'body-far'), distance);
  bodyPivot.add(lod); return lod;
}
