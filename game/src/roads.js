// 3D meshes for the road / trail strips and junction pieces of one tile (data.js `renderRoads` / `renderJunctions`).
// Heights are baked by the build (tools/roadnet.py), which also carved the ground just below every road.
import * as THREE from 'three';

const TOP = { asphalt: 0x50535c, gravel: 0xb9a888, trail: 0xc98d55 };
const SIDE = { asphalt: 0x44474f, gravel: 0xa39472, trail: 0xb27a47 };
const LINE = 0xf2f2ea, DASH = 0xf3c63c;
// Developed school drives use town asphalt, without yellow centre markings. Woodland trails stay dirt.
export function campusRoad(x, z, kind) {
  const developed = x >= -900 && x <= -350 && z >= 130 && z <= 650;
  const courtyard = x >= -660 && x <= -470 && z >= 200 && z <= 460;
  return developed && (kind !== 'trail' || courtyard);
}
// Road drawing by OSM class (tile.json `cls`, tools/build_tiles.py). A tile without `cls` (older builds) draws
// exactly as before. With `cls`:
//  - yellow centre dashes only on two-way main roads (motorway / trunk / primary / secondary / tertiary / unclassified)
//  - white edge lines only on main roads out of town (no sidewalk tag) and on the campus drives
//  - residential streets, alleys, driveways plain; flat paving (short driveways, parking aisles) drawn as concrete
//  - `sidewalk` tag: a low kerb (KERB) and a concrete sidewalk (SIDEWALK wide) beside the road (drivable: data.js)
//  - `stop`: a stop line + zebra crossing where a town street meets a bigger road
// Each batch has a cheap far version (no markings, half the samples) used beyond FAR_AT m.
const PAVE = 0x8f9196, WALK = 0xb9bab5, KERBC = 0xcfd0cb;
export const KERB = 0.1, SIDEWALK = 1.8;
const FAR_AT = 350;
const MAIN = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified']);
const RGB = {};
for (const hex of [...Object.values(TOP), ...Object.values(SIDE), LINE, DASH, PAVE, WALK, KERBC]) { const c = new THREE.Color(hex); RGB[hex] = [c.r, c.g, c.b]; }

// sidewalk widths [left, right] of a strip (left = left of the drawing direction)
export function sidewalkSides(sw) {
  if (sw === 'both' || sw === 'yes') return [SIDEWALK, SIDEWALK];
  if (sw === 'left') return [SIDEWALK, 0];
  if (sw === 'right') return [0, SIDEWALK];
  return [0, 0];
}

// Splits a tile's strips into batches of roughly `samples` strip samples each (so no batch takes too long to build),
// grouped by area so each batch is compact (its far version can switch in by distance).
export function roadBatches(list, samples = 1500) {
  const out = []; let cur = [], n = 0;
  const cell = r => Math.floor(r.z[0] / 300) * 1e4 + Math.floor(r.x[0] / 300);
  const sorted = [...list].sort((a, b) => cell(a) - cell(b));
  const SLICE = 400;                             // long strips in ~600 m slices
  for (const r of sorted) {
    if (r.n > SLICE) {
      for (let a = 0; a < r.n - 1; a += SLICE) out.push([{ r, a, b: Math.min(r.n - 1, a + SLICE) }]);
      continue;
    }
    cur.push({ r, a: 0, b: r.n - 1 }); n += r.n;
    if (n >= samples) { out.push(cur); cur = []; n = 0; }
  }
  if (cur.length) out.push(cur);
  return out;
}

