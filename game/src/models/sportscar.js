// Sports car: a low, wide wedge in the Huracán / Aventador style (no badges or logos). Local axes: +z forward, +y up,
// +x = the car's left; origin = centre of mass. Flat shaded. Fixed colours are vertex colours (sRGB → linear, as in
// campusmodel.js); the Garage paint roles are materials: body (paint), trim (splitter, skirts, wing, diffuser, blades,
// louvres) and wheels (rims); the type's factory trim is black (vehicletypes.js colors). The body pivot holds a
// THREE.LOD: the near body (~1.7k triangles, ~3k with wheels) and a far one (~650) past FAR_AT metres. Wheels keep the car.js / mp/remotes.js layout: holder (steers) → spin →
// [tyre, rim]; userData.wheelArch[i] = height of the arch above the ground-level body frame where wheel i's tyre top meets it (wheeltravel.js).
import * as THREE from 'three';
import { WHEEL_POS } from '../carmodel.js';

const FAR_AT = 70;
const COL = {
  under: '#0b0c0e', black: '#15161a', mesh: '#2a2c31', glass: '#16222c', lens: '#1b2833', drl: '#eef4ff',
  tail: '#f0202a', tailDark: '#4a0a0e', steel: '#4b4e54', disc: '#6b6e73', caliper: '#d9a300',
};
// wheels: visual track and size (the physics mounts stay where vehicletypes.js puts them)
const WHEEL = { front: { x: .87, r: .37, w: .27 }, rear: { x: .87, r: .395, w: .36 } };
const ARCH_GAP = .115;              // parked tyre top → arch ceiling (arch radius = tyre radius + gap)

