// Road blocks' near level built only when the camera comes near (game/src/roadnear.js, roads.js roadLODSteps nearNow /
// addNearLevelSteps): the scheduler's rules on made-up blocks, then on real tiles the near level built later is the
// same mesh, at the same LOD distance, as the one built with the tile; and what leaving it out saves.
//   node tools/road_near_test.mjs [tx_tz …]     (default: McMinnville, Sheridan and campus tiles)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { roadBatches, roadLOD, roadLODSteps, addNearLevelSteps } from '../game/src/roads.js';
import { mergeRoadBatches, placeRoadBlockSteps } from '../game/src/meshmerge.js';
import { createRoadNear, nearNow, soonDist, lodDist, LEAD, LEAD_S, GUARD } from '../game/src/roadnear.js';

const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

// ---- the rules
{
  assert.equal(lodDist({ x: 3, y: 4, z: 0 }, 0, 0), 5, 'LOD distance: to (x, 0, z), camera height included');
  const cam = { x: 0, y: 2, z: 0 };
  assert.equal(nearNow(null, null, 1e6, 1e6, 100), true, 'no camera yet (start-up tiles): built with the tile, as before');
  assert.equal(nearNow(cam, null, 600, 0, 400), true, 'standing: within show + LEAD');
  assert.equal(nearNow(cam, null, 400 + LEAD + 10, 0, 400), false, 'standing: beyond show + LEAD');
  const v = 1000 / 3.6;
  assert.equal(nearNow(cam, { x: v, y: 0, z: 0 }, 400 + LEAD + v * LEAD_S - 10, 0, 400), true, 'ahead, LEAD_S seconds at 1000 km/h');
  assert.equal(nearNow(cam, { x: v, y: 0, z: 0 }, 400 + LEAD + v * LEAD_S + 10, 0, 400), false, '... and no further');
  assert.equal(nearNow(cam, { x: -v, y: 0, z: 0 }, 400 + LEAD + 10, 0, 400), false, 'behind, moving away');
  assert.equal(nearNow(cam, { x: v, y: 0, z: 0 }, 300, 400 + LEAD - 10, 400), true, 'passing beside: the closest approach counts');
  near(soonDist(cam, { x: v, y: 0, z: 0 }, 300, 500), Math.hypot(500, 2), 1e-9, 'closest approach beside the line');
  const jet = { x: 0, y: 850, z: 0 }, level = { x: 1700 / 3.6, y: 0, z: 0 };
  assert.equal(nearNow(jet, level, 300, 0, 550), false, 'a jet 800 m up in level flight: the blocks below are never wanted');
  assert.equal(nearNow(jet, { x: 200, y: -200, z: 0 }, 300, 0, 550), true, '... but diving towards them they are');
}
// ---- the scheduler, with fake blocks: a generator of n steps of `ms` each on a fake clock
{
  let clock = 0;
  const made = [];
  const block = (x, show = 400, n = 3, ms = 1) => ({ x, z: 0, show, gen: null, done: false, steps: function* () { for (let i = 0; i < n; i++) { clock += ms; yield 'road-strips'; } made.push(x); } });
  const rn = createRoadNear({ now: () => clock });
  const cam = { x: 0, y: 2, z: 0 };
  const far = block(2000), soon = block(400 + 200), sooner = block(400 + 100), now = block(400 + GUARD - 1);
  const list = [far, soon, sooner, now];
  rn.check(list, cam, 0, null);
  assert.equal(now.done, true, 'within show + GUARD: built at once, in this frame');
  assert.equal(rn.stats.forced, 1);
  assert(!list.includes(now) && list.includes(far) && list.length === 3, 'finished blocks leave the list');
  assert(!soon.done && !sooner.done && !far.done, 'the rest wait for the budget');
  const t0 = clock; rn.build(2.5);
  assert(clock - t0 <= 3 + 1e-9, `the budget holds (one step may overrun): ${clock - t0}`);
  assert.equal(sooner.gen !== null, true, 'nearest to showing first');
  assert.equal(soon.gen, null, 'the farther one waits');
  rn.build(10);
  assert.equal(made.includes(400 + 100), false, 'build only works on what check listed (it was cleared)');
  for (let f = 0; f < 10; f++) { rn.check(list, cam, 0, null); rn.build(2.5); }
  assert(sooner.done && soon.done && !far.done, 'both built over a few frames; the far one never asked for');
  assert.deepEqual(made.slice(-2), [500, 600]);
  assert(!list.includes(soon) && list.includes(far));
  // due first (keep: the list stays for the second call), then the rest
  {
    const a = block(400 + 100), b = block(400 + 240);
    rn.check([a, b], cam, null, null);
    rn.build(100, { due: 150, keep: true });
    assert(a.done && !b.gen, 'only the due one in the first call');
    rn.build(100);
    assert(b.done, 'the rest in the second');
  }
  // budget 0: nothing but forced builds, and the list doesn't pile up
  const w = block(600); rn.check([w], cam, 0, null); assert.equal(rn.build(0), 0); assert.equal(w.gen, null);
  rn.build(100); assert.equal(w.gen, null, 'cleared without building');
  // a tile dropped while its block waited
  const owner = { dead: false }, d = block(600); rn.check([d], cam, 0, owner); owner.dead = true; rn.build(100); assert.equal(d.gen, null, 'dead tile: skipped');
  // a block part-way through its slices, then needed at once
  const p = block(620, 400, 5); rn.check([p], cam, null, null); rn.build(0.5);
  assert(p.gen && !p.done, 'started');
  rn.check([p], { x: 610, y: 2, z: 0 }, null, null); assert(p.done, 'forced: finishes the same build');
}