// cross-section columns of a strip: [offset left of centre, height offset, colour key of the quad to the next column]
function columns(r, school, far) {
  const { hw, kind, osm } = r;
  if (osm === undefined) {                       // older tiles: exactly the old layout
    if (far) return [[hw + 1.2, -3, 'side'], [hw, 0, 'top'], [-hw, 0, 'side'], [-(hw + 1.2), -3, null]];
    const lineW = kind === 'asphalt' ? 0.35 : 0;
    const offs = kind === 'asphalt' ? [hw + 1.2, hw + 0.4, hw, hw - 0.5, hw - 0.5 - lineW, 0.12, -0.12,
      -(hw - 0.5 - lineW), -(hw - 0.5), -hw, -(hw + 0.4), -(hw + 1.2)] : [hw + 1.2, hw + 0.4, hw, 0, -hw, -(hw + 0.4), -(hw + 1.2)];
    const K = offs.length;
    return offs.map((o, k) => {
      let key = k <= 1 || k >= K - 3 ? 'side' : 'top';
      if (kind === 'asphalt' && (k === 3 || k === K - 5)) key = 'line';
      else if (kind === 'asphalt' && k === 5) key = 'dash';
      return [o, k === 0 || k === K - 1 ? -3 : k === 1 || k === K - 2 ? -0.3 : 0, k === K - 1 ? null : key];
    });
  }
  const [swL, swR] = r.sw, base = osm.split(':')[0];
  const paint = kind === 'asphalt' && !r.flat;
  const edges = paint && ((MAIN.has(base) && !r.hasSidewalk) || school);
  const centre = paint && !school && MAIN.has(base) && !r.oneway;
  const top = r.flat ? 'pave' : 'top';
  const cols = [];
  const side = (sw, sgn) => {                    // outer part of one side, listed from the outside in
    const o = q => sgn * q;
    if (sw) return [[o(hw + sw + 1.2), -3, 'side'], [o(hw + sw + 0.3), KERB - 0.3, 'side'], [o(hw + sw), KERB, 'walk'],
      [o(hw + 0.15), KERB, 'kerb'], [o(hw), KERB, 'kerb'], [o(hw), 0, top]];
    return [[o(hw + 1.2), -3, 'side'], [o(hw + 0.4), -0.3, 'side'], [o(hw), 0, top]];
  };
  cols.push(...side(swL, 1));
  if (far) cols[cols.length - 1][2] = top;
  else if (edges) { cols.push([hw - 0.5, 0, 'line'], [hw - 0.85, 0, top]); }
  if (!far && centre) cols.push([0.12, 0, 'dash'], [-0.12, 0, top]);
  if (!far && edges) cols.push([-(hw - 0.85), 0, 'line'], [-(hw - 0.5), 0, top]);
  // right side, inside out: each column takes the colour of the quad beyond it (listed outside-in by side())
  const rs = side(swR, -1);
  for (let i = rs.length - 1; i >= 0; i--) {
    const [o, dy] = rs[i], key = i > 0 ? rs[i - 1][2] : null;
    cols.push([o, dy, key]);
  }
  return cols;
}

function colourOf(key, style, dashOn) {
  switch (key) {
    case 'side': return RGB[SIDE[style]];
    case 'line': return RGB[LINE];
    case 'dash': return dashOn ? RGB[DASH] : RGB[TOP[style]];
    case 'pave': return RGB[PAVE];
    case 'walk': return RGB[WALK];
    case 'kerb': return RGB[KERBC];
    default: return RGB[TOP[style]];
  }
}

// one batch → { pos, col } triangles (world coordinates)
function stripTriangles(batch, far) {
  const P = [], C = [];
  const step = far ? 2 : 1;
  for (const { r, a, b } of batch) {
    const { x, z, y, c, lx, lz } = r;
    const school0 = campusRoad(x[a], z[a], r.kind);
    let cols = columns(r, school0, far), K = cols.length;
    const at = (i, k) => { const [o, dy] = cols[k]; return [x[i] + lx[i] * o, y[i] + c[i] * o + dy, z[i] + lz[i] * o]; };
    for (let i = a; i < b; i += step) {
      const j = Math.min(b, i + step);
      const school = campusRoad((x[i] + x[j]) / 2, (z[i] + z[j]) / 2, r.kind);
      if (r.osm !== undefined && school !== school0) { cols = columns(r, school, far); K = cols.length; }
      const style = school ? 'asphalt' : r.kind;
      const dashOn = !school && Math.floor(i / 2) % 2 === 0;
      for (let k = 0; k < K - 1; k++) {
        const rgb = colourOf(cols[k][2], style, dashOn);
        const p0 = at(i, k), p1 = at(i, k + 1), q1 = at(j, k + 1), q0 = at(j, k);
        P.push(...p0, ...p1, ...q1, ...p0, ...q1, ...q0);
        for (let t = 0; t < 6; t++) C.push(...rgb);
      }
    }
    if (!far && r.stop) stopMarks(r, a, b, P, C);
  }
  return { P, C };
}

