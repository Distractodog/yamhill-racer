// Instanced street props for one tile. One mesh per type. Only the ones within PROP_R
// of the camera are copied into the mesh, and that copy waits until the camera has
// moved, so a parked bench does not rebuild them every frame.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { placeProps } from './props.js';

export const PROP_R = 250;
const R2 = PROP_R * PROP_R;
const MOVE2 = 30 * 30;

const up = new THREE.Vector3(0, 1, 0);
const q = new THREE.Quaternion();
const pos = new THREE.Vector3();
const scl = new THREE.Vector3(1, 1, 1);
const m4 = new THREE.Matrix4();

function paint(g, hex) {
  g = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(hex), a = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g;
}
const box = (w, h, d, y, z, hex) => {
  const g = new THREE.BoxGeometry(w, h, d); g.translate(0, y, z); return paint(g, hex);
};
const pole = (r0, r1, h, hex) => {
  const g = new THREE.CylinderGeometry(r0, r1, h, 6); g.translate(0, h / 2, 0); return paint(g, hex);
};

export function propGeometries() {
  const light = mergeGeometries([
    pole(0.05, 0.07, 7.4, 0x3c3f46),
    box(0.08, 0.08, 1.25, 7.25, 0.62, 0x3c3f46),
    box(0.52, 0.1, 0.28, 7.12, 1.22, 0xf2d48a),
  ]);
  const power = mergeGeometries([
    pole(0.09, 0.13, 10.2, 0x6b4a32),
    box(2.3, 0.1, 0.1, 9.25, 0, 0x5a4030),
  ]);
  const bits = [];
  for (let i = 0; i < 4; i++) {
    const t0 = i / 4, t1 = (i + 1) / 4, sag = t => Math.sin(Math.PI * t) * 0.5;
    const g = new THREE.BoxGeometry((t1 - t0), 0.025, 0.025);
    g.translate((t0 + t1) / 2, -(sag(t0) + sag(t1)) / 2, 0);
    bits.push(paint(g, 0x241f1c));
  }
  const line = mergeGeometries(bits);
  const sign = new THREE.CylinderGeometry(0.4, 0.4, 0.05, 8); sign.rotateX(Math.PI / 2); sign.translate(0, 2.45, 0);
  const stripe = new THREE.BoxGeometry(0.46, 0.1, 0.02); stripe.translate(0, 2.45, 0.04);
  const stop = mergeGeometries([pole(0.035, 0.045, 2.45, 0x2e3136), paint(sign, 0xc0392b), paint(stripe, 0xf4f4f0)]);
  const mail = mergeGeometries([
    pole(0.035, 0.04, 1.05, 0x4a4e52),
    box(0.56, 0.32, 0.28, 1.16, 0, 0x2c4a7a),
    box(0.4, 0.2, 0.03, 1.16, 0.15, 0xd5d7da),
  ]);
  const postL = new THREE.BoxGeometry(0.08, 0.95, 0.08); postL.translate(-1.05, 0.48, 0);
  const postR = new THREE.BoxGeometry(0.08, 0.95, 0.08); postR.translate(1.05, 0.48, 0);
  const railHi = new THREE.BoxGeometry(2.18, 0.07, 0.05); railHi.translate(0, 0.72, 0);
  const railLo = new THREE.BoxGeometry(2.18, 0.07, 0.05); railLo.translate(0, 0.38, 0);
  const fence = mergeGeometries([paint(postL, 0x6d5128), paint(postR, 0x6d5128), paint(railHi, 0x8a6840), paint(railLo, 0x8a6840)]);
  return { light, pole: power, line, stop, mail, fence };
}

function writeYaw(buf, i, x, y, z, yaw) {
  q.setFromAxisAngle(up, yaw);
  m4.compose(pos.set(x, y, z), q, scl.set(1, 1, 1));
  m4.toArray(buf, i * 16);
}

function writeLine(buf, i, x, y, z, x2, y2, z2) {
  const dx = x2 - x, dy = y2 - y, dz = z2 - z, len = Math.hypot(dx, dy, dz) || 1;
  const xx = dx / len, xy = dy / len, xz = dz / len;
  let zx = xy * 0 - xz * 1, zy = xz * 0 - xx * 0, zz = xx * 1 - xy * 0;
  const zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  m4.set(xx * len, yx, zx, x, xy * len, yy, zy, y, xz * len, yz, zz, z, 0, 0, 0, 1);
  m4.toArray(buf, i * 16);
}

function pack(group, mat, geo, name, items, yAt) {
  if (!items.length) return null;
  const src = new Float32Array(items.length * 16), xz = new Float32Array(items.length * 2);
  items.forEach((it, i) => {
    xz[i * 2] = it.x2 !== undefined ? (it.x + it.x2) / 2 : it.x;
    xz[i * 2 + 1] = it.x2 !== undefined ? (it.z + it.z2) / 2 : it.z;
    if (it.x2 !== undefined) writeLine(src, i, it.x, yAt(it.x, it.z) + 9.2, it.z, it.x2, yAt(it.x2, it.z2) + 9.2, it.z2);
    else writeYaw(src, i, it.x, yAt(it.x, it.z), it.z, it.yaw);
  });
  const mesh = new THREE.InstancedMesh(geo, mat, items.length);
  mesh.name = 'prop:' + name; mesh.count = 0; mesh.visible = false;
  mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
  group.add(mesh);
  return { mesh, src, xz, n: items.length };
}

// Builds the meshes and yields once. `lods` receives one record per tile that has props.
export function* addProps(group, lods, td, geos, mat) {
  const placed = placeProps({ paths: td.sourcePaths, junctions: td.sourceJunctions, buildings: td.buildings });
  const yAt = (x, z) => td.terrainAt(x, z);
  const types = [];
  for (const name of ['light', 'pole', 'line', 'stop', 'mail', 'fence']) {
    const key = name === 'mail' ? 'mailboxes' : name === 'light' ? 'lights' : name === 'pole' ? 'poles' : name === 'line' ? 'lines' : name === 'stop' ? 'stops' : 'fences';
    const rec = pack(group, mat, geos[name], name, placed[key], yAt);
    if (rec) types.push(rec);
  }
  if (types.length) lods.push({ x: Infinity, z: Infinity, types });
  yield 'props';
}

// Copies nearby instances into the live meshes. No work when the camera has stayed put.
export function showProps(lods, cam) {
  for (const tile of lods) {
    const dx = tile.x - cam.x, dz = tile.z - cam.z;
    if (dx * dx + dz * dz < MOVE2) continue;
    tile.x = cam.x; tile.z = cam.z;
    for (const t of tile.types) {
      let n = 0;
      const dst = t.mesh.instanceMatrix.array;
      for (let i = 0; i < t.n; i++) {
        const ox = t.xz[i * 2] - cam.x, oz = t.xz[i * 2 + 1] - cam.z;
        if (ox * ox + oz * oz > R2) continue;
        dst.set(t.src.subarray(i * 16, i * 16 + 16), n * 16);
        n++;
      }
      t.mesh.count = n; t.mesh.visible = n > 0; t.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
