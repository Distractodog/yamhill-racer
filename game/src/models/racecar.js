// Race car (the default car type): a modern open-wheel single-seater, no logos. Long low nose on a multi-element
// front wing with endplates, monocoque with a halo over the cockpit and the driver's helmet, sculpted sidepods with
// intakes and an undercut, airbox and engine cover with a shark fin, floor with fences and a diffuser, a rear wing with
// endplates and a DRS flap on a central pylon, a beam wing, the rear crash structure with the rain light, mirrors, and
// exposed wishbones, push / pull rods and track rods to each wheel. Local axes as carmodel.js: +z forward, +y up,
// +x = the car's left; origin = centre of mass. Flat shaded.
// Paint: one vertex-coloured body mesh per detail level. cosmetics.js repaints the vertices whose colour is exactly a
// race-car palette colour: PAINT → Garage body, TRIM → trim, HELMET → helmet; rims (wheel spin.children[1]) are the
// wheels colour. Every other colour here is fixed and must stay off those three.
// The body pivot holds a THREE.LOD (shapedbody.js lodBody): near (~2.2k triangles; ~4.3k with the wheels) and far
// (~0.85k) past FAR_AT metres. The suspension arms are the last vertices of the near body mesh, a block per wheel
// hinged on the chassis: userData.linkage.update() (called by car.js syncMesh, so remote puppets too) swings each block
// to its wheel. Wheels keep the car.js / mp/remotes.js layout: holder (steers) → spin → [tyre, rim, sidewall marks].
// userData.wheelArch = tyre-top ceilings in the body frame (wheeltravel.js). Lowest bodywork ~11 cm off the road, so
// bodyclearance.js keeps the full roll / dive on flat ground; keep the front wing and the lenses (lights.js) that high.
import * as THREE from 'three';
import { Shape, lodBody } from './shapedbody.js';
import { measureWheelArch } from '../wheeltravel.js';

export const FAR_AT = 70;
// the suspension arms' limits: swing about the chassis hinge (rad) and stretch along themselves (× their built length)
export const ARM_SWING = 0.6, ARM_STRETCH = 1.2;
// Garage palette (cosmetics.js matches these exact vertex colours) and the fixed colours
export const PAINT = '#e8402f', TRIM = '#ffffff', HELMET = '#ffd23a';
const CARBON = '#1b1c20', CARBON2 = '#2a2c31', DARK = '#0b0c0e', VISOR = '#1c2a3a', MIRROR = '#5a6b78',
  STEEL = '#8d9297', RAIN = '#b3121c', LAMP = '#e4ebf0', STRIPE = '#f2c41a', NUT = '#2e3034';
// parked stance: car.js syncMesh at rest with TUNING_DEFAULTS (restLength .42, springK 60000) and the 900 kg car:
// hub = WHEEL_POS y + .3 - (restLength - mass·24 / 4k) - (.38 - r)
export const STANCE = .3 - .42 + 900 * 24 / (4 * 60000);
const PHYS_R = .38;

const lerp = (a, b, t) => a + (b - a) * t;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const centre = r => r.reduce((c, p) => [c[0] + p[0] / r.length, c[1] + p[1] / r.length, c[2] + p[2] / r.length], [0, 0, 0]);
const mx = p => [-p[0], p[1], p[2]];

