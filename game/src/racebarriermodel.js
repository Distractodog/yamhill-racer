import * as THREE from 'three';
import { BARRIER_HEIGHT, BARRIER_WIDTH } from './racebarriers.js';

// One vertex-coloured mesh for the active race, filled as the road tiles stream in. No per-segment draw calls.
export function buildRaceBarrierModel(layer) {
  const size = layer.segments.length * 60 * 3;
  const positions = new Float32Array(size), colours = new Float32Array(size), normals = new Float32Array(size);
  let used = 0;
  const red = new THREE.Color(0xc9342d), white = new THREE.Color(0xe8e5dc), rail = new THREE.Color(0x72777b);
  const pending = new Set(layer.segments);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setDrawRange(0, 0);
  const bounds = new THREE.Box3(), vertex = new THREE.Vector3(), aV = new THREE.Vector3(), bV = new THREE.Vector3();
  const normal = new THREE.Vector3(), edge = new THREE.Vector3();
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'race-barriers'; mesh.receiveShadow = true;
  function box(s, bottom, top, width, colour) {
    const nx = s.nx * width / 2, nz = s.nz * width / 2;
    const corners = [[s.ax-nx,s.ay+bottom,s.az-nz], [s.ax+nx,s.ay+bottom,s.az+nz],
      [s.bx+nx,s.by+bottom,s.bz+nz], [s.bx-nx,s.by+bottom,s.bz-nz],
      [s.ax-nx,s.ay+top,s.az-nz], [s.ax+nx,s.ay+top,s.az+nz],
      [s.bx+nx,s.by+top,s.bz+nz], [s.bx-nx,s.by+top,s.bz-nz]];
    for (const [a,b,c,d] of [[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7],[4,5,6,7]]) {
      aV.fromArray(corners[a]); bV.fromArray(corners[b]);
      normal.fromArray(corners[c]).sub(aV).cross(edge.subVectors(bV, aV)).normalize();
      for (const i of [a,c,b,a,d,c]) {
        positions.set(corners[i], used); normal.toArray(normals, used);
        colour.toArray(colours, used); used += 3;
        bounds.expandByPoint(vertex.fromArray(corners[i]));
      }
    }
  }
  function update() {
    const start = used;
    for (const s of pending) if (layer.prepare(s)) {
      // Alternate every centre-line sample (~4 m); a narrow dark cap reads as a top rail.
      box(s, -0.08, BARRIER_HEIGHT - 0.06, BARRIER_WIDTH, s.index % 2 ? red : white);
      box(s, BARRIER_HEIGHT - 0.06, BARRIER_HEIGHT, BARRIER_WIDTH + 0.02, rail);
      pending.delete(s);
    }
    if (used !== start) {
      for (const attribute of Object.values(geometry.attributes)) {
        attribute.addUpdateRange(start, used - start); attribute.needsUpdate = true;
      }
      geometry.setDrawRange(0, used / 3);
      geometry.boundingSphere = bounds.getBoundingSphere(geometry.boundingSphere || new THREE.Sphere());
    }
  }
  update();
  const near = (s, points, radius) => (!layer.canLoad || layer.canLoad(s)) &&
    points.some(([x, z]) => Math.hypot((s.ax + s.bx) / 2 - x, (s.az + s.bz) / 2 - z) < radius);
  return { mesh, update,
    loadPoints(points, radius = 150) {
      return layer.segments.filter(s => near(s, points, radius)).flatMap(s => [[s.ax, s.az], [s.bx, s.bz]]);
    },
    readyNear(points, radius = 150) {
      return ![...pending].some(s => near(s, points, radius));
    },
    dispose() { geometry.dispose(); material.dispose(); } };
}
