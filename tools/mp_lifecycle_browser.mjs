// Controller-only real game check. Owns ephemeral loopback servers and two isolated Chrome contexts.
// From this worktree (no existing servers needed):
// ~/argus-runs/.heavy/heavy node tools/mp_lifecycle_browser.mjs /tmp/distractodog-mp-browser
// Allow ~2–4 minutes; hard deadline 5 minutes plus bounded cleanup. Local relay only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { watchNetwork } from './lib/mp-browser-network.mjs';
import { startGame, openMenu, holdCar } from './lib/startgame.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), gameRoot = resolve(root, 'game');
if (process.argv.includes('--help')) {
  console.log('Usage: node tools/mp_lifecycle_browser.mjs [evidence-directory]\nOwns ephemeral loopback game/relay and Chrome; ~2–4 min, 5 min deadline. No production relay.');
  process.exit(0);
}
const out = resolve(process.argv[2] || '/tmp/distractodog-mp-browser');
await mkdir(out, { recursive: true });
const errors = [], pages = [], logs = [], sockets = [], sources = {}, raceResults = [];
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
let relayProcess, relayExit, browser, launch, timeout, failed = null, stopping = false;
let interrupt;
const interrupted = new Promise((_, reject) => { interrupt = reject; });
const onInt = () => { stopping = true; interrupt(Error('Interrupted by SIGINT')); };
const onTerm = () => { stopping = true; interrupt(Error('Interrupted by SIGTERM')); };
process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
  const puppeteer = (await import('puppeteer-core')).default;
  if (stopping) return;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  if (stopping) { server.close(); return; }
  const origin = `http://127.0.0.1:${server.address().port}`;
  relayProcess = spawn(process.execPath, [resolve(root, 'server/local.mjs'), '0'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  relayExit = new Promise(resolve => { relayProcess.once('exit', resolve); relayProcess.once('error', resolve); });
  const relay = await new Promise((resolve, reject) => {
    relayProcess.once('error', reject);
    relayProcess.once('exit', code => reject(Error(`Local relay exited (${code}): ${logs.join('')}`)));
    relayProcess.stderr.on('data', data => logs.push(String(data)));
    relayProcess.stdout.on('data', data => { logs.push(String(data)); const match = logs.join('').match(/MP relay: (ws:\/\/127\.0\.0\.1:\d+)/); if (match) resolve(match[1]); });
  });
  // Own port and byte/hash verification prevent a stale main checkout from being tested.
  for (const file of ['index.html', 'src/main.js', 'src/mp/net.js', 'src/mp/menu.js', 'src/mp/racecore.js']) {
    const body = await readFile(resolve(gameRoot, file), 'utf8');
    const url = `${origin}/${file}`;
    assert.equal(await (await fetch(url, { signal: AbortSignal.timeout(5000) })).text(), body);
    sources[file] = { url, sha256: createHash('sha256').update(body).digest('hex') };
  }
  for (const file of ['tools/mp_lifecycle_browser.mjs', 'server/local.mjs', 'server/relay.mjs', 'server/local-room.mjs', 'server/lobby.mjs']) {
    sources[file] = { sha256: createHash('sha256').update(await readFile(resolve(root, file))).digest('hex') };
  }
  if (stopping) return;
  logs.push(`\nWorktree: ${root}\nGame: ${origin}\nRelay: ${relay}\n`);
  launch = puppeteer.launch({ timeout: 30000, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
  browser = await launch;
  if (stopping) return;
  for (const name of ['Host', 'Guest']) {
    const context = await browser.createBrowserContext(), page = await context.newPage(); pages.push(page);
    page.setDefaultTimeout(30000);
    await page.setCacheEnabled(false);
    await page.setViewport({ width: 1280, height: 800 });
    await watchNetwork(page, name, origin, relay, errors, logs);
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
    assert.equal(page.url(), origin + '/?nostats=1');
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
  // Run both participants together: a first finisher starts the relay's 60-second deadline.
  // Use the existing hold helper so unloaded ground cannot pull a teleported car back.
  await Promise.all(pages.map(async (page, participant) => {
    const gates = await page.evaluate(() => game.challenges.runInfo().gates);
    for (let i = 1; i < gates.length; i++) {
      const gate = gates[i], fx = Math.sin(gate.yaw), fz = Math.cos(gate.yaw);
      await holdCar(page, { x: gate.x - fx * 4, z: gate.z - fz * 4, yaw: gate.yaw }, 20000);
      await page.evaluate(async gate => {
        const { car, challenges, world } = game;
        if (challenges.state !== 'running') throw Error(`Race stopped: ${JSON.stringify(challenges.result)}`);
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        // Let update() observe the approach position before crossing the line.
        await frame(); await frame();
        const x = gate.x + Math.sin(gate.yaw) * 3, z = gate.z + Math.cos(gate.yaw) * 3;
        if (!world.loadedAt(x, z)) throw Error('Crossing ground not loaded');
        car.pos.set(x, world.heightAt(x, z) + 0.8, z); car.vel.set(0, 0, 0);
        car._lastLoaded = null; car.savePrev(); car.interpolate(0);
        await frame(); await frame();
      }, gate);
      await page.waitForFunction(i => game.challenges.next > i || game.challenges.state === 'finished', { timeout: 3000 }, i);
      const progress = await page.evaluate(() => ({ next: game.challenges.next, state: game.challenges.state, result: game.challenges.result }));
      assert.equal(progress.next, i + 1, `Participant ${participant}, gate ${i}: ${JSON.stringify(progress)}`);
    }
    const result = await page.evaluate(() => game.challenges.result);
    assert.equal(result?.dnf, undefined, `Participant ${participant} DNF`);
    assert(Number.isFinite(result?.time) && result.time > 0, 'Successful timed finish required');
    raceResults.push({ participant, result, gates: gates.length });
    await page.screenshot({ path: resolve(out, `finished-${participant}.png`) });
  }));
  for (const page of pages) {
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('#ch-mp-results .mp-results > div');
      return rows.length === 2 && [...rows].every(row => {
        const time = row.querySelector('em')?.textContent;
        return time && /[0-9]/.test(time) && !/DNF|racing/.test(time);
      });
    }, { timeout: 5000 });
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
    await watchNetwork(duplicate, 'Duplicate', origin, relay, errors, logs);
    await duplicate.goto(origin + '/src/mp/net.js');
    const reason = await duplicate.evaluate(async relay => {
      window.YR_MP_RELAY = relay;
      const NativeSocket = WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(url, ...args) {
          if (!String(url).startsWith(relay + '/room/')) throw Error('Nonlocal relay forbidden by lifecycle check');
          super(url, ...args);
        }
      };
      const { mp } = await import('/src/mp/net.js');
      try { await mp.host(); return 'unexpectedly-connected'; } catch (e) { return e.reason; }
    }, relay);
    assert.equal(reason, 'duplicate-id'); assert.equal(await host.evaluate(() => game.multiplayer.mp.inGame), true);
  } finally { await duplicate.close(); }
  // Live guest ping/state traffic must not keep hosting alive after heartbeat loss.
  await host.evaluate(() => { const mp = game.multiplayer.mp; clearInterval(mp._heartbeatTimer); });
  const activity = await guest.evaluate(() => {
    window.__guestPings = 0;
    window.__guestActivity = setInterval(() => {
      if (game.multiplayer.mp.inGame) { game.multiplayer.mp.send({ t: 'ping', c: Date.now() }); window.__guestPings++; }
    }, 250);
    return game.multiplayer.mp.inGame;
  });
  assert.equal(activity, true);
  await guest.waitForFunction(() => !game.multiplayer.mp.inGame, { timeout: 35000 });
  assert.deepEqual(await guest.evaluate(() => game.multiplayer.mp.listGames()), []);
  const pings = await guest.evaluate(() => { clearInterval(window.__guestActivity); return window.__guestPings; });
  assert(pings >= 4, `Guest activity missing: ${pings} pings`);
  logs.push(`Guest sent ${pings} pings during host heartbeat expiry\n`);
  await host.waitForFunction(() => !game.multiplayer.mp.inGame);
  code = await hostGame();
  await guest.evaluate(code => game.multiplayer.mp.join(code), code);
  await openMenu(host); await host.click('#mp-button'); await host.click('#mp-leave');
  await guest.waitForFunction(() => !game.multiplayer.mp.inGame, { timeout: 3000 });
  assert.deepEqual(await guest.evaluate(() => game.multiplayer.mp.listGames()), []);
  await openMenu(guest); await guest.click('#mp-button');
  await guest.waitForFunction(() => !document.querySelector('#mp-games button') && /No one is hosting/.test(document.querySelector('#mp-empty').textContent));
  await guest.screenshot({ path: resolve(out, 'guest-after-leave.png') });
  // Seed a real cached listing before forcing discovery failure on reopen.
  await guest.click('#mp-close');
  code = await hostGame();
  await openMenu(guest); await guest.click('#mp-button');
  await guest.waitForSelector('#mp-games button', { visible: true });
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
  await Promise.race([run(), interrupted, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Browser lifecycle check exceeded 5 minutes')), 300000); })]);
} catch (e) { failed = e; logs.push(`${e.stack}\n`); }
finally {
  stopping = true;
  clearTimeout(timeout);
  for (let i = 0; i < pages.length; i++) if (!pages[i].isClosed()) {
    await Promise.race([pages[i].screenshot({ path: resolve(out, `final-${i}.png`) }).catch(e => logs.push(`Screenshot failed: ${e}\n`)), delay(5000)]);
  }
  // Launch may still be in flight when a signal/deadline wins; adopt it before cleanup.
  if (launch && !browser) browser = await launch.catch(() => null);
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
  if (!failed && errors.length) failed = Error('Browser errors were recorded during shutdown');
  await writeFile(resolve(out, 'report.json'), JSON.stringify({ status: failed ? 'fail' : 'pass', worktree: root, sources, raceResults, errors, logs }, null, 2));
}
process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
for (const line of logs) process.stdout.write(line);
if (failed) process.exitCode = 1;
