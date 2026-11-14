// Low-poly meshes for the hand-authored campus buildings (campus.js): walls down to the ground, flat roofs with a
// parapet, gable / hip roofs with eaves, rows of windows per storey, doors, porch roofs on posts, boxes (towers' stone
// faces, rooftop units, stairs). One flat-shaded, vertex-coloured BufferGeometry per building.
import * as THREE from 'three';
import { partPts } from './campus.js';
import { addEntranceDressing } from './campusprops.js';
import { addCourtyardDressing } from './campuscourt.js';
import { addCampusPaint } from './campuspaint.js';

const D2R = Math.PI / 180;
// palette colours are sRGB (as picked from photos); vertex colours are linear
const _c = new THREE.Color(), _lin = new Map();
const lin = col => { const key = col.join(); let v = _lin.get(key); if (!v) { _c.setRGB(col[0], col[1], col[2], THREE.SRGBColorSpace); _lin.set(key, v = [_c.r, _c.g, _c.b]); } return v; };

class Mesh {
  constructor() { this.p = []; this.c = []; }
  // triangle facing `want` (any vector on the side it should face)
  tri(a, b, c, col, want) {
    if (want) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * want[0] + ny * want[1] + nz * want[2] < 0) { const t = b; b = c; c = t; }
    }
    const k = lin(col); this.p.push(...a, ...b, ...c); this.c.push(k[0], k[1], k[2], k[0], k[1], k[2], k[0], k[1], k[2]);
  }
  quad(a, b, c, d, col, want) { this.tri(a, b, c, col, want); this.tri(a, c, d, col, want); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeVertexNormals();          // not indexed: every triangle keeps its own face normal (flat shading)
    return g;
  }
}

const inside = (pts, x, z) => {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [x1, z1] = pts[j], [x2, z2] = pts[i];
    if ((z2 > z) !== (z1 > z) && x < (x1 - x2) * (z - z2) / (z1 - z2) + x2) c = !c;
  }
  return c;
};
// edges with unit direction, length and outward normal
function edges(pts) {
  return pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length], dx = q[0] - p[0], dz = q[1] - p[1], L = Math.hypot(dx, dz) || 1;
    const ux = dx / L, uz = dz / L; let ox = uz, oz = -ux;
    const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
    if (inside(pts, mx + ox * 0.05, mz + oz * 0.05)) { ox = -ox; oz = -oz; }
    return { p, q, ux, uz, L, ox, oz };
  });
}
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

function walls(m, pts, y0, y1, col) {
  for (const e of edges(pts)) m.quad([e.p[0], y0, e.p[1]], [e.q[0], y0, e.q[1]], [e.q[0], y1, e.q[1]], [e.p[0], y1, e.p[1]], col, [e.ox, 0, e.oz]);
}
function cap(m, pts, y, col, down = false) {
  const tris = THREE.ShapeUtils.triangulateShape(pts.map(([x, z]) => new THREE.Vector2(x, z)), []);
  for (const [a, b, c] of tris) m.tri([pts[a][0], y, pts[a][1]], [pts[b][0], y, pts[b][1]], [pts[c][0], y, pts[c][1]], col, [0, down ? -1 : 1, 0]);
}
function grow(pts, d) {    // rectangle grown by d on every side (about its centre)
  const e = edges(pts);
  return pts.map((p, i) => { const a = e[(i + pts.length - 1) % pts.length], b = e[i]; return [p[0] + (a.ox + b.ox) * d, p[1] + (a.oz + b.oz) * d]; });
}
// rectangle corners reordered so that 0→1 is a long side
function longFirst(pts) {
  const l01 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), l12 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
  return l01 >= l12 ? pts : [pts[1], pts[2], pts[3], pts[0]];
}

function box(m, b, floor) {
  const r = b.a * D2R, ux = Math.cos(r), uz = Math.sin(r), vx = -uz, vz = ux, c = b.c;
  const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => [c[0] + ux * s * b.L / 2 + vx * t * b.W / 2, c[1] + uz * s * b.L / 2 + vz * t * b.W / 2]);
  walls(m, pts, floor + b.y0, floor + b.y1, b.color); cap(m, pts, floor + b.y1, shade(b.color, 1.05));
}

