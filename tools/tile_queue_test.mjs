// world.js tile loading (tilequeue.js) with tiles that fail:   node tools/tile_queue_test.mjs
// A real campus tile decodes and builds; copies of it with a corrupt tile.json (cut in half) or corrupt heights throw
// inside a build step (the stepwise decode, tilepack.js decodeTileSteps), one fails at the download, one in a late
// build step after part of it was built, one build returns nothing, one tile's finish throws. They are all queued
// together and stepped by the frame loop's update. Each failure: no exception out of update, its job leaves the
// queue, whatever it built is freed (its ground bitmaps closed), it no longer counts as loading (no stuck slot), finish
// never gets undefined, and it can be tried again after 3 s (and then loads). A sync (start-up) build of a corrupt
// tile doesn't throw either. The good tile loads in the same frames.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTileDataSteps } from '../game/src/data.js';
import { readTileRaw, decodeTileSteps } from '../game/src/tilepack.js';
import { createTileQueue } from '../game/src/tilequeue.js';

const A = 'game/assets/', WJ = JSON.parse(fs.readFileSync(A + 'world.json'));
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const raw = await readTileRaw(async f => ab(`${A}tiles/0_0/${f}`), WJ.packed);
const TILES = {
  good: { raw },
  json: { raw: { ...raw, json: raw.json.slice(0, raw.json.byteLength >> 1) } },          // tile.json cut in half
  height: { raw: { ...raw, height: raw.height.slice(0, 64) } },                           // heights cut short
  net: { reject: true },                                                                 // download fails
  late: { raw, failLate: true },                                                         // a later build step throws
  nothing: { raw, nothing: true },                                                       // the build returns nothing
  finish: { raw, finishThrows: true },                                                   // finish throws
};
let clock = 0, closed = 0;
const finished = [], freed = [], warnings = [];
const bitmap = () => ({ close() { closed++; } });
const q = createTileQueue({
  now: () => clock, warn: (...a) => warnings.push(a.join(' ')),
  fetch: job => { const t = TILES[job.k]; if (t.reject) return Promise.reject(new Error('404')); return t; },
  build: (job, t) => {
    job.img = [bitmap(), bitmap(), bitmap(), bitmap()];
    return (function* () {           // like world.js buildTile: decode, tile data, then meshes (job.partial)
      const td = yield* makeTileDataSteps(WJ, 0, 0, yield* decodeTileSteps(t.raw));
      job.partial = { td, freed: false };
      yield 'meshes';
      if (t.failLate) throw new Error('a mesh step failed');
      yield 'more meshes';
      return t.nothing ? undefined : job.partial;
    })();
  },
  finish: (job, v) => { assert(v, 'finish never gets undefined'); if (TILES[job.k].finishThrows) throw new Error('finish failed'); finished.push(job.k); },
  free: job => { freed.push(job.k); if (job.partial) job.partial.freed = true; job.img?.forEach(b => b.close()); },
});
const keys = Object.keys(TILES), jobsByKey = {};
await Promise.all(keys.map(k => q.start(k, { tx: 0, tz: 0 })));
for (const j of q.jobs) jobsByKey[j.k] = j;
assert.equal(q.jobs.length, keys.length - 1, 'every tile but the failed download is queued');
for (let frame = 0; frame < 5000 && q.jobs.length; frame++) { clock += 16; q.update(1e9, j => keys.indexOf(j.k)); }
assert.deepEqual(finished, ['good'], 'the good tile loads alongside the failing ones');
assert.equal(q.jobs.length, 0, 'no job left in the queue'); assert.equal(q.loading.size, 0, 'no tile stuck "loading"'); assert.equal(q.pending(), 0);
const bad = keys.filter(k => k !== 'good');
assert.deepEqual([...freed].sort(), [...bad].sort(), 'every failed tile is freed once');
for (const k of ['late', 'nothing', 'finish']) assert(jobsByKey[k].partial.freed, `${k}: what it built is freed`);
assert.equal(closed, 4 * (bad.length - 1), 'the failed builds\' ground bitmaps are closed');
for (const k of bad) assert(q.failedAt.has(k), `${k}: failure time kept`);
assert(warnings.some(w => w.includes('json')) && warnings.some(w => w.includes('height')), 'the corrupt tiles report why');
// retry: not within 3 s, then yes; a repaired tile then loads
clock += 1000; assert.equal(q.canStart('json'), false, 'no retry within 3 s');
clock += 2100; assert.equal(q.canStart('json'), true, 'retry after 3 s');
TILES.json = { raw };
await q.start('json', { tx: 0, tz: 0 });
for (let frame = 0; frame < 5000 && q.jobs.length; frame++) { clock += 16; q.update(5, () => 0); }
assert(finished.includes('json') && !q.failedAt.has('json') && q.loading.size === 0, 'the repaired tile loads on retry');
// start-up (sync) build of a corrupt tile: no throw, not stuck
TILES.sync = { raw: { ...raw, json: raw.json.slice(0, 100) } };
await q.start('sync', { tx: 0, tz: 0 }, true);
assert(!q.loading.has('sync') && q.failedAt.has('sync') && !finished.includes('sync'), 'a corrupt start-up tile fails cleanly');
console.log(`PASS tile queue: ${bad.length} failing tiles (corrupt tile.json, corrupt heights, download, late step, empty build, finish) ` +
  'dropped from the queue and freed, none stuck loading, retried after 3 s and loaded once repaired; the good tile loaded alongside; sync start-up build safe');