// ---------------------------------------------------------------- generic pieces
// Closed rings (same point count) lofted in order; colour(i, k) → colour of band k between rings i and i+1 (null =
// skip). Faces are turned away from the rings' centres; caps (convex) face away from the neighbouring ring.
function loft(s, rings, colour, { start = null, end = null } = {}) {
  const C = rings.map(centre), n = rings[0].length;
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i], B = rings[i + 1], c = C[i].map((v, j) => (v + C[i + 1][j]) / 2);
    for (let k = 0; k < n; k++) {
      const col = colour(i, k); if (!col) continue;
      const k2 = (k + 1) % n, m = centre([A[k], B[k], B[k2], A[k2]]);
      s.quad(A[k], B[k], B[k2], A[k2], col, sub(m, c));
    }
  }
  if (start) s.poly(rings[0], start, sub(C[0], C[1]));
  if (end) s.poly(rings.at(-1), end, sub(C.at(-1), C.at(-2)));
}
// convex polygon in (z, y) extruded across x from x0 to x1
function plateX(s, pts, x0, x1, col, capCol = col) {
  const R = [pts.map(([z, y]) => [x0, y, z]), pts.map(([z, y]) => [x1, y, z])];
  const c = centre(R[0]);
  for (let k = 0; k < pts.length; k++) {
    const k2 = (k + 1) % pts.length, m = centre([R[0][k], R[0][k2]]);
    s.quad(R[0][k], R[1][k], R[1][k2], R[0][k2], col, [0, m[1] - c[1], m[2] - c[2]]);
  }
  s.poly(R[0], capCol, [Math.sign(x0 - x1), 0, 0]); s.poly(R[1], capCol, [Math.sign(x1 - x0), 0, 0]);
}
// convex polygon in (x, z) extruded from y0 up to y1
function plateY(s, pts, y0, y1, col, topCol = col) {
  const lo = pts.map(([x, z]) => [x, y0, z]), hi = pts.map(([x, z]) => [x, y1, z]), c = centre(lo);
  for (let k = 0; k < pts.length; k++) {
    const k2 = (k + 1) % pts.length, m = centre([lo[k], lo[k2]]);
    s.quad(lo[k], hi[k], hi[k2], lo[k2], col, [m[0] - c[0], 0, m[2] - c[2]]);
  }
  s.poly(hi, topCol, [0, 1, 0]); s.poly(lo, col, [0, -1, 0]);
}
// a straight bar from a to b, w wide (across, kept level) and h thick: suspension arms, rods, stalks
function rod(s, a, b, w, h, col) {
  const d = norm(sub(b, a)), across = Math.abs(d[1]) > .95 ? [1, 0, 0] : norm(cross(d, [0, 1, 0])), up = cross(across, d);
  const corner = (p, i, j) => [p[0] + across[0] * i * w / 2 + up[0] * j * h / 2, p[1] + across[1] * i * w / 2 + up[1] * j * h / 2, p[2] + across[2] * i * w / 2 + up[2] * j * h / 2];
  const ring = p => [corner(p, -1, -1), corner(p, 1, -1), corner(p, 1, 1), corner(p, -1, 1)];
  loft(s, [ring(a), ring(b)], () => col, { start: col, end: col });
}
// a tube of n sides along a path (halo)
function tube(s, path, r, col, n = 6) {
  const rings = path.map((p, i) => {
    const t = norm(sub(path[Math.min(i + 1, path.length - 1)], path[Math.max(i - 1, 0)]));
    const a = Math.abs(t[1]) > .9 ? norm(cross(t, [1, 0, 0])) : norm(cross(t, [0, 1, 0])), b = cross(a, t);
    return Array.from({ length: n }, (_, k) => {
      const th = (k + .5) / n * Math.PI * 2, c = Math.cos(th) * r, d = Math.sin(th) * r;
      return [p[0] + a[0] * c + b[0] * d, p[1] + a[1] * c + b[1] * d, p[2] + a[2] * c + b[2] * d];
    });
  });
  // turn each band away from the path (not the ring centroid, which the bend pulls inward)
  for (let i = 0; i < rings.length - 1; i++) for (let k = 0; k < n; k++) {
    const A = rings[i], B = rings[i + 1], k2 = (k + 1) % n, pm = centre([path[i], path[i + 1]]);
    s.quad(A[k], B[k], B[k2], A[k2], col, sub(centre([A[k], B[k], B[k2], A[k2]]), pm));
  }
  s.poly(rings[0], col, sub(path[0], path[1])); s.poly(rings.at(-1), col, sub(path.at(-1), path.at(-2)));
}
// wing element: an inverted aerofoil (chord c, trailing edge raised by aoa) lofted across span stations
// { x, y, z (leading edge), c, aoa }, flat ends capped
const FOIL = [[0, 0], [.12, -.55], [.55, -.45], [1, 0], [.6, .3], [.15, .4]];
function wing(s, stations, t, col) {
  const ring = ({ x, y, z, c, aoa }) => {
    const dz = -Math.cos(aoa), dy = Math.sin(aoa), nz = Math.sin(aoa), ny = Math.cos(aoa);
    return FOIL.map(([u, v]) => [x, y + u * c * dy + v * t * c * ny, z + u * c * dz + v * t * c * nz]);
  };
  loft(s, stations.map(ring), () => col, { start: col, end: col });
}
// a mesh's own triangles (already facing out), coloured per face: pick(centroid, normal) → colour
function geoBy(s, g, pick, matrix) {
  const src = g.index ? g.toNonIndexed() : g; if (matrix) src.applyMatrix4(matrix);
  const p = src.attributes.position.array, A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3();
  for (let i = 0; i < p.length; i += 9) {
    A.fromArray(p, i); B.fromArray(p, i + 3); C.fromArray(p, i + 6);
    N.subVectors(B, A).cross(C.clone().sub(A)).normalize();
    s.tri(A.toArray(), B.toArray(), C.toArray(), pick(A.clone().add(B).add(C).divideScalar(3), N));
  }
  if (src !== g) src.dispose(); g.dispose();
}

