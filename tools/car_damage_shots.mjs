// Controller-run real-game evidence. No server is launched here. Run through the heavy gate:
// node tools/car_damage_shots.mjs --url http://127.0.0.1:8173/ --out /tmp/yr-car-dents
// Limits: YR_DENT_LIMITS JSON overrides tools/lib/cardamageperf.mjs defaults;
// YR_DENT_SAMPLES=2..8 (default 4 matched pairs per type/speed), no unbounded runs.
// Actual Car.step/building contacts generate every dent. After each impact we move the car
// without resetting to one loaded display spot for comparable front/side photographs.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GAME_URL, startGame, holdCar } from './lib/startgame.mjs';
import { findCarDamageSite } from './lib/cardamagesite.mjs';
import { probeDentUploads } from './lib/cardamagegpu.mjs';
import { dentOptions, dentCasePlan, DENT_HELP, dentSources, dentNetwork } from './car_damage_check.mjs';
import { dentLimits, compareFrames, installDentTiming } from './lib/cardamageperf.mjs';
const options = dentOptions(process.argv.slice(2), process.env, true);
if (options.help) { console.log(DENT_HELP); process.exit(0); }
if (options.checkOnly || options.preparePreview) throw Error('distractodog: use car_damage_check.mjs for preparation flags');
const url = options.url || GAME_URL, out = options.out;
const limits = dentLimits(process.env.YR_DENT_LIMITS), sampleCount = options.samples;
const started = Date.now();
const report = { status: 'running', startedAt: new Date(started).toISOString(), plan: dentCasePlan(options), selection: options, sources: await dentSources(), limits, sampleCount, timingNotes: 'Matched fixed-step runs (36 follow-through ticks after impact; 120 moving ticks), alternating order, warmed renderer. CPU = step + syncMesh (includes damage.update) + render submission; GPU completion is not isolated. intervalBeforeMs captures deformation before render; intervalAfterMs captures following upload stalls. Frame guardrails use the worse adjacent interval, retaining both raw intervals. Impact summaries include contact frame and next two frames. Small sample p95 is insufficient for high-confidence tail estimates. Raw slow-frame percentages remain; duration-qualified quantile crossings avoid <=1ms boundary jitter, without changing CPU/p95/worst budgets. Same production scene, with non-car weather/FX/bird clocks held constant in both paths; excludes ongoing FX emission cost.', comparisons: [], measuredRuns: [], validationFailures: [], gpuChecks: [], author: 'distractodog', url, errors: [], warnings: [], shots: [], impacts: [], performance: [], visualReview: 'NOT REVIEWED: Ethan judges appearance' };
const checkpoint = () => writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
await mkdir(out, { recursive: true });
await checkpoint();
let browser, page;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
  page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
  await dentNetwork(page, url, report);
  await startGame(page, { url, hold: { x: -542, z: 440, kind: 'car' }, storage: { 'yr-graphics-2': JSON.stringify({ mode: 'high' }) } });
  const site = await page.evaluate(findCarDamageSite);
  await page.evaluate(site => {
    game.challenges.quit(); game.atmosphere.set({ cycle: false, look: 'midday', weather: 'clear' }, false); game.setCam(0);
    window.dentShots = { site, running: false, view: 'front', originalRender: game.renderer.render.bind(game.renderer) };
    const s = window.dentShots;
    s.display = { x: site.x + site.nx * 15, z: site.z + site.nz * 15, yaw: Math.atan2(-site.nx, -site.nz) };
    game.renderer.render = function(scene, camera) {
      if (scene !== game.scene) return s.originalRender(scene, camera);
      if (scene === game.scene && !game.garage.open) {
        const v = game.vehicles.current, V = v.pos.constructor, front = new V(0, 0, 1).applyQuaternion(v.quat), side = new V(1, 0, 0).applyQuaternion(v.quat);
        const p = v.mesh.position.clone(); p.y += .25;
        camera.position.copy(p).addScaledVector(front, s.view === 'front' ? 7 : 1).addScaledVector(side, s.view === 'front' ? 4 : 8);
        camera.position.y += s.view === 'front' ? 2.7 : 1.5;
        camera.up.set(0, 1, 0); camera.fov = 48; camera.updateProjectionMatrix(); camera.lookAt(p); camera.updateMatrixWorld();
      }
      const start = performance.now(), prior = s.lastTimingFrame;
      if (prior) prior.intervalAfterMs = start - s.lastRenderStart;
      if (s.finishRendered) { s.measure = false; s.measureDone = true; s.finishRendered = false; }
      s.originalRender(scene, camera);
      s.camera = camera;
      const f = s.frame || { stepMs: 0, syncMs: 0, damageMs: 0, renderMs: 0, repairMs: 0, impact: false };
      f.renderMs += performance.now() - start;
      f.drawCalls = game.renderer.info.render.calls; f.triangles = game.renderer.info.render.triangles; f.programs = game.renderer.info.programs.length;
      if (s.measure) {
        f.intervalBeforeMs = s.lastRenderStart ? start - s.lastRenderStart : null;
        s.frames.push(f); s.lastTimingFrame = f;
        if (s.finished) s.finishRendered = true;
      } else s.lastTimingFrame = null;
      s.lastRenderStart = start; s.frame = null;
    };
  }, site);
  await page.waitForFunction(() => game.warmup.done && game.world.pendingTiles() === 0, { timeout: 120000 });
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
    report.performance.push({ type, phase, scope: 'settled photographic pose; excludes ordinary physics; ancillary only', ...stats });
  }
  async function impact(type, phase, speed, orientation = 0, measure = false, mode = 'enabled') {
    await page.evaluate(({ speed, orientation, measure, mode }) => {
      const s = dentShots, c = game.vehicles.current, p = s.site, radius = 1.5 * (c.typePhysics?.width ?? 1);
      c.pos.set(p.x + p.nx * (radius + .1), 0, p.z + p.nz * (radius + .1));
      c.pos.y = game.world.heightAt(c.pos.x, c.pos.z) + (c.typePhysics ? c.t.restLength + c.typePhysics.radius : .75);
      c.quat.setFromAxisAngle(c.vel.clone().set(0, 1, 0), Math.atan2(-p.nx, -p.nz) + orientation);
      c.vel.set(-p.nx * speed, 0, -p.nz * speed); c.ang.set(0, 0, 0); c.savePrev(); c._lastLoaded = null;
      s.contacts = []; s.steps = 0; s.running = true; s.kind = 'impact'; s.mode = mode;
      s.measure = measure; s.frames = []; s.frame = null; s.lastTimingFrame = null;
      s.finished = s.measureDone = s.finishRendered = false; s.contactPhysics = s.finalPhysics = null; s.stopStep = null;
    }, { speed, orientation, measure, mode });
    await page.waitForFunction(() => dentShots.measure ? dentShots.measureDone : !dentShots.running, { timeout: 20000 });
    const result = await page.evaluate(() => ({ contacts: dentShots.contacts, steps: dentShots.steps, sites: game.vehicles.current.damage.sites.length, frames: dentShots.frames, contactPhysics: dentShots.contactPhysics, finalPhysics: dentShots.finalPhysics }));
    report.impacts.push({ type, phase, requestedSpeedMs: speed, orientation, ...result });
    assert(result.contacts.some(c => c.source === 'building' && c.speed > 0), `${type}/${phase}: no actual building contact`);
    await pose();
    return result;
  }
  async function gpuCheck(type) {
    await pose();
    await page.evaluate(() => { dentShots.mode = 'enabled'; dentShots.measure = false; });
    const result = await page.evaluate(probeDentUploads, { ...limits, ...(options.timingOnly ? { imagePhases: ['pristine', 'repeated-sync-3', 'dented-reference', 'reset-first', 'reset-reference'] } : {}) });
    for (const [phase, data] of Object.entries(result.images)) {
      const file = `${type}-gpu-${phase}.png`;
      await writeFile(join(out, file), Buffer.from(data.split(',')[1], 'base64'));
      report.shots.push({ file, phase, evidence: result.evidence });
    }
    delete result.images; report.gpuChecks.push({ type, ...result });
    if (!result.pass) report.validationFailures.push(`${type}: rendered dent/repair pixel guardrails failed`);
    await checkpoint();
    // Leave the driven car dented for Garage/repaint evidence, after the probe repaired it.
    if (!options.timingOnly) await impact(type, 'post-gpu-probe', 45);
  }
  async function moving(mode) {
    await page.evaluate(mode => {
      const s = dentShots, c = game.vehicles.current, d = s.display;
      // Preserve enabled dents, change only kinematic setup for the matched moving run.
      c.pos.set(d.x, game.world.heightAt(d.x, d.z) + c.wheelReach(), d.z);
      c.quat.setFromAxisAngle(c.vel.clone().set(0, 1, 0), d.yaw + Math.PI);
      c.vel.set(s.site.nx * 10, 0, s.site.nz * 10); c.ang.set(0, 0, 0); c.latAcc = c.lonAcc = c.steer = 0;
      for (const w of c.wheels) { w.comp = w.prevComp = w.spin = 0; w.terrainHeight = undefined; w.contact = false; }
      c.savePrev(); c.interpolate(0); c._lastLoaded = null;
      Object.assign(s, { mode, kind: 'moving', running: true, measure: true, frames: [], frame: null,
        lastTimingFrame: null, contacts: [], steps: 0, finished: false, finishRendered: false, measureDone: false, contactPhysics: null });
    }, mode);
    await page.waitForFunction(() => dentShots.measureDone, { timeout: 20000 });
    return page.evaluate(() => ({ frames: dentShots.frames, finalPhysics: dentShots.finalPhysics }));
  }
  async function repairFrame(mode) {
    await page.evaluate(mode => {
      const s = dentShots, c = game.vehicles.current;
      Object.assign(s, { mode, kind: 'repair', running: false, measure: true, frames: [], lastTimingFrame: null,
        finished: true, finishRendered: false, measureDone: false });
      s.frame = { stepMs: 0, syncMs: 0, damageMs: 0, renderMs: 0, impact: false, repairMs: 0 };
      const beforeSites = c.damage.sites.length;
      const t = performance.now(); c.reset(s.display.x, s.display.z, s.display.yaw); s.frame.repairMs = performance.now() - t;
      s.frame.repairState = { beforeSites, afterSites: c.damage.sites.length, revision: c.damage.revision, appliedBeforeSync: c.damage.applied };
    }, mode);
    await page.waitForFunction(() => dentShots.measureDone, { timeout: 20000 });
    const frames = await page.evaluate(() => dentShots.frames);
    const repair = frames[0]?.repairState;
    if (!repair || repair.afterSites || (mode === 'enabled' && !repair.beforeSites) || frames[0].applied !== repair.revision) report.validationFailures.push(`repair/${mode}: missing dent/reset/sync coverage`);
    return frames;
  }
  async function benchmark(type) {
    const fullSpeed = await page.evaluate(() => game.vehicles.current.t.topSpeed / 3.6);
    const reset = () => page.evaluate(() => game.vehicles.current.reset(dentShots.display.x, dentShots.display.z, dentShots.display.yaw));
    // Hold non-car visual clocks/emitters throughout both paths, so accumulating dust,
    // sparks, weather and bird motion cannot become the baseline/enabled difference.
    await page.evaluate(() => {
      dentShots.visualClocks = [];
      for (const [object, method] of [[game.effects, 'update'], [game.drivingFX, 'update'], [game.windView, 'update'], [game.atmosphere, 'update'], [game.world, 'tick']]) {
        if (!object?.[method]) continue;
        dentShots.visualClocks.push([object, method, object[method]]); object[method] = () => {};
      }
    });
    try {
      for (const speed of options.speeds.map(s => s === 'high' ? 45 : fullSpeed)) {
        const runs = { baseline: [], enabled: [] }, movingRuns = { baseline: [], enabled: [] }, repeatedRuns = { baseline: [], enabled: [] }, repairRuns = { baseline: [], enabled: [] };
        // Warm both paths, their shaders, private geometry and restoration uploads before timing.
        for (const mode of ['baseline', 'enabled']) { await reset(); await impact(type, 'warmup', speed, 0, true, mode); }
        await page.waitForFunction(() => game.world.pendingTiles() === 0, { timeout: 120000 });
        for (let sample = 0; sample < sampleCount; sample++) {
          const pair = {};
          for (const mode of sample % 2 ? ['enabled', 'baseline'] : ['baseline', 'enabled']) {
            await reset();
            const run = await impact(type, `timed-${sample}-${mode}`, speed, 0, true, mode);
            const index = run.frames.findIndex(f => f.impact);
            assert(index >= 0 && run.frames.slice(index, index + 3).every(f => Number.isFinite(f.intervalAfterMs)), 'distractodog: incomplete impact-frame timing');
            if (mode === 'enabled' && !run.frames.slice(index, index + 3).some(f => f.dirty && f.sites > 0 && f.applied === f.revision)) report.validationFailures.push(`${type}/${speed}/${sample}: no synced damage revision on impact frames`);
            runs[mode].push(...run.frames.slice(index, index + 3));
            const repeats = [];
            // Fixed three additional contacts exercise a populated field and several panels.
            for (const orientation of [0, Math.PI / 2, Math.PI]) {
              const repeat = await impact(type, `timed-repeat-${sample}-${mode}`, speed, orientation, true, mode);
              const at = repeat.frames.findIndex(f => f.impact);
              assert(at >= 0 && repeat.frames.slice(at, at + 3).length === 3, 'distractodog: incomplete repeated timing');
              repeatedRuns[mode].push(...repeat.frames.slice(at, at + 3)); repeats.push(repeat);
            }
            const move = await moving(mode); movingRuns[mode].push(...move.frames);
            const repair = await repairFrame(mode); repairRuns[mode].push(...repair);
            pair[mode] = { contact: run.contactPhysics, impactEnd: run.finalPhysics, repeats: repeats.map(r => r.finalPhysics), movingEnd: move.finalPhysics };
            report.measuredRuns.push({ type, speed, sample, mode, impact: run, repeats, moving: move, repair });
            if (mode === 'enabled') {
              const first = move.frames[0], last = move.frames.at(-1);
              if (!first?.sites || !last?.sites) report.validationFailures.push(`${type}: moving run lost dents`);
              if (!first || Math.hypot(...last.position.map((x, i) => x - first.position[i])) < .1) report.validationFailures.push(`${type}: no moving-car coverage`);
              const wheelRange = Math.max(...first.wheelY.map((_, i) => Math.max(...move.frames.map(f => f.wheelY[i])) - Math.min(...move.frames.map(f => f.wheelY[i]))));
              report.measuredRuns.at(-1).movingWheelRangeM = wheelRange;
              if (wheelRange < .0001) report.validationFailures.push(`${type}: no moving suspension coverage`);
            }
          }
          try { assert.deepEqual(pair.enabled, pair.baseline); }
          catch { report.validationFailures.push(`${type}/${speed}/${sample}: matched physics differ; inspect measuredRuns`); }
        }
        for (const [kind, data] of [['impact', runs], ['repeated', repeatedRuns], ['moving', movingRuns], ['repair', repairRuns]]) {
          const comparison = { type, speed, kind, samplePairs: sampleCount, ...compareFrames(data.baseline, data.enabled, kind, limits) };
          report.comparisons.push(comparison);
          if (!comparison.pass) report.validationFailures.push(`${type}/${speed}/${kind}: technical timing limits exceeded`);
        }
        await checkpoint();
      }
    } finally {
      await page.evaluate(() => { for (const [object, method, fn] of dentShots.visualClocks) object[method] = fn; });
    }
  }
  for (const type of options.types) {
    await page.evaluate(type => {
      dentShots.restore?.();
      game.vehicles.choose('car', type);
    }, type);
    await holdCar(page, { ...display, kind: 'car' });
    await page.evaluate(installDentTiming);
    await page.evaluate(() => {
      const c = game.vehicles.current, s = dentShots;
      s.clean = [];
      c.mesh.userData.bodyPivot.traverse(o => {
        if (o.isMesh && !o.name.startsWith('vehicle-')) s.clean.push({ mesh: o, p: o.geometry.attributes.position.array.slice(), count: o.userData.damageVertexCount ?? o.geometry.attributes.position.count });
      });
    });
    await benchmark(type);
    if (options.timingOnly) { await gpuCheck(type); continue; }
    await page.evaluate(() => game.vehicles.current.reset(dentShots.display.x, dentShots.display.z, dentShots.display.yaw));
    await pose(); await shots(type, 'pristine'); await perf(type, 'before');
    for (const [phase, speed] of [['low', 2], ['medium', 15], ['high', 45], ['full-speed', await page.evaluate(() => game.vehicles.current.t.topSpeed / 3.6)]]) {
      await page.evaluate(() => game.vehicles.current.reset(dentShots.display.x, dentShots.display.z, dentShots.display.yaw));
      await impact(type, phase, speed); await shots(type, phase);
      if (phase === 'low') assert.equal(await page.evaluate(() => game.vehicles.current.damage.sites.length), 0);
      else assert(await page.evaluate(() => game.vehicles.current.damage.sites.length) > 0);
    }
    await page.evaluate(() => game.vehicles.current.reset(dentShots.display.x, dentShots.display.z, dentShots.display.yaw));
    await impact(type, 'repeat-seed', 45);
    for (const [i, orientation] of [0, 0, Math.PI / 2, Math.PI].entries()) await impact(type, `repeat-${i + 1}`, 45, orientation);
    await shots(type, 'repeated'); await perf(type, 'after');
    // Inspect both actual LOD bodies from the same near camera (clearly labelled supplementary views).
    await page.evaluate(() => game.vehicles.current.mesh.userData.bodyPivot.traverse(o => { if (o.isLOD) { o.autoUpdate = false; o.levels.forEach((l, i) => { l.object.visible = i === o.levels.length - 1; }); } }));
    await shots(type, 'repeated-far-body-supplement');
    await page.evaluate(() => game.vehicles.current.mesh.userData.bodyPivot.traverse(o => { if (o.isLOD) o.autoUpdate = true; }));
    await gpuCheck(type);
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
    await pose(); await shots(type, 'reset'); await checkpoint();
  }
  assert.deepEqual([...report.errors, ...report.validationFailures], [], [...report.errors, ...report.validationFailures].join('\n'));
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.errors.push(`distractodog: ${error.stack || error.message}`);
  if (page && !page.isClosed()) {
    try {
      await page.screenshot({ path: join(out, 'failure.png') });
      report.shots.push({ file: 'failure.png', evidence: 'distractodog failure context; see report.errors and validationFailures' });
    } catch (captureError) { report.errors.push(`distractodog failure screenshot unavailable: ${captureError.message}`); }
  }
  throw error;
} finally {
  if (page && !page.isClosed()) {
    try {
      report.measurementRestored = await page.evaluate(() => {
        const s = window.dentShots; if (!s) return false;
        s.restore?.();
        for (const [object, method, fn] of s.visualClocks || []) object[method] = fn;
        game.renderer.render = s.originalRender; return true;
      });
    } catch (error) { report.errors.push(`distractodog restoration failed: ${error.message}`); report.status = 'failed'; process.exitCode = 1; }
  }
  report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.now() - started;
  await checkpoint();
  await browser?.close();
}
console.log(`distractodog: saved ${report.shots.length} PNGs and actual-impact/performance evidence to ${out}. Review all PNGs; appearance is not automatically approved.`);
