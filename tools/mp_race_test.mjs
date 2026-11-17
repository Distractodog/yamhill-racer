// Browser test for multiplayer races (director runs it; needs Chrome, the local relay and the game server):
//   node tools/mp_race_test.mjs [shotDir]      (YR_URL = game, default http://127.0.0.1:8173/; YR_MP_RELAY default ws://127.0.0.1:8787)
// Starts server/local.mjs and tools/serve.py on those ports unless already running, opens two isolated pages (host + guest),
// invites, accepts, checks the synced GO (within 100 ms on the relay clock), then teleports each car through the gates
// (host first, guest 2 s later) and checks the results order.  Exit code 1 on failure.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { GAME_URL as GAME, RELAY_URL as RELAY, startGame, watchErrors } from './lib/startgame.mjs';

const shots = process.argv[2] || '/tmp/yr-mp-race';
mkdirSync(shots, { recursive: true });
const port = url => String(new URL(url).port);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const portOpen = p => new Promise(r => { const s = connect(+p, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
const procs = [];                                               // reuse servers that are already running on those ports
if (!(await portOpen(port(RELAY)))) procs.push(spawn('node', ['server/local.mjs', port(RELAY)], { stdio: 'inherit' }));
if (!(await portOpen(port(GAME)))) procs.push(spawn('python3', ['tools/serve.py', port(GAME), 'game'], { stdio: 'ignore' }));
let failed = 0;
const pageErrors = [];
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!ok) failed++; };

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--window-size=1100,700', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
async function open(name) {
  const ctx = await browser.createBrowserContext();            // separate localStorage = separate player id
  const page = await ctx.newPage();
  await page.setViewport({ width: 1100, height: 700 });
  watchErrors(page, name, pageErrors);
  await startGame(page, { url: GAME, relay: RELAY, storage: { 'yr-mp-name-1': name } });   // past the spawn map, tiles loaded
  return page;
}
try {
  await sleep(1500);
  const host = await open('Hosty'), guest = await open('Guesty');
  const code = await host.evaluate(async () => { const { mp } = await import('./src/mp/net.js'); await mp.host(); mp.send({ t: 'join-policy', anyone: true }); return mp.roomCode; });
  await guest.evaluate(async c => { const { mp } = await import('./src/mp/net.js'); await mp.join(c); }, code);
  await sleep(1000);
  check('both in game', await host.evaluate(async () => (await import('./src/mp/net.js')).mp.players.size === 2));

  // watch for GO on both pages (relay clock)
  for (const p of [host, guest]) await p.evaluate(async () => {
    const { mp } = await import('./src/mp/net.js');
    window.__go = null; const t = setInterval(() => { if (window.game.challenges.state === 'running' && !window.__go) { window.__go = mp.now(); clearInterval(t); } }, 5);
  });
  await host.evaluate(() => { window.game.challenges.openMenu(0); });
  check('race menu offers Invite players', await host.evaluate(() => !document.querySelector('#ch-menu .rm-invite').hidden));
  await host.click('#ch-menu .rm-invite'); await sleep(200);        // in MP the race menu's Invite players opens the Invite step
  await host.click('#mp-invite-out [data-a="invite"]'); await sleep(500);
  check('guest sees invite', await guest.evaluate(() => getComputedStyle(document.getElementById('mp-invite-in')).display === 'block'));
  check('invite leaves the corner map visible', await guest.evaluate(() => {
    const a = document.getElementById('mp-invite-in').getBoundingClientRect(), b = document.getElementById('minimap').getBoundingClientRect();
    return a.top >= b.bottom || a.bottom <= b.top || a.left >= b.right || a.right <= b.left;
  }));
  await guest.screenshot({ path: `${shots}/guest-invite.png` });
  await guest.click('#mp-invite-in [data-a="yes"]');
  await sleep(1000);
  await host.screenshot({ path: `${shots}/host-countdown.png` });
  await guest.waitForFunction(() => window.__go, { timeout: 20000 }); await host.waitForFunction(() => window.__go, { timeout: 20000 });
  const [h, g] = [await host.evaluate(() => window.__go), await guest.evaluate(() => window.__go)];
  check('GO within 100 ms', Math.abs(h - g) < 100, `(${Math.abs(h - g).toFixed(0)} ms)`);
  await sleep(1000);
  await host.screenshot({ path: `${shots}/host-race.png` });
  check('live places on HUD', await host.evaluate(() => /1st|2nd/.test(document.getElementById('ch-hud').textContent)));

  const through = page => page.evaluate(async () => {
    const { car, challenges } = window.game, gates = challenges.runInfo().gates;
    // note: the first row (long-walk) is a car race; gates sit on the route
    const frame = () => new Promise(r => requestAnimationFrame(() => r()));
    for (let i = 1; i < gates.length; i++) {
      const g = gates[i], fx = Math.sin(g.yaw), fz = Math.cos(g.yaw);
      for (const d of [-4, 3]) { car.pos.set(g.x + fx * d, g.y ?? car.pos.y, g.z + fz * d); car.vel.set(0, 0, 0); await frame(); await frame(); }
    }
  });
  await through(host); await sleep(2000); await through(guest); await sleep(1500);
  const order = await host.evaluate(() => [...document.querySelectorAll('#ch-mp-results .mp-results div')].map(d => d.textContent.trim()));
  console.log(order);
  check('results: host 1st, guest 2nd', order.length === 2 && /Hosty/.test(order[0]) && /Guesty/.test(order[1]));
  await host.screenshot({ path: `${shots}/host-results.png` });
} catch (e) { console.log('ERROR', e); failed++; }
check('no page errors', pageErrors.length === 0, `(${pageErrors.length})`);
await browser.close(); procs.forEach(p => p.kill());
process.exit(failed ? 1 : 0);