const _c = new THREE.Color(), _lin = new Map();
function lin(hex) {
  let v = _lin.get(hex);
  if (!v) { _c.setStyle(hex, THREE.SRGBColorSpace); _lin.set(hex, v = [_c.r, _c.g, _c.b]); }
  return v;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Triangles sorted into paint buckets: 'body', 'trim', or a fixed '#hex' colour (vertex coloured).
class Parts {
  constructor() { this.b = { body: [], trim: [], fixed: [] }; this.col = []; }
  // want: any vector on the side the face should look toward (winding is flipped to match)
  tri(a, b, c, role, want) {
    if (want) {
      const n = cross(sub(b, a), sub(c, a));
      if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) { const t = b; b = c; c = t; }
    }
    const bucket = this.b[role] || this.b.fixed;
    bucket.push(...a, ...b, ...c);
    if (bucket === this.b.fixed) { const k = lin(role); this.col.push(...k, ...k, ...k); }
  }
  quad(a, b, c, d, role, want) { this.tri(a, b, c, role, want); this.tri(a, c, d, role, want); }
  poly(pts, role, want) { for (let i = 1; i < pts.length - 1; i++) this.tri(pts[0], pts[i], pts[i + 1], role, want); }
  // convex polygon (in the two axes other than `axis`) extruded from a0 to a1 along axis 'x' | 'y' | 'z'
  prism(poly, axis, a0, a1, role, capRole = role) {
    const at = ([u, v], a) => axis === 'x' ? [a, v, u] : axis === 'y' ? [u, a, v] : [u, v, a];
    const ax = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];
    const cu = poly.reduce((s, p) => s + p[0], 0) / poly.length, cv = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length], out = at([(p[0] + q[0]) / 2 - cu, (p[1] + q[1]) / 2 - cv], 0);
      this.quad(at(p, a0), at(q, a0), at(q, a1), at(p, a1), role, out);
    }
    const s = Math.sign(a1 - a0);
    this.poly(poly.map(p => at(p, a1)), capRole, ax.map(v => v * s));
    this.poly(poly.map(p => at(p, a0)), role, ax.map(v => -v * s));
  }
  box(x, y, z, w, h, d, role) { this.prism([[z - d / 2, y - h / 2], [z + d / 2, y - h / 2], [z + d / 2, y + h / 2], [z - d / 2, y + h / 2]], 'x', x - w / 2, x + w / 2, role); }
  geometry(key) {
    const p = this.b[key]; if (!p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    if (key === 'fixed') g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
  count() { return (this.b.body.length + this.b.trim.length + this.b.fixed.length) / 9; }
}

// Lofted hull. Each section: { z, pts } with pts = the right half ([x, y] or [x, y, dz]) from the bottom centre round
// to the top centre, counter-clockwise seen from the front, so every quad faces out without fixing (also the flat
// "walls" where two sections share a z: wheel-arch ends). paint(i, k) → role of the quad between sections i, i+1 on
// half-edge k. Returns rings (3D half points) for placing details on the surface with `onHull`.
function loft(parts, sections, paint, { front = 'body', back = 'body' } = {}) {
  const rings = sections.map(s => s.pts.map(([x, y, dz = 0]) => [x, y, s.z + dz]));
  const full = r => [...r, ...r.slice(1, -1).reverse().map(([x, y, z]) => [-x, y, z])];
  const n = rings[0].length;
  for (let i = 0; i < rings.length - 1; i++) {
    const A = full(rings[i]), B = full(rings[i + 1]), m = A.length;
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m, k = j < n - 1 ? j : m - 1 - j;        // mirrored edges share the half-edge index
      const a = A[j], b = B[j], c = B[j2], d = A[j2];
      const role = paint(i, k);
      // the mirrored half splits each quad along the mirrored diagonal, so both sides are the same surface (a decal
      // lifted off a non-flat quad on one side was under the other side's paint: the left headlight)
      if (role && j < n - 1) { parts.tri(a, b, c, role); parts.tri(a, c, d, role); }
      else if (role) { parts.tri(a, b, d, role); parts.tri(b, c, d, role); }
    }
  }
  const cap = (r, role, dir) => {
    if (!role) return;
    const R = full(r), c = R.reduce((s, p) => s.map((v, i) => v + p[i] / R.length), [0, 0, 0]);
    for (let j = 0; j < R.length; j++) parts.tri(c, R[j], R[(j + 1) % R.length], role, [0, 0, dir]);
  };
  cap(rings[0], front, 1); cap(rings.at(-1), back, -1);
  return rings;
}
// a point on hull quad (section i → i+1, half-edge k) at u (along the hull) and v (along the edge), lifted along the
// face normal; side -1 mirrors to the right of the car. Returns [point, normal].
function onHull(rings, i, k, u, v, lift = 0, side = 1) {
  const A0 = rings[i][k], A1 = rings[i][k + 1], B0 = rings[i + 1][k], B1 = rings[i + 1][k + 1];
  const p = lerp(lerp(A0, A1, v), lerp(B0, B1, v), u);
  let n = cross(sub(lerp(B0, B1, v), lerp(A0, A1, v)), sub(lerp(A1, B1, u), lerp(A0, B0, u)));
  if (Math.hypot(...n) < 1e-9) n = [0, 0, rings[i + 1][k][2] < rings[i][k][2] ? -1 : 1];
  n = norm(n);
  const q = p.map((x, j) => x + n[j] * lift);
  return side < 0 ? [[-q[0], q[1], q[2]], [-n[0], n[1], n[2]]] : [q, n];
}
// a flat detail drawn on a hull quad, both sides: uv = [[u, v], ...] convex
function decal(parts, rings, i, k, uv, lift, role, sides = [1, -1]) {
  for (const s of sides) {
    const pts = uv.map(([u, v]) => onHull(rings, i, k, u, v, lift, s)[0]);
    parts.poly(pts, role, onHull(rings, i, k, .5, .5, 0, s)[1]);
  }
}