// Vertical bays on one face: brick piers, inset brick between the floors, light sills.
// `far` keeps the plain window grid. Other faces of the same part are unchanged.
function frontEdge(es, face) {
  let best = null, dot = 0.72;
  for (const e of es) {
    const d = e.ox * face[0] + e.oz * face[1];
    if (d > dot) { dot = d; best = e; }
  }
  return best;
}
function groupedBays(span, winW, groups) {
  const n = groups.reduce((a, b) => a + b, 0);
  const wideAt = new Set();
  let acc = 0;
  for (let g = 0; g < groups.length - 1; g++) { acc += groups[g]; wideAt.add(acc); }
  const gaps = n + 1, minN = 0.42, minW = 0.95;
  const extra = Math.max(0, span - n * winW - (gaps - wideAt.size) * minN - wideAt.size * minW);
  const weight = (gaps - wideAt.size) + wideAt.size * 2.1;
  const narrow = minN + extra / weight, wide = minW + extra / weight * 2.1;
  const centers = [];
  let x = 0;
  for (let i = 0; i < n; i++) {
    x += wideAt.has(i) ? wide : narrow;
    centers.push({ s: x + winW / 2, setback: i >= groups[0] });
    x += winW;
  }
  return { centers, end: x + (wideAt.has(n) ? wide : narrow) };
}
function evenBays(from, to, every, winW) {
  const centers = [];
  const n = Math.max(0, Math.floor((to - from) / every));
  if (n < 1) return centers;
  const span = (n - 1) * every, s0 = from + Math.max(0, (to - from - span) / 2);
  for (let i = 0; i < n; i++) {
    const s = s0 + i * every;
    if (s > winW * 0.5 && s < to - winW * 0.4) centers.push({ s, setback: false });
  }
  return centers;
}
function baysOn(m, edge, part, floor, ground, top) {
  const w = part.win, bay = w.bays, winW = bay.w || Math.min(w.w, 1.55), winH = bay.h || w.h;
  const towerStart = !bay.anchor || Math.hypot(edge.p[0] - bay.anchor[0], edge.p[1] - bay.anchor[1])
    <= Math.hypot(edge.q[0] - bay.anchor[0], edge.q[1] - bay.anchor[1]);
  const along = s => towerStart ? s : edge.L - s;
  let spots;
  if (bay.groups) {
    const head = groupedBays(Math.min(edge.L - 0.4, bay.span || edge.L), winW, bay.groups);
    spots = head.centers;
    if (head.end < edge.L - 2) spots = spots.concat(evenBays(head.end, edge.L, bay.every || 3.5, winW));
  } else spots = evenBays(0.4, edge.L - 0.2, bay.every || w.every, winW);
  const at = (s, y, off) => {
    const u = along(s);
    return [edge.p[0] + edge.ux * u + edge.ox * off, y, edge.p[1] + edge.uz * u + edge.oz * off];
  };
  const face = [edge.ox, 0, edge.oz];
  const pierOf = (a, b, off) => {
    if (b - a < 0.18) return;
    m.quad(at(a, floor, off), at(b, floor, off), at(b, top, off), at(a, top, off), part.wall, face);
  };
  const ordered = spots.map(s => s.s).sort((a, b) => a - b);
  if (!ordered.length) return;
  const back = new Set(spots.filter(s => s.setback).map(s => s.s));
  const proud = s => bay.setback && back.has(s) ? 0.06 : 0.16;
  pierOf(0.05, ordered[0] - winW / 2, proud(ordered[0]));
  for (let i = 0; i < ordered.length - 1; i++) pierOf(ordered[i] + winW / 2, ordered[i + 1] - winW / 2, Math.min(proud(ordered[i]), proud(ordered[i + 1])));
  pierOf(ordered[ordered.length - 1] + winW / 2, edge.L - 0.05, proud(ordered[ordered.length - 1]));
  const sill = bay.sill || part.wall;
  for (const spot of spots) {
    const s = spot.s, off = spot.setback && bay.setback ? 0.05 : 0.045;
    const gnd = ground(at(s, 0, 1.2)[0], at(s, 0, 1.2)[2]);
    for (let r = 0; r < w.rows; r++) {
      const yb = floor + r * w.sh + w.sill, yt = yb + winH;
      if (yt > top - 0.35 || yb < gnd + 0.3) continue;
      m.quad(at(s - winW / 2, yb, off), at(s + winW / 2, yb, off), at(s + winW / 2, yt, off), at(s - winW / 2, yt, off), w.color, face);
      m.quad(at(s - winW / 2 - 0.08, yb - 0.14, off + 0.05), at(s + winW / 2 + 0.08, yb - 0.14, off + 0.05),
        at(s + winW / 2 + 0.08, yb, off + 0.05), at(s - winW / 2 - 0.08, yb, off + 0.05), sill, face);
      const yNext = r + 1 < w.rows ? floor + (r + 1) * w.sh + w.sill : top - 0.15;
      if (yNext - yt > 0.2) m.quad(at(s - winW / 2, yt, 0.02), at(s + winW / 2, yt, 0.02), at(s + winW / 2, yNext, 0.02), at(s - winW / 2, yNext, 0.02), shade(part.wall, 0.86), face);
    }
  }
}

