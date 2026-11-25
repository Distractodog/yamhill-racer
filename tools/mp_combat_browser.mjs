// Run through the heavy gate. Owns game/relay servers by default; GAME_URL / YR_MP_RELAY may point at local servers.
// Actual keyboard missile firing, client sweeps, relay and target damage; aircraft motion is held solely for aiming.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startGame, watchErrors } from './lib/startgame.mjs';
import { missilePose, localURL } from './lib/mp-combat-browser.mjs';
const root = resolve('game'), out = resolve(process.argv[2] || '/tmp/yr-mp-combat');
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.jpg':'image/jpeg', '.png':'image/png', '.ogg':'audio/ogg' };
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + new URL(req.url, 'http://local').pathname.replace(/\/$/, '/index.html'));
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
let browser, relayProcess, relayExit, deadline;
const errors = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
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
  const pages = [];
  for (const name of ['Ace', 'Driver']) {
    const context = await browser.createBrowserContext(), page = await context.newPage(); pages.push(page);
    await page.setViewport({ width: 1280, height: 800 }); watchErrors(page, name, errors);
    await startGame(page, { url, relay, storage: { 'yr-mp-name-1': name }, hold: { x: -542, z: 440 } });
  }
  const [a, b] = pages;
  const code = await a.evaluate(async () => { const mp = game.multiplayer.mp; await mp.host(); mp.send({t:'join-policy', anyone:true}); return mp.me.code; });
  await a.waitForFunction(() => document.querySelector('#mp-anyone').checked);
  await b.evaluate(code => game.multiplayer.mp.join(code), code);
  await b.evaluate(() => {
    window.combatEvidence = { min: 100, wreckAt: null, respawnAt: null, feeds: [], frames: [] };
    let previous = performance.now();
    const sample = now => {
      const s = game.combat.state, e = window.combatEvidence;
      e.min = Math.min(e.min, s.health); if (s.wrecked && !e.wreckAt) e.wreckAt = now;
      if (e.wreckAt && !s.wrecked && !e.respawnAt) e.respawnAt = now;
      const f = document.querySelector('#combat-feed'); if (!f.hidden && !e.feeds.includes(f.textContent)) e.feeds.push(f.textContent);
      if (e.frames.length < 3000) e.frames.push(now - previous); previous = now; requestAnimationFrame(sample);
    }; requestAnimationFrame(sample);
  });
  await b.waitForFunction(() => !game.combat.state.protected, { timeout: 15000 });
  const target = await b.evaluate(() => game.vehicles.current.pos.toArray());
  await a.evaluate(async pose => {
    game.vehicles.choose('jet', 'fighter'); const v = game.vehicles.current;
    v.pos.fromArray(pose.position); v.quat.fromArray(pose.quaternion); v.vel.set(0,0,0); v.mode = 'air'; v.gear = 0;
    v.step = () => {}; v.savePrev(); v.interpolate(0); v.syncMesh(0); v.mesh.updateMatrixWorld(true);
  }, missilePose(target));
  await a.waitForFunction(() => game.remotes.count === 1 && !game.respawnHold.blocked);
  // Keep both pages visible to Chrome's scheduler and use the actual game's Q key binding.
  async function missile() {
    await a.waitForFunction(() => game.weapons.core.cooldown === 0);
    await a.evaluate(() => game.keys.add('KeyQ')); await delay(200); await a.evaluate(() => game.keys.delete('KeyQ')); await delay(400);
  }
  for (let i = 0; i < 4 && !await b.evaluate(() => !!window.combatEvidence.wreckAt); i++) await missile();
  await b.waitForFunction(() => !!window.combatEvidence.wreckAt, { timeout: 10000 });
  await a.waitForFunction(() => document.querySelector('#combat-feed').textContent === 'Ace wrecked Driver', { timeout: 3000 });
  await Promise.all([a.screenshot({ path: `${out}/shooter-feed.png` }), b.screenshot({ path: `${out}/target-wreck.png` })]);
  await b.waitForFunction(() => !!window.combatEvidence.respawnAt, { timeout: 10000 });
  const evidence = await b.evaluate(() => window.combatEvidence);
  assert.ok(evidence.min < 100); assert.ok(evidence.respawnAt - evidence.wreckAt >= 2800);
  assert.ok(evidence.feeds.includes('Ace wrecked Driver'));
  assert.equal(await b.evaluate(() => game.combat.state.health), 100);
  await b.screenshot({ path: `${out}/respawn.png` });
  // Toggle the real menu control, then wait past protection so it cannot hide an enabled-damage bug.
  await a.evaluate(() => { const e = document.querySelector('#mp-weapons'); e.checked = false; e.dispatchEvent(new Event('change')); });
  await b.waitForFunction(() => !game.multiplayer.mp.weaponsEnabled && !game.combat.state.protected, { timeout: 15000 });
  await missile();
  assert.equal(await a.evaluate(() => game.weapons.core.pool.some(p => p.active && !p.remote)), false, 'toggle blocks firing');
  // Even a stale/malicious shot sender cannot bypass the disabled relay or receiver.
  const dest = await b.evaluate(() => ({ id: game.multiplayer.mp.me.id, p: game.vehicles.current.pos.toArray() }));
  await a.evaluate(({id,p}) => game.multiplayer.mp.send({t:'hit',to:id,k:'missile',n:65000,d:70,p}), dest); await delay(500);
  assert.equal(await b.evaluate(() => game.combat.state.health), 100);
  assert.deepEqual(errors, []);
  await writeFile(`${out}/report.json`, JSON.stringify({ ...evidence, errors }, null, 2));
  console.log(`PASS multiplayer combat: missiles, damage, wreck, safe respawn, both feeds, host disable; evidence ${out}`);
}
try {
  await Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Combat browser deadline (5 minutes)')), 300000); })]);
} finally { clearTimeout(deadline); await cleanup(); }