// ---------------------------------------------------------------- body profile
// key cross sections (right half: bottom centre, floor edge, rocker, lower crease, upper side, shoulder, fender / deck
// edge, bonnet edge, top centre) between the front corners and the tail; stations in between are interpolated. Over
// the front wheels the fenders stand up as ridges (their tops stay above the arch ceilings) round a flat bonnet.
const KEYS = [
  [1.90, [[0, -.25], [.80, -.25], [.95, -.19], [.99, -.04], [1.00, .14], [.97, .44], [.74, .44], [.50, .21], [0, .20]]],
  [1.42, [[0, -.25], [.80, -.25], [.95, -.19], [1.00, -.02], [1.00, .20], [.99, .53], [.72, .53], [.52, .30], [0, .286]]],
  [0.95, [[0, -.25], [.80, -.25], [.94, -.19], [.955, .01], [.99, .24], [.97, .49], [.80, .49], [.56, .38], [0, .37]]],
  [0.20, [[0, -.25], [.80, -.25], [.92, -.19], [.93, .03], [.99, .26], [.97, .43], [.86, .43], [.50, .425], [0, .42]]],
  [-0.30, [[0, -.25], [.80, -.25], [.92, -.19], [.93, .05], [1.00, .30], [.98, .45], [.88, .46], [.50, .45], [0, .44]]],
  [-0.86, [[0, -.25], [.82, -.25], [.95, -.18], [1.03, .04], [1.06, .36], [1.04, .56], [.84, .57], [.48, .565], [0, .56]]],
  [-1.36, [[0, -.24], [.82, -.24], [.96, -.17], [1.05, .06], [1.07, .38], [1.05, .60], [.80, .60], [.46, .592], [0, .585]]],
  [-1.86, [[0, -.20], [.82, -.20], [.96, -.14], [1.04, .08], [1.05, .36], [1.03, .56], [.76, .56], [.44, .552], [0, .545]]],
  [-2.20, [[0, -.12], [.84, -.12], [.95, -.07], [1.00, .10], [1.00, .32], [.97, .46], [.70, .48], [.40, .475], [0, .47]]],
];
function profile(z) {
  let j = 0; while (j < KEYS.length - 2 && z < KEYS[j + 1][0]) j++;
  const [z0, a] = KEYS[j], [z1, b] = KEYS[j + 1], t = Math.min(1, Math.max(0, (z - z0) / (z1 - z0)));
  return a.map((p, i) => lerp(p, b[i], t));
}
// height of the top surface at (x, z): centre → bonnet edge → fender / deck edge
function topY(z, x) {
  const p = profile(z), [e, m, c] = [p[6], p[7], p[8]], ax = Math.abs(x);
  return ax <= m[0] ? c[1] + (m[1] - c[1]) * ax / m[0] : m[1] + (e[1] - m[1]) * Math.min(1, (ax - m[0]) / (e[0] - m[0]));
}
// wheel arch: polygon on a squared-off circle (superellipse) round the parked hub (dz from the wheel centre → ceiling
// height). Squarer than a circle so the tyre's box (wheeltravel.js clamps boxes) clears it while the suspension works.
const ARCH_DZ = [1, .85, .7, .5, .25, 0, -.25, -.5, -.7, -.85, -1], ARCH_DZ_FAR = [1, .8, .3, -.3, -.8, -1];
// squareness n per axle: the front arch stays rounder (a squarer one would poke its liner through the low bonnet)
const ARCH_N = { front: 3.5, rear: 4 };
const archShape = (f, n) => Math.pow(Math.max(0, 1 - Math.pow(Math.abs(f), n)), 1 / n);
function archSections(zc, hub, ra, xIn, dzs = ARCH_DZ, n = ARCH_N.rear) {
  return dzs.map(f => {
    const z = zc + f * ra, p = profile(z), y = hub + ra * archShape(f, n);
    const lip = p[4][0] - .005, top = Math.max(p[4][1], y + .035);
    p[1] = [xIn, p[1][1]]; p[2] = [xIn, y]; p[3] = [lip, y]; p[4] = [p[4][0], top];
    if (p[5][1] < top + .02) p[5] = [p[5][0], top + .02];
    return { z, pts: p, arch: true };
  });
}
// height of the arch polygon above the hub at dz (linear between the sections, as drawn)
function archCeiling(dz, ra, n) {
  const f = Math.max(-1, Math.min(1, dz / ra));
  for (let i = 0; i < ARCH_DZ.length - 1; i++) {
    const a = ARCH_DZ[i], b = ARCH_DZ[i + 1];
    if (f <= a && f >= b) {
      const ya = archShape(a, n), yb = archShape(b, n);
      return ra * (ya + (yb - ya) * (f - a) / (b - a));
    }
  }
  return 0;
}

