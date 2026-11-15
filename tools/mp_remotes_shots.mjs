// Multiplayer remotes in two real browsers through the local relay (director-run; needs Chrome):
//   node tools/mp_remotes_shots.mjs [out dir] [--game http://127.0.0.1:8173/] [--relay ws://127.0.0.1:8787]
// Starts server/local.mjs (port 8787) and tools/serve.py (port 8173) if they aren't already running. Page A hosts,
// page B joins with A's code; A then looks at B at 12 / 60 / 150 m (name tag readable), B on the bike with the glider
// open, B in the jet, B repainted, the corner map and the full map with B's named dot; B's view of A. B leaves.
// Then A's full-game frame time at one spot with one fixed camera, 10 s each: 0 remotes, 15 fake remotes fed in at
// 15 Hz, 0 again; fails if the median grows by more than 2 ms. Prints remotes.list(), median / p95 frame times, draw
// calls, page errors; exits nonzero on page errors or failed checks.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const GAME = opt('--game', process.env.YR_URL || 'http://127.0.0.1:8173/'), RELAY = opt('--relay', process.env.YR_MP_RELAY || 'ws://127.0.0.1:8787');
const OUT = args[0] || 'mp-remotes-shots';
fs.mkdirSync(OUT, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
const children = [], failures = [], errors = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

const portOpen = (port, host = '127.0.0.1') => new Promise(r => { const s = net.connect(port, host); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
async function ensure(port, cmd, argv, label) {
  if (await portOpen(port)) { console.log(`${label}: already running on ${port}`); return; }
  console.log(`${label}: starting ${cmd} ${argv.join(' ')}`);
  const c = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'inherit'] }); children.push(c);
  for (let i = 0; i < 100 && !(await portOpen(port)); i++) await wait(100);
  if (!(await portOpen(port))) throw Error(`${label} did not start on port ${port}`);
}
const cleanup = () => children.forEach(c => c.kill());
process.on('exit', cleanup);

const relayPort = +new URL(RELAY.replace(/^ws/, 'http')).port || 8787;
await ensure(relayPort, process.execPath, ['server/local.mjs', String(relayPort)], 'relay');
await ensure(+new URL(GAME).port || 80, 'python3', ['tools/serve.py', String(+new URL(GAME).port || 8173), 'game'], 'game server');

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
async function open(label) {
  const ctx = await browser.createBrowserContext();                 // own localStorage → own player id / code
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 760 });
  page.on('pageerror', e => { errors.push(`${label}: ${e.message}`); console.log(`PAGE ERROR (${label})`, e.message); });
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.location()?.url || '')) console.log(`console error (${label})`, m.text()); });
  await page.evaluateOnNewDocument(relay => { window.YR_MP_RELAY = relay; try { Object.defineProperty(navigator, 'getGamepads', { value: () => [] }); } catch {} }, RELAY);
  await page.goto(GAME, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.game?.sessionSpawn, { timeout: 120000 });
  if (await page.evaluate(() => game.sessionSpawn.blocked)) {        // pick the spawn through the visible map, like a player
    await page.waitForSelector('#fullmap.open canvas', { visible: true, timeout: 30000 });
    const box = await (await page.$('#fullmap canvas')).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => !game.sessionSpawn.blocked, { timeout: 120000 });
  }
  await page.evaluate(() => { document.getElementById('welcome-start')?.click(); game.garage?.close(); game.minimap.toggle(false); });
  return page;
}
// put this page's vehicle at (x, z) facing yaw, once the ground there has streamed in
const place = (page, x, z, yaw, kind) => page.evaluate(async (x, z, yaw, kind) => {
  const g = game; if (kind) g.vehicles.switchTo(kind);
  const car = g.vehicles.current, sleep = ms => new Promise(r => setTimeout(r, ms));
  const t0 = performance.now();
  while (!g.world.loadedAt(x, z) || g.world.pendingTiles() > 0) { car.pos.set(x, car.pos.y, z); car._lastLoaded = null; if (performance.now() - t0 > 60000) throw Error('ground did not load'); await sleep(100); }
  car.reset(x, z, yaw); car.vel.set(0, 0, 0); car.safe = [];
}, x, z, yaw, kind);
const remotesOf = page => page.evaluate(() => game.remotes.list());
const shot = async (page, name, clip) => { const file = path.join(OUT, name + '.png'); await page.screenshot({ path: file, clip }); console.log('  shot', file); };

