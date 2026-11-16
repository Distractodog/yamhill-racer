// Director: serve game/ at YR_URL (default 8173), then run through the heavy gate:
// node tools/menu_shots.mjs /tmp/yr-menu
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { startGame, openMenu, watchErrors } from './lib/startgame.mjs';

const out = process.argv[2] || '/tmp/yr-menu';
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  watchErrors(page, 'menu', errors);
  await startGame(page);
  const shot = name => page.screenshot({ path: `${out}/${name}.png` });
  const closed = async () => assert.equal(await page.$eval('#menu-panel', el => el.hidden), true);
  await closed(); await shot('closed');
  await page.focus('#menu-button'); await page.keyboard.press('Space');
  assert.equal(await page.$eval('#menu-panel', el => el.hidden), false);
  await page.keyboard.press('Escape');
  await openMenu(page); await shot('open');
  assert.deepEqual(await page.$$eval('#menu-panel > *', items => items.map(el => el.id)),
    ['mp-button', 'garage-button', 'atmosphere-button', 'settings-button', 'help-button', 'suggest-button']);
  await page.keyboard.press('KeyW');
  assert.equal(await page.evaluate(() => game.keys.size), 0);
  await page.focus('#suggest-button'); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'menu-button');
  await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'suggest-button');
  await page.keyboard.press('Escape'); await closed(); await shot('escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'menu-button');
  await openMenu(page); await page.mouse.click(600, 500); await closed();
  for (const [item, panel, close] of [
    ['mp-button', '#mp-panel', '#mp-close'],
    ['garage-button', '#cosmetic-garage', '.garage-close'],
    ['atmosphere-button', '#atmosphere-content', '#settings-close'],
    ['settings-button', '#tuning-content', '#settings-close'],
    ['help-button', '#help-content', '#settings-close'],
  ]) {
    await openMenu(page); await page.click(`#${item}`); await closed();
    await page.waitForSelector(panel, { visible: true }); await shot(item);
    await page.click(close);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'menu-button');
  }
  await openMenu(page);
  assert.equal(await page.$eval('#suggest-button', el => el.target === '_blank' && el.href.startsWith('https://docs.google.com/forms/')), true);
  const popupTarget = browser.waitForTarget(target => target.opener() === page.target());
  await page.click('#suggest-button');
  const target = await popupTarget;
  await (await target.page())?.close(); await closed(); await shot('suggest-return');
  await page.setViewport({ width: 390, height: 844 });
  await openMenu(page); await shot('mobile-open');
  assert.equal(await page.$eval('#menu-panel', el => el.getBoundingClientRect().right <= innerWidth), true);
  await page.keyboard.press('Escape');
  const frames = await page.evaluate(async () => {
    const samples = []; let last = performance.now();
    for (let i = 0; i < 120; i++) { await new Promise(requestAnimationFrame); const now = performance.now(); samples.push(now - last); last = now; }
    return { fps: 1000 / (samples.reduce((a, b) => a + b) / samples.length), slow: samples.filter(ms => ms > 20).length / samples.length };
  });
  console.log('Frame sample:', frames);
  assert.deepEqual(errors, []);
  console.log('PASS: closed/open, all items, focus/Tab, game input filtering, Escape/outside click, new-tab form, mobile, no page errors');
} finally { await browser.close(); }