// ---------------------------------------------------------------- monocoque, nose and engine cover
// Section: z, w (half width), bw (flat bottom half width), yb (bottom), ym (widest), yt (top), tw (flat top half
// width). Half ring from the bottom centre round the +x side to the top centre: the top between ±tw is flat (decals,
// cockpit opening and stripes lie on it exactly).
const S = (z, w, bw, yb, ym, yt, tw) => ({ z, w, bw, yb, ym, yt, tw });
// the nose top is straight from z 2.0 to 1.2 (the livery panel), the cockpit opening runs from z .47 to -.27
const TUB = [
  S(2.47, .06, .045, -.325, -.285, -.235, .03),
  S(2.30, .095, .07, -.32, -.265, -.17, .055),
  S(2.00, .135, .10, -.33, -.21, -.09, .08),
  S(1.60, .175, .13, -.32, -.14, -.01, .10),
  S(1.20, .21, .15, -.32, -.07, .07, .12),
  S(0.85, .25, .17, -.33, .00, .15, .14),
  S(0.55, .29, .20, -.33, .06, .22, .165),
  S(0.15, .31, .22, -.33, .08, .25, .20),
  S(-0.30, .32, .22, -.33, .08, .27, .20),
  S(-0.70, .30, .20, -.33, .06, .26, .16),
  S(-1.20, .24, .16, -.32, .02, .22, .12),
  S(-1.60, .17, .12, -.30, -.02, .16, .09),
  S(-1.95, .12, .09, -.28, -.05, .10, .07),
];
const TUB_FAR = [0, 2, 4, 6, 8, 10, 12].map(i => TUB[i]);
const COVER = [            // airbox and engine cover: narrow top over a body buried in the tub
  S(-0.22, .13, .13, .20, .36, .48, .045),
  S(-0.40, .16, .16, .20, .34, .51, .04),
  S(-0.80, .22, .22, .15, .26, .41, .04),
  S(-1.30, .19, .19, .10, .18, .27, .04),
  S(-1.75, .13, .13, .05, .12, .18, .035),
  S(-1.98, .09, .09, .02, .07, .11, .03),
];
const COVER_FAR = [0, 1, 3, 5].map(i => COVER[i]);
function half({ w, bw, yb, ym, yt, tw }) {
  return [[0, yb], [bw, yb], [w, yb + (ym - yb) * .55], [w, ym], [w - (w - tw) * .4, ym + (yt - ym) * .72], [tw, yt], [0, yt]];
}
function ring(sec) {
  const h = half(sec), r = h.map(([x, y]) => [x, y, sec.z]);
  for (let k = h.length - 2; k >= 1; k--) r.push([-h[k][0], h[k][1], sec.z]);
  return r;
}
// a section between the key ones (z falling along the list)
function at(secs, z) {
  let i = 0; while (i < secs.length - 2 && z < secs[i + 1].z) i++;
  const a = secs[i], b = secs[i + 1], t = THREE.MathUtils.clamp((a.z - z) / (a.z - b.z), 0, 1), o = { z };
  for (const k of Object.keys(a)) if (k !== 'z') o[k] = lerp(a[k], b[k], t);
  return o;
}
// band of the half ring (0 bottom … 5 top) for full-ring band k (12 bands)
const halfBand = k => k < 6 ? k : 11 - k;
// a flat overlay on a section list's flat top (y = key), between edges xa(z) and xb(z), split at the stations so it
// follows the facets; lift = how far proud of the surface
function onTop(s, secs, key, z0, z1, xa, xb, col, lift = .003, rows = 1) {
  const zs = [z0];
  for (const sec of secs) if (sec.z < z0 && sec.z > z1) zs.push(sec.z);
  zs.push(z1);
  const all = [];
  for (let i = 0; i < zs.length - 1; i++) for (let j = 0; j < rows; j++) all.push(lerp(zs[i], zs[i + 1], j / rows));
  all.push(z1);
  for (let i = 0; i < all.length - 1; i++) {
    const za = all[i], zb = all[i + 1], ya = at(secs, za)[key] + lift, yb = at(secs, zb)[key] + lift;
    s.quad([xa(za), ya, za], [xb(za), ya, za], [xb(zb), yb, zb], [xa(zb), yb, zb], col, [0, 1, 0]);
  }
}

function tub(s, far) {
  const secs = far ? TUB_FAR : TUB;
  loft(s, secs.map(ring), (i, k) => {
    const h = halfBand(k);
    if (i === 0) return h <= 1 ? CARBON : TRIM;                                  // white nose tip
    return h <= 1 ? CARBON : PAINT;
  }, { start: TRIM, end: CARBON });
}
function cover(s, far) {
  loft(s, (far ? COVER_FAR : COVER).map(ring), () => PAINT, { start: PAINT, end: PAINT });
  // roll-hoop intake over the driver's head, split by the hoop blade
  const z = -.22 + .004;
  s.poly([[.075, .37, z], [.04, .462, z], [-.04, .462, z], [-.075, .37, z]], DARK, [0, 0, 1]);
  if (far) return;
  s.box(0, .415, z + .002, .012, .09, .004, CARBON);
  s.box(0, .525, -.36, .10, .025, .05, TRIM);                                    // camera pod on the airbox
  // shark fin along the engine cover
  plateX(s, [[-.45, .47], [-.60, .535], [-1.60, .42], [-1.72, .17]], -.008, .008, PAINT);
  // trim stripe along the spine of the cover
  onTop(s, COVER, 'yt', -.42, -1.70, () => -.012, () => .012, TRIM, .002);
}

