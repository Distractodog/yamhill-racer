// Controller-only real game check. Owns ephemeral loopback servers and two isolated Chrome contexts.
// From this worktree (no existing servers needed):
// /Users/ethanbristol/argus-runs/.heavy/heavy node tools/mp_lifecycle_browser.mjs /tmp/distractodog-mp-browser
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { startGame, openMenu } from './lib/startgame.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), gameRoot = resolve(root, 'game');
const out = resolve(process.argv[2] || '/tmp/distractodog-mp-browser');
await mkdir(out, { recursive: true });
const errors = [], pages = [], logs = [], sockets = [];
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ogg': 'audio/ogg', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    const path = resolve(gameRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(gameRoot + sep)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch { res.writeHead(404).end(); }
});
server.on('connection', socket => { sockets.push(socket); });
let relayProcess, relayExit, browser, timeout, failed = null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  relayProcess = spawn(process.execPath, [resolve(root, 'server/local.mjs'), '0'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  relayExit = once(relayProcess, 'exit');
  const relay = await new Promise((resolve, reject) => {
    relayProcess.once('error', reject);
    relayProcess.once('exit', code => reject(Error(`Local relay exited (${code}): ${logs.join('')}`)));
    relayProcess.stderr.on('data', data => logs.push(String(data)));
    relayProcess.stdout.on('data', data => { logs.push(String(data)); const match = logs.join('').match(/MP relay: (ws:\/\/127\.0\.0\.1:\d+)/); if (match) resolve(match[1]); });
  });
  // Verify the served transport is exactly this checkout, not an already running/stale server.
  assert.equal(await (await fetch(`${origin}/src/mp/net.js`)).text(), await readFile(resolve(gameRoot, 'src/mp/net.js'), 'utf8'));
  logs.push(`\nWorktree: ${root}\nGame: ${origin}\nRelay: ${relay}\n`);
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
  for (const name of ['Host', 'Guest']) {
    const context = await browser.createBrowserContext(), page = await context.newPage(); pages.push(page);
    page.setDefaultTimeout(30000);
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
    page.on('console', msg => { if (['error', 'warn'].includes(msg.type())) logs.push(`${name} console ${msg.type()}: ${msg.text()}\n`); });
    page.on('requestfailed', req => { if (req.failure()?.errorText !== 'net::ERR_ABORTED' && !req.url().endsWith('/favicon.ico')) errors.push(`${name}: ${req.failure()?.errorText} ${req.url()}`); });
    page.on('response', r => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`${name}: HTTP ${r.status()} ${r.url()}`); });
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = new URL(req.url());
      if (url.origin === origin || url.origin === relay.replace(/^ws/, 'http') ||
          (url.hostname === 'cdn.jsdelivr.net' && req.method() === 'GET') || ['data:', 'blob:'].includes(url.protocol)) req.continue();
      else { errors.push(`Blocked nonlocal request: ${req.method()} ${req.url()}`); req.abort(); }
    });
    await page.evaluateOnNewDocument(relay => {
      const NativeSocket = WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(url, ...args) {
          if (!String(url).startsWith(relay + '/room/')) throw Error('Nonlocal relay forbidden by lifecycle check');
          super(url, ...args);
        }
      };
    }, relay);
    await startGame(page, { url: origin + '/?nostats=1', relay, storage: { 'yr-mp-name-1': name } });
    assert.equal(new URL(page.url()).origin, origin);
    assert.equal(await page.evaluate(() => window.YR_MP_RELAY), relay);
  }
  const [host, guest] = pages;
  const hostGame = () => host.evaluate(async () => {
    const mp = game.multiplayer.mp; await mp.host(); mp.send({ t: 'join-policy', anyone: true }); return mp.roomCode;
  });
  let code = await hostGame();
  await guest.evaluate(async code => game.multiplayer.mp.join(code), code);
  await host.waitForFunction(() => game.multiplayer.mp.players.size === 2);
  await host.evaluate(() => game.challenges.openMenu(0));
  await host.waitForSelector('#ch-menu .rm-invite', { visible: true }); await host.click('#ch-menu .rm-invite');
  await host.waitForSelector('#mp-invite-out [data-a="invite"]', { visible: true }); await host.click('#mp-invite-out [data-a="invite"]');
  await guest.waitForSelector('#mp-invite-in [data-a="yes"]', { visible: true }); await guest.click('#mp-invite-in [data-a="yes"]');
  for (const page of pages) await page.waitForFunction(() => game.challenges.state === 'running', { timeout: 45000 });
  for (const page of pages) {
    await page.evaluate(async () => {
      const { car, challenges } = game, gates = challenges.runInfo().gates;
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      for (let i = 1; i < gates.length; i++) {
        const gate = gates[i];
        for (const distance of [-4, 3]) {
          car.pos.set(gate.x + Math.sin(gate.yaw) * distance, gate.y ?? car.pos.y, gate.z + Math.cos(gate.yaw) * distance);
          car.vel.set(0, 0, 0); await frame(); await frame();
        }
      }
    });
    await page.waitForFunction(() => game.challenges.state === 'finished');
  }
  await host.screenshot({ path: resolve(out, 'host-finished.png') });
  for (const page of pages) {
    await page.click('#ch-done [data-action="roam"]');
    assert.equal(await page.evaluate(() => game.multiplayer.mp.inGame && game.challenges.state === 'idle'), true);
  }
  assert.equal(await host.evaluate(() => game.multiplayer.mp.players.size), 2);
  logs.push('PASS finish -> Free roam keeps both network memberships\n');
  await startGame(host, { url: origin + '/?nostats=1', relay, storage: { 'yr-mp-name-1': 'Host' } });
  await guest.waitForFunction(() => !game.multiplayer.mp.inGame, { timeout: 35000 });
  assert.deepEqual(await guest.evaluate(() => game.multiplayer.mp.listGames()), []);
  code = await hostGame();
  await guest.evaluate(code => game.multiplayer.mp.join(code), code);
  // Same-browser second tab shares the stored identity, but cannot replace the live host.
  const duplicate = await host.browserContext().newPage();
  try {
    await duplicate.goto(origin + '/src/mp/net.js');
    const reason = await duplicate.evaluate(async relay => {
      window.YR_MP_RELAY = relay; const { mp } = await import('/src/mp/net.js');
      try { await mp.host(); return 'unexpectedly-connected'; } catch (e) { return e.reason; }
    }, relay);
    assert.equal(reason, 'duplicate-id'); assert.equal(await host.evaluate(() => game.multiplayer.mp.inGame), true);
  } finally { await duplicate.close(); }
  // Live guest ping/state traffic must not keep hosting alive after heartbeat loss.
  await host.evaluate(() => { const mp = game.multiplayer.mp; clearInterval(mp._heartbeatTimer); });
  await guest.waitForFunction(() => !game.multiplayer.mp.inGame, { timeout: 35000 });
  assert.deepEqual(await guest.evaluate(() => game.multiplayer.mp.listGames()), []);
  await host.waitForFunction(() => !game.multiplayer.mp.inGame);
  code = await hostGame();
  await guest.evaluate(code => game.multiplayer.mp.join(code), code);
  await openMenu(host); await host.click('#mp-button'); await host.click('#mp-leave');
  await guest.waitForFunction(() => !game.multiplayer.mp.inGame, { timeout: 3000 });
  assert.deepEqual(await guest.evaluate(() => game.multiplayer.mp.listGames()), []);
  await openMenu(guest); await guest.click('#mp-button');
  await guest.waitForFunction(() => !document.querySelector('#mp-games button') && /No one is hosting/.test(document.querySelector('#mp-empty').textContent));
  await guest.screenshot({ path: resolve(out, 'guest-after-leave.png') });
  // Reopen while discovery is failing: show an error and no cached rows.
  await guest.click('#mp-close');
  await guest.evaluate(() => { game.multiplayer.mp.listGames = async () => { throw Error('deterministic browser refresh failure'); }; });
  await openMenu(guest); await guest.click('#mp-button');
  await guest.waitForFunction(() => /Could not refresh/.test(document.querySelector('#mp-empty').textContent));
  assert.equal(await guest.$('#mp-games button'), null);
  await guest.screenshot({ path: resolve(out, 'guest-refresh-failed.png') });
  assert.deepEqual(errors, []);
  logs.push('PASS distractodog: real two-context game, finish/exit/refresh, rehost, live duplicate rejection, heartbeat expiry with guest activity, prompt Leave, menu failure; no page errors\n');
}
try {
  await Promise.race([run(), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Browser lifecycle check exceeded 5 minutes')), 300000); })]);
} catch (e) { failed = e; logs.push(`${e.stack}\n`); }
finally {
  clearTimeout(timeout);
  for (let i = 0; i < pages.length; i++) if (!pages[i].isClosed()) {
    await Promise.race([pages[i].screenshot({ path: resolve(out, `final-${i}.png`) }).catch(e => logs.push(`Screenshot failed: ${e}\n`)), delay(5000)]);
  }
  if (browser) {
    const process = browser.process();
    const kill = setTimeout(() => process?.kill('SIGKILL'), 5000);
    await browser.close().catch(() => {}); clearTimeout(kill);
  }
  if (relayProcess) {
    relayProcess.kill(); const kill = setTimeout(() => relayProcess.kill('SIGKILL'), 2000);
    await relayExit.catch(() => {}); clearTimeout(kill);
  }
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await writeFile(resolve(out, 'report.json'), JSON.stringify({ status: failed ? 'fail' : 'pass', worktree: root, errors, logs }, null, 2));
}
for (const line of logs) process.stdout.write(line);
if (failed) process.exitCode = 1;
