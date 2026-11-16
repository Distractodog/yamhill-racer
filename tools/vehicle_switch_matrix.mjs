// Browser matrix; existing game server + local multiplayer relay required. Run through the heavy gate.
// YR_URL / YR_MP_RELAY override tools/lib/startgame.mjs defaults. No servers are started here.
import puppeteer from 'puppeteer-core';
import { startGame, holdCar, watchErrors, openMenu, CAMPUS, RELAY_URL } from './lib/startgame.mjs';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--window-size=1280,800', '--enable-gpu', '--use-angle=metal'] });
const rows = [], errors = [], types = ['fighter', 'stealth', 'prop', 'stunt', 'heli'];
const wait = ms => new Promise(r => setTimeout(r, ms));
async function fresh(type = 'fighter', name = 'Matrix') {
  const context = await browser.createBrowserContext(), page = await context.newPage();
  await page.setViewport({ width: 1280, height: 800 }); watchErrors(page, name, errors);
  await startGame(page, { relay: RELAY_URL, storage: {
    'yr-vtype-1': JSON.stringify({ jet: type }), 'yr-mp-name-1': name,
    'yr-cosmetics-1': JSON.stringify({ jet: { body: '#000000', custom: ['body'] } }),
  } });
  return page;
}
async function reset(page, from, type) {
  await page.evaluate(({ from, type }) => {
    window.__matrixRestore?.(); window.__matrixRestore = null;
    game.respawnHold.cancel(); game.challenges.quit(); game.settings?.close();
    game.garage.close(); game.vehicles.close(); game.keys.clear();
    game.vehicles.setType('jet', from === 'heli' ? 'heli' : type);
    game.vehicles.switchTo(from === 'heli' ? 'jet' : from);
  }, { from, type });
  await holdCar(page, CAMPUS);
}
async function choose(page, route, type) {
  if (route === 'garage') {
    await page.evaluate(() => game.garage.show());
    await page.waitForSelector('#cosmetic-garage:not([hidden])');
    await page.click('#cosmetic-garage [data-kind="jet"]');
    await page.select('#cosmetic-garage [name="vehicleType"]', type);
    await page.click('#cosmetic-garage .garage-done');
  } else {
    await page.keyboard.press('KeyV');
    await page.waitForSelector('#veh-menu', { visible: true, timeout: 2000 });
    if (route === 'key') await page.keyboard.press('Digit3');
    else if (route === 'chip') {
      await page.hover('#veh-menu .vp-card[data-kind="jet"]');
      await page.click(`#veh-menu .vp-chip[data-kind="jet"][data-type="${type}"]`);
    } else await page.click('#veh-menu .vp-card[data-kind="jet"]');
  }
}
async function run(page, state, from, route, type = 'fighter') {
  try {
    await reset(page, from, type);
    await page.evaluate(async state => {
      const g = game, v = g.vehicles.current;
      if (state === 'reset' || state === 'hold') {
        if (state === 'hold') {
          const loaded = g.world.loadedAt; g.world.loadedAt = () => false;
          window.__matrixRestore = () => { g.world.loadedAt = loaded; g.respawnHold.cancel(); };
        }
        v.safe = [[v.pos.x, v.pos.z, v.heading(), v.pos.y]]; v.resetToSafe();
        if (state === 'hold' && !g.respawnHold.blocked) throw Error('hold not active');
      }
      if (state === 'crash' || state === 'crash-reset') {
        g.vehicles.switchTo('jet'); const a = g.vehicles.current; a.grace = 0; a.crash('matrix');
        if (state === 'crash-reset') { a.safe = [[a.pos.x, a.pos.z, a.heading()]]; a.resetToSafe(); }
      }
      if (state === 'roof' || state === 'buildings') {
        const x = -510.5, z = 172, roof = v.world.roofUnder(x, z, 1e5);
        if (!Number.isFinite(roof)) throw Error('Gym roof unavailable');
        v.pos.set(x, state === 'roof' ? roof + 1 : g.world.terrainAt(x, z), z);
        v.reset(x, z, 0); v.savePrev();
      }
      if (state === 'water') {
        let spot;
        for (let x = -900; x < 900 && !spot; x += 8) for (let z = -900; z < 900; z += 8)
          if (g.world.waterLevelAt(x, z) - g.world.heightAt(x, z) > .5) { spot = [x, z]; break; }
        if (!spot) throw Error('no loaded campus water');
        v.reset(...spot, 0); v.savePrev();
      }
      if (['race', 'finished', 'quit'].includes(state)) {
        const i = g.challenges.list.findIndex(r => r.vehicle !== 'jet');
        await g.challenges.start(i);
        if (state === 'finished') g.challenges.dnf();
        if (state === 'quit') g.challenges.quit();
      }
    }, state);
    if (state === 'home' || state === 'home-loading') {
      if (state === 'home-loading') await page.evaluate(() => {
        const pending = game.world.pendingTiles; game.world.pendingTiles = () => 1;
        window.__matrixRestore = () => { game.world.pendingTiles = pending; };
      });
      await page.keyboard.press('KeyH');
      if (state === 'home') await page.waitForFunction(() => !game.sessionSpawn.blocked);
    }
    if (state === 'menu-open' || state === 'menu-closed') {
      await openMenu(page);
      if (state === 'menu-closed') await page.click('#menu-button');
    }
    await choose(page, route, from === 'heli' && route !== 'garage' ? 'heli' : type);
    await wait(100);
    const result = await page.evaluate(() => {
      const v = game.vehicles.current;
      return { kind: v.kind, type: game.vehicles.getType('jet'), mode: v.mode, held: game.respawnHold.blocked,
        race: game.challenges.state, finite: [...v.pos, ...v.vel, ...v.quat].every(Number.isFinite) };
    });
    const expected = from === 'heli' && route !== 'garage' ? 'heli' : type;
    rows.push({ state, from, route, saved: type, ...result, result: result.kind === 'jet' && result.type === expected && result.finite ? 'PASS' : 'FAIL' });
  } catch (e) { rows.push({ state, from, route, saved: type, result: 'FAIL', error: e.message }); }
  finally {
    await page.evaluate(() => { window.__matrixRestore?.(); window.__matrixRestore = null; });
    await page.waitForFunction(() => !game.sessionSpawn.blocked, { timeout: 35000 });
  }
}
try {
  // Saved types and paint are loaded before startup, in separate browser storage contexts.
  for (const type of types) {
    const page = await fresh(type);
    for (const from of ['car', 'bike', 'heli']) for (const route of ['key', 'click', 'chip', 'garage']) await run(page, 'saved-black', from, route, type);
    await page.browserContext().close();
  }
  const page = await fresh();
  for (const state of ['reset', 'crash', 'crash-reset', 'hold', 'home', 'home-loading', 'race', 'finished', 'quit', 'roof', 'water', 'buildings', 'menu-open', 'menu-closed'])
    for (const from of ['car', 'bike', 'heli']) for (const route of ['key', 'click', 'chip', 'garage']) {
      // Garage intentionally stays closed during spawn loading and races. V remains available.
      if (route === 'garage' && ['home-loading', 'race', 'finished'].includes(state)) continue;
      if (route === 'chip' && ['race', 'finished'].includes(state)) continue; // type chips stay locked in a race
      await run(page, state, from, route);
    }
  const guest = await fresh('fighter', 'Guest');
  const code = await page.evaluate(async () => { const { mp } = await import('./src/mp/net.js'); await mp.host(); return mp.roomCode; });
  await guest.evaluate(async code => { const { mp } = await import('./src/mp/net.js'); await mp.join(code); }, code);
  await guest.waitForFunction(() => document.getElementById('tuning-controls').inert);
  for (const [p, role] of [[page, 'host'], [guest, 'guest-host-settings']])
    for (const route of ['key', 'click', 'chip', 'garage']) await run(p, role, 'bike', route);
  // Small frame sample catches stalls without adding a benchmark run.
  const frames = await page.evaluate(() => new Promise(resolve => {
    const samples = []; let last;
    function frame(t) { if (last) samples.push(t - last); last = t;
      if (samples.length < 60) requestAnimationFrame(frame); else resolve({ medianMs: samples.sort((a,b)=>a-b)[30], slow: samples.filter(x=>x>25).length }); }
    requestAnimationFrame(frame);
  }));
  console.log('frame sample', frames);
} finally {
  console.table(rows); console.log('page errors:', errors);
  await browser.close();
  if (rows.some(r => r.result === 'FAIL') || errors.length) process.exitCode = 1;
}