// ---------------------------------------------------------------- cockpit, halo, driver, mirrors
const tubTop = z => at(TUB, z).yt;
function cockpit(s, far) {
  // opening: carbon rim, then the dark interior (split at the stations so it lies on the flat top)
  const hw = z => z > .43 ? lerp(.15, .06, (z - .43) / .04) : z < -.22 ? lerp(.15, .10, (-.22 - z) / .05) : .15;
  if (far) { onTop(s, TUB_FAR, 'yt', .47, -.27, z => -hw(z), hw, DARK, .003); }
  else {
    onTop(s, TUB, 'yt', .49, -.29, z => -hw(z) - .02, z => hw(z) + .02, CARBON, .002, 3);
    onTop(s, TUB, 'yt', .47, -.27, z => -hw(z), hw, DARK, .004, 3);
  }
  // helmet: yellow shell, dark visor across the front (faceted), in the tub with only the top half showing
  const helmet = far ? new THREE.IcosahedronGeometry(.125, 0) : new THREE.SphereGeometry(.125, 10, 7);
  geoBy(s, helmet, (c, n) => n.z > .42 && n.y > -.3 && n.y < .42 ? VISOR : HELMET, new THREE.Matrix4().makeTranslation(0, .33, -.06));
  // halo: centre pillar on the tub ahead of the cockpit, the hoop round the helmet to the mounts behind it
  const side = [[.13, .44, .34], [.22, .44, .18], [.25, .43, -.02], [.25, .40, -.18], [.245, .25, -.33]];
  const hoop = [...side.slice().reverse().map(mx), [0, .425, .42], ...side];
  if (far) tube(s, [hoop[0], hoop[3], hoop[5], hoop[7], hoop[10]], .024, CARBON, 4);
  else tube(s, hoop, .024, CARBON, 6);
  tube(s, [[0, tubTop(.66) - .02, .66], [0, .36, .52], [0, .425, .42]], .022, CARBON, far ? 4 : 6);
  // mirrors: pods on stalks from the tub sides, glass toward the back
  for (const x of [1, -1]) {
    s.box(x * .45, .30, .40, .14, .065, .055, PAINT);
    if (far) continue;
    rod(s, [x * .29, .215, .44], [x * .41, .29, .41], .02, .02, CARBON);
    s.poly([[x * .385, .275, .371], [x * .515, .275, .371], [x * .515, .325, .371], [x * .385, .325, .371]], MIRROR, [0, 0, -1]);
  }
  if (far) return;
  // headrest round the helmet, steering wheel
  for (const x of [1, -1]) s.box(x * .155, tubTop(-.12) + .025, -.12, .07, .06, .22, CARBON);
  s.box(0, tubTop(-.24) + .03, -.235, .30, .07, .05, CARBON);
  s.box(0, .275, .25, .18, .07, .025, DARK, -.5);
}

// ---------------------------------------------------------------- sidepods
// Section: z, xi (inner, buried in the tub), xo (outer), yb (bottom: the undercut), ym (widest), yt (flat top)
const P = (z, xi, xo, yb, ym, yt) => ({ z, xi, xo, yb, ym, yt });
const podTop = z => .18 - .04 * (.30 - z) / .85;           // straight from z .30 to -.55: the livery / scuff panels
const POD = [
  P(0.40, .26, .62, -.04, .10, .175),
  P(0.30, .26, .66, -.10, .10, podTop(.30)),
  P(-0.10, .27, .67, -.18, .08, podTop(-.10)),
  P(-0.55, .27, .62, -.24, .04, podTop(-.55)),
  P(-1.00, .24, .50, -.28, -.02, .09),
  P(-1.45, .18, .34, -.30, -.06, .03),
  P(-1.75, .14, .20, -.30, -.09, -.02),
];
const POD_FAR = [0, 2, 4, 6].map(i => POD[i]);
// closed ring round the pod, starting at the inner bottom
const podRing = ({ z, xi, xo, yb, ym, yt }, sx) => [
  [xi, yb], [xo - .10, yb], [xo - .02, yb + (ym - yb) * .5], [xo, ym], [xo - .04, yt - .03], [xo - .14, yt], [xi + .06, yt], [xi, yt - .02],
].map(([x, y]) => [sx * x, y, z]);
function sidepods(s, far) {
  const secs = far ? POD_FAR : POD;
  for (const sx of [1, -1]) {
    const rings = secs.map(p => podRing(p, sx));
    loft(s, rings, (i, k) => k === 0 ? CARBON : PAINT, { start: PAINT, end: PAINT });
    // intake mouth: the front face less a lip
    const f = rings[0], c = centre(f);
    s.poly(f.map(p => [c[0] + (p[0] - c[0]) * .8, c[1] + (p[1] - c[1]) * .74, p[2] + .004]), DARK, [0, 0, 1]);
    if (far) continue;
    // trim stripe along the outer edge of the top, cooling louvres further back
    const xo = z => sx * (at(POD, z).xo - .14), xin = z => sx * (at(POD, z).xo - .19);
    onTop(s, POD, 'yt', .38, -.55, sx > 0 ? xin : xo, sx > 0 ? xo : xin, TRIM, .003);
    for (const z of [-.66, -.74, -.82, -.90]) {
      const a = z => sx * (at(POD, z).xi + .08), b = z => sx * (at(POD, z).xo - .15);
      onTop(s, POD, 'yt', z, z - .035, sx > 0 ? a : b, sx > 0 ? b : a, DARK, .003);
    }
  }
}

