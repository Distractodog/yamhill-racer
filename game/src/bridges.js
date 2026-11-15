// Visual-only bridge furniture. Deck heights/cross slopes come from the baked road strip;
// foundations use raw terrain (including river beds), never the elevated road query.
import * as THREE from 'three';
import { PATH_KINDS } from './data.js';

const CONCRETE = 0xb5b6ae, RAIL = 0xc8cbc4, STEEL = 0x95b9a1;
const DEPTH = 1.2;
class Builder {
  constructor() { this.p = []; this.c = []; }
  beam(a, b, width, depth, hex) {
    const along = new THREE.Vector3().subVectors(new THREE.Vector3(...b), new THREE.Vector3(...a));
    if (along.lengthSq() < 1e-8) return;
    along.normalize();
    const side = new THREE.Vector3().crossVectors(along, Math.abs(along.y) > .95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(width / 2);
    const up = new THREE.Vector3().crossVectors(side, along).normalize().multiplyScalar(depth / 2);
    const pts = [a, b].flatMap(p => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, u]) =>
      [p[0] + side.x * s + up.x * u, p[1] + side.y * s + up.y * u, p[2] + side.z * s + up.z * u]));
    this.solid(pts, hex);
  }
  solid(pts, hex) {
    const col = new THREE.Color(hex); // three.js converts sRGB hex to linear vertex colour
    for (const [i, j, k, l] of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]])
      for (const n of [i, k, j, i, l, k]) { this.p.push(...pts[n]); this.c.push(col.r, col.g, col.b); }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeVertexNormals(); g.computeBoundingSphere(); return g;
  }
}
function station(r) {
  const cum = [0];
  for (let i = 1; i < r.n; i++) cum.push(cum[i - 1] + Math.hypot(r.x[i] - r.x[i - 1], r.z[i] - r.z[i - 1]));
  const length = cum.at(-1);
  const at = (s, offset = 0, lift = 0) => {
    s = Math.max(0, Math.min(length, s)); let i = 1;
    while (i < r.n - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / Math.max(1e-8, cum[i] - cum[i - 1]);
    const mix = a => a[i - 1] + (a[i] - a[i - 1]) * t;
    return [mix(r.x) + mix(r.lx) * offset, mix(r.y) + mix(r.c) * offset + lift, mix(r.z) + mix(r.lz) * offset];
  };
  return { length, at };
}
// prepRoad deliberately omits visual metadata. Restore it only on render strips, before
// roads.columns() is used; physics strips and world queries remain unchanged.
function tagRoads(td) {
  const paths = (td.sourcePaths || []).filter(p => PATH_KINDS[p.kind] && p.pts.length > 1);
  td.renderRoads.forEach((r, i) => { r.bridge = paths[i] ? paths[i].bridge || false : r.bridge || false; });
  return td.renderRoads.filter(r => r.bridge && r.n > 1);
}
function lowerRoadAt(td, bridge, p) {
  for (const r of td.renderRoads) {
    if (r === bridge) continue;
    for (let i = 1; i < r.n; i++) {
      const dx = r.x[i] - r.x[i - 1], dz = r.z[i] - r.z[i - 1], len2 = dx * dx + dz * dz;
      const t = Math.max(0, Math.min(1, ((p[0] - r.x[i - 1]) * dx + (p[2] - r.z[i - 1]) * dz) / (len2 || 1)));
      const y = r.y[i - 1] + (r.y[i] - r.y[i - 1]) * t;
      if (y < p[1] - 2 && Math.hypot(p[0] - r.x[i - 1] - dx * t, p[2] - r.z[i - 1] - dz * t) < r.hw + Math.max(...r.sw) + 3) return true;
    }
  }
  return false;
}
function addBridge(td, r, m, far, report) {
  const { length: L, at } = station(r), sides = [r.hw + r.sw[0], -(r.hw + r.sw[1])];
  // Concrete fascia outside the road skirt, and a closed slab underneath it. Sample
  // the road every ~4 m (~12 m far) to follow curved/superelevated decks.
  const n = Math.max(1, Math.ceil(L / (far ? 12 : 4)));
  for (let i = 0; i < n; i++) {
    const a = L * i / n, b = L * (i + 1) / n;
    // Each half follows its own cross slope; its top stays below the road surface.
    for (const [j, edge] of sides.entries()) {
      const lo = Math.min(0, edge), hi = Math.max(0, edge);
      m.solid([a, b].flatMap(s => [at(s, hi, -DEPTH), at(s, lo, -DEPTH), at(s, lo, -.03), at(s, hi, -.03)]), CONCRETE);
      m.beam(at(a, edge + (j ? -.15 : .15), -.55), at(b, edge + (j ? -.15 : .15), -.55), .3, DEPTH, CONCRETE);
      if (!far) for (const h of [.55, 1.1]) m.beam(at(a, edge, h), at(b, edge, h), .16, .16, r.bridge === 'truss' ? STEEL : RAIL);
    }
  }
  if (!far) for (let s = 0; s <= L + .01; s += L / Math.max(1, Math.ceil(L / 4)))
    for (const edge of sides) m.beam(at(s, edge, .05), at(s, edge, 1.18), .22, .22, CONCRETE);
  // Piers at span ends and approximately every 25 m. Skip any support over a lower
  // road's corridor; flanking supports carry that opening instead.
  const count = Math.max(1, Math.ceil(L / 25));
  for (let i = 0; i <= count; i++) {
    if (r.bridge === 'truss' && i !== 0 && i !== count) continue;
    const s = Math.min(L - .7, Math.max(.7, L * i / count));
    for (const edge of sides) {
      const top = at(s, edge * .72, -DEPTH), ground = td.terrainAt(top[0], top[2]);
      if (!Number.isFinite(ground) || ground >= top[1] || lowerRoadAt(td, r, top)) continue;
      const bottom = [top[0], ground - .4, top[2]];
      m.beam(bottom, top, 1.2, 1.6, CONCRETE);
      if (!far) report.piers.push({ bottom, top, ground });
    }
  }
  if (r.bridge !== 'truss') return;
  const panels = 8, trussSides = sides.map((s, i) => s + (i ? -.55 : .55));
  // Polygonal Parker top chord: ends slope upward toward the central crown.
  // The lowest overhead member remains >6 m above even the higher sidewalk edge.
  const crown = i => 7.4 + 3.1 * Math.sin(Math.PI * i / panels);
  for (const edge of trussSides) {
    for (let i = 0; i <= panels; i++) {
      const s = L * i / panels;
      m.beam(at(s, edge, .3), at(s, edge, crown(i)), .32, .36, STEEL);
      if (i === panels) continue;
      const t = L * (i + 1) / panels;
      m.beam(at(s, edge, .3), at(t, edge, .3), .38, .42, STEEL);
      m.beam(at(s, edge, crown(i)), at(t, edge, crown(i + 1)), .38, .42, STEEL);
      if (!far) { // Pratt diagonals descend toward the centre of the span
        const inward = i < panels / 2;
        m.beam(at(inward ? s : t, edge, inward ? crown(i) : crown(i + 1)), at(inward ? t : s, edge, .3), .23, .26, STEEL);
      }
    }
  }
  for (let i = 0; i <= panels; i++) {
    const s = L * i / panels;
    const a = at(s, trussSides[0], crown(i)), b = at(s, trussSides[1], crown(i));
    m.beam(a, b, .3, .4, STEEL); // end members also form the portal lintels
    if (!far) report.overhead.push({ a, b, clearance: Math.min(a[1], b[1]) - .2 - Math.max(at(s, sides[0])[1], at(s, sides[1])[1]) });
    if (!far && i < panels) {
      const t = L * (i + 1) / panels;
      m.beam(a, at(t, trussSides[1], crown(i + 1)), .14, .14, STEEL);
      m.beam(b, at(t, trussSides[0], crown(i + 1)), .14, .14, STEEL);
    }
  }
}
// One merged mesh per tile per level; no per-frame geometry work or extra shadows.
export function* buildBridgeSteps(td, material) {
  const roads = tagRoads(td); if (!roads.length) return null;
  const report = { piers: [], overhead: [] }, meshes = [];
  for (const far of [false, true]) {
    const m = new Builder();
    for (const r of roads) { addBridge(td, r, m, far, report); yield 'bridges'; }
    const mesh = new THREE.Mesh(m.geometry(), material); mesh.name = far ? 'bridges-far' : 'bridges';
    mesh.receiveShadow = !far; mesh.visible = far; meshes.push(mesh);
  }
  const bounds = roads.map(r => { const { length, at } = station(r); const p = at(length / 2); return { x: p[0], z: p[2], radius: length / 2 }; });
  return { near: meshes[0], far: meshes[1], bounds, report };
}
export function showBridges(bridges, cam) {
  if (!bridges) return;
  const near = bridges.bounds.some(b => Math.hypot(cam.x - b.x, cam.z - b.z) < b.radius + 350);
  bridges.near.visible = near; bridges.far.visible = !near;
}
