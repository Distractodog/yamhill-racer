// Jet ski + speedboat screenshots in a real browser (director-run; needs Chrome and the game server):
//   node tools/boat_shots.mjs [out dir | --out dir] [--game http://127.0.0.1:8173/]
// Starts tools/serve.py on 8173 if nothing is listening there. Start-up via tools/lib/startgame.mjs (campus spawn).
// Shots: the V picker with both boats in it; per boat (jet ski, speedboat): picked on land at campus (it should start
// on the nearest pond / river), at full speed on the South Yamhill at Sheridan (chase camera, spray + wake), in a hard
// turn (lean / bank), from the side at speed, and beached on the river bank; a launch from campus to the nearest launch
// spot (tiles stream in during the hold) and back to the car (on the bank); then both in the Garage (repainted).
// Prints the boat state per shot, median frame time while driving, and page errors; exits nonzero on page errors
// or failed checks. The images need looking at.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { GAME_URL, startGame, holdCar, watchErrors, CAMPUS } from './lib/startgame.mjs';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const GAME = opt('--game', GAME_URL), outOption = opt('--out', null), OUT = outOption || args[0] || 'boat-shots';
const RIVER = { x: 3700, z: 1344, yaw: -Math.PI / 2 };          // South Yamhill just east of Bridge Street, heading west
fs.mkdirSync(OUT, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
const failures = [], errors = [], children = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
const portOpen = port => new Promise(r => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
const port = +new URL(GAME).port || 80;
if (!(await portOpen(port))) {
  console.log(`game server: starting tools/serve.py ${port} game`);
  children.push(spawn('python3', ['tools/serve.py', String(port), 'game'], { stdio: ['ignore', 'ignore', 'inherit'] }));
  for (let i = 0; i < 100 && !(await portOpen(port)); i++) await wait(100);
}
process.on('exit', () => children.forEach(c => c.kill()));

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--window-size=1280,800', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
watchErrors(page, 'game', errors);
page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.location()?.url || '')) console.log('console error', m.text()); });
const shot = async name => { const file = path.join(OUT, name + '.png'); await page.screenshot({ path: file }); console.log('  shot', file); };
const state = () => page.evaluate(() => {
  const b = game.vehicles.current, lv = game.world.waterLevelAt(b.pos.x, b.pos.z);
  return { kind: b.kind, kmh: Math.round(b.vel.length() * 3.6), mode: b.mode, onWater: b.onWater, x: Math.round(b.pos.x), z: Math.round(b.pos.z),
    aboveWater: Number.isFinite(lv) ? +(b.pos.y - lv).toFixed(2) : null, lean: +(b.lean * 57.3).toFixed(1), pitch: +(b.pitch * 57.3).toFixed(1),
    hud: document.getElementById('veh-line')?.textContent || '', msg: document.getElementById('veh-msg')?.textContent || '' };
});
const keys = (add, del = []) => page.evaluate((add, del) => { del.forEach(k => game.keys.delete(k)); add.forEach(k => game.keys.add(k)); }, add, del);
// frame times over `ms` while whatever is held keeps driving
const frames = ms => page.evaluate(ms => new Promise(done => {
  const t = []; let last = performance.now(); const end = last + ms;
  const f = now => { t.push(now - last); last = now; if (now < end) requestAnimationFrame(f); else { t.sort((a, b) => a - b); done({ median: t[t.length >> 1], p95: t[Math.floor(t.length * 0.95)], n: t.length }); } };
  requestAnimationFrame(f);
}), ms);

await startGame(page, { url: GAME });

// ---- V picker lists both boats
await page.keyboard.press('KeyV'); await wait(300);
const items = await page.$$eval('#veh-menu .veh-name', els => els.map(e => e.textContent));
check(items.includes('Jet ski') && items.includes('Speedboat'), `V picker lists the boats (${items.join(', ')})`);
await shot('00-vehicle-picker');
await page.keyboard.press('Escape');

