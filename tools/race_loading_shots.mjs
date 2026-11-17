// Director: serve game/ at http://127.0.0.1:8173 (or YR_URL), then run through the heavy gate:
// node tools/race_loading_shots.mjs --out /tmp/yr-race-loading
// Fresh browser contexts, DPR 2, campus → three far races via J, plus Esc/button cancellation.
// Review the PNGs. report.json records every frame, including failures, for before/after diagnosis.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import { startGame, watchErrors } from './lib/startgame.mjs';
const { values } = parseArgs({ options: { out: { type: 'string', default: '/tmp/yr-race-loading' } } });
const out = values.out;
await mkdir(out, { recursive: true });
const errors = [], reports = [];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
try {
  for (const scenario of [
    { id: 'mcminnville-downtown' }, { id: 'hwy18-top-speed' }, { id: 'sheridan-river-loop', busyMap: true },
    { id: 'mcminnville-downtown', cancel: 'Escape' }, { id: 'mcminnville-downtown', cancel: 'button' },
  ]) {
    const name = `${scenario.id}${scenario.cancel ? `-cancel-${scenario.cancel}` : ''}`;
    const context = await browser.createBrowserContext(); // no saved settings/cache from the preceding race
    const page = await context.newPage(), report = { ...scenario, name };
    reports.push(report);
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    watchErrors(page, name, errors);
    page.on('response', r => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`${name}: HTTP ${r.status()} ${r.url()}`); });
    try {
      await startGame(page);
      const race = report.race = await page.evaluate(id => {
        const g = game, i = g.challenges.list.findIndex(r => r.id === id), r = g.challenges.list[i];
        if (!r) throw Error(`Missing race ${id}`);
        window.raceLoadFrames = [];
        window.stopRaceFrames = false;
        // Observe actual calls, rather than inferring a pause from UI state. Works on pre-fix code too.
        let builds = 0, renders = 0, extraMs = 0;
        const update = g.world.updateLOD, render = g.renderer.render;
        g.world.updateLOD = (...args) => { builds++; extraMs = args[2] || 0; return update(...args); };
        g.renderer.render = (...args) => { renders++; return render.apply(g.renderer, args); };
        function frame(at) {
          const root = document.getElementById('race-loading'), hold = g.respawnHold.holding;
          raceLoadFrames.push({ at, state: g.challenges.state, blocked: g.challenges.blocked,
            progress: root?.querySelector('progress').value, overlay: root && !root.hidden,
            status: root?.querySelector('.rl-status').textContent, readiness: g.challenges.loadingStatus,
            ground: g.world.loadedAt(g.car.pos.x, g.car.pos.z), courseGround: g.world.raceLoadProgress(), pending: g.world.pendingTiles(),
            budget: g.world.buildStatus?.budget, extraMs, buildPaused: builds === 0, renderPaused: renders === 0,
            mapOpen: g.minimap.open, mapBusy: g.minimap.busy, menuOpen: g.challenges.menuOpen, spawnBlocked: g.sessionSpawn.blocked,
            hold: hold && { x: hold.x, z: hold.z, t: hold.t }, x: g.car.pos.x, z: g.car.pos.z, speed: g.car.vel.length() });
          builds = renders = 0;
          if (!window.stopRaceFrames) requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
        return { i, id, name: r.name, departure: { x: g.car.pos.x, z: g.car.pos.z }, distance: Math.hypot(r.start.x-g.car.pos.x, r.start.z-g.car.pos.z) };
      }, scenario.id);
      assert(race.distance > 3000, 'each race starts far from campus');
      const delayed = [];
      let holdTiles = !!scenario.cancel;
      if (scenario.cancel) {
        // Keep cancellation deterministic even when the far course would otherwise finish before the screenshot.
        await page.setRequestInterception(true);
        page.on('request', request => {
          if (holdTiles && request.url().includes('/assets/tiles/')) delayed.push(request);
          else request.continue().catch(() => {});
        });
      }
      await page.keyboard.press('KeyJ');
      await page.click(`#ch-menu .rm-card[data-i="${race.i}"]`);
      await page.click('#ch-menu .rm-start');
      await page.waitForSelector('#race-loading:not([hidden])', { visible: true });
      if (scenario.cancel) {
        await page.waitForFunction(() => game.challenges.state === 'placing' && !game.world.loadedAt(game.car.pos.x, game.car.pos.z), { timeout: 5000 });
        await page.screenshot({ path: `${out}/${name}-loading.png` });
        if (scenario.cancel === 'Escape') await page.keyboard.press('Escape');
        else await page.click('#race-loading .rl-cancel');
        await page.waitForFunction(() => game.challenges.state === 'idle' && !game.respawnHold.blocked);
        holdTiles = false; report.delayedTiles = delayed.length;
        await Promise.all(delayed.map(request => request.continue()));
        const returned = await page.evaluate(() => ({ x: game.car.pos.x, z: game.car.pos.z, ground: game.world.loadedAt(game.car.pos.x, game.car.pos.z) }));
        assert(returned.ground && Math.hypot(returned.x-race.departure.x, returned.z-race.departure.z) < 5, 'cancel restores loaded departure');
        await page.keyboard.down('KeyW');
        await page.waitForFunction(p => Math.hypot(game.car.pos.x-p.x, game.car.pos.z-p.z) > 5 && game.car.vel.length() > 2, { timeout: 5000 }, returned);
        await page.keyboard.up('KeyW');
        await page.screenshot({ path: `${out}/${name}-driving.png` });
      } else {
        if (scenario.busyMap) await page.evaluate(() => {
          // Even a stale gesture hidden behind loading must not starve the builder or scene rendering.
          game.minimap.toggle(true);
          Object.defineProperty(game.minimap, 'busy', { configurable: true, get: () => true });
        });
        await page.screenshot({ path: `${out}/${name}-loading.png` });
        await page.waitForFunction(() => game.challenges.state === 'countdown', { timeout: 25000 });
        if (scenario.busyMap) await page.evaluate(() => {
          Object.defineProperty(game.minimap, 'busy', { configurable: true, get: () => false });
          game.minimap.toggle(false);
        });
        await page.screenshot({ path: `${out}/${name}-countdown.png` });
        await page.waitForFunction(() => game.challenges.state === 'running', { timeout: 10000 });
        await new Promise(resolve => setTimeout(resolve, 600));
      }
    } catch (error) {
      report.failure = error.message;
      throw error;
    } finally {
      report.frames = await page.evaluate(() => { window.stopRaceFrames = true; return window.raceLoadFrames || []; }).catch(() => []);
      await writeFile(`${out}/report.json`, JSON.stringify({ reports, errors }, null, 2));
      await context.close();
    }
    const race = report.race, frames = report.frames, loading = frames.filter(f => f.state === 'placing');
    assert(loading.length > 0 && loading.every(f => f.blocked && f.overlay), `${name}: loading holds physics`);
    assert(loading.slice(1).every(f => !f.buildPaused && !f.renderPaused && f.extraMs >= 8), `${name}: loading builds/renders every frame at full budget`);
    if (scenario.cancel) {
      const idle = frames.filter(f => f.state === 'idle' && !f.overlay && Math.hypot(f.x-race.departure.x, f.z-race.departure.z) < 100);
      assert(idle.some(f => f.speed > 2) && idle.every(f => f.ground && !f.hold), `${name}: can drive on loaded ground after cancel`);
    } else {
      assert(loading.some(f => f.progress > 0), `${name}: real progress displayed`);
      assert(frames.some(f => f.state === 'countdown' && !f.overlay), `${name}: countdown follows overlay`);
      const go = frames.filter(f => f.state === 'running');
      assert(go.length > 0 && go.every(f => f.ground && !f.hold), `${name}: no missing ground/hold at GO`);
      assert(!loading.some(f => f.readiness?.timedOut || /Taking longer/.test(f.status)), `${name}: normal far race does not time out`);
    }
    console.log(`PASS ${name}: ${loading.length} loading frames; DPR 2; screenshots in ${out}`);
  }
  assert.equal(errors.length, 0, errors.join('\n'));
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify({ reports, errors }, null, 2));
  await browser.close();
}
