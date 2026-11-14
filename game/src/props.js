// Where street props stand. No three.js. A tile's paths, junctions and footprints pick
// the spots; the same coordinates always give the same spots. Props are not solid.
import { hash } from './townbuild.js';

const TOWN = /^(residential|tertiary|secondary|primary|unclassified)$/;
const LIGHT_GAP = 42, POLE_GAP = 56, MAIL_GAP = 76;
const CAMPUS = { x0: -900, x1: -350, z0: 130, z1: 650 };

const inCampus = (x, z) => x >= CAMPUS.x0 && x <= CAMPUS.x1 && z >= CAMPUS.z0 && z <= CAMPUS.z1;
const town = p => (p.kind === 'asphalt' || p.kind === 'gravel') && TOWN.test(p.cls || '');

function lengthOf(pts) {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return n;
}

// Points `gap` metres apart, starting `phase` metres in. Left normal matches the road mesh.
function spaced(pts, gap, phase) {
  const out = [];
  let acc = 0, next = phase;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    if (L < 0.4) continue;
    while (next <= acc + L) {
      const t = (next - acc) / L;
      out.push({ x: ax + dx * t, z: az + dz * t, lx: dz / L, lz: -dx / L });
      next += gap;
    }
    acc += L;
  }
  return out;
}

function yawOf(fx, fz) { return Math.atan2(fx, fz); }

// side +1 is the left of the path, -1 the right. The stored yaw points the prop's front at the road.
function drop(list, spot, side, off) {
  const x = spot.x + spot.lx * side * off, z = spot.z + spot.lz * side * off;
  if (inCampus(x, z)) return;
  const face = side > 0 ? -1 : 1;   // front looks back toward the centre line
  list.push({ x, z, yaw: yawOf(spot.lx * face, spot.lz * face) });
}

function nearJunction(grid, x, z) {
  const G = 40, gx = Math.floor(x / G), gz = Math.floor(z / G);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const list = grid.get((gx + dx) + ',' + (gz + dz));
    if (!list) continue;
    for (let i = 0; i < list.length; i += 2) if (Math.hypot(list[i] - x, list[i + 1] - z) < 11) return true;
  }
  return false;
}

function junctionGrid(junctions) {
  const grid = new Map(), G = 40;
  for (const j of junctions || []) {
    if (!j.c) continue;
    const k = Math.floor(j.c[0] / G) + ',' + Math.floor(j.c[1] / G);
    let list = grid.get(k); if (!list) grid.set(k, list = []); list.push(j.c[0], j.c[1]);
  }
  return grid;
}

function roadGrid(paths) {
  const grid = new Map(), G = 40;
  for (const p of paths) {
    if (p.kind === 'trail') continue;
    for (const [x, z] of p.pts || []) {
      const k = Math.floor(x / G) + ',' + Math.floor(z / G);
      let list = grid.get(k); if (!list) grid.set(k, list = []); list.push(x, z);
    }
  }
  return grid;
}

function nearestRoad(grid, x, z) {
  const G = 40, gx = Math.floor(x / G), gz = Math.floor(z / G);
  let best = 1e9;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const list = grid.get((gx + dx) + ',' + (gz + dz));
    if (!list) continue;
    for (let i = 0; i < list.length; i += 2) best = Math.min(best, Math.hypot(list[i] - x, list[i + 1] - z));
  }
  return best;
}

function addStops(stops, p) {
  const pts = p.pts;
  if (!p.stop || pts.length < 2) return;
  const ends = [[0, p.stop[0]], [pts.length - 1, p.stop[1]]];
  for (const [i, flag] of ends) {
    if (!flag) continue;
    const j = i === 0 ? 1 : pts.length - 2;
    const ax = pts[i][0], az = pts[i][1], bx = pts[j][0], bz = pts[j][1];
    const L = Math.hypot(bx - ax, bz - az) || 1;
    const hx = (ax - bx) / L, hz = (az - bz) / L;          // heading of a car arriving at this end
    const rx = -hz, rz = hx;                               // its right
    const back = Math.min(6.5, L * 0.45);
    const x = ax + (bx - ax) / L * back + rx * (p.w / 2 + 0.9);
    const z = az + (bz - az) / L * back + rz * (p.w / 2 + 0.9);
    if (inCampus(x, z)) continue;
    stops.push({ x, z, yaw: yawOf(-hx, -hz) });
  }
}