// ---------------------------------------------------------------- floor, diffuser, crash structure
const FLOOR = [[.30, 1.05], [.55, .75], [.70, .45], [.72, -.75], [.66, -1.0], [.60, -1.80]];
function floor(s, far) {
  plateY(s, [...FLOOR, ...FLOOR.slice().reverse().map(([x, z]) => [-x, z])], -.37, -.345, CARBON);
  // diffuser: a roof rising to the back between tall side walls
  plateX(s, [[-1.80, -.37], [-1.80, -.345], [-2.25, -.19], [-2.25, -.22]], -.58, .58, CARBON);
  if (far) return;
  for (const x of [.58, -.58]) plateX(s, [[-1.78, -.37], [-1.78, -.33], [-2.27, -.17], [-2.27, -.36]], x - .01, x + .01, CARBON2);
  for (const x of [.20, -.20, .40, -.40]) plateX(s, [[-1.88, -.345], [-2.25, -.21], [-2.25, -.33], [-1.98, -.37]], x - .006, x + .006, CARBON2);
  // floor edge fins and the fences under the sidepod mouths
  for (const sx of [1, -1]) {
    plateX(s, [[.40, -.37], [-.85, -.37], [-.85, -.325], [.40, -.35]], sx * .705, sx * .72, CARBON2);
    for (const x of [.36, .46, .56]) plateX(s, [[.95, -.36], [.55, -.36], [.50, -.24], [.85, -.22]], sx * x - .005, sx * x + .005, CARBON2);
  }
}
function tail(s, far) {
  // crash structure behind the gearbox, rain light on its back
  const box = (z, w, y0, y1) => [[w, y0, z], [-w, y0, z], [-w, y1, z], [w, y1, z]];
  loft(s, [box(-1.92, .085, -.21, -.03), box(-2.27, .06, -.19, -.05)], () => CARBON, { end: CARBON });
  s.poly([[.045, -.145, -2.274], [-.045, -.145, -2.274], [-.045, -.095, -2.274], [.045, -.095, -2.274]], RAIN, [0, 0, -1]);
  if (far) return;
  // exhaust above it, under the beam wing
  s.geo(new THREE.CylinderGeometry(.042, .046, .18, 8).rotateX(Math.PI / 2), STEEL, new THREE.Matrix4().makeTranslation(0, .03, -2.06));
  s.poly(Array.from({ length: 8 }, (_, i) => [.03 * Math.cos(i * Math.PI / 4), .03 + .03 * Math.sin(i * Math.PI / 4), -2.153]), DARK, [0, 0, -1]);
}

// ---------------------------------------------------------------- wings
const flapY = (x, y0, rise) => y0 + rise * Math.pow(Math.max(0, (Math.abs(x) - .3) / .66), 1.5);
function frontWing(s, far) {
  const xs = far ? [-.96, .96] : [-.96, -.75, -.52, -.3, .3, .52, .75, .96];
  wing(s, (far ? [-.96, .96] : [-.96, -.6, -.22, .22, .6, .96]).map(x => ({ x, y: Math.abs(x) < .3 ? -.355 : -.37, z: 2.58 - .03 * Math.abs(x), c: .30, aoa: .05 })), .09, CARBON);
  const flaps = far ? [[2.30, -.32, .2, .45, .06, PAINT]]
    : [[2.31, -.335, .17, .30, .04, CARBON2], [2.19, -.295, .14, .55, .07, PAINT], [2.10, -.25, .11, .80, .09, TRIM]];
  for (const [z, y0, c, aoa, rise, col] of flaps) wing(s, xs.map(x => ({ x, y: flapY(x, y0, rise), z, c, aoa: aoa + .25 * Math.max(0, Math.abs(x) - .3) })), .1, col);
  // endplates with the lamps on their front edges (head-light anchors)
  for (const sx of [1, -1]) {
    plateX(s, [[2.60, -.40], [2.04, -.40], [2.00, -.32], [2.00, -.06], [2.12, -.04], [2.50, -.20], [2.60, -.26]], sx * .955, sx * .975, PAINT);
    s.poly([[sx * .952, -.33, 2.604], [sx * .978, -.33, 2.604], [sx * .978, -.28, 2.604], [sx * .952, -.28, 2.604]], LAMP, [0, 0, 1]);
  }
}
function rearWing(s, far) {
  wing(s, [-.62, .62].map(x => ({ x, y: .345, z: -1.98, c: .19, aoa: .18 })), .1, CARBON);
  wing(s, [-.62, .62].map(x => ({ x, y: .405, z: -2.14, c: .15, aoa: .50 })), .1, TRIM);            // DRS flap
  for (const sx of [1, -1]) {
    plateX(s, [[-1.92, .08], [-2.34, .08], [-2.36, .40], [-2.30, .50], [-2.02, .48], [-1.92, .38]], sx * .62, sx * .64, PAINT);
    // rain-light strip on the endplate's trailing edge (tail anchors)
    s.poly([[sx * .62, .20, -2.351], [sx * .64, .20, -2.351], [sx * .64, .35, -2.362], [sx * .62, .35, -2.362]], RAIN, [0, 0, -1]);
  }
  // central swan-neck pylon from the gearbox
  plateX(s, [[-1.80, .10], [-1.95, .08], [-2.13, .32], [-2.03, .35]], -.012, .012, CARBON);
  if (far) return;
  wing(s, [-.50, .50].map(x => ({ x, y: .00, z: -2.02, c: .13, aoa: .22 })), .12, CARBON2);           // beam wing
  // DRS actuator pod between the elements
  s.box(0, .43, -2.10, .03, .07, .05, CARBON);
}