const ARCH_GLASS = [[0.22, 0.32, 0.48], [0.32, 0.40, 0.36], [0.42, 0.30, 0.28], [0.28, 0.34, 0.42]];

// Pointed arches: a tall pane up to the spring line, then a triangle. The lancet is the
// narrower arch at the south end of the row. Far copies keep the plain rectangular grid.
function pointedOn(m, e, w, floor, top, fixed) {
  const n = fixed || Math.max(1, Math.floor((e.L - 2 * w.margin) / w.every) + 1);
  const span = (n - 1) * (fixed ? e.L / (n + 0.4) : w.every), s0 = (e.L - span) / 2;
  let lancet = -1, best = -1e9;
  if (w.lancet && !fixed) {
    for (let i = 0; i < n; i++) {
      const s = s0 + i * w.every, dot = (e.p[0] + e.ux * s) * w.lancet[0] + (e.p[1] + e.uz * s) * w.lancet[1];
      if (dot > best) { best = dot; lancet = i; }
    }
  }
  const face = [e.ox, 0, e.oz], step = fixed ? e.L / (n + 0.4) : w.every;
  for (let i = 0; i < n; i++) {
    const narrow = i === lancet, ww = narrow ? w.w * 0.62 : w.w, hh = narrow ? w.h * 0.86 : w.h;
    const s = s0 + i * step, yb = floor + w.sill, yt = yb + hh;
    if (yt > top - 0.25 || yb < floor) continue;
    const spring = yb + hh * 0.66, o = 0.04;
    const at = (ds, y) => [e.p[0] + e.ux * (s + ds) + e.ox * o, y, e.p[1] + e.uz * (s + ds) + e.oz * o];
    const col = ARCH_GLASS[i % ARCH_GLASS.length];
    m.quad(at(-ww / 2, yb), at(ww / 2, yb), at(ww / 2, spring), at(-ww / 2, spring), col, face);
    m.tri(at(-ww / 2, spring), at(ww / 2, spring), at(0, yt), col, face);
  }
}

function windowsOn(m, pts, part, floor, ground, top, far) {
  const w = part.win; if (!w) return;
  const es = edges(pts), front = !far && w.bays ? frontEdge(es, w.bays.face) : null;
  const arch = !far && w.pointed ? frontEdge(es, w.face) : null;
  const arch2 = !far && w.pointed && w.face2 ? frontEdge(es, w.face2) : null;
  const o = 0.05;
  for (const e of es) {
    if (e === arch) { pointedOn(m, e, w, floor, top, 0); continue; }
    if (e === arch2) { pointedOn(m, e, w, floor, top, 2); continue; }
    if (w.pointed) continue;
    if (e === front) continue;
    const n = Math.floor((e.L - 2 * w.margin) / w.every) + 1; if (n < 1 || e.L < w.w + 2 * w.margin) continue;
    const span = (n - 1) * w.every, s0 = (e.L - span) / 2;
    for (let i = 0; i < n; i++) {
      const s = s0 + i * w.every, cx = e.p[0] + e.ux * s + e.ox * o, cz = e.p[1] + e.uz * s + e.oz * o;
      const gnd = ground(e.p[0] + e.ux * s + e.ox * 1.5, e.p[1] + e.uz * s + e.oz * 1.5);
      // Explicit lower floor candidates still pass the terrain clearance check below.
      const r0 = w.basementRows ? -w.basementRows : w.below ? -Math.floor(Math.max(0, floor - gnd - 0.4) / w.sh) : 0;
      for (let r = r0; r < w.rows; r++) {
        const yb = floor + r * w.sh + w.sill, yt = yb + w.h;
        if (yt > top - 0.4 || yb < gnd + 0.3) continue;
        const ax = cx - e.ux * w.w / 2, az = cz - e.uz * w.w / 2, bx = cx + e.ux * w.w / 2, bz = cz + e.uz * w.w / 2;
        m.quad([ax, yb, az], [bx, yb, bz], [bx, yt, bz], [ax, yt, az], w.color, [e.ox, 0, e.oz]);
      }
    }
  }
  if (front) baysOn(m, front, part, floor, ground, top);
}

