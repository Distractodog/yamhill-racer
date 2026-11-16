// Full map lag fix (map_lag_test.mjs measures it in the browser): mapimage.js levels (½ ¼ ⅛ copies cut into tiles in
// mapimageworker.js) and batched patches, mapview.js (still / moving, the moved old drawing), minimapdetail.js load:false.
//   node tools/mapmip_test.mjs
import assert from 'node:assert/strict';
import { drawMapImage, prepareMapImage, mapImageRevision, mapImageReady, warmMapImage, levelTiles, pickMapLevel, LEVEL_FACTORS } from '../game/src/mapimage.js';
import { createSettle, snapshotPlace, SETTLE_MS, easeZoom, ZOOM_EASE_MS, wheelEases, drawRatio, createQuiet, QUIET_MS, draw3D, BEHIND_MAP_MS } from '../game/src/mapview.js';
import { createMapDetail } from '../game/src/minimapdetail.js';
const tick = () => new Promise(r => setTimeout(r, 0));

// ---- levelTiles: cores tile the level exactly once, cut rectangles = core + pad inside the level
for (const [w, h] of [[4800, 4800], [1200, 1200], [2400, 1000], [700, 1500]]) {
  const tiles = levelTiles(w, h, 1024, 2);
  assert.equal(tiles.reduce((a, t) => a + t.w * t.h, 0), w * h, `${w}×${h}: cores cover the level once`);
  for (const t of tiles) {
    assert(t.px >= 0 && t.py >= 0 && t.px + t.pw <= w && t.py + t.ph <= h, 'cut inside the level');
    assert.equal(t.x - t.px, t.x ? 2 : 0); assert.equal(t.y - t.py, t.y ? 2 : 0);
    assert.equal(t.px + t.pw, Math.min(w, t.x + t.w + 2)); assert.equal(t.py + t.ph, Math.min(h, t.y + t.h + 2));
  }
}
// ---- pickMapLevel: the smallest level at least as sharp as the original drawn at that scale
assert.equal(pickMapLevel(LEVEL_FACTORS, .146), .25, 'whole map on a 1400 px canvas: the ¼ copy, drawn at 0.58');
assert.equal(pickMapLevel(LEVEL_FACTORS, .1), .125);
assert.equal(pickMapLevel(LEVEL_FACTORS, .125), .125, 'exactly ⅛ scale: the ⅛ copy');
assert.equal(pickMapLevel(LEVEL_FACTORS, .3), .5);
assert.equal(pickMapLevel(LEVEL_FACTORS, .9), .5, 'nothing sharp enough: the sharpest there is');
assert.equal(pickMapLevel([.125, .25], .3), .25, 'until the ½ copy arrives, the ¼ one');
assert.equal(pickMapLevel([], .3), null);

// ---- a fake 2D context: records every drawImage with the clip rectangle it was drawn under
function fakeCtx(width, height) {
  const draws = []; let pathRect = null, clip = null; const stack = [];
  return { draws, canvas: { width, height }, save() { stack.push(clip); }, restore() { clip = stack.pop(); }, beginPath() { pathRect = null; },
    rect(...r) { pathRect = r; }, clip() { clip = pathRect; }, drawImage(src, ...a) { draws.push({ src, a, clip }); } };
}
// a fake worker: posted jobs are kept; level / patch replies come from the test
function fakeWorker() {
  const w = { posted: [], terminated: false, postMessage(m) { this.posted.push(m); }, terminate() { this.terminated = true; } };
  return w;
}
const levelMsg = (f, W = 9600) => {
  const size = Math.round(W * f);
  return { level: { width: size, height: size, tiles: levelTiles(size, size, 1024, 2).map(t => ({ ...t, bitmap: { width: t.pw, height: t.ph, level: f } })) } };
};
let bitmapCalls = [], closedPatches = 0;
globalThis.createImageBitmap = (...a) => { bitmapCalls.push(a); return new Promise(() => {}); };   // the old one-at-a-time path

