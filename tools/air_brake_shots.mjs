// Director-run browser evidence (requires the game at http://127.0.0.1:8173).
// node tools/air_brake_shots.mjs --out /tmp/yr-air-brakes [--url http://127.0.0.1:8173/]
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : '/tmp/yr-air-brakes';
const url = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://127.0.0.1:8173/';
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const errors = [], shots = [];
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
    document.getElementById('welcome-start')?.click(); game.garage?.close();
    game.challenges.quit(); game.minimap.toggle(false);
  });
  await page.waitForFunction(() => game.world.pendingTiles() === 0, { timeout: 120000 });
  // Keep the test flight on a loaded patch so the screenshots isolate moving panels and HUD.
  for (const type of ['fighter', 'stealth', 'prop', 'stunt']) {
    await page.evaluate(type => {
      game.vehicles.choose('jet', type); game.setCam(0);
      const j = game.vehicles.current, x = j.pos.x, z = j.pos.z;
      j.placeInAir(j.pos.x, game.world.heightAt(j.pos.x, j.pos.z) + 500, j.pos.z, 0, type === 'prop' ? 220 : type === 'stunt' ? 300 : 1000);
      j.throttle = 0;
      const original = j.step;
      j.step = function(dt, input) {
        original.call(this, dt, input);
        this.pos.x = x; this.pos.z = z; // hold the loaded patch; retain real air-brake physics
      };
      window.brakeShotOriginal = original;
    }, type);
    for (const deployed of [false, true]) {
      if (deployed) await page.keyboard.down('Space');
      await new Promise(resolve => setTimeout(resolve, 650));
      const frames = await page.evaluate(() => new Promise(resolve => {
        const intervals = []; let previous;
        function sample(now) {
          if (previous !== undefined) intervals.push(now - previous);
          previous = now;
          if (intervals.length < 60) requestAnimationFrame(sample); else resolve(intervals);
        }
        requestAnimationFrame(sample);
      }));
      frames.sort((a, b) => a - b);
      const state = await page.evaluate(() => {
        const j = game.vehicles.current, panels = [];
        j.mesh.traverse(o => { if (o.name === 'speed-brake') panels.push([o.rotation.x, o.rotation.z]); });
        return { mode: j.mode, amount: j.speedBrake, hud: j.hudInfo(), panels, kmh: j.vel.length() * 3.6,
          calls: game.renderer.info.render.calls, triangles: game.renderer.info.render.triangles };
      });
      assert.equal(state.mode, 'air');
      if (deployed) { assert(state.hud.includes('AIR BRAKE')); assert(state.amount > .95); }
      const file = `${type}-${deployed ? 'open' : 'closed'}.png`;
      await page.screenshot({ path: join(out, file) }); shots.push({ file, state, frames: { median: frames[30], p95: frames[57], worst: frames[59] } });
    }
    await page.keyboard.up('Space');
    await page.evaluate(() => { game.vehicles.current.step = window.brakeShotOriginal; });
  }
  assert.deepEqual(errors, []);
} finally {
  await writeFile(join(out, 'report.json'), JSON.stringify({ errors, shots, visualReview: 'NOT REVIEWED' }, null, 2));
  await browser.close();
}
console.log(`Saved ${shots.length} screenshots in ${out}; inspect each PNG.`);