const A = await open('A'), B = await open('B');
const code = await A.evaluate(async () => { const { mp } = await import('./src/mp/net.js'); mp.setName('Hana Host'); await mp.host(); return mp.me.code; });
console.log('A hosts with code', code);
await B.evaluate(async code => { const { mp } = await import('./src/mp/net.js'); mp.setName('Gus Guest'); await mp.join(code); }, code);
await wait(800);
check((await remotesOf(A)).length === 1 && (await remotesOf(B)).length === 1, 'each page has one remote');

const X = -558, Z = 45;                     // campus, by the Main Building
await place(A, X, Z, 0);
for (const [d, name] of [[12, 'a-sees-b-12m'], [60, 'a-sees-b-60m'], [150, 'a-sees-b-150m']]) {
  await place(B, X, Z + d, Math.PI / 2);
  await wait(1500);
  const r = (await remotesOf(A))[0];
  console.log(`  B at ${d} m:`, JSON.stringify(r));
  check(r?.visible && r.tag && Math.abs(r.z - (Z + d)) < 3, `B drawn at ${d} m with its name tag`);
  await shot(A, name);
}
await place(B, X, Z + 25, Math.PI / 2, 'bike');
await B.evaluate(() => { const v = game.vehicles.current; v.pos.y += 25; v.vel.set(15, 0, 0); game.bikeGlider.deploy(); });
await wait(900);
let r = (await remotesOf(A))[0]; console.log('  B gliding:', JSON.stringify(r));
check(r?.kind === 'bike' && r.glide, 'B on the bike with the glider open');
await shot(A, 'a-sees-b-bike-glider');
await place(B, X, Z + 45, Math.PI / 2, 'jet');
await wait(1200);
r = (await remotesOf(A))[0]; check(r?.kind === 'jet', 'B in the jet'); await shot(A, 'a-sees-b-jet');
await place(B, X, Z + 15, Math.PI / 2, 'car');
await B.evaluate(() => game.cosmetics.set('car', { body: '#2a6bff', trim: '#ffd23a' }));
await wait(1500);
r = (await remotesOf(A))[0]; console.log('  B repainted:', JSON.stringify(r));
check(r?.body === '#2a6bff', 'B\'s new paint reached A (needs net.js to send skin on change)');
await shot(A, 'a-sees-b-repainted');
await place(B, X + 120, Z - 60, 0);
await wait(1500);
await shot(A, 'a-corner-map', { x: 1280 - 260, y: 0, width: 260, height: 260 });
await A.evaluate(() => { game.minimap.toggle(true); document.querySelector('#fullmap [data-z="car"]').click(); });
await wait(800); await shot(A, 'a-full-map');
await A.evaluate(() => game.minimap.toggle(false));
await place(B, X, Z + 20, Math.PI); await wait(1500); await shot(B, 'b-sees-a');

// B leaves: A drops it
await B.evaluate(async () => { const { mp } = await import('./src/mp/net.js'); mp.leave(); });
await wait(1500);
check((await remotesOf(A)).length === 0, 'B gone from A after leaving');
await B.browserContext().close();                   // only A renders from here, so the timings are A's alone

