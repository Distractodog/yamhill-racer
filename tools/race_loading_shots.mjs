// Director: serve game/ at http://127.0.0.1:8173 (or YR_URL), then run through the heavy gate:
// node tools/race_loading_shots.mjs --out /tmp/yr-race-loading
// Review loading.png and countdown.png. report.json includes per-frame readiness and missing ground at GO.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import { startGame, watchErrors } from './lib/startgame.mjs';
const { values } = parseArgs({ options: { out: { type: 'string', default: '/tmp/yr-race-loading' } } });
const out = values.out;
await mkdir(out, { recursive: true });
const errors = [];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  watchErrors(page, 'race loading', errors);
  await startGame(page);
  const race = await page.evaluate(() => {
    const g = game;
    const candidates = g.challenges.list.map((r,i) => ({ i, r, distance: Math.hypot(r.start.x-g.car.pos.x, r.start.z-g.car.pos.z) })).filter(c => (c.r.vehicle || 'car') === 'car');
    candidates.sort((a,b) => b.distance-a.distance);
    const chosen = candidates[0];
    window.raceLoadFrames = [];
    let doneAt = null;
    function frame(at) {
      const state = g.challenges.state, root = document.getElementById('race-loading');
      if (state === 'running' && doneAt === null) doneAt = at;
      raceLoadFrames.push({ at, state, blocked: g.challenges.blocked, progress: root?.querySelector('progress').value,
        overlay: root && !root.hidden, status: root?.querySelector('.rl-status').textContent,
        ground: g.world.loadedAt(g.car.pos.x, g.car.pos.z), readiness: g.world.raceLoadProgress(), pending: g.world.pendingTiles() });
      if (doneAt === null || at - doneAt < 500) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    g.challenges.openMenu(chosen.i, { filter: 'all' });
    return { id: chosen.r.id, name: chosen.r.name, distance: chosen.distance };
  });
  await page.click('#ch-menu .rm-start');
  await page.waitForSelector('#race-loading:not([hidden])', { visible: true });
  await page.screenshot({ path: `${out}/loading.png` });
  await page.waitForFunction(() => game.challenges.state === 'countdown', { timeout: 40000 });
  await page.screenshot({ path: `${out}/countdown.png` });
  await page.waitForFunction(() => game.challenges.state === 'running', { timeout: 10000 });
  await new Promise(resolve => setTimeout(resolve, 600));
  const frames = await page.evaluate(() => raceLoadFrames);
  await writeFile(`${out}/report.json`, JSON.stringify({ race, frames, errors }, null, 2));
  const loading = frames.filter(f => f.state === 'placing');
  assert(loading.length > 0 && loading.every(f => f.blocked && f.overlay), 'loading screen holds physics');
  assert(loading.some(f => f.progress > 0), 'real progress displayed');
  assert(frames.some(f => f.state === 'countdown' && !f.overlay), 'countdown follows overlay');
  const go = frames.filter(f => f.state === 'running');
  assert(go.length > 0 && go.every(f => f.ground), 'no frames with missing ground at GO');
  assert(!loading.some(f => /Taking longer/.test(f.status)), 'normal far race does not time out');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS far race loading → countdown → GO:', race, `${loading.length} loading frames; ${go.length} GO frames; no missing ground; screenshots in ${out}`);
} finally { await browser.close(); }
