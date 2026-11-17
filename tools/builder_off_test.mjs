// Bounded before/after comparison: one real tile, never the whole map.
// Director: heavy gate + node --max-old-space-size=1024 tools/builder_off_test.mjs --before <pre-builder commit>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { readTileData } from '../game/src/tilepack.js';
import { createPlacedLayer } from '../game/src/builder/placed.js';

const { values } = parseArgs({ options: { before: { type: 'string' } } });
assert.ok(values.before, 'Pass --before with the pre-builder revision.');
const root = new URL('../', import.meta.url), source = new URL('game/src/', root), modules = new Map();
// Load only the changed query/contact modules and their car consumers from the reference revision.
// Rewrite their imports to absolute URLs, with no temporary files or checkout changes.
async function reference(name) {
  const path = `game/src/${name}`;
  const original = execFileSync('git', ['show', `${values.before}:${path}`], { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const rewritten = original.replace(/(from\s+)(['"])([^'"]+)\2/g, (_, prefix, quote, specifier) => {
    const target = specifier.startsWith('.') ? modules.get(new URL(specifier, new URL(name, source)).href) || new URL(specifier, new URL(name, source)).href : import.meta.resolve(specifier);
    return `${prefix}${quote}${target}${quote}`;
  });
  const url = `data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`;
  modules.set(new URL(name, source).href, url);
  return import(url);
}
await reference('roofs.js');
await reference('vehicle.js');
const oldCar = await reference('car.js'), oldData = await reference('data.js');
const manifest = JSON.parse(await readFile(new URL('game/assets/world.json', root), 'utf8'));
assert.ok(manifest.tiles.some(([x,z]) => x === 0 && z === 0), 'Campus tile exists.');
const tileRoot = new URL('game/assets/tiles/0_0/', root);
const raw = await readTileData(async name => {
  const b = await readFile(new URL(name, tileRoot));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}, manifest.packed);
const current = makeWorld(manifest), baseline = oldData.makeWorld(manifest);
current.add(makeTileData(manifest, 0, 0, raw));
baseline.add(oldData.makeTileData(manifest, 0, 0, raw));
// Exercise off after a previously active layout, including clearing the roof cache revision.
const layer = createPlacedLayer();
layer.set({version:1,pieces:[{id:'temporary',type:'platform',x:0,y:20,z:0,yaw:0,scale:1}]});
current.setPlacedPieces(layer);
current.setPlacedPieces(null);
const snapshot = v => [...v.pos, ...v.vel, ...v.quat, ...v.ang, v.grounded, v.surface, v.airTime];
let steps = 0;
for (const [name,x,z,yaw] of [['campus',-542,440,0],['field',828,480,-Math.PI/2],['trail',0,0,.4]]) {
  const a = new Car(current,{...TUNING_DEFAULTS}), b = new oldCar.Car(baseline,{...oldCar.TUNING_DEFAULTS});
  a.reset(x,z,yaw);b.reset(x,z,yaw);
  for(let i=0;i<960;i++) {
    const input={throttle:i<720?1:0,brake:i>=720?1:0,steer:i>240&&i<480?.3:0,handbrake:i>540&&i<660};
    for(const v of [a,b]) {v.savePrev();v.step(1/120,input);}
    assert.deepEqual(snapshot(a),snapshot(b),`${name}: exact parity at step ${i}`);
    assert.ok([...a.pos,...a.vel,...a.quat].every(Number.isFinite),`${name}: finite state`);
    steps++;
  }
  console.log(`PASS ${name}: 960 identical physics steps`);
}
console.log(`PASS builder off vs ${values.before}: ${steps} identical steps; one loaded tile per world`);
