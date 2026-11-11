// 3D meshes for the road / trail strips of one tile (geometry from data.js `renderRoads`).
import * as THREE from 'three';

const TOP = { asphalt: 0x50535c, gravel: 0xb9a888, trail: 0xc98d55 };
const SIDE = { asphalt: 0x44474f, gravel: 0xa39472, trail: 0xb27a47 };
const LINE = 0xf2f2ea, DASH = 0xf3c63c;
const RGB = {};
for (const hex of [...Object.values(TOP), ...Object.values(SIDE), LINE, DASH]) { const c = new THREE.Color(hex); RGB[hex] = [c.r, c.g, c.b]; }

// Splits a tile's strips into batches of roughly `samples` strip samples each (so no batch takes too long to build).
export function roadBatches(list, samples = 1500) {
  const out = []; let cur = [], n = 0;
  for (const r of list) {
    if (r.n > samples) {                         // a very long strip: build it in slices
      for (let a = 0; a < r.n - 1; a += samples) out.push([{ r, a, b: Math.min(r.n - 1, a + samples) }]);
      continue;
    }
    cur.push({ r, a: 0, b: r.n - 1 }); n += r.n;
    if (n >= samples) { out.push(cur); cur = []; n = 0; }
  }
  if (cur.length) out.push(cur);
  return out;
}

export function buildRoads(D, groundMat, batch) {
  // count quads first so everything goes straight into typed arrays
  let quads = 0;
  for (const { r, a, b } of batch) quads += (b - a) * (r.kind === 'asphalt' ? 9 : 4);
  const pos = new Float32Array(quads * 18), col = new Float32Array(quads * 18);
  let p = 0;
  const put = (arr, i, c) => { pos[p] = arr[i]; pos[p + 1] = arr[i + 1]; pos[p + 2] = arr[i + 2]; col[p] = c[0]; col[p + 1] = c[1]; col[p + 2] = c[2]; p += 3; };
  for (const { r, a, b } of batch) {
    const { x, z, lx, lz, hw, raise, kind } = r;
    const lineW = kind === 'asphalt' ? 0.35 : 0;
    const offs = kind === 'asphalt' ? [hw + 0.3, hw, hw - 0.5, hw - 0.5 - lineW, 0.12, -0.12,
      -(hw - 0.5 - lineW), -(hw - 0.5), -hw, -(hw + 0.3)] : [hw + 0.3, hw, 0, -hw, -(hw + 0.3)];
    const K = offs.length, lift = raise + (r.id % 7) * 0.004;        // tiny per-strip lift stops overlaps flickering
    let prev = new Float32Array(K * 3), row = new Float32Array(K * 3);
    const fill = (i, out) => {
      for (let k = 0; k < K; k++) {
        const o = offs[k], px = x[i] + lx[i] * o, pz = z[i] + lz[i] * o;
        out[k * 3] = px; out[k * 3 + 1] = D.terrainAt(px, pz) + (k === 0 || k === K - 1 ? -0.05 : lift); out[k * 3 + 2] = pz;
      }
    };
    fill(a, prev);
    for (let i = a; i < b; i++) {
      fill(i + 1, row);
      const dashOn = Math.floor(i / 2) % 2 === 0;
      for (let k = 0; k < K - 1; k++) {
        let hex = TOP[kind];
        if (k === 0 || k === K - 2) hex = SIDE[kind];
        else if (kind === 'asphalt' && (k === 2 || k === K - 4)) hex = LINE;
        else if (kind === 'asphalt' && k === 4) hex = dashOn ? DASH : TOP[kind];
        const c = RGB[hex], A = k * 3, B = (k + 1) * 3;
        // quad prev[k], prev[k+1], row[k+1], row[k] as two triangles (faces point up)
        put(prev, A, c); put(prev, B, c); put(row, B, c);
        put(prev, A, c); put(row, B, c); put(row, A, c);
      }
      const t = prev; prev = row; row = t;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, p), 3));
  g.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, p), 3));
  g.computeVertexNormals();
  const strips = new THREE.Mesh(g, groundMat);
  strips.receiveShadow = true;
  return strips;
}
