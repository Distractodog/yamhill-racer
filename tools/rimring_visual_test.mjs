// Full-size ring positioned with its east wall at campus x=600; no manifest/physics changes.
// node tools/rimring_visual_test.mjs <output folder> [http://127.0.0.1:8173/]
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const out = process.argv[2] || 'rimring-results', url = process.argv[3] || 'http://127.0.0.1:8173/';
await mkdir(out, { recursive: true });
const report = { fixture: { cx: -16600, cz: 0, r: 17200 }, phases: [], pageErrors: [], consoleErrors: [], status: 'running', visualReview: 'NOT REVIEWED', performanceBudgetMs: .2 };
let browser, page;
try {
 browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
 page = await browser.newPage(); await page.setViewport({ width: 1280, height: 760 });
 page.on('pageerror', e => { report.pageErrors.push(e.message); console.error('PAGE ERROR', e.message); });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text(), location = message.location();
    // Ignore only the browser's missing favicon request, never a shader/application error.
    let favicon404 = false;
    try { favicon404 = new URL(location.url).pathname === '/favicon.ico' && /^Failed to load resource:.*404/.test(text); } catch {}
    if (favicon404) return;
    report.consoleErrors.push({ text, url: location.url || '', line: location.lineNumber ?? null });
    console.error('BROWSER CONSOLE ERROR', text);
  });

 await page.evaluateOnNewDocument(() => localStorage.setItem('yr-welcome-hidden-1', '1'));
 await page.goto(url, { waitUntil: 'load' }); await page.waitForFunction(() => window.game, { timeout: 120000 });
 await page.evaluate(async rim => {
  const { createRimRing } = await import('./src/rimring.js');
  game.renderer.debug.checkShaderErrors = true;
  const car = game.vehicles.current, ring = createRimRing({ scene: game.scene, rim });
  if (ring.mesh.geometry.index.count / 3 !== 2048) throw Error('Performance fixture must use production-size ring geometry');
  window.ringFixture = { ring, car, originalStep: car.step, enabled: false, raf: 0, loading: 0 };
  const tick = () => { const f = ringFixture; if (f.enabled) f.ring.update(car.renderPos); else f.ring.mesh.visible = false; f.raf = requestAnimationFrame(tick); };
  tick();
 }, report.fixture);
 const measure = enabled => page.evaluate(enabled => new Promise(resolve => {
  ringFixture.enabled = enabled;
  const frames = [], calls = []; let start, last;
  const tick = now => { start ??= now; if (last !== undefined) frames.push(now - last); last = now; calls.push(game.renderer.info.render.calls);
   if (now - start < 3000) requestAnimationFrame(tick);
   else { const total = frames.reduce((a, b) => a + b, 0), sorted = [...frames].sort((a, b) => a - b);
    resolve({ enabled, frames: frames.length, fps: frames.length * 1000 / total, meanMs: total / frames.length,
      p95Ms: sorted[Math.floor(sorted.length * .95)], slowFrames: frames.filter(t => t > 1000 / 30).length,
      minDrawCalls: Math.min(...calls), maxDrawCalls: Math.max(...calls), frameTimesMs: frames }); }
  }; requestAnimationFrame(tick);
 }), enabled);
 for (const distance of [300, 100, 0]) {
  const row = { distanceMetres: distance, visualVerdict: 'NOT REVIEWED', measurements: [] }; report.phases.push(row);
  await page.evaluate(distance => {
   const f = ringFixture, x = 600 - distance; f.enabled = false; f.car.step = f.originalStep;
   f.loading = setInterval(() => { f.car.reset(x, 0, Math.PI / 2); f.car._lastLoaded = null; }, 50);
  }, distance);
  await page.waitForFunction(distance => game.world.loadedAt(600 - distance, 0) && game.world.pendingTiles() === 0, { timeout: 120000 }, distance);
  await page.evaluate(distance => { const f = ringFixture; clearInterval(f.loading); f.car.reset(600 - distance, 0, Math.PI / 2); f.car.step = () => {}; }, distance);
  // Alternating measurements keep the same frozen pose, camera and streamed scene for both states.
  for (let i = 0; i < 3; i++) { row.measurements.push(await measure(false)); row.measurements.push(await measure(true)); }
  row.screenshot = `rim-${distance}m.png`; await page.screenshot({ path: join(out, row.screenshot) });
  row.ringState = await page.evaluate(() => ({ visible: ringFixture.ring.mesh.visible, opacity: ringFixture.ring.mesh.material.opacity }));
  const mean = enabled => row.measurements.filter(m => m.enabled === enabled).reduce((sum, m) => sum + m.meanMs, 0) / 3;
  row.meanFrameDeltaMs = mean(true) - mean(false); row.withinMeasuredBudget = row.meanFrameDeltaMs <= report.performanceBudgetMs;
  if ((distance === 300) === row.ringState.visible) throw Error('Unexpected ring visibility');
 }
 report.performanceFailures = report.phases.filter(p => p.withinMeasuredBudget !== true).map(p => ({ distanceMetres: p.distanceMetres, meanFrameDeltaMs: p.meanFrameDeltaMs }));
 report.status = report.pageErrors.length || report.consoleErrors.length || report.performanceFailures.length ? 'failed' : 'captured-awaiting-visual-review';
} catch (e) { report.status = 'blocked-or-failed'; report.error = e.message; console.error(e.message); }
finally {
 if (page && !page.isClosed()) await page.evaluate(() => { const f = window.ringFixture; if (f) { clearInterval(f.loading); cancelAnimationFrame(f.raf); f.car.step = f.originalStep; f.ring.dispose(); } }).catch(() => {});
 await browser?.close(); await writeFile(join(out, 'rimring-report.json'), JSON.stringify(report, null, 2));
}
console.log(report.status); if (report.status !== 'captured-awaiting-visual-review') process.exitCode = 1;
