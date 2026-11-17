// Build one real tile through world.js to check the combined feature hooks. No browser or GPU.
// Run through the heavy gate: node --max-old-space-size=1024 tools/world_features_test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { loadWorld } from '../game/src/world.js';
import { GRAPHICS } from '../game/src/graphics.js';
import { nightUniform } from '../game/src/nightlights.js';
import { createPlacedLayer } from '../game/src/builder/placed.js';

const root = new URL('../', import.meta.url);
globalThis.document = {
  createElement: () => ({ getContext: () => ({
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {}, fillRect() {}, fillText() {},
  }) }),
};
globalThis.createImageBitmap = async () => ({ width: 1024, height: 1024, close() {} });
globalThis.fetch = async path => {
  const data = await fs.readFile(new URL('game/' + path, root));
  if (path === 'assets/world.json') {
    const manifest = JSON.parse(data); manifest.tiles = [[0, 0]];
    return Response.json(manifest);
  }
  return new Response(data);
};
let uploads = 0, compiles = 0;
const renderer = { initTexture() { uploads++; }, async compileAsync() { compiles++; } };
const world = await loadWorld(renderer);
assert.equal(world.loadedTiles(), 1, 'the campus tile finishes building, including its water mesh');
assert.equal(uploads, 4);
let seamMeshes = 0;
world.group.traverse(o => { if (o.geometry?.getAttribute('edgeNormal')) seamMeshes++; });
assert.equal(seamMeshes, 64, 'all 16 terrain chunks have four seam-safe LOD levels');
await world.treeFX.warmup(renderer, new THREE.PerspectiveCamera(), new THREE.Scene());
assert.equal(compiles, 1); assert(world.treeFX.warmed);
const tile = [...world.tiles.values()][0];
const p = new THREE.Vector3(tile.trees[0], world.heightAt(tile.trees[0], tile.trees[1]) + 3, tile.trees[1]);
assert(world.breakTree('0_0:0', { dx: 1, dz: 0 })); assert(tile.brokenTrees.has(0));
assert.equal(world.treeFX.activeTops, 1, 'the built tile is attached to tree-break effects');
for (const level of ['low', 'medium', 'high']) {
  const d = GRAPHICS[level]; world.setDetail({ ...d, shadows: d.shadow > 0 });
  world.setNight(1); world.tick(1); world.updateLOD(p, null); world.updateShadows(p);
  assert.equal(nightUniform.value, 1); assert.equal(world.graphicsDetail().treeNear, d.treeNear);
  assert(tile.brokenTrees.has(0));
}
const layer = createPlacedLayer(), y = world.baseHeightAt(0, 0) + 20;
layer.set({ version: 1, pieces: [{ id: 'platform', type: 'platform', x: 0, y, z: 0, yaw: 0, scale: 1 }] });
world.setPlacedPieces(layer); assert(world.heightAt(0, 0) >= y);
world.setPlacedPieces(null); assert(world.heightAt(0, 0) < y);
console.log('PASS integrated world: real campus tile built; seam geometry, tree FX warmup/breaks, all graphics levels, night uniform and placed surfaces coexist (stub renderer; no GPU validation)');

// Race cancellation must return to resident ground even after the camera has crossed the map.
world.setRaceReturnPoint({ x: 0, z: 0 });
world.setRaceLoadPoints([[20000, 20000]]);
assert.equal(world.raceLoadProgress(), 1, 'tiles absent from the manifest never block race readiness');
world.updateLOD(new THREE.Vector3(20000, 100, 20000), null, 8);
assert(world.loadedAt(0, 0), 'race departure tile is retained beyond the normal drop radius');
assert(world.buildStatus.budget >= 13, 'race loading receives the base plus accelerated build budget');
world.setRaceReturnPoint(null); world.setRaceLoadPoints([]);
world.updateLOD(new THREE.Vector3(0, 100, 0));
assert(world.loadedAt(0, 0), 'cancel can resume immediately on retained ground');
world.updateLOD(new THREE.Vector3(20000, 100, 20000));
assert(!world.loadedAt(0, 0), 'normal disposal resumes after race preparation releases the departure');
console.log('PASS race streaming: manifest filtering, retained departure, accelerated budget and pin release');
