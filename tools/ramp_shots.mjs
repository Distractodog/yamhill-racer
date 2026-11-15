// Director-only browser check; existing server required. Run behind the heavy gate.
// node tools/ramp_shots.mjs /tmp/ramps-audit.json /tmp/ramp-shots [--ids RJ-001,RJ-002]
import puppeteer from 'puppeteer-core';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [input, output, ...options] = process.argv.slice(2);
if (!input || !output || (options.length && (options[0] !== '--ids' || !options[1]))) {
  throw new Error('Usage: node tools/ramp_shots.mjs <audit.json> <output-folder> [--ids RJ-001,RJ-002]');
}
const data = JSON.parse(await readFile(input, 'utf8'));
const selected = options[0] === '--ids' ? new Set(options[1].split(',')) : null;
const rows = (Array.isArray(data) ? data : data.rows).filter(r => !selected || selected.has(r.id));
if (!rows.length) throw new Error('No audit rows selected');
for (const r of rows) {
  if (!/^RJ-\d+$/.test(r.id) || ![r.x, r.z, r.yaw, ...r.approach].every(Number.isFinite)) {
    throw new Error(`Invalid audit row ${r.id}`);
  }
}
await mkdir(output, { recursive: true });
const errors = [];
const results = [];
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760 });
  page.on('pageerror', e => { errors.push(e.message); console.error('PAGE ERROR', e.message); });
  await page.evaluateOnNewDocument(() => localStorage.setItem('yr-welcome-hidden-1', '1'));
  await page.goto('http://127.0.0.1:8173/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.game, { timeout: 120000 });
  // Override only this page's renderer.render: after the game's own camera update,
  // pin a survey camera and vehicle and render the normal scene. Streaming still runs.
  await page.evaluate(() => {
    const g = window.game;
    // Survey mode keeps spawn physics paused but removes its full-map overlay.
    g.minimap.pickSpawn(null);
    g.minimap.toggle(false);
    const render = g.renderer.render.bind(g.renderer);
    window.rampSurvey = { active: false, intervals: [], last: 0 };
    g.renderer.render = (scene, camera) => {
      const s = window.rampSurvey;
      if (s.active) {
        const now = performance.now();
        if (s.last) s.intervals.push(now - s.last);
        s.last = now;
        g.keys.clear();
        g.car.pos.set(s.px, s.py, s.pz);
        g.car._lastLoaded = null;
        g.car.vel.set(0, 0, 0);
        g.car.ang.set(0, 0, 0);
        camera.position.set(...s.eye);
        camera.up.set(0, 1, 0);
        camera.fov = 65; camera.updateProjectionMatrix();
        camera.lookAt(...s.target);
        g.world.updateLOD(camera.position, g.car.vel);
      }
      render(scene, camera);
    };
  });
  for (const row of rows) {
    const result = { id: row.id, views: [], errors: [] };
    const errorStart = errors.length;
    try {
      // Hold at the actual audit coordinates until both meet and approach have ground.
      await page.evaluate(r => {
        const g = window.game, s = window.rampSurvey;
        s.active = true;
        Object.assign(s, { px: r.x, pz: r.z, py: 200, eye: [r.x, 240, r.z + 40], target: [r.x, 200, r.z] });
      }, row);
      await page.waitForFunction(r => {
        const w = window.game.world;
        return w.loadedAt(r.x, r.z) && w.loadedAt(...r.approach);
      }, { timeout: 120000 }, row);
      for (const view of ['driver', 'overhead']) {
        await page.evaluate((r, view) => {
          const g = window.game, s = window.rampSurvey;
          const [ax, az] = r.approach;
          const ground = g.world.heightAt(r.x, r.z);
          const approachGround = g.world.heightAt(ax, az);
          if (![ground, approachGround].every(Number.isFinite)) throw new Error('Ground query failed');
          g.car.reset(ax, az, r.yaw);
          g.car.safe = [];
          Object.assign(s, { px: ax, pz: az, py: approachGround + 1,
            eye: view === 'driver' ? [ax, approachGround + 1.8, az] : [r.x, ground + 40, r.z + 12],
            target: [r.x, ground + (view === 'driver' ? 1 : 0), r.z], intervals: [], last: 0 });
        }, row, view);
        await page.waitForFunction(() => window.game.world.pendingTiles() === 0, { timeout: 120000 });
        await new Promise(resolve => setTimeout(resolve, 2000));
        const metrics = await page.evaluate(() => {
          const s = window.rampSurvey;
          const times = s.intervals.slice(-120).sort((a, b) => a - b);
          const total = times.reduce((a, b) => a + b, 0);
          return { samples: times.length, fps: times.length * 1000 / total,
            medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.floor(times.length * .95)],
            slowOver20ms: times.filter(t => t > 20).length / times.length,
            triangles: window.game.renderer.info.render.triangles };
        });
        const filename = `${row.id}-${view}.png`;
        await page.screenshot({ path: path.join(output, filename) });
        result.views.push({ view, filename, ...metrics, verdict: 'NOT REVIEWED' });
        console.log(row.id, view, JSON.stringify(metrics));
      }
    } catch (e) {
      result.failure = e.message;
      console.error(row.id, e.message);
    }
    result.errors = errors.slice(errorStart);
    results.push(result);
    await writeFile(path.join(output, 'results.json'), JSON.stringify({ results, pageErrors: errors }, null, 2) + '\n');
  }
} finally {
  await browser.close();
}
if (errors.length || results.some(r => r.failure || r.views.length !== 2)) process.exitCode = 1;
