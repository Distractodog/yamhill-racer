// Rules that turn an OSM footprint into building parts. No three.js and no DOM, so Node
// tests and the later mesh builder share one plan. Part fields match campus.js (h, wall,
// roof, win, doors) and wallH is the same number as h. Roofs sit on the wall outline
// (over is 0), so a roof never sticks out past its walls.
import { inPoly, partTop } from './campus.js';

const GLASS = [0.27, 0.33, 0.40];
const TRIM = [0.93, 0.91, 0.86];
const DOOR = [0.28, 0.20, 0.14];
const WALLS = [[0.72, 0.70, 0.66], [0.78, 0.68, 0.52], [0.62, 0.68, 0.60], [0.58, 0.64, 0.70], [0.90, 0.88, 0.84]];
const ROOFS = [[0.28, 0.27, 0.26], [0.40, 0.28, 0.20], [0.45, 0.44, 0.42]];
const BRICK = [0.62, 0.32, 0.26];
const STUCCO = [0.86, 0.82, 0.74];
const METAL = [0.72, 0.74, 0.76];

const MAIN = /^(motorway|trunk|primary|secondary|tertiary)/;

export function hash(x, z) {
  let s = (Math.imul(Math.round(x * 10), 0x9e3779b1) ^ Math.imul(Math.round(z * 10), 0x85ebca6b)) >>> 0;
  if (s === 0) s = 1;
  return () => ((s = Math.imul(s, 1664525) + 1013904223 >>> 0) / 4294967296);
}

const centroid = pts => {
  let x = 0, z = 0;
  for (const p of pts) { x += p[0]; z += p[1]; }
  return [x / pts.length, z / pts.length];
};
const areaOf = pts => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a) / 2;
};
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
function edgeDist(p, a, b) {
  const abx = b[0] - a[0], abz = b[1] - a[1], den = abx * abx + abz * abz || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / den));
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + abz * t));
}
function insideFoot(foot, q) {
  const c = centroid(q);
  if (!inPoly(foot, c[0], c[1])) return false;
  for (const p of q) {
    if (inPoly(foot, p[0], p[1])) continue;
    let near = false;
    for (let i = 0; i < foot.length; i++) if (edgeDist(p, foot[i], foot[(i + 1) % foot.length]) <= 0.35) { near = true; break; }
    if (!near) return false;
  }
  return true;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = v => Math.hypot(v[0], v[1]);

function longestEdgeAngle(pts) {
  let best = 0, ang = 0;
  for (let i = 0; i < pts.length; i++) {
    const d = sub(pts[(i + 1) % pts.length], pts[i]), L = len(d);
    if (L > best) { best = L; ang = Math.atan2(d[1], d[0]); }
  }
  return ang;
}
function rotate(pts, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return pts.map(([x, z]) => [x * c + z * s, -x * s + z * c]);
}
function unrotate(pts, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return pts.map(([x, z]) => [x * c - z * s, x * s + z * c]);
}
function bounds(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return { x0, x1, z0, z1, L: x1 - x0, W: z1 - z0 };
}
function snap(vals, tol) {
  const s = [...vals].sort((a, b) => a - b), out = [];
  for (const v of s) {
    if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  }
  return out;
}
function axisAligned(local) {
  for (let i = 0; i < local.length; i++) {
    const d = sub(local[(i + 1) % local.length], local[i]);
    if (len(d) < 0.2) continue;
    const a = Math.atan2(Math.abs(d[1]), Math.abs(d[0]));
    if (a > 0.18 && a < Math.PI / 2 - 0.18) return false;
  }
  return true;
}
function quad(x0, x1, z0, z1) {
  return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
}
// An orthogonal rectangle stays one part. An orthogonal L (three of four cells) becomes two quads.
function decompose(world, ang) {
  const local = rotate(world, -ang);
  if (world.length < 3 || !axisAligned(local)) return [world.map(p => [p[0], p[1]])];
  const box = bounds(local);
  if (box.L < 0.5 || box.W < 0.5) return [world.map(p => [p[0], p[1]])];
  const xs = snap(local.map(p => p[0]), Math.max(0.6, box.L * 0.04));
  const zs = snap(local.map(p => p[1]), Math.max(0.6, box.W * 0.04));
  const back = qs => qs.map(q => unrotate(q, -ang));
  if (xs.length === 2 && zs.length === 2 && world.length <= 5) return [world.map(p => [p[0], p[1]])];
  if (xs.length !== 3 || zs.length !== 3) return [world.map(p => [p[0], p[1]])];
  const inside = [[false, false], [false, false]];
  let n = 0;
  for (let i = 0; i < 2; i++) for (let k = 0; k < 2; k++) {
    const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[k] + zs[k + 1]) / 2;
    let hit = false;
    for (const [x, z] of local) if (Math.abs(x - cx) < (xs[i + 1] - xs[i]) / 2 && Math.abs(z - cz) < (zs[k + 1] - zs[k]) / 2) hit = true;
    // A cell is filled when its centre is inside the footprint.
    if (!hit) {
      let c = false;
      for (let a = 0, b = local.length - 1; a < local.length; b = a++) {
        const [x1, z1] = local[b], [x2, z2] = local[a];
        if ((z2 > cz) !== (z1 > cz) && cx < (x1 - x2) * (cz - z2) / (z1 - z2) + x2) c = !c;
      }
      hit = c;
    }
    inside[i][k] = hit; if (hit) n++;
  }
  if (n !== 3) return [world.map(p => [p[0], p[1]])];
  let mx = 0, mz = 0;
  for (let i = 0; i < 2; i++) for (let k = 0; k < 2; k++) if (!inside[i][k]) { mx = i; mz = k; }
  const row = 1 - mz, col = 1 - mx;
  return back([
    quad(xs[0], xs[2], zs[row], zs[row + 1]),
    quad(xs[col], xs[col + 1], zs[mz], zs[mz + 1]),
  ]);
}