// ---------------------------------------------------------------- suspension
// Per wheel, in the body frame at the parked stance: the inboard hinge (pivot) and the bars to the upright inside the
// wheel (wishbones, push / pull rod, track / toe rod). Front: pushrods; rear: pullrods.
function arms(wheel) {
  const [x, y, z] = wheel.hub, sx = Math.sign(x), out = Math.abs(x) - wheel.w / 2 + .008, P = (a, b, c) => [sx * a, b, c];
  if (wheel.front) return { pivot: P(.16, y, z), bars: [
    [P(.16, .00, z + .22), P(out, y + .10, z)], [P(.17, -.01, z - .22), P(out, y + .10, z)],
    [P(.12, -.26, z + .23), P(out, y - .10, z)], [P(.15, -.27, z - .24), P(out, y - .10, z)],
    [P(out - .04, y - .08, z - .02), P(.17, .05, z - .04)], [P(out, y + .03, z + .10), P(.16, -.10, z + .13)],
  ] };
  return { pivot: P(.15, y, z), bars: [
    [P(.16, .10, z + .26), P(out, y + .12, z)], [P(.14, .10, z - .26), P(out, y + .12, z)],
    [P(.16, -.22, z + .31), P(out, y - .12, z)], [P(.13, -.24, z - .29), P(out, y - .12, z)],
    [P(out - .04, y + .10, z + .02), P(.14, -.20, z + .06)], [P(out, y - .02, z - .14), P(.15, -.01, z - .26)],
  ] };
}

// ---------------------------------------------------------------- wheels
// slick: rounded tread and sidewalls (spin.children[0]); rim lip and flat wheel cover ([1], the Garage wheels colour);
// sidewall marking ring, cover vents and nut ([2], fixed colours). Outer face toward +x for side 1.
function wheelMeshes(r, w, side, mats) {
  const hw = w / 2, rimR = r * .70, N = 20, V = (a, b) => new THREE.Vector2(a, b);
  const lathe = (pts, n = N) => new THREE.LatheGeometry(pts, n).toNonIndexed();
  const orient = g => { g.rotateZ(-Math.PI / 2); if (side < 0) g.rotateY(Math.PI); return g; };   // lathe axis +y → +x
  const join = parts => {
    const pos = []; for (const g of parts) { pos.push(...g.attributes.position.array); g.dispose(); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    orient(g); g.computeVertexNormals(); return g;
  };
  const tyre = join([
    lathe([V(rimR, -hw + .015), V(r - .05, -hw), V(r - .012, -hw + .03), V(r, -hw + .07), V(r, hw - .07), V(r - .012, hw - .03), V(r - .05, hw), V(rimR, hw - .015)]),
    lathe([V(.001, -hw + .015), V(rimR, -hw + .015)], 12),                    // inner face, closed
  ]);
  const rim = join([
    lathe([V(rimR + .006, hw - .01), V(rimR * .93, hw - .004), V(rimR * .88, hw - .03)]),        // lip
    lathe([V(rimR * .88, hw - .03), V(rimR * .35, hw - .045), V(.001, hw - .04)], 16),           // wheel cover
  ]);
  const deco = new Shape();
  // marking band round the outer sidewall, vents round the cover, centre nut (built in lathe space, then oriented);
  // y(rr) = the surface under them (sidewall: rimR → r - .05; cover: rimR·.88 → rimR·.35), a little proud
  const wall = rr => hw - .015 + .015 * (rr - rimR) / (r - .05 - rimR) + .0015;
  const disc = rr => hw - .045 + .015 * (rr / rimR - .35) / .53 + .0015;
  const band = (ra, rb, y, col, n = N) => { for (let i = 0; i < n; i++) {
    const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2, P = (rr, a) => [rr * Math.sin(a), y(rr), rr * Math.cos(a)];
    deco.quad(P(ra, a0), P(ra, a1), P(rb, a1), P(rb, a0), col, [0, 1, 0]);
  } };
  band(r - .085, r - .065, wall, STRIPE);
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2, P = (rr, da) => [rr * Math.sin(a + da), disc(rr), rr * Math.cos(a + da)];
    deco.quad(P(rimR * .55, -.09), P(rimR * .80, -.07), P(rimR * .80, .07), P(rimR * .55, .09), DARK, [0, 1, 0]);
  }
  band(.001, rimR * .16, () => hw - .036, NUT, 6);
  const [dm] = deco.meshes({ fixed: mats.fixed });
  orient(dm.geometry); dm.geometry.computeVertexNormals();
  const t = new THREE.Mesh(tyre, mats.tyre), m = new THREE.Mesh(rim, mats.rim);
  t.castShadow = true;
  return [t, m, dm];
}
// ---------------------------------------------------------------- model
function body(far) {
  const s = new Shape();
  cover(s, far);                      // first: the body mesh starts with a PAINT vertex (cosmetics_test reads vertex 0)
  tub(s, far); cockpit(s, far); sidepods(s, far); floor(s, far); tail(s, far); frontWing(s, far); rearWing(s, far);
  return s;
}