// stop line (approaching half) + zebra crossing, painted 2 cm above the road at a junction end of a town street
function stopMarks(r, a, b, P, C) {
  const { x, z, y, c, lx, lz, hw } = r, white = RGB[LINE], lift = 0.02;
  // point + left normal at arc length s from sample a (dir +1) or from sample b (dir -1)
  const cum = [0];
  for (let i = a + 1; i <= b; i++) cum.push(cum[cum.length - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]));
  const L = cum[cum.length - 1];
  const pt = s => {
    s = Math.min(L, Math.max(0, s)); let k = 1; while (k < cum.length - 1 && cum[k] < s) k++;
    const t = (s - cum[k - 1]) / Math.max(1e-6, cum[k] - cum[k - 1]), i = a + k - 1;
    const m = (A, i2) => A[i2] + (A[i2 + 1] - A[i2]) * t;
    return { x: m(x, i), z: m(z, i), y: m(y, i), c: m(c, i), lx: m(lx, i), lz: m(lz, i) };
  };
  const quad = (s0, s1, o0, o1) => {             // rectangle between arc lengths s0..s1 and offsets o0..o1
    const A = pt(s0), B = pt(s1);
    const v = (Q, o) => [Q.x + Q.lx * o, Q.y + Q.c * o + lift, Q.z + Q.lz * o];
    const p0 = v(A, o0), p1 = v(A, o1), q1 = v(B, o1), q0 = v(B, o0);
    P.push(...p0, ...q0, ...q1, ...p0, ...q1, ...p1);
    for (let t = 0; t < 6; t++) C.push(...white);
  };
  if (L < 14) return;
  const edge = hw - 0.3;
  for (const [flag, from, sgn] of [[r.stop[0], 0, 1], [r.stop[1], L, -1]]) {
    if (!flag) continue;
    const s = d => from + sgn * d;                  // d metres in from that end
    // zebra: bars along the road, 0.5 m wide every 1 m, between 1.0 and 4.0 m from the end
    for (let o = -edge + 0.25; o < edge - 0.25; o += 1.0) quad(Math.min(s(1.0), s(4.0)), Math.max(s(1.0), s(4.0)), o, o + 0.5);
    // stop line 0.4 m wide at 5 m, across the lane heading into the junction (its right-hand half)
    const half = sgn > 0 ? [0, edge] : [-edge, 0];
    quad(Math.min(s(5.0), s(5.4)), Math.max(s(5.0), s(5.4)), half[0], half[1]);
  }
}

// one batch of strips as one mesh in world coordinates (far = the cheap version: no markings, half the samples)
export function buildRoads(D, groundMat, batch, far = false) {
  const { P, C } = stripTriangles(batch, far);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(C), 3));
  g.computeVertexNormals();
  const strips = new THREE.Mesh(g, groundMat);
  strips.receiveShadow = true;
  return strips;
}

// near + far versions of a batch: the far one is shown once the camera is FAR_AT m beyond the batch's extent
export function roadLOD(D, groundMat, batch) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const { r, a, b } of batch) for (let i = a; i <= b; i++) {
    x0 = Math.min(x0, r.x[i]); x1 = Math.max(x1, r.x[i]); z0 = Math.min(z0, r.z[i]); z1 = Math.max(z1, r.z[i]);
  }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, rad = Math.hypot(x1 - x0, z1 - z0) / 2;
  const lod = new THREE.LOD();
  lod.position.set(cx, 0, cz);
  for (const [far, dist] of [[false, 0], [true, FAR_AT + rad]]) {
    const m = buildRoads(D, groundMat, batch, far); m.position.set(-cx, 0, -cz);   // geometry stays in world coords
    lod.addLevel(m, dist);
  }
  return lod;
}

// Junction pieces: a fan from the centre over the ring (road ends joined by curved corners), plus a sloped skirt
// along the open (corner) edges so the piece meets the ground like the strips' sides do.
export function buildJunctions(list, groundMat) {
  const P = [], Cc = [];
  const tri = (a, b, d, col) => {
    // keep every face pointing up / outward-up
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    const ny = uz * vx - ux * vz;
    const pts = ny >= 0 ? [a, b, d] : [a, d, b];
    for (const q of pts) { P.push(q[0], q[1], q[2]); Cc.push(col[0], col[1], col[2]); }
  };
  for (const j of list) {
    const style = campusRoad(j.c[0], j.c[1], j.kind) ? 'asphalt' : j.kind;
    const top = RGB[TOP[style]], side = RGB[SIDE[style]], R = j.ring, n = R.length;
    const c = [j.c[0], j.c[2], j.c[1]];
    const v = q => [q[0], q[2], q[1]];
    for (let k = 0; k < n; k++) tri(c, v(R[k]), v(R[(k + 1) % n]), top);
    for (let k = 0; k < n; k++) {
      if (!R[k][3]) continue;
      const a = R[k], b = R[(k + 1) % n];
      const out = (q, w, dy) => { const dx = q[0] - j.c[0], dz = q[1] - j.c[1], L = Math.hypot(dx, dz) || 1;
        return [q[0] + dx / L * w, q[2] - dy, q[1] + dz / L * w]; };
      const A = v(a), B = v(b), A2 = out(a, 0.4, 0.3), B2 = out(b, 0.4, 0.3), A3 = out(a, 1.2, 3), B3 = out(b, 1.2, 3);
      tri(A, B, B2, side); tri(A, B2, A2, side); tri(A2, B2, B3, side); tri(A2, B3, A3, side);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, groundMat); m.receiveShadow = true;
  return m;
}
