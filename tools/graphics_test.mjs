// Director: serve game/ at YR_URL (default http://127.0.0.1:8173), then run through the heavy gate:
//   node tools/graphics_test.mjs --out /tmp/yr-graphics [--seconds 15] [--dpr 2] [--only campus] [--no-auto]
// Settings → Graphics in the real game (graphics.js, graphicsapply.js). The same drive (car held to a straight line
// from a fixed start at ≤ 60 km/h, `--seconds` long) on the campus Main Building drive and McMinnville NE 3rd St at
// Low, Medium and High, switched in the running game (no reload): per run median / p95 frame ms, % over 20 ms,
// triangles, draw calls, metres driven, the frames right after the switch (worst ms, shader programs compiled) and
// what the level set (pixel ratio, shadows, camera far, fog far, world detail); a screenshot at the start and at the
// end of each drive. Then the Settings → Graphics section (screenshot; a click on Low applies it), and Auto on a fresh
// browser profile: the guess, ~5 s of driving measured, the pick saved to yr-graphics-2. Fails on page errors, a
// level not applied, or Auto not picking. Prints WARN when a lower level draws more triangles than a higher one.
// --dpr sets the screen's devicePixelRatio (2 = Retina: Low then renders at 1, Medium at 1.25, High at 1.5). Review the PNGs.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import { startGame, holdCar, watchErrors } from './lib/startgame.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' }, seconds: { type: 'string' }, dpr: { type: 'string' }, only: { type: 'string' }, 'no-auto': { type: 'boolean' } } });
const out = values.out || '/tmp/yr-graphics', seconds = Number(values.seconds) || 15, dpr = Number(values.dpr) || 2;
const SPOTS = [
  { name: 'campus', label: 'Campus Main Building drive', x: -542, z: 440, yaw: 1.8 },
  { name: 'mcminnville', label: 'McMinnville NE 3rd St', x: 19451, z: -11032, yaw: -1.573 },
].filter(s => !values.only || values.only.split(',').some(w => s.name.includes(w)));
const LEVELS = ['low', 'medium', 'high'];
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const errors = [], report = { seconds, dpr, runs: [], settings: null, auto: null };
const wait = ms => new Promise(r => setTimeout(r, ms));
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] : NaN; };

// in the page: hold W to ≤ 60 km/h and steer back onto the line through (x, z) along yaw; frame times, triangles and
// draw calls of every frame for `ms`
const drive = (page, spot, ms) => page.evaluate(async (spot, ms) => {
  const g = game, car = g.vehicles.current, keys = g.keys, fx = Math.sin(spot.yaw), fz = Math.cos(spot.yaw);
  const x0 = car.pos.x, z0 = car.pos.z, dts = [], tris = [], calls = [];
  let last = performance.now(), t0 = last, first = true, pwm = 0;
  await new Promise(done => {
    const tick = now => {
      if (!first) { dts.push(now - last); tris.push(g.renderer.info.render.triangles); calls.push(g.renderer.info.render.calls); }
      first = false; last = now;
      const dx = car.pos.x - spot.x, dz = car.pos.z - spot.z, left = dx * fz - dz * fx;    // + = left of the line
      const f = { x: 0, z: 1 }, q = car.quat;
      f.x = 2 * (q.x * q.z + q.w * q.y); f.z = 1 - 2 * (q.x * q.x + q.y * q.y);
      let head = Math.atan2(f.x, f.z) - spot.yaw; head = Math.atan2(Math.sin(head), Math.cos(head));   // + = pointing left
      const steer = Math.max(-1, Math.min(1, left * 0.08 + head * 2.5));                    // + = steer right
      keys.delete('KeyA'); keys.delete('KeyD');
      pwm += Math.abs(steer);
      if (pwm >= 1) { pwm -= 1; keys.add(steer > 0 ? 'KeyD' : 'KeyA'); }
      if (Math.hypot(car.vel.x, car.vel.z) < 16.7) keys.add('KeyW'); else keys.delete('KeyW');
      if (now - t0 < ms) requestAnimationFrame(tick); else { keys.clear(); done(); }
    };
    requestAnimationFrame(tick);
  });
  return { dts, tris, calls, metres: Math.hypot(car.pos.x - x0, car.pos.z - z0), end: [Math.round(car.pos.x), Math.round(car.pos.z)] };
}, spot, ms);

