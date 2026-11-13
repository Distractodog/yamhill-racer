// Pure world data + queries (no rendering). Shared by the game and the headless test drives.
// World space: metres, x = east, z = south, y = up. The world is cut into square tiles (world.json); each tile's
// data is loaded separately (makeTileData) and registered with the world (makeWorld), which routes every query
// to the tile that contains the point.
import * as THREE from 'three';
import { applyCampus } from './campus.js';

// road / trail strips and junction pieces: surface class per kind. Heights come baked from the build
// (tools/roadnet.py): each strip point has a centre-line height y and a cross slope c (height per metre to the left).
export const PATH_KINDS = {
  asphalt: { cls: 3 },
  gravel: { cls: 4 },
  trail: { cls: 2 },
};
export const STEP = 1.5;
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
  const pts = p.pts, yc = p.yc || pts.map(() => [0, 0]), xs = [], zs = [], ys = [], cs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], [ay, ac] = yc[i], [by, bc] = yc[i + 1];
    const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / STEP));
    for (let k = 0; k < n; k++) {
      const t = k / n; xs.push(ax + (bx - ax) * t); zs.push(az + (bz - az) * t); ys.push(ay + (by - ay) * t); cs.push(ac + (bc - ac) * t);
    }
  }
  const e = pts.length - 1; xs.push(pts[e][0]); zs.push(pts[e][1]); ys.push(yc[e][0]); cs.push(yc[e][1]);
  const n = xs.length; if (n < 2) return null;
  const lx = new Float32Array(n), lz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let tx = xs[b] - xs[a], tz = zs[b] - zs[a]; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
    lx[i] = tz; lz[i] = -tx;
  }
  return { id, kind: p.kind, hw: p.w / 2, cls: K.cls, x: xs, z: zs, y: ys, c: cs, lx, lz, n };
}

// ---------------------------------------------------------------- one tile
export function makeTileData(W, tx, tz, { hbuf, sbuf, tbuf, pbuf, tile }) {
  const T = W.tile, HS = W.hstep, HN = W.hn, HM = W.hm, NN = HN + 2 * HM;
  const x0 = tx * T - T / 2, z0 = tz * T - T / 2;             // tile corner (core)
  const gx0 = x0 - HM * HS, gz0 = z0 - HM * HS;               // height grid origin (includes margin)
  const H = new Float32Array(hbuf), surf = new Uint8Array(sbuf), trees = new Float32Array(tbuf);
  const pondId = new Uint16Array(pbuf), pondLevel = tile.ponds || {};

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
    const lv = pondLevel[k]; return lv !== undefined && terrainAt(x, z) < lv ? lv : -Infinity;
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
  for (const p of tile.physPaths || []) {
    const r = prepRoad(p, roads.length); if (!r) continue; roads.push(r);
    for (let i = 0; i < r.n - 1; i++) {
      const m = r.hw + 1;
      addBox(Math.min(r.x[i], r.x[i + 1]) - m, Math.max(r.x[i], r.x[i + 1]) + m,
        Math.min(r.z[i], r.z[i + 1]) - m, Math.max(r.z[i], r.z[i + 1]) + m, r.id, i);
    }
  }
  for (const j of tile.physJunctions || []) {
    const id = juncs.length, R = j.ring, c = j.c; juncs.push({ cls: PATH_KINDS[j.kind].cls, c, ring: R });
    for (let k = 0; k < R.length; k++) {
      const p = R[k], q = R[(k + 1) % R.length];
      addBox(Math.min(c[0], p[0], q[0]), Math.max(c[0], p[0], q[0]), Math.min(c[1], p[1], q[1]), Math.max(c[1], p[1], q[1]), -1 - id, k);
    }
  }
  for (const p of tile.paths || []) { const r = prepRoad(p, renderRoads.length); if (r) renderRoads.push(r); }
  const renderJunctions = (tile.junctions || []).map(j => ({ ...j, cls: PATH_KINDS[j.kind].cls }));
  let lastCls = -1;
  function overlayAt(x, z) {                 // road surface height here (-Infinity if no road); sets lastCls
    let best = -Infinity; lastCls = -1;
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
        if (y > best) { best = y; lastCls = J.cls; }
        continue;
      }
      const r = roads[id];
      const ax = r.x[i], az = r.z[i], ex = r.x[i + 1] - ax, ez = r.z[i + 1] - az, L2 = ex * ex + ez * ez;
      if (L2 < 1e-4) continue;
      const u = ((x - ax) * ex + (z - az) * ez) / L2;
      if (u < -0.02 || u > 1.02) continue;
      const off = ((x - ax) * ez - (z - az) * ex) / Math.sqrt(L2);
      if (Math.abs(off) > r.hw) continue;
      const uc = Math.min(1, Math.max(0, u));
      const y = r.y[i] + (r.y[i + 1] - r.y[i]) * uc + (r.c[i] + (r.c[i + 1] - r.c[i]) * uc) * off;
      if (y > best) { best = y; lastCls = r.cls; }
    }
    return best;
  }
  function surfaceAt(x, z) { overlayAt(x, z); return lastCls >= 0 ? lastCls : rasterSurfaceAt(x, z); }

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
  const td = { tx, tz, x0, z0, gx0, gz0, NN, H, trees, treeCount: nT, roads, renderRoads, renderJunctions, buildings: tile.buildings || [],
    pondId, pondLevel, terrainAt, overlayAt, surfaceAt, waterLevelAt, treesNear,
    heightAt: (x, z) => Math.max(terrainAt(x, z), overlayAt(x, z)) };
  td.buildings = applyCampus(td);           // Delphian campus: hand-made models replace the OSM blocks (campus.js)
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
  function groundAt(x, z) { const t = at(x, z); return t ? t.heightAt(x, z) : 0; }     // without ramps
  function heightAt(x, z) { const g = groundAt(x, z); return ramps.length ? g + rampAt(x, z) : g; }
  function surfaceAt(x, z) { const t = tileAt(x, z); return t ? t.surfaceAt(x, z) : 0; }
  function waterLevelAt(x, z) { const t = tileAt(x, z); return t ? t.waterLevelAt(x, z) : -Infinity; }
  function normalAt(x, z, out = new THREE.Vector3()) {
    const e = W.hstep * 0.5;
    const hl = terrainAt(x - e, z), hr = terrainAt(x + e, z), hd = terrainAt(x, z - e), hu = terrainAt(x, z + e);
    out.set(hl - hr, 2 * e, hd - hu);
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
