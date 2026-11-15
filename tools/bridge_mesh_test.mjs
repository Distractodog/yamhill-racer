// Geometry probes without a renderer. Supply one or more read-only BR-2 scratch asset roots.
// node tools/bridge_mesh_test.mjs <assets-a> <assets-b>
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import { readTileData } from '../game/src/tilepack.js';
import { makeTileData } from '../game/src/data.js';
import { buildBridgeSteps, showBridges } from '../game/src/bridges.js';
import { buildRoads } from '../game/src/roads.js';

const roots = process.argv.slice(2);
assert(roots.length, 'supply BR-2 scratch asset roots');
const W = JSON.parse(await fs.readFile(new URL('../game/assets/world.json', import.meta.url)));
const material = new THREE.MeshLambertMaterial({ vertexColors: true });
let trusses = 0, bridges = 0, piers = 0;
for (const root of roots) for (const id of await fs.readdir(path.join(root, 'tiles'))) {
  const [tx, tz] = id.split('_').map(Number);
  const data = await readTileData(async name => {
    const b = await fs.readFile(path.join(root, 'tiles', id, name));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }, 3);
  const td = makeTileData(W, tx, tz, data), physics = td.roads.map(r => r.bridge);
  const iter = buildBridgeSteps(td, material); let result;
  while (!(result = iter.next()).done);
  const b = result.value; if (!b) continue;
  assert.deepEqual(td.roads.map(r => r.bridge), physics, 'visual tagging cannot change physics');
  const near = b.near.geometry, far = b.far.geometry;
  for (const g of [near, far]) {
    for (const name of ['position', 'normal', 'color']) assert(Array.from(g.attributes[name].array).every(Number.isFinite), `${id}: finite ${name}`);
    assert(g.boundingSphere.radius > 0);
    // Every solid consists of twelve outward-facing triangles, including the
    // sloping deck boxes. Signed volume catches accidentally inverted faces.
    const pos = g.attributes.position;
    for (let start = 0; start < pos.count; start += 36) {
      const origin = new THREE.Vector3().fromBufferAttribute(pos, start); let volume = 0;
      for (let i = start; i < start + 36; i += 3) {
        const a = new THREE.Vector3().fromBufferAttribute(pos, i).sub(origin);
        const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1).sub(origin);
        const c = new THREE.Vector3().fromBufferAttribute(pos, i + 2).sub(origin);
        volume += a.dot(b.cross(c)) / 6;
      }
      assert(volume > 0, `${id}: solid faces point outward`);
    }
  }
  assert(far.attributes.position.count < near.attributes.position.count, 'far level is cheaper');
  for (const p of b.report.piers) {
    assert(p.bottom[1] <= td.terrainAt(p.bottom[0], p.bottom[2]) - .39, 'pier reaches bed');
    assert(p.top[1] > p.ground); piers++;
  }
  for (const p of b.report.overhead) assert(p.clearance >= 6, `overhead clearance ${p.clearance}`);
  trusses += td.renderRoads.filter(r => r.bridge === 'truss').length;
  bridges += td.renderRoads.filter(r => r.bridge).length;
  showBridges(b, { x: b.bounds[0].x, z: b.bounds[0].z }); assert(b.near.visible && !b.far.visible);
  showBridges(b, { x: 1e8, z: 1e8 }); assert(!b.near.visible && b.far.visible);
  // Exercise columns() for both tagged and untagged strips, including the legacy layout.
  const road = buildRoads(td, material, td.renderRoads.map(r => ({ r, a: 0, b: r.n - 1 }))); assert(road.geometry.attributes.position.count > 0); road.geometry.dispose();
  const legacy = { ...td.renderRoads[0], osm: undefined, bridge: false };
  const old = buildRoads(td, material, [{ r: legacy, a: 0, b: legacy.n - 1 }]); assert(Array.from(old.geometry.attributes.position.array).every(Number.isFinite)); old.geometry.dispose();
  console.log(JSON.stringify({ tile: id, bridges: b.bounds.length, nearTriangles: near.attributes.position.count / 3, farTriangles: far.attributes.position.count / 3,
    piers: b.report.piers.length, minOverhead: b.report.overhead.length ? Math.min(...b.report.overhead.map(p => p.clearance)) : null }));
  near.dispose(); far.dispose();
}
assert(bridges && trusses && piers, 'scratch fixtures cover bridges, truss and foundations');
// Committed old tiles with no bridge flags must produce no meshes.
assert.equal(buildBridgeSteps({ sourcePaths: [], renderRoads: [] }, material).next().value, null);
material.dispose();
console.log(`PASS: ${bridges} bridges, ${trusses} truss, ${piers} foundations`);
