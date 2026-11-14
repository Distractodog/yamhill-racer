// Campus props: lamps, benches, signs, fences, hedges and small trees.
// No three.js. Nothing here is solid, so the drive routes are unchanged.
import { hash } from './townbuild.js';
import { inPoly } from './campus.js';

const BOX = { x0: -920, x1: 180, z0: 60, z1: 720 };
const inBox = (x, z) => x >= BOX.x0 && x <= BOX.x1 && z >= BOX.z0 && z <= BOX.z1;

function lengthOf(pts) {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return n;
}

function spaced(pts, gap, phase) {
  const out = [];
  let acc = 0, next = phase;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    if (L < 0.4) continue;
    while (next <= acc + L) {
      const t = (next - acc) / L;
      out.push({ x: ax + dx * t, z: az + dz * t, lx: dz / L, lz: -dx / L, fx: dx / L, fz: dz / L });
      next += gap;
    }
    acc += L;
  }
  return out;
}

const yawOf = (fx, fz) => Math.atan2(fx, fz);
const inside = (x, z, buildings) => buildings.some(b => b.pts && b.pts.length >= 3 && inPoly(b.pts, x, z));

function put(list, spot, side, off, buildings) {
  const x = spot.x + spot.lx * side * off, z = spot.z + spot.lz * side * off;
  if (!inBox(x, z) || inside(x, z, buildings)) return;
  list.push({ x, z, yaw: yawOf(-spot.lx * side, -spot.lz * side) });
}

// Fixed spots that the photos pin to a building, not to a path.
const FIXED = {
  globes: [[-576, 490], [-576, 506]],
  lanterns: [[-442, 430], [-442, 448]],
  signs: [
    { x: -510, z: 206, yaw: 0, color: [0.15, 0.38, 0.22] },
    { x: -598, z: 244, yaw: 0.6, color: [0.92, 0.92, 0.90] },
    { x: -444, z: 454, yaw: -0.4, color: [0.93, 0.89, 0.76] },
  ],
  bollards: [[-540, 354], [-536, 358], [-532, 354], [-528, 350]],
  fences: [
    { x: -790, z: 588, yaw: 0.4 }, { x: -788, z: 586, yaw: 0.4 },
    { x: -832, z: 600, yaw: 0.3 }, { x: -834, z: 598, yaw: 0.3 },
    { x: -808, z: 508, yaw: 1.2 }, { x: -806, z: 510, yaw: 1.2 },
  ],
};

export function placeCampusItems({ paths, buildings }) {
  const discs = [], benches = [], hedges = [], trees = [];
  const buildingsSafe = buildings || [];
  for (const p of paths || []) {
    if (p.cls !== 'trail' || lengthOf(p.pts) < 24) continue;
    const off = (p.w || 4) / 2 + 1.6;
    const phase = 8 + hash(p.pts[0][0], p.pts[0][1])() * 10;
    for (const s of spaced(p.pts, 26, phase)) {
      if (!inBox(s.x, s.z)) continue;
      const h = hash(s.x, s.z)();
      put(discs, s, -1, off, buildingsSafe);
      if (h < 0.34) put(benches, s, 1, off + 0.4, buildingsSafe);
      if (h < 0.28) put(hedges, s, 1, off + 1.2, buildingsSafe);
      if (h < 0.2) put(trees, s, -1, off + 2.4, buildingsSafe);
    }
  }
  const keep = (x, z) => inBox(x, z) && !inside(x, z, buildingsSafe);
  const globes = FIXED.globes.filter(([x, z]) => keep(x, z)).map(([x, z]) => ({ x, z, yaw: 0.4 }));
  const lanterns = FIXED.lanterns.filter(([x, z]) => keep(x, z)).map(([x, z]) => ({ x, z, yaw: 1.2 }));
  const signs = FIXED.signs.filter(s => keep(s.x, s.z));
  const bollards = FIXED.bollards.filter(([x, z]) => keep(x, z)).map(([x, z]) => ({ x, z, yaw: 0 }));
  const fences = FIXED.fences.filter(s => keep(s.x, s.z));
  return { discs, globes, lanterns, benches, signs, fences, hedges, trees, bollards };
}
