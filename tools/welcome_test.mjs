// Headless check of the welcome card (needs the preview server on 127.0.0.1:8173): node tools/welcome_test.mjs <dir>
import puppeteer from 'puppeteer-core';
const OUT = process.argv[2] || '.';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760 });
const errs = []; page.on('pageerror', e => { errs.push(e.message); console.log('PAGE ERROR', e.message); });
const wait = ms => new Promise(r => setTimeout(r, ms));
const load = async () => { await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => window.game && !document.getElementById('loading'), { timeout: 120000 }); await wait(500); };
const shown = () => page.evaluate(() => !document.getElementById('welcome').hidden);
const speed = () => page.evaluate(() => Math.round(game.car.vel.length() * 3.6));
await page.goto('http://127.0.0.1:8173/', { waitUntil: 'load' });
await page.evaluate(() => { localStorage.removeItem('yr-welcome-hidden-1'); localStorage.removeItem('yr-vehicle-1'); });
await load();
console.log('1. first load: card shown', await shown());
await page.screenshot({ path: OUT + '/welcome.png' });
// keys don't drive while it's open
await page.keyboard.down('KeyW'); await wait(1200); await page.keyboard.up('KeyW');
console.log('2. held W 1.2 s with the card open: speed', await speed(), 'km/h, still shown', await shown());
for (const key of ['Enter', 'Escape', 'Space']) {
  await load();
  const before = await page.evaluate(() => game.challenges.state);
  await page.keyboard.press(key); await wait(600);
  console.log(`3. ${key}: closed ${!(await shown())}, speed ${await speed()} km/h, race ${before}→${await page.evaluate(() => game.challenges.state)}, race menu open ${await page.evaluate(() => game.challenges.menuOpen)}`);
}
await load();
await page.click('#welcome-start'); await wait(300);
console.log('4. button: closed', !(await shown()));
await page.keyboard.down('KeyW'); await wait(1000); await page.keyboard.up('KeyW');
console.log('   after closing, W drives: speed', await speed(), 'km/h');
await load();
console.log('5. reload without ticking the box: shown again', await shown());
await page.click('#welcome-hide'); await page.click('#welcome-start'); await wait(200);
await load();
console.log('6. after "don\'t show again" + reload: shown', await shown());
await page.click('#help-button'); await wait(300);
console.log('7. How to play? button still opens the panel:', await page.evaluate(() => !document.getElementById('settings-panel').hidden && !document.getElementById('help-content').hidden));
await page.evaluate(() => localStorage.removeItem('yr-welcome-hidden-1'));
console.log('page errors', errs.length);
await browser.close();
