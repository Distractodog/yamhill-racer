// Streams the tiled world (tools/build_tiles.py): loads tiles around the camera and builds their meshes.
// World space: metres, x = east, z = south, y = up. Origin = centre of the map.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeWorld, makeTileDataSteps } from './data.js';
import { readTileRaw, decodeTileSteps, fetchReader, groundFile } from './tilepack.js';
import { createTileQueue, fetchTileParts } from './tilequeue.js';
import { roadLODSteps, roadBatches, buildJunctions } from './roads.js';
import { buildBridgeSteps, showBridges } from './bridges.js';
import { mergeRoadBatches, placeRoadBlockSteps } from './meshmerge.js';
import { installPerf } from './perf.js';
import * as STREAM from './streamplan.js';
import { createTileScenery } from './scenery.js';
import { buildCampusGateGeometry } from './campusgate.js';
import { placeCampus } from './campusmodel.js';
import { TRACK } from './campustrack.js';
import { buildTrackMeshes } from './campustrackmodel.js';
import { placeLandmarks } from './landmarksmodel.js';
import { blockOf, footprintMeshes, mergeBlock, planFootprint, roadContext, townRange } from './townmodel.js';
import { addProps, propGeometries, showProps } from './propsmodel.js';
import { addCampusItems, campusItemGeometries, showCampusItems } from './campusitemsmodel.js';

export const SURFACES = ['grass', 'forest floor', 'dirt trail', 'asphalt', 'gravel', 'water', 'concrete', 'running track'];

// Tiles within LOAD_R of the camera are loaded (in the background, a few ms per frame); beyond DROP_R they're hidden
// and kept for a while, then dropped. Look-ahead, keeping and the per-frame build budget: streamplan.js.
const { LOAD_R } = STREAM;