for (const [kind, n] of [['jetski', 4], ['boat', 5]]) {
  console.log(`\n== ${kind}`);
  // picked on land at campus with the number key: starts on the nearest water
  await holdCar(page, { ...CAMPUS, kind: 'car' });
  await page.keyboard.press('KeyV'); await wait(200); await page.keyboard.press(`Digit${n}`); await wait(1500);
  let s = await state(); console.log(' ', JSON.stringify(s));
  check(s.kind === kind && s.onWater, `${kind}: picked at campus, starts on the water ${Math.round(Math.hypot(s.x - CAMPUS.x, s.z - CAMPUS.z))} m away`);
  await shot(`${kind}-01-picked-at-campus`);

  // full throttle west along the South Yamhill
  await holdCar(page, { ...RIVER, kind });
  await page.evaluate(() => game.setCam(0));
  await keys(['KeyW']);
  const ft = await frames(4500);
  s = await state(); console.log(' ', JSON.stringify(s), 'frames', JSON.stringify(ft));
  check(s.onWater && s.kmh > 70, `${kind}: at speed on the river (${s.kmh} km/h)`);
  await shot(`${kind}-02-speed-chase`);
  // hard turn (left: the river bends that way past the bridge), then a far chase camera
  await holdCar(page, { ...RIVER, kind }); await keys(['KeyW']); await wait(3500);
  await keys(['KeyA']); await wait(700);
  s = await state(); console.log(' ', JSON.stringify(s));
  check(Math.abs(s.lean) > (kind === 'jetski' ? 15 : 4), `${kind}: leans / banks in the turn (${s.lean}°)`);
  await shot(`${kind}-03-turn`);
  await keys([], ['KeyA', 'KeyW']);
  // side view at speed: camera parked on the north bank looking south across the river
  await holdCar(page, { ...RIVER, kind }); await keys(['KeyW']); await wait(3000);
  await page.evaluate(() => { game.setCam(1); }); await wait(900);
  await shot(`${kind}-04-speed-far-chase`);
  await keys([], ['KeyW']); await page.evaluate(() => game.setCam(0));

  // beached: head across the river onto the low bank (same search as tools/boat_test.mjs), then let go
  await holdCar(page, { x: RIVER.x, z: RIVER.z, yaw: 0, kind });
  const bh = await page.evaluate(() => {
    const W = game.world, b = game.vehicles.current, water = (x, z) => { const w = W.waterLevelAt(x, z); return w > W.terrainAt(x, z) ? w : -Infinity; };
    const lv = water(b.pos.x, b.pos.z); let best = null;
    for (let a = 0; a < Math.PI * 2; a += 0.05) {
      let r = 0; while (r < 200 && water(b.pos.x + Math.sin(a) * r, b.pos.z + Math.cos(a) * r) > -Infinity) r++;
      if (r < 25 || r > 120) continue;
      const bx = b.pos.x + Math.sin(a) * (r + 12), bz = b.pos.z + Math.cos(a) * (r + 12);
      let trees = 0; for (let k = 0; k <= 16; k += 4) W.treesNear(b.pos.x + Math.sin(a) * (r + k), b.pos.z + Math.cos(a) * (r + k), 4, () => trees++);
      const houses = W.buildingsNear(bx, bz, 30).some(h => h.pts.some(([px, pz]) => Math.hypot(px - bx, pz - bz) < 30));
      if (W.heightAt(bx, bz) - lv > 2.5 || trees || houses) continue;
      if (!best || r > best[1]) best = [a, r];
    }
    if (best) { b.yaw = best[0]; b.setQuat(); b.afterReset(); }
    return best;
  });
  check(!!bh, `${kind}: found a low bank to beach on`);
  await keys(['KeyW']);
  await page.waitForFunction(() => game.vehicles.current.mode === 'land', { timeout: 20000 }).catch(() => {});
  await keys([], ['KeyW']); await wait(3000);
  s = await state(); console.log(' ', JSON.stringify(s));
  check(s.mode === 'land' && s.kmh < 2, `${kind}: beached and stopped (${s.hud})`);
  await shot(`${kind}-05-beached`);
  await page.evaluate(() => game.setCam(1)); await wait(600);
  await shot(`${kind}-06-beached-far`);
  await page.evaluate(() => game.setCam(0));
  // S pushes it back in
  await keys(['KeyS']);
  await page.waitForFunction(() => game.vehicles.current.onWater && game.vehicles.current.mode === 'water', { timeout: 30000 }).catch(() => {});
  await keys([], ['KeyS']);
  s = await state(); console.log(' ', JSON.stringify(s));
  check(s.onWater, `${kind}: S pushed it back into the water`);
  // R puts it back on open water
  await page.keyboard.press('KeyR'); await wait(800);
  s = await state(); check(s.onWater, `${kind}: R puts it on the water`);
}