{ // levels: zoomed out the picture is drawn from them, never from the 9600² original
  const pic = { width: 9600, height: 9600 }, worker = fakeWorker();
  prepareMapImage(pic, { bytes: 1 }, { worker });
  assert.equal(worker.posted[0].type, 'init', 'the worker gets the bytes at once');
  assert.deepEqual(worker.posted[0].factors, LEVEL_FACTORS);
  const W = 2400, H = 1400, s = Math.min(W / 9600, H / 9600), ox = W / 2 - 4800 * s, oy = H / 2 - 4800 * s;
  let ctx = fakeCtx(W, H); drawMapImage(ctx, pic, ox, oy, s);
  assert.equal(ctx.draws.length, 1); assert.equal(ctx.draws[0].src, pic, 'no levels yet: the original, as before');
  const rev = mapImageRevision(pic);
  for (const f of LEVEL_FACTORS) worker.onmessage({ data: levelMsg(f) });
  assert.equal(mapImageRevision(pic), rev + 3, 'each level redraws a cached full map');
  ctx = fakeCtx(W, H); drawMapImage(ctx, pic, ox, oy, s);
  assert(ctx.draws.length > 0 && ctx.draws.every(d => d.src.level === .25), 'whole map: only the ¼ copy');
  // the clipped cores cover the picture's whole on-canvas square once
  const area = ctx.draws.reduce((a, d) => a + d.clip[2] * d.clip[3], 0), side = 9600 * s;
  assert(Math.abs(area - side * Math.min(H, side)) < 1, `level tiles cover the view (${area} vs ${side * side})`);
  for (const d of ctx.draws) {     // each tile drawn at the scale that maps its pixels back onto the original's
    const [dx, dy, dw, dh] = d.a, k = 9600 / 2400;
    assert(Math.abs(dw - d.src.width * k * s) < 1e-9 && Math.abs(dh - d.src.height * k * s) < 1e-9);
    assert(dx <= d.clip[0] + 1e-9 && dy <= d.clip[1] + 1e-9 && dx + dw >= d.clip[0] + d.clip[2] - 1e-9, 'the tile covers its clip');
  }
  // zoomed in a little (scale .3, ½ copy): only the tiles in view are touched
  ctx = fakeCtx(W, H); drawMapImage(ctx, pic, W / 2 - 4800 * .3, H / 2 - 4800 * .3, .3);
  assert(ctx.draws.every(d => d.src.level === .5), '½ copy at scale .3');
  assert(ctx.draws.length < levelTiles(4800, 4800).length, `only tiles in view (${ctx.draws.length})`);
  const inView = ctx.draws.reduce((a, d) => a + d.clip[2] * d.clip[3], 0);
  assert(Math.abs(inView - W * H) < 1, 'and they fill the canvas exactly');
  ctx = fakeCtx(W, H); drawMapImage(ctx, pic, W / 2 - 4800 * .08, H / 2 - 4800 * .08, .08);
  assert(ctx.draws.every(d => d.src.level === .125), '⅛ copy below ⅛ scale');
  assert.equal(bitmapCalls.length, 0, 'the overview cuts nothing');
}

