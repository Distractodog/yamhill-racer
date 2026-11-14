// Meshes for the running track (shape in campustrack.js): red lanes with white lane lines and a grey kerb, a mowed
// infield with soccer markings and two goals, and the red jumps runway. Two vertex-coloured meshes: the flat ground
// layer, and the painted lines + goals just above it.
import * as THREE from 'three';
import { TRACK, trackXZ } from './campustrack.js';

const RED = [0.66, 0.29, 0.23], RED2 = [0.62, 0.27, 0.22];
const WHITE = [0.94, 0.94, 0.91], KERB = [0.78, 0.78, 0.76];
const GRASS = [[0.36, 0.53, 0.22], [0.41, 0.58, 0.25]];

const _c = new THREE.Color();
const lin = col => { _c.setRGB(col[0], col[1], col[2], THREE.SRGBColorSpace); return [_c.r, _c.g, _c.b]; };

function builder() {
  const P = [], C = [];
  return {
    P, C,
    tri(a, b, c, col) { const k = lin(col); P.push(...a, ...b, ...c); for (let i = 0; i < 3; i++) C.push(...k); },
    quad(a, b, c, d, col) { this.tri(a, b, c, col); this.tri(a, c, d, col); },
  };
}
const MATS = {};
function mesh(b, name, offset) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.P, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.C, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, MATS[offset] ||= new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset }));   // shared: the track is one place
  m.name = name; m.receiveShadow = true; m.renderOrder = 2;
  return m;
}

// point on the oval at radius r (from the centre segment) and arc parameter s in [0, 4): 0-1 east straight going
// south, 1-2 south bend, 2-3 west straight going north, 3-4 north bend
function ovalPt(r, s, y) {
  const { S } = TRACK;
  let u, p;
  if (s < 1) { u = -S + 2 * S * s; p = r; }
  else if (s < 2) { const a = (s - 1) * Math.PI; u = S + Math.sin(a) * r; p = Math.cos(a) * r; }
  else if (s < 3) { u = S - 2 * S * (s - 2); p = -r; }
  else { const a = (s - 3) * Math.PI; u = -S - Math.sin(a) * r; p = -Math.cos(a) * r; }
  const [x, z] = trackXZ(u, p); return [x, y, z];
}
const bend = s => Array.from({ length: 33 }, (_, i) => s + i / 32);
const STEPS = [0, ...bend(1), ...bend(3)];                    // 0, 1 … 2 (south bend), 3 … 4 (north bend)

function ring(b, r0, r1, y, col) {
  for (let i = 0; i < STEPS.length - 1; i++) {
    const s0 = STEPS[i], s1 = STEPS[i + 1];
    b.quad(ovalPt(r0, s0, y), ovalPt(r0, s1, y), ovalPt(r1, s1, y), ovalPt(r1, s0, y), col);
  }
}

// flat rectangle in track coordinates (u0..u1 along, p0..p1 across)
function rectUP(b, u0, u1, p0, p1, y, col) {
  const q = (u, p) => { const [x, z] = trackXZ(u, p); return [x, y, z]; };
  b.quad(q(u0, p0), q(u0, p1), q(u1, p1), q(u1, p0), col);
}
// painted arc of radius r around (uc, pc), angles a0..a1 (0 = +u), line width w
function arcUP(b, uc, pc, r, a0, a1, w, y, col, n = 24) {
  const q = (rr, a) => { const [x, z] = trackXZ(uc + Math.cos(a) * rr, pc + Math.sin(a) * rr); return [x, y, z]; };
  for (let i = 0; i < n; i++) {
    const t0 = a0 + (a1 - a0) * i / n, t1 = a0 + (a1 - a0) * (i + 1) / n;
    b.quad(q(r - w / 2, t0), q(r - w / 2, t1), q(r + w / 2, t1), q(r + w / 2, t0), col);
  }
}
// box (bar) from track-frame point A to B (each [u, p, y]) with square section t
function bar(b, A, B, t, col) {
  const pa = trackXZ(A[0], A[1]), pb = trackXZ(B[0], B[1]);
  const a = new THREE.Vector3(pa[0], A[2], pa[1]), e = new THREE.Vector3(pb[0], B[2], pb[1]);
  const d = e.clone().sub(a).normalize();
  const s1 = Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const n1 = new THREE.Vector3().crossVectors(d, s1).normalize().multiplyScalar(t / 2);
  const n2 = new THREE.Vector3().crossVectors(d, n1).normalize().multiplyScalar(t / 2);
  const c = (o, i, j) => o.clone().addScaledVector(n1, i).addScaledVector(n2, j).toArray();
  const k = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < 4; i++) {
    const [i0, j0] = k[i], [i1, j1] = k[(i + 1) % 4];
    b.quad(c(a, i0, j0), c(a, i1, j1), c(e, i1, j1), c(e, i0, j0), col);
  }
}

