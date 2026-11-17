// Director: start the game server (YR_URL, default 8173) and server/local.mjs (YR_MP_RELAY, default 8787).
// Run through the heavy-check gate: node tools/mp_menu_test.mjs [screenshot directory]
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { RELAY_URL, startGame, watchErrors, openMenu } from './lib/startgame.mjs';
const out = process.argv[2];
if (out) await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const errors = [];
try {
  const contexts = await Promise.all([browser.createBrowserContext(), browser.createBrowserContext()]);
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  const [host, guest] = pages;
  await Promise.all(pages.map(async (page, i) => {
    watchErrors(page, i ? 'guest' : 'host', errors);
    await page.setViewport({ width: 1280, height: 800 });
    // past the spawn map (it covers the menu bar) and the welcome card, tiles loaded
    await startGame(page, { relay: RELAY_URL, storage: { 'yr-mp-name-1': i ? 'Guest' : 'Host' } });
    await page.waitForFunction(() => window.game?.multiplayer);
  }));
  const saved = page => page.evaluate(() => Object.fromEntries(['yr-tuning-2', 'yr-tuning-bike-1', 'yr-tuning-jet-1', 'yr-atmo-2'].map(key => [key, localStorage.getItem(key)])));
  const current = page => page.evaluate(() => ({ tuning: structuredClone(game.multiplayer.tuning), atmosphere: game.atmosphere.preset }));
  await host.evaluate(() => { game.tuning.accel = 51; game.multiplayer.tuning.bike.accel = 33; game.multiplayer.tuning.jet.thrust = 30; game.atmosphere.setPreset('night', false); });
  await guest.evaluate(() => { game.tuning.accel = 21; game.atmosphere.setPreset('golden', false); });
  const own = await current(guest), guestSaved = await saved(guest);
  await openMenu(host); await host.click('#mp-button'); await host.click('#mp-host');
  await host.waitForFunction(() => game.multiplayer.mp.inGame);
  assert.equal(await host.$eval('#menu-button', el => el.textContent), 'Menu · MP');
  const room = await host.evaluate(() => game.multiplayer.mp.roomCode);
  await openMenu(guest); await guest.click('#mp-button');
  await guest.waitForSelector(`#mp-games button[data-game="${room}"]`);
  assert.equal(await guest.$('#mp-join-code'), null, 'no codes in the menu');
  await guest.click('#mp-name', { clickCount: 3 }); await guest.type('#mp-name', 'Guest');
  assert.equal(await guest.evaluate(() => game.keys.size), 0, 'typing in the menu does not drive');
  const ask = async (action = 'accept') => {
    await guest.waitForSelector(`#mp-games button[data-game="${room}"]:not([disabled])`);
    await guest.click(`#mp-games button[data-game="${room}"]`);
    await host.waitForSelector('#mp-requests:not([hidden]) button[data-action="accept"]');
    assert.equal(await guest.evaluate(() => game.multiplayer.mp.inGame), false);
    if (out) { await host.screenshot({ path: out + '/mp-join-request.png' }); await guest.screenshot({ path: out + '/mp-open-games.png' }); }
    await host.click(`#mp-requests button[data-action="${action}"]`);
  };
  await ask('decline');
  await guest.waitForFunction(() => document.querySelector('#mp-status').textContent === 'Host declined');
  await ask();
  await guest.waitForFunction(() => game.multiplayer.mp.inGame && game.tuning.accel === 51);
  assert.deepEqual(await current(guest), await current(host)); assert.deepEqual(await saved(guest), guestSaved);
  // the guest sees the host's current world setting checked, and can't change it
  const checked = page => page.$eval('#mp-panel', p => [...p.querySelectorAll('[name="mp-mode"]')].filter(el => el.checked).map(el => el.value));
  assert.equal(await guest.$eval('#mp-world', el => el.inert), true);
  assert.deepEqual(await checked(guest), ['host']); assert.deepEqual(await checked(host), ['host']);
  assert.equal(await guest.$eval('#tuning-controls', el => el.inert), true);
  await host.click('[name="mp-mode"][value="own"]');
  await guest.waitForFunction(() => !document.getElementById('tuning-controls').inert);
  assert.deepEqual(await current(guest), own);
  assert.deepEqual(await checked(guest), ['own'], 'guest radio follows the host to own');
  if (out) await guest.screenshot({ path: out + '/mp-guest-own.png' });
  const radio = await (await guest.$('[name="mp-mode"][value="host"]')).boundingBox();   // a guest's real click changes nothing
  await guest.mouse.click(radio.x + radio.width / 2, radio.y + radio.height / 2);
  assert.deepEqual(await checked(guest), ['own']); assert.deepEqual(await checked(host), ['own']);
  await host.click('[name="mp-mode"][value="host"]');
  await guest.waitForFunction(() => game.tuning.accel === 51);
  assert.deepEqual(await checked(guest), ['host'], 'guest radio follows the host back to host');
  await host.evaluate(() => { game.tuning.accel = 54; game.atmosphere.setPreset('rain', false); });
  await guest.waitForFunction(() => game.tuning.accel === 54 && game.atmosphere.preset === 'rain');
  // day/night cycle: the guest follows the host's clock and weather (a jump is sent at once)
  await host.evaluate(() => { game.atmosphere.set({ cycle: true, weather: 'rain' }, false); game.atmosphere.jump('night'); });
  await guest.waitForFunction(() => game.atmosphere.settings.cycle && game.atmosphere.phase === 'night' && game.atmosphere.rain === 1 && game.atmosphere.following);
  const clocks = await Promise.all([host, guest].map(p => p.evaluate(() => game.atmosphere.time)));
  assert(Math.abs(clocks[0] - clocks[1]) < 5, `guest clock ${clocks[1]} follows host ${clocks[0]}`);
  if (out) { await host.screenshot({ path: out + '/mp-host.png' }); await guest.screenshot({ path: out + '/mp-guest.png' }); }
  await host.click('#mp-players button');
  await guest.waitForFunction(() => !game.multiplayer.mp.inGame);
  assert.deepEqual(await current(guest), own); assert.deepEqual(await saved(guest), guestSaved);
  await ask(); await guest.waitForFunction(() => game.multiplayer.mp.inGame);
  await guest.click('#mp-leave'); await guest.waitForFunction(() => !game.multiplayer.mp.inGame);
  assert.deepEqual(await current(guest), own);
  await host.click('#mp-anyone');
  await host.waitForFunction(() => document.getElementById('mp-anyone').checked);
  await guest.waitForSelector(`#mp-games button[data-game="${room}"]:not([disabled])`);
  await guest.click(`#mp-games button[data-game="${room}"]`);
  await guest.waitForFunction(() => game.multiplayer.mp.inGame);
  assert.equal(await host.$eval('#mp-requests', el => el.hidden), true);
  await host.click('#mp-leave'); await guest.waitForFunction(() => !game.multiplayer.mp.inGame);
  assert.deepEqual(await current(guest), own); assert.deepEqual(await saved(guest), guestSaved);
  await guest.waitForFunction(() => !document.querySelector('#mp-games button'));
  await guest.setViewport({ width: 390, height: 844 });
  if (out) await guest.screenshot({ path: out + '/mp-empty-mobile.png' });
  assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS: join, input filtering, host/own/host restores, tuning + atmosphere updates, remove, guest leave, host leave, saved values unchanged, no page errors');
} finally { await browser.close(); }