function doorsOn(m, pts, part, floor) {
  const E = edges(pts);
  for (const d of part.doors || []) {
    const e = E[d.edge % E.length], s = e.L * d.t;
    const put = (w, h, off, col, shift = 0) => {
      const cx = e.p[0] + e.ux * (s + shift) + e.ox * off, cz = e.p[1] + e.uz * (s + shift) + e.oz * off;
      m.quad([cx - e.ux * w / 2, floor, cz - e.uz * w / 2], [cx + e.ux * w / 2, floor, cz + e.uz * w / 2],
             [cx + e.ux * w / 2, floor + h, cz + e.uz * w / 2], [cx - e.ux * w / 2, floor + h, cz - e.uz * w / 2], col, [e.ox, 0, e.oz]);
    };
    if (d.frame) {   // a raised stone surround: front + its sides
      const f = d.frame, t = 0.35;
      box(m, { c: [e.p[0] + e.ux * s + e.ox * t / 2, e.p[1] + e.uz * s + e.oz * t / 2], L: f.w, W: t, a: Math.atan2(e.uz, e.ux) / D2R, y0: -0.6, y1: f.h, color: f.color }, floor);
      if (d.leaves === 2) {
        put(d.w, d.h, t + 0.04, d.color, -d.w / 2 - 0.05);
        put(d.w, d.h, t + 0.04, d.color, d.w / 2 + 0.05);
      } else put(d.w, d.h, t + 0.04, d.color);
    } else put(d.w, d.h, 0.04, d.color);
  }
}

function roof(m, pts, part, yTop) {
  const R = part.roof; if (!R) return;
  if (R.type === 'flat') {
    cap(m, pts, yTop, R.color);
    if (R.parapet) {      // thin parapet: outer face + inner face + coping
      const t = R.trim || R.color;
      for (const e of edges(pts)) {
        const a = [e.p[0], yTop, e.p[1]], b = [e.q[0], yTop, e.q[1]], c = [e.q[0], yTop + R.parapet, e.q[1]], d = [e.p[0], yTop + R.parapet, e.p[1]];
        m.quad(a, b, c, d, t, [e.ox, 0, e.oz]); m.quad(a, b, c, d, shade(part.wall, 0.9), [-e.ox, 0, -e.oz]);
      }
    }
    return;
  }
  const r4 = longFirst(pts), tan = Math.tan(R.pitch * D2R), over = R.over || 0;
  const W = Math.hypot(r4[2][0] - r4[1][0], r4[2][1] - r4[1][1]), L = Math.hypot(r4[1][0] - r4[0][0], r4[1][1] - r4[0][1]);
  const [A, B, C, Dd] = grow(r4, over), yE = yTop - over * tan, yR = yTop + W / 2 * tan;
  const v = (p, y) => [p[0], y, p[1]], mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const under = shade(R.color, 0.55);
  const face = (a, b, c, d) => { if (d) { m.quad(a, b, c, d, R.color, [0, 1, 0]); m.quad(a, b, c, d, under, [0, -1, 0]); } else { m.tri(a, b, c, R.color, [0, 1, 0]); m.tri(a, b, c, under, [0, -1, 0]); } };
  if (R.type === 'gable') {
    const rDA = mid(Dd, A), rBC = mid(B, C);
    face(v(A, yE), v(B, yE), v(rBC, yR), v(rDA, yR)); face(v(C, yE), v(Dd, yE), v(rDA, yR), v(rBC, yR));
    // gable ends: wall-coloured triangles on the short walls
    for (const [p, q] of [[r4[1], r4[2]], [r4[3], r4[0]]]) {
      const e = edges(r4).find(x => x.p === p);
      m.tri(v(p, yTop), v(q, yTop), v(mid(p, q), yR), part.wall, [e.ox, 0, e.oz]);
    }
  } else {   // hip: ridge of length L − W along the middle
    const c = mid(mid(A, B), mid(C, Dd)), ux = (r4[1][0] - r4[0][0]) / L, uz = (r4[1][1] - r4[0][1]) / L, k = Math.max(0, L - W) / 2;
    const R1 = [c[0] - ux * k, c[1] - uz * k], R2 = [c[0] + ux * k, c[1] + uz * k];
    face(v(A, yE), v(B, yE), v(R2, yR), v(R1, yR)); face(v(C, yE), v(Dd, yE), v(R1, yR), v(R2, yR));
    face(v(B, yE), v(C, yE), v(R2, yR)); face(v(Dd, yE), v(A, yE), v(R1, yR));
  }
}

