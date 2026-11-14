// Meshes for town buildings planned by townbuild.js. One merged mesh per 200 m block,
// with a simpler copy past 300 m. Walls, roofs, windows and doors come from the campus
// mesh builder; colours are converted to linear there. Campus buildings are not handled here.
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildCampusGeometry } from './campusmodel.js';
import { planBuilding } from './townbuild.js';

const CELL = 200;
const MAIN = /^(motorway|trunk|primary|secondary|tertiary)/;

// A short sample of each road, split into "main" and "other", for door facing and class.
export function roadContext(roads) {
  const all = [], main = [];
  for (const r of roads || []) {
    const cls = String(r.osm || '').split(':')[0];
    const n = r.n || 0;
    const step = Math.max(1, Math.floor(n / 6));
    for (let i = 0; i < n; i += step) {
      const p = [r.x[i], r.z[i]];
      all.push(p);
      if (MAIN.test(cls)) main.push(p);
    }
  }
  return [{ cls: 'residential', pts: all }, { cls: 'primary', pts: main }];
}

function floorOf(pts, ground) {
  let s = 0;
  for (const [x, z] of pts) s += ground(x, z);
  return s / pts.length;
}

function forMesh(parts, detailed) {
  return parts.map(p => detailed ? { ...p, porch: null }
    : { ...p, porch: null, win: null, windows: null, doors: [], awnings: [], boxes: undefined });
}

export function blockOf(plan) {
  const pts = plan.parts[0]?.pts || [];
  let sx = 0, sz = 0;
  for (const p of pts) { sx += p[0]; sz += p[1]; }
  const cx = sx / Math.max(1, pts.length), cz = sz / Math.max(1, pts.length);
  return {
    key: Math.floor(cx / CELL) + ',' + Math.floor(cz / CELL),
    cx: Math.floor(cx / CELL) * CELL + CELL / 2,
    cz: Math.floor(cz / CELL) * CELL + CELL / 2,
  };
}

// Near mesh (windows and doors) and a far mesh (walls and roof only).
export function footprintMeshes(plan, ground) {
  const pts = plan.parts[0]?.pts || [];
  if (pts.length < 3) return null;
  try {
    const floor = floorOf(pts, ground);
    const near = buildCampusGeometry({ floor, parts: forMesh(plan.parts, true) }, ground);
    const far = buildCampusGeometry({ floor, parts: forMesh(plan.parts, false) }, ground);
    if (!near.getAttribute('position')?.count) { near.dispose(); far.dispose(); return null; }
    return { near, far };
  } catch {
    return null;
  }
}

export function mergeBlock(geos) {
  const list = geos.filter(g => g && g.getAttribute('position')?.count);
  if (!list.length) return null;
  const merged = list.length === 1 ? list[0] : mergeGeometries(list);
  if (list.length > 1) list.forEach(g => g.dispose());
  merged.computeBoundingSphere();
  return merged;
}

// One footprint → its plan. Used by the tile builder so a tile can yield between buildings.
export function planFootprint(footprint, roads) {
  return planBuilding(footprint, { roads });
}