// far: fewer stations, coarse arches, no side intakes
function bodyHull(parts, hubs, far = false) {
  const [F, R] = hubs;
  const S0 = { z: 2.30, pts: [[0, -.23], [.66, -.23, -.20], [.74, -.20, -.22], [.78, -.13, -.23], [.78, -.07, -.23], [.72, -.03, -.21], [.40, -.01, -.12], [.20, -.005, -.06], [0, 0]] };
  const S1 = { z: 2.10, pts: [[0, -.25], [.80, -.25, -.10], [.93, -.21, -.11], [.98, -.10, -.12], [.99, .00, -.12], [.93, .11, -.11], [.55, .12, -.07], [.30, .115, -.04], [0, .11]] };
  const st = z => ({ z, pts: profile(z) });
  const intake = (z, p3, p4) => { const s = st(z); s.pts[3] = p3; s.pts[4] = p4; s.intake = true; return s; };
  const raF = WHEEL.front.r + ARCH_GAP, raR = WHEEL.rear.r + ARCH_GAP;
  // arch inner walls just inboard of the tyres (front .735, rear .69), under the fender ridges
  const secs = far ? [S0, S1, st(F.z + raF), ...archSections(F.z, F.y, raF, .70, ARCH_DZ_FAR, ARCH_N.front), st(F.z - raF), st(-.30),
    st(R.z + raR), ...archSections(R.z, R.y, raR, .66, ARCH_DZ_FAR), st(R.z - raR), st(-2.20)]
    : [S0, S1, st(F.z + raF), ...archSections(F.z, F.y, raF, .70, ARCH_DZ, ARCH_N.front), st(F.z - raF), st(.55), st(.15), st(-.30),
      intake(-.42, [.92, .10], [.93, .35]), intake(-.74, [.92, .03], [.95, .43]),
      st(R.z + raR), ...archSections(R.z, R.y, raR, .66), st(R.z - raR), st(-2.04), st(-2.20)];
  const arch = i => secs[i].arch && secs[i + 1].arch || secs[i].z === secs[i + 1].z && (secs[i].arch || secs[i + 1].arch);
  const rings = loft(parts, secs, (i, k) => {
    if (k === 0) return COL.under;
    if (arch(i) && k <= 2) return COL.black;
    if (i === 0 && (k === 2 || k === 3)) return COL.black;                  // front corner intakes wrap the nose
    if (k === 1) return i > 2 && secs[i].z < F.z && secs[i + 1].z > R.z ? 'trim' : COL.black;   // side skirts
    if (k === 3 && (secs[i].intake || secs[i + 1].intake)) return COL.black;   // side air intakes
    return 'body';
  }, { front: 'body', back: 'body' });
  return { rings, secs };
}

// Greenhouse: windscreen, roof, side glass, rear glass. Half points: belt, window sill, window top, roof edge, centre.
const CABIN = [
  { z: 1.00, pts: [[.84, .40], [.80, .405], [.66, .395], [.50, .365], [0, .355]] },     // base tucked under the bonnet
  { z: -0.10, pts: [[.88, .42], [.84, .445], [.64, .705], [.50, .748], [0, .757]] },
  { z: -0.62, pts: [[.90, .47], [.86, .50], [.65, .70], [.50, .738], [0, .747]] },
  { z: -1.18, pts: [[.84, .57], [.78, .60], [.56, .625], [.42, .635], [0, .635]] },
];
function cabin(parts) {
  // loft wants bottom centre → top centre: close the ring under the belt line (hidden inside the body)
  const secs = CABIN.map(s => ({ z: s.z, pts: [[0, s.pts[0][1] - .06], [s.pts[0][0] - .02, s.pts[0][1] - .06], ...s.pts] }));
  const rings = loft(parts, secs, (i, k) => {
    if (k < 2) return null;
    if (k === 2) return 'body';                                                  // belt line
    if (i === 0) return COL.glass;                                               // windscreen and front side glass
    if (i === 1) return k === 3 ? COL.glass : 'body';                            // side window, roof
    return k === 3 ? 'body' : COL.glass;                                         // rear buttress, engine glass
  }, { front: null, back: 'body' });
  // A pillars along the windscreen edges and a slim rear quarter window
  decal(parts, rings, 0, 3, [[0, .78], [1, .70], [1, 1], [0, 1]], .004, 'body');
  decal(parts, rings, 0, 4, [[0, 0], [1, 0], [1, .12], [0, .16]], .004, 'body');
  decal(parts, rings, 2, 3, [[0, .18], [.55, .55], [.5, .88], [0, .92]], .004, COL.glass);
  return rings;
}