// switch level in the running game; the next 20 frames' worst interval and new shader programs
const switchTo = (page, level) => page.evaluate(async level => {
  const g = game, programs = () => g.renderer.info.programs.length, before = programs(), dts = [];
  const t0 = performance.now(); g.graphics.set(level); const setMs = performance.now() - t0;
  let last = performance.now();
  for (let i = 0; i < 20; i++) await new Promise(r => requestAnimationFrame(now => { dts.push(now - last); last = now; r(); }));
  const fog = g.scene.fog;
  return { setMs, worstMs: Math.max(...dts), programsBefore: before, programsAfter: programs(), level: g.graphics.level, mode: g.graphics.mode,
    pixelRatio: g.renderer.getPixelRatio(), shadows: g.renderer.shadowMap.enabled && g.sun.castShadow, shadowMap: g.sun.shadow.mapSize.x,
    cameraFar: Math.round(g.camera.far), fog: [Math.round(fog.near), Math.round(fog.far)], detail: g.world.graphicsDetail(),
    saved: JSON.parse(localStorage.getItem('yr-graphics-2') || 'null') };
}, level);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: dpr });
  watchErrors(page, 'graphics', errors);
  await startGame(page, { storage: { 'yr-graphics-2': JSON.stringify({ mode: 'high', auto: null }) } });
  await page.waitForFunction(() => game.warmup.done, { timeout: 120000 });
  await page.evaluate(() => { game.atmosphere.speed = 0; game.atmosphere.setPreset('midday', false); });   // the same light in every shot

  for (const spot of SPOTS) for (const level of LEVELS) {
    const sw = await switchTo(page, level);
    assert.equal(sw.level, level); assert.equal(sw.mode, level); assert.equal(sw.saved?.mode, level, 'saved per browser');
    assert.equal(sw.pixelRatio, level === 'low' ? 1 : Math.min(dpr, level === 'medium' ? 1.25 : 1.5), `${level}: pixel ratio`);
    assert.equal(sw.shadows, level !== 'low', `${level}: shadows`);
    if (level !== 'low') assert.equal(sw.shadowMap, level === 'high' ? 2048 : 1024);
    await holdCar(page, { x: spot.x, z: spot.z, yaw: spot.yaw, kind: 'car' });
    await page.waitForFunction(() => game.world.pendingTiles() === 0, { timeout: 120000 });
    await wait(2000);
    await page.screenshot({ path: `${out}/${spot.name}-${level}-start.png` });
    const d = await drive(page, spot, seconds * 1000);
    await page.screenshot({ path: `${out}/${spot.name}-${level}-drive.png` });
    const run = { spot: spot.name, level, medianMs: +pct(d.dts, .5).toFixed(2), p95Ms: +pct(d.dts, .95).toFixed(2),
      over20: +(100 * d.dts.filter(t => t > 20).length / d.dts.length).toFixed(1), frames: d.dts.length,
      tris: Math.round(pct(d.tris, .5)), calls: Math.round(pct(d.calls, .5)), metres: Math.round(d.metres), end: d.end,
      switch: { setMs: +sw.setMs.toFixed(2), worstMs: +sw.worstMs.toFixed(1), newPrograms: sw.programsAfter - sw.programsBefore },
      applied: { pixelRatio: sw.pixelRatio, shadows: sw.shadows, shadowMap: sw.shadowMap, cameraFar: sw.cameraFar, fog: sw.fog, detail: sw.detail } };
    report.runs.push(run);
    console.log(`${spot.label.padEnd(28)} ${level.padEnd(6)} median ${String(run.medianMs).padStart(6)} ms  p95 ${String(run.p95Ms).padStart(6)} ms  >20ms ${String(run.over20).padStart(5)}%  ` +
      `tris ${String(run.tris).padStart(8)}  calls ${String(run.calls).padStart(4)}  ${run.metres} m  switch worst ${run.switch.worstMs} ms, +${run.switch.newPrograms} programs`);
  }
  for (const spot of SPOTS) {
    const r = Object.fromEntries(report.runs.filter(x => x.spot === spot.name).map(x => [x.level, x]));
    if (r.low && r.medium && r.low.tris > r.medium.tris) console.log(`WARN ${spot.name}: Low draws more triangles than Medium`);
    if (r.medium && r.high && r.medium.tris > r.high.tris) console.log(`WARN ${spot.name}: Medium draws more triangles than High`);
    for (const x of Object.values(r)) if (x.metres < seconds * 8) console.log(`WARN ${spot.name} ${x.level}: drove only ${x.metres} m (blocked?) - see ${spot.name}-${x.level}-drive.png`);
  }

  // ---- Settings → Graphics: the section, and a click applies at once
  await page.evaluate(() => game.graphics.set('high'));
  await page.click('#settings-button'); await page.waitForSelector('#graphics-content', { visible: true });
  await page.evaluate(() => document.getElementById('graphics-content').scrollIntoView());
  const buttons = await page.$$eval('#graphics-modes button', bs => bs.map(b => [b.dataset.graphics, b.getAttribute('aria-pressed')]));
  assert.deepEqual(buttons, [['auto', 'false'], ['low', 'false'], ['medium', 'false'], ['high', 'true']], 'four buttons, High pressed');
  await page.screenshot({ path: `${out}/settings-high.png` });
  await page.click('[data-graphics="low"]');
  const clicked = await page.evaluate(() => ({ level: game.graphics.level, status: document.getElementById('graphics-status').textContent, pressed: document.querySelector('[data-graphics="low"]').getAttribute('aria-pressed') }));
  assert.equal(clicked.level, 'low'); assert.equal(clicked.pressed, 'true');
  await wait(300); await page.screenshot({ path: `${out}/settings-low.png` });
  report.settings = { buttons, clicked };
  await page.click('#settings-close');
  await page.close();

  // ---- Auto on a fresh profile entry: the guess, ~5 s of play measured, the pick saved
  if (!values['no-auto']) {
    const auto = await browser.newPage();
    await auto.setViewport({ width: 1280, height: 800, deviceScaleFactor: dpr });
    watchErrors(auto, 'auto', errors);
    await auto.evaluateOnNewDocument(() => { try { localStorage.removeItem('yr-graphics-2'); } catch {} });
    await startGame(auto, {});
    const start = await auto.evaluate(() => ({ mode: game.graphics.mode, level: game.graphics.level, measuring: game.graphics.measuring, cores: navigator.hardwareConcurrency }));
    assert.equal(start.mode, 'auto'); assert(start.measuring, 'a fresh browser measures');
    await auto.waitForFunction(() => game.warmup.done, { timeout: 120000 });
    await holdCar(auto, { x: SPOTS[0].x, z: SPOTS[0].z, yaw: SPOTS[0].yaw, kind: 'car' });
    const d = await drive(auto, SPOTS[0], 9000);
    const end = await auto.evaluate(() => ({ mode: game.graphics.mode, level: game.graphics.level, measuring: game.graphics.measuring, auto: game.graphics.auto,
      saved: JSON.parse(localStorage.getItem('yr-graphics-2') || 'null'), status: document.getElementById('graphics-status').textContent }));
    report.auto = { start, end, medianMs: +pct(d.dts, .5).toFixed(2) };
    console.log('auto', JSON.stringify(report.auto));
    assert(!end.measuring && end.auto && end.saved?.auto?.level === end.level, 'Auto picked and saved within 9 s of driving');
    await auto.screenshot({ path: `${out}/auto-${end.level}.png` });
    await auto.close();
  }
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify({ ...report, errors }, null, 1));
  await browser.close();
}
if (errors.length) { console.log('FAIL page errors', errors); process.exit(1); }
console.log(`PASS graphics_test: ${report.runs.length} runs; screenshots and report.json in ${out}`);
