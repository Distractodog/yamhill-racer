// Original-resolution overview patches avoid resubmitting a huge decoded image
// every frame. Full-map zoom-out is already cached by minimap.js.
const caches = new WeakMap();
const TILE = 512, PAD = 4, LIMIT = 16;
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
    if (!patch) {
      const sx = Math.max(0, x - PAD), sy = Math.max(0, y - PAD);
      const ex = Math.min(width, x + TILE + PAD), ey = Math.min(height, y + TILE + PAD);
      const canvas = document.createElement('canvas'); canvas.width = ex - sx; canvas.height = ey - sy;
      canvas.getContext('2d').drawImage(image, sx, sy, ex - sx, ey - sy, 0, 0, ex - sx, ey - sy);
      patch = { canvas, sx, sy };
    }
    cache.delete(key); cache.set(key, patch);
    while (cache.size > LIMIT) cache.delete(cache.keys().next().value);
    // Padded source pixels supply filtering at chunk seams. Clip only output,
    // never the source sampling region, and retain fractional destination edges.
    ctx.save(); ctx.beginPath(); ctx.rect(ox + x * scale, oy + y * scale,
      Math.min(TILE, width - x) * scale, Math.min(TILE, height - y) * scale); ctx.clip();
    ctx.drawImage(patch.canvas, ox + patch.sx * scale, oy + patch.sy * scale,
      patch.canvas.width * scale, patch.canvas.height * scale);
    ctx.restore();
  }
}