// ---- real tiles: later = the same mesh, the same LOD
const A = 'game/assets/', WJ = JSON.parse(fs.readFileSync(A + 'world.json')), W = makeWorld(WJ);
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['9_-6', '10_-6', '2_0', '0_0'];
const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
const arrays = lod => lod.levels.map(l => [l.distance, l.object.position.toArray(), l.object.geometry.boundingSphere?.radius,
  ...['position', 'color', 'normal'].map(k => l.object.geometry.attributes[k].array)]);
const run = g => { let r; while (!(r = g.next()).done); return r.value; };
let blocks = 0, farMs = 0, nearMs = 0;
for (const name of names) {
  const [tx, tz] = name.split('_').map(Number), d = `${A}tiles/${name}/`;
  const td = makeTileData(WJ, tx, tz, await readTileData(async f => ab(d + f), WJ.packed)); W.add(td);
  for (const batch of mergeRoadBatches(roadBatches(td.renderRoads))) {
    const eager = run(placeRoadBlockSteps(td, mat, batch, roadLODSteps));
    let shown = null;
    const t0 = performance.now();
    const later = run(placeRoadBlockSteps(td, mat, batch, (D, m, b) => roadLODSteps(D, m, b, (x, z, show) => { shown = { x, z, show }; return false; })));
    const t1 = performance.now();
    assert.equal(later.levels.length, 1, `${name}: only the far level with the tile`);
    assert(later.userData.near && shown, 'the left-out level is kept for later');
    assert.deepEqual(later.position.toArray(), [shown.x, 0, shown.z]);
    assert.equal(shown.show, eager.levels[1].distance, 'show distance = the far level\'s switch distance');
    run(addNearLevelSteps(later));
    farMs += t1 - t0; nearMs += performance.now() - t1;
    assert.equal(later.userData.near, null);
    assert.deepStrictEqual(arrays(later), arrays(eager), `${name}: the near level built later differs`);
    later.updateMatrixWorld(); eager.updateMatrixWorld();
    for (const dd of [0, shown.show - 1, shown.show, shown.show + 1, 5000]) {           // the same level shows at every distance
      const cam = new THREE.PerspectiveCamera(); cam.position.set(shown.x + dd, 0, shown.z); cam.updateMatrixWorld();
      later.update(cam); eager.update(cam);
      assert.deepEqual(later.levels.map(l => l.object.visible), eager.levels.map(l => l.object.visible), 'same level shown');
    }
    blocks++;
  }
}
console.log(`PASS road near: rules + scheduler; ${blocks} real blocks built later are identical to the tile-time build (mesh, LOD distance, level shown) · `
  + `far levels ${farMs.toFixed(0)} ms, near levels ${nearMs.toFixed(0)} ms (${(100 * nearMs / (farMs + nearMs)).toFixed(0)}% of the road build, now only near the camera)`);
