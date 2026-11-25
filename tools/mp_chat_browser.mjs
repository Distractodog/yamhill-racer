// Two real game pages and a local relay; run through the heavy gate. Owns and closes every server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startGame, watchErrors } from './lib/startgame.mjs';
import { localURL } from './lib/mp-combat-browser.mjs';
import { combatGameHandler } from './lib/mp-combat-server.mjs';
const out = resolve(process.argv[2] || '/tmp/yr-mp-chat');
const server = createServer(combatGameHandler(resolve('game'))), errors = [], pages = [];
let browser, relayProcess, relayExit, deadline;
async function cleanup() {
  await browser?.close();
  if (relayProcess && relayProcess.exitCode === null) { relayProcess.kill('SIGTERM'); await relayExit; }
  server.closeAllConnections();
  if (server.listening) await new Promise(r => server.close(r));
}
async function run() {
  await mkdir(out, { recursive: true });
  let url = process.env.GAME_URL || process.env.YR_URL;
  if (!url) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); url = `http://127.0.0.1:${server.address().port}/`; }
  localURL(url, ['http:', 'https:']);
  let relay = process.env.YR_MP_RELAY;
  if (!relay) {
    relayProcess = spawn(process.execPath, ['server/local.mjs', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    relayExit = once(relayProcess, 'exit');
    relay = await new Promise((resolve, reject) => {
      let text = '';
      relayProcess.on('error', reject); relayProcess.on('exit', code => reject(Error(`Relay exited ${code}: ${text}`)));
      relayProcess.stderr.on('data', b => text += b);
      relayProcess.stdout.on('data', b => { text += b; const m = text.match(/MP relay: (ws:\/\/127\.0\.0\.1:\d+)/); if (m) resolve(m[1]); });
    });
  }
  localURL(relay, ['ws:', 'wss:']);
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  for (const name of ['Host', 'Guest']) {
    const context = await browser.createBrowserContext(), page = await context.newPage(); pages.push(page);
    await page.setViewport({ width: 1280, height: 800 }); watchErrors(page, name, errors);
    await startGame(page, { url, relay, storage: { 'yr-mp-name-1': name } });
  }
  const [a, b] = pages;
  const code = await a.evaluate(async () => { const mp = game.multiplayer.mp; await mp.host(); mp.send({ t: 'join-policy', anyone: true }); return mp.me.code; });
  await a.waitForFunction(() => document.querySelector('#mp-anyone').checked);
  await b.evaluate(code => game.multiplayer.mp.join(code), code);
  for (const [page, name, text] of [[a, 'Host', '<script>hello</script>'], [b, 'Guest', 'WASD Q V J M T are chat text']]) {
    await page.bringToFront();
    await page.keyboard.down('w');
    await page.keyboard.press('Enter');
    await page.keyboard.up('w');
    await page.waitForSelector('#mp-chat-input', { visible: true });
    await page.keyboard.type(text);
    const state = await page.evaluate(() => ({ keys: [...game.keys], open: game.multiplayer.chat.open,
      picker: game.vehicles.open, map: game.minimap.open, race: game.challenges.menuOpen }));
    assert.deepEqual(state, { keys: [], open: true, picker: false, map: false, race: false });
    await page.keyboard.press('Enter');
    for (const peer of pages) await peer.waitForFunction(line => document.querySelector('#mp-chat-lines').textContent.includes(line), {}, `${name}: ${text}`);
    assert.equal(await page.evaluate(() => !!document.querySelector('#mp-chat-lines script')), false);
  }
  await b.keyboard.press('Enter');
  await b.screenshot({ path: `${out}/chat-open.png` });
  const bounds = await b.evaluate(() => {
    const chat = document.querySelector('#mp-chat').getBoundingClientRect(), health = document.querySelector('#combat-health').getBoundingClientRect();
    return { bottom: chat.bottom, top: health.top };
  });
  assert.ok(bounds.bottom < bounds.top, 'chat stays above health and speed HUD');
  await b.keyboard.type('cancelled'); await b.keyboard.press('Escape');
  assert.equal(await b.evaluate(() => game.multiplayer.chat.open), false);
  await a.screenshot({ path: `${out}/chat-received.png` });
  await b.evaluate(() => game.multiplayer.mp.leave());
  await b.waitForFunction(() => document.querySelector('#mp-chat').hidden);
  assert.deepEqual(errors, []);
  console.log(`PASS two-way authoritative chat, typing blocks controls, literal text, Escape and leave; screenshots ${out}`);
}
try {
  await Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Chat browser deadline (5 minutes)')), 300000); })]);
} finally { clearTimeout(deadline); await cleanup(); }
