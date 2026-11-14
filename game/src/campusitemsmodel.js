// Instanced campus props. One mesh per type per tile. Only instances within 250 m
// are copied into the mesh, and only after the camera has moved.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { placeCampusItems } from './campusitems.js';

const R2 = 250 * 250;
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
const pole = (r0, r1, h, hex) => { const g = new THREE.CylinderGeometry(r0, r1, h, 6); g.translate(0, h / 2, 0); return paint(g, hex); };
const box = (w, h, d, x, y, z, hex) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return paint(g, hex); };

export function campusItemGeometries() {
  const discHead = new THREE.CylinderGeometry(0.55, 0.55, 0.06, 8); discHead.translate(0, 3.25, 0);
  const discNeck = new THREE.CylinderGeometry(0.08, 0.12, 0.16, 6); discNeck.translate(0, 3.12, 0);
  const disc = mergeGeometries([pole(0.06, 0.08, 3.2, 0xb7bcc2), paint(discHead, 0xd5d8dc), paint(discNeck, 0xf0d48a)]);
  const globe = new THREE.SphereGeometry(0.28, 8, 6); globe.translate(0, 2.55, 0);
  const globeMesh = mergeGeometries([pole(0.045, 0.06, 2.4, 0x2a2c30), paint(globe, 0xf4f1ea)]);
  const lantern = new THREE.BoxGeometry(0.32, 0.42, 0.32); lantern.translate(0, 3.5, 0);
  const lanternMesh = mergeGeometries([pole(0.04, 0.05, 3.3, 0xf2f0ea), paint(lantern, 0xf6e7b0)]);
  const bench = mergeGeometries([
    box(1.5, 0.08, 0.42, 0, 0.48, 0, 0x4a4e52),
    box(1.5, 0.32, 0.06, 0, 0.72, -0.16, 0x4a4e52),
    box(0.08, 0.48, 0.4, -0.65, 0.24, 0, 0x3a3c40),
    box(0.08, 0.48, 0.4, 0.65, 0.24, 0, 0x3a3c40),
  ]);
  const sign = mergeGeometries([pole(0.04, 0.05, 1.7, 0x3a3c40), box(0.9, 0.45, 0.06, 0, 1.85, 0, 0xffffff)]);
  const fence = mergeGeometries([
    box(0.08, 0.9, 0.08, -1.0, 0.45, 0, 0x6d5128),
    box(0.08, 0.9, 0.08, 1.0, 0.45, 0, 0x6d5128),
    box(2.1, 0.07, 0.05, 0, 0.72, 0, 0x8a6840),
    box(2.1, 0.07, 0.05, 0, 0.38, 0, 0x8a6840),
  ]);
  const hedge = box(2.2, 0.85, 0.7, 0, 0.42, 0, 0x2f6a34);
  const canopy = new THREE.SphereGeometry(0.85, 7, 5); canopy.translate(0, 2.15, 0);
  const tree = mergeGeometries([pole(0.08, 0.12, 1.3, 0x5a4030), paint(canopy, 0x3d7a3a)]);
  const bollard = box(0.18, 0.55, 0.18, 0, 0.28, 0, 0x2a2c30);
  return { disc, globe: globeMesh, lantern: lanternMesh, bench, sign, fence, hedge, tree, bollard };
}

function writeYaw(buf, i, x, y, z, yaw) {
  q.setFromAxisAngle(up, yaw);
  m4.compose(pos.set(x, y, z), q, scl);
  m4.toArray(buf, i * 16);
}

const ORDER = ['disc', 'globe', 'lantern', 'bench', 'sign', 'fence', 'hedge', 'tree', 'bollard'];
const KEY = { disc: 'discs', globe: 'globes', lantern: 'lanterns', bench: 'benches', sign: 'signs', fence: 'fences', hedge: 'hedges', tree: 'trees', bollard: 'bollards' };

export function* addCampusItems(group, lods, td, geos, mat) {
  const placed = placeCampusItems({ paths: td.sourcePaths, buildings: td.buildings });
  const yAt = (x, z) => td.terrainAt(x, z);
  const types = [];
  for (const name of ORDER) {
    const items = placed[KEY[name]];
    if (!items.length) continue;
    const src = new Float32Array(items.length * 16), xz = new Float32Array(items.length * 2);
    const col = name === 'sign' ? new Float32Array(items.length * 3) : null;
    items.forEach((it, i) => {
      xz[i * 2] = it.x; xz[i * 2 + 1] = it.z;
      writeYaw(src, i, it.x, yAt(it.x, it.z), it.z, it.yaw || 0);
      if (col) { col[i * 3] = it.color[0]; col[i * 3 + 1] = it.color[1]; col[i * 3 + 2] = it.color[2]; }
    });
    const mesh = new THREE.InstancedMesh(geos[name], mat, items.length);
    mesh.name = 'campus:' + name; mesh.count = 0; mesh.visible = false;
    mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
    if (col) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(items.length * 3), 3);
    group.add(mesh);
    types.push({ mesh, src, xz, n: items.length, col });
  }
  if (types.length) lods.push({ x: Infinity, z: Infinity, types });
  yield 'campus-items';
}

export function showCampusItems(lods, cam) {
  for (const tile of lods) {
    const dx = tile.x - cam.x, dz = tile.z - cam.z;
    if (dx * dx + dz * dz < MOVE2) continue;
    tile.x = cam.x; tile.z = cam.z;
    for (const t of tile.types) {
      let n = 0;
      const dst = t.mesh.instanceMatrix.array;
      const cd = t.col ? t.mesh.instanceColor.array : null;
      for (let i = 0; i < t.n; i++) {
        const ox = t.xz[i * 2] - cam.x, oz = t.xz[i * 2 + 1] - cam.z;
        if (ox * ox + oz * oz > R2) continue;
        dst.set(t.src.subarray(i * 16, i * 16 + 16), n * 16);
        if (cd) cd.set(t.col.subarray(i * 3, i * 3 + 3), n * 3);
        n++;
      }
      t.mesh.count = n; t.mesh.visible = n > 0; t.mesh.instanceMatrix.needsUpdate = true;
      if (cd) t.mesh.instanceColor.needsUpdate = true;
    }
  }
}
