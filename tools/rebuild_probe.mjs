// Rebuilt-world regression locations and route queries (no browser).
// node tools/rebuild_probe.mjs [report.json]
// Pass report.screenshots to tools/bridge_shots.mjs for director-owned locator images.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';

const assets = 'game/assets', manifest = JSON.parse(fs.readFileSync(`${assets}/world.json`));
const world = makeWorld(manifest);
for (const [tx, tz] of [[0, 0], [-2, 3], [2, 1]]) {
  const data = await readTileData(async name => {
    const b = fs.readFileSync(`${assets}/tiles/${tx}_${tz}/${name}`);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }, manifest.packed);
  world.add(makeTileData(manifest, tx, tz, data));
}
const query = (x, z, y) => ({ x, z, height: world.heightAt(x, z, y), surface: world.surfaceAt(x, z, y) });
const north = JSON.parse(fs.readFileSync(`${assets}/challenges.json`)).find(c => c.id === 'bike-north-scramble');
const routeSamples = north.track.flatMap(([x, z, halfWidth], index) =>
  index >= 700 && index <= 730 && index % 2 === 0 ? [{ index, ...query(x, z), halfWidth }] : []);
assert(routeSamples.some(p => p.halfWidth === 6), 'North woods bend corridor is capped');

const bridge = { below: query(-4138.578720247033, 6269.930476413629, 74.89425600921462),
  above: query(-4138.578720247033, 6269.930476413629) };
assert(bridge.above.height - bridge.below.height > 4, 'bridge junction keeps distinct layers');
assert.equal(bridge.below.surface, 3, 'lower road remains asphalt');
const seamSamples = [];
for (let d = -.1; d <= .1001; d += .01) seamSamples.push(query(3672.80 + d, 2352.93));
for (const p of seamSamples) assert.equal(p.surface, 3, 'rounded join has no exposed soil');
const seamStep = Math.max(...seamSamples.slice(1).map((p, i) => Math.abs(p.height - seamSamples[i].height)));
assert(seamStep < .02, `seam discontinuity ${seamStep}`);
const screenshots = [
  { id: 'NORTH-BEND', x: -20, z: -330, yaw: 1.4 },
  { id: 'BR-016', x: -4141.56, z: 6281.07, yaw: 2.034357 },
  { id: 'SHERIDAN-SEAM', x: 3672.80, z: 2352.93, yaw: 1.93 },
];
const report = { screenshots, routeSamples, bridge, seamSamples, seamStep };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
