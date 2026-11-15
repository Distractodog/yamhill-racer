// Director check: existing game server + relay required. Run through the heavy-check gate.
// Two isolated browser identities exercise real main-loop collisions, world settings and reset propagation.
// Usage: node tools/mp_collide_test_browser.mjs [output-directory]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';
import { startGame, watchErrors } from './lib/startgame.mjs';

const url = process.env.YR_URL || 'http://127.0.0.1:8173/';
const relay = process.env.YR_MP_RELAY || 'ws://127.0.0.1:8787';
const out = process.argv[2] || path.join(os.tmpdir(), 'yr-mp-collide');
await fs.mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const errors = [], report = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    watchErrors(page, i ? 'guest' : 'host', errors);
    page.on('console', m => { if (m.type() === 'error' && !m.location().url?.endsWith('/favicon.ico')) errors.push(m.text()); });
    await startGame(page, { url, relay });
    await page.waitForFunction(() => window.game?.multiplayer?.collisions, { timeout: 120000 });
    pages.push(page);
  }
  const [host, guest] = pages;
  const code = await host.evaluate(async () => { await game.multiplayer.mp.host(); return game.multiplayer.mp.me.code; });
  await guest.evaluate(code => game.multiplayer.mp.join(code), code);
  await Promise.all(pages.map(p => p.waitForFunction(() => game.multiplayer.mp.players.size === 2)));
  const base = await host.evaluate(() => ({ x: game.car.pos.x, z: game.car.pos.z, y: game.world.heightAt(game.car.pos.x, game.car.pos.z) }));
  // A flat, obstacle-free physics fixture isolates player impacts; the real renderer, input, net and remotes remain live.
  await Promise.all(pages.map(p => p.evaluate(base => {
    game.settings?.close?.(); game.challenges.quit();
    game.car.world = { heightAt: () => base.y, terrainAt: () => base.y, groundAt: () => base.y, surfaceAt: () => 3,
      normalAt: (_x, _z, n) => n.set(0, 1, 0), waterLevelAt: () => -Infinity,
      treesNear() {}, buildingsNear: () => [], loadedAt: () => true, rampAt: () => null,
      extent: [-100000, -100000, 100000, 100000] };
    window.collisionStates = new Map();
    game.multiplayer.mp.on('state', m => collisionStates.set(m.from, m));
    window.collisionSamples = []; window.recordCollision = false;
    let last;
    function record(t) {
      const v = game.car;
      if (recordCollision) collisionSamples.push({ ms: t - (last ?? t), x: v.pos.x, y: v.pos.y, z: v.pos.z,
        vz: v.vel.z, up: 1 - 2 * (v.quat.x ** 2 + v.quat.z ** 2), hits: game.multiplayer.collisions.stats.hits });
      last = t; requestAnimationFrame(record);
    }
    requestAnimationFrame(record);
  }, base)));
  for (const bump of [false, true]) {
    await host.evaluate(() => game.multiplayer.menu.open());
    await host.select('#mp-bump', bump ? 'on' : 'off');
    await guest.waitForFunction(bump => game.multiplayer.menu.world.bump === bump, {}, bump);
    await host.screenshot({ path: path.join(out, `host-bump-${bump}.png`) });
    await host.click('#mp-close');
    await guest.evaluate(() => game.multiplayer.menu.open());
    assert(await guest.$eval('#mp-world', el => el.inert), 'guest settings read-only');
    await guest.screenshot({ path: path.join(out, `guest-bump-${bump}.png`) });
    await guest.click('#mp-close');
    for (const kmh of [60, 150, 300]) {
      await Promise.all(pages.map((p, i) => p.evaluate(({ base, i }) => {
        game.keys.clear(); game.car.reset(base.x, base.z + (i ? -12 : 12), 0);
        game.car.safe = [[base.x, base.z + (i ? -12 : 12), 0]];
        game.multiplayer.collisions.stats.hits = 0; collisionSamples = [];
      }, { base, i })));
      await sleep(3400); // actual reset immunity must expire on both clients
      const startAt = await host.evaluate(() => game.multiplayer.mp.now() + 500);
      await Promise.all(pages.map((p, i) => p.evaluate(({ startAt, i, kmh }) => {
        setTimeout(() => { recordCollision = true; if (i) game.car.vel.z = kmh / 3.6; }, Math.max(0, startAt - game.multiplayer.mp.now()));
      }, { startAt, i, kmh })));
      await sleep(3500);
      const samples = await Promise.all(pages.map(p => p.evaluate(() => { recordCollision = false; return collisionSamples; })));
      for (const list of samples) {
        assert(list.length > 20, 'browser made progress');
        assert(list.every(s => Object.values(s).every(Number.isFinite) && s.up > 0 && s.y < base.y + 3), 'finite, upright, no launch');
      }
      const h = samples[0].at(-1), g = samples[1].at(-1);
      if (bump) { assert(h.hits > 0 && g.hits > 0, 'both computers resolve their own bump'); assert(g.z < h.z, 'guest cannot pass through host'); }
      else { assert.equal(h.hits + g.hits, 0); assert(g.z > h.z + 4, 'bumping off allows pass-through'); }
      const frame = samples.flat().map(s => s.ms).sort((a, b) => a - b);
      report.push({ bump, kmh, host: h, guest: g, medianMs: frame[Math.floor(frame.length / 2)], p95Ms: frame[Math.floor(frame.length * 0.95)], slowPercent: frame.filter(t => t > 20).length / frame.length * 100 });
      await guest.screenshot({ path: path.join(out, `impact-${bump}-${kmh}.png`) });
    }
  }
  await guest.keyboard.press('r');
  await guest.waitForFunction(() => game.car.ghostUntil > game.multiplayer.mp.now() + 2000);
  await host.waitForFunction(() => [...collisionStates.values()].some(s => s.ghostUntil > game.multiplayer.mp.now() + 1500));
  assert.deepEqual(errors.filter(e => !e.includes('favicon.ico')), []);
  console.log(JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ report, errors }, null, 2));
  console.log('PASS two-page impacts, off/pass-through, host UI, guest read-only, R ghost propagation; review screenshots and frame times');
} finally { await browser.close(); }
