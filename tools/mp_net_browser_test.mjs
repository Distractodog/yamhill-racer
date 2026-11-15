// Director integration check (requires game server on 8173 and local relay on 8787).
// Run through the heavy-check gate: node tools/mp_net_browser_test.mjs
// Two isolated browser identities import the transport without loading/rendering the world.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const origin = process.env.YR_GAME_URL || 'http://127.0.0.1:8173';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--no-sandbox'],
});
const errors = [];
try {
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/src/mp/net.js`);
    await page.evaluate(async () => {
      const { mp } = await import('/src/mp/net.js');
      window.mp = mp; window.states = []; window.skins = [];
      mp.on('state', m => window.states.push(m)); mp.on('skin', m => window.skins.push(m));
    });
    pages.push(page);
  }
  const [host, guest] = pages;
  const code = await host.evaluate(async () => {
    window.paint = '#e8402f';
    mp.setVehicleSource(() => ({ kind: 'car', colors: { body: window.paint }, glider: {}, vehicle: {
      pos: { x: -542, y: 200, z: 440 }, quat: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 1, y: 0, z: 2 },
    } }));
    await mp.host(); return mp.me.code;
  });
  await guest.evaluate(code => mp.join(code), code);
  await guest.waitForFunction(() => mp.players.size === 2 && window.states.length >= 3);
  await host.evaluate(() => { window.paint = '#00ff00'; });
  await guest.waitForFunction(() => window.skins.some(m => m.skin.colors.body === '#00ff00'));
  const state = await guest.evaluate(() => window.states.at(-1));
  assert.deepEqual(state.p, [-542, 200, 440]); assert.ok(Number.isFinite(state.srvT));
  const offset = await guest.evaluate(() => Math.abs(mp.now() - Date.now()));
  assert.ok(offset < 2000, `local relay clock offset ${offset} ms`);
  await host.evaluate(() => mp.leave());
  await guest.waitForFunction(() => !mp.inGame && mp.roomCode === null);
  assert.deepEqual(errors, []);
  console.log('PASS browser mp: two identities, local relay, roster, states, skin update, clock, host closure');
} finally { await browser.close(); }