{ // patches: all missing ones in one worker job, the ½ copy under them meanwhile; load:false asks for nothing
  const pic = { width: 9600, height: 9600 }, worker = fakeWorker();
  prepareMapImage(pic, { bytes: 1 }, { worker });
  worker.onmessage({ data: levelMsg(.5) });
  const W = 2560, H = 1440, s = .5, ox = W / 2 - 4000 * s, oy = H / 2 - 5000 * s;
  let ctx = fakeCtx(W, H); drawMapImage(ctx, pic, ox, oy, s, { load: false });
  assert.equal(worker.posted.length, 1, 'load:false: no patch job');
  assert(ctx.draws.length > 0 && ctx.draws.every(d => d.src.level === .5), 'missing patches show the ½ copy');
  ctx = fakeCtx(W, H); drawMapImage(ctx, pic, ox, oy, s);
  const job = worker.posted[1];
  assert.equal(job.type, 'patches');
  const need = Math.ceil(W / s / 512 + 1) * Math.ceil(H / s / 512 + 1);
  assert(job.rects.length > 16 && job.rects.length <= need, `one job for the whole view (${job.rects.length} patches)`);
  drawMapImage(fakeCtx(W, H), pic, ox, oy, s); drawMapImage(fakeCtx(W, H), pic, ox + 300, oy, s);
  assert.equal(worker.posted.length, 2, 'one job at a time');
  for (const r of job.rects) { assert(r.sx >= 0 && r.sy >= 0 && r.sx + r.sw <= 9600 && r.sy + r.sh <= 9600); }
  const rev = mapImageRevision(pic);
  worker.onmessage({ data: { id: job.id, patches: job.rects.map(r => ({ key: r.key, sx: r.sx, sy: r.sy, bitmap: { width: r.sw, height: r.sh, patch: r.key, close() { closedPatches++; } } })) } });
  assert(mapImageRevision(pic) > rev, 'patches arriving redraw the cached map');
  for (let i = 0; i < 3; i++) {
    ctx = fakeCtx(W, H); drawMapImage(ctx, pic, ox, oy, s);
    assert(ctx.draws.length === job.rects.length && ctx.draws.every(d => d.src.patch), `frame ${i}: the whole view from patches (${ctx.draws.length})`);
  }
  assert.equal(worker.posted.length, 2, 'a view bigger than 16 patches stays cached (no new job)');
  // the corner map (1-4 patches) shrinks the cache back to 16: the rest are closed
  drawMapImage(fakeCtx(420, 420), pic, 210 - 4000 * 3, 210 - 5000 * 3, 3);
  assert.equal(closedPatches, job.rects.length - 16, 'corner map: cache back to 16 patches, the evicted ones closed');
  // a worker that fails: from then on one patch at a time with createImageBitmap(bytes, rect), as before
  bitmapCalls = [];
  worker.onerror(new Event('error'));
  assert(worker.terminated);
  const ox2 = W / 2 - 8000 * s, oy2 = H / 2 - 8000 * s;
  drawMapImage(fakeCtx(W, H), pic, ox2, oy2, s); drawMapImage(fakeCtx(W, H), pic, ox2, oy2, s);
  assert.equal(bitmapCalls.length, 1, 'no worker: one createImageBitmap(bytes, rect) at a time');
  assert.equal(bitmapCalls[0].length, 5);
}

{ // a failed patch job (decode error): patches are cut on the main thread from then on, and the map redraws
  const pic = { width: 9600, height: 9600 }, worker = fakeWorker();
  let made = 0; globalThis.document = { createElement() { made++; return { width: 0, height: 0, getContext() { return { drawImage() {} }; } }; } };
  prepareMapImage(pic, { bytes: 1 }, { worker });
  drawMapImage(fakeCtx(420, 300), pic, -5000, -5000, 1);
  const job = worker.posted.at(-1), rev = mapImageRevision(pic);
  worker.onmessage({ data: { id: job.id, error: 'decode failed' } });
  assert(mapImageRevision(pic) > rev);
  const ctx = fakeCtx(420, 300); drawMapImage(ctx, pic, -5000, -5000, 1);
  assert(made > 0 && ctx.draws.length > 0, 'cut and drawn on the main thread at once');
  delete globalThis.document;
}