// ---------------------------------------------------------------- details
function nose(parts, rings) {
  // the front face is V-shaped in plan: z = 2.30 - .295|x|
  const face = (pts, role, lift = .006) => {
    for (const s of [1, -1]) parts.poly(pts.map(([x, y]) => [s * x, y, 2.30 - .295 * x + lift]), role, [s * .29, 0, 1]);
  };
  // big side intakes with two blades, a central intake with a honeycomb hint
  face([[.30, -.215], [.70, -.215], [.765, -.19], [.775, -.12], [.70, -.065], [.40, -.075]], COL.black);
  face([[.33, -.165], [.72, -.165], [.72, -.15], [.33, -.15]], 'trim', .012);
  face([[.36, -.115], [.72, -.115], [.70, -.10], [.38, -.10]], 'trim', .012);
  face([[0, -.215], [.24, -.215], [.27, -.17], [.22, -.12], [0, -.12]], COL.black);
  for (const [x, y] of [[.06, -.17], [.17, -.17]]) face(hexPts(x, y, .035), COL.mesh, .011);
  // headlights on the front slope: a slim angular blade of dark lens (taller at the outer end, u = up the slope,
  // v = inward) with a sideways-Y daytime light
  const blade = [[.12, .03], [.88, .02], [.80, .55], [.68, .96], [.50, .97], [.38, .55]];
  decal(parts, rings, 0, 5, blade, .006, COL.lens);
  for (const [u0, v0, u1, v1, w] of [[.62, .30, .60, .92, .035], [.62, .32, .25, .07, .035], [.62, .32, .84, .06, .035]]) {
    const du = u1 - u0, dv = v1 - v0, l = Math.hypot(du, dv), nu = -dv / l * w, nv = du / l * w;
    decal(parts, rings, 0, 5, [[u0 - nu, v0 - nv], [u1 - nu, v1 - nv], [u1 + nu, v1 + nv], [u0 + nu, v0 + nv]], .011, COL.drl);
  }
  // splitter following the V front
  parts.prism([[0, 2.37], [.82, 2.12], [.95, 2.00], [.95, 1.90], [-.95, 1.90], [-.95, 2.00], [-.82, 2.12]].map(([x, z]) => [x, z]), 'y', -.275, -.245, 'trim');
  // the lit lens (lights.js) covers the blade, above the daytime light; anchor + outline for the left (+x) lamp
  return { at: onHull(rings, 0, 5, .55, .45, .008)[0], outline: blade.map(([u, v]) => onHull(rings, 0, 5, u, v, .008)[0]) };
}
function hexPts(x, y, r, rot = 0) { return [0, 1, 2, 3, 4, 5].map(i => [x + r * Math.cos(rot + i * Math.PI / 3), y + r * Math.sin(rot + i * Math.PI / 3)]); }

function tail(parts) {
  const z = -2.20 - .006, back = (pts, role, lift = 0) => { for (const s of [1, -1]) parts.poly(pts.map(([x, y]) => [s * x, y, z - lift]), role, [0, 0, -1]); };
  // black grille panel with a honeycomb, slim angular Y tail lights along the top edge
  back([[0, -.06], [.90, -.06], [.95, .08], [.92, .27], [0, .27]], COL.black);
  for (let row = 0; row < 3; row++) for (let i = 0; i < 6; i++) {
    const x = .40 + i * .085 + (row % 2) * .042, y = -.01 + row * .085;
    if (x < .88) back(hexPts(x, y, .036, Math.PI / 6), COL.mesh, .004);
  }
  // tail lights: a black band across the top with a red Y at each end and a thin red line toward the middle
  back([[0, .30], [.90, .30], [.975, .345], [.95, .42], [0, .42]], COL.black, .001);
  back([[.30, .352], [.80, .352], [.80, .368], [.30, .368]], COL.tail, .003);
  back([[.76, .345], [.92, .345], [.96, .40], [.90, .41], [.76, .375]], COL.tail, .003);
  back([[.80, .35], [.90, .305], [.945, .32], [.86, .372]], COL.tail, .004);
  back([[.84, .36], [.92, .36], [.925, .385], [.86, .385]], COL.tailDark, .005);
  // hexagonal exhausts in hexagon surrounds, low in the middle
  for (const s of [1, -1]) {
    parts.prism(hexPts(s * .20, .03, .105, Math.PI / 6), 'z', -2.19, -2.215, 'trim');
    parts.prism(hexPts(s * .20, .03, .075, Math.PI / 6), 'z', -2.15, -2.27, COL.steel, COL.under);
  }
  // diffuser: plate and fins under the tail
  parts.prism([[-.86, -2.24], [.86, -2.24], [.86, -1.80], [-.86, -1.80]], 'y', -.165, -.145, 'trim');
  for (const x of [-.62, -.36, 0, .36, .62]) parts.prism([[-2.24, -.21], [-1.82, -.25], [-1.82, -.16], [-2.24, -.15]], 'x', x - .012, x + .012, COL.black);
  // lit lenses (lights.js) for the left (+x) side: the Y at the end, the line toward the middle
  const lens = (at, pts) => ({ at: [...at, z - .006], outline: pts.map(([x, y]) => [x, y, z - .006]) });
  return [lens([.87, .36], [[.76, .345], [.90, .305], [.945, .32], [.96, .40], [.90, .41], [.76, .375]]),
    lens([.55, .36], [[.30, .352], [.80, .352], [.80, .368], [.30, .368]])];
}

