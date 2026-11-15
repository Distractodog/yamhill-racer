// Pure world data + queries (no rendering). Shared by the game and the headless test drives.
// World space: metres, x = east, z = south, y = up. The world is cut into square tiles (world.json); each tile's
// data is loaded separately (makeTileData) and registered with the world (makeWorld), which routes every query
// to the tile that contains the point.
import * as THREE from 'three';
import { sidewalkSides, KERB } from './roads.js';
import { roadHalfWidth, roadEdge, triangleHeight } from './ramps.js';
import { bridgeJunction } from './bridgequeries.js';
import { applyCampus } from './campus.js';
import { applyTrack } from './campustrack.js';
import { campusDrive } from './campusdrive.js';
import { applyLandmarks } from './landmarks.js';

// road / trail strips and junction pieces: surface class per kind. Heights come baked from the build
// (tools/roadnet.py): each strip point has a centre-line height y and a cross slope c (height per metre to the left).
export const PATH_KINDS = {
  asphalt: { cls: 3 },
  gravel: { cls: 4 },
  trail: { cls: 2 },
};
export const STEP = 1.5;
// A deck supports callers within 3 m below it or higher. Omit y for placement's highest surface.
export const BRIDGE_CLIMB = 3;
// jump ramps (challenges): a wedge laid on the road. u = metres along from the foot, v = across.
// Up 11 m to 2.2 m high (~11°), 2 m flat top, then an 18 m gentle back so the wrong way is a bump, not a wall.
export const RAMP = { up: 11, top: 2, down: 18, h: 2.2 };
export const RAMP_LEN = RAMP.up + RAMP.top + RAMP.down;
export function rampShape(u) {          // [height, d height / du]
  const { up, top, down, h } = RAMP;
  if (u <= 0 || u >= RAMP_LEN) return [0, 0];
  if (u < up) return [h * u / up, h / up];
  if (u < up + top) return [h, 0];
  return [h * (1 - (u - up - top) / down), -h / down];
}
export function trunkRadius(h, broad) { return broad ? 0.25 + h * 0.015 : 0.3 + h * 0.012; }

// polyline -> strip samples every <= STEP m with left-pointing unit normals, heights and cross slopes
export function prepRoad(p, id) {
  const K = PATH_KINDS[p.kind]; if (!K) return null;
  const pts = p.pts, yc = p.yc || pts.map(() => [0, 0]), xs = [], zs = [], ys = [], cs = [], ss = [];
  let distance = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], [ay, ac] = yc[i], [by, bc] = yc[i + 1];
    const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / STEP));
    const fractions = Array.from({ length: n }, (_, k) => k / n);
    if (p.widen) {
      for (const [, s0, s1] of p.widen) for (const s of [s0, s1]) {
        if (s > distance && s < distance + L) fractions.push((s - distance) / L);
      }
      fractions.sort((a, b) => a - b);
    }
    for (const t of p.widen ? [...new Set(fractions)] : fractions) {
      ss.push(distance + L * t); xs.push(ax + (bx - ax) * t); zs.push(az + (bz - az) * t); ys.push(ay + (by - ay) * t); cs.push(ac + (bc - ac) * t);
    }
    distance += L;
  }
  ss.push(distance);
  const e = pts.length - 1; xs.push(pts[e][0]); zs.push(pts[e][1]); ys.push(yc[e][0]); cs.push(yc[e][1]);
  const n = xs.length; if (n < 2) return null;
  const lx = new Float32Array(n), lz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let tx = xs[b] - xs[a], tz = zs[b] - zs[a]; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
    lx[i] = tz; lz[i] = -tx;
  }
  // road class data (tile.json from builds with road classes; absent on older tiles)
  const sw = sidewalkSides(p.sidewalk);
  return { id, kind: p.kind, hw: p.w / 2, cls: K.cls, x: xs, z: zs, y: ys, c: cs, lx, lz, n,
    bridge: p.bridge, s: ss, widen: p.widen, link: (p.cls || '').split(':')[0].endsWith('_link'), osm: p.cls, flat: !!p.flat, oneway: !!p.oneway, sw, hasSidewalk: !!(sw[0] || sw[1]), stop: p.stop };
}

