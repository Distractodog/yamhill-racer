// Synthetic replay fixture for visual review; uses an isolated browser profile, not the user's saved best runs.
// Start tools/serve.py first. node tools/ghost_visual_test.mjs <output directory> [game URL]
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const out = process.argv[2] || 'ghost-results', url = process.argv[3] || 'http://127.0.0.1:8173/';
await mkdir(out, { recursive: true });
const report = { fixture: 'Synthetic stationary best-run poses for visual inspection, not race completion evidence', status: 'running', phases: [], pageErrors: [], visualReview: 'NOT REVIEWED' };
let browser;
try {
 browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
 const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 760 });
 page.on('pageerror', e => { report.pageErrors.push(e.message); console.error('PAGE ERROR', e.message); });
 await page.evaluateOnNewDocument(() => localStorage.setItem('yr-welcome-hidden-1', '1'));
 await page.goto(url, { waitUntil: 'load' }); await page.waitForFunction(() => window.game, { timeout: 120000 });
 const measure = () => page.evaluate(() => new Promise(done => {
  const frames = []; let start, last;
  const tick = now => { start ??= now; if (last !== undefined) frames.push(now - last); last = now;
   if (now - start < 3000) requestAnimationFrame(tick);
   else { const ms = frames.reduce((a, b) => a + b, 0); done({ fps: frames.length * 1000 / ms, slowFrames: frames.filter(t => t > 1000 / 30).length, frameTimesMs: frames }); }
  }; requestAnimationFrame(tick);
 }));
 for (const kind of ['car', 'bike', 'jet']) {
  const row = { kind, visualVerdict: 'NOT REVIEWED' }; report.phases.push(row);
  await page.evaluate(async kind => {
   const i = game.challenges.list.findIndex(c => (c.vehicle || 'car') === kind); if (i < 0) throw Error(`No ${kind} race`);
   const { GHOST_KEY } = await import('./src/ghost.js'); localStorage.removeItem(GHOST_KEY); await game.challenges.start(i);
  }, kind);
  await page.waitForFunction(() => game.challenges.state === 'running', { timeout: 120000 }); row.baseline = await measure();
  await page.evaluate(async kind => {
   const { ghostCourse, saveGhost } = await import('./src/ghost.js');
   const i = game.challenges.list.findIndex(c => (c.vehicle || 'car') === kind), ch = game.challenges.list[i];
   await game.challenges.start(i); const v = game.vehicles.current, yaw = ch.start.yaw;
   const x = v.pos.x + Math.cos(yaw) * 4 + Math.sin(yaw) * 8, z = v.pos.z - Math.sin(yaw) * 4 + Math.cos(yaw) * 8;
   const samples = Array.from({ length: 401 }, (_, n) => [n / 20, x, v.pos.y, z, ...v.quat.toArray()]);
   if (!saveGhost(localStorage, { course: ghostCourse(ch), kind, time: 20, samples })) throw Error('Failed to seed visual fixture');
  }, kind);
  await page.waitForFunction(() => game.challenges.state === 'running' && game.scene.children.some(o => o.name === 'race-ghost' && o.visible), { timeout: 15000 });
  row.withGhost = await measure(); row.screenshot = `${kind}-ghost.png`; await page.screenshot({ path: join(out, row.screenshot) });
  await page.evaluate(() => game.challenges.quit());
  if (await page.evaluate(() => game.scene.children.some(o => o.name === 'race-ghost'))) throw Error('Ghost leaked after quit');
 }
 report.status = report.pageErrors.length ? 'failed' : 'captured-awaiting-visual-review';
} catch (e) { report.status = 'blocked-or-failed'; report.error = e.message; console.error(e.message); }
finally { await browser?.close(); await writeFile(join(out, 'ghost-visual-report.json'), JSON.stringify(report, null, 2)); }
console.log(report.status); if (report.status !== 'captured-awaiting-visual-review') process.exitCode = 1;
