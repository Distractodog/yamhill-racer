// Controller-run real-game evidence. No server is launched here. Run through the heavy gate:
// node tools/car_damage_shots.mjs --url http://127.0.0.1:8173/ --out /tmp/yr-car-dents
// Actual Car.step/building contacts generate every dent. After each impact we move the car
// without resetting to one loaded display spot for comparable front/side photographs.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GAME_URL, startGame, holdCar, watchErrors } from './lib/startgame.mjs';
import { findCarDamageSite } from './lib/cardamagesite.mjs';
const option = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const url = option('--url', GAME_URL), out = option('--out', '/tmp/yr-car-dents');
const report = { author: 'distractodog', url, errors: [], warnings: [], shots: [], impacts: [], performance: [], visualReview: 'NOT REVIEWED: Ethan judges appearance' };
await mkdir(out, { recursive: true });
let browser;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
  watchErrors(page, 'car-dents', report.errors);
  page.on('response', r => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) report.errors.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on('requestfailed', r => { if (!r.url().endsWith('/favicon.ico')) report.errors.push(`REQUEST ${r.url()}: ${r.failure()?.errorText}`); });
  page.on('console', m => {
    if (m.type() === 'error' && !m.text().includes('favicon')) report.errors.push(m.text());
    if (m.type() === 'warn') report.warnings.push(m.text());
  });
  await startGame(page, { url, hold: { x: -542, z: 440, kind: 'car' }, storage: { 'yr-graphics-2': JSON.stringify({ mode: 'high' }) } });
  const site = await page.evaluate(findCarDamageSite);
  await page.evaluate(site => {
    game.challenges.quit(); game.atmosphere.setPreset('midday', false); game.setCam(0);
    window.dentShots = { site, running: false, view: 'front', originalRender: game.renderer.render.bind(game.renderer) };
    const s = window.dentShots;
    s.display = { x: site.x + site.nx * 15, z: site.z + site.nz * 15, yaw: Math.atan2(-site.nx, -site.nz) };
    game.renderer.render = function(scene, camera) {
      if (scene === game.scene && !game.garage.open) {
        const v = game.vehicles.current, V = v.pos.constructor, front = new V(0, 0, 1).applyQuaternion(v.quat), side = new V(1, 0, 0).applyQuaternion(v.quat);
        const p = v.mesh.position.clone(); p.y += .25;
        camera.position.copy(p).addScaledVector(front, s.view === 'front' ? 7 : 1).addScaledVector(side, s.view === 'front' ? 4 : 8);
        camera.position.y += s.view === 'front' ? 2.7 : 1.5;
        camera.up.set(0, 1, 0); camera.fov = 48; camera.updateProjectionMatrix(); camera.lookAt(p); camera.updateMatrixWorld();
      }
      s.originalRender(scene, camera);
    };
  }, site);
  report.site = site;
  const display = await page.evaluate(() => dentShots.display);
  async function pose() {
    await page.evaluate(() => {
      const s = dentShots, c = game.vehicles.current, d = s.display;
      s.running = false; c.pos.set(d.x, game.world.heightAt(d.x, d.z) + (c.typePhysics ? c.t.restLength + c.typePhysics.radius : .75), d.z);
      c.quat.setFromAxisAngle(c.vel.clone().set(0, 1, 0), d.yaw); c.vel.set(0, 0, 0); c.ang.set(0, 0, 0);
      c.latAcc = c.lonAcc = c.steer = 0; c.wheels.forEach(w => { w.spin = 0; }); c.savePrev(); c.interpolate(0); c._lastLoaded = null;
    });
    await wait(350);
  }
  async function shots(type, phase) {
    for (const view of ['front', 'side']) {
      await page.evaluate(view => { dentShots.view = view; }, view); await wait(80);
      const file = `${type}-${phase}-${view}.png`; await page.screenshot({ path: join(out, file) });
      const state = await page.evaluate(() => ({ type: game.vehicles.current.type, sites: game.vehicles.current.damage.sites.map(s => ({ point: s.point.toArray(), normal: s.normal.toArray(), depth: s.depth, speed: s.speed, source: s.source })) }));
      report.shots.push({ file, phase, view, state, evidence: 'real Car.step collision; repositioned for display without repair' });
    }
  }
  async function perf(type, phase) {
    const stats = await page.evaluate(() => new Promise(resolve => {
      const samples = []; let previous;
      function frame(now) {
        if (previous !== undefined) samples.push(now - previous); previous = now;
        if (samples.length < 180) return requestAnimationFrame(frame);
        samples.sort((a, b) => a - b);
        resolve({ medianMs: samples[90], p95Ms: samples[171], worstMs: samples.at(-1), slow20Percent: samples.filter(x => x > 20).length / 1.8,
          slow33Percent: samples.filter(x => x > 33.3).length / 1.8, calls: game.renderer.info.render.calls, triangles: game.renderer.info.render.triangles });
      }
      requestAnimationFrame(frame);
    }));
    report.performance.push({ type, phase, ...stats });
  }
  async function impact(type, phase, speed, orientation = 0) {
    await page.evaluate(({ speed, orientation }) => {
      const s = dentShots, c = game.vehicles.current, p = s.site, radius = 1.5 * (c.typePhysics?.width ?? 1);
      c.pos.set(p.x + p.nx * (radius + .1), 0, p.z + p.nz * (radius + .1));
      c.pos.y = game.world.heightAt(c.pos.x, c.pos.z) + (c.typePhysics ? c.t.restLength + c.typePhysics.radius : .75);
      c.quat.setFromAxisAngle(c.vel.clone().set(0, 1, 0), Math.atan2(-p.nx, -p.nz) + orientation);
      c.vel.set(-p.nx * speed, 0, -p.nz * speed); c.ang.set(0, 0, 0); c.savePrev(); c._lastLoaded = null;
      s.contacts = []; s.steps = 0; s.running = true;
    }, { speed, orientation });
    await page.waitForFunction(() => !dentShots.running, { timeout: 12000 });
    const result = await page.evaluate(() => ({ contacts: dentShots.contacts, steps: dentShots.steps, sites: game.vehicles.current.damage.sites.length }));
    assert(result.contacts.some(c => c.source === 'building' && c.speed > 0), `${type}/${phase}: no actual building contact`);
    report.impacts.push({ type, phase, requestedSpeedMs: speed, orientation, ...result });
    await pose();
  }
  for (const type of ['race', 'sports', 'hatch', 'suv', 'truck']) {
    await page.evaluate(type => {
      const prior = game.vehicles.current;
      if (dentShots.originalStep) { prior.step = dentShots.originalStep; prior.recordImpact = dentShots.originalImpact; }
      game.vehicles.choose('car', type);
    }, type);
    await holdCar(page, { ...display, kind: 'car' });
    await page.evaluate(() => {
      const c = game.vehicles.current, s = dentShots;
      s.originalStep = c.step; s.originalImpact = c.recordImpact;
      c.recordImpact = function(x, y, z, nx, ny, nz, speed, source) {
        if (s.running && source === 'building') s.contacts.push({ x, y, z, nx, ny, nz, speed, source });
        return s.originalImpact.call(this, x, y, z, nx, ny, nz, speed, source);
      };
      c.step = function(dt, input) {
        if (!s.running) { this.damage.step(dt); return; }
        s.originalStep.call(this, dt, { throttle: 0, brake: 0, steer: 0, handbrake: false });
        s.steps++;
        if (s.contacts.length || s.steps > 600) s.running = false;
      };
      s.clean = [];
      c.mesh.userData.bodyPivot.traverse(o => {
        if (o.isMesh && !o.name.startsWith('vehicle-')) s.clean.push({ mesh: o, p: o.geometry.attributes.position.array.slice(), count: o.userData.damageVertexCount ?? o.geometry.attributes.position.count });
      });
    });
    await pose(); await shots(type, 'pristine'); await perf(type, 'before');
    for (const [phase, speed] of [['low', 2], ['medium', 15], ['high', 45]]) {
      await page.evaluate(() => game.vehicles.current.reset(dentShots.display.x, dentShots.display.z, dentShots.display.yaw));
      await impact(type, phase, speed); await shots(type, phase);
      if (phase === 'low') assert.equal(await page.evaluate(() => game.vehicles.current.damage.sites.length), 0);
      else assert(await page.evaluate(() => game.vehicles.current.damage.sites.length) > 0);
    }
    for (const [i, orientation] of [0, 0, Math.PI / 2, Math.PI].entries()) await impact(type, `repeat-${i + 1}`, 45, orientation);
    await shots(type, 'repeated'); await perf(type, 'after');
    // Inspect both actual LOD bodies from the same near camera (clearly labelled supplementary views).
    await page.evaluate(() => game.vehicles.current.mesh.userData.bodyPivot.traverse(o => { if (o.isLOD) { o.autoUpdate = false; o.levels.forEach((l, i) => { l.object.visible = i === o.levels.length - 1; }); } }));
    await shots(type, 'repeated-far-body-supplement');
    await page.evaluate(() => game.vehicles.current.mesh.userData.bodyPivot.traverse(o => { if (o.isLOD) o.autoUpdate = true; }));
    const beforeGarage = await page.evaluate(() => game.vehicles.current.damage.revision);
    await page.evaluate(() => { game.cosmetics.set('car', { body: '#cf392c', trim: '#e9e2d6', livery: 'classic' }); game.garage.show(); });
    await wait(400); const file = `${type}-garage-preview.png`; await page.screenshot({ path: join(out, file) });
    report.shots.push({ file, evidence: 'Garage preview while driven car remains dented' });
    await page.evaluate(() => game.garage.close());
    assert.equal(await page.evaluate(() => game.vehicles.current.damage.revision), beforeGarage, 'Garage/paint must not repair');
    await pose(); await shots(type, 'repainted');
    await page.evaluate(() => {
      const c = game.vehicles.current; c.reset(dentShots.display.x, dentShots.display.z, dentShots.display.yaw);
      for (const { mesh, p, count } of dentShots.clean) {
        const a = mesh.geometry.attributes.position.array;
        for (let i = 0; i < count * 3; i++) if (a[i] !== p[i]) throw Error(`Reset failed to restore ${mesh.name} vertex ${i}`);
      }
      if (c.damage.sites.length) throw Error('Reset retained damage sites');
    });
    await pose(); await shots(type, 'reset');
  }
  assert.deepEqual(report.errors, [], report.errors.join('\n'));
} catch (error) {
  report.errors.push(`distractodog: ${error.stack || error.message}`);
  throw error;
} finally {
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close();
}
console.log(`distractodog: saved ${report.shots.length} PNGs and actual-impact/performance evidence to ${out}. Review all PNGs; appearance is not automatically approved.`);