export async function loadWorld(renderer, onProgress = () => {}) {
  const notePerf = installPerf(renderer);
  const base = 'assets/';
  const W = await fetch(base + 'world.json').then(r => r.json());
  const world = makeWorld(W);
  const T = W.tile, HS = W.hstep;
  const group = new THREE.Group();
  const available = new Set(W.tiles.map(([tx, tz]) => world.key(tx, tz)));

  // shared by every tile
  const stripMat = groundMaterial(null);
  const conifer = coniferGeometry(), broadleaf = broadleafGeometry(), coniferFar = farConifer(), broadFar = farBroadleaf();
  const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const windTime = { value: 0 };
  // Sway only the upper canopy. Shader animation avoids rebuilding instance matrices.
  treeMat.onBeforeCompile = shader => {
    shader.uniforms.windTime = windTime;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float windTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float windPhase = instanceMatrix[3].x * 0.013 + instanceMatrix[3].z * 0.017;
          float canopy = smoothstep(0.22, 1.1, position.y);
          transformed.x += sin(windTime * 1.15 + windPhase) * 0.012 * canopy;
          transformed.z += cos(windTime * 0.85 + windPhase) * 0.008 * canopy;
        #endif`);
  };
  let sceneryTime = 0, nightAmount = 0;
  const buildingMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const campusMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const waterUniforms = { time: { value: 0 } };
  const waterMat = new THREE.MeshLambertMaterial({ color: 0x3d8fc4, transparent: true, opacity: 0.8, flatShading: true });
  waterMat.onBeforeCompile = sh => {
    sh.uniforms.time = waterUniforms.time;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float time;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 wp = modelMatrix * vec4(transformed, 1.0);
        transformed.y += sin(wp.x * 0.35 + time * 1.7) * 0.035 + cos(wp.z * 0.42 + time * 1.3) * 0.035;`);
  };
  const propGeos = propGeometries();
  const campusItemGeos = campusItemGeometries();
  const propMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const SHARED = new Set([conifer, broadleaf, coniferFar, broadFar, ...Object.values(propGeos), ...Object.values(campusItemGeos)]);

  const vis = new Map();            // key -> { group, chunks, treeLods, treeMats, textures, materials }
  let lastShadowAt = null;          // where the shadow casters were last rebuilt

  // data and ground bitmaps together; if either fails, the bitmaps made are closed (tilequeue.js fetchTileParts)
  function fetchTile(tx, tz) {
    const dir = `${base}tiles/${tx}_${tz}/`;
    return fetchTileParts(
      () => readTileRaw(fetchReader(dir), W.packed),          // unzipped here, decoded in buildTile's steps: tilepack.js
      // ground colours as four 1024^2 quarters (cropped off the main thread), so each uploads in its own slice
      () => fetch(dir + groundFile(W.packed)).then(r => r.blob()).then(b => [0, 1, 2, 3].map(q =>
        createImageBitmap(b, (q % 2) * 1024, (q >> 1) * 1024, 1024, 1024, { imageOrientation: 'none' }))));
  }

  // builds one tile's data and meshes, yielding between pieces so the frame budget can pause it. job.partial holds what
  // is built so far, so a failure part-way (tilequeue.js) can free it
  function* buildTile(tx, tz, raw, img, job = {}) {
    const td = yield* makeTileDataSteps(W, tx, tz, yield* decodeTileSteps(raw));
    const g = new THREE.Group(), out = { td, group: g, chunks: [], treeLods: [], buildingLods: [], propLods: [], campusLods: [], campusItemLods: [], treeMats: null, tgrid: null };
    out.textures = []; out.materials = []; job.partial = out;
    const quarterMats = [];
    for (const bmp of img) {
      const tex = new THREE.Texture(bmp); tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.needsUpdate = true;
      const m = groundMaterial(tex); out.textures.push(tex); out.materials.push(m); quarterMats.push(m);
      renderer.initTexture(tex);                   // upload now, one quarter per slice, not on the tile's first frame
      yield 'texture';
    }
    const { H, NN } = td, HM = W.hm, HN = W.hn;
    // near roads, the coarser terrain levels take the lowest height around each vertex, so a big coarse triangle can
    // never bulge up through a road the fine terrain was carved under
    const near = new Uint8Array(NN * NN);
    const markBox = (x0, x1, z0, z1) => {
      const j0 = Math.max(0, Math.floor((x0 - td.gx0) / HS)), j1 = Math.min(NN - 1, Math.ceil((x1 - td.gx0) / HS));
      const i0 = Math.max(0, Math.floor((z0 - td.gz0) / HS)), i1 = Math.min(NN - 1, Math.ceil((z1 - td.gz0) / HS));
      for (let i = i0; i <= i1; i++) near.fill(1, i * NN + j0, i * NN + j1 + 1);
    };
    for (const r of td.roads) for (let k = 0; k < r.n; k += 2) { const m = r.hw + 6; markBox(r.x[k] - m, r.x[k] + m, r.z[k] - m, r.z[k] + m); }
    for (const j of td.renderJunctions) {
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const q of j.ring) { a0 = Math.min(a0, q[0]); a1 = Math.max(a1, q[0]); b0 = Math.min(b0, q[1]); b1 = Math.max(b1, q[1]); }
      markBox(a0 - 6, a1 + 6, b0 - 6, b1 + 6);
    }
    const dilated = st => {                    // any road-near vertex within st cells (box), separable
      const a = new Uint8Array(NN * NN), b = new Uint8Array(NN * NN);
      for (let i = 0; i < NN; i++) for (let j = 0; j < NN; j++) {
        if (!near[i * NN + j]) continue;
        a.fill(1, i * NN + Math.max(0, j - st), i * NN + Math.min(NN - 1, j + st) + 1);
      }
      for (let i = 0; i < NN; i++) for (let j = 0; j < NN; j++) {
        if (!a[i * NN + j]) continue;
        for (let q = Math.max(0, i - st); q <= Math.min(NN - 1, i + st); q++) b[q * NN + j] = 1;
      }
      return b;
    };
    const lowMask = {};
    for (const st of [2, 4, 8]) { lowMask[st] = dilated(st); yield 'roadmask'; }
    const heightFor = (gi, gj, st) => {         // gi, gj: height-grid indices (with margin)
      if (st === 1 || !lowMask[st][gi * NN + gj]) return H[gi * NN + gj];
      let h = Infinity;
      for (let q = Math.max(0, gi - st); q <= Math.min(NN - 1, gi + st); q++)
        for (let p = Math.max(0, gj - st); p <= Math.min(NN - 1, gj + st); p++) h = Math.min(h, H[q * NN + p]);
      return h;
    };
    // terrain: 100-cell (400 m) chunks with 4 detail levels + skirts
    const CHUNK = 125, QN = (HN - 1) / 2, STEPS = [1, 2, 4, 8];      // 500 m chunks; 4 chunks per texture quarter
    function chunkGeometry(i0, j0, i1, j1, st, qi0, qj0) {
      const is = [], js = [];
      for (let i = i0; i < i1; i += st) is.push(i); is.push(i1);
      for (let j = j0; j < j1; j += st) js.push(j); js.push(j1);
      const ni = is.length, nj = js.length, P = [], U = [], I = [];
      const vert = (i, j, drop) => {
        P.push(td.x0 + j * HS, heightFor(i + HM, j + HM, st) - drop, td.z0 + i * HS);
        U.push((j - qj0) / QN, (i - qi0) / QN); return P.length / 3 - 1;
      };
      for (const i of is) for (const j of js) vert(i, j, 0);
      for (let a = 0; a < ni - 1; a++) for (let b = 0; b < nj - 1; b++) {
        const v00 = a * nj + b, v01 = v00 + 1, v10 = v00 + nj, v11 = v10 + 1;
        I.push(v00, v10, v01, v01, v10, v11);
      }
      const skirt = 1.5 + st * 1.5;
      const edge = list => {
        for (let k = 0; k < list.length - 1; k++) {
          const [va, ia, ja] = list[k], [vb, ib, jb] = list[k + 1];
          const da = vert(ia, ja, skirt), db = vert(ib, jb, skirt);
          I.push(va, da, vb, vb, da, db, va, vb, da, vb, db, da);
        }
      };
      edge(js.map((j, b) => [b, is[0], j])); edge(js.map((j, b) => [(ni - 1) * nj + b, is[ni - 1], j]));
      edge(is.map((i, a) => [a * nj, i, js[0]])); edge(is.map((i, a) => [a * nj + nj - 1, i, js[nj - 1]]));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
      geo.setIndex(I); geo.computeBoundingSphere();
      return geo;
    }
    for (let i0 = 0; i0 < HN - 1; i0 += CHUNK) for (let j0 = 0; j0 < HN - 1; j0 += CHUNK) {
      const i1 = Math.min(i0 + CHUNK, HN - 1), j1 = Math.min(j0 + CHUNK, HN - 1);
      const levels = [], qi0 = i0 >= QN ? QN : 0, qj0 = j0 >= QN ? QN : 0, mat = quarterMats[(qi0 ? 2 : 0) + (qj0 ? 1 : 0)];
      const level = st => { const m = new THREE.Mesh(chunkGeometry(i0, j0, i1, j1, st, qi0, qj0), mat); m.receiveShadow = true; m.visible = false; g.add(m); return m; };
      // full detail (st 1, ~15% of a tile's build) only when the camera comes near: updateLOD → buildDetail
      for (const st of STEPS) { if (st === 1) { levels.push(null); continue; } levels.push(level(st)); yield 'terrain' + st; }
      out.chunks.push({ levels, cx: td.x0 + (j0 + j1) / 2 * HS, cz: td.z0 + (i0 + i1) / 2 * HS, lv: -1, full: () => level(1) });
    }
    // Copy bridge metadata onto rendering strips before drawing the shallow road skirts.
    out.bridges = yield* buildBridgeSteps(td, campusMat);
    // road / trail strips
    for (const batch of mergeRoadBatches(roadBatches(td.renderRoads))) g.add(yield* placeRoadBlockSteps(td, stripMat, batch, roadLODSteps));   // one near + far pair per block
    if (out.bridges) g.add(out.bridges.near, out.bridges.far);
    for (let k = 0; k < td.renderJunctions.length; k += 300) { g.add(buildJunctions(td.renderJunctions.slice(k, k + 300), stripMat)); yield 'junctions'; }
    // ponds + river pools: a quad per height cell touching one. Each corner sits at its own pool's level (a corner
    // outside any pool: the highest one next to it), so a river's stepped pools join into one smooth surface
    const wpos = [], lvAt = (a, b) => { const k = td.pondId[(a + HM) * NN + (b + HM)]; return k ? td.waterLevel[k] : undefined; };
    const cornerY = (a, b) => {
      const y = lvAt(a, b); if (y !== undefined) return y;
      let m = -Infinity;
      for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) { const v = lvAt(a + da, b + db); if (v !== undefined && v > m) m = v; }
      return m;
    };
    for (let i = 0; i < HN - 1; i++) {
      if (i % 100 === 99) yield 'pond';
      for (let j = 0; j < HN - 1; j++) {
      if (lvAt(i, j) === undefined && lvAt(i, j + 1) === undefined && lvAt(i + 1, j) === undefined && lvAt(i + 1, j + 1) === undefined) continue;
      const a = cornerY(i, j), b = cornerY(i, j + 1), c = cornerY(i + 1, j), d = cornerY(i + 1, j + 1);
      const x0 = td.x0 + j * HS, z0 = td.z0 + i * HS, x1 = x0 + HS, z1 = z0 + HS;
      wpos.push(x0, a, z0, x0, c, z1, x1, b, z0, x1, b, z0, x0, c, z1, x1, d, z1);
    } }
    if (wpos.length) {
      const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wpos, 3)); wg.computeVertexNormals();
      const m = new THREE.Mesh(wg, waterMat); m.receiveShadow = true; m.renderOrder = 1; g.add(m);
    }
    yield;
    // trees: 250 m chunks, near (full) and far (simple) versions
    const trees = td.trees, nT = td.treeCount, CH = 250, NC = Math.ceil(T / CH), buckets = new Map();
    for (let t = 0; t < nT; t++) {
      const cx = Math.min(NC - 1, Math.floor((trees[t * 4] - td.x0) / CH)), cz = Math.min(NC - 1, Math.floor((trees[t * 4 + 1] - td.z0) / CH));
      const k = (cz * NC + cx) * 2 + trees[t * 4 + 3]; let l = buckets.get(k); if (!l) buckets.set(k, l = []); l.push(t);
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), tp = new THREE.Vector3();
    const col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    let seed = 1 + Math.abs(td.tx * 7919 + td.tz * 104729);
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const treeMats = new Float32Array(nT * 16);
    for (const [k, list] of buckets) {
      const broad = k % 2 === 1, cell = (k / 2) | 0;
      const near = new THREE.InstancedMesh(broad ? broadleaf : conifer, treeMat, list.length);
      const far = new THREE.InstancedMesh(broad ? broadFar : coniferFar, treeMat, list.length);
      list.forEach((t, n) => {
        const x = trees[t * 4], z = trees[t * 4 + 1], h = trees[t * 4 + 2];
        const w = broad ? h * (0.55 + rnd() * 0.2) : h * (0.24 + rnd() * 0.08);
        q.setFromAxisAngle(up, rnd() * Math.PI * 2);
        m4.compose(tp.set(x, td.terrainAt(x, z) - 0.3, z), q, sc.set(w, h, w));
        near.setMatrixAt(n, m4); m4.toArray(treeMats, t * 16);
        if (broad) col.setHSL(0.24 + rnd() * 0.06, 0.45, 0.85 + rnd() * 0.3); else col.setHSL(0.30 + rnd() * 0.05, 0.25, 0.75 + rnd() * 0.35);
        near.setColorAt(n, col);
      });
      far.instanceMatrix.copyArray(near.instanceMatrix.array); far.instanceColor = near.instanceColor;
      near.computeBoundingSphere(); far.computeBoundingSphere();
      near.receiveShadow = true; near.visible = false; far.visible = false;
      g.add(near, far);
      out.treeLods.push({ near, far, cx: td.x0 + (cell % NC + 0.5) * CH, cz: td.z0 + (((cell / NC) | 0) + 0.5) * CH });
      yield 'trees';
    }
    out.treeMats = treeMats;
    // buildings: planned town blocks, plus the hand-made campus
    const cGeos = [], lGeos = [], cells = new Map(), roads = roadContext(td.renderRoads);
    if (td.tx === 0 && td.tz === 0) cGeos.push(buildCampusGateGeometry(td.terrainAt));
    let planned = 0;
    for (const b of td.buildings) {
      if (b.campusPart) {      // hand-made campus building (campus.js), drawn once from its first footprint
        if (b.campus) { placeCampus(g, out.campusLods, cGeos, b.campus, td.terrainAt, campusMat); yield 'buildings'; }
        continue;
      }
      if (b.landmarkPart) {   // hand-made landmark (landmarks.js), drawn once from its first footprint
        if (b.landmark) { placeLandmarks(lGeos, b.landmark, td.terrainAt); yield 'buildings'; }
        continue;
      }
      if (!b.pts || b.pts.length < 3) continue;
      let lo = Infinity, hi = -Infinity;
      for (const [x, z] of b.pts) { const h = td.terrainAt(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h); }
      const plan = planFootprint(b, roads);
      const meshes = footprintMeshes(plan, td.terrainAt);
      b.lo = lo; b.top = hi + (b.h || 6);   // collision keeps the footprint height so drive times stay put
      if (meshes) {
        const block = blockOf(plan);
        let cell = cells.get(block.key);
        if (!cell) cells.set(block.key, cell = { cx: block.cx, cz: block.cz, near: [], far: [] });
        cell.near.push(meshes.near); cell.far.push(meshes.far);
      }
      if (++planned % 8 === 0) yield 'buildings';
    }
    for (const cell of cells.values()) {
      const nearG = mergeBlock(cell.near), farG = mergeBlock(cell.far);
      if (!nearG || !farG) { nearG?.dispose(); farG?.dispose(); continue; }
      const near = new THREE.Mesh(nearG, buildingMat), far = new THREE.Mesh(farG, buildingMat);
      near.receiveShadow = far.receiveShadow = true;
      near.castShadow = false; far.castShadow = false;
      near.visible = false; far.visible = false;
      g.add(near, far);
      out.buildingLods.push({ near, far, cx: cell.cx, cz: cell.cz });
      yield 'buildings';
    }
    if (cGeos.length) {
      const cm = new THREE.Mesh(mergeGeometries(cGeos), campusMat); cm.name = 'campus'; cm.castShadow = cm.receiveShadow = true; g.add(cm);
      cGeos.forEach(x => x.dispose());
    }
    const [tcx, tcz] = TRACK.c;      // the running track north of the gym (campustrack.js)
    if (tcx >= td.x0 && tcx < td.x0 + T && tcz >= td.z0 && tcz < td.z0 + T) { g.add(...buildTrackMeshes(td.terrainAt)); yield 'track'; }
    if (lGeos.length) {
      const lm = new THREE.Mesh(mergeGeometries(lGeos), campusMat); lm.name = 'landmarks'; lm.castShadow = lm.receiveShadow = true; g.add(lm);
      lGeos.forEach(x => x.dispose());
    }
    yield* addProps(g, out.propLods, td, propGeos, propMat);
    yield* addCampusItems(g, out.campusItemLods, td, campusItemGeos, propMat);
    out.scenery = createTileScenery(td); g.add(out.scenery.group);
    out.textures.push(...out.scenery.textures); out.materials.push(...out.scenery.materials);
    yield 'scenery';
    return out;
  }

  // A dropped tile's materials are disposed, except one that is the last user of its shader program: three.js would
  // delete that program and compile it again (a stutter) as soon as the next tile using it is drawn, which happens after
  // every teleport, H or far respawn (all old tiles drop before the new ones arrive). Kept, it costs no GPU memory (its
  // textures are freed with the tile); at most one is kept per program.
  const keepers = new Set();
  const lastUser = m => { const ps = renderer.properties?.get(m)?.programs; return !!ps && [...ps.values()].some(p => p.usedTimes === 1); };
  function dispose(v) {
    v.dead = true;
    v.group.traverse(o => { if (o.isInstancedMesh) o.dispose(); if (o.geometry && !SHARED.has(o.geometry)) o.geometry.dispose(); });
    v.textures.forEach(t => t.dispose()); v.materials.forEach(m => { if (lastUser(m)) keepers.add(m); else m.dispose(); });
    group.remove(v.group);
  }

  // fetch → build in time slices → add to the world; a tile that fails is freed and retried later (tilequeue.js)
  const queue = createTileQueue({
    fetch: job => fetchTile(job.tx, job.tz),
    build: (job, { data, img }) => { job.img = img; return buildTile(job.tx, job.tz, data, img, job); },
    finish: (job, v) => { world.add(v.td); vis.set(job.k, v); group.add(v.group); lastShadowAt = null; },
    free: job => {
      const v = job.partial;
      if (v) { if (vis.get(job.k) === v) { vis.delete(job.k); world.remove(job.tx, job.tz); } dispose(v); }
      job.img?.forEach(b => b.close?.());
    },
  });
  function startLoad(tx, tz, now = false) {
    const k = world.key(tx, tz);
    if (vis.has(k) || !available.has(k)) return null;
    return queue.start(k, { tx, tz }, now);
  }

  // which tiles should be loaded around a point
  function wanted(x, z, R) {
    const out = [];
    const [a0, b0] = world.tileIndex(x - R, z - R), [a1, b1] = world.tileIndex(x + R, z + R);
    for (let tz = b0; tz <= b1; tz++) for (let tx = a0; tx <= a1; tx++) {
      const rx0 = tx * T - T / 2, rz0 = tz * T - T / 2;
      const dx = Math.max(rx0 - x, 0, x - (rx0 + T)), dz = Math.max(rz0 - z, 0, z - (rz0 + T));
      if (Math.hypot(dx, dz) < R && available.has(world.key(tx, tz))) out.push([tx, tz]);
    }
    return out;
  }

  // initial load: everything around the spawn, fully built before the game starts
  const [sx, sz] = W.spawn;
  const first = wanted(sx, sz, LOAD_R);
  let done = 0;
  await Promise.all(first.map(([tx, tz]) => (startLoad(tx, tz, true) || Promise.resolve()).then(() => onProgress(++done, first.length))));

  // vel (m/s, optional): at speed, also load around points up to AHEAD_S seconds ahead along the turn being flown
  // (streamplan.js lookAhead), nearest the camera first (needDist), so the map keeps up even at 1000 km/h
  // extraMs: more build time while the game is paused for the ground to load (a respawn hold, respawnhold.js)
  const turn = STREAM.createTurnTracker();
  let lastNow = 0, frameMs = 16.7;
  const stream = { urgent: false, budget: 0, hidden: 0, up: 0, detailMs: 0 };   // this frame's choices (tools/fly_lag_*.mjs read them)
  function update(cam, vel, extraMs = 0) {
    const now = performance.now(), dt = lastNow ? now - lastNow : 16.7; lastNow = now;
    if (dt < 250) frameMs += (dt - frameMs) * 0.1;
    const sp = vel ? Math.hypot(vel.x, vel.z) : 0, w = vel ? turn.update(vel.x, vel.z, now) : 0;
    const ahead = vel ? STREAM.lookAhead(cam.x, cam.z, vel.x, vel.z, w) : [];
    const want = new Map();
    for (const p of [cam, ...ahead]) for (const [tx, tz] of wanted(p.x, p.z, LOAD_R)) want.set(world.key(tx, tz), [tx, tz]);
    const need = ([tx, tz]) => STREAM.needDist(tx * T - T / 2, tz * T - T / 2, T, cam);
    // at most 3 tiles in flight, but a tile near the camera (the one under it, or one it is about to reach) never waits
    // behind look-ahead tiles, or tiles from before a respawn / teleport
    let urgent = false;
    const urgentR = STREAM.urgentDist(sp);
    for (const [tx, tz] of [...want.values()].sort((p, q) => need(p) - need(q))) {
      const close = STREAM.rectDist(cam.x, cam.z, tx * T - T / 2, tz * T - T / 2, T) < urgentR;
      if (close && !vis.has(world.key(tx, tz))) urgent = true;
      if (queue.loading.size < 3 || close) startLoad(tx, tz);
    }
    // beyond DROP_R: hidden and kept (turning back doesn't build them again) until too far or too many
    const built = [];
    for (const [k, v] of vis) { const t = world.tiles.get(k); if (t) built.push({ k, d: STREAM.rectDist(cam.x, cam.z, t.x0, t.z0, T) }); }
    const plan = STREAM.planKeep(built);
    for (const k of plan.drop) { const v = vis.get(k), t = world.tiles.get(k); dispose(v); vis.delete(k); world.remove(t.tx, t.tz); lastShadowAt = null; }
    stream.hidden = 0;
    for (const [k, v] of vis) {
      const show = plan.show.has(k) || !world.tiles.has(k);
      if (v.group.visible !== show) { v.group.visible = show; lastShadowAt = null; }
      if (!show) stream.hidden++;
    }
    // build steps within this frame's budget: full-detail terrain near the camera first (needed within ~1 s), then
    // tiles, nearest first, by the same measure the loads are ordered by (after a respawn / teleport the queue
    // can still hold tiles from where the vehicle was)
    stream.urgent = urgent; stream.budget = STREAM.buildBudget(sp, { urgent, frameMs, extraMs });
    stream.detailMs = buildDetail(stream.budget);
    queue.update(Math.max(0.1, stream.budget - stream.detailMs), j => need([j.tx, j.tz]));
  }

  // full-detail terrain chunks (buildTile leaves them out) once the camera is within DETAIL_R, nearest first, from the
  // chunks the last updateLOD listed; one a frame at least while one is already in view range (< 420 m: until then the
  // next level down is shown). From high up (true distance) they are never built. Returns the ms spent.
  const DETAIL_R = 700, detail = [];
  let detailCost = 3;
  function buildDetail(budget) {
    if (!detail.length) return 0;
    detail.sort((a, b) => a.d - b.d);
    const t0 = performance.now();
    let first = true;
    for (const { c, d, v } of detail) {
      if (v.dead || c.levels[0]) continue;
      const t = performance.now();
      if (!(first && d < 420) && t - t0 + detailCost > budget) break;
      first = false; c.levels[0] = c.full(); c.lv = -1;
      const ms = performance.now() - t; detailCost = Math.max(ms, detailCost * 0.9 + ms * 0.1);
    }
    detail.length = 0;
    return performance.now() - t0;
  }

  // shadow casters: only trees near the car (that's all the shadow area covers); invisible in the normal view
  const SHADOW_R = 75;
  const ghost = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const casters = [conifer, broadleaf].map(geo => {
    const m = new THREE.InstancedMesh(geo, ghost, 4000); m.count = 0; m.castShadow = true; m.frustumCulled = false; group.add(m); return m;
  });
  // p: the vehicle. Above SHADOW_UP m the shadow camera (60–260 m from the sun, centred on the vehicle) can't reach the
  // ground: no tree casters, instead of up to 8000 drawn into the shadow map every frame for nothing
  const SHADOW_UP = 200;
  function updateShadows(p) {
    const high = Number.isFinite(p.y) && world.loadedAt(p.x, p.z) && p.y - world.terrainAt(p.x, p.z) > SHADOW_UP;
    if (high) { casters.forEach(m => { m.count = 0; }); lastShadowAt = null; return; }
    if (lastShadowAt && Math.hypot(p.x - lastShadowAt.x, p.z - lastShadowAt.z) < 10) return;
    lastShadowAt = { x: p.x, z: p.z };
    const n = [0, 0];
    for (const [k, v] of vis) {
      const t = world.tiles.get(k); if (!t || !v.treeMats || !v.group.visible) continue;
      const dx = Math.max(t.x0 - p.x, 0, p.x - (t.x0 + T)), dz = Math.max(t.z0 - p.z, 0, p.z - (t.z0 + T));
      if (Math.hypot(dx, dz) > SHADOW_R) continue;
      const tr = t.trees;
      for (let i = 0; i < t.treeCount; i++) {
        const x = tr[i * 4], z = tr[i * 4 + 1];
        if (Math.abs(x - p.x) > SHADOW_R || Math.abs(z - p.z) > SHADOW_R || Math.hypot(x - p.x, z - p.z) > SHADOW_R) continue;
        const kind = tr[i * 4 + 3] > 0 ? 1 : 0; if (n[kind] >= 4000) continue;
        casters[kind].instanceMatrix.array.set(v.treeMats.subarray(i * 16, i * 16 + 16), n[kind] * 16); n[kind]++;
      }
    }
    casters.forEach((m, i) => { m.count = n[i]; m.instanceMatrix.needsUpdate = true; });
  }

  // Detail levels go by the camera's true distance, its height above the ground included: from high up everything
  // below is drawn at far detail, and above HIGH m the props, campus items and roadside scenery (all within 650 m, a
  // few pixels from there) are not drawn. Driving, the camera is a few metres up: the same levels as before.
  // The town's far cut-off stays a flat distance (towns must not vanish under a high jet).
  const HIGH = 300, NOWHERE = { x: 1e9, y: 0, z: 1e9 };
  function updateLOD(cam, vel, extraMs = 0) {
    update(cam, vel, extraMs);
    const up = Number.isFinite(cam.y) && world.loadedAt(cam.x, cam.z) ? Math.max(0, cam.y - world.terrainAt(cam.x, cam.z)) : 0, up2 = up * up;
    const small = up > HIGH ? NOWHERE : cam;
    stream.up = up;
    detail.length = 0;
    for (const v of vis.values()) {
      if (!v.group.visible) continue;                 // kept beyond DROP_R (streamplan.js planKeep)
      v.scenery?.update(small, sceneryTime, nightAmount);
      for (const c of v.chunks) {
        const d = Math.sqrt((c.cx - cam.x) ** 2 + (c.cz - cam.z) ** 2 + up2);
        let lv = d < 420 ? 0 : d < 850 ? 1 : d < 1500 ? 2 : 3;
        if (!c.levels[0] && d < DETAIL_R) { detail.push({ c, d, v }); if (!lv) lv = 1; }
        if (lv !== c.lv) { c.levels.forEach((m, i) => { if (m) m.visible = i === lv; }); c.lv = lv; }
      }
      for (const l of v.treeLods) {
        const near = (l.cx - cam.x) ** 2 + (l.cz - cam.z) ** 2 + up2 < 420 * 420;
        l.near.visible = near; l.far.visible = !near;
      }
      for (const b of v.buildingLods) {
        const flat = Math.hypot(b.cx - cam.x, b.cz - cam.z), d = Math.sqrt(flat * flat + up2);
        b.near.visible = d < townRange.near;
        b.far.visible = d >= townRange.near && flat < townRange.far;
        b.near.castShadow = d < townRange.shadow;
      }
      showBridges(v.bridges, cam);
      showProps(v.propLods, small);
      showCampusItems(v.campusItemLods, small);
      for (const c of v.campusLods) {
        const near = (c.cx - cam.x) ** 2 + (c.cz - cam.z) ** 2 + up2 < 250 * 250;
        c.near.visible = near; c.far.visible = !near;
      }
    }
    notePerf();
  }
  return Object.assign(world, { group, updateLOD, updateShadows, townRange, setWetness(value) { world.wetness = Math.max(0, Math.min(1, Number(value) || 0)); stripMat.color.setScalar(1 - world.wetness * .24); }, setNight(value) { nightAmount = Math.max(0, Math.min(1, Number(value) || 0)); },
    tick(t) { waterUniforms.time.value = t; windTime.value = t; sceneryTime = t; },
    loadedTiles: () => vis.size, pendingTiles: () => queue.pending(), buildStep: queue.slowStep, stream });
}


// unit-height low-poly conifer: trunk + three stacked cones, vertex coloured
function coniferGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.05, 0.07, 0.25, 5); trunk.translate(0, 0.125, 0);
  parts.push(paint(trunk, 0x5a4030));
  const tiers = [[0.18, 0.5, 1.0, 0.36], [0.42, 0.42, 0.8, 0.30], [0.64, 0.36, 0.55, 0.22]];
  for (const [y, hgt, rad, _] of tiers) {
    const c = new THREE.ConeGeometry(rad * 0.5, hgt, 7); c.translate(0, y + hgt / 2, 0);
    parts.push(paint(c, 0x2f5a34));
  }
  return mergeGeometries(parts);
}
// Ground: flat-colour map + two layers of world-space grain (fine 3 m and coarse 23 m) so speed reads up
// close, plus flat shading for the low-poly facet look.
function groundMaterial(tex) {
  const mat = tex ? new THREE.MeshLambertMaterial({ map: tex, flatShading: true })
    : new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const detail = grainTexture();                 // one shared texture, built once
  mat.onBeforeCompile = sh => {
    sh.uniforms.detailMap = { value: detail };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;\nuniform sampler2D detailMap;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float g1 = texture2D(detailMap, vWorld.xz / 3.1).r;
        float g2 = texture2D(detailMap, vWorld.xz / 23.0 + 0.37).g;
        float camD = length(vWorld - cameraPosition);
        float fade = 1.0 - smoothstep(60.0, 260.0, camD);
        diffuseColor.rgb *= mix(1.0, 0.82 + g1 * 0.32, fade) * (0.9 + g2 * 0.2);`);
  };
  return mat;
}
let _grain = null;
function grainTexture() {
  if (_grain) return _grain;
  const n = 256, c = document.createElement('canvas'); c.width = c.height = n;
  const ctx = c.getContext('2d'), img = ctx.createImageData(n, n);
  let seed = 9; const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // value noise at two scales, tileable
  const grid = (k) => { const g = []; for (let i = 0; i < k * k; i++) g.push(r()); return (x, y) => {
    const fx = x * k / n, fy = y * k / n, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (a, b) => g[((b % k + k) % k) * k + ((a % k + k) % k)];
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy; }; };
  const a = grid(32), b = grid(8), d = grid(64);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (y * n + x) * 4;
    img.data[i] = (a(x, y) * 0.6 + d(x, y) * 0.4) * 255; img.data[i + 1] = b(x, y) * 255; img.data[i + 2] = 0; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  return (_grain = t);
}
function farConifer() {
  const c = new THREE.ConeGeometry(0.36, 0.85, 5); c.translate(0, 0.15 + 0.425, 0);
  return paint(c, 0x2f5a34);
}
function farBroadleaf() {
  const c = new THREE.OctahedronGeometry(0.5, 0); c.scale(1, 0.8, 1); c.translate(0, 0.62, 0);
  return paint(c, 0x4f7d34);
}
function broadleafGeometry() {
  const trunk = new THREE.CylinderGeometry(0.03, 0.05, 0.45, 5); trunk.translate(0, 0.225, 0);
  const crown = new THREE.IcosahedronGeometry(0.5, 0); crown.scale(1, 0.75, 1); crown.translate(0, 0.62, 0);
  const crown2 = new THREE.IcosahedronGeometry(0.33, 0); crown2.translate(0.22, 0.8, 0.1);
  return mergeGeometries([paint(trunk, 0x5c4532), paint(crown.toNonIndexed(), 0x4f7d34), paint(crown2.toNonIndexed(), 0x5a8a3a)]
    .map(g => g.index ? g.toNonIndexed() : g));
}
function paint(g, hex) {
  g = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(hex), a = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g;
}