// ---- launch started, then straight back to the car before it gets there: launch cancelled, car back at campus, dry.
// Precondition set up here: the boat is held for the launch spot farthest from campus (tens of km: never loaded in this
// page), and that is checked to be still unloaded and still pending right before switching back.
console.log('\n== launch cancelled');
await holdCar(page, { ...CAMPUS, kind: 'car' });
const before = await state();
const far = await page.evaluate(async () => {
  const { LAUNCH_SPOTS } = await import('./src/boat.js');
  game.vehicles.switchTo('jetski'); const b = game.vehicles.current;
  const L = LAUNCH_SPOTS.reduce((a, c) => Math.hypot(c.x - b.pos.x, c.z - b.pos.z) > Math.hypot(a.x - b.pos.x, a.z - b.pos.z) ? c : a);
  b.holdAt(L, () => b.reset(L.x, L.z, null, { launch: false }));   // what launchFrom does, aimed at the far spot
  return { x: L.x, z: L.z, km: +(Math.hypot(L.x - b.pos.x, L.z - b.pos.z) / 1000).toFixed(1) };
});
await wait(100);
const pending = await page.evaluate((x, z) => !!game.vehicles.jetski.launching && game.vehicles.current === game.vehicles.jetski && !game.world.loadedAt(x, z), far.x, far.z);
check(pending, `precondition: jet ski held for the far launch spot ${far.x},${far.z}, still unloaded`);
await page.keyboard.press('KeyV'); await page.keyboard.press('Digit1');
await page.waitForFunction(() => game.vehicles.current.kind === 'car', { timeout: 30000 }).catch(() => {});
await wait(1500);
let back = await state(); console.log(' ', JSON.stringify(far), JSON.stringify(back));
const backDry = await page.evaluate(() => { const c = game.vehicles.current, w = game.world.waterLevelAt(c.pos.x, c.pos.z); return !(w > game.world.terrainAt(c.pos.x, c.pos.z)) && c.pos.y > game.world.heightAt(c.pos.x, c.pos.z) - 0.3; });
check(pending && back.kind === 'car' && Math.hypot(back.x - before.x, back.z - before.z) < 5 && backDry && !(await page.evaluate(() => game.vehicles.jetski.launching)),
  'jet ski launch cancelled by switching back: the car is where it was, on dry ground');
await shot('launch-00-cancelled-car-back');

// ---- no water loaded near: launch (what reset() does then) from campus to the nearest launch spot, with streaming
console.log('\n== launch spot');
await holdCar(page, { ...CAMPUS, kind: 'jetski' });
const launch = await page.evaluate(async () => {
  const b = game.vehicles.current, t0 = performance.now(); b.launchFrom(b.pos.x, b.pos.z);
  const msg = b.msg; await b.launchDone; return { msg, ms: Math.round(performance.now() - t0) };
});
await wait(1500);
let ls = await state(); console.log(' ', JSON.stringify(launch), JSON.stringify(ls));
check(ls.onWater && Math.hypot(ls.x - 3694, ls.z - 1350) < 60, `launched to the South Yamhill at Sheridan after ${launch.ms} ms`);
await shot('launch-01-at-sheridan');
// ---- leaving the boat: V → car puts the car on the nearest bank, facing away from the water
await page.keyboard.press('KeyV'); await wait(200); await page.keyboard.press('Digit1'); await wait(1500);
ls = await state(); console.log(' ', JSON.stringify(ls));
const dry = await page.evaluate(() => {
  const c = game.vehicles.current, W = game.world;
  if (c.kind !== 'car') return false;
  return c.wheels.every(wh => {
    const p = wh.mount.clone().applyQuaternion(c.quat).add(c.pos);
    for (let dx = -3; dx <= 3; dx += 0.5) for (let dz = -3; dz <= 3; dz += 0.5) {
      if (dx * dx + dz * dz > 9) continue;
      if (!W.loadedAt(p.x + dx, p.z + dz) || Number.isFinite(W.waterLevelAt(p.x + dx, p.z + dz))) return false;
    }
    return true;
  });
});
check(ls.kind === 'car' && dry, 'jet ski → car: the car is on the bank, not in the river');
await shot('launch-02-car-on-bank');

// ---- Garage: both boats, repainted
for (const kind of ['jetski', 'boat']) {
  await page.evaluate(() => game.garage.show()); await wait(400);
  await page.click(`#cosmetic-garage [data-kind="${kind}"]`); await wait(500);
  await shot(`garage-${kind}`);
  await page.evaluate(k => game.cosmetics.set(k, { body: '#7a2bd6', trim: '#29d17a', livery: 'number', number: '42' }), kind); await wait(500);
  await shot(`garage-${kind}-repainted`);
  const shown = await page.$$eval('#cosmetic-garage .garage-colors label[data-role]', ls => ls.filter(l => !l.hidden).map(l => l.dataset.role));
  check(!shown.includes('wheels') && shown.includes('jacket'), `garage ${kind}: rider colours shown, no wheel colours (${shown.join(', ')})`);
  await page.evaluate(k => game.cosmetics.reset(k), kind);
  await page.evaluate(() => game.garage.close());
}

await browser.close();
if (errors.length) console.log('\nPAGE ERRORS:\n' + errors.join('\n'));
console.log(failures.length || errors.length ? `\nFAIL boat_shots: ${failures.length} check(s), ${errors.length} page error(s)` : '\nPASS boat_shots (look at the images)');
process.exit(failures.length || errors.length ? 1 : 0);