function deck(parts) {
  // engine cover: dark recess with louvre slats
  const zs = [-1.24, -1.36, -1.52, -1.70, -1.86, -1.96], xw = .48;
  for (let i = 0; i < zs.length - 1; i++) {
    const a = zs[i], b = zs[i + 1];
    parts.quad([-xw, topY(a, xw) + .004, a], [xw, topY(a, xw) + .004, a], [xw, topY(b, xw) + .004, b], [-xw, topY(b, xw) + .004, b], COL.black, [0, 1, 0]);
  }
  for (let z = -1.30; z > -1.95; z -= .095) {
    const y = topY(z, .3) + .006;
    parts.prism([[z - .02, y], [z + .02, y + .012], [z + .02, y + .035], [z - .02, y + .03]], 'x', -xw + .03, xw - .03, 'body');
  }
  // fixed rear wing on two pylons (Performante style)
  for (const s of [1, -1]) parts.prism([[-1.86, topY(-1.86, .45) - .02], [-1.80, topY(-1.80, .45) - .02], [-1.90, .67], [-1.98, .67]], 'x', s * .45 - .025, s * .45 + .025, COL.black);
  parts.prism([[-1.80, .675], [-1.84, .705], [-2.10, .72], [-2.14, .695]], 'x', -.94, .94, 'trim');
  for (const s of [1, -1]) parts.prism([[-1.76, .62], [-2.18, .62], [-2.18, .76], [-1.86, .75]], 'x', s * .94 - .012, s * .94 + .012, 'trim');
}

function sides(parts, rings, secs) {
  // mirrors on the door tops; intake blade; side-skirt fins ahead of the rear wheels
  for (const s of [1, -1]) {
    parts.prism([[.70, .46], [.84, .455], [.82, .50], [.74, .505]], 'x', s * .86, s * .93, COL.black);
    parts.prism([[.66, .485], [.82, .48], [.84, .55], [.70, .565]], 'x', s * .93, s * 1.06, 'body');
    parts.prism([[.70, .495], [.80, .49], [.80, .545], [.71, .555]], 'x', s * 1.055, s * 1.065, COL.black);
  }
  const i = secs.findIndex(s => s.intake);
  decal(parts, rings, i, 3, [[0, .48], [1, .40], [1, .48], [0, .56]], .01, 'trim');
}

// ---------------------------------------------------------------- far version
function farBody(parts, hubs) {
  const { rings } = bodyHull(parts, hubs, true);
  const cab = CABIN.map(s => ({ z: s.z, pts: [[0, s.pts[0][1] - .06], s.pts[0], s.pts[2], s.pts[4]] }));
  loft(parts, cab, (i, j) => j === 0 ? null : i === 1 && j === 2 ? 'body' : j === 1 && i === 2 ? 'body' : COL.glass, { front: null, back: 'body' });
  for (const s of [1, -1]) {
    const face = pts => parts.poly(pts.map(([x, y]) => [s * x, y, 2.30 - .295 * x + .006]), COL.black, [s * .29, 0, 1]);
    face([[.30, -.215], [.70, -.215], [.775, -.12], [.40, -.075]]); face([[0, -.215], [.24, -.215], [.22, -.12], [0, -.12]]);
    const back = (pts, role) => parts.poly(pts.map(([x, y]) => [s * x, y, -2.206]), role, [0, 0, -1]);
    back([[0, -.06], [.90, -.06], [.92, .27], [0, .27]], COL.black);
    back([[0, .30], [.90, .30], [.975, .345], [.95, .42], [0, .42]], COL.black);
  }
  for (const s of [1, -1]) parts.poly([[s * .30, .352, -2.21], [s * .96, .352, -2.21], [s * .96, .40, -2.21], [s * .30, .368, -2.21]], COL.tail, [0, 0, -1]);
  decal(parts, rings, 0, 5, [[.12, .03], [.88, .02], [.68, .96], [.50, .97]], .006, COL.lens);
  parts.prism([[-1.80, .675], [-2.14, .695], [-2.14, .72], [-1.80, .705]], 'x', -.94, .94, 'trim');
}

