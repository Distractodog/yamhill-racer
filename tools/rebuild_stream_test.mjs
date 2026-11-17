// Director check after a rebuild: traverse the full playable diameter at 1000 km/h.
// Needs the game server at 127.0.0.1:8173; run through the heavy gate.
// node tools/rebuild_stream_test.mjs [report.json] [kmh]
import fs from 'node:fs';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const output = process.argv[2], kmh = Number(process.argv[3] || 1000);
assert(Number.isFinite(kmh) && kmh > 0);
const errors = [];
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  protocolTimeout: 900000,
  headless: 'new', args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => {
    if (r.status() >= 400 && r.url().includes('/assets/')) errors.push(`${r.status()} ${r.url()}`);
  });
  page.on('requestfailed', r => {
    if (r.url().includes('/assets/')) errors.push(`${r.failure()?.errorText} ${r.url()}`);
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('yr-welcome-hidden-1', '1');
    Object.defineProperty(navigator, 'getGamepads', { value: () => [] });
  });
  await page.goto('http://127.0.0.1:8173/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.game?.sessionSpawn);
  if (await page.evaluate(() => game.sessionSpawn.blocked)) {
    await page.waitForSelector('#fullmap.open canvas', { visible: true });
    const box = await (await page.$('#fullmap canvas')).boundingBox();
    assert(box, 'visible spawn map');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => !game.sessionSpawn.blocked);
  }
  const route = await page.evaluate(async kmh => {
    const manifest = await (await fetch('assets/world.json')).json(), rim = manifest.rim;
    if (!rim || manifest.tiles.length !== 468) throw new Error('expected rebuilt 468-tile round world');
    const g = game, c = g.car;
    g.challenges.quit(); g.minimap.toggle(false); g.respawnHold.cancel();
    const s = window.rebuildStream = { x: rim.cx - rim.r + 200, end: rim.cx + rim.r - 200,
      z: rim.cz, speed: kmh / 3.6, running: false, originalStep: c.step };
    c.step = function(dt) {
      if (s.running) s.x = Math.min(s.end, s.x + s.speed * dt);
      this._lastLoaded = null;
      this.pos.set(s.x, g.world.heightAt(s.x, s.z) + 4, s.z);
      this.vel.set(s.running ? s.speed : 0, 0, 0);
      this.yaw = Math.PI / 2; this.quat.set(0, Math.SQRT1_2, 0, Math.SQRT1_2);
    };
    c.step(0); c.savePrev(); g.camera.position.copy(c.pos);
    return { start: s.x, end: s.end, z: s.z, kmh, tiles: manifest.tiles.length };
  }, kmh);
  await page.waitForFunction(() => game.world.loadedAt(rebuildStream.x, rebuildStream.z) && game.world.pendingTiles() === 0);
  const stats = await page.evaluate(() => new Promise((resolve, reject) => {
    const g = game, s = rebuildStream, intervals = [], missing = [];
    const began = performance.now(); let last = began, frames = 0;
    s.running = true;
    function tick(now) {
      intervals.push(now - last); last = now; frames++;
      if (!g.world.loadedAt(s.x, s.z)) missing.push([s.x, s.z]);
      if (s.x >= s.end) {
        s.running = false; g.car.step = s.originalStep;
        intervals.sort((a, b) => a - b);
        resolve({ frames, seconds: (now - began) / 1000, missingFrames: missing.length,
          firstMissing: missing.slice(0, 10), medianMs: intervals[frames >> 1],
          p95Ms: intervals[Math.floor(frames * .95)], worstMs: intervals.at(-1),
          slowPercent: 100 * intervals.filter(ms => ms > 33.3).length / frames });
      } else if (now - began > 600000) reject(new Error('full-map traversal timed out'));
      else requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }));
  const report = { route, ...stats, errors };
  console.log(JSON.stringify(report, null, 2));
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  assert.equal(errors.length, 0, 'page/asset errors');
  assert.equal(stats.missingFrames, 0, 'frames without loaded ground');
} finally {
  await browser.close();
}