export function buildTrackMeshes(ground) {
  const { R, RO, S, lanes, lane, field } = TRACK, y = TRACK.level ?? ground(...TRACK.c);
  const base = builder(), top = builder();
  const y0 = y + 0.04, y1 = y + 0.06;

  // lanes + lines (one flat layer, no overlap): kerb, then per lane a white line and the red lane
  const LW = 0.08;
  ring(base, R - 0.25, R, y0, KERB);
  for (let i = 0; i < lanes; i++) {
    const r = R + i * lane;
    ring(base, r, r + LW, y0, WHITE);
    ring(base, r + LW, r + lane, y0, i % 2 ? RED : RED2);
  }
  ring(base, RO, RO + LW, y0, WHITE);
  ring(base, RO + LW, RO + 0.6, y0, RED);

  // infield: mowed stripes across the field, out to the kerb
  const Ri = R - 0.25, Umax = S + Ri, ST = 8, DU = 2;
  const half = u => { const e = Math.max(0, Math.abs(u) - S); return e >= Ri ? 0 : Math.sqrt(Ri * Ri - e * e); };
  for (let u = -Umax; u < Umax - 1e-6; u += DU) {
    const u1 = Math.min(Umax, u + DU), h0 = half(u), h1 = half(u1);
    const col = GRASS[((Math.floor((u + Umax) / ST)) % 2 + 2) % 2];
    const q = (uu, p) => { const [x, z] = trackXZ(uu, p); return [x, y0, z]; };
    base.quad(q(u, -h0), q(u, h0), q(u1, h1), q(u1, -h1), col);
  }

  // jumps runway + pad, draped on the ground in 2 m cells
  for (const quad of TRACK.runway) {
    const [A, B, Cc, D] = quad, n = 12;
    const at = (s, t) => {
      const x = (A[0] * (1 - s) + B[0] * s) * (1 - t) + (D[0] * (1 - s) + Cc[0] * s) * t;
      const z = (A[1] * (1 - s) + B[1] * s) * (1 - t) + (D[1] * (1 - s) + Cc[1] * s) * t;
      return [x, ground(x, z) + 0.06, z];
    };
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
      base.quad(at(i / n, j / n), at(i / n, (j + 1) / n), at((i + 1) / n, (j + 1) / n), at((i + 1) / n, j / n), RED);
  }

  // soccer pitch markings (FIFA proportions on a 96 x 60 m pitch)
  const L = field.L / 2, W = field.W / 2, w = 0.12, Y = y1;
  rectUP(top, -L, L, -W - w / 2, -W + w / 2, Y, WHITE);           // touchlines
  rectUP(top, -L, L, W - w / 2, W + w / 2, Y, WHITE);
  for (const sg of [-1, 1]) {
    const g = sg * L;
    rectUP(top, g - w / 2, g + w / 2, -W, W, Y, WHITE);             // goal line
    const pa = g - sg * 16.5, ga = g - sg * 5.5;
    rectUP(top, Math.min(g, pa), Math.max(g, pa), -20.16 - w / 2, -20.16 + w / 2, Y, WHITE);   // penalty area
    rectUP(top, Math.min(g, pa), Math.max(g, pa), 20.16 - w / 2, 20.16 + w / 2, Y, WHITE);
    rectUP(top, pa - w / 2, pa + w / 2, -20.16, 20.16, Y, WHITE);
    rectUP(top, Math.min(g, ga), Math.max(g, ga), -9.16 - w / 2, -9.16 + w / 2, Y, WHITE);     // goal area
    rectUP(top, Math.min(g, ga), Math.max(g, ga), 9.16 - w / 2, 9.16 + w / 2, Y, WHITE);
    rectUP(top, ga - w / 2, ga + w / 2, -9.16, 9.16, Y, WHITE);
    const ps = g - sg * 11;
    rectUP(top, ps - 0.15, ps + 0.15, -0.15, 0.15, Y, WHITE);         // penalty spot
    const a = Math.acos(5.5 / 9.15), base0 = sg > 0 ? Math.PI : 0;     // arc outside the area
    arcUP(top, ps, 0, 9.15, base0 - a, base0 + a, w, Y, WHITE, 12);
    for (const sp of [-1, 1])                                          // corner arcs
      arcUP(top, g, sp * W, 1, sg > 0 ? (sp > 0 ? Math.PI : Math.PI / 2) : (sp > 0 ? -Math.PI / 2 : 0),
        sg > 0 ? (sp > 0 ? 1.5 * Math.PI : Math.PI) : (sp > 0 ? 0 : Math.PI / 2), w, Y, WHITE, 6);
    // goal: posts, crossbar, and a frame back to the ground 2 m behind
    const gy = y, t = 0.12, back = g + sg * 2;
    for (const sp of [-3.66, 3.66]) {
      bar(top, [g, sp, gy], [g, sp, gy + 2.44], t, WHITE);
      bar(top, [g, sp, gy + 2.44], [back, sp, gy + 0.05], 0.06, KERB);
      bar(top, [back, sp, gy + 0.05], [g, sp, gy + 0.05], 0.06, KERB);
    }
    bar(top, [g, -3.66 - t / 2, gy + 2.44], [g, 3.66 + t / 2, gy + 2.44], t, WHITE);
    bar(top, [back, -3.66, gy + 0.05], [back, 3.66, gy + 0.05], 0.06, KERB);
  }
  rectUP(top, -w / 2, w / 2, -W, W, Y, WHITE);                         // halfway line
  arcUP(top, 0, 0, 9.15, 0, Math.PI * 2, w, Y, WHITE, 40);             // centre circle
  rectUP(top, -0.15, 0.15, -0.15, 0.15, Y, WHITE);
  // finish line across the lanes at the north end of the east straight
  rectUP(top, -S + 0.5, -S + 0.8, R, RO, Y, WHITE);

  return [mesh(base, 'track', -2), mesh(top, 'track-lines', -4)];
}