function addFences(fences, buildings, paths) {
  const roads = roadGrid(paths);
  for (const b of buildings || []) {
    const pts = b.pts;
    if (!pts || pts.length < 4 || b.campusPart) continue;
    let area = 0, cx = 0, cz = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
      area += x1 * z2 - x2 * z1; cx += x1; cz += z1;
    }
    area = Math.abs(area) / 2; cx /= pts.length; cz /= pts.length;
    if (area < 55 || area > 480 || inCampus(cx, cz)) continue;
    if (hash(cx, cz)() > 0.22) continue;
    let best = null;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (len < 7 || len > 34) continue;
      const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
      const d = nearestRoad(roads, mx, mz);
      if (d < 8 || d > 26) continue;
      if (!best || d > best.d) best = { a, c, len, d, mx, mz };
    }
    if (!best) continue;
    const ex = best.c[0] - best.a[0], ez = best.c[1] - best.a[1], L = best.len;
    const lx = ez / L, lz = -ex / L;
    const sgn = (lx * (cx - best.mx) + lz * (cz - best.mz)) > 0 ? -1 : 1;
    const ox = lx * sgn * 0.55, oz = lz * sgn * 0.55;
    const yaw = Math.atan2(-ez / L, ex / L);
    const nSeg = Math.min(12, Math.max(1, Math.round(L / 2.4)));
    for (let s = 0; s < nSeg; s++) {
      const t = (s + 0.5) / nSeg;
      const x = best.a[0] + ex * t + ox, z = best.a[1] + ez * t + oz;
      if (!inCampus(x, z)) fences.push({ x, z, yaw });
    }
  }
}

// tile: { paths, junctions, buildings } as stored in tile.json (buildings may already be the campus swap).
export function placeProps(tile) {
  const lights = [], poles = [], lines = [], stops = [], mailboxes = [], fences = [];
  const junctions = junctionGrid(tile.junctions);
  for (const p of tile.paths || []) {
    if (!town(p) || !p.pts || p.pts.length < 2) continue;
    const total = lengthOf(p.pts);
    const phase = hash(p.pts[0][0], p.pts[0][1]);
    if (total > 24) {
      for (const s of spaced(p.pts, LIGHT_GAP, LIGHT_GAP * (0.2 + phase() * 0.6))) {
        if (nearJunction(junctions, s.x, s.z)) continue;
        drop(lights, s, -1, p.w / 2 + 2.2);
      }
      const run = [];
      for (const s of spaced(p.pts, POLE_GAP, POLE_GAP * (0.25 + phase() * 0.5))) {
        if (nearJunction(junctions, s.x, s.z)) continue;
        const before = poles.length;
        drop(poles, s, 1, p.w / 2 + 3.4);
        if (poles.length > before) run.push(poles[poles.length - 1]);
      }
      for (let i = 1; i < run.length; i++) {
        const a = run[i - 1], b = run[i], d = Math.hypot(b.x - a.x, b.z - a.z);
        if (d > 12 && d < 78) lines.push({ x: a.x, z: a.z, x2: b.x, z2: b.z });
      }
    }
    if (p.cls === 'residential' && total > 30) {
      for (const s of spaced(p.pts, MAIL_GAP, MAIL_GAP * (0.3 + phase() * 0.4))) {
        if (hash(s.x, s.z)() > 0.45) continue;
        drop(mailboxes, s, -1, p.w / 2 + 2.8);
      }
    }
    addStops(stops, p);
  }
  addFences(fences, tile.buildings, tile.paths || []);
  return { lights, poles, lines, stops, mailboxes, fences };
}
