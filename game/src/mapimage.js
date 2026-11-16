// Original-resolution overview patches avoid resubmitting a huge decoded image
// every frame. Zoomed out, the picture is drawn from smaller copies (levels).
const caches = new WeakMap();
const TILE = 512, PAD = 4, LIMIT = 16, MAX_PATCHES = 96;
// A big picture can be given its file's bytes (prepareMapImage). Then a missing patch is cut off the main thread
// instead of from the <img>: for the 9600² minimap that meant decoding the whole picture again (the browser can't keep
// ~370 MB decoded), a freeze of a few hundred ms whenever the map needed a new patch: after every R reset, respawn or
// H, and every ~2 km of driving. Until its patch is ready (a fraction of a second) that square shows the finest level
// (or the background before the levels exist); the street imagery (minimapdetail.js) is drawn over it.
// (A quarter-size stand-in copy was tried on the main thread: drawing from it cost ~100 ms the first time and ~10 ms
// a frame after. The levels are cut into 1024 px tiles in a worker, so each draw only touches the tiles in view.)
// With a worker (mapimageworker.js) the picture is decoded once per batch of missing patches, and once at the start
// for the levels: ½, ¼ and ⅛ size, each from the one before. Without one, patches are cut one at a time with
// createImageBitmap(bytes, rect) and a zoomed-out view draws the whole <img> as before.
const sources = new WeakMap(), mips = new WeakMap();
export const LEVEL_FACTORS = [.5, .25, .125], LEVEL_TILE = 1024, LEVEL_PAD = 2;
export function prepareMapImage(image, blob, { worker = makeWorker() } = {}) {
  if (!blob || typeof createImageBitmap !== 'function') return;
  const src = { blob, busy: false, failed: false, revision: 0, worker: null, jobs: new Map(), next: 0 };
  sources.set(image, src);
  if (!worker) return;
  const mip = { levels: [] };       // ready levels, finest first
  mips.set(image, mip);
  src.worker = worker;
  worker.onmessage = ({ data }) => {
    if (data.level) { mip.levels.push(data.level); mip.levels.sort((a, b) => b.width - a.width); src.revision++; return; }
    const job = src.jobs.get(data.id); src.jobs.delete(data.id); job?.(data);
  };
  worker.onerror = () => {          // no worker after all: patches one at a time (levels that came stay)
    src.worker = null; worker.terminate?.();
    for (const job of src.jobs.values()) job({ error: 'worker' });
    src.jobs.clear();
  };
  worker.postMessage({ type: 'init', blob, factors: LEVEL_FACTORS, tile: LEVEL_TILE, pad: LEVEL_PAD });
}
function makeWorker() {
  if (typeof Worker !== 'function') return null;
  try { return new Worker(new URL('./mapimageworker.js', import.meta.url), { type: 'module' }); } catch { return null; }
}
// Goes up (never down) whenever what drawMapImage would draw changes: a patch or level arrived, or cutting them off
// the main thread failed and patches are now cut the old way. Callers that cache what they drew (minimap.js full map)
// redraw.
export const mapImageRevision = image => sources.get(image)?.revision ?? 0;

// the tiles a width × height picture is cut into: core squares of `tile` px (x, y, w, h) and the rectangle cut for
// each (px, py, pw, ph): the core plus `pad` px of its neighbours, so filtering at the seams matches one big picture
export function levelTiles(width, height, tile = LEVEL_TILE, pad = LEVEL_PAD) {
  const out = [];
  for (let y = 0; y < height; y += tile) for (let x = 0; x < width; x += tile) {
    const w = Math.min(tile, width - x), h = Math.min(tile, height - y);
    const px = Math.max(0, x - pad), py = Math.max(0, y - pad);
    out.push({ x, y, w, h, px, py, pw: Math.min(width, x + w + pad) - px, ph: Math.min(height, y + h + pad) - py });
  }
  return out;
}
// Which level to draw at `scale` canvas px per original px, of the ready levels' factors (size / original size):
// the smallest one still at least as sharp as the original drawn at that scale; if none is, the sharpest ready one
// (softer until the right one arrives). No levels: null (draw the original).
export function pickMapLevel(factors, scale) {
  let best = null, finest = null;
  for (const f of factors) {
    if (f >= scale * (1 - 1e-9) && (best === null || f < best)) best = f;
    if (finest === null || f > finest) finest = f;
  }
  return best ?? finest;
}
const levelFor = (mip, width, scale) => {
  if (!mip?.levels.length) return null;
  const f = pickMapLevel(mip.levels.map(l => l.width / width), scale);
  return mip.levels.find(l => l.width / width === f);
};
// draw a level's tiles over original-picture rectangle [l, r) × [t, b), each clipped to its own core square
function drawLevel(ctx, level, width, height, ox, oy, scale, l, t, r, b) {
  const kx = width / level.width, ky = height / level.height;
  for (const tile of level.tiles) {
    const cx0 = Math.max(l, tile.x * kx), cy0 = Math.max(t, tile.y * ky);
    const cx1 = Math.min(r, (tile.x + tile.w) * kx), cy1 = Math.min(b, (tile.y + tile.h) * ky);
    if (cx1 <= cx0 || cy1 <= cy0) continue;
    ctx.save(); ctx.beginPath(); ctx.rect(ox + cx0 * scale, oy + cy0 * scale, (cx1 - cx0) * scale, (cy1 - cy0) * scale); ctx.clip();
    ctx.drawImage(tile.bitmap, ox + tile.px * kx * scale, oy + tile.py * ky * scale, tile.bitmap.width * kx * scale, tile.bitmap.height * ky * scale);
    ctx.restore();
  }
}

