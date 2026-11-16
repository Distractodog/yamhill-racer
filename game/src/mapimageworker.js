// Off the main thread for mapimage.js: decodes the map picture's bytes and cuts what is drawn from it.
//   init:    { blob, factors, tile, pad } → one { level: { width, height, tiles: [{ x, y, w, h, px, py, bitmap }] } } per
//            factor, largest first, each made from the one before (½ of ½ …: a mip chain, sharp like the browser's own),
//            then { levelsDone: true } (also after a failure)
//   patches: { id, rects: [{ key, sx, sy, sw, sh }] } → { id, patches: [{ key, sx, sy, bitmap }] } (one decode for all)
// Jobs run one after another, so the ~370 MB decoded picture exists at most once and only while a job runs.
import { levelTiles } from './mapimage.js';
let blob = null, chain = Promise.resolve();
// a failed init only means no levels (mapimage.js then draws the original zoomed out); later jobs still run
self.onmessage = ({ data }) => { chain = chain.then(() => run(data)).catch(() => {}); };

async function resize(source, width, height) {
  const out = await createImageBitmap(source, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
  if (out.width === width && out.height === height) return out;
  out.close?.();                                           // resize options not supported: draw it smaller instead
  const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(source, 0, 0, width, height);
  return canvas.transferToImageBitmap();
}

async function run(data) {
  if (data.type === 'init') {
    blob = data.blob;
    try { await levels(data); } finally { self.postMessage({ levelsDone: true }); }   // also when it failed part-way
    return;
  }
  if (data.type === 'patches') {
    try {
      const full = await createImageBitmap(blob), patches = [];
      try {
        for (const r of data.rects) patches.push({ key: r.key, sx: r.sx, sy: r.sy, bitmap: await createImageBitmap(full, r.sx, r.sy, r.sw, r.sh) });
      } finally { full.close(); }
      self.postMessage({ id: data.id, patches }, patches.map(p => p.bitmap));
    } catch (e) { self.postMessage({ id: data.id, error: String(e?.message || e) }); }
  }
}

// ½ ¼ ⅛ of the picture, each from the one before, cut into tiles and sent as soon as each is made
async function levels(data) {
  let source = await createImageBitmap(blob);
  const W = source.width, H = source.height;
  for (const f of data.factors) {
    const width = Math.max(1, Math.round(W * f)), height = Math.max(1, Math.round(H * f));
    const level = await resize(source, width, height);
    source.close(); source = level;
    const tiles = [];
    for (const t of levelTiles(width, height, data.tile, data.pad))
      tiles.push({ x: t.x, y: t.y, w: t.w, h: t.h, px: t.px, py: t.py, bitmap: await createImageBitmap(level, t.px, t.py, t.pw, t.ph) });
    self.postMessage({ level: { width, height, tiles } }, tiles.map(t => t.bitmap));
  }
  source.close();
}
