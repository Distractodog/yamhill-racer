// The game decodes tiles in steps inside its time-sliced build (tilepack.js readTileRaw + decodeTileSteps) instead
// of all at once (readTileData, still used by the Node tests): same data for every tile, and how long the longest
// single step takes compared with the whole decode.   node tools/tile_decode_steps_test.mjs [tx_tz …]
// (YR_ASSETS=dir for another assets folder; all tiles take ~30 s: run it through the heavy gate)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readTileData, readTileRaw, decodeTileSteps } from '../game/src/tilepack.js';

const A = (process.env.YR_ASSETS || 'game/assets').replace(/\/?$/, '/');
const W = JSON.parse(fs.readFileSync(A + 'world.json'));
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const names = process.argv.slice(2).length ? process.argv.slice(2) : W.tiles.map(([tx, tz]) => `${tx}_${tz}`);
let worstWhole = { ms: 0 }, worstStep = { ms: 0 };
for (const name of names) {
  const read = async f => ab(`${A}tiles/${name}/${f}`);
  const raw = await readTileRaw(read, W.packed);
  const steps = decodeTileSteps(raw);
  let r, label = 'decode-height', whole = 0;
  for (;;) {
    const s = performance.now(); r = steps.next(); const d = performance.now() - s; whole += d;
    if (d > worstStep.ms) worstStep = { ms: d, name: `${name} ${label}` };
    if (r.done) break;
    label = r.value;
  }
  if (whole > worstWhole.ms) worstWhole = { ms: whole, name };
  assert.deepStrictEqual(r.value, await readTileData(read, W.packed), `${name}: stepwise decode differs from readTileData`);
}
console.log(`PASS tile decode steps: ${names.length} tiles identical to readTileData · whole decode up to ${worstWhole.ms.toFixed(1)} ms (${worstWhole.name}), ` +
  `longest single step ${worstStep.ms.toFixed(1)} ms (${worstStep.name})`);
