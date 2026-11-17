// Director: with game/ served on 127.0.0.1:8173, run through the heavy gate.
// node tools/switch_placement_shots.mjs /tmp/yr-switch-placement
// Review desktop/mobile Settings PNGs; checks each selection survives reload.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { startGame, openMenu, watchErrors } from './lib/startgame.mjs';
const out = process.argv[2] || '/tmp/yr-switch-placement';
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
});
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  watchErrors(page, 'switch placement', errors);
  await startGame(page);
  const settings = async () => {
    await openMenu(page);
    await page.click('#settings-button');
    await page.waitForSelector('#switch-placement', { visible: true });
  };
  await settings();
  assert.equal(await page.$eval('#switch-placement', el => el.value), 'open');
  for (const mode of ['paved', 'road', 'open']) {
    await page.select('#switch-placement', mode);
    await startGame(page);
    await settings();
    assert.equal(await page.$eval('#switch-placement', el => el.value), mode);
    await page.screenshot({ path: `${out}/settings-${mode}.png` });
  }
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/settings-mobile.png` });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS saved switch settings; review desktop/mobile PNGs');
} finally { await browser.close(); }