function closestRoad(x, z, roads) {
  let bestD = Infinity, mainD = Infinity, point = null;
  for (const r of roads || []) {
    const main = MAIN.test(r.cls || '');
    const line = r.pts || [];
    for (const p of line) {
      const d = Math.hypot(p[0] - x, p[1] - z);
      if (d < bestD) { bestD = d; point = p; }
      if (main && d < mainD) mainD = d;
    }
  }
  return { bestD, mainD, point };
}

function classify(area, aspect, osmH, mainD) {
  if (area < 40) return 'outbuilding';
  if (osmH >= 11 && area >= 70 && area <= 500 && aspect < 2) return 'church';
  if (area >= 800 && area <= 3000 && aspect < 1.75 && mainD > 30) return 'school';
  if (area >= 1500 && mainD > 40) return 'warehouse';
  if (area >= 600 || (area >= 350 && mainD < 22)) return 'commercial';
  if (area >= 350) return 'apartment';
  return 'house';
}

function facingEdge(pts, toward) {
  if (!toward) {
    let best = 0, L = -1;
    for (let i = 0; i < pts.length; i++) {
      const d = len(sub(pts[(i + 1) % pts.length], pts[i]));
      if (d > L) { L = d; best = i; }
    }
    return best;
  }
  let best = 0, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const d = Math.hypot((a[0] + b[0]) / 2 - toward[0], (a[1] + b[1]) / 2 - toward[1]);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function cutQuad(q, t) {
  const a = lerp(q[0], q[1], t), b = lerp(q[3], q[2], t);
  return [[q[0], a, b, q[3]], [a, q[1], q[2], b]];
}

function winRow(rows, sh, extra = {}) {
  return { rows, sh, sill: 0.9, w: 1.2, h: 1.25, every: 2.8, color: GLASS, margin: 1.1, ...extra };
}

export function planBuilding(footprint, context = {}) {
  const src = (footprint.pts || []).map(p => [p[0], p[1]]);
  if (src.length < 3) {
    const part = { pts: src, h: 2.4, wallH: 2.4, wall: WALLS[0], colour: { wall: WALLS[0], trim: TRIM, roof: ROOFS[2] },
      roof: { type: 'flat', pitch: 0, color: ROOFS[2], parapet: 0.2, over: 0 }, win: null, windows: null, doors: [], awnings: [] };
    return { kind: 'outbuilding', parts: [part], top: partTop(part) };
  }
  const [cx, cz] = centroid(src);
  const rnd = hash(cx, cz);
  const area = areaOf(src);
  const ang = longestEdgeAngle(src);
  const box = bounds(rotate(src, -ang));
  const aspect = Math.max(box.L, box.W) / Math.max(0.5, Math.min(box.L, box.W));
  const near = closestRoad(cx, cz, context.roads);
  const kind = classify(area, aspect, footprint.h || 0, near.mainD);
  let quads = decompose(src, ang).filter(q => areaOf(q) > 1 && insideFoot(src, q));
  const covered = quads.reduce((s, q) => s + areaOf(q), 0);
  if (!quads.length || covered > area * 1.05) quads = [src];

  const levels = kind === 'outbuilding' || kind === 'warehouse' || kind === 'church' ? 1
    : kind === 'house' ? (area < 130 || rnd() < 0.45 ? 1 : 2)
    : kind === 'school' ? (rnd() < 0.5 ? 1 : 2)
    : kind === 'apartment' ? 2 + (rnd() < 0.5 ? 0 : 1)
    : 1 + Math.floor(rnd() * 3);
  const wallH = kind === 'outbuilding' ? 2.5
    : kind === 'warehouse' ? 5.5
    : kind === 'church' ? 8
    : kind === 'school' ? 3.4 * levels
    : 3.0 * levels;

  let wall = WALLS[Math.floor(rnd() * WALLS.length)];
  let roofCol = ROOFS[Math.floor(rnd() * ROOFS.length)];
  if (kind === 'commercial') wall = rnd() < 0.5 ? BRICK : STUCCO;
  if (kind === 'warehouse') { wall = METAL; roofCol = [0.55, 0.56, 0.57]; }
  if (kind === 'church') wall = WALLS[4];
  const trim = TRIM;

  const roofFor = (partKind, q) => {
    if (partKind === 'commercial' || partKind === 'apartment' && rnd() < 0.7) {
      return { type: 'flat', pitch: 0, color: roofCol, parapet: partKind === 'commercial' ? 0.9 : 0.4, over: 0 };
    }
    if (q.length !== 4) return { type: 'flat', pitch: 0, color: roofCol, parapet: 0.3, over: 0 };
    if (partKind === 'outbuilding') return { type: 'gable', pitch: 18 + rnd() * 6, color: roofCol, parapet: 0, over: 0 };
    if (partKind === 'warehouse') return { type: 'gable', pitch: 12, color: roofCol, parapet: 0, over: 0 };
    if (partKind === 'church') return { type: 'gable', pitch: 46 + rnd() * 6, color: ROOFS[0], parapet: 0, over: 0 };
    if (partKind === 'school') return { type: rnd() < 0.5 ? 'hip' : 'flat', pitch: rnd() < 0.5 ? 22 : 0, color: roofCol, parapet: 0.4, over: 0 };
    const hip = rnd() < 0.45;
    return { type: hip ? 'hip' : 'gable', pitch: 20 + rnd() * 15, color: roofCol, parapet: 0, over: 0 };
  };

  // Attached garage: cut a strip off the back of a single house rectangle.
  let garage = null;
  if (kind === 'house' && quads.length === 1 && quads[0].length === 4 && rnd() < 0.35) {
    const span = len(sub(quads[0][1], quads[0][0]));
    if (span > 9) {
      const pieces = cutQuad(quads[0], 1 - 3.2 / span);
      quads = [pieces[0]];
      garage = pieces[1];
    }
  }

  const doorAt = facingEdge(quads[0], near.point);
  const parts = [];
  const add = (q, partKind, extra) => {
    const h = partKind === 'garage' ? 2.6 : wallH;
    const roof = partKind === 'garage'
      ? { type: 'gable', pitch: 18, color: roofCol, parapet: 0, over: 0 }
      : roofFor(partKind, q);
    const win = partKind === 'outbuilding' || partKind === 'garage' ? null
      : partKind === 'commercial' ? winRow(1, h, { sill: 0.15, w: 1.8, h: 2.0, every: 2.2, margin: 0.4 })
      : partKind === 'warehouse' ? null
      : partKind === 'church' ? winRow(1, h, { sill: 2.2, w: 1.1, h: 3.4, every: 2.4 })
      : winRow(partKind === 'house' || partKind === 'school' || partKind === 'apartment' ? levels : 1, h / levels);
    const doors = partKind === 'garage'
      ? [{ edge: 1, t: 0.5, w: 2.6, h: 2.3, color: [0.82, 0.80, 0.76] }]
      : partKind === 'outbuilding' ? []
      : partKind === 'warehouse' ? [{ edge: doorAt % q.length, t: 0.5, w: 3.2, h: 3.4, color: [0.45, 0.46, 0.47] }]
      : [{ edge: (partKind === kind ? doorAt : 0) % q.length, t: 0.42, w: partKind === 'commercial' ? 1.4 : 1.0, h: 2.15, color: DOOR }];
    const porch = partKind === 'house' ? { edge: doorAt % q.length, t: 0.42, w: 2.4, d: 1.3 } : null;
    const awnings = partKind === 'commercial' ? [{ edge: doorAt % q.length, t: 0.5, w: Math.min(8, len(sub(q[(doorAt + 1) % q.length], q[doorAt % q.length])) * 0.8), d: 1.1 }] : [];
    const part = {
      pts: q, h, wallH: h, wall, colour: { wall, trim, roof: roof.color },
      roof, win, windows: win, doors, awnings, porch,
    };
    if (partKind === 'church') {
      const [px, pz] = centroid(q);
      part.boxes = [{ c: [px, pz], L: 1.6, W: 1.6, a: 0, y0: h, y1: h + 7, color: wall }];
    }
    if (extra) Object.assign(part, extra);
    parts.push(part);
  };
  quads.forEach((q, i) => add(q, i === 0 ? kind : kind));
  if (garage) add(garage, 'garage');
  // A second rectangle of an L keeps the same kind; its door edge is 0 when it is not the front piece.
  if (parts.length > 1 && garage) parts[parts.length - 1].doors[0].edge = 1;
  const top = parts.reduce((m, p) => Math.max(m, partTop(p)), 0);
  return { kind, parts, top };
}