// ---------------------------------------------------------------- wheels
function ring(n, r, x, rot = 0) { const out = []; for (let i = 0; i < n; i++) { const a = rot + i * 2 * Math.PI / n; out.push([x, r * Math.cos(a), r * Math.sin(a)]); } return out; }
function band(parts, A, B, role, want) {
  for (let i = 0; i < A.length; i++) { const j = (i + 1) % A.length; parts.quad(A[i], B[i], B[j], A[j], role, want(A[i], A[j])); }
}
function wheelParts(r, w, s) {
  const tyre = new Parts(), rim = new Parts(), N = 16, o = s * w / 2;
  const radial = (a, b) => [0, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], inward = (a, b) => radial(a, b).map(v => -v);
  // tyre: tread, sidewalls to the rim lip, dark wheel well behind the spokes
  band(tyre, ring(N, r, -o), ring(N, r, o), 'body', radial);
  band(tyre, ring(N, r, o), ring(N, r * .80, o + s * .004), 'body', () => [s, 0, 0]);
  band(tyre, ring(N, r, -o), ring(N, r * .62, -o), 'body', () => [-s, 0, 0]);
  tyre.poly(ring(N, r * .73, o - s * .10), 'body', [s, 0, 0]);
  // rim: polished lip, barrel into the dish, five Y spokes, hexagonal centre lock
  const lipX = o + s * .006, dish = o - s * .05;
  band(rim, ring(N, r * .80, lipX), ring(N, r * .73, lipX), 'body', () => [s, 0, 0]);
  band(rim, ring(N, r * .73, lipX), ring(N, r * .73, o - s * .10), 'body', inward);
  const P = (rho, a, x) => [x, rho * r * Math.cos(a), rho * r * Math.sin(a)];
  const xAt = rho => dish + (lipX - dish) * Math.min(1, Math.max(0, (rho - .18) / .55));
  const arm = (r0, a0, r1, a1, hw) => {
    const d = .02, p = [P(r0, a0 - hw / r0, xAt(r0)), P(r1, a1 - hw / r1, xAt(r1)), P(r1, a1 + hw / r1, xAt(r1)), P(r0, a0 + hw / r0, xAt(r0))];
    const back = p.map(q => [q[0] - s * d, q[1], q[2]]);
    rim.poly(p, 'body', [s, 0, 0]);
    for (const [i, j] of [[0, 1], [2, 3]]) { const mid = lerp(p[i], p[j], .5); rim.quad(p[i], p[j], back[j], back[i], 'body', [0, mid[1] - (p[0][1] + p[2][1]) / 2, mid[2] - (p[0][2] + p[2][2]) / 2]); }
  };
  for (let i = 0; i < 5; i++) {
    const a = i * 2 * Math.PI / 5;
    arm(.16, a, .44, a, .055);
    arm(.44, a, .74, a - .20, .035); arm(.44, a, .74, a + .20, .035);
  }
  const hex = ring(6, r * .17, dish + s * .012, Math.PI / 6), hexBack = ring(6, r * .17, dish - s * .02, Math.PI / 6);
  band(rim, hex, hexBack, 'body', radial);
  rim.poly(hex, 'body', [s, 0, 0]);
  return { tyre, rim };
}
function brake(parts, r, w, s) {
  const x = s * (w / 2 - .12);
  parts.prism(ring(10, r * .58, 0).map(p => [p[2], p[1]]), 'x', x - s * .015, x + s * .015, COL.disc);
  parts.prism([[-.42 * r, .30 * r], [-.20 * r, .52 * r], [-.08 * r, .58 * r], [-.30 * r, .36 * r]].map(([z, y]) => [z - .02, y]), 'x', x - s * .045, x + s * .03, COL.caliper);
}