// evicted patches give their pixels back at once: an ImageBitmap is closed, a canvas shrunk to nothing
const release = patch => { const c = patch?.canvas; if (!c) return; if (typeof c.close === 'function') c.close(); else { c.width = 0; c.height = 0; } };
const keep = cache => { while (cache.size > cache.limit) { const k = cache.keys().next().value; release(cache.get(k)); cache.delete(k); } };
// cut missing patches off the main thread: with the worker all of them from one decode, else one at a time
function request(src, cache, missing) {
  if (src.busy) return;
  src.busy = true;
  const done = () => { src.busy = false; };
  const failed = () => { src.failed = true; src.revision++; };      // cut them on the main thread from now on
  if (src.worker) {
    const id = ++src.next;
    src.jobs.set(id, data => {
      done();
      if (data.error) { if (!src.worker) src.revision++; else failed(); return; }
      for (const p of data.patches) { release(cache.get(p.key)); cache.delete(p.key); cache.set(p.key, { canvas: p.bitmap, sx: p.sx, sy: p.sy }); }
      keep(cache); src.revision++;
    });
    src.worker.postMessage({ type: 'patches', id, rects: missing.slice(0, cache.limit) });
    return;
  }
  const { key, sx, sy, sw, sh } = missing[0];
  createImageBitmap(src.blob, sx, sy, sw, sh).then(canvas => { release(cache.get(key)); cache.set(key, { canvas, sx, sy }); keep(cache); src.revision++; },
    failed).finally(done);
}
// options.load = false: draw only what is already there (no new patches cut): minimap.js while the full map moves
export function drawMapImage(ctx, image, ox, oy, scale, { load = true } = {}) {
  if (!(scale > 0) || !Number.isFinite(scale)) return;
  const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
  const left = Math.max(0, -ox / scale), top = Math.max(0, -oy / scale);
  const right = Math.min(width, (ctx.canvas.width - ox) / scale), bottom = Math.min(height, (ctx.canvas.height - oy) / scale);
  if (right <= left || bottom <= top) return;
  const x0 = Math.floor(left / TILE), y0 = Math.floor(top / TILE);
  const x1 = Math.ceil(right / TILE), y1 = Math.ceil(bottom / TILE), count = (x1 - x0) * (y1 - y0);
  const mip = mips.get(image);
  if (scale < .5 || count > MAX_PATCHES) {
    const level = levelFor(mip, width, scale);
    if (level) drawLevel(ctx, level, width, height, ox, oy, scale, left, top, right, bottom);
    else ctx.drawImage(image, ox, oy, width * scale, height * scale);
    return;
  }
  let cache = caches.get(image);
  if (!cache) { cache = new Map(); caches.set(image, cache); }
  cache.limit = Math.max(LIMIT, count);    // the whole view stays cached (a big full map at ½ scale needs ~80)
  const src = sources.get(image), under = levelFor(mip, width, Infinity), missing = [];
  for (let ty = y0; ty < y1; ty++) for (let tx = x0; tx < x1; tx++) {
    const key = `${tx},${ty}`, x = tx * TILE, y = ty * TILE;
    let patch = cache.get(key);
    if (!patch && src && !src.failed) {
      const sx = Math.max(0, x - PAD), sy = Math.max(0, y - PAD);
      if (load) missing.push({ key, sx, sy, sw: Math.min(width, x + TILE + PAD) - sx, sh: Math.min(height, y + TILE + PAD) - sy });
      if (under) drawLevel(ctx, under, width, height, ox, oy, scale, x, y, Math.min(width, x + TILE), Math.min(height, y + TILE));
      continue;
    }
    if (!patch) {
      const sx = Math.max(0, x - PAD), sy = Math.max(0, y - PAD);
      const ex = Math.min(width, x + TILE + PAD), ey = Math.min(height, y + TILE + PAD);
      const canvas = document.createElement('canvas'); canvas.width = ex - sx; canvas.height = ey - sy;
      canvas.getContext('2d').drawImage(image, sx, sy, ex - sx, ey - sy, 0, 0, ex - sx, ey - sy);
      patch = { canvas, sx, sy };
    }
    cache.delete(key); cache.set(key, patch); keep(cache);
    // Padded source pixels supply filtering at chunk seams. Clip only output,
    // never the source sampling region, and retain fractional destination edges.
    ctx.save(); ctx.beginPath(); ctx.rect(ox + x * scale, oy + y * scale,
      Math.min(TILE, width - x) * scale, Math.min(TILE, height - y) * scale); ctx.clip();
    ctx.drawImage(patch.canvas, ox + patch.sx * scale, oy + patch.sy * scale,
      patch.canvas.width * scale, patch.canvas.height * scale);
    ctx.restore();
  }
  if (missing.length) request(src, cache, missing);
}
