// world.js tile loading (tilequeue.js) with tiles that fail:   node tools/tile_queue_test.mjs
// A real campus tile decodes and builds; copies of it with a corrupt tile.json (cut in half) or corrupt heights throw
// inside a build step (the stepwise decode, tilepack.js decodeTileSteps), one fails at the download, one in a late
// build step after part of it was built, one build returns nothing, one tile's finish throws. They are all queued
// together and stepped by the frame loop's update. Each failure: no exception out of update, its job leaves the
// queue, whatever it built is freed (its ground bitmaps closed), it no longer counts as loading (no stuck slot), finish
// never gets undefined, and it can be retried (and then loads). A sync (start-up) build of a corrupt
// tile doesn't throw either. The good tile loads in the same frames.
// The download (world.js fetchTile → fetchTileParts): when the data download fails while the ground bitmaps succeed —
// some before the failure, some after it — or one bitmap fails, every bitmap made is closed; nothing leaks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { makeTileDataSteps } from '../game/src/data.js';
import { readTileRaw, decodeTileSteps, fetchReader } from '../game/src/tilepack.js';
import { createTileQueue, fetchTileParts, frameBudget, CARRY_MAX_MS, FRAME_MAX_MS } from '../game/src/tilequeue.js';

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
// retry: not within 1.5 s, then yes; a repaired tile then loads
clock += 1000; assert.equal(q.canStart('json'), false, 'no retry within 1.5 s');
clock += 500; assert.equal(q.canStart('json'), true, 'retry after 1.5 s');
TILES.json = { raw };
await q.start('json', { tx: 0, tz: 0 });
for (let frame = 0; frame < 5000 && q.jobs.length; frame++) { clock += 16; q.update(5, () => 0); }
assert(finished.includes('json') && !q.failedAt.has('json') && q.loading.size === 0, 'the repaired tile loads on retry');
// start-up (sync) build of a corrupt tile: no throw, not stuck
TILES.sync = { raw: { ...raw, json: raw.json.slice(0, 100) } };
await q.start('sync', { tx: 0, tz: 0 }, true);
assert(!q.loading.has('sync') && q.failedAt.has('sync') && !finished.includes('sync'), 'a corrupt start-up tile fails cleanly');

// Persistent failures back off, but never give up. Retries after fetch AND build failures bypass the cache;
// a success resets both the delay and reload flag, so a later visit starts normally.
{
  let t = 0, works = false;
  const reloads = [];
  const qr = createTileQueue({ now: () => t, warn: () => {},
    fetch: job => { reloads.push(job.reload); if (!works) throw new Error('offline'); return {}; },
    build: () => (function* () { return {}; })(), finish: () => {} });
  for (const delay of [1500, 3000, 6000, 12000, 12000, 12000]) {
    await qr.start('retry');
    assert.equal(qr.loading.size, 0, 'failed fetch releases its slot');
    t += delay - 1;
    assert.equal(qr.canStart('retry'), false, `backoff waits ${delay} ms`);
    t++;
    assert.equal(qr.canStart('retry'), true, 'retry remains available without an attempt limit');
  }
  works = true;
  await qr.start('retry', {}, true);
  assert(!qr.failedAt.has('retry'), 'success clears failure state');
  await qr.start('retry', {}, true);
  assert.deepEqual(reloads, [false, true, true, true, true, true, true, false]);
  works = false;
  await qr.start('retry'); t += 1500;
  assert(qr.canStart('retry'), 'success resets the backoff to 1.5 s');
}
// Real fetchReader → gunzip → stepwise decode: a valid gzip containing truncated JSON stays cached until reload.
{
  const originalFetch = globalThis.fetch, requests = [];
  let t = 0, loaded = false;
  try {
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options });
      const name = url.split('/').at(-1);
      if (name === 'tile.json.gz' && options?.cache !== 'reload') return new Response(gzipSync(raw.json.slice(0, 100)));
      return new Response(fs.readFileSync(`${A}tiles/0_0/${name}`));
    };
    const qr = createTileQueue({ now: () => t, warn: () => {},
      fetch: job => readTileRaw(fetchReader('tiles/0_0/', job.reload ? { cache: 'reload' } : undefined), WJ.packed),
      build: (job, data) => decodeTileSteps(data), finish: () => { loaded = true; } });
    await qr.start('cached', {}, true);
    assert(!loaded && qr.failedAt.has('cached'), 'cached corrupt JSON fails during the build');
    t = 1500;
    await qr.start('cached', {}, true);
    assert(loaded && !qr.failedAt.has('cached'), 'reload replaces the corrupt cached response and loads');
    assert.equal(requests.length, 10, 'both attempts fetch all five data files');
    assert(requests.slice(0, 5).every(r => r.options === undefined), 'first load keeps normal caching');
    assert(requests.slice(5).every(r => r.options?.cache === 'reload'), 'every retry data file bypasses the cache');
  } finally { globalThis.fetch = originalFetch; }
}
// ---- fetchTileParts
const later = ms => new Promise(r => setTimeout(r, ms));
const bmps = [];
const mk = (ms, ok = true) => later(ms).then(() => { if (!ok) throw new Error('bad bitmap'); const b = { open: true, close() { this.open = false; } }; bmps.push(b); return b; });
const open = () => bmps.filter(b => b.open).length;
// data fails at 20 ms; bitmaps arrive at 5, 10 (before) and 40, 60 ms (after the failure)
await assert.rejects(fetchTileParts(() => later(20).then(() => { throw new Error('data 404'); }), () => [mk(5), mk(10), mk(40), mk(60)]), /data 404/);
await later(100);
assert.equal(bmps.length, 4, 'all four bitmaps were made'); assert.equal(open(), 0, 'data failed: every bitmap closed, also the two that arrived after');
// one bitmap fails, the data and the other bitmaps succeed
bmps.length = 0;
await assert.rejects(fetchTileParts(() => later(5).then(() => ({ ok: 1 })), () => [mk(5), mk(15, false), mk(30), mk(50)]), /bad bitmap/);
await later(80);
assert.equal(bmps.length, 3); assert.equal(open(), 0, 'a bitmap failed: the others are closed');
// the ground file itself fails (no bitmaps at all) / everything fine
await assert.rejects(fetchTileParts(() => ({ ok: 1 }), () => Promise.reject(new Error('ground 404'))), /ground 404/);
bmps.length = 0;
const okParts = await fetchTileParts(() => later(5).then(() => 'data'), () => [mk(1), mk(2), mk(3), mk(4)]);
assert.equal(okParts.data, 'data'); assert.equal(okParts.img.length, 4); assert.equal(open(), 4, 'success: bitmaps kept for the textures');
// through the queue: a tile whose data download fails leaves no open bitmap and isn't stuck
bmps.length = 0;
const q2 = createTileQueue({ now: () => clock, warn: () => {}, fetch: () => fetchTileParts(() => later(10).then(() => { throw new Error('404'); }), () => [mk(2), mk(30)]),
  build: () => { throw new Error('never built'); }, finish: () => {} });
