// Headless screenshots of the running game: node tools/shot.mjs out.png [x z surfaceClass yaw cam]
import puppeteer from 'puppeteer-core';
const [out = 'shot.png', x, z, cls = '2', cam = '0'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760 });
page.on('pageerror', e => console.log('PAGE ERROR', e.message));
await page.goto('http://localhost:8173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game, { timeout: 60000 });
const fps = await page.evaluate(async (x, z, cls, cam) => {
  const g = window.game;
  if (x !== undefined) g.teleport(+x, +z, +cls);
  g.setCam?.(+cam);
  g.keys.add('KeyW'); await new Promise(r => setTimeout(r, 1800)); g.keys.delete('KeyW');
  await new Promise(r => setTimeout(r, 1200));
  return document.getElementById('info').textContent + ' tris ' + g.renderer.info.render.triangles;
}, x, z, cls, cam);
console.log(fps);
await page.screenshot({ path: out });
await browser.close();
