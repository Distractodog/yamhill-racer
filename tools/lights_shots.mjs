// Director: run through the heavy gate with the no-cache server on 127.0.0.1:8173.
// node tools/lights_shots.mjs /tmp/yr-lights
// Captures require visual review. Night A/B/A benchmark compares the same frozen scene.
import puppeteer from 'puppeteer-core';
import { GAME_URL, startGame, holdCar } from './lib/startgame.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const out = process.argv[2] || '/tmp/yr-lights';
await mkdir(out, { recursive: true });
const report = { pageErrors: [], consoleErrors: [], shots: [], bench: [], status: 'running', visualReview: 'NOT REVIEWED' };
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
});
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 760 });
  page.setDefaultTimeout(120000);
  page.on('pageerror', e => { report.pageErrors.push(e.message); console.error('PAGE ERROR', e.message); });
  page.on('console', m => { if (m.type() === 'error' && !m.location().url?.endsWith('/favicon.ico')) report.consoleErrors.push(m.text()); });
  await startGame(page, { url: process.env.GAME_URL || GAME_URL, hold: { x: 19451, z: -11032, yaw: -1.573, kind: 'car' } });
  await page.evaluate(() => {
    const g = game; g.atmosphere.setPreset('night', false); g.setCam(0);
    window.lightsEvidence = { view: 'behind', enabled: true, renderMs: [], strobeOn: 0, strobeOff: 0 };
    const original = g.renderer.render.bind(g.renderer);
    // Freeze physics at a real road position; keep the normal lighting/render loop running.
    for (const v of Object.values(g.vehicles.all)) v.step = () => {};
    g.renderer.render = (scene, camera) => {
      const s = lightsEvidence, v = g.vehicles.current, p = v.mesh.position;
      const forward = p.clone().set(0, 0, 1).applyQuaternion(v.mesh.quaternion);
      const offset = (s.view === 'front' ? 1 : -1) * (v.kind === 'jet' ? 22 : 11);
      if (s.view !== null) {
        camera.position.copy(p).addScaledVector(forward, offset); camera.position.y += v.kind === 'jet' ? 4 : 2.6;
        camera.lookAt(p.clone().addScaledVector(forward, 5)); camera.updateMatrixWorld();
      }
      // Benchmark baseline only: hide the light so the baseline really excludes it (the game itself never hides it: off
      // is intensity 0, so day/night and vehicle switches don't change the light count and recompile shaders).
      g.vehicleLights.spot.visible = s.enabled;
      v.mesh.getObjectByName('vehicle-lenses').visible = s.enabled;
      const strobe = v.mesh.getObjectByName('vehicle-light-strobe');
      if (strobe) { if (strobe.visible) s.strobeOn++; else s.strobeOff++; }
      const start = performance.now(); original(scene, camera); s.renderMs.push(performance.now() - start);
    };
  });
  async function shot(kind, view, brake = false) {
    await page.evaluate(({ kind, view, brake }) => {
      const g = game; g.vehicles.switchTo(kind); const v = g.vehicles.current;
      v.reset(19451, -11032, -1.573); v.vel.set(0, 0, 0);
      if (kind === 'jet') v.placeInAir(19451, g.world.heightAt(19451, -11032) + 150, -11032, -1.573, 600);
      lightsEvidence.view = view;
      g.keys.clear(); if (brake) g.keys.add('KeyS');
    }, { kind, view, brake });
    await new Promise(r => setTimeout(r, 1200));
    const name = `${kind}-${view}${brake ? '-braking' : ''}.png`;
    await page.screenshot({ path: join(out, name) });
    const state = await page.evaluate(() => ({ kind: game.vehicles.current.kind, lightsOn: game.vehicleLights.on,
      brake: game.input.brake, beam: game.vehicleLights.beam, spotIntensity: Math.round(game.vehicleLights.spot.intensity),
      type: game.vehicles.current.type || null, programs: game.renderer.info.programs?.length,
      pos: game.car.pos.toArray(), surface: game.world.surfaceAt(game.car.pos.x, game.car.pos.z) }));
    report.shots.push({ file: name, ...state });
  }
  await shot('car', 'behind'); await shot('car', 'front'); await shot('car', 'behind', true);
  // Exercise the real key handler at night and in daylight.
  await page.keyboard.press('l');
  if (await page.evaluate(() => game.vehicleLights.on)) throw new Error('L did not turn night lights off');
  await page.screenshot({ path: join(out, 'car-behind-lights-off.png') });
  report.shots.push({ file: 'car-behind-lights-off.png', note: 'Brakes remain held; running/headlights are off' });
  await page.keyboard.press('l');
  await page.evaluate(() => game.atmosphere.setPreset('midday', false));
  await page.waitForFunction(() => !game.vehicleLights.on);
  await page.keyboard.press('l');
  if (!await page.evaluate(() => game.vehicleLights.on)) throw new Error('L did not turn daylight lights on');
  await page.evaluate(() => game.atmosphere.setPreset('night', false));
  await shot('bike', 'front'); await shot('bike', 'behind'); await shot('jet', 'behind'); await shot('jet', 'front');
  report.strobe = await page.evaluate(() => ({ onFrames: lightsEvidence.strobeOn, offFrames: lightsEvidence.strobeOff }));
  if (!report.strobe.onFrames || !report.strobe.offFrames) throw new Error('Jet strobe did not alternate');
  await shot('car', 'behind');
  // Garage types: lenses rebuild on each new model.
  for (const [kind, type] of [['car', 'truck'], ['car', 'sports'], ['bike', 'sport']]) {
    await page.evaluate(({ kind, type }) => game.vehicles.setType(kind, type), { kind, type });
    await shot(kind, 'front'); await shot(kind, 'behind', true);
  }
  await page.evaluate(() => { game.vehicles.setType('car', 'race'); game.vehicles.setType('bike', 'dirt'); });
  // Light count stays the same through vehicle switches and day/night: no shader recompiles (programs count steady).
  report.programs = await page.evaluate(async () => {
    const g = game, count = () => g.renderer.info.programs.length, before = count(), wait = ms => new Promise(r => setTimeout(r, ms));
    for (const kind of ['bike', 'jet', 'car']) { g.vehicles.switchTo(kind); await wait(400); }
    g.atmosphere.setPreset('midday', false); await wait(600); g.atmosphere.setPreset('night', false); await wait(600);
    return { before, after: count() };
  });
  await holdCar(page, { x: 19451, z: -11032, yaw: -1.573, kind: 'car' });
  await page.evaluate(() => { lightsEvidence.view = null; game.setCam(0); });
  await page.waitForFunction(() => game.world.loadedAt(19451, -11032) && game.world.pendingTiles() === 0);
  // Baseline removes both lenses and spotlight, then warms shader variants before sampling.
  for (const enabled of [false, true, false]) {
    await page.evaluate(enabled => { lightsEvidence.enabled = enabled; }, enabled);
    await new Promise(r => setTimeout(r, 3000));
    const row = await page.evaluate(async enabled => {
      lightsEvidence.renderMs.length = 0;
      const frames = []; let last = performance.now(), start = last;
      await new Promise(done => requestAnimationFrame(function tick(now) {
        frames.push(now - last); last = now;
        if (now - start < 20000) requestAnimationFrame(tick); else done();
      }));
      const median = values => { const s = values.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
      return { enabled, medianMs: median(frames), renderMedianMs: median(lightsEvidence.renderMs),
        p95Ms: frames.slice().sort((a, b) => a - b)[Math.floor(frames.length * .95)],
        slowPercent: 100 * frames.filter(t => t > 20).length / frames.length,
        calls: game.renderer.info.render.calls, triangles: game.renderer.info.render.triangles, samples: frames.length,
        spotlightVisible: game.vehicleLights.spot.visible, lensesVisible: game.car.mesh.getObjectByName('vehicle-lenses').visible,
        position: game.car.pos.toArray(), pendingTiles: game.world.pendingTiles() };
    }, enabled);
    report.bench.push(row); console.log('McMinnville night', row);
    if (row.spotlightVisible !== enabled || row.lensesVisible !== enabled || row.pendingTiles !== 0) throw new Error('Invalid benchmark state');
  }
  const baseline = (report.bench[0].medianMs + report.bench[2].medianMs) / 2;
  report.extraMedianMs = report.bench[1].medianMs - baseline;
  report.performancePass = report.extraMedianMs <= 1;
  report.candidate = 'single shadowless spotlight + lenses';
  console.log('Extra median ms:', report.extraMedianMs);
  report.status = report.performancePass && !report.pageErrors.length && !report.consoleErrors.length ? 'pass' : 'fail';
  if (report.status === 'fail') process.exitCode = 1;
} catch (error) {
  report.status = 'fail'; report.error = error.message; throw error;
} finally {
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
