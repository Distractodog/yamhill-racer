// BUG-1: real browser bank recovery; start tools/serve.py 8173 game first.
// node tools/glider_stuck_test.mjs --runs 50 --workers 4 --out /tmp/yr-glider-stress
// --runs is per vehicle. CPU throttle 4, real RAF, no replacement physics/tuning.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const options = { runs: 50, workers: 4, out: '/tmp/yr-glider-stress', url: 'http://127.0.0.1:8173/' };
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i].replace(/^--/, '');
  if (!(name in options) || process.argv[i + 1] === undefined) throw new Error(`Unknown/missing option: ${process.argv[i]}`);
  options[name] = ['runs', 'workers'].includes(name) ? Number(process.argv[i + 1]) : process.argv[i + 1];
}
assert(Number.isInteger(options.runs) && options.runs > 0, '--runs must be positive');
assert(Number.isInteger(options.workers) && options.workers > 0 && options.workers <= 4, '--workers must be 1–4');
await fs.mkdir(options.out, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
const jobs = ['car', 'bike'].flatMap(kind => Array.from({ length: options.runs }, (_, i) => ({ kind, run: i + 1 })));
const results = [], errors = [];
let cursor = 0;
let browser;
try { browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', protocolTimeout: 120000, dumpio: process.env.CHROME_DUMPIO === '1',
  args: ['--window-size=800,600', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
}); } catch (error) { errors.push(`Browser launch failed: ${error.stack || error}`); }
async function worker(workerId) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => { pageErrors.push(e.message); console.log('PAGE ERROR', workerId, e.message); });
  try {
    await page.setViewport({ width: 800, height: 600 });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('yr-welcome-hidden-1', '1');
      Object.defineProperty(navigator, 'getGamepads', { value: () => [] });
    });
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.goto(options.url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.game && game.world.loadedAt(0, 0) && game.world.pendingTiles() === 0,
      { timeout: 120000 });
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible', 'RAF target must be visible');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const key = (type, code, value, autoRepeat = false) => cdp.send('Input.dispatchKeyEvent', {
      type, code, key: value, windowsVirtualKeyCode: value.toUpperCase().charCodeAt(0), autoRepeat,
    });
    while (cursor < jobs.length) {
      const job = jobs[cursor++], code = job.run % 2 ? 'KeyA' : 'KeyQ';
      const variant = code === 'KeyA' ? 'physical-A-repeat' : 'layout-Q-as-a-repeat';
      await page.evaluate(kind => {
        dispatchEvent(new Event('blur'));
        game.vehicles.switchTo(kind, { place: false });
        const v = game.vehicles.current;
        v.reset(0, 0, 0); v.pos.set(0, game.world.heightAt(0, 0) + 1500, 0);
        v.quat.identity(); v.vel.set(0, 0, 150 / 3.6); v.ang.set(0, 0, 0);
        v.grounded = false; v.airTime = 1; v._lastLoaded = null;
        v.savePrev(); v.renderPos.copy(v.pos); v.renderQuat.copy(v.quat); v.glide.toggle();
        const start = performance.now();
        const s = window.__gliderStress = { samples: [], start, phase: 'held', stalls: 0 };
        s.sample = () => {
          const q = v.quat;
          const bank = Math.atan2(2 * (q.x * q.y + q.z * q.w), 1 - 2 * (q.x * q.x + q.z * q.z));
          const state = [...v.pos.toArray(), ...v.vel.toArray(), ...q.toArray(), ...v.ang.toArray(), v.glide.bank, bank];
          const row = { wall: (performance.now() - start) / 1000, sim: v.glide.t, phase: s.phase,
            bank, reportedBank: v.glide.bank, steer: game.input.steer, keys: [...game.keys],
            active: v.glide.active, result: v.glide.result, finite: state.every(Number.isFinite),
            position: v.pos.toArray(), speed: v.vel.length() * 3.6 };
          s.samples.push(row); return row;
        };
        s.timer = setInterval(s.sample, 100);
        s.stallTimer = setInterval(() => {
          const until = performance.now() + 200;
          while (performance.now() < until) { /* intentional main-thread frame stall */ }
          s.stalls++;
        }, 1200);
      }, job.kind);
      let held = false;
      try {
        await key('keyDown', code, 'a'); held = true;
        await wait(900); await key('keyDown', code, 'a', true); await wait(1100);
        await key('keyUp', code, 'a'); held = false;
        await page.evaluate(() => {
          const s = window.__gliderStress; s.phase = 'released'; s.release = s.sample();
        });
        await wait(12000);
        const data = await page.evaluate(() => {
          const s = window.__gliderStress;
          clearInterval(s.timer); clearInterval(s.stallTimer);
          const final = s.sample();
          return { samples: s.samples, release: s.release, final, stalls: s.stalls };
        });
        const reasons = [];
        const heldSamples = data.samples.filter(s => s.phase === 'held');
        const recovery = data.samples.filter(s => s.phase === 'released' && s.sim > data.release.sim + 0.025);
        const peakHeldBank = Math.max(0, ...heldSamples.map(s => Math.abs(s.bank)));
        const simulationRecovery = data.final.sim - data.release.sim;
        if (peakHeldBank < 0.2 || !heldSamples.some(s => s.steer === -1)) reasons.push('inconclusive: no meaningful held bank/steering');
        if (simulationRecovery < 6) reasons.push('inconclusive: fewer than 6 simulated recovery seconds');
        if (data.samples.some(s => !s.active)) reasons.push('glider folded/crashed during run');
        if (data.samples.some(s => !s.finite)) reasons.push('non-finite physics state');
        if (!recovery.length || recovery.some(s => s.steer !== 0 || s.keys.includes(code))) reasons.push('steering/key remained held after keyup');
        if (Math.abs(data.final.bank) >= 0.1) reasons.push('bank did not recover below 0.1 rad');
        if (!data.stalls) reasons.push('inconclusive: no injected stalls');
        if (pageErrors.length) reasons.push('page errors');
        const result = { ...job, worker: workerId, variant, passed: reasons.length === 0, reasons,
          peakHeldBank, simulationRecovery, pageErrors: [...pageErrors], ...data };
        results.push(result);
        await fs.writeFile(path.join(options.out, `${job.kind}-${String(job.run).padStart(3, '0')}.json`), JSON.stringify(result, null, 2));
        console.log(`${result.passed ? 'PASS' : 'FAIL'} ${job.kind} ${job.run}/${options.runs} ${variant}: bank=${data.final.bank.toFixed(4)}, recovery=${simulationRecovery.toFixed(2)} sim s, stalls=${data.stalls}${reasons.length ? ' · ' + reasons.join('; ') : ''}`);
      } finally {
        if (held) await key('keyUp', code, 'a').catch(() => {});
        await page.evaluate(() => {
          const s = window.__gliderStress;
          if (s) { clearInterval(s.timer); clearInterval(s.stallTimer); }
          dispatchEvent(new Event('blur'));
        }).catch(() => {});
      }
    }
  } finally { await context.close(); }
}
try {
  const settled = browser ? await Promise.allSettled(Array.from({ length: Math.min(options.workers, jobs.length) }, (_, i) => worker(i + 1))) : [];
  for (const item of settled) if (item.status === 'rejected') errors.push(String(item.reason?.stack || item.reason));
} finally { if (browser) await browser.close(); }
results.sort((a, b) => a.kind.localeCompare(b.kind) || a.run - b.run);
const summary = { options, expected: jobs.length, completed: results.length, passed: results.filter(r => r.passed).length,
  failed: results.filter(r => !r.passed).length, errors,
  method: 'Real rendered game loop; CDP keys including repeat and alternate layout; CPU throttle 4; 200 ms stall every 1200 ms; hold 2 wall seconds; sample each 100 ms for 12 wall seconds after keyup; no gamepad.',
  runs: results.map(({ samples, ...result }) => result) };
await fs.writeFile(path.join(options.out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ expected: summary.expected, completed: summary.completed, passed: summary.passed, failed: summary.failed, errors }));
if (summary.completed !== summary.expected || summary.failed || errors.length) process.exitCode = 1;
