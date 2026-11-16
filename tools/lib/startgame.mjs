// Shared start-up for browser scripts (puppeteer pages): open the game, get past the spawn map like a player
// (click campus), wait for the tiles, and optionally hold the car at a point the way H / goHome() does.
// Start-up from tools/river_shots.mjs; the click point from tools/spawn_test.mjs; holding from spawn.js move().
//   import { GAME_URL, RELAY_URL, startGame, holdCar, watchErrors } from './lib/startgame.mjs';
//   const errors = []; watchErrors(page, 'host', errors);
//   await startGame(page, { relay: RELAY_URL, storage: { 'yr-mp-name-1': 'Host' }, hold: { x: -542, z: 440 } });
//   ... if (errors.length) fail.
export const GAME_URL = process.env.YR_URL || 'http://127.0.0.1:8173/';
export const RELAY_URL = process.env.YR_MP_RELAY || 'ws://127.0.0.1:8787';
export const CAMPUS = { x: -542, z: 440 };

// page errors go into `errors` (the script fails on any) and are printed as they happen
export function watchErrors(page, label, errors) {
  page.on('pageerror', e => { errors.push(`${label}: ${e.message}`); console.log(`PAGE ERROR (${label})`, e.message); });
  return errors;
}

// options: url (default YR_URL), relay (sets window.YR_MP_RELAY), storage (extra localStorage entries, set before
// the game loads), spawn ({x, z} clicked on the spawn map, default campus), hold ({x, z, yaw, kind} or null), timeout
export async function startGame(page, { url = GAME_URL, relay = null, storage = {}, spawn = CAMPUS, hold = null, timeout = 120000 } = {}) {
  await page.evaluateOnNewDocument((relay, storage) => {
    if (relay) window.YR_MP_RELAY = relay;
    try { localStorage.setItem('yr-welcome-hidden-1', '1'); for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v); } catch {}
    try { Object.defineProperty(navigator, 'getGamepads', { value: () => [] }); } catch {}
  }, relay, storage);
  await page.goto(url, { waitUntil: 'load', timeout });
  await page.waitForFunction(() => window.game?.sessionSpawn, { timeout });
  if (await page.evaluate(() => game.sessionSpawn.blocked)) {      // "Where do you want to start?": click the spawn point
    await page.waitForSelector('#fullmap.open canvas', { visible: true, timeout: 30000 });
    const at = await page.evaluate(async (x, z) => {               // world → screen on the full map (it opens at zoom 1)
      const m = await fetch('./assets/minimap.json').then(r => r.json()), im = new Image();
      im.src = './assets/minimap.jpg'; await im.decode();
      const r = document.querySelector('#fullmap canvas').getBoundingClientRect(), s = Math.min(r.width / im.width, r.height / im.height);
      return [r.left + r.width / 2 + ((x - m.extent[0]) / m.mpp - im.width / 2) * s, r.top + r.height / 2 + ((z - m.extent[1]) / m.mpp - im.height / 2) * s];
    }, spawn.x, spawn.z);
    await page.mouse.click(...at);
    await page.waitForFunction(() => !game.sessionSpawn.blocked, { timeout });
  }
  await page.evaluate(() => {
    document.getElementById('welcome-start')?.click();
    game.garage?.close(); game.minimap.toggle(false);
  });
  await page.waitForFunction(() => { const c = game.vehicles.current; return game.world.loadedAt(c.pos.x, c.pos.z) && game.world.pendingTiles() === 0; }, { timeout });
  if (hold) await holdCar(page, hold, timeout);
  return page;
}

// goHome() / spawn.js move(): steer the streaming focus to (x, z) with physics still, wait until the ground there is
// loaded, then reset the vehicle onto it (facing yaw). kind switches vehicle first ('car' | 'bike' | 'jet').
export function holdCar(page, { x, z, yaw = 0, kind = null }, timeout = 120000) {
  return page.evaluate(async (x, z, yaw, kind, timeout) => {
    const g = game; if (kind) g.vehicles.switchTo(kind);
    const car = g.vehicles.current, sleep = ms => new Promise(r => setTimeout(r, ms)), deadline = performance.now() + timeout;
    g.keys.clear();
    const hold = () => { car.pos.set(x, car.pos.y, z); car.vel.set(0, 0, 0); car._lastLoaded = null; car.savePrev(); car.interpolate(0); };
    hold();
    while (!g.world.loadedAt(x, z) || g.world.pendingTiles() > 0) {
      if (performance.now() > deadline) throw Error(`ground at (${x}, ${z}) did not load: pending ${g.world.pendingTiles()}`);
      await sleep(100); hold();
    }
    car.reset(x, z, yaw); car.vel.set(0, 0, 0); car.safe = []; car._lastLoaded = null;
  }, x, z, yaw, kind, timeout);
}

// Open the options disclosure before clicking one of its existing item buttons.
export async function openMenu(page) {
  await page.waitForSelector('#menu-button:not(:disabled)', { visible: true });
  if (await page.$eval('#menu-panel', panel => panel.hidden)) await page.click('#menu-button');
  await page.waitForSelector('#menu-panel', { visible: true });
}