// ---------------------------------------------------------------- one tile
export function makeTileData(W, tx, tz, data) {
  const steps = makeTileDataSteps(W, tx, tz, data); let r;
  while (!(r = steps.next()).done);
  return r.value;
}
// the same, yielding between pieces so the game can spread a big town tile over several frames
export function* makeTileDataSteps(W, tx, tz, { hbuf, sbuf, tbuf, pbuf, tile }) {
  const T = W.tile, HS = W.hstep, HN = W.hn, HM = W.hm, NN = HN + 2 * HM;
  const x0 = tx * T - T / 2, z0 = tz * T - T / 2;             // tile corner (core)
  const gx0 = x0 - HM * HS, gz0 = z0 - HM * HS;               // height grid origin (includes margin)
  const H = new Float32Array(hbuf), surf = new Uint8Array(sbuf), trees = new Float32Array(tbuf);
  // river pools (tools/rivers.py) are water like ponds: same id grid, levels in tile.json `rivers`. waterLevel has both;
  // pondLevel stays the real ponds only (drive.mjs's pond test picks the biggest one)
  const pondId = new Uint16Array(pbuf), pondLevel = tile.ponds || {};
  const waterLevel = tile.rivers ? { ...pondLevel, ...tile.rivers } : pondLevel;

  // terrain height exactly as the mesh triangles interpolate it (split along the b-c diagonal)
  function terrainAt(x, z) {
    let fx = (x - gx0) / HS, fz = (z - gz0) / HS;
    fx = Math.min(Math.max(fx, 0), NN - 1.001); fz = Math.min(Math.max(fz, 0), NN - 1.001);
    const j = fx | 0, i = fz | 0; fx -= j; fz -= i;
    const a = H[i * NN + j], b = H[i * NN + j + 1], c = H[(i + 1) * NN + j], d = H[(i + 1) * NN + j + 1];
    if (fx + fz <= 1) return a + (b - a) * fx + (c - a) * fz;
    return d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
  }
  function rasterSurfaceAt(x, z) {
    const u = Math.min(T - 1, Math.max(0, (x - x0) | 0)), v = Math.min(T - 1, Math.max(0, (z - z0) | 0));
    return surf[v * T + u];
  }
  function waterLevelAt(x, z) {
    const j = Math.round((x - gx0) / HS), i = Math.round((z - gz0) / HS);
    if (i < 0 || j < 0 || i >= NN || j >= NN) return -Infinity;
    const k = pondId[i * NN + j]; if (!k) return -Infinity;
    const lv = waterLevel[k]; return lv !== undefined && terrainAt(x, z) < lv ? lv : -Infinity;
  }

  // strips + junction pieces: physics uses the padded sets (they can reach over the tile edge), drawing the exact ones
  const roads = [], renderRoads = [], juncs = [];
  const SG = 10, SGN = Math.ceil((T + 120) / SG), segGrid = new Map(), sx0 = x0 - 60, sz0 = z0 - 60;
  const addBox = (a0, a1, b0, b1, id, i) => {
    for (let gz = Math.max(0, Math.floor((b0 - sz0) / SG)); gz <= Math.min(SGN - 1, Math.floor((b1 - sz0) / SG)); gz++)
      for (let gx = Math.max(0, Math.floor((a0 - sx0) / SG)); gx <= Math.min(SGN - 1, Math.floor((a1 - sx0) / SG)); gx++) {
        const k = gz * SGN + gx; let l = segGrid.get(k); if (!l) segGrid.set(k, l = []); l.push(id, i);
      }
  };
  let work = 0;
  for (const p of tile.physPaths || []) {
    if ((work += p.pts.length) > 1500) { work = 0; yield 'tiledata'; }
    const r = prepRoad(p, roads.length); if (!r) continue; roads.push(r);
    for (let i = 0; i < r.n - 1; i++) {
      const hw = r.widen ? Math.max(roadHalfWidth(r, i, 1), roadHalfWidth(r, i, -1), roadHalfWidth(r, i + 1, 1), roadHalfWidth(r, i + 1, -1)) : r.hw;
      const m = hw + 1 + Math.max(r.sw[0], r.sw[1]);
      addBox(Math.min(r.x[i], r.x[i + 1]) - m, Math.max(r.x[i], r.x[i + 1]) + m,
        Math.min(r.z[i], r.z[i + 1]) - m, Math.max(r.z[i], r.z[i + 1]) + m, r.id, i);
    }
  }
  const deckRoads = roads.filter(r => r.bridge);
  for (const j of tile.physJunctions || []) {
    const id = juncs.length, R = j.ring, c = j.c;
    juncs.push({ cls: PATH_KINDS[j.kind].cls, c, ring: R, bridge: bridgeJunction(j, deckRoads) });
    for (let k = 0; k < R.length; k++) {
      const p = R[k], q = R[(k + 1) % R.length];
      addBox(Math.min(c[0], p[0], q[0]), Math.max(c[0], p[0], q[0]), Math.min(c[1], p[1], q[1]), Math.max(c[1], p[1], q[1]), -1 - id, k);
    }
  }
  yield 'tiledata';
  for (const p of tile.paths || []) {
    if ((work += p.pts.length) > 1500) { work = 0; yield 'tiledata'; }
    const r = prepRoad(p, renderRoads.length); if (r) renderRoads.push(r);
  }
  yield 'tiledata';
  const renderJunctions = (tile.junctions || []).map(j => ({ ...j, cls: PATH_KINDS[j.kind].cls }));
  const hasBridges = roads.some(r => r.bridge) || juncs.some(j => j.bridge);
  let lastCls = -1, lastBridge = false, lastGx = 0, lastGz = 0;
  // Road surface height here (-Infinity if absent); remember the winning surface and deck gradient.
  function overlayAt(x, z, yq = Infinity) {
    let best = -Infinity; lastCls = -1; lastBridge = false;
    const l = segGrid.get(Math.floor((z - sz0) / SG) * SGN + Math.floor((x - sx0) / SG)); if (!l) return best;
    for (let q = 0; q < l.length; q += 2) {
      const id = l[q], i = l[q + 1];
      if (id < 0) {                            // junction triangle (centre, ring[i], ring[i+1])
        const J = juncs[-1 - id], c = J.c, A = J.ring[i], B = J.ring[(i + 1) % J.ring.length];
        const ux = A[0] - c[0], uz = A[1] - c[1], vx = B[0] - c[0], vz = B[1] - c[1], px = x - c[0], pz = z - c[1];
        const det = ux * vz - uz * vx; if (Math.abs(det) < 1e-9) continue;
        const a = (px * vz - pz * vx) / det, b = (ux * pz - uz * px) / det;
        if (a < -1e-4 || b < -1e-4 || a + b > 1 + 1e-4) continue;
        const y = c[2] + (A[2] - c[2]) * a + (B[2] - c[2]) * b;
        if (J.bridge && yq < y - BRIDGE_CLIMB) continue;
        if (y > best) {
          best = y; lastCls = J.cls; lastBridge = J.bridge;
          if (lastBridge) {
            lastGx = ((A[2] - c[2]) * vz - uz * (B[2] - c[2])) / det;
            lastGz = (ux * (B[2] - c[2]) - (A[2] - c[2]) * vx) / det;
          }
        }
        continue;
      }
      const r = roads[id];
      if (r.widen || r.link) {               // match the renderer's exact pavement triangles
        const accept = (A, B, C, cls) => {
          const h = triangleHeight(x, z, A, B, C);
          if (h <= best || (r.bridge && yq < h - BRIDGE_CLIMB)) return;
          best = h; lastCls = cls; lastBridge = !!r.bridge;
          if (lastBridge) {
            const ux = B[0] - A[0], uz = B[1] - A[1], uy = B[2] - A[2];
            const vx = C[0] - A[0], vz = C[1] - A[1], vy = C[2] - A[2];
            const det = ux * vz - uz * vx;
            lastGx = (uy * vz - uz * vy) / det; lastGz = (ux * vy - uy * vx) / det;
          }
        };
        const A = roadEdge(r, i, 1), B = roadEdge(r, i, -1);
        const C = roadEdge(r, i + 1, -1), D = roadEdge(r, i + 1, 1);
        accept(A, B, C, r.cls); accept(A, C, D, r.cls);
        for (const side of [1, -1]) {
          const sw = r.sw[side > 0 ? 0 : 1]; if (!sw) continue;
          const A = roadEdge(r, i, side, 0, KERB), B = roadEdge(r, i, side, sw, KERB);
          const C = roadEdge(r, i + 1, side, sw, KERB), D = roadEdge(r, i + 1, side, 0, KERB);
          accept(A, B, C, 6); accept(A, C, D, 6);
        }
        continue;
      }
      const ax = r.x[i], az = r.z[i], ex = r.x[i + 1] - ax, ez = r.z[i + 1] - az, L2 = ex * ex + ez * ez;
      if (L2 < 1e-4) continue;
      const u = ((x - ax) * ex + (z - az) * ez) / L2;
      if (u < -0.02 || u > 1.02) continue;
      const off = ((x - ax) * ez - (z - az) * ex) / Math.sqrt(L2);
      const uc = Math.min(1, Math.max(0, u));
      if (Math.abs(off) > r.hw) {               // sidewalk beside the road: KERB above the road edge, concrete (6)
        const sw = off > 0 ? r.sw[0] : r.sw[1];
        if (!sw || Math.abs(off) > r.hw + sw) continue;
        const e = off > 0 ? r.hw : -r.hw;
        const y = r.y[i] + (r.y[i + 1] - r.y[i]) * uc + (r.c[i] + (r.c[i + 1] - r.c[i]) * uc) * e + KERB;
        if (r.bridge && yq < y - BRIDGE_CLIMB) continue;
        if (y > best) { best = y; lastCls = 6; if ((lastBridge = !!r.bridge)) deckSlope(r, i, ex, ez, L2, uc, e, true); }
        continue;
      }
      const y = r.y[i] + (r.y[i + 1] - r.y[i]) * uc + (r.c[i] + (r.c[i + 1] - r.c[i]) * uc) * off;
      if (r.bridge && yq < y - BRIDGE_CLIMB) continue;
      if (y > best) { best = y; lastCls = r.cls; if ((lastBridge = !!r.bridge)) deckSlope(r, i, ex, ez, L2, uc, off, false); }
    }
    return best;
  }
  function deckSlope(r, i, ex, ez, L2, uc, off, sidewalk) {
    const L = Math.sqrt(L2);
    const along = (r.y[i + 1] - r.y[i] + (r.c[i + 1] - r.c[i]) * off) / L;
    const cross = sidewalk ? 0 : r.c[i] + (r.c[i + 1] - r.c[i]) * uc;
    lastGx = (along * ex + cross * ez) / L; lastGz = (along * ez - cross * ex) / L;
  }
  function deckNormal(x, z, y, out) {
    if (!hasBridges) return false;
    const h = overlayAt(x, z, y);
    if (!lastBridge || h < terrainAt(x, z)) return false;
    out.set(-lastGx, 1, -lastGz); return true;
  }
  function surfaceAt(x, z, y) {
    overlayAt(x, z, y);
    // Pave only the approach road strips/junctions, leaving surrounding gravel and trails alone.
    if (lastCls === 4 && campusDrive(x, z)) return 3;
    return lastCls >= 0 ? lastCls : rasterSurfaceAt(x, z);
  }

  // trunks, bucketed for collisions
  const nT = trees.length / 4, GC = 8, GN = Math.ceil(T / GC), tgrid = new Map();
  for (let t = 0; t < nT; t++) {
    const gx = Math.min(GN - 1, Math.max(0, Math.floor((trees[t * 4] - x0) / GC)));
    const gz = Math.min(GN - 1, Math.max(0, Math.floor((trees[t * 4 + 1] - z0) / GC)));
    const k = gz * GN + gx; let l = tgrid.get(k); if (!l) tgrid.set(k, l = []); l.push(t);
  }
  function treesNear(x, z, r, cb) {
    const a0 = Math.max(0, Math.floor((x - r - x0) / GC)), a1 = Math.min(GN - 1, Math.floor((x + r - x0) / GC));
    const b0 = Math.max(0, Math.floor((z - r - z0) / GC)), b1 = Math.min(GN - 1, Math.floor((z + r - z0) / GC));
    for (let gz = b0; gz <= b1; gz++) for (let gx = a0; gx <= a1; gx++) {
      const l = tgrid.get(gz * GN + gx); if (!l) continue;
      for (const t of l) cb(trees[t * 4], trees[t * 4 + 1], trunkRadius(trees[t * 4 + 2], trees[t * 4 + 3]), trees[t * 4 + 2], trees[t * 4 + 3]);   // x, z, trunk r, height, broadleaf?
    }
  }
  yield 'tiledata';
  const td = { tx, tz, x0, z0, gx0, gz0, NN, hs: HS, H, surf, trees, treeCount: nT, roads, renderRoads, renderJunctions, buildings: tile.buildings || [],
    sourcePaths: tile.paths || [], sourceJunctions: tile.junctions || [],
    pondId, pondLevel, waterLevel, terrainAt, overlayAt, surfaceAt, waterLevelAt, treesNear, deckNormal,
    heightAt: (x, z, y) => Math.max(terrainAt(x, z), overlayAt(x, z, y)) };
  applyTrack(td);                           // running track north of the gym: level ground + surface (campustrack.js)
  td.buildings = applyCampus(td);           // Delphian campus: hand-made models replace the OSM blocks (campus.js)
  yield 'tiledata';
  td.buildings = applyLandmarks(td);        // landmarks.js replaces the OSM block under each landmark
  return td;
}