{ // spawn map / gestures (map-lag round 2): levels ready promise, nothing new uploaded or the original drawn mid-gesture,
  // level tiles warmed coarsest first
  const pic = { width: 9600, height: 9600 }, worker = fakeWorker();
  prepareMapImage(pic, { bytes: 1 }, { worker });
  let ready = false; mapImageReady(pic).then(() => { ready = true; });
  const W = 1350, H = 800, s = Math.min(W, H) / 9600, ox = W / 2 - 4800 * s, oy = H / 2 - 4800 * s;
  let ctx = fakeCtx(W, H); drawMapImage(ctx, pic, ox, oy, s, { load: false });
  assert.equal(ctx.draws.length, 0, 'moving before the levels exist: not the 9600² original (background only)');
  worker.onmessage({ data: levelMsg(.5) }); worker.onmessage({ data: levelMsg(.25) }); await tick();
  assert(!ready, 'two of three levels: not ready yet');
  worker.onmessage({ data: levelMsg(.125) }); await tick();
  assert(ready, 'all levels: ready');
  // warm-up: one tile per call, ⅛ first, then ¼, then ½; each 1 px at (0, 0); then false
  const warm = fakeCtx(W, H), order = [];
  while (warmMapImage(warm, pic)) order.push(warm.draws.at(-1).src.level);
  const n = f => levelTiles(9600 * f, 9600 * f).length;
  assert.equal(order.length, n(.5) + n(.25) + n(.125), 'every level tile once');
  assert.deepEqual([...new Set(order)], [.125, .25, .5], 'coarsest first');
  assert(warm.draws.every(d => d.a.join() === '0,0,1,1'), 'drawn 1 px big');
  assert.equal(warmMapImage(warm, pic), false);
  // a patch that arrived while moving is not drawn (first upload) until a still frame; the ½ copy shows instead
  const s2 = .6, ox2 = W / 2 - 3000 * s2, oy2 = H / 2 - 3000 * s2;
  drawMapImage(fakeCtx(W, H), pic, ox2, oy2, s2);
  const job = worker.posted.at(-1);
  assert.equal(job.type, 'patches');
  worker.onmessage({ data: { id: job.id, patches: job.rects.map(r => ({ key: r.key, sx: r.sx, sy: r.sy, bitmap: { width: r.sw, height: r.sh, patch: r.key } })) } });
  ctx = fakeCtx(W, H); drawMapImage(ctx, pic, ox2, oy2, s2, { load: false });
  assert(ctx.draws.length > 0 && ctx.draws.every(d => d.src.level === .5), 'moving: new patches not drawn yet');
  ctx = fakeCtx(W, H); drawMapImage(ctx, pic, ox2, oy2, s2);
  assert(ctx.draws.every(d => d.src.patch), 'still: the patches');
  ctx = fakeCtx(W, H); drawMapImage(ctx, pic, ox2, oy2, s2, { load: false });
  assert(ctx.draws.every(d => d.src.patch), 'moving again: patches already shown are drawn');
  // a worker that never makes levels: done is still announced, and an error resolves it too
  const pic2 = { width: 9600, height: 9600 }, w2 = fakeWorker(); prepareMapImage(pic2, { bytes: 1 }, { worker: w2 });
  let r2 = false; mapImageReady(pic2).then(() => { r2 = true; }); w2.onmessage({ data: { levelsDone: true } }); await tick(); assert(r2, 'levelsDone: ready');
  const pic3 = { width: 9600, height: 9600 }, w3 = fakeWorker(); prepareMapImage(pic3, { bytes: 1 }, { worker: w3 });
  let r3 = false; mapImageReady(pic3).then(() => { r3 = true; }); w3.onerror(new Event('error')); await tick(); assert(r3, 'worker error: ready');
  ctx = fakeCtx(W, H); drawMapImage(ctx, pic3, ox, oy, s, { load: false });
  assert.equal(ctx.draws[0]?.src, pic3, 'no worker and no levels: the original even while moving (as before)');
  let r4 = false; mapImageReady({}).then(() => { r4 = true; }); await tick(); assert(r4, 'never prepared: ready at once');
}

