// Road blocks are built in slices (roads.js stripTriangleSteps, used by world.js through roadLODSteps): the same meshes
// as the one-go build (roadLOD), and no single step anywhere near a whole block's cost.
//   node tools/road_steps_test.mjs [tx_tz …]     (default: McMinnville, Sheridan and campus tiles)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { roadBatches, roadLOD, roadLODSteps } from '../game/src/roads.js';
import { mergeRoadBatches } from '../game/src/meshmerge.js';

const A = 'game/assets/', WJ = JSON.parse(fs.readFileSync(A + 'world.json')), W = makeWorld(WJ);
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['9_-6', '10_-6', '10_-5', '10_-7', '2_0', '1_0', '0_0'];
const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
const arrays = lod => lod.levels.map(l => [l.object.geometry.attributes.position.array, l.object.geometry.attributes.color.array, l.object.geometry.attributes.normal.array]);
let blocks = 0, worstBlock = { ms: 0 }, worstStep = { ms: 0 }; const all = [], wholes = [];
for (const name of names) {
  const [tx, tz] = name.split('_').map(Number), d = `${A}tiles/${name}/`;
  const td = makeTileData(WJ, tx, tz, await readTileData(async f => ab(d + f), WJ.packed)); W.add(td);
  for (const batch of mergeRoadBatches(roadBatches(td.renderRoads))) {
    const t0 = performance.now(), once = roadLOD(td, mat, batch), whole = performance.now() - t0;
    const steps = roadLODSteps(td, mat, batch); let r, label = 'start';
    for (;;) { const s = performance.now(); r = steps.next(); const ms = performance.now() - s; all.push(ms); if (ms > worstStep.ms) worstStep = { ms, name: `${name} after '${label}'` }; if (r.done) break; label = r.value; }
    assert.deepStrictEqual(arrays(r.value), arrays(once), `${name}: stepwise road block differs`);
    wholes.push(whole); if (whole > worstBlock.ms) worstBlock = { ms: whole, name };
    blocks++;
  }
}
const p99 = a => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.99)];
console.log(`PASS road steps: ${blocks} blocks in ${names.length} tiles identical to the one-go build · one-go block p99 ${p99(wholes).toFixed(1)} ms, ` +
  `max ${worstBlock.ms.toFixed(1)} ms (${worstBlock.name}) · steps p99 ${p99(all).toFixed(1)} ms, max ${worstStep.ms.toFixed(1)} ms (${worstStep.name}; machine load and GC make single maxima noisy)`);