// ---------------------------------------------------------------- model
// p: the type's physics (width, length, mass), suspension: its tuning (restLength, springK) for the parked stance.
export function buildSportsCarModel(p, suspension) {
  const root = new THREE.Group(); root.name = 'car-sports';
  const bodyPivot = new THREE.Group(); root.add(bodyPivot);
  const mat = (color, role, extra = {}) => {
    const m = new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra }); if (role) m.userData.cosmeticRole = role; return m;
  };
  const paint = mat('#e8402f', 'body'), trim = mat('#ffffff', 'trim'), fixed = mat('#ffffff', null, { vertexColors: true });
  const rimMat = mat('#d9dce2', 'wheels'), tyreMat = mat('#1d1e22');
  // parked hub heights: car.js syncMesh at rest (spring holding a quarter of the weight)
  const sag = .3 - suspension.restLength + p.mass * 24 / (4 * suspension.springK);
  const spec = WHEEL_POS.map(([x, y, z, front]) => {
    const W = front ? WHEEL.front : WHEEL.rear;
    return { x: Math.sign(x) * W.x, restY: y, z: z * p.length, front, r: W.r, w: W.w, y: y + sag - (.38 - W.r) };
  });
  const hubs = [spec[0], spec[2]];
  const toMeshes = (parts, parent) => {
    for (const [key, m] of [['body', paint], ['trim', trim], ['fixed', fixed]]) {
      const g = parts.geometry(key); if (!g) continue;
      const mesh = new THREE.Mesh(g, m); mesh.castShadow = true; parent.add(mesh);
    }
  };
  const near = new Parts(), { rings, secs } = bodyHull(near, hubs);
  cabin(near);
  const head = nose(near, rings), tl = tail(near);
  deck(near); sides(near, rings, secs);
  const far = new Parts(); farBody(far, hubs);
  const lod = new THREE.LOD(), nearGroup = new THREE.Group(), farGroup = new THREE.Group();
  nearGroup.name = 'sports-near'; farGroup.name = 'sports-far';
  toMeshes(near, nearGroup); toMeshes(far, farGroup);
  lod.addLevel(nearGroup, 0); lod.addLevel(farGroup, FAR_AT); bodyPivot.add(lod);

  const wheels = [], wheelArch = [];
  for (const W of spec) {
    const s = Math.sign(W.x), holder = new THREE.Group(); holder.position.set(W.x, W.y, W.z); root.add(holder);
    const spin = new THREE.Group(); holder.add(spin);
    const { tyre, rim } = wheelParts(W.r, W.w, s);
    const tm = new THREE.Mesh(tyre.geometry('body'), tyreMat), rm = new THREE.Mesh(rim.geometry('body'), rimMat);
    tm.castShadow = true; spin.add(tm, rm);
    const b = new Parts(); brake(b, W.r, W.w, s); const bm = new THREE.Mesh(b.geometry('fixed'), fixed); holder.add(bm);
    wheels.push({ holder, spin, restY: W.restY, r: W.r, front: W.front });
    // tyre-top ceiling in the body frame (wheeltravel.js): the clamp treats the tyre as a box over its whole footprint,
    // so it is the lowest point of the arch polygon over the tyre's length (minus a 1 cm margin), not a travel
    const ra = W.r + ARCH_GAP; let low = Infinity;
    for (let i = -20; i <= 20; i++) low = Math.min(low, archCeiling(i / 20 * W.r, ra, W.front ? ARCH_N.front : ARCH_N.rear));
    wheelArch.push(+(W.y + low - .01).toFixed(3));
  }
  const side = (s, [x, y, z]) => [s * x, y, z];
  const headLights = [1, -1].map(s => new THREE.Vector3(...side(s, head.at)));
  const tailLights = tl.flatMap(t => [1, -1].map(s => new THREE.Vector3(...side(s, t.at))));
  const lens = { head: [1, -1].map(s => head.outline.map(p => side(s, p))), tail: tl.flatMap(t => [1, -1].map(s => t.outline.map(p => side(s, p)))) };
  root.userData = { bodyPivot, wheels, wheelArch, lightMount: bodyPivot, lights: { head: headLights, tail: tailLights, lens },
    blob: [2.15, 4.6], lod, nearTriangles: near.count(), farTriangles: far.count(),
    // livery decals sit on the flat middle of the bonnet
    decalPanels: [[.5, .5, 0, .296, 1.40, -Math.PI / 2 + .177]] };
  return root;
}
