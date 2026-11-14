// Courtyard dressing, north of the chapel. Pavers, the stone fountain, the seat-wall,
// the fire pit and the planters are a flat picture: not footprints, so a car can cross
// them and the drive routes stay put. No name on the fountain.
import * as THREE from 'three';
import { ENTRANCE } from './campus.js';

const PAVER = [0.72, 0.66, 0.52];
const INSET = [0.55, 0.42, 0.32];
const CREAM = [0.90, 0.86, 0.74];
const BRICK = [0.62, 0.40, 0.28];
const STONE = [0.32, 0.32, 0.33];
const RUST = [0.55, 0.32, 0.20];
const GRASS = [0.34, 0.46, 0.24];
const PIT = [0.18, 0.18, 0.19];

const _c = new THREE.Color();
const lin = col => { _c.setRGB(col[0], col[1], col[2], THREE.SRGBColorSpace); return [_c.r, _c.g, _c.b]; };

function quad(P, C, a, b, c, d, col) {
  const k = lin(col);
  P.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i < 6; i++) C.push(...k);
}

export function addCourtyardDressing(group, ground) {
  const { N, U } = ENTRANCE;
  const c = [-553.05, 358.95];
  const P = [], C = [];
  const at = (n, u) => [c[0] + N[0] * n + U[0] * u, c[1] + N[1] * n + U[1] * u];
  const corner = (n, u, lift = 0.12) => { const p = at(n, u); return [p[0], ground(p[0], p[1]) + lift, p[1]]; };
  const slab = (n0, n1, u0, u1, col, lift) => quad(P, C, corner(n0, u0, lift), corner(n1, u0, lift), corner(n1, u1, lift), corner(n0, u1, lift), col);
  slab(-16, 12, 11, 24, PAVER);
  slab(-4, 4, 14, 20, INSET, 0.14);
  // three-tier seat-wall, then a single planter arc, east of the pavers
  for (let i = 0; i < 14; i++) {
    const a0 = -0.4 + i / 14 * 2.2, a1 = -0.4 + (i + 1) / 14 * 2.2;
    const ring = (rad, lift, h, col) => {
      const p = (a, y) => {
        const n = Math.sin(a) * rad, u = 18 + Math.cos(a) * rad * 0.55;
        const q = at(n, u);
        return [q[0], ground(q[0], q[1]) + y, q[1]];
      };
      quad(P, C, p(a0, lift), p(a1, lift), p(a1, lift + h), p(a0, lift + h), col);
    };
    const tiers = i < 8 ? 3 : 1;
    for (let t = 0; t < tiers; t++) ring(7.5 + t * 0.45, 0.15 + t * 0.28, 0.32, CREAM);
    if (i >= 8) ring(8.6, 0.5, 0.08, BRICK);
  }
  // fire pit: a low cream drum in front of the seat-wall, dark grate on top
  for (let i = 0; i < 10; i++) {
    const a0 = i / 10 * Math.PI * 2, a1 = (i + 1) / 10 * Math.PI * 2;
    const p = (a, rad, y) => {
      const q = at(-8 + Math.sin(a) * rad, 16 + Math.cos(a) * rad);
      return [q[0], ground(q[0], q[1]) + y, q[1]];
    };
    quad(P, C, p(a0, 1.15, 0.1), p(a1, 1.15, 0.1), p(a1, 1.15, 0.7), p(a0, 1.15, 0.7), CREAM);
    quad(P, C, p(a0, 0.2, 0.72), p(a1, 0.2, 0.72), p(a1, 1.0, 0.72), p(a0, 1.0, 0.72), PIT);
  }
  // fountain: three rough stones and a wet disc. No lettering.
  const stone = (n, u, w, h, col, faceU) => {
    const q = at(n, u), y = ground(q[0], q[1]);
    const dx = faceU ? U[0] : N[0], dz = faceU ? U[1] : N[1];
    const px = -dz, pz = dx;
    const a = [q[0] - px * w / 2, y, q[1] - pz * w / 2], b = [q[0] + px * w / 2, y, q[1] + pz * w / 2];
    quad(P, C, a, b, [b[0], y + h, b[2]], [a[0], y + h, a[2]], col);
    quad(P, C, b, a, [a[0], y + h, a[2]], [b[0], y + h, b[2]], col);
  };
  stone(0.4, 16.6, 0.7, 1.5, STONE, false);
  stone(-0.5, 17.4, 0.55, 1.15, RUST, true);
  stone(0.9, 17.2, 0.8, 0.45, STONE, false);
  slab(-1.6, 1.8, 15.2, 18.6, [0.28, 0.36, 0.38], 0.16);
  // planters on the lawn side of the wall
  for (const [n, u] of [[-10, 22], [-2, 23], [6, 22.5]]) {
    stone(n, u, 1.3, 0.7, GRASS, true);
    stone(n, u + 0.7, 0.9, 1.1, [0.28, 0.40, 0.22], false);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'courtyard'; mesh.renderOrder = 2; mesh.receiveShadow = true;
  group.add(mesh);
}