await q2.start('x', { tx: 0, tz: 0 }); await later(60);
assert.equal(open(), 0, 'queue: no open bitmap'); assert(!q2.loading.has('x') && q2.failedAt.has('x'), 'queue: failed download not stuck');

// budget carry: steps of one label alternating 3 and 0.2 ms keep its remembered cost at 3 ms, so a 5 ms frame stopped
// after ~3.2 ms (3 + 0.2, and 3 more doesn't fit). What is left is carried to the next frame: over many frames the
// builder averages its whole budget (without the carry: ~3.2 ms), never more than budget + CARRY_MAX_MS in a frame.
// Nothing is carried once the queue is empty.
{
  let t = 0;
  const qc = createTileQueue({ now: () => t, warn: () => {}, fetch: () => 1, finish: () => {},
    build: () => (function* () { for (let i = 0; i < 400; i++) { yield 'a'; t += i % 2 ? 0.2 : 3; } return {}; })() });
  await qc.start('c', {});
  const used = [];
  for (let f = 0; f < 60; f++) { const t0 = t; qc.update(5); used.push(t - t0); }
  const avg = used.slice(5).reduce((a, x) => a + x, 0) / (used.length - 5);
  assert(avg > 4.5 && avg <= 5.01, `carry: ${avg.toFixed(2)} ms a frame on average (budget 5)`);
  assert(Math.max(...used.slice(1)) <= 5 + CARRY_MAX_MS, 'carry: no frame over budget + CARRY_MAX_MS');
  while (qc.jobs.length) qc.update(5);
  assert.equal(qc.carry, 0, 'carry: none once the queue is empty');
}
// frameBudget: 60 Hz and faster keep the base; slower frames get proportionally more, never past FRAME_MAX_MS (or below base)
assert.equal(frameBudget(5, 1000 / 60), 5); assert.equal(frameBudget(5, 1000 / 120), 5);
assert(Math.abs(frameBudget(5, 25) - 7.5) < 1e-9, '40 fps: 1.5x'); assert.equal(frameBudget(5, 60), FRAME_MAX_MS);
assert.equal(frameBudget(9, 40), 9, 'at speed (9 ms) it stays 9'); assert.equal(frameBudget(13, 40), 13, 'a respawn hold base above the cap is kept');

console.log(`PASS tile queue: budget carry (whole budget on average, ≤ budget + ${CARRY_MAX_MS} ms a frame), frameBudget by frame rate; ${bad.length} failing tiles (corrupt tile.json, corrupt heights, download, late step, empty build, finish) ` +
  'dropped from the queue and freed, none stuck loading, retried after 1.5 s with capped backoff and cache reload, loaded once repaired; the good tile loaded alongside; sync start-up build safe; ' +
  'fetchTileParts closes every bitmap when the data, the ground file or one bitmap fails, including bitmaps that arrive after the failure');
