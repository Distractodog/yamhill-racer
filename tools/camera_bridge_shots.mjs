// Director: run against tools/serve.py 8173 game, under the heavy-check gate.
// node tools/camera_bridge_shots.mjs --out /tmp/yr-camera-bridge
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startGame, holdCar, watchErrors } from './lib/startgame.mjs';
import { bridgeFixture } from './camera_bridge_test.mjs';

const out = process.argv[process.argv.indexOf('--out') + 1];
if (!process.argv.includes('--out') || !out) throw Error('usage: node tools/camera_bridge_shots.mjs --out <dir>');
await fs.mkdir(out, { recursive: true });
const route = await bridgeFixture('BR-005', 3570, 2381);
const { x, z, dx, dz } = route, yaw = Math.atan2(dx, dz);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
});
const errors = [], report = [];
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
  watchErrors(page, 'camera bridges', errors);
  page.on('requestfailed', r => { if (!/cloudflareinsights/.test(r.url())) errors.push(`REQUEST FAILED ${r.url()}: ${r.failure()?.errorText}`); });
  page.on('response', r => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await startGame(page);
  await holdCar(page, { x: x - dx * 55, z: z - dz * 55, yaw, kind: 'car' });
  await page.evaluate(({ x, z, dx, dz }) => {
    const v = game.vehicles.current;
    game.setCam(0);
    v.pos.y = game.world.heightAt(v.pos.x, v.pos.z, -1e6) + .5;
    v.savePrev(); v.interpolate(0);
    window.bridgeEvidence = { frames: [], samples: [], last: performance.now(), running: true };
    const frame = now => {
      const e = window.bridgeEvidence; if (!e.running) return;
      e.frames.push(now - e.last); e.last = now;
      const p = game.camera.position, rp = v.renderPos;
      const low = game.world.heightAt(p.x, p.z, rp.y), high = game.world.heightAt(p.x, p.z);
      e.samples.push({ s: (v.pos.x-x)*dx+(v.pos.z-z)*dz, y: p.y, low, high });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    // Cruise with normal physics/keyboard input. No teleporting or overriding the camera during the pass.
    window.bridgeCruise = setInterval(() => {
      if (v.vel.length() < 9) game.keys.add('KeyW'); else game.keys.delete('KeyW');
    }, 50);
  }, { x, z, dx, dz });
  for (const [name, s] of [['approaching', -25], ['under', 4], ['leaving', 30]]) {
    await page.waitForFunction(({ x, z, dx, dz, s }) => {
      const v = game.vehicles.current;
      return (v.pos.x-x)*dx+(v.pos.z-z)*dz >= s;
    }, { timeout: 30000, polling: 'raf' }, { x, z, dx, dz, s });
    const evidence = await page.evaluate(() => {
      const e = window.bridgeEvidence, a = e.frames.splice(0).sort((a,b)=>a-b);
      return { ...e.samples.at(-1), medianMs: a[Math.floor(a.length*.5)], p95Ms: a[Math.floor(a.length*.95)],
        slowPercent: 100*a.filter(ms=>ms>20).length/a.length };
    });
    if (name === 'under') assert(evidence.high > evidence.low + 3 && evidence.y <= evidence.high - 1.7 + .01, 'under shot must show the camera beneath the deck');
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    report.push({ phase: name, ...evidence });
  }
  const samples = await page.evaluate(() => {
    window.bridgeEvidence.running = false; clearInterval(window.bridgeCruise); game.keys.clear();
    game.vehicles.current.vel.set(0,0,0); return window.bridgeEvidence.samples;
  });
  await fs.writeFile(path.join(out, 'camera-bridge.json'), JSON.stringify({ report, samples, errors }, null, 2));
  console.table(report);
  assert.equal(errors.length, 0, errors.join('\n'));
} finally { await browser.close(); }
