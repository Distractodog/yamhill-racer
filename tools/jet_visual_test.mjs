// Jet visual evidence: node tools/jet_visual_test.mjs --out <folder> [--url http://127.0.0.1:8173/]
// Needs the no-cache game server. CHROME_PATH selects another Chrome executable.
// Screenshots need human inspection; successful automation does not imply a visual verdict.
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const options = { url: 'http://127.0.0.1:8173/', out: 'jet-visual-results' };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  if (!Object.hasOwn(options, key) || !process.argv[i + 1]) throw new Error('Usage: --out <folder> --url <game URL>');
  options[key] = process.argv[i + 1];
}
await mkdir(options.out, { recursive: true });
const report = { phases: [], pageErrors: [], status: 'running', visualReview: 'NOT REVIEWED', ownerFlight: 'NOT VERIFIED' };
let browser, page;
const save = () => writeFile(join(options.out, 'jet-visual-report.json'), JSON.stringify(report, null, 2));
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--disable-background-timer-throttling'] });
  page = await browser.newPage(); await page.setViewport({ width: 1280, height: 760 });
  page.on('pageerror', e => { report.pageErrors.push(e.message); console.error('PAGE ERROR', e.message); });
  await page.evaluateOnNewDocument(() => { localStorage.setItem('yr-welcome-hidden-1', '1'); Object.defineProperty(navigator, 'getGamepads', { value: () => [] }); });
  await page.goto(options.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.game && game.world.pendingTiles() === 0, { timeout: 120000 });
  await page.evaluate(() => {
    const g = window.game; g.vehicles.switchTo('jet'); g.setCam(0);
    const j = g.vehicles.jet, original = j.step;
    window.jetVisual = { phase: '', elapsed: 0, original, frames: [], state: () => ({ mode: j.mode, speedKmh: j.vel.length() * 3.6,
      bank: j.bank, stall: j.stall, agl: j.agl, surface: game.world.surfaceAt(j.pos.x, j.pos.z), pos: j.pos.toArray(), quaternion: j.quat.toArray(), message: j.msg }) };
    // Test-only controller supplies inputs to the real fixed-step physics; never advances time itself.
    j.step = function(dt, input) {
      const s = window.jetVisual, J = { thr: 0, pitch: 0, roll: 0, yaw: 0 }, i = { ...input, handbrake: false, jet: J };
      const clamp = x => Math.max(-1, Math.min(1, x));
      const headingError = target => Math.atan2(Math.sin(target - j.heading()), Math.cos(target - j.heading()));
      if (s.phase === 'takeoff') {
        J.thr = 1; J.yaw = j.mode === 'ground' ? clamp(-4 * headingError(s.yaw)) : 0;
        J.pitch = j.mode === 'ground' ? (j.v * 3.6 > 240 ? 1 : 0) : clamp((Math.min(20, (300 - j.agl) * .15, j.airTime * 6) - j.vel.y) * .05);
      } else if (s.phase === 'pass') { J.thr = clamp((s.speed - j.vel.length() * 3.6) * .04); }
      else if (s.phase === 'bank') { J.roll = clamp((.8 - j.bank) * 3); J.thr = .4; J.pitch = .2; }
      else if (s.phase === 'stall') { J.thr = -1; J.pitch = 1; }
      else if (s.phase === 'landing') {
        if (j.mode === 'air') {
          const off = (j.pos.x - s.x) * Math.cos(s.yaw) - (j.pos.z - s.z) * Math.sin(s.yaw);
          const d = Math.atan2(Math.sin(s.yaw - Math.atan2(j.vel.x, j.vel.z)), Math.cos(s.yaw - Math.atan2(j.vel.x, j.vel.z)));
          const targetBank = Math.max(-.4, Math.min(.4, -d * 3 + off * .004));
          J.roll = clamp((targetBank - j.bank) * 3);
          const vy = j.agl > 6 ? -Math.min(4, Math.max(1.5, j.agl / 15)) : -1.2;
          J.pitch = clamp((vy - j.vel.y) * .25); J.thr = j.vel.length() * 3.6 > 300 ? -1 : 1;
        } else { J.thr = -1; i.handbrake = j.mode === 'ground'; J.yaw = clamp(-4 * headingError(s.yaw)); }
      } else if (s.phase === 'crash') { J.thr = 1; J.pitch = -1; }
      original.call(j, dt, i); s.elapsed += dt;
    };
  });
  const ramp = await page.evaluate(async () => { const r = await fetch('assets/ramps.json'); if (!r.ok) throw new Error('ramps fetch failed'); return (await r.json())[0]; });
  // Hold only during streaming; measurements begin after release, on actual game frames.
  const prepare = async ({ x = 0, z = 0, yaw = 0, altitude = 900, speed = 600, ground = false, phase }) => {
    await page.evaluate(({ x, z, yaw, altitude, speed, ground, phase }) => {
      const s = jetVisual, j = game.vehicles.jet;
      s.phase = ''; s.elapsed = 0; game.keys.clear();
      clearInterval(s.loading);
      s.loading = setInterval(() => {
        j.reset(x, z, yaw); j.pos.y = game.world.heightAt(x, z) + altitude; j._lastLoaded = null;
      }, 50);
      s.pendingSetup = { x, z, yaw, altitude, speed, ground, phase };
    }, { x, z, yaw, altitude, speed, ground, phase });
    try { await page.waitForFunction(() => {
      const s = jetVisual.pendingSetup; return game.world.loadedAt(s.x, s.z) && game.world.pendingTiles() === 0;
    }, { timeout: 120000 }); }
    finally { await page.evaluate(() => clearInterval(jetVisual.loading)); }
    await page.evaluate(() => {
      const s = jetVisual, p = s.pendingSetup, j = game.vehicles.jet;
      if (p.ground) {
        if (game.world.surfaceAt(p.x, p.z) !== 3) throw new Error('Hwy 18 takeoff start is not asphalt');
        j.reset(p.x, p.z, p.yaw);
      }
      else j.placeInAir(p.x, game.world.heightAt(p.x, p.z) + p.altitude, p.z, p.yaw, p.speed);
      j.safe = [[p.x, p.z, p.yaw]];
      Object.assign(s, p, { elapsed: 0 });
      s.frames = []; s.last = null; s.measuring = true;
      cancelAnimationFrame(s.raf);
      const frame = t => { if (!s.measuring) return; if (s.last !== null) s.frames.push(t - s.last); s.last = t; s.raf = requestAnimationFrame(frame); };
      s.raf = requestAnimationFrame(frame);
    });
  };
  const capture = async (name, setup, condition, timeout = 45000) => {
    const row = { phase: name, status: 'running', visualVerdict: 'NOT REVIEWED' }; report.phases.push(row);
    try {
      if (setup) await prepare(setup);
      await page.waitForFunction(condition, { timeout });
      row.captureState = await page.evaluate(() => jetVisual.state());
      row.screenshot = name + '.png'; await page.screenshot({ path: join(options.out, row.screenshot) });
      row.metrics = await page.evaluate(() => {
        const s = jetVisual, ms = s.frames, total = ms.reduce((a, b) => a + b, 0), sorted = [...ms].sort((a, b) => a - b);
        return { frames: ms.length, elapsedSeconds: total / 1000, fps: total ? ms.length * 1000 / total : null,
          slowFrames: ms.filter(t => t > 1000 / 30).length, slowPercent: ms.length ? 100 * ms.filter(t => t > 1000 / 30).length / ms.length : null,
          p95Ms: sorted[Math.floor(sorted.length * .95)] ?? null, worstMs: sorted.at(-1) ?? null, frameTimesMs: ms };
      });
      if (!row.metrics.frames) throw new Error('No measured frames');
      if (name === '05-landing' && row.captureState.surface !== 3) throw new Error('Touchdown was off the asphalt road');
      if (![...row.captureState.pos, ...row.captureState.quaternion, row.captureState.speedKmh].every(Number.isFinite)) throw new Error('Nonfinite jet state');
      row.status = 'captured';
    } catch (e) { row.status = 'failed'; row.error = e.message; console.error(name, e.message); }
    await save();
  };
  // This ramp axis was checked on current world data: all 3,003 samples from -4 km to +1 km
  // (5 m spacing; center and both main-wheel tracks ±1.4 m) are asphalt.
  const hx = Math.sin(ramp.yaw), hz = Math.cos(ramp.yaw);
  await capture('01-takeoff', { x: ramp.x - hx * 1600, z: ramp.z - hz * 1600, yaw: ramp.yaw, ground: true, phase: 'takeoff' },
    () => game.vehicles.jet.mode === 'air' && game.vehicles.jet.agl > 20 && jetVisual.elapsed > 3, 90000);
  for (const speed of [600, 1000, 1700]) {
    await capture(`02-pass-${speed}`, { x: -2000, z: 0, yaw: Math.PI / 2, altitude: 1200, speed, phase: 'pass' },
      () => jetVisual.elapsed > 3 && game.vehicles.jet.mode === 'air' && Math.abs(game.vehicles.jet.vel.length() * 3.6 - jetVisual.speed) < jetVisual.speed * .1);
  }
  await capture('03-banked-turn', { phase: 'bank', speed: 700 }, () => jetVisual.elapsed > 3 && game.vehicles.jet.mode === 'air' && Math.abs(game.vehicles.jet.bank) > .6);
  await capture('04-stall', { phase: 'stall', altitude: 1500, speed: 400 }, () => jetVisual.elapsed > 3 && game.vehicles.jet.mode === 'air' && game.vehicles.jet.stall, 60000);
  await capture('05-landing', { phase: 'landing', x: ramp.x - hx * 3400, z: ramp.z - hz * 3400, yaw: ramp.yaw, altitude: 81.6, speed: 330 },
    () => jetVisual.elapsed > 3 && game.vehicles.jet.mode === 'ground', 150000);
  await capture('06-crash', { phase: 'crash', x: 828, z: 480, yaw: Math.PI / 2, altitude: 150, speed: 500 },
    () => game.vehicles.jet.mode === 'crashed' && game.vehicles.jet.crashT > .35, 60000);
  if (report.phases.at(-1).status === 'captured') {
    await page.evaluate(() => { jetVisual.phase = ''; jetVisual.frames = []; jetVisual.last = null; });
    await capture('07-respawn', null, () => game.vehicles.jet.mode !== 'crashed', 30000);
  } else report.phases.push({ phase: '07-respawn', status: 'blocked', error: 'Crash phase did not capture a wreck' });
  report.status = report.pageErrors.length || report.phases.some(p => p.status !== 'captured') ? 'failed' : 'captured-awaiting-visual-review';
} catch (e) {
  report.status = 'blocked'; report.error = e.message; console.error('BLOCKED:', e.message);
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => { if (window.jetVisual) { const s = jetVisual; s.measuring = false; clearInterval(s.loading); cancelAnimationFrame(s.raf); game.vehicles.jet.step = s.original; } }).catch(() => {});
  await browser?.close(); await save();
}
console.table(report.phases.map(p => ({ phase: p.phase, status: p.status, fps: p.metrics?.fps?.toFixed(1), slowFrames: p.metrics?.slowFrames, screenshot: p.screenshot || 'none' })));
console.log(`Page errors: ${report.pageErrors.length}; status: ${report.status}. Screenshots require visual review; owner flight remains unverified.`);
if (report.status !== 'captured-awaiting-visual-review') process.exitCode = 1;
