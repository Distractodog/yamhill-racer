// 3D meshes for the road / trail strips and junction pieces of one tile (data.js `renderRoads` / `renderJunctions`).
// Heights are baked by the build (tools/roadnet.py), which also carved the ground just below every road.
import * as THREE from 'three';

const TOP = { asphalt: 0x50535c, gravel: 0xb9a888, trail: 0xc98d55 };
const SIDE = { asphalt: 0x44474f, gravel: 0xa39472, trail: 0xb27a47 };
const LINE = 0xf2f2ea, DASH = 0xf3c63c;
// Developed school drives use town asphalt, without yellow centre markings. Woodland trails stay dirt.
export function campusRoad(x, z, kind) {
  const developed = x >= -900 && x <= -350 && z >= 130 && z <= 650;
  const courtyard = x >= -660 && x <= -470 && z >= 200 && z <= 460;
  return developed && (kind !== 'trail' || courtyard);
}
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
  for (const { r, a, b } of batch) quads += (b - a) * (r.kind === 'asphalt' ? 11 : 6);
  const pos = new Float32Array(quads * 18), col = new Float32Array(quads * 18);
  let p = 0;
  const put = (arr, i, c) => { pos[p] = arr[i]; pos[p + 1] = arr[i + 1]; pos[p + 2] = arr[i + 2]; col[p] = c[0]; col[p + 1] = c[1]; col[p + 2] = c[2]; p += 3; };
  for (const { r, a, b } of batch) {
    const { x, z, y, c, lx, lz, hw, kind } = r;
    const lineW = kind === 'asphalt' ? 0.35 : 0;
    const offs = kind === 'asphalt' ? [hw + 1.2, hw + 0.4, hw, hw - 0.5, hw - 0.5 - lineW, 0.12, -0.12,
      -(hw - 0.5 - lineW), -(hw - 0.5), -hw, -(hw + 0.4), -(hw + 1.2)] : [hw + 1.2, hw + 0.4, hw, 0, -hw, -(hw + 0.4), -(hw + 1.2)];
    const K = offs.length;
    let prev = new Float32Array(K * 3), row = new Float32Array(K * 3);
    const fill = (i, out) => {
      for (let k = 0; k < K; k++) {
        const o = offs[k];
        out[k * 3] = x[i] + lx[i] * o; out[k * 3 + 1] = y[i] + c[i] * o + (k === 0 || k === K - 1 ? -3 : k === 1 || k === K - 2 ? -0.3 : 0); out[k * 3 + 2] = z[i] + lz[i] * o;
      }
    };
    fill(a, prev);
    for (let i = a; i < b; i++) {
      fill(i + 1, row);
      const school = campusRoad((x[i] + x[i + 1]) / 2, (z[i] + z[i + 1]) / 2, kind);
      const style = school ? 'asphalt' : kind;
      const dashOn = !school && Math.floor(i / 2) % 2 === 0;
      for (let k = 0; k < K - 1; k++) {
        let hex = TOP[style];
        if (k <= 1 || k >= K - 3) hex = SIDE[style];
        else if (kind === 'asphalt' && (k === 3 || k === K - 5)) hex = LINE;
        else if (kind === 'asphalt' && k === 5) hex = dashOn ? DASH : TOP[style];
        const rgb = RGB[hex], A = k * 3, B = (k + 1) * 3;
        // quad prev[k], prev[k+1], row[k+1], row[k] as two triangles (faces point up)
        put(prev, A, rgb); put(prev, B, rgb); put(row, B, rgb);
        put(prev, A, rgb); put(row, B, rgb); put(row, A, rgb);
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

// Junction pieces: a fan from the centre over the ring (road ends joined by curved corners), plus a sloped skirt
// along the open (corner) edges so the piece meets the ground like the strips' sides do.
export function buildJunctions(list, groundMat) {
  const P = [], Cc = [];
  const tri = (a, b, d, col) => {
    // keep every face pointing up / outward-up
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    const ny = uz * vx - ux * vz;
    const pts = ny >= 0 ? [a, b, d] : [a, d, b];
    for (const q of pts) { P.push(q[0], q[1], q[2]); Cc.push(col[0], col[1], col[2]); }
  };
  for (const j of list) {
    const style = campusRoad(j.c[0], j.c[1], j.kind) ? 'asphalt' : j.kind;
    const top = RGB[TOP[style]], side = RGB[SIDE[style]], R = j.ring, n = R.length;
    const c = [j.c[0], j.c[2], j.c[1]];
    const v = q => [q[0], q[2], q[1]];
    for (let k = 0; k < n; k++) tri(c, v(R[k]), v(R[(k + 1) % n]), top);
    for (let k = 0; k < n; k++) {
      if (!R[k][3]) continue;
      const a = R[k], b = R[(k + 1) % n];
      const out = (q, w, dy) => { const dx = q[0] - j.c[0], dz = q[1] - j.c[1], L = Math.hypot(dx, dz) || 1;
        return [q[0] + dx / L * w, q[2] - dy, q[1] + dz / L * w]; };
      const A = v(a), B = v(b), A2 = out(a, 0.4, 0.3), B2 = out(b, 0.4, 0.3), A3 = out(a, 1.2, 3), B3 = out(b, 1.2, 3);
      tri(A, B, B2, side); tri(A, B2, A2, side); tri(A2, B2, B3, side); tri(A2, B3, A3, side);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, groundMat); m.receiveShadow = true;
  return m;
}
