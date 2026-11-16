// Original-resolution overview patches avoid resubmitting a huge decoded image
// every frame. Full-map zoom-out is already cached by minimap.js.
const caches = new WeakMap();
const TILE = 512, PAD = 4, LIMIT = 16;
// A big picture can be given its file's bytes (prepareMapImage). Then a missing patch is cut off the main thread
// (createImageBitmap from the bytes, one at a time) instead of from the <img>: for the 9600² minimap that meant
// decoding the whole picture again (the browser can't keep ~370 MB decoded), a freeze of a few hundred ms whenever
// the map needed a new patch: after every R reset, respawn or H, and every ~2 km of driving. Until its patch is ready
// (a fraction of a second) that square shows the background; the street imagery (minimapdetail.js) is drawn over it.
// (A quarter-size stand-in copy was tried: drawing from it cost ~100 ms the first time and ~10 ms a frame after.)
const sources = new WeakMap();
export function prepareMapImage(image, blob) {
  if (!blob || typeof createImageBitmap !== 'function') return;
  sources.set(image, { blob, busy: false, failed: false, revision: 0 });
}
// Goes up (never down) whenever what drawMapImage would draw changes: a patch arrived, or cutting them off the main
// thread failed and patches are now cut the old way. Callers that cache what they drew (minimap.js full map) redraw.
export const mapImageRevision = image => sources.get(image)?.revision ?? 0;
// evicted patches give their pixels back at once: an ImageBitmap is closed, a canvas shrunk to nothing
const release = patch => { const c = patch?.canvas; if (!c) return; if (typeof c.close === 'function') c.close(); else { c.width = 0; c.height = 0; } };
const keep = cache => { while (cache.size > LIMIT) { const k = cache.keys().next().value; release(cache.get(k)); cache.delete(k); } };
export function drawMapImage(ctx, image, ox, oy, scale) {
  if (!(scale > 0) || !Number.isFinite(scale)) return;
  const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
  const left = Math.max(0, -ox / scale), top = Math.max(0, -oy / scale);
  const right = Math.min(width, (ctx.canvas.width - ox) / scale), bottom = Math.min(height, (ctx.canvas.height - oy) / scale);
  if (right <= left || bottom <= top) return;
  const x0 = Math.floor(left / TILE), y0 = Math.floor(top / TILE);
  const x1 = Math.ceil(right / TILE), y1 = Math.ceil(bottom / TILE);
  if (scale < .5 || (x1 - x0) * (y1 - y0) > LIMIT) {
    ctx.drawImage(image, ox, oy, width * scale, height * scale);
    return;
  }
  let cache = caches.get(image);
  if (!cache) { cache = new Map(); caches.set(image, cache); }
  for (let ty = y0; ty < y1; ty++) for (let tx = x0; tx < x1; tx++) {
    const key = `${tx},${ty}`, x = tx * TILE, y = ty * TILE;
    let patch = cache.get(key);
    const src = sources.get(image);
    if (!patch && src && !src.failed) {
      const sx = Math.max(0, x - PAD), sy = Math.max(0, y - PAD), sw = Math.min(width, x + TILE + PAD) - sx, sh = Math.min(height, y + TILE + PAD) - sy;
      if (!src.busy) {
        src.busy = true;
        createImageBitmap(src.blob, sx, sy, sw, sh).then(canvas => { release(cache.get(key)); cache.set(key, { canvas, sx, sy }); keep(cache); src.revision++; },
          () => { src.failed = true; src.revision++; }).finally(() => { src.busy = false; });   // failed: cut them on the main thread from now on
      }
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
}
