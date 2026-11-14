// Painted marks on the ground: the running track, a small east-lawn court, and the
// west-wing stalls. Flat quads with polygon offset, not a new surface, so class 7
// still drives and the drive numbers stay put. No kerbs.
import * as THREE from 'three';
import { ENTRANCE } from './campus.js';
import { terrainPaintQuad } from './terrainpaint.js';

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

// The class-7 oval: centre and outer half-axes measured from the surface grid.
const CX = -555.8, CZ = 48, AX = 39, AZ = 87;

export function addCampusPaint(group, ground) {
  const P = [], C = [];
  const y = (x, z, lift = 0.1) => [x, ground(x, z) + lift, z];
  const trackQuad = (a, b, c, d, col, lift = 0.16) => {
    const k = lin(col);
    terrainPaintQuad(a, b, c, d, ground, lift, (p, q, r) => {
      P.push(...p, ...q, ...r); C.push(...k, ...k, ...k);
    });
  };
  const ring = (a0, b0, a1, b1, col, lift) => {
    const n = 72;
    for (let i = 0; i < n; i++) {
      const t0 = i / n * Math.PI * 2, t1 = (i + 1) / n * Math.PI * 2;
      const p = (a, b, t) => y(CX + Math.cos(t) * a, CZ + Math.sin(t) * b, lift);
      trackQuad(p(a0, b0, t0), p(a1, b1, t0), p(a1, b1, t1), p(a0, b0, t1), col, lift);
    }
  };
  // red band over the class-7 ring (inner ellipse is 0.787 of the outer)
  ring(AX * 0.79, AZ * 0.79, AX, AZ, RED, 0.08);
  for (let k = 1; k <= 6; k++) {
    const t = 0.79 + 0.21 * k / 7;
    ring(AX * t, AZ * t, AX * t + 0.10, AZ * t + 0.10, WHITE, 0.16);
  }
  // start line across the west straight, inner edge to outer edge
  trackQuad(y(CX - AX, CZ - 0.05, 0.12), y(CX - AX * 0.79, CZ - 0.05, 0.12), y(CX - AX * 0.79, CZ + 0.05, 0.12), y(CX - AX, CZ + 0.05, 0.12), WHITE);
  // infield: halfway line, centre circle, two goals
  trackQuad(y(CX - 20, CZ - 0.04, 0.1), y(CX + 20, CZ - 0.04, 0.1), y(CX + 20, CZ + 0.04, 0.1), y(CX - 20, CZ + 0.04, 0.1), WHITE);
  const n = 24;
  for (let i = 0; i < n; i++) {
    const t0 = i / n * Math.PI * 2, t1 = (i + 1) / n * Math.PI * 2;
    const p = (r, t) => y(CX + Math.cos(t) * r, CZ + Math.sin(t) * r, 0.1);
    trackQuad(p(9, t0), p(9.08, t0), p(9.08, t1), p(9, t1), WHITE);
  }
  for (const s of [-1, 1]) {
    const z = CZ + s * 32;
    trackQuad(y(CX - 3.6, z - 0.04), y(CX + 3.6, z - 0.04), y(CX + 3.6, z + 0.04), y(CX - 3.6, z + 0.04), WHITE);
    trackQuad(y(CX - 3.6, z), y(CX - 3.52, z), y(CX - 3.52, z + s * 2), y(CX - 3.6, z + s * 2), WHITE);
    trackQuad(y(CX + 3.52, z), y(CX + 3.6, z), y(CX + 3.6, z + s * 2), y(CX + 3.52, z + s * 2), WHITE);
  }
  // field-event pad just west of the oval
  trackQuad(y(CX - AX - 16, CZ - 12, 0.08), y(CX - AX - 4, CZ - 12, 0.08), y(CX - AX - 4, CZ + 12, 0.08), y(CX - AX - 16, CZ + 12, 0.08), RED, 0.08);

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
