// Director-only browser capture. Start the game server separately and use the heavy gate.
// node tools/bridge_shots.mjs /tmp/bridges-audit.json /tmp/bridge-shots --rows 1,2,BR-003
// Also accepts a JSON array of selected audit row objects. No browser is opened for --help.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const usage = 'Usage: node tools/bridge_shots.mjs <audit.json> <output-folder> [--rows 1,2,BR-003] [--url http://127.0.0.1:8173/]';
if (args.includes('--help')) { console.log(usage); process.exit(0); }
if (args.length < 2) throw new Error(usage);
const [input, out] = args;
let selection, url = 'http://127.0.0.1:8173/';
for (let i = 2; i < args.length; i += 2) {
  if (!args[i + 1]) throw new Error(usage);
  if (args[i] === '--rows') selection = args[i + 1].split(',');
  else if (args[i] === '--url') url = args[i + 1];
  else throw new Error(`Unknown option: ${args[i]}`);
}
const source = JSON.parse(await readFile(input, 'utf8'));
const allRows = Array.isArray(source) ? source : source.rows;
if (!Array.isArray(allRows)) throw new Error('Expected an audit object with rows, or an array of rows');
const wanted = selection?.map(id => /^\d+$/.test(id) ? `BR-${id.padStart(3, '0')}` : id);
const rows = wanted ? wanted.map(id => {
  const row = allRows.find(r => r.id === id);
  if (!row) throw new Error(`Row not found: ${id}`);
  return row;
}) : allRows;
if (!rows.length) throw new Error('No rows selected');
for (const r of rows) {
  if (!/^BR-\d+$/.test(r.id) || ![r.x, r.z, r.yaw].every(Number.isFinite)) {
    throw new Error('Each row needs a safe BR ID and finite x, z, yaw');
  }
}
// Import after validation so selection/help can be checked without browser dependencies.
const { default: puppeteer } = await import('puppeteer-core');
await mkdir(out, { recursive: true });
const report = { status: 'running', visualReview: 'NOT REVIEWED', rows: [], pageErrors: [], consoleErrors: [] };
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--disable-background-timer-throttling'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760 });
  page.on('pageerror', e => { report.pageErrors.push(e.message); console.error('PAGE ERROR', e.message); });
  page.on('console', msg => {
    if (msg.type() === 'error') {
      report.consoleErrors.push(msg.text()); console.error('BROWSER ERROR', msg.text());
    }
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('yr-welcome-hidden-1', '1');
    Object.defineProperty(navigator, 'getGamepads', { value: () => [] });
  });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.game, { timeout: 120000 });
  await page.evaluate(() => {
    const g = window.game;
    window.bridgeCapture = { render: g.renderer.render, step: g.car.step, shot: null, frames: [], last: null };
    const s = window.bridgeCapture;
    // Hold the exact crossing instead of allowing physics to return to an old loaded tile.
    g.car.step = function() {
      if (!s.row) return;
      this._lastLoaded = null;
      this.pos.set(s.row.x, (g.world.heightAt(s.row.x, s.row.z) || 0) + 1, s.row.z);
      this.vel.set(0, 0, 0); this.yaw = s.row.yaw;
      this.savePrev?.();
    };
    g.renderer.render = function(scene, camera) {
      if (s.shot && camera === g.camera) {
        g.car.mesh.visible = s.view !== 'driver';
        camera.position.set(...s.shot.position);
        camera.up.set(0, 1, 0);
        camera.lookAt(...s.shot.target);
        camera.updateMatrixWorld();
        const now = performance.now();
        if (s.last !== null) s.frames.push(now - s.last);
        s.last = now;
      }
      return s.render.call(this, scene, camera);
    };
  });
  for (const row of rows) {
    console.log(`Capturing ${row.id} at ${row.x}, ${row.z}`);
    await page.evaluate(row => {
      const g = window.game, s = window.bridgeCapture;
      s.row = row; s.view = 'side'; s.shot = null; g.keys.clear(); g.car._lastLoaded = null;
      // Seed camera and vehicle here; the render hook maintains it while loading.
      g.car.pos.set(row.x, 200, row.z); g.car.vel.set(0, 0, 0);
      g.camera.position.set(row.x, 220, row.z);
      s.shot = { position: [row.x + 60 * Math.cos(row.yaw), 220, row.z - 60 * Math.sin(row.yaw)],
        target: [row.x, 200, row.z] };
    }, row);
    await page.waitForFunction(({ x, z }) => {
      const w = window.game.world;
      return w.loadedAt(x, z) && w.pendingTiles() === 0;
    }, { timeout: 120000, polling: 100 }, row);
    const entry = { id: row.id, x: row.x, z: row.z, views: [], verdict: 'NOT REVIEWED',
      driverPlacement: row.roads?.length ? 'along inferred deck road' : 'locator only; no deck road identified' };
    report.rows.push(entry);
    for (const view of ['side', 'driver']) {
      const camera = await page.evaluate((row, view) => {
        const g = window.game, s = window.bridgeCapture;
        s.view = view;
        const fx = Math.sin(row.yaw), fz = Math.cos(row.yaw);
        const y = g.world.heightAt(row.x, row.z);
        if (!Number.isFinite(y)) throw new Error('No ground at crossing');
        const dx = row.x - 15 * fx, dz = row.z - 15 * fz;
        const dy = g.world.heightAt(dx, dz);
        if (view === 'driver' && !Number.isFinite(dy)) throw new Error('No ground at driver approach');
        s.shot = view === 'side'
          ? { position: [row.x + 60 * fz, y + 18, row.z - 60 * fx], target: [row.x, y + 1, row.z] }
          : { position: [dx, dy + 1.6, dz], target: [row.x + 30 * fx, y + 1.6, row.z + 30 * fz] };
        g.car.mesh.visible = view !== 'driver';
        s.frames = []; s.last = null;
        return s.shot;
      }, row, view);
      // Wait for rendered frames and streaming to settle at the actual camera.
      await page.waitForFunction(() => window.bridgeCapture.frames.length >= 60 && window.game.world.pendingTiles() === 0,
        { timeout: 120000, polling: 100 });
      const filename = `${row.id}-${view}.png`;
      await page.screenshot({ path: join(out, filename) });
      const metrics = await page.evaluate(() => {
        const g = window.game, samples = window.bridgeCapture.frames;
        const sorted = [...samples].sort((a, b) => a - b);
        return { frames: samples.length, medianMs: sorted[Math.floor(sorted.length / 2)],
          p95Ms: sorted[Math.floor(sorted.length * .95)],
          slowFramesPct: 100 * samples.filter(ms => ms > 20).length / samples.length,
          triangles: g.renderer.info.render.triangles, drawCalls: g.renderer.info.render.calls,
          loadedTiles: g.world.loadedTiles(), pendingTiles: g.world.pendingTiles() };
      });
      entry.views.push({ view, filename, camera, ...metrics });
      console.log(filename, JSON.stringify(metrics));
    }
    await writeFile(join(out, 'bridge-shots-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  report.status = report.pageErrors.length ? 'page-errors' : 'captured';
  if (report.pageErrors.length) process.exitCode = 1;
} catch (error) {
  report.status = 'failed'; report.error = error.message;
  console.error(error); process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await writeFile(join(out, 'bridge-shots-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Evidence folder: ${resolve(out)}; visual verdicts still require review.`);
}
