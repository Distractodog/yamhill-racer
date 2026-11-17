// Director: with game/ served at http://127.0.0.1:8173, run through the heavy gate:
// node tools/wind_shots.mjs --out /tmp/yr-wind
// Review PNGs for readable wind HUD and circling/flapping birds. No server is started here.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import { startGame, watchErrors } from './lib/startgame.mjs';
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = values.out || '/tmp/yr-wind';
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const errors = [], report = { shots: {} };
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
  watchErrors(page, 'wind', errors); await startGame(page);
  await page.waitForFunction(() => game.warmup.done, { timeout: 60000 });
  const column = await page.evaluate(() => {
    const g = game;
    g.wind.follow({ seed: 42, time: 700 });
    g.atmosphere.speed = 0; g.atmosphere.set({ cycle: true, weather: 'clear' }, false); g.atmosphere.jump('day'); g.atmosphere.update(0, g.camera);
    const p = g.car.pos;
    return g.wind.columnsNear(p.x, p.z, 1800).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
  });
  assert(column, 'a loaded open field must have a thermal (seed 42)'); report.column = column;
  async function place(type) {
    await page.evaluate(({ c, type }) => {
      const g = game; g.keys.clear(); g.glider.cancel(); g.bikeGlider.cancel();
      g.vehicles.choose(type === 'glider' ? 'car' : type === 'bikeglider' ? 'bike' : 'jet', ['glider', 'bikeglider'].includes(type) ? null : type);
      const v = g.vehicles.current; v.reset(c.x, c.z - 100, 0);
      if (v.kind === 'jet') v.placeInAir(c.x, c.ground + 110, c.z - 100, 0, type === 'prop' ? 120 : 160);
      else { v.pos.y = c.ground + 110; v.vel.set(0, 0, 35); v.grounded = false; v.airTime = 1; v.glide.deploy(); }
      v.savePrev(); g.setCam(0);
    }, { c: column, type });
  }
  async function shot(name) {
    const state = await page.evaluate(async () => {
      const frames = []; let last = performance.now();
      await new Promise(done => { const start = last; function tick(now) { frames.push(now - last); last = now; if (now - start < 1100) requestAnimationFrame(tick); else done(); } requestAnimationFrame(tick); });
      frames.sort((a, b) => a - b);
      const g = game, p = g.car.pos;
      return { seed: g.wind.seed, time: g.wind.time, phase: g.atmosphere.phase, rain: g.atmosphere.rain,
        active: g.wind.active, thermalActive: g.wind.thermalActive, columns: g.windView.columns.length,
        hud: document.getElementById('wind-hud').textContent, hudHidden: document.getElementById('wind-hud').hidden,
        wind: { ...g.wind.sample(p.x, p.y, p.z) }, mode: g.car.mode, vehicle: g.car.kind,
        frameMedian: frames[Math.floor(frames.length * .5)], frameP95: frames[Math.floor(frames.length * .95)],
        over33: frames.filter(t => t > 33).length / frames.length * 100 };
    });
    report.shots[name] = state; console.log(name, state); await page.screenshot({ path: `${out}/${name}.png` }); return state;
  }
  for (const type of ['glider', 'bikeglider', 'prop', 'stunt', 'heli']) {
    await place(type); const s = await shot(`sunny-${type}`);
    assert(s.thermalActive && s.columns > 0 && !s.hudHidden && /Wind \d+ km\/h/.test(s.hud));
  }
  await place('glider');
  await page.evaluate(() => { game.atmosphere.set({ weather: 'rain' }, false); game.atmosphere.update(1, game.camera); });
  const rain = await shot('rain'); assert(!rain.thermalActive && rain.columns === 0 && rain.wind.y === 0);
  await page.evaluate(() => { game.atmosphere.set({ weather: 'clear' }, false); game.atmosphere.jump('night'); });
  const night = await shot('night'); assert(!night.thermalActive && night.columns === 0);
  await page.evaluate(() => { game.atmosphere.jump('day'); game.wind.enabled = false; });
  const off = await shot('wind-disabled'); assert(!off.active && off.hudHidden && off.columns === 0 && off.wind.speed === 0);
  // Start a real race (including its placing/countdown), and verify the race gate on the shared controller.
  await page.evaluate(() => { game.wind.enabled = true; game.challenges.start(0); });
  const race = await shot('race-calm'); assert(!race.active && race.hudHidden && race.columns === 0 && race.wind.speed === 0);
  assert.equal(errors.length, 0, errors.join('\n'));
} finally {
  report.errors = errors; await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); await browser.close();
}
console.log(`PASS: wind/thermals browser state checks; review ${out}/*.png`);
