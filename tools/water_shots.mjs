// WP-1 water in the real game (browser): car and dirt bike driving into a campus pond and the South Yamhill
// (~3694,1350) on the real map, with screenshots, HUD read-outs, page errors and frame times.
//   python3 tools/serve.py 8173 game        then        node tools/water_shots.mjs --out <dir> [--url http://127.0.0.1:8173/]
// Sites and run-ups are picked in Node from the committed tiles exactly as tools/water_test.mjs does (tools/lib/water.mjs).
// Per site and vehicle:
//   deep   — in at ~40 km/h, W held: shots on entry (splash / wading spray), floating, sinking, and back on the bank
//   skim   — in at 150 km/h from 8 m up the bank: a shot while planing (HUD 'SKIMMING')
//   shallow (pond edge only; the river banks are near-vertical) — wading out of 0.1–0.55 m of water: spray
// Driving uses the real keys (game.keys); the camera is the normal chase camera. Prints every shot with the HUD text,
// frame times per run (median / p95 / % over 20 ms, from requestAnimationFrame), page errors and console errors.
// Exit code 1 on page errors or a missing event (never wet, no sink, no bank respawn, no skim). The images need looking at.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { RIVER, deepestPond, approach } from './lib/water.mjs';
import { GAME_URL, startGame, holdCar, watchErrors } from './lib/startgame.mjs';

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, '')] = args[i + 1];
if (process.argv.includes('--sites')) opt.sites = true;      // just print the chosen spots (no browser)
if (!opt.out && !opt.sites) { console.log('usage: node tools/water_shots.mjs --out <dir> [--url http://127.0.0.1:8173/] | --sites'); process.exit(1); }
if (opt.out) fs.mkdirSync(opt.out, { recursive: true });

// ---------------------------------------------------------------- sites (Node, committed tiles)
const A = 'game/assets/', WJ = JSON.parse(fs.readFileSync(A + 'world.json')), W = makeWorld(WJ);
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const have = new Set(WJ.tiles.map(([a, b]) => a + ',' + b));
for (const [x, z] of [RIVER, [0, 0]]) {
  const cx = Math.floor((x + 1000) / 2000), cz = Math.floor((z + 1000) / 2000);
  for (let tz = cz - 1; tz <= cz + 1; tz++) for (let tx = cx - 1; tx <= cx + 1; tx++)
    if (have.has(tx + ',' + tz) && !W.has(tx, tz)) W.add(makeTileData(WJ, tx, tz, await readTileData(async f => ab(`${A}tiles/${tx}_${tz}/${f}`), WJ.packed)));
}
const depth = (x, z) => W.waterLevelAt(x, z) - W.heightAt(x, z), wet = (x, z) => W.waterLevelAt(x, z) > -Infinity;
const pond = deepestPond(W, 0, 0);
function shallowSpot([cx, cz]) {                 // as water_test.mjs: 0.1–0.55 m deep under the middle and 2 m around
  let best = null;
  for (let dz = -80; dz <= 80; dz++) for (let dx = -80; dx <= 80; dx++) {
    const x = cx + dx, z = cz + dz;
    if ([[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]].every(([a, b]) => { const d = depth(x + a, z + b); return d > 0.1 && d < 0.55; })
      && (!best || dx * dx + dz * dz < best.d2)) best = { x, z, d2: dx * dx + dz * dz };
  }
  if (!best) return null;
  let yaw = 0, R = 1e9;                         // face the nearest dry ground
  for (let a = 0; a < Math.PI * 2; a += 0.05) for (let r = 1; r < 60; r++) if (!wet(best.x + Math.sin(a) * r, best.z + Math.cos(a) * r)) { if (r < R) { R = r; yaw = a; } break; }
  return { x: best.x, z: best.z, yaw };
}
const SITES = [['pond', [pond.x, pond.z]], ['river', RIVER]].map(([id, c]) => {
  const ap = approach(W, c), ex = ap.x + Math.sin(ap.yaw) * ap.run, ez = ap.z + Math.cos(ap.yaw) * ap.run;
  return { id, c, ap, bank: { x: ex - Math.sin(ap.yaw) * 8, z: ez - Math.cos(ap.yaw) * 8, yaw: ap.yaw }, shallow: id === 'pond' ? shallowSpot(c) : null };
});
for (const s of SITES) console.log(`${s.id}: water at ${s.c.map(v => v.toFixed(0))} ${depth(...s.c).toFixed(1)} m deep · run-up from ${s.ap.x.toFixed(0)},${s.ap.z.toFixed(0)}` +
  ` heading ${(s.ap.yaw * 57.3 % 360).toFixed(0)}°${s.shallow ? ` · shallow spot ${s.shallow.x},${s.shallow.z}` : ''}`);
if (opt.sites) process.exit(0);

