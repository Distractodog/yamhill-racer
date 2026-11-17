// Render-only terrain boundaries. Every LOD keeps the same 4 m edge polyline;
// only the outer row of coarse cells is triangulated differently. Physics and
// interior heights/triangles are unchanged, including the road clearance rule.
import * as THREE from 'three';

export const TERRAIN_CHUNK = 125;
export const TERRAIN_STEPS = [1, 2, 4, 8];

export function terrainGeometry(td, W, heightFor, i0, j0, i1, j1, st, qi0, qj0) {
  const { H, NN } = td, HS = W.hstep, HM = W.hm, QN = (W.hn - 1) / 2;
  const is = [], js = [];
  for (let i = i0; i < i1; i += st) is.push(i); is.push(i1);
  for (let j = j0; j < j1; j += st) js.push(j); js.push(j1);
  const ni = is.length, nj = js.length;
  const extra = st === 1 ? 0 : 2 * (i1 - i0 + j1 - j0) - 2 * (ni + nj - 2);
  const fans = st === 1 ? 0 : 2 * (ni + nj - 4);
  const count = ni * nj + extra + fans;
  const P = new Float32Array(count * 3), U = new Float32Array(count * 2), N = new Float32Array(count * 3);
  const Index = count > 65535 ? Uint32Array : Uint16Array;
  const I = new Index((2 * (ni - 1) * (nj - 1) + extra + 2 * fans) * 3);
  let vertexCount = 0, indexCount = 0;
  const triangle = (a, b, c) => { I[indexCount++] = a; I[indexCount++] = b; I[indexCount++] = c; };
  const row = j1 - j0 + 1, vertices = new Int32Array((i1 - i0 + 1) * row);
  const boundary = (i, j) => i === i0 || i === i1 || j === j0 || j === j1;
  const vertex = (i, j, y) => {
    const gi = i + HM, gj = j + HM, k = gi * NN + gj;
    const edge = boundary(i, j);
    const v = vertexCount++, p = v * 3, uv = v * 2;
    P[p] = td.x0 + j * HS; P[p + 1] = y ?? (edge ? H[k] : heightFor(gi, gj, st)); P[p + 2] = td.z0 + i * HS;
    U[uv] = (j - qj0) / QN; U[uv + 1] = (i - qi0) / QN;
    // Padded heights contain the neighbour's samples even before it is loaded.
    // Keep these unnormalised: interpolate the gradient, then normalise in GLSL.
    if (edge) {
      N[p] = (H[k - 1] - H[k + 1]) / (2 * HS); N[p + 1] = 1;
      N[p + 2] = (H[k - NN] - H[k + NN]) / (2 * HS);
    }
    return v;
  };
  const at = (i, j) => {
    const key = (i - i0) * row + j - j0;
    if (!vertices[key]) vertices[key] = vertex(i, j) + 1;
    return vertices[key] - 1;
  };
  // Preserve the original grid vertex ordering for the ordinary cells.
  for (const i of is) for (const j of js) vertices[(i - i0) * row + j - j0] = vertex(i, j) + 1;
  for (let a = 0; a < is.length - 1; a++) for (let b = 0; b < js.length - 1; b++) {
    const i = is[a], ie = is[a + 1], j = js[b], je = js[b + 1];
    const v00 = a * nj + b, v01 = v00 + 1, v10 = v00 + nj, v11 = v10 + 1;
    if (st === 1 || (i !== i0 && ie !== i1 && j !== j0 && je !== j1)) {
      triangle(v00, v10, v01); triangle(v01, v10, v11); continue;
    }
    // Fan around the old diagonal midpoint, inserting fine samples only on
    // the chunk boundary. The other three sides still meet the coarse grid.
    const ring = [v00];
    if (j === j0) for (let q = i + 1; q < ie; q++) ring.push(at(q, j));
    ring.push(v10);
    if (ie === i1) for (let q = j + 1; q < je; q++) ring.push(at(ie, q));
    ring.push(v11);
    if (je === j1) for (let q = ie - 1; q > i; q--) ring.push(at(q, je));
    ring.push(v01);
    if (i === i0) for (let q = je - 1; q > j; q--) ring.push(at(i, q));
    const center = vertex((i + ie) / 2, (j + je) / 2, (P[v01 * 3 + 1] + P[v10 * 3 + 1]) / 2);
    for (let k = 0; k < ring.length; k++) triangle(center, ring[k], ring[(k + 1) % ring.length]);
  }
  // Matching polylines close the mesh at every LOD; no overlapping skirt
  // walls are needed (or added to the draw count).
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  geo.setAttribute('edgeNormal', new THREE.BufferAttribute(N, 3));
  geo.setIndex(new THREE.BufferAttribute(I, 1)); geo.computeBoundingSphere();
  return geo;
}

// Ground retains flat facets except within 4 m of a chunk edge. World-space
// distance makes the band the same width at every LOD, and shared edge samples
// make its lighting independent of which neighbour has streamed in.
export function terrainEdgeShader(shader, tileSize, chunkSize) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 edgeNormal;\nvarying vec3 vEdgeNormal;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEdgeNormal = normalMatrix * edgeNormal;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vEdgeNormal;')
    .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
      vec2 edgeCell = mod(vWorld.xz + vec2(${(tileSize / 2).toFixed(1)}), ${chunkSize.toFixed(1)});
      vec2 edgeDist = min(edgeCell, vec2(${chunkSize.toFixed(1)}) - edgeCell);
      float edgeBlend = 1.0 - smoothstep(0.0, 4.0, min(edgeDist.x, edgeDist.y));
      if (edgeBlend > 0.0 && dot(vEdgeNormal, vEdgeNormal) > 0.000001)
        normal = normalize(mix(normal, normalize(vEdgeNormal), edgeBlend));`);
}
