// Director: serve game/ at YR_URL (default 8173), then run through the heavy gate:
//   node tools/daynight_shots.mjs --out /tmp/yr-daynight [--speed 60]
// Day/night cycle + rain in the real game (?daySpeed): a fresh load starts at morning; screenshots at morning,
// midday, golden hour, rose dusk, night and rain (car turned toward the sun / moon), the Settings section (cycle on and
// off) and the ☰ Menu without Atmosphere; then one whole cycle at the accelerated speed (rain switched on half way)
// measuring frame times, atmosphere.update cost and three.js shader programs (must not change: no recompiles).
// Fails on page errors, a start that is not morning, an Atmosphere menu item, new shader programs during the cycle,
// or atmosphere.update over 0.5 ms at the 95th percentile. Review the PNGs.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import { GAME_URL, startGame, openMenu, watchErrors } from './lib/startgame.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' }, speed: { type: 'string' } } });
const out = values.out || '/tmp/yr-daynight', speed = Number(values.speed) || 60;
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const errors = [], report = { speed, shots: {} };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  watchErrors(page, 'daynight', errors);
  const url = new URL(GAME_URL); url.searchParams.set('daySpeed', String(speed));
  await startGame(page, { url: url.href });
  const start = await page.evaluate(() => ({ phase: game.atmosphere.phase, time: game.atmosphere.time, speed: game.atmosphere.speed, settings: game.atmosphere.settings }));
  console.log('start', start); report.start = start;
  assert.equal(start.phase, 'morning', 'a fresh load starts at morning'); assert.equal(start.speed, speed); assert.equal(start.settings.cycle, true);
  await page.waitForFunction(() => game.warmup.done, { timeout: 60000 });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = name => page.screenshot({ path: `${out}/${name}.png` });

  // ---- looks: clock stopped at a set time, the car turned toward the sun (by night the moon)
  await page.evaluate(() => { game.atmosphere.speed = 0; game.atmosphere.set({ weather: 'clear' }, false); });
  for (const [name, minutes, weather] of [['morning', 1, 'clear'], ['midday', 15, 'clear'], ['golden-hour', 25.5, 'clear'], ['dusk', 29.5, 'clear'], ['night', 40, 'clear'], ['rain', 15, 'rain'], ['night-rain', 40, 'rain']]) {
    const state = await page.evaluate(async (minutes, weather) => {
      const a = game.atmosphere; a.set({ weather }, false); a.jump(minutes * 60); a.update(0, game.camera);
      const c = game.vehicles.current, o = a.cycle.out, d = o.sunUp > .05 ? o.sun : o.moon;
      c.reset(c.pos.x, c.pos.z, Math.atan2(d[0], d[2])); c.vel.set(0, 0, 0); game.keys.clear();
      await new Promise(r => setTimeout(r, 1500));          // the chase camera settles behind the car
      return { phase: a.phase, time: Math.round(a.time), night: +a.night.toFixed(2), rain: a.rain, wetness: a.wetness, lightsOn: game.vehicleLights.on,
        fog: [Math.round(game.scene.fog.near), Math.round(game.scene.fog.far)], sun: +game.sun.intensity.toFixed(2), sunUp: +o.sunUp.toFixed(2), moonUp: +o.moonUp.toFixed(2), stars: +o.stars.toFixed(2) };
    }, minutes, weather);
    console.log(name, state); report.shots[name] = state; await shot(name);
  }
  assert(report.shots.night.lightsOn && report.shots.dusk.lightsOn && !report.shots.midday.lightsOn, 'headlights on at dusk and night, off at midday');
  assert(report.shots.rain.rain === 1 && report.shots.rain.wetness === .8);
  await page.evaluate(sp => { game.atmosphere.set({ weather: 'random' }, false); game.atmosphere.jump('morning'); game.atmosphere.speed = sp; }, speed);

  // ---- ☰ Menu: no Atmosphere item; Settings has the section (cycle on, then off with the fixed looks)
  await openMenu(page); await shot('menu');
  const items = await page.$$eval('#menu-panel > *', els => els.map(el => el.id));
  assert(!items.includes('atmosphere-button') && !(await page.$('#atmosphere-button')), `menu items ${items}`);
  await page.click('#settings-button'); await page.waitForSelector('#atmosphere-content', { visible: true });
  assert.equal(await page.$eval('#atmo-cycle', el => el.checked), true);
  await page.click('[data-time="dusk"]'); assert.equal(await page.evaluate(() => game.atmosphere.phase), 'dusk');
  await page.click('[data-time="morning"]');
  await shot('settings-cycle-on');
  await page.click('#atmo-cycle'); await page.waitForSelector('#atmosphere-presets', { visible: true });
  assert.equal(await page.evaluate(() => game.atmosphere.settings.cycle), false);
  await shot('settings-cycle-off');
  await page.click('#atmo-cycle'); await page.click('#settings-close');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('yr-atmo-2')).cycle), true, 'saved per browser');

  // ---- one whole cycle at the accelerated speed: frame times, atmosphere cost, shader programs
  const run = await page.evaluate(async () => {
    const g = game, a = g.atmosphere, cost = [], frames = [], phases = new Set();
    const programs = () => g.renderer.info.programs.length, before = programs();
    const update = a.update;
    a.update = function (...args) { const t0 = performance.now(); update.apply(this, args); cost.push(performance.now() - t0); };
    a.jump('morning'); const seconds = 3000 / a.speed;
    let last = performance.now(); const t0 = last, newPrograms = [];
    await new Promise(done => {
      const tick = now => {
        frames.push(now - last); last = now; phases.add(a.phase);
        if (programs() !== before && !newPrograms.length) newPrograms.push({ at: a.phase, time: Math.round(a.time), count: programs() });
        if (now - t0 > seconds * 500 && a.settings.weather !== 'rain') a.set({ weather: 'rain' }, false);    // rain over the second half
        if (now - t0 < seconds * 1000 + 500) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
    a.update = update; a.set({ weather: 'random' }, false);
    const q = (xs, p) => { const s = [...xs].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3); };
    return { seconds, frames: frames.length, frameMedian: q(frames, .5), frameP95: q(frames, .95), over33: +(frames.filter(f => f > 33).length / frames.length * 100).toFixed(1),
      atmosphereMedian: q(cost, .5), atmosphereP95: q(cost, .95), atmosphereMax: q(cost, 1), programsBefore: before, programsAfter: programs(), newPrograms, phases: [...phases] };
  });
  console.log('cycle run', run); report.run = run;
  assert.deepEqual(run.newPrograms, [], 'no shader compiled during the cycle');
  assert(run.atmosphereP95 <= .5, `atmosphere.update p95 ${run.atmosphereP95} ms`);
  assert.deepEqual(run.phases.sort(), ['day', 'dusk', 'morning', 'night']);
  assert.deepEqual(errors, []);
  await writeFile(`${out}/daynight.json`, JSON.stringify(report, null, 2));
  console.log(`PASS daynight shots → ${out}: starts at morning, ${Object.keys(report.shots).join(', ')}, menu, settings on/off, ${run.frames} frames over one cycle at ${speed}× (no new shader programs, atmosphere p95 ${run.atmosphereP95} ms)`);
} finally { await browser.close(); }
