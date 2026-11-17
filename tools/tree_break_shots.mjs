// Director-run: game server at 127.0.0.1:8173, through the heavy gate. Review every PNG.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const out = arg('--out', '/tmp/yr-tree-break'), url = arg('--url', 'http://127.0.0.1:8173/');
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const errors = [], shots = [], report = { errors, shots, visualReview: 'NOT REVIEWED' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', e => errors.push(e.message));
  await page.evaluateOnNewDocument(() => { localStorage.setItem('yr-welcome-hidden-1', '1'); Object.defineProperty(navigator, 'getGamepads', { value: () => [] }); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.game?.sessionSpawn, { timeout: 180000 });
  if (await page.evaluate(() => game.sessionSpawn.blocked)) {
    await page.waitForSelector('#fullmap.open canvas', { visible: true });
    const box = await (await page.$('#fullmap canvas')).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => !game.sessionSpawn.blocked, { timeout: 120000 });
  }
  await page.evaluate(() => {
    document.getElementById('welcome-start')?.click(); game.garage?.close(); game.challenges.quit(); game.minimap.toggle(false);
  });
  await page.waitForFunction(() => game.world.pendingTiles() === 0, { timeout: 120000 });
  report.target = await page.evaluate(() => {
    const g = game, w = g.world;
    g.vehicles.choose('car', 'truck'); g.setCam(0);
    const car = g.vehicles.current, candidates = [];
    for (const td of w.tiles.values()) for (let i = 0; i < td.treeCount; i++) {
      const [x, z, h] = td.trees.subarray(i * 4, i * 4 + 3);
      if (h < 6 || h > 12 || w.normalAt(x, z).y < .98 || w.buildingsNear(x, z).some(b => b.pts.some(p => Math.hypot(p[0] - x, p[1] - z) < 15))) continue;
      const d = Math.hypot(car.pos.x - x, car.pos.z - z);
      candidates.push({ x, z, h, id: `${td.tx}_${td.tz}:${i}`, d });
    }
    candidates.sort((a, b) => a.d - b.d);
    const target = candidates[0]; if (!target) throw new Error('No flat, small tree loaded');
    car.reset(target.x, target.z - 8, 0); car.vel.set(0, 0, 0);
    window.treeShot = { target, step: car.step, frames: [], last: null };
    car.step = () => {};
    const sample = now => { const s = window.treeShot; if (s.last !== null) s.frames.push(now - s.last); s.last = now; requestAnimationFrame(sample); }; requestAnimationFrame(sample);
    window.treeShot.off = w.treeBreaks.onChange(e => { if (e.id === target.id && e.broken) { window.treeShot.brokenAt = performance.now(); car.step = () => {}; } });
    return target;
  });
  await wait(1000);
  const shot = async name => {
    const state = await page.evaluate(() => ({ broken: game.world.treeBreaks.broken.has(treeShot.target.id), tops: game.world.treeFX.activeTops,
      kmh: game.vehicles.current.vel.length() * 3.6, programs: game.renderer.info.programs.length, calls: game.renderer.info.render.calls }));
    const file = `${name}.png`; await page.screenshot({ path: join(out, file) }); shots.push({ file, state }); return state;
  };
  await page.waitForFunction(() => game.world.treeFX.warmed && game.warmup.done, { timeout: 120000 });
  const before = await shot('before');
  await page.evaluate(() => { const c = game.vehicles.current; c.vel.set(0, 0, 100 / 3.6); c.step = treeShot.step; });
  await page.waitForFunction(() => treeShot.brokenAt, { timeout: 15000 });
  const impact = await shot('impact'); assert(impact.broken); assert(impact.kmh > 70, 'truck keeps most speed');
  assert.equal(impact.programs, before.programs, 'the first break does not compile programs');
  report.startupPrograms = before.programs;
  await wait(650); await shot('falling');
  await wait(1600); await shot('landed');
  await wait(6500); await shot('fading');
  await wait(2000); const stump = await shot('stump'); assert.equal(stump.tops, 0);
  report.firstPrograms = stump.programs;
  await page.evaluate(() => {
    const t = treeShot.target, candidates = [];
    game.world.treesNear(t.x, t.z, 100, (x, z, r, h, b, id) => candidates.push(id));
    for (const id of candidates.slice(0, 20)) game.world.breakTree(id, { dx: 1, dz: 1 });
  });
  await wait(250); const burst = await shot('many-trees'); assert(burst.tops <= 12);
  assert.equal(burst.programs, stump.programs, 'subsequent breaks do not compile programs');
  await page.evaluate(() => game.world.treeBreaks.update(Infinity)); await wait(150);
  assert.equal((await shot('regrown')).broken, false);
  report.frames = await page.evaluate(() => {
    const frames = treeShot.frames.sort((a, b) => a - b);
    game.vehicles.current.step = treeShot.step; treeShot.off();
    return { median: frames[Math.floor(frames.length / 2)], p95: frames[Math.floor(frames.length * .95)], worst: frames.at(-1) };
  });
  assert.deepEqual(errors, []);
} finally {
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(`PASS: evidence in ${out}; PNGs still require visual review.`);