// ---- mapview.js
{
  const st = createSettle();
  assert.equal(st.step('a', 0), true, 'first frame after opening: still (drawn properly at once)');
  assert.equal(st.step('a', 16), true);
  assert.equal(st.step('b', 32), false, 'view changed: moving');
  assert.equal(st.step('b', 32 + SETTLE_MS - 1), false);
  assert.equal(st.step('b', 32 + SETTLE_MS), true, `still after ${SETTLE_MS} ms`);
  assert.equal(st.step('c', 400), false); st.reset(); assert.equal(st.step('d', 401), true, 'reset (map reopened): still');
  // a picture pixel lands at the same canvas spot through the moved old drawing as drawn directly
  const snap = { ox: -1234.5, oy: 321.25, s: 1.7, w: 2400, h: 1400 };
  for (const [ox, oy, s] of [[-1000, 200, 1.7], [-3000, -50, 3.4], [100, 600, .4], [-1234.5, 321.25, 1.7]]) {
    const at = snapshotPlace(snap, ox, oy, s), k = s / snap.s;
    assert(at, `placed at ${s}`);
    for (const [u, v] of [[0, 0], [700, 900], [2400, 1400]]) {
      const ix = (u - snap.ox) / snap.s, iy = (v - snap.oy) / snap.s;
      assert(Math.abs(at[0] + u * k - (ox + ix * s)) < 1e-6 && Math.abs(at[1] + v * k - (oy + iy * s)) < 1e-6);
    }
    assert(Math.abs(at[2] - snap.w * k) < 1e-9 && Math.abs(at[3] - snap.h * k) < 1e-9);
  }
  assert.equal(snapshotPlace(snap, 0, 0, snap.s * 3), null, 'stretched 3×: not used (blurry)');
  assert.equal(snapshotPlace(snap, 0, 0, snap.s / 9), null, 'shrunk 9×: not used');
  assert.equal(snapshotPlace(null, 0, 0, 1), null);
  // eased zoom: ~95 % of the way after 3τ (120 ms) at 60 fps, never past the goal, in and out alike, ends exactly on it
  for (const [z0, goal] of [[1, 1.6 ** 3], [40, 40 / 1.6], [4, 4 * Math.exp(.18)]]) {
    let z = z0, t = 0, done = false, prev = z0;
    while (!done && t < 1000) {
      ({ zoom: z, done } = easeZoom(z, goal, 1000 / 60)); t += 1000 / 60;
      assert(goal > z0 ? z >= prev && z <= goal : z <= prev && z >= goal, 'monotone, never past the goal'); prev = z;
      if (Math.abs(t - 3 * ZOOM_EASE_MS) < 9) assert(Math.abs(Math.log(z / z0)) >= .93 * Math.abs(Math.log(goal / z0)), `${z0} → ${goal}: ≥ 93 % at ~120 ms`);
    }
    assert(done && z === goal && t < 400, `${z0} → ${goal}: arrives (${t.toFixed(0)} ms)`);
  }
  assert.equal(easeZoom(2, 3, 0).zoom, 2, 'no time, no step');
  assert(easeZoom(2, 3, 1e6).done, 'a long frame: there');
  // wheel: a mouse notch eases; a trackpad's pinch (ctrlKey) or small scroll deltas are applied at once
  assert(wheelEases({ deltaY: -100, deltaMode: 0 }) && wheelEases({ deltaY: 3, deltaMode: 1 }), 'notches (pixels or lines) ease');
  assert(!wheelEases({ deltaY: -6, deltaMode: 0, ctrlKey: true }) && !wheelEases({ deltaY: -120, deltaMode: 0, ctrlKey: true }), 'pinch: at once');
  assert(!wheelEases({ deltaY: 4, deltaMode: 0 }), 'two-finger scroll: at once');
  // moving frames at pixel ratio 1 (a Retina screen draws ¼ of the pixels); still: the full ratio
  assert.equal(drawRatio(2, true), 1); assert.equal(drawRatio(2, false), 2); assert.equal(drawRatio(1, true), 1); assert.equal(drawRatio(.8, true), .8);
  const q = createQuiet();
  assert(!q.busy(0), 'no input yet: quiet'); q.touch(100);
  assert(q.busy(100) && q.busy(100 + QUIET_MS - 1) && !q.busy(100 + QUIET_MS), `busy for ${QUIET_MS} ms after the last input`);
  q.reset(); assert(!q.busy(101));
  // the 3D view behind the open full map: frozen in single player and on the spawn map, ~4 fps mid-game in multiplayer
  const frames = o => {             // redraws in one second at 60 fps
    let last = -Infinity, n = 0;
    for (let i = 0; i < 60; i++) { const now = i * 1000 / 60; if (draw3D({ drawn: true, last, now, ...o })) { n++; last = now; } }
    return n;
  };
  assert.equal(frames({ open: false, multiplayer: false, spawn: false, busy: false }), 60, 'map closed: every frame');
  assert.equal(frames({ open: true, multiplayer: false, spawn: false, busy: false }), 0, 'single player, M open: paused');
  assert.equal(frames({ open: true, multiplayer: true, spawn: true, busy: false }), 0, 'spawn map (multiplayer too): paused');
  assert.equal(frames({ open: true, multiplayer: true, spawn: false, busy: true }), 0, 'multiplayer while zooming / dragging: paused');
  const mp = frames({ open: true, multiplayer: true, spawn: false, busy: false });
  assert(mp >= 3 && mp <= 4 && BEHIND_MAP_MS === 250, `multiplayer, M open: ${mp} redraws a second`);
  assert(draw3D({ open: true, drawn: false, multiplayer: false, spawn: true, busy: true, now: 0, last: 0 }), 'nothing drawn yet: one frame');
}

