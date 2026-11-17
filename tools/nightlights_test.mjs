import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildingSeed, windowThreshold } from '../game/src/nightwindows.js';
import { nightAttribute, nightMaterial, nightUniform, addLampPools } from '../game/src/nightlights.js';
import { buildCampusGeometry } from '../game/src/campusmodel.js';
import { propGeometries } from '../game/src/propsmodel.js';
import { campusItemGeometries } from '../game/src/campusitemsmodel.js';
const points = [[0, 0], [30, 0], [30, 20], [0, 20]];
assert.equal(buildingSeed(points), buildingSeed([...points].reverse()));
const seeds = [];
for (let b = 0; b < 30; b++) {
  const seed = buildingSeed(points.map(([x, z]) => [x + b * 100, z]));
  const values = Array.from({ length: 2000 }, (_, i) => windowThreshold(seed, i * 2, 3, b));
  assert.deepEqual(values, values.map((_, i) => windowThreshold(seed, i * 2, 3, b)));
  const fraction = values.filter(v => v >= 0).length / values.length;
  assert(fraction >= .37 && fraction <= .73, `lit fraction ${fraction}`);
  const thresholds = values.filter(v => v >= 0);
  assert(thresholds.every(v => v >= .12 && v < .72));
  assert(thresholds.some(v => v < .25) && thresholds.some(v => v > .6), 'staggered dusk onset');
  seeds.push(values.join(','));
}
assert.equal(new Set(seeds).size, 30);
const building = { floor: 0, parts: [{ pts: points, h: 9, wall: [.5, .4, .3], win: { rows: 2, sh: 3, sill: 1, h: 1.5, w: 1, margin: 2, every: 3, color: [.2, .3, .4] } }] };
const g = buildCampusGeometry(building, () => 0), n = g.attributes.nightStart.array;
assert.equal(n.length, g.attributes.position.count);
assert(n.some(v => v >= 0) && n.some(v => v < 0));
assert.deepEqual(n, buildCampusGeometry(building, () => 0).attributes.nightStart.array);
// Non-window faces (walls) remain dark. Quad's six vertices share the same selection.
assert([...n.slice(0, 24)].every(v => v === -1));
for (let i = 0; i < n.length; i += 6) assert([...n.slice(i, i + 6)].every(v => v === n[i]));
for (const geos of [propGeometries(), campusItemGeometries()]) for (const [name, geo] of Object.entries(geos)) {
  assert.equal(geo.attributes.nightStart.count, geo.attributes.position.count, name);
  if (['light', 'disc', 'globe', 'lantern'].includes(name)) assert(geo.attributes.nightStart.array.some(v => v >= 0), name);
}
const mat = nightMaterial(new THREE.MeshLambertMaterial({ vertexColors: true }));
const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
mat.onBeforeCompile(shader);
assert.equal(shader.uniforms.townNight, nightUniform);
assert(shader.fragmentShader.includes('totalEmissiveRadiance += vec3'));
assert(shader.vertexShader.includes('vNightStart = nightStart;'));
const version = mat.version, key = mat.customProgramCacheKey();
for (let i = 0; i <= 100; i++) nightUniform.value = i / 100;
assert.equal(mat.version, version); assert.equal(mat.customProgramCacheKey(), key);
assert.equal(nightAttribute(new THREE.BoxGeometry()).attributes.nightStart.array[0], -1);
const group = new THREE.Group(), pool = addLampPools(group, [{ x: 0, z: 0 }], (x, z) => x * .1 + z * .2);
const pos = pool.geometry.attributes.position;
for (let i = 0; i < pos.count; i++) assert(Math.abs(pos.getY(i) - (pos.getX(i) * .1 + pos.getZ(i) * .2 + .055)) < 1e-6);
assert.equal(pool.material.depthWrite, false); assert(!group.children.some(m => m.isLight));
console.log('PASS seeded selection (30 buildings, 60000 panes), dusk onset, geometry, lamp heads, shared uniform/program and terrain pools');
