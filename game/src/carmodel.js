// Low-poly open-wheel racer. Local axes: +z forward, +y up, +x = car's left. Origin = centre of mass.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const WHEEL_POS = [   // x, y (hub, at rest), z, front?, radius, width
  [0.98, -0.1, 1.42, true, 0.36, 0.32], [-0.98, -0.1, 1.42, true, 0.36, 0.32],
  [0.98, -0.06, -1.36, false, 0.41, 0.44], [-0.98, -0.06, -1.36, false, 0.41, 0.44],
];

// Lofted body: each section = [z, halfWidthBottom, yBottom, yShoulder, yTop, halfWidthTop]; x offset optional.
function loft(sections, xOff = 0) {
  const ring = s => {
    const [z, hw, yb, ym, yt, thw] = s;
    return [[-hw, yb], [hw, yb], [hw, ym], [thw, yt], [-thw, yt], [-hw, ym]].map(([x, y]) => new THREE.Vector3(x + xOff, y, z));
  };
  const rings = sections.map(ring), P = [];
  const quad = (a, b, c, d) => P.push(a, b, c, a, c, d);
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i], B = rings[i + 1];
    for (let k = 0; k < 6; k++) { const k2 = (k + 1) % 6; quad(A[k], B[k], B[k2], A[k2]); }   // outward-facing
  }
  const cap = (R, flip) => { for (let k = 1; k < 5; k++) flip ? P.push(R[0], R[k + 1], R[k]) : P.push(R[0], R[k], R[k + 1]); };
  cap(rings[0], false); cap(rings[rings.length - 1], true);
  const g = new THREE.BufferGeometry().setFromPoints(P);
  g.computeVertexNormals();
  return g;
}
function box(w, h, d, x, y, z, rx = 0) {
  const g = new THREE.BoxGeometry(w, h, d); if (rx) g.rotateX(rx); g.translate(x, y, z); return g.toNonIndexed();
}
function tint(g, hex) {
  const c = new THREE.Color(hex), a = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3)); g.deleteAttribute('uv'); return g;
}

export function buildCarModel(colors = {}) {
  const C = { paint: 0xe8402f, accent: 0xffffff, carbon: 0x23252b, helmet: 0xffd23a, visor: 0x1c2a3a, ...colors };
  const parts = [];
  // monocoque: needle nose -> cockpit -> engine cover with airbox hump -> tail
  parts.push(tint(loft([
    [2.32, 0.10, -0.06, 0.00, 0.05, 0.06],
    [1.75, 0.20, -0.10, 0.07, 0.16, 0.14],
    [1.05, 0.31, -0.15, 0.13, 0.28, 0.24],
    [0.40, 0.40, -0.17, 0.19, 0.33, 0.30],
    [-0.35, 0.44, -0.17, 0.22, 0.36, 0.30],
    [-0.75, 0.40, -0.16, 0.22, 0.56, 0.16],
    [-1.35, 0.32, -0.15, 0.18, 0.38, 0.18],
    [-1.95, 0.18, -0.12, 0.08, 0.20, 0.10],
  ]), C.paint));
  // sidepods
  for (const s of [1, -1]) {
    parts.push(tint(loft([
      [0.55, 0.16, -0.16, 0.10, 0.15, 0.12],
      [0.25, 0.24, -0.17, 0.17, 0.25, 0.20],
      [-0.55, 0.24, -0.17, 0.15, 0.22, 0.18],
      [-1.15, 0.12, -0.15, 0.06, 0.10, 0.08],
    ], s * 0.58), C.paint));
    parts.push(tint(box(0.5, 0.05, 0.9, s * 0.58, 0.24, -0.2), C.accent));            // stripe on pod
  }
  // white nose stripe and number panel
  parts.push(tint(box(0.16, 0.03, 1.5, 0, 0.215, 1.35, -0.12), C.accent));
  // cockpit tub, roll hoop, helmet
  parts.push(tint(box(0.5, 0.06, 0.75, 0, 0.33, 0.05), C.carbon));
  const helmet = new THREE.IcosahedronGeometry(0.19, 1); helmet.translate(0, 0.47, -0.08);
  parts.push(tint(helmet, C.helmet));
  parts.push(tint(box(0.3, 0.08, 0.06, 0, 0.5, 0.08), C.visor));
  parts.push(tint(box(0.12, 0.22, 0.12, 0, 0.62, -0.55), C.carbon));                  // air intake above hoop
  // front wing + endplates
  parts.push(tint(box(2.05, 0.05, 0.42, 0, -0.13, 2.18), C.carbon));
  parts.push(tint(box(1.7, 0.04, 0.22, 0, -0.04, 2.08, 0.25), C.paint));
  for (const s of [1, -1]) parts.push(tint(box(0.05, 0.24, 0.52, s * 1.03, -0.04, 2.16), C.paint));
  // rear wing on two pylons + endplates
  parts.push(tint(box(1.55, 0.06, 0.42, 0, 0.78, -2.02, 0.12), C.carbon));
  parts.push(tint(box(1.55, 0.05, 0.22, 0, 0.92, -2.12, 0.35), C.paint));
  for (const s of [1, -1]) {
    parts.push(tint(box(0.05, 0.5, 0.6, s * 0.8, 0.72, -2.04), C.paint));
    parts.push(tint(box(0.06, 0.62, 0.12, s * 0.22, 0.42, -1.9), C.carbon));
  }
  // diffuser / floor
  parts.push(tint(box(1.3, 0.05, 2.9, 0, -0.19, -0.35), C.carbon));
  // suspension arms (visual)
  for (const [x, y, z] of WHEEL_POS) {
    const len = Math.abs(x) - 0.3;
    for (const dy of [-0.06, 0.08]) parts.push(tint(box(len, 0.035, 0.07, Math.sign(x) * (0.3 + len / 2), y + dy, z), C.carbon));
  }
  const bodyGeo = mergeGeometries(parts);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const body = new THREE.Mesh(bodyGeo, mat);
  body.castShadow = true;

  const car = new THREE.Group();
  const bodyPivot = new THREE.Group();     // leans with cornering / braking
  bodyPivot.add(body);
  car.add(bodyPivot);

  const tyreMat = new THREE.MeshLambertMaterial({ color: 0x1d1e22, flatShading: true });
  const rimMat = new THREE.MeshLambertMaterial({ color: 0xd9dce2, flatShading: true });
  const wheels = [];
  for (const [x, y, z, front, r, w] of WHEEL_POS) {
    const holder = new THREE.Group(); holder.position.set(x, y, z);
    const spin = new THREE.Group();
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 12).rotateZ(Math.PI / 2), tyreMat);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.62, w + 0.02, 8).rotateZ(Math.PI / 2), rimMat);
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, r * 1.1, 0.07), tyreMat);
    tyre.castShadow = true;
    spin.add(tyre, rim, spoke); holder.add(spin); car.add(holder);
    wheels.push({ holder, spin, restY: y, front, r });
  }
  car.userData = { wheels, bodyPivot };
  return car;
}