// Full-game frame cost, 0 vs 15 remotes: same spot, same fixed camera, 10 s each (0, then 15, then 0 again).
// Fails if the median frame time with 15 remotes is more than 2 ms above the average of the two 0-remote medians.
await A.bringToFront();
await place(A, X, Z, 0);
await A.evaluate(async (X, Z) => {
  const g = game, car = g.vehicles.current, sleep = ms => new Promise(r => setTimeout(r, ms));
  car.step = () => {}; g.keys.clear(); car.vel.set(0, 0, 0);       // parked: physics can't change the picture
  const y = g.world.heightAt(X, Z), render = g.renderer.render;
  g.renderer.render = function (scene, cam) {
    if (cam === g.camera) { cam.position.set(X, y + 14, Z - 40); cam.up.set(0, 1, 0); cam.lookAt(X, y, Z + 60); cam.fov = 70; cam.updateProjectionMatrix(); cam.updateMatrixWorld(); }
    return render.call(this, scene, cam);
  };
  while (g.world.pendingTiles() > 0) await sleep(100);
  await sleep(2000);
}, X, Z);
const frames = (page, label) => page.evaluate(async () => {
  const ts = []; let last = performance.now(); const t0 = last;
  await new Promise(r => { const f = now => { ts.push(now - last); last = now; if (now - t0 < 10000) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f); });
  ts.shift(); ts.sort((a, b) => a - b);
  return { frames: ts.length, median: +ts[ts.length >> 1].toFixed(2), p95: +ts[Math.floor(ts.length * 0.95)].toFixed(2), remotes: game.remotes.count,
    calls: game.renderer.info.render.calls, tris: game.renderer.info.render.triangles, pendingTiles: game.world.pendingTiles() };
}).then(r => { console.log(`  ${label}:`, JSON.stringify(r)); return r; });
const base1 = await frames(A, '0 remotes ');
await A.evaluate(async (X, Z) => {
  const { mp } = await import('./src/mp/net.js'), kinds = ['car', 'bike', 'jet'], y = game.world.heightAt(X, Z), start = performance.now();
  window.__fakes = setInterval(() => {                 // 15 players at 15 Hz on circles 20-244 m around the spot
    const t = (performance.now() - start) / 1000;
    for (let i = 0; i < 15; i++) {
      const a = t * 0.4 + i * 0.42, rad = 20 + i * 16, yaw = a + Math.PI / 2, k = kinds[i % 3];
      game.remotes.receive({ t: 'state', from: 'fake' + i, srvT: mp.now(), v: k, glide: i === 3, p: [X + rad * Math.sin(a), y + (k === 'jet' ? 40 : i === 3 ? 12 : 0.6), Z + 60 + rad * Math.cos(a)],
        q: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], vel: [rad * 0.4 * Math.cos(a), 0, -rad * 0.4 * Math.sin(a)], ts: mp.now() });
    }
  }, 66);
}, X, Z);
await wait(3000);                                      // every model built once before timing
const loaded = await frames(A, '15 remotes');
const st = await A.evaluate(() => ({ ...game.remotes.stats }));
console.log('  remotes.update', st.ms.toFixed(3), 'ms avg (model builds excluded):', JSON.stringify(st));
await shot(A, 'a-15-remotes');
await A.evaluate(() => { game.minimap.toggle(true); document.querySelector('#fullmap [data-z="car"]').click(); }); await wait(800);
await shot(A, 'a-15-remotes-full-map');
await A.evaluate(() => { clearInterval(window.__fakes); game.minimap.toggle(false); for (let i = 0; i < 15; i++) game.remotes.receive({ t: 'left', id: 'fake' + i }); });
await wait(1500);
const base2 = await frames(A, '0 remotes again');
const baseMedian = (base1.median + base2.median) / 2, grow = loaded.median - baseMedian;
console.log(`frame time median: 0 remotes ${baseMedian.toFixed(2)} ms (${base1.median} / ${base2.median}), 15 remotes ${loaded.median} ms → +${grow.toFixed(2)} ms; p95 ${base1.p95} / ${base2.p95} → ${loaded.p95}`);
check(loaded.remotes === 15 && st.visible === 15 && base1.remotes === 0 && base2.remotes === 0, '0 vs 15 remotes measured');
check(grow <= 2, `15 remotes add ≤ 2 ms to the median frame (+${grow.toFixed(2)} ms)`);
check(st.ms < 1, 'remotes.update under 1 ms per frame');
check(errors.length === 0, `no page errors (${errors.length})`);
await browser.close();
console.log(failures.length ? `FAILED: ${failures.join('; ')}` : 'PASS mp remotes shots');
process.exit(failures.length ? 1 : 0);
