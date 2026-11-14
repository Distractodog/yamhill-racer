// Painted marks on the ground: a small east-lawn court and the west-wing stalls (the running
// track is campustrackmodel.js). Flat quads with polygon offset, not a new surface, so class 7
// still drives and the drive numbers stay put. No kerbs.
import * as THREE from 'three';
import { ENTRANCE } from './campus.js';

const RED = [0.62, 0.16, 0.14];
const WHITE = [0.92, 0.92, 0.90];
const PAD = [0.62, 0.62, 0.60];
const KEY = [0.55, 0.28, 0.22];

const _c = new THREE.Color();
const lin = col => { _c.setRGB(col[0], col[1], col[2], THREE.SRGBColorSpace); return [_c.r, _c.g, _c.b]; };
function quad(P, C, a, b, c, d, col) {
  const crossY = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  if (crossY < 0) { const t = b; b = d; d = t; }
  const k = lin(col);
  P.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i < 6; i++) C.push(...k);
}


export function addCampusPaint(group, ground) {
  const P = [], C = [];
  const y = (x, z, lift = 0.1) => [x, ground(x, z) + lift, z];
  // eight stall marks on the pad in front of the west wing
  const { N, U } = ENTRANCE;
  const origin = [-607.2, 382.3];
  for (let i = 0; i < 8; i++) {
    const u = 2.2 + i * 2.6;
    const a = [origin[0] + U[0] * u + N[0] * 5, origin[1] + U[1] * u + N[1] * 5];
    const b = [origin[0] + U[0] * u + N[0] * 10, origin[1] + U[1] * u + N[1] * 10];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1, px = -dz / L * 0.07, pz = dx / L * 0.07;
    quad(P, C, y(a[0] - px, a[1] - pz, 0.1), y(b[0] - px, b[1] - pz, 0.1), y(b[0] + px, b[1] + pz, 0.1), y(a[0] + px, a[1] + pz, 0.1), WHITE);
  }

  // east lawn: a small pad and one key, not a full-size court
  const bx = -470, bz = 340;
  quad(P, C, y(bx - 5, bz - 3.5, 0.08), y(bx + 5, bz - 3.5, 0.08), y(bx + 5, bz + 3.5, 0.08), y(bx - 5, bz + 3.5, 0.08), PAD);
  quad(P, C, y(bx - 1.6, bz - 2.2, 0.1), y(bx + 1.6, bz - 2.2, 0.1), y(bx + 1.6, bz + 0.4, 0.1), y(bx - 1.6, bz + 0.4, 0.1), KEY);
  quad(P, C, y(bx - 1.8, bz + 0.3, 0.12), y(bx + 1.8, bz + 0.3, 0.12), y(bx + 1.8, bz + 0.45, 0.12), y(bx - 1.8, bz + 0.45, 0.12), WHITE);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'campus-paint'; mesh.renderOrder = 2; mesh.receiveShadow = true;
  group.add(mesh);
}
