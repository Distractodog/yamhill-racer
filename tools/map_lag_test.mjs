// Full map (M) lag when zooming and dragging, measured in the real game (headless Chrome), before → after.
//   python3 tools/serve.py 8173 game                     (this branch; another terminal)
//   python3 tools/serve.py 8174 <main checkout>/game     (optional: the code before)
//   node tools/map_lag_test.mjs [--before http://127.0.0.1:8174/] [--scale 5] [--only pan,pinch] [--out dir] [--headful]
//     (a heavy run: use the gate)
// With the car on campus the full map is opened and tools/lib/maplag.mjs runs its gestures: 20 wheel notches in, 20 out,
// a drag round a circle at zoom 1.6 / 4 / 30 / 200 (--scale × 1 s each, default 5 s), trackpad pinch at zoom 4 and 60.
// Per gesture: frame interval median / p95 / worst and % over 16.7 ms, map main-thread ms (minimap.update + the
// wheel / pointer handlers) median / p95 / worst and % over 8 ms, the whole frame's main-thread ms (3D render included),
// and per frame what ran: drawImage of a ≥ 4096 px picture (the old overview), other drawImage, path fills / strokes
// (roads, buildings), createImageBitmap calls.
// Then still views at zoom 1, 40 and 164 ('fit', 'car', 'car' + 3 × '+'): the full map canvas is saved as PNG in --out
// (default $TMPDIR/map-lag) for each build, and with --before the pairs are compared pixel by pixel (the car's arrow and
// pulsing ring masked): mean difference and % of pixels off by more than 32 (any channel). FAIL over 2 %.
// Headless Chrome is slower than a real browser: compare before/after on the same machine, not to 16.7 ms.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startGame, watchErrors, GAME_URL } from './lib/startgame.mjs';
import { mapGestures } from './lib/maplag.mjs';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SCALE = Number(arg('--scale', 5)), OUT = arg('--out', path.join(process.env.TMPDIR || os.tmpdir(), 'map-lag'));
const ONLY = arg('--only')?.split(',').map(s => s.trim()).filter(Boolean) || null;
const VIEWS = [['z1', 0], ['z40', 0], ['z164', 3]];    // name, '+' clicks after 'car' (z1: 'fit' only)
fs.mkdirSync(OUT, { recursive: true });
const launch = () => puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: process.argv.includes('--headful') ? false : 'new', args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });

async function measure(url, label) {
  const browser = await launch(), errors = [];
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 760 });
    watchErrors(page, label, errors); page.setDefaultTimeout(0);
    await startGame(page, { url });
    await page.evaluate(() => { game.keys.clear(); game.minimap.toggle(true); });
    await new Promise(r => setTimeout(r, 3000));           // the picture's levels / first patches (new code: a worker)
    const runs = await page.evaluate(`(${mapGestures})(${JSON.stringify({ scale: SCALE, phases: ONLY })})`);
    for (const r of runs) console.log(`${label.padEnd(6)} ${r.name.padEnd(22)} ${String(r.frames).padStart(4)} frames  interval median ${r.median.toFixed(1).padStart(5)} p95 ${r.p95.toFixed(1).padStart(5)} worst ${r.worst.toFixed(0).padStart(4)}  >16.7ms ${r.over16.toFixed(0).padStart(3)}%`
      + `  map ms median ${r.mainMedian.toFixed(1)} p95 ${r.mainP95.toFixed(1)} worst ${r.mainWorst.toFixed(0)} (>8 ms ${r.over8main.toFixed(0)}%)  frame ms p95 ${r.frameP95.toFixed(1)}`
      + `\n         per frame: big drawImage ${r.bigImageMs.toFixed(1)} ms (${r.bigImageN} in all), drawImage ${r.imageMs.toFixed(1)} ms ×${r.imageN.toFixed(0)}, paths ${r.pathMs.toFixed(1)} ms ×${r.pathN.toFixed(0)}, text ${r.textMs.toFixed(1)} ms, createImageBitmap ${r.bitmaps} in all`);
    const shots = {};
    for (const [name, plus] of VIEWS) {
      shots[name] = await still(page, name, plus);
      fs.writeFileSync(path.join(OUT, `${label}-${name}.png`), Buffer.from(shots[name].png.split(',')[1], 'base64'));
    }
    return { label, url, runs, shots, errors };
  } finally { await browser.close(); }
}
// a still view: 'fit' (z1), or 'car' then `plus` × '+'; waits for the detail and the picture to finish, then reads the canvas
function still(page, name, plus) {
  return page.evaluate(async (name, plus) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms)), m = game.minimap, click = k => document.querySelector(`#fullmap [data-z="${k}"]`).click();
    click('fit'); await sleep(300);
    if (name !== 'z1') { click('car'); for (let i = 0; i < plus; i++) click('in'); }
    await sleep(800);
    for (let i = 0; i < 300 && (m.detailStats.pending || m.moving); i++) await sleep(100);
    await sleep(4000);                                     // patches / street imagery (cut one at a time in the old code)
    const c = document.querySelector('#fullmap canvas'), W = c.width, H = c.height;
    // the car on the canvas: the centre on the 'car' views; on the whole map where it sits on the fitted picture
    let car = [W / 2, H / 2];
    if (name === 'z1') {
      const meta = await fetch('./assets/minimap.json').then(r => r.json()), [iw, ih] = meta.size, s = Math.min(W / iw, H / ih), p = game.vehicles.current.pos;
      car = [W / 2 + ((p.x - meta.extent[0]) / meta.mpp - iw / 2) * s, H / 2 + ((p.z - meta.extent[1]) / meta.mpp - ih / 2) * s];
    }
    return { png: c.toDataURL('image/png'), zoom: m.zoom, width: W, height: H, car, mask: 40 * W / c.getBoundingClientRect().width };
  }, name, plus);
}