// ---------------------------------------------------------------- the whole world: routes queries to tiles
export function makeWorld(W) {
  const T = W.tile, tiles = new Map(), [EX0, EZ0, EX1, EZ1] = W.extent;
  const key = (tx, tz) => tx * 1000 + tz;
  const tileIndex = (x, z) => [Math.floor((x + T / 2) / T), Math.floor((z + T / 2) / T)];
  // Map membership comes from the manifest, independently of streamed/loaded tiles.
  const available = new Set(W.tiles.map(([tx, tz]) => key(tx, tz)));
  function mapContains(x, z, margin = 0) {
    // A vehicle-sized square spans at most four cells (margin is much less than half a tile).
    for (const dx of [-margin, margin]) for (const dz of [-margin, margin]) {
      const [tx, tz] = tileIndex(x + dx, z + dz);
      if (!available.has(key(tx, tz))) return false;
    }
    return true;
  }
  let last = null;
  function tileAt(x, z) {
    if (last && x >= last.x0 && x < last.x0 + T && z >= last.z0 && z < last.z0 + T) return last;
    const [tx, tz] = tileIndex(x, z); const t = tiles.get(key(tx, tz)); if (t) last = t; return t || null;
  }
  // no tile loaded here (outside the map, or not streamed in yet): hold the height of the nearest loaded edge
  function nearest(x, z) {
    let best = null, bd = Infinity;
    for (const t of tiles.values()) {
      const cx = Math.min(Math.max(x, t.x0), t.x0 + T), cz = Math.min(Math.max(z, t.z0), t.z0 + T);
      const d = (cx - x) ** 2 + (cz - z) ** 2; if (d < bd) { bd = d; best = t; }
    }
    return best;
  }
  const at = (x, z) => tileAt(x, z) || nearest(x, z);
  function terrainAt(x, z) { const t = at(x, z); return t ? t.terrainAt(x, z) : 0; }
  // ramps: the map's fixed ones (assets/ramps.json, setFixedRamps) + a running challenge's (setRamps); each sits on
  // whatever road is under it
  let ramps = [], fixedRamps = [], challengeRamps = [];
  const prepRamps = list => (list || []).map(r => ({ ...r, fx: Math.sin(r.yaw), fz: Math.cos(r.yaw) }));
  let rampSlope = 0, rampFx = 0, rampFz = 0;           // set by rampAt: slope along the ramp at the last point
  function rampAt(x, z) {
    rampSlope = 0;
    for (const r of ramps) {
      const dx = x - r.x, dz = z - r.z;
      const u = dx * r.fx + dz * r.fz; if (u <= 0 || u >= RAMP_LEN) continue;
      if (Math.abs(dx * r.fz - dz * r.fx) > r.w / 2) continue;
      const [h, s] = rampShape(u); rampSlope = s; rampFx = r.fx; rampFz = r.fz; return h;
    }
    return 0;
  }
  function setRamps(list) { challengeRamps = prepRamps(list); ramps = fixedRamps.concat(challengeRamps); }
  function setFixedRamps(list) { fixedRamps = prepRamps(list); ramps = fixedRamps.concat(challengeRamps); }
  function groundAt(x, z, y) { const t = at(x, z); return t ? t.heightAt(x, z, y) : 0; }     // without ramps
  function heightAt(x, z, y) { const g = groundAt(x, z, y); return ramps.length ? g + rampAt(x, z) : g; }
  function surfaceAt(x, z, y) { const t = tileAt(x, z); return t ? t.surfaceAt(x, z, y) : 0; }
  function waterLevelAt(x, z) { const t = tileAt(x, z); return t ? t.waterLevelAt(x, z) : -Infinity; }
  function normalAt(x, z, out = new THREE.Vector3(), y) {
    const e = W.hstep * 0.5, t = at(x, z);
    if (t?.deckNormal?.(x, z, y, out)) out.multiplyScalar(2 * e);
    else {
      const hl = terrainAt(x - e, z), hr = terrainAt(x + e, z), hd = terrainAt(x, z - e), hu = terrainAt(x, z + e);
      out.set(hl - hr, 2 * e, hd - hu);
    }
    if (ramps.length && rampAt(x, z) > 0) { out.x -= 2 * e * rampSlope * rampFx; out.z -= 2 * e * rampSlope * rampFz; }
    return out.normalize();
  }
  function treesNear(x, z, r, cb) {
    const [a0, b0] = tileIndex(x - r, z - r), [a1, b1] = tileIndex(x + r, z + r);
    for (let tz = b0; tz <= b1; tz++) for (let tx = a0; tx <= a1; tx++) { const t = tiles.get(key(tx, tz)); if (t) t.treesNear(x, z, r, cb); }
  }
  const _b = [];
  function buildingsNear(x, z, r = 40) {
    _b.length = 0;
    const [a0, b0] = tileIndex(x - r, z - r), [a1, b1] = tileIndex(x + r, z + r);
    for (let tz = b0; tz <= b1; tz++) for (let tx = a0; tx <= a1; tx++) { const t = tiles.get(key(tx, tz)); if (t) for (const b of t.buildings) _b.push(b); }
    return _b;
  }
  // nearest point of a given surface class, facing along it (spawns, teleports)
  function placeOn(x0, z0, cls, radius = 150) {
    let best = null;
    for (let dz = -radius; dz <= radius; dz += 2) for (let dx = -radius; dx <= radius; dx += 2) {
      if (surfaceAt(x0 + dx, z0 + dz) !== cls) continue;
      const d = dx * dx + dz * dz; if (!best || d < best[2]) best = [x0 + dx, z0 + dz, d];
    }
    if (!best) return [x0, z0, 0];
    let yaw = 0, run = -1;
    for (let a = 0; a < Math.PI * 2; a += 0.05) {
      let c = 0; for (let r = 3; r < 60; r += 3) { if (surfaceAt(best[0] + Math.sin(a) * r, best[1] + Math.cos(a) * r) === cls) c++; else break; }
      if (c > run) { run = c; yaw = a; }
    }
    return [best[0], best[1], yaw];
  }
  return {
    W, tiles, extent: W.extent, spawn: W.spawn, tileIndex, tileAt, key, mapContains,
    add(t) { tiles.set(key(t.tx, t.tz), t); last = null; },
    remove(tx, tz) { tiles.delete(key(tx, tz)); last = null; },
    has: (tx, tz) => tiles.has(key(tx, tz)),
    loadedAt: (x, z) => !!tileAt(x, z),
    terrainAt, heightAt, groundAt, rampAt, setRamps, setFixedRamps, get ramps() { return ramps; }, surfaceAt, waterLevelAt, normalAt, treesNear, buildingsNear, placeOn,
  };
}