// ---- minimapdetail.js draw(…, { load: false }): only images already shown, nothing requested or evicted
{
  const tiles = []; for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) tiles.push([x, z]);
  const meta = { mpp: 5, extent: [-11000, -11000, 11000, 11000], detail: { tile: 2000, path: 'detail/', tiles } };
  const calls = [], jobs = [];
  const det = createMapDetail(meta, 'assets/', url => { calls.push(url); return new Promise(r => jobs.push(() => r({ url }))); });
  const draws = [], ctx = { canvas: { width: 420, height: 420 }, drawImage: (...a) => draws.push(a) };
  const view = (x, z, opt) => det.draw(ctx, 210 - (x + 11000), 210 - (z + 11000), 5, opt);
  view(0, 0); while (jobs.length) { jobs.splice(0).forEach(f => f()); await tick(); }
  view(0, 0); assert.equal(draws.length, 1, 'shown');
  draws.length = 0; view(0, 0, { load: false }); assert.equal(draws.length, 1, 'load:false draws a shown image');
  const n = calls.length; draws.length = 0;
  view(6000, 6000, { load: false }); await tick();
  assert.equal(calls.length, n, 'load:false requests nothing'); assert.equal(draws.length, 0);
  view(4000, 0); while (jobs.length) { jobs.splice(0).forEach(f => f()); await tick(); }
  draws.length = 0; view(4000, 0, { load: false });
  assert.equal(draws.length, 0, 'load:false skips a loaded image never drawn yet (its first draw is the slow one)');
  view(4000, 0); assert.equal(draws.length, 1, 'the next normal draw shows it');
}
// map_lag_test.mjs sends the gesture runner to the page as source text: it must stand alone
{ const { mapGestures } = await import('./lib/maplag.mjs'); assert.equal(typeof new Function(`return (${mapGestures})`)(), 'function'); }
console.log('PASS: map levels (tiles cover once, level pick, zoomed out never the original, only tiles in view), patches in one worker job with the ½ copy under them, load:false asks nothing, big views stay cached, worker failure → one at a time, failed job → main thread; levels ready promise, moving: no original / no first patch upload, warm-up coarsest first; settle / moved drawing maths, eased zoom, wheel kinds, moving pixel ratio, quiet timer, 3D behind the map (paused, multiplayer ~4 fps); imagery load:false');