// colors: { paint, accent, helmet } (hex number or css string) in place of PAINT / TRIM / HELMET
function recolour(meshes, colors) {
  const swaps = [[PAINT, colors.paint], [TRIM, colors.accent], [HELMET, colors.helmet]].filter(([, to]) => to != null)
    .map(([from, to]) => [new THREE.Color(from), new THREE.Color(to)]);
  if (!swaps.length) return;
  for (const m of meshes) {
    const a = m.geometry.attributes.color;
    for (let i = 0; i < a.count; i++) for (const [from, to] of swaps) {
      if (Math.abs(a.getX(i) - from.r) + Math.abs(a.getY(i) - from.g) + Math.abs(a.getZ(i) - from.b) < 1e-4) { a.setXYZ(i, to.r, to.g, to.b); break; }
    }
  }
}

export function buildRaceCarModel(wheelPos, colors = {}) {
  const root = new THREE.Group(); root.name = 'car-race';
  const bodyPivot = new THREE.Group(); bodyPivot.name = 'race-body'; root.add(bodyPivot);
  const fixed = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const rimMat = new THREE.MeshLambertMaterial({ color: '#d9dce2', flatShading: true }); rimMat.userData.cosmeticRole = 'wheels';
  const mats = { fixed, rim: rimMat, tyre: new THREE.MeshLambertMaterial({ color: '#1d1e22', flatShading: true }) };

  // wheels at the parked stance (car.js syncMesh moves them from there)
  const spec = wheelPos.map(([x, y, z, front, r, w]) => ({ hub: [x, y + STANCE - (PHYS_R - r), z], restY: y, front, r, w }));
  const wheels = spec.map(W => {
    const side = Math.sign(W.hub[0]), holder = new THREE.Group(); holder.position.set(...W.hub); root.add(holder);
    const spin = new THREE.Group(); holder.add(spin); spin.add(...wheelMeshes(W.r, W.w, side, mats));
    return { holder, spin, restY: W.restY, r: W.r, front: W.front, hubWidth: W.w + .01 };
  });

  const near = body(false), far = body(true);
  // suspension: the last vertices of the near body mesh (no extra draw call, and mp/remotes.js bakeParts keeps their
  // order), one block per wheel hinged on the chassis; the far body has fixed arms
  const armStart = near.p.length / 3, farArmStart = far.p.length / 3;
  const links = spec.map((W, i) => {
    const { pivot, bars } = arms(W), from = near.p.length / 3;
    for (const [a, b] of bars) rod(near, a, b, .045, .016, CARBON);
    for (const k of [0, 3]) rod(far, ...bars[k], .04, .02, CARBON);
    // the bars' outer ends: on the upright, `inset` inboard of the hub (the holder only moves, so they move with it)
    const inset = Math.sign(W.hub[0]) * (W.w / 2 - .008);
    return { pivot, inset, from, to: near.p.length / 3, reach: Math.abs(W.hub[0] - inset - pivot[0]), wheel: wheels[i], angle: 0, stretch: 1,
      wantAngle: 0, wantStretch: 1 };
  });
  const armEnd = near.p.length / 3;
  const nearMeshes = near.meshes({ fixed }), farMeshes = far.meshes({ fixed });
  nearMeshes[0].userData.damageVertexCount = armStart;
  farMeshes[0].userData.damageVertexCount = farArmStart;
  recolour([...nearMeshes, ...farMeshes], colors);
  const lod = lodBody(bodyPivot, nearMeshes, farMeshes, FAR_AT);
  const [nearGroup, farGroup] = lod.levels.map(l => l.object);
  farGroup.visible = false;              // until the LOD's first update (a fresh model counts one body draw call)
  const rest = nearMeshes[0].geometry.attributes.position.array.slice(armStart * 3, armEnd * 3);

  const inv = new THREE.Matrix4(), hub = new THREE.Vector3();
  let posed = null;
  const linkage = {
    // swing each wheel's arms about their chassis hinge (along z through the pivot) and stretch them along x so their
    // outer ends stay on the upright (springs, body roll / dive); only while the near body is drawn
    update() {
      if (!nearGroup.visible) return;
      const mesh = nearGroup.children.find(o => o.isMesh), pos = mesh?.geometry.attributes.position;
      if (!pos || pos.count < armEnd) return;
      bodyPivot.updateMatrix(); inv.copy(bodyPivot.matrix).invert();
      let moved = pos !== posed;
      for (const L of links) {
        hub.copy(L.wheel.holder.position).applyMatrix4(inv);
        const dx = hub.x - L.inset - L.pivot[0], dy = hub.y - L.pivot[1], sx = Math.sign(dx) || 1;
        // within real lengths, whatever the drawing asks: a wishbone's swing and stretch (bodyclearance.js caps the
        // body's lift off the wheels, so this is only a backstop)
        L.wantAngle = Math.atan2(dy * sx, dx * sx); L.wantStretch = Math.hypot(dx, dy) / L.reach;
        const angle = THREE.MathUtils.clamp(L.wantAngle, -ARM_SWING, ARM_SWING);
        const stretch = THREE.MathUtils.clamp(L.wantStretch, 1 / ARM_STRETCH, ARM_STRETCH);
        if (pos === posed && Math.abs(angle - L.angle) < 1e-4 && Math.abs(stretch - L.stretch) < 1e-4) continue;
        L.angle = angle; L.stretch = stretch; moved = true;
        const c = Math.cos(angle), s = Math.sin(angle), [px, py] = L.pivot, a = pos.array;
        for (let v = L.from; v < L.to; v++) {
          const r = (v - armStart) * 3, lx = (rest[r] - px) * stretch, ly = rest[r + 1] - py;
          a[v * 3] = px + lx * c - ly * s; a[v * 3 + 1] = py + lx * s + ly * c;
        }
      }
      if (!moved) return;
      posed = pos;                       // (a baked copy, mp/remotes.js, is a new buffer: posed in full once)
      pos.clearUpdateRanges(); pos.addUpdateRange(armStart * 3, (armEnd - armStart) * 3); pos.needsUpdate = true;
    },
    // the arms' largest |swing| (rad) and stretch as last drawn, and as the wheels asked (tests)
    extent() {
      let swing = 0, stretch = 0, wantSwing = 0, wantStretch = 0;
      for (const L of links) {
        swing = Math.max(swing, Math.abs(L.angle)); stretch = Math.max(stretch, L.stretch);
        wantSwing = Math.max(wantSwing, Math.abs(L.wantAngle)); wantStretch = Math.max(wantStretch, L.wantStretch);
      }
      return { swing, stretch, wantSwing, wantStretch };
    },
  };
  // lenses (lights.js) on the drawn lamps: the endplate lamps, the rain light, the endplate LED strips
  const rect = (x0, x1, y0, y1, z0, z1 = z0) => [[x0, y0, z0], [x1, y0, z0], [x1, y1, z1], [x0, y1, z1]];
  root.userData = { bodyPivot, wheels, lightMount: bodyPivot, linkage, lod, blob: [2.3, 4.9],
    lights: {
      head: [1, -1].map(x => new THREE.Vector3(x * .965, -.305, 2.604)),
      tail: [new THREE.Vector3(0, -.12, -2.274), ...[1, -1].map(x => new THREE.Vector3(x * .63, .275, -2.3565))],
      lens: {
        head: [1, -1].map(x => rect(x * .952, x * .978, -.33, -.28, 2.604)),
        tail: [rect(-.045, .045, -.145, -.095, -2.274), ...[1, -1].map(x => rect(x * .62, x * .64, .20, .35, -2.351, -2.362))],
      },
    },
    triangles: { near: near.triangles(), far: far.triangles() },
    // livery panels: nose top and both sidepod tops (flat facets: lifted 6 mm), scuffs on the sidepods
    decalPanels: [
      [.16, .32, 0, tubTop(1.52) + .006, 1.52, -Math.PI / 2 + Math.atan(.2)],
      ...[1, -1].map(x => [.16, .30, x * .425, podTop(-.13) + .006, -.13, -Math.PI / 2 - Math.atan(.04 / .85)]),
    ],
    scuffPanels: [1, -1].map(x => [.15, .4, x * .42, podTop(-.2) + .008, -.2, -Math.PI / 2 - Math.atan(.04 / .85)]),
  };
  // tyre-top ceilings (body frame): nothing is over an open wheel, so the old model's ones, its measured fallback (tyre
  // top at the WHEEL_POS hub + 8 cm). They also bound the body roll / dive bodyclearance.js allows: keep them.
  root.userData.wheelArch = measureWheelArch(root).map((c, i) => Number.isFinite(c) ? c : +(spec[i].restY + spec[i].r + .08).toFixed(3));
  return root;
}
