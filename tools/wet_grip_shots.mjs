// Director: serve game/ at http://127.0.0.1:8173, then run through the heavy gate.
// node tools/wet_grip_shots.mjs --out /tmp/yr-wet-grip
// Review dry/rain/drying road screenshots and both revised help notes; JSON includes frame timings and errors.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import { startGame, openMenu, watchErrors } from './lib/startgame.mjs';
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = values.out || '/tmp/yr-wet-grip'; await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const errors = [], report = {};
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
  watchErrors(page, 'wet-grip', errors); await startGame(page);
  await page.waitForFunction(() => game.warmup.done, { timeout: 60000 });
  await page.evaluate(() => { game.atmosphere.speed = 0; game.atmosphere.jump('day'); game.atmosphere.set({ cycle: true, weather: 'clear' }, false); });
  const shot = name => page.screenshot({ path: `${out}/${name}.png` });
  for (const name of ['dry', 'rain', 'drying']) {
    await page.evaluate(name => {
      const a = game.atmosphere; a.set({ weather: name === 'rain' ? 'rain' : 'clear' }, false);
      // Advance moisture without changing the stopped day clock; leave real frames to render it below.
      if (name !== 'dry') for (let i = 0; i < (name === 'rain' ? 8 : 30); i++) a.update(1, game.camera);
    }, name);
    report[name] = await page.evaluate(async () => {
      const frames = []; let last = performance.now(), start = last;
      await new Promise(done => { function tick(now) { frames.push(now - last); last = now; if (now - start < 3000) requestAnimationFrame(tick); else done(); } requestAnimationFrame(tick); });
      frames.sort((a, b) => a - b);
      return { wetness: game.world.wetness, rain: game.atmosphere.rain, median: frames[Math.floor(frames.length * .5)],
        p95: frames[Math.floor(frames.length * .95)], slowPercent: frames.filter(n => n > 33).length / frames.length * 100 };
    });
    await shot(name);
  }
  assert.equal(report.dry.wetness, 0); assert.equal(report.rain.wetness, 1);
  assert(report.drying.wetness > .4 && report.drying.wetness < .65);
  await openMenu(page); await page.click('#settings-button');
  await page.waitForSelector('#atmosphere-content', { visible: true });
  await page.$eval('#atmosphere-content', el => el.scrollIntoView()); await shot('settings');
  assert((await page.$eval('#settings-panel', el => el.textContent)).includes('Roads get slippery in the rain'));
  await page.click('#settings-help'); await page.waitForSelector('#help-content', { visible: true });
  await page.$eval('#help-content', el => [...el.querySelectorAll('p')].find(p => p.textContent.includes('Roads get slippery')).scrollIntoView());
  await shot('how-to-play');
  assert.deepEqual(errors, []); report.errors = errors;
  await writeFile(`${out}/wet-grip.json`, JSON.stringify(report, null, 2)); console.log(report);
} finally { await browser.close(); }