// ---------------------------------------------------------------- browser
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--window-size=1280,800', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const errors = [], missing = [];
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
watchErrors(page, 'water', errors);
page.on('console', m => { if (m.type() === 'error' && !/cloudflareinsights/.test(m.text() + (m.location()?.url || ''))) { errors.push('console: ' + m.text()); console.log('CONSOLE ERROR', m.text()); } });
await startGame(page, { url: opt.url || GAME_URL });
await page.evaluate(() => {
  game.challenges.quit?.();
  // frame times: every requestAnimationFrame delta while a run records
  const g = game; g._ft = []; g._ftOn = false; let last = performance.now();
  const tick = t => { if (g._ftOn) g._ft.push(t - last); last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
});

const state = () => page.evaluate(() => {
  const v = game.vehicles.current, hud = id => document.getElementById(id)?.textContent.trim() || '';
  return { x: v.pos.x, y: v.pos.y, z: v.pos.z, kmh: v.vel.length() * 3.6, waterDepth: v.waterDepth || 0, sub: v.waterSub || 0,
    wet: v.waterDepth > 0 || v.onWater || (v.waterSub || 0) > 0 || v.wheels.some(w => w.surf === 5 && w.contact),
    skimming: !!v.skimming, underT: v.underT || 0, sunk: !!v.sunk, flood: v.flood || 0,
    hud: [hud('info'), hud('veh-line'), hud('veh-msg')].filter(Boolean).join(' | ') };
});
const keys = (down, up = []) => page.evaluate((d, u) => { for (const k of u) game.keys.delete(k); for (const k of d) game.keys.add(k); }, down, up);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function shot(name, label, s) {
  const file = path.join(opt.out, `water-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  ${label.padEnd(8)} ${file} · ${s.kmh.toFixed(0)} km/h · water depth ${s.waterDepth.toFixed(2)} m · body in ${s.sub.toFixed(2)} · HUD: ${s.hud || '—'}`);
}
async function frames(name) {
  const ft = await page.evaluate(() => { const f = game._ft; game._ft = []; game._ftOn = false; return f; });
  if (!ft.length) return;
  const s = [...ft].sort((a, b) => a - b), q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  console.log(`  frames   ${ft.length} · median ${q(0.5).toFixed(1)} ms · p95 ${q(0.95).toFixed(1)} ms · over 20 ms ${(100 * ft.filter(t => t > 20).length / ft.length).toFixed(1)}%`);
}
// put the vehicle at p, wait for its tiles, start recording frames, give it speed kmh (+ along the bank's slope)
async function begin(kind, p, kmh, vy = 0) {
  await keys([], ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space']);
  await holdCar(page, { x: p.x, z: p.z, yaw: p.yaw, kind });
  await page.evaluate((kmh, yaw, vy) => { const v = game.vehicles.current; v.vel.set(Math.sin(yaw) * kmh / 3.6, vy, Math.cos(yaw) * kmh / 3.6); game._ft = []; game._ftOn = true; }, kmh, p.yaw, vy);
}
// poll until f(state) or timeout (game seconds don't matter: everything waits on the game's own state)
async function until(f, ms, everyTick = () => {}) {
  const t0 = Date.now();
  for (;;) { const s = await state(); if (f(s)) return s; if (Date.now() - t0 > ms) return null; await everyTick(s); await sleep(60); }
}

try {
  for (const site of SITES) for (const kind of ['car', 'bike']) {
    const tag = `${site.id}-${kind}`;
    // ---- deep: in at ~40 km/h holding W; float, sink, back on the bank
    console.log(`${tag} deep`);
    await begin(kind, { x: site.ap.x, z: site.ap.z, yaw: site.ap.yaw }, 40);
    await keys(['KeyW']);
    const hold = async s => { if (s.kmh > 45) await keys(['KeyS'], ['KeyW']); else await keys(['KeyW'], ['KeyS']); };   // brake down the bank
    let s = await until(s => s.wet, 30000, hold);
    if (!s) { missing.push(`${tag}: never reached the water`); await frames(tag); continue; }
    await keys(['KeyW'], ['KeyS']);
    const start = [s.x, s.z];
    await sleep(250); await shot(`${tag}-1-entry`, 'entry', await state());
    await sleep(1000); await shot(`${tag}-2-floating`, 'floating', await state());
    s = await until(s => s.underT > 0 || s.sunk || (s.sub > 0.3 && s.flood > 0.5) || Math.hypot(s.x - start[0], s.z - start[1]) > 60, 15000);
    if (s && Math.hypot(s.x - start[0], s.z - start[1]) <= 60) await shot(`${tag}-3-sinking`, 'sinking', s);
    else missing.push(`${tag}: never started sinking`);
    let last = s ? [s.x, s.z] : start;
    s = await until(s => { const j = Math.hypot(s.x - last[0], s.z - last[1]) > 6; last = [s.x, s.z]; return j && !s.wet; }, 20000);
    if (s) { await keys([], ['KeyW']); await sleep(500); await shot(`${tag}-4-bank`, 'bank', await state()); }
    else missing.push(`${tag}: never put back on the bank`);
    await frames(tag);

    // ---- skim: 150 km/h from 8 m up the bank, W held
    console.log(`${tag} skim`);
    const b = site.bank, ex = b.x + Math.sin(b.yaw) * 7, ez = b.z + Math.cos(b.yaw) * 7;
    await begin(kind, b, 150, (W.heightAt(ex, ez) - W.heightAt(b.x, b.z)) / 7 * 150 / 3.6);
    await keys(['KeyW']);
    s = await until(s => s.skimming, 6000);
    if (s) { await sleep(200); await shot(`${tag}-5-skimming`, 'skimming', await state()); }
    else missing.push(`${tag}: never skimmed`);
    await sleep(1500); await keys([], ['KeyW']);
    await frames(tag + ' skim');

    // ---- shallow: wading out of the pond's edge, W held
    if (site.shallow) {
      console.log(`${tag} shallow`);
      await begin(kind, site.shallow, 0);
      await keys(['KeyW']);
      s = await until(s => s.kmh > 12, 5000);
      if (s?.wet) await shot(`${tag}-6-wading`, 'wading', s); else missing.push(`${tag}: no wading shot (${s ? 'already out' : 'never moved'})`);
      await sleep(1500); await keys([], ['KeyW']);
      await frames(tag + ' shallow');
    }
  }
} finally {
  await browser.close();
}
for (const m of missing) console.log('MISSING', m);
for (const e of errors) console.log('PAGE ERROR', e);
console.log(errors.length || missing.length ? `FAIL: ${errors.length} page/console errors, ${missing.length} missing events` : 'done: no page errors, every event captured — now look at the images');
process.exit(errors.length || missing.length ? 1 : 0);
