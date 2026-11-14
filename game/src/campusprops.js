// Entrance dressing that is not a wall: the raised plaza and walks (drivable, so they are
// only a flat picture), the name over the doors, and lamp posts. Flagpoles and steps are
// real footprints in campus.js. Lamp posts are not.
import * as THREE from 'three';
import { ENTRANCE } from './campus.js';

const STONE = [0.93, 0.90, 0.82];
const BRICK = [0.62, 0.32, 0.24];
const CREAM = [0.86, 0.78, 0.62];
const WALK = [0.80, 0.80, 0.78];

const _c = new THREE.Color();
const lin = col => { _c.setRGB(col[0], col[1], col[2], THREE.SRGBColorSpace); return [_c.r, _c.g, _c.b]; };
const add = (p, ...t) => { const r = [p[0], p[1]]; for (let i = 0; i < t.length; i += 2) { r[0] += t[i][0] * t[i + 1]; r[1] += t[i][1] * t[i + 1]; } return r; };

function quad(P, C, a, b, c, d, col) {
  const k = lin(col);
  P.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i < 6; i++) C.push(...k);
}

function signMaterial() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 512; c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = '#ebe4d4';
  g.fillRect(0, 0, 512, 160);
  g.fillStyle = '#2a241c';
  g.textAlign = 'center';
  g.font = 'bold 46px sans-serif';
  g.fillText('THE DELPHIAN', 256, 62);
  g.fillText('SCHOOL', 256, 122);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshLambertMaterial({ map: tex });
}

function lampGeometry() {
  const pole = new THREE.CylinderGeometry(0.06, 0.08, 3.2, 6); pole.translate(0, 1.6, 0);
  const disc = new THREE.CylinderGeometry(0.55, 0.55, 0.06, 10); disc.translate(0, 3.25, 0);
  const head = new THREE.CylinderGeometry(0.08, 0.12, 0.16, 6); head.translate(0, 3.12, 0);
  const geo = new THREE.BufferGeometry();
  const parts = [pole, disc, head].map(g => g.index ? g.toNonIndexed() : g);
  const colors = [0xb7bcc2, 0xd5d8dc, 0xf0d48a];
  let n = 0;
  for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  parts.forEach((g, i) => {
    const p = g.attributes.position.array, k = new THREE.Color(colors[i]);
    for (let v = 0; v < g.attributes.position.count; v++) {
      pos.set(p.subarray(v * 3, v * 3 + 3), (o + v) * 3);
      col[(o + v) * 3] = k.r; col[(o + v) * 3 + 1] = k.g; col[(o + v) * 3 + 2] = k.b;
    }
    o += g.attributes.position.count;
  });
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

// Flat plaza, a light X, and a curved walk. y sits just above the ground at the doors.
function groundDressing(ground) {
  const { at, N, U } = ENTRANCE;
  const P = [], C = [];
  const corner = (nu, uu) => {
    const p = add(at, N, nu, U, uu);
    return [p[0], ground(p[0], p[1]) + 0.14, p[1]];
  };
  const slab = (n0, n1, u0, u1, col) => quad(P, C, corner(n0, u0), corner(n1, u0), corner(n1, u1), corner(n0, u1), col);
  slab(4.4, 16, -8, 8, BRICK);
  slab(6.2, 14.2, -1.1, 1.1, CREAM);
  slab(8.5, 11.5, -6.2, 6.2, CREAM);
  // curved walk leaving the east side of the plaza
  let prev = add(at, N, 12, U, 8);
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    const next = add(at, N, 12 - t * 4, U, 8 + t * 16);
    const side = (p, s) => {
      const dx = next[0] - prev[0], dz = next[1] - prev[1], L = Math.hypot(dx, dz) || 1;
      return [p[0] + (-dz / L) * s, ground(p[0], p[1]) + 0.14, p[1] + (dx / L) * s];
    };
    quad(P, C, side(prev, -0.9), side(next, -0.9), side(next, 0.9), side(prev, 0.9), WALK);
    prev = next;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'entrance-plaza'; mesh.renderOrder = 2; mesh.receiveShadow = true;
  return mesh;
}

function nameSign(ground) {
  const mat = signMaterial(); if (!mat) return null;
  const { at, N, U } = ENTRANCE;
  const y = ground(at[0], at[1]) + 3.85;
  const p = add(at, N, 1.2);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.05), mat);
  mesh.position.set(p[0], y, p[1]);
  const face = new THREE.Vector3(N[0], 0, N[1]);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), face);
  mesh.name = 'entrance-sign'; mesh.renderOrder = 3;
  return mesh;
}

function lamps(ground) {
  const { at, N, U } = ENTRANCE;
  const geo = lampGeometry();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const spots = [add(at, N, 5.2, U, -4.2), add(at, N, 5.2, U, 4.2)];
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  mesh.name = 'entrance-lamps'; mesh.castShadow = false; mesh.frustumCulled = false;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
  spots.forEach((p, i) => {
    m4.compose(new THREE.Vector3(p[0], ground(p[0], p[1]), p[1]), q, new THREE.Vector3(1, 1, 1));
    mesh.setMatrixAt(i, m4);
  });
  return mesh;
}

export function addEntranceDressing(group, ground) {
  group.add(groundDressing(ground));
  const sign = nameSign(ground); if (sign) group.add(sign);
  group.add(lamps(ground));
}
