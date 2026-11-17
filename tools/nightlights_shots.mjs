// Director: no-cache game server at YR_URL (default 8173), run through the heavy gate:
// node tools/nightlights_shots.mjs --out /tmp/yr-nightlights
// Review all PNGs. Frozen McMinnville A/B/A isolates fake lights from atmosphere/vehicle lighting.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import { startGame, holdCar, watchErrors } from './lib/startgame.mjs';
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = values.out || '/tmp/yr-nightlights';
await mkdir(out, { recursive: true });
const report = { errors: [], shots: [], bench: [], visualReview: 'NOT REVIEWED', benchmarkBaseline: 'Same patched shaders with emission disabled and pools hidden; measures incremental drawing cost, not shader/attribute overhead against an unmodified build' };
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
  watchErrors(page, 'nightlights', report.errors);
  page.on('console', m => { if (m.type() === 'error' && /shader|WebGL|VALIDATE_STATUS/i.test(m.text())) report.errors.push(m.text()); });
  await startGame(page);
  await page.waitForFunction(() => game.warmup.done, { timeout: 120000 });
  await page.evaluate(async () => {
    const g = game, { nightUniform } = await import('./src/nightlights.js');
    window.nightEvidence = { view: 'street', enabled: true, nightUniform, samples: [] };
    g.atmosphere.speed = 0; g.atmosphere.set({ weather: 'clear' }, false);
    for (const v of Object.values(g.vehicles.all)) v.step = () => {};
    const render = g.renderer.render.bind(g.renderer);
    g.renderer.render = (scene, camera) => {
      const s = nightEvidence, p = g.vehicles.current.pos;
      camera.position.set(p.x + (s.view === 'street' ? -8 : 65), p.y + (s.view === 'street' ? 2.3 : 150), p.z + (s.view === 'street' ? 10 : 85));
      camera.lookAt(p.x, p.y + 5, p.z - 25); camera.updateMatrixWorld();
      const saved = s.nightUniform.value, pools = [];
      if (!s.enabled) {
        s.nightUniform.value = 0;
        scene.traverse(o => { if (o.name === 'night-lamp-pools' && o.visible) { pools.push(o); o.visible = false; } });
      }
      const start = performance.now(); render(scene, camera); s.samples.push(performance.now() - start);
      s.nightUniform.value = saved; for (const pool of pools) pool.visible = true;
    };
  });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const counts = () => page.evaluate(() => {
    let lights = 0; game.scene.traverse(o => { if (o.isLight) lights++; });
    return { lights, programs: game.renderer.info.programs.length, night: game.atmosphere.night };
  });
  for (const [town, x, z] of [['mcminnville', 19451, -11032], ['sheridan', 3580, 1070], ['campus', -542, 440]]) {
    await holdCar(page, { x, z }); await wait(1500);
    // Compile this location's visible geometry once before checking dusk/night program stability.
    await page.evaluate(() => { game.atmosphere.setPreset('night', false); nightEvidence.view = 'street'; });
    await wait(800);
    for (const view of ['street', '150m']) {
      await page.evaluate(view => { nightEvidence.view = view; }, view); await wait(800);
      await page.waitForFunction(() => game.world.pendingTiles() === 0, { timeout: 120000 });
      const before = await counts();
      for (const phase of ['midday', 'dusk', 'night']) {
        await page.evaluate(phase => game.atmosphere.setPreset(phase, false), phase); await wait(600);
        const state = await counts(), file = `${town}-${phase}-${view}.png`;
        await page.screenshot({ path: `${out}/${file}` }); report.shots.push({ file, ...state });
        assert.equal(state.lights, before.lights, 'constant real light count');
        assert.equal(state.programs, before.programs, 'no shader recompiles over time');
      }
    }
  }
  await holdCar(page, { x: 19451, z: -11032 });
  await page.evaluate(() => { game.atmosphere.setPreset('night', false); nightEvidence.view = 'street'; });
  await page.waitForFunction(() => game.world.pendingTiles() === 0 && game.warmup.done, { timeout: 120000 });
  for (const enabled of [false, true, false]) {
    await page.evaluate(v => { nightEvidence.enabled = v; }, enabled); await wait(1500);
    const row = await page.evaluate(async enabled => {
      const s = nightEvidence; s.samples.length = 0;
      for (let i = 0; i < 240; i++) await new Promise(requestAnimationFrame);
      const a = s.samples.slice().sort((x, y) => x - y);
      return { enabled, median: a[Math.floor(a.length * .5)], p95: a[Math.floor(a.length * .95)], frames: a.length };
    }, enabled);
    report.bench.push(row);
  }
  report.extraMedianMs = report.bench[1].median - (report.bench[0].median + report.bench[2].median) / 2;
  await writeFile(`${out}/nightlights.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(report.errors, []);
  assert(report.extraMedianMs <= .3, `night emission cost ${report.extraMedianMs.toFixed(3)} ms exceeds .3 ms`);
  console.log(`PASS nightlights shots and A/B/A → ${out}; PNG visual review required`);
} finally { await browser.close(); }