function porch(m, pts, P, floor, ground) {
  const outer = grow(pts, P.depth), y0 = floor + P.y, y1 = y0 - P.drop;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length, a = [pts[i][0], y0, pts[i][1]], b = [pts[j][0], y0, pts[j][1]], c = [outer[j][0], y1, outer[j][1]], d = [outer[i][0], y1, outer[i][1]];
    m.quad(a, b, c, d, P.color, [0, 1, 0]); m.quad(a, b, c, d, shade(P.color, 0.6), [0, -1, 0]);
  }
  // posts at the corners and every `every` metres along the outer edge
  for (const e of edges(outer)) {
    const n = Math.max(1, Math.round(e.L / P.every));
    for (let i = 0; i < n; i++) {
      const x = e.p[0] + e.ux * e.L * i / n - e.ox * 0.15, z = e.p[1] + e.uz * e.L * i / n - e.oz * 0.15, g = ground(x, z);
      box(m, { c: [x, z], L: 0.22, W: 0.22, a: 0, y0: g - floor - 0.2, y1: y1 - floor, color: P.post }, floor);
    }
  }
}

// b: a campus.js building with b.floor set (applyCampus); ground(x, z) = terrain height.
// far = the plain window grid, used past ~250 m.
export function buildCampusGeometry(b, ground, far = false) {
  const m = new Mesh();
  for (const part of b.parts) {
    const pts = partPts(part), floor = b.floor + (part.dy || 0);
    let lo = Infinity; for (const [x, z] of pts) lo = Math.min(lo, ground(x, z));
    const bottom = Math.min(lo, floor) - 1.5, top = floor + part.h;
    if (part.wallTop) {       // two-tone walls (lower storey / upper storey)
      walls(m, pts, bottom, floor + part.wallTop.y, part.wall); walls(m, pts, floor + part.wallTop.y, top, part.wallTop.color);
    } else walls(m, pts, bottom, top, part.wall);
    windowsOn(m, pts, part, floor, ground, top, far);
    doorsOn(m, pts, part, floor);
    roof(m, pts, part, top);
    if (part.porch) porch(m, pts, part.porch, floor, ground);
    for (const bx of part.boxes || []) box(m, bx, floor);
  }
  return m.geometry();
}

// Detailed front and the plain far copy, for a building whose windows name a bay face.
// Other buildings are pushed onto `geos` and merged by the caller.
export function placeCampus(group, lods, geos, building, ground, mat) {
  const detailed = building.parts.some(p => p.win && p.win.bays);
  if (!detailed) { geos.push(buildCampusGeometry(building, ground)); return; }
  const near = new THREE.Mesh(buildCampusGeometry(building, ground, false), mat);
  const far = new THREE.Mesh(buildCampusGeometry(building, ground, true), mat);
  near.name = 'campus-near'; far.name = 'campus-far';
  near.castShadow = near.receiveShadow = far.receiveShadow = true;
  near.visible = far.visible = false;
  let cx = 0, cz = 0, n = 0;
  for (const part of building.parts) for (const p of partPts(part)) { cx += p[0]; cz += p[1]; n++; }
  group.add(near, far);
  lods.push({ near, far, cx: cx / n, cz: cz / n });
  if (building.name === 'Main Building') { addEntranceDressing(group, ground); addCourtyardDressing(group, ground); addCampusPaint(group, ground); }
}
