// Original-resolution overview patches avoid resubmitting a huge decoded image
// every frame. Full-map zoom-out is already cached by minimap.js.
const caches = new WeakMap();
const TILE = 512, PAD = 4, LIMIT = 16;
// A big picture can be given its file's bytes (prepareMapImage). Then a missing patch is cut off the main thread
// (createImageBitmap from the bytes, one at a time) instead of from the <img>: for the 9600² minimap that meant
// decoding the whole picture again (the browser can't keep ~370 MB decoded), a freeze of a few hundred ms whenever
// the map needed a new patch: after every R reset, respawn or H, and every ~2 km of driving. Until its patch is
// ready, that part is drawn from a quarter-size copy of the picture (also made off the main thread, at start-up).
const sources = new WeakMap();
export function prepareMapImage(image, blob) {
  if (!blob || typeof createImageBitmap !== 'function') return;
  const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
  const src = { blob, low: null, busy: false, revision: 0 };
  sources.set(image, src);
  createImageBitmap(blob, { resizeWidth: Math.round(width / 4), resizeHeight: Math.round(height / 4), resizeQuality: 'medium' })
    .then(low => { src.low = low; src.revision++; }, () => {});
}
// changes when a patch (or the small copy) arrives, for callers that cache what they drew (minimap.js full map)
export const mapImageRevision = image => sources.get(image)?.revision ?? 0;
const keep = cache => { while (cache.size > LIMIT) cache.delete(cache.keys().next().value); };
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
    if (!patch && src) {
      const sx = Math.max(0, x - PAD), sy = Math.max(0, y - PAD), sw = Math.min(width, x + TILE + PAD) - sx, sh = Math.min(height, y + TILE + PAD) - sy;
      if (!src.busy) {
        src.busy = true;
        createImageBitmap(src.blob, sx, sy, sw, sh).then(canvas => { cache.set(key, { canvas, sx, sy }); keep(cache); src.revision++; },
          () => sources.delete(image)).finally(() => { src.busy = false; });       // failed: cut them as before
      }
      if (src.low) {
        const k = src.low.width / width;
        ctx.save(); ctx.beginPath(); ctx.rect(ox + x * scale, oy + y * scale, Math.min(TILE, width - x) * scale, Math.min(TILE, height - y) * scale); ctx.clip();
        ctx.drawImage(src.low, sx * k, sy * k, sw * k, sh * k, ox + sx * scale, oy + sy * scale, sw * scale, sh * scale);
        ctx.restore();
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