// before vs after, in a blank page: mean |difference| and % of pixels off by > 32, the car's surroundings masked
async function compare(before, after) {
  const browser = await launch();
  try {
    const page = await browser.newPage(), out = {};
    for (const [name] of VIEWS) {
      const a = before.shots[name], b = after.shots[name];
      if (a.width !== b.width || a.height !== b.height) { out[name] = { error: `sizes differ ${a.width}×${a.height} / ${b.width}×${b.height}` }; continue; }
      out[name] = await page.evaluate(async (a, b) => {
        const load = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
        const [ia, ib] = await Promise.all([load(a.png), load(b.png)]), W = ia.width, H = ia.height;
        const px = im => { const c = new OffscreenCanvas(W, H), x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, W, H).data; };
        const da = px(ia), db = px(ib), mask = Math.max(a.mask, b.mask);
        let n = 0, off = 0, sum = 0;
        const diff = new ImageData(W, H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          if (Math.hypot(x - a.car[0], y - a.car[1]) < mask || Math.hypot(x - b.car[0], y - b.car[1]) < mask) continue;
          const i = (y * W + x) * 4, d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
          n++; sum += d; if (d > 32) off++;
          diff.data[i] = Math.min(255, d * 4); diff.data[i + 3] = 255;
        }
        const c = new OffscreenCanvas(W, H); c.getContext('2d').putImageData(diff, 0, 0);
        const blob = await c.convertToBlob(), bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = ''; for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return { mean: sum / n, offPct: 100 * off / n, diffPng: btoa(bin) };
      }, a, b);
      if (out[name].diffPng) { fs.writeFileSync(path.join(OUT, `diff-${name}.png`), Buffer.from(out[name].diffPng, 'base64')); delete out[name].diffPng; }
    }
    return out;
  } finally { await browser.close(); }
}

function table(before, after) {
  const by = new Map((before?.runs || []).map(r => [r.name, r]));
  const c = (o, r, k, d = 1) => o ? `${o[k].toFixed(d).padStart(5)} → ${r[k].toFixed(d).padEnd(5)}` : r[k].toFixed(d).padStart(5);
  console.log(`\n${'gesture'.padEnd(22)} ${'median ms'.padEnd(13)} ${'p95 ms'.padEnd(13)} ${'worst ms'.padEnd(13)} ${'% > 16.7'.padEnd(13)} ${'map p95 ms'.padEnd(13)} ${'map worst'.padEnd(13)} ${'frame p95 ms'.padEnd(13)} big drawImage/frame`);
  for (const r of after.runs) {
    const o = by.get(r.name);
    console.log(`${r.name.padEnd(22)} ${c(o, r, 'median')} ${c(o, r, 'p95')} ${c(o, r, 'worst', 0)} ${c(o, r, 'over16', 0)} ${c(o, r, 'mainP95')} ${c(o, r, 'mainWorst', 0)} ${c(o, r, 'frameP95')} ${c(o, r, 'bigImageMs')}`);
  }
}

const before = arg('--before') ? await measure(arg('--before'), 'before') : null;
const after = await measure(GAME_URL, before ? 'after' : 'run');
table(before, after);
let fail = false;
if (before) {
  const cmp = await compare(before, after);
  console.log('\nstill views, before vs after (the car masked):');
  for (const [name, r] of Object.entries(cmp)) {
    if (r.error) { console.log(`  ${name}: ${r.error}`); fail = true; continue; }
    const bad = r.offPct > 2; fail ||= bad;
    console.log(`  ${name.padEnd(5)} zoom ${after.shots[name].zoom.toFixed(1).padStart(6)}  mean |diff| ${r.mean.toFixed(2)}  ${r.offPct.toFixed(2)} % of pixels off by > 32${bad ? '  FAIL' : ''}`);
  }
}
console.log(`\nPNGs: ${OUT}  (${before ? 'before-*, after-*, diff-*' : 'run-*'})`);
fs.writeFileSync(path.join(OUT, 'map-lag.json'), JSON.stringify({ when: new Date().toISOString(), before: before && { ...before, shots: undefined }, after: { ...after, shots: undefined } }, null, 1));
const errors = [...(before?.errors || []), ...after.errors];
if (errors.length) { console.log(`FAIL page errors:\n  ${errors.join('\n  ')}`); fail = true; }
process.exit(fail ? 1 : 0);
