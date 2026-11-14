import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRimRing, ringFade } from '../game/src/rimring.js';
const scene = new THREE.Scene();
assert.equal(createRimRing({ scene }), null); assert.equal(scene.children.length, 0);
for (const rim of [{ cx: 0, cz: 0, r: 0 }, { cx: NaN, cz: 0, r: 10 }, { cx: 0, cz: Infinity, r: 10 }, { cx: 0, cz: 0, r: -5 }]) assert.throws(() => createRimRing({ scene, rim }), RangeError);
const rim = { cx: 9000, cz: -5000, r: 17200 }, ring = createRimRing({ scene, rim }), mesh = ring.mesh;
assert.equal(scene.children.length, 1); assert.equal(mesh.name, 'map-rim-ring'); assert.equal(mesh.children.length, 0);
assert.equal(mesh.geometry.index.count / 3, 2048); assert.equal(mesh.geometry.groups.length, 1);
assert.equal(mesh.material.blending, THREE.AdditiveBlending); assert.equal(mesh.material.depthWrite, false);
assert.equal(mesh.material.fog, false); assert.equal(mesh.material.transparent, true); assert.equal(mesh.material.forceSinglePass, true);
assert.equal(mesh.castShadow, false); assert.equal(mesh.receiveShadow, false);
const p = new THREE.Vector3(rim.cx + rim.r - 300, 200, rim.cz), uniformVector = mesh.material.uniforms.uPlayer.value;
ring.update(p); assert.equal(mesh.visible, false); assert.equal(mesh.material.opacity, 0);
p.x += 150; ring.update(p); assert.equal(mesh.visible, false);
p.x += 50; ring.update(p); assert.equal(mesh.visible, true); const faint = mesh.material.opacity; assert.ok(faint > 0 && faint < .16);
p.x += 100; ring.update(p); assert.equal(mesh.visible, true); assert.equal(mesh.material.opacity, .16); assert.equal(mesh.position.y, 280);
assert.equal(mesh.material.uniforms.uPlayer.value, uniformVector); assert.ok(uniformVector.equals(p));
p.y = 4000; ring.update(p); assert.equal(mesh.position.y, 4080);
p.x += 151; ring.update(p); assert.equal(mesh.visible, false);
assert.equal(ringFade(300), 0); assert.equal(ringFade(150), 0); assert.equal(ringFade(0), 1);
assert.ok(ringFade(100) < ringFade(50)); assert.equal(ringFade(-100), ringFade(100));
// Local draw range covers every potentially visible sector, including seam wraps,
// while snapped rotation leaves the original world-space tessellation unchanged.
for (const radius of [100, 299, 301, 350, 600, 17200]) {
  const test = createRimRing({ rim: { cx: 0, cz: 0, r: radius } }), geometry = test.mesh.geometry;
  const n = geometry.parameters.radialSegments, step = 2 * Math.PI / n;
  const first = geometry.drawRange.start / 6, count = geometry.drawRange.count / 6;
  for (const angle of [-Math.PI - 1e-8, -Math.PI, -Math.PI + 1e-8, -.0000001, 0, .0000001, Math.PI - 1e-8, Math.PI, Math.PI + 1e-8, .719]) {
    for (const offset of [-149, 0, 149]) {
      const radial = Math.max(0, radius + offset), position = new THREE.Vector3(Math.sin(angle) * radial, 30, Math.cos(angle) * radial);
      test.update(position); if (!test.mesh.visible) continue;
      const shift = Math.round(test.mesh.rotation.y / step);
      assert(Math.abs(test.mesh.rotation.y / step - shift) < 1e-10, 'rotation must preserve original sector grid');
      const drawn = new Set(Array.from({ length: count }, (_, i) => ((first + i + shift) % n + n) % n));
      for (let sector = 0; sector < n; sector++) {
        const a = sector * step, b = (sector + 1) * step;
        const ax = Math.sin(a) * radius, az = Math.cos(a) * radius;
        const dx = Math.sin(b) * radius - ax, dz = Math.cos(b) * radius - az;
        const u = Math.max(0, Math.min(1, ((position.x - ax) * dx + (position.z - az) * dz) / (dx * dx + dz * dz)));
        const distance = Math.hypot(ax + dx * u - position.x, az + dz * u - position.z);
        if (distance < 300 - 1e-7) assert(drawn.has(sector), `missing visible sector r=${radius} angle=${angle} sector=${sector}`);
      }
    }
  }
  if (radius === 17200) assert(geometry.drawRange.count / 3 <= 20, 'production arc should submit at most 20 triangles');
  test.dispose();
}
let geometryDisposals = 0, materialDisposals = 0;
mesh.geometry.addEventListener('dispose', () => geometryDisposals++); mesh.material.addEventListener('dispose', () => materialDisposals++);
ring.dispose(); ring.dispose(); ring.update(p); assert.equal(scene.children.length, 0); assert.equal(geometryDisposals, 1); assert.equal(materialDisposals, 1);
console.log('PASS: absent manifest disabled, invalid config rejected, one single-pass additive mesh, local-arc coverage/grid alignment across seams, distance fade, aircraft height, reusable uniforms, idempotent disposal.');
