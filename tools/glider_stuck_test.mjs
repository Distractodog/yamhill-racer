// BUG-1: real browser bank recovery; start tools/serve.py 8173 game first.
// node tools/glider_stuck_test.mjs --runs 50 --workers 4 --out /tmp/yr-glider-stress
// --runs is per vehicle. CPU throttle 4, real RAF, no replacement physics/tuning.
// --node checks real physics and extracted main.js input without a browser (not a browser substitute).
// --node --replay <browser-output-dir> also replays the recorded DOM events, with/without the repeat guard.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { startGame } from './lib/startgame.mjs';
const options = { runs: 50, workers: 4, out: '/tmp/yr-glider-stress', url: 'http://127.0.0.1:8173/', replay: '' };
const nodeMode = process.argv.includes('--node');
const args = process.argv.slice(2).filter(a => a !== '--node');
for (let i = 0; i < args.length; i += 2) {
  const name = args[i].replace(/^--/, '');
  if (!(name in options) || args[i + 1] === undefined) throw new Error(`Unknown/missing option: ${args[i]}`);
  options[name] = ['runs', 'workers'].includes(name) ? Number(args[i + 1]) : args[i + 1];
}
assert(!options.replay || nodeMode, '--replay requires --node');
assert(Number.isInteger(options.runs) && options.runs > 0, '--runs must be positive');
assert(Number.isInteger(options.workers) && options.workers > 0 && options.workers <= 4, '--workers must be 1–4');
await fs.mkdir(options.out, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
const jobs = ['car', 'bike'].flatMap(kind => Array.from({ length: options.runs }, (_, i) => ({ kind, run: i + 1 })));
if (nodeMode) { await nodeChecks(); process.exit(0); }
const results = [], errors = [], sourceChecks = [];
const expectedMain = await fs.readFile(new URL('../game/src/main.js', import.meta.url), 'utf8');
const sha256 = source => createHash('sha256').update(source).digest('hex');
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
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.setCacheEnabled(false);
    const scripts = [];
    cdp.on('Debugger.scriptParsed', script => {
      if (script.url.split('?')[0].endsWith('/src/main.js')) scripts.push(script);
    });
    await cdp.send('Debugger.enable');
    // Loading tiles is not enough: spawn.js pauses physics AND consumes keydown until a map point is chosen.
    await startGame(page, { url: options.url, spawn: { x: 0, z: 0 } });
    // Read the actual executed module, not a new fetch that might differ from a cached/other server's module.
    assert.equal(scripts.length, 1, 'expected one loaded src/main.js');
    const { scriptSource } = await cdp.send('Debugger.getScriptSource', { scriptId: scripts[0].scriptId });
    await cdp.send('Debugger.disable');
    const sourceCheck = { worker: workerId, url: scripts[0].url, expected: sha256(expectedMain),
      loaded: sha256(scriptSource), matches: scriptSource === expectedMain };
    sourceChecks.push(sourceCheck);
    await fs.writeFile(path.join(options.out, `source-${workerId}.json`), JSON.stringify(sourceCheck, null, 2));
    assert(sourceCheck.matches, `Served main.js differs from this worktree: ${JSON.stringify(sourceCheck)}. Serve this worktree's game/ and pass its port with --url.`);
    await page.evaluate(() => {
      for (const type of ['keydown', 'keyup']) addEventListener(type, e => {
        const s = window.__gliderStress;
        if (s) s.events.push({ type, code: e.code, key: e.key, repeat: e.repeat,
          wall: (performance.now() - s.start) / 1000, phase: s.phase, before: game.inputState() });
      }, true);
    });
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible', 'RAF target must be visible');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const key = (type, code, value, autoRepeat = false) => cdp.send('Input.dispatchKeyEvent', {
      type, code, key: value, windowsVirtualKeyCode: value.toUpperCase().charCodeAt(0), autoRepeat,
    });
    while (cursor < jobs.length) {
      const job = jobs[cursor++], right = job.run % 4 >= 2;
      const value = right ? 'd' : 'a', steer = right ? 1 : -1;
      const code = job.run % 2 ? (right ? 'KeyD' : 'KeyA') : (right ? 'KeyE' : 'KeyQ');
      const variant = `${job.run % 2 ? 'physical' : 'layout'}-${value}-repeat`;
      await page.evaluate(kind => {
        dispatchEvent(new Event('blur'));
        game.vehicles.switchTo(kind, { place: false });
        const v = game.vehicles.current;
        v.reset(0, 0, 0); v.pos.set(0, game.world.heightAt(0, 0) + 1500, 0);
        v.quat.identity(); v.vel.set(0, 0, 150 / 3.6); v.ang.set(0, 0, 0);
        v.grounded = false; v.airTime = 1; v._lastLoaded = null;
        v.savePrev(); v.renderPos.copy(v.pos); v.renderQuat.copy(v.quat); v.glide.toggle();
        const start = performance.now();
        const s = window.__gliderStress = { samples: [], events: [], start, phase: 'preflight', stalls: 0 };
        s.sample = () => {
          const q = v.quat;
          const bank = Math.atan2(2 * (q.x * q.y + q.z * q.w), 1 - 2 * (q.x * q.x + q.z * q.z));
          const state = [...v.pos.toArray(), ...v.vel.toArray(), ...q.toArray(), ...v.ang.toArray(), v.glide.bank, bank];
          const row = { wall: (performance.now() - start) / 1000, sim: v.glide.t, phase: s.phase,
            bank, reportedBank: v.glide.bank, steer: game.input.steer, vehicleSteer: v.steer, ...game.inputState(),
            active: v.glide.active, result: v.glide.result, finite: state.every(Number.isFinite),
            position: v.pos.toArray(), speed: v.vel.length() * 3.6,
            blocked: { spawn: game.sessionSpawn.blocked, respawn: game.respawnHold.blocked,
              garage: game.garage.open, picker: game.vehicles.open, builder: game.builder.open,
              map: game.minimap.open, welcome: !document.querySelector('#welcome').hidden, hidden: document.hidden } };
          s.samples.push(row); return row;
        };
        s.timer = setInterval(s.sample, 100);
      }, job.kind);
      try {
        // Abort a worker immediately if startup/pausing/deployment broke; do not spend 100 × 14 s testing no physics.
        try {
          await page.waitForFunction(() => game.vehicles.current.glide.active && game.vehicles.current.glide.t >= 0.1,
            { timeout: 15000 });
        } catch {
          throw new Error(`Preflight physics did not advance: ${JSON.stringify(await page.evaluate(() => __gliderStress.sample()))}`);
        }
        await page.evaluate(() => {
          const s = window.__gliderStress; s.phase = 'held';
          s.stallTimer = setInterval(() => {
            const until = performance.now() + [200, 20, 320, 45][s.stalls % 4];
            while (performance.now() < until) { /* intentional main-thread frame stall */ }
            s.stalls++;
          }, 1200);
        });
        await key('keyDown', code, value);
        await wait(900); await key('keyDown', code, value, true); await wait(1100);
        const banked = await page.evaluate(() => __gliderStress.sample());
        assert(banked.active && banked.steer === steer && Math.abs(banked.bank) > 0.2,
          `Held-key preflight did not bank: ${JSON.stringify(banked)}`);
        await key('keyUp', code, value);
        await page.evaluate(() => {
          const s = window.__gliderStress; s.phase = 'released'; s.release = s.sample();
        });
        // Deliberately inject an orphan repeat AFTER key-up. It must not become a new held key.
        await key('keyDown', code, value, true);
        await wait(12000);
        const data = await page.evaluate(() => {
          const s = window.__gliderStress;
          clearInterval(s.timer); clearInterval(s.stallTimer);
          const final = s.sample();
          return { samples: s.samples, events: s.events, release: s.release, final, stalls: s.stalls };
        });
        const reasons = [];
        const heldSamples = data.samples.filter(s => s.phase === 'held');
        const recovery = data.samples.filter(s => s.phase === 'released' && s.sim > data.release.sim + 0.025);
        const peakHeldBank = Math.max(0, ...heldSamples.map(s => Math.abs(s.bank)));
        const simulationRecovery = data.final.sim - data.release.sim;
        if (peakHeldBank < 0.2 || !heldSamples.some(s => s.steer === steer)) reasons.push('inconclusive: no meaningful held bank/steering');
        if (simulationRecovery < 6) reasons.push('inconclusive: fewer than 6 simulated recovery seconds');
        if (data.samples.some(s => !s.active)) reasons.push('glider folded/crashed during run');
        if (data.samples.some(s => !s.finite)) reasons.push('non-finite physics state');
        if (!recovery.length) reasons.push('inconclusive: no advancing recovery samples');
        if (data.release.keys.length || data.release.letters.length || recovery.some(s => s.steer !== 0 || s.keys.length || s.letters.length)) reasons.push('steering/key remained held after keyup');
        if (!data.events.some(e => e.type === 'keydown' && e.repeat && e.phase === 'released')) reasons.push('inconclusive: orphan repeat was not delivered');
        if (Math.abs(data.final.bank) >= 0.1) reasons.push('bank did not recover below 0.1 rad');
        if (recovery.some(s => s.sim - data.release.sim >= 6 && Math.abs(s.bank) >= 0.1)) reasons.push('bank stayed/returned above 0.1 rad after 6 simulated seconds');
        if (!data.stalls) reasons.push('inconclusive: no injected stalls');
        if (pageErrors.length) reasons.push('page errors');
        const result = { ...job, worker: workerId, variant, passed: reasons.length === 0, reasons,
          peakHeldBank, simulationRecovery, pageErrors: [...pageErrors], ...data };
        results.push(result);
        await fs.writeFile(path.join(options.out, `${job.kind}-${String(job.run).padStart(3, '0')}.json`), JSON.stringify(result, null, 2));
        console.log(`${result.passed ? 'PASS' : 'FAIL'} ${job.kind} ${job.run}/${options.runs} ${variant}: bank=${data.final.bank.toFixed(4)}, recovery=${simulationRecovery.toFixed(2)} sim s, stalls=${data.stalls}${reasons.length ? ' · ' + reasons.join('; ') : ''}`);
      } finally {
        await key('keyUp', code, value).catch(() => {}); // also release CDP's deliberately orphaned repeat
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
  failed: results.filter(r => !r.passed).length, errors, sourceChecks,
  method: 'Real rendered game loop; CDP keys including held/orphan repeats and alternate layout; CPU throttle 4; 200/20/320/45 ms stalls every 1200 ms; hold 2 wall seconds; sample each 100 ms for 12 wall seconds after keyup; no gamepad.',
  runs: results.map(({ samples, ...result }) => result) };
await fs.writeFile(path.join(options.out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ expected: summary.expected, completed: summary.completed, passed: summary.passed, failed: summary.failed, errors }));
if (summary.completed !== summary.expected || summary.failed || errors.length) process.exitCode = 1;


async function nodeChecks() {
  const { Car, TUNING_DEFAULTS } = await import('../game/src/car.js');
  const { Bike } = await import('../game/src/bike.js');
  const { Glider, BIKE_GLIDER } = await import('../game/src/glider.js');
  // Exercise the production key handlers/readInput, including code-to-letter ownership.
  // No separate imitation of key-up behaviour: fail if these source boundaries change.
  const source = await fs.readFile(new URL('../game/src/main.js', import.meta.url), 'utf8');
  const { c, handlers } = controlsFor(source);
  for (const type of ['blur', 'visibilitychange']) {
    handlers.get('keydown')({ code: 'KeyQ', key: 'a', repeat: false });
    handlers.get('keydown')({ code: 'KeyQ', key: 'a', repeat: true });
    c.readInput(); assert.equal(c.input.steer, -1);
    handlers.get(type)(); c.readInput();
    assert.equal(c.input.steer, 0, `${type} clears repeated layout steering`);
    assert.equal(c.keys.size, 0); assert.equal(c.letters.size, 0);
  }
  // A repeat can continue an owned press, but cannot create one after release/focus/UI clearing.
  for (const [code, key, steer] of [['KeyA', 'a', -1], ['KeyQ', 'a', -1], ['KeyD', 'd', 1], ['KeyE', 'd', 1]]) {
    for (const clear of ['keyup', 'blur', 'visibilitychange']) for (const upKey of [key, key.toUpperCase(), key === 'a' ? 'q' : 'e', 'Unidentified']) {
      c.clearKeys();
      const event = { code, key, repeat: false };
      handlers.get('keydown')(event);
      handlers.get('keydown')({ ...event, repeat: true });
      c.readInput(); assert.equal(c.input.steer, steer, 'owned repeat keeps steering');
      handlers.get(clear)({ ...event, key: upKey });
      handlers.get('keydown')({ ...event, repeat: true });
      c.readInput();
      assert.equal(c.input.steer, 0, `${code}: orphan repeat after ${clear} must not resurrect steering`);
      assert.equal(c.keys.size, 0); assert.equal(c.letters.size, 0);
      handlers.get('keydown')(event); c.readInput();
      assert.equal(c.input.steer, steer, 'fresh non-repeat press still works');
    }
  }
  // Two physical keys can legitimately own the same letter: releasing one must preserve the other.
  for (const [physical, layout, key, steer] of [['KeyA', 'KeyQ', 'a', -1], ['KeyD', 'KeyE', 'd', 1]]) {
    c.clearKeys();
    for (const code of [physical, layout]) handlers.get('keydown')({ code, key, repeat: false });
    handlers.get('keyup')({ code: physical });
    handlers.get('keydown')({ code: physical, key, repeat: true });
    c.readInput(); assert.equal(c.input.steer, steer);
    assert.equal(c.keys.has(physical), false, 'released physical alias stays released');
    handlers.get('keyup')({ code: layout });
    c.readInput(); assert.equal(c.input.steer, 0, 'last letter owner released');
  }
  const world = { heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3,
    waterLevelAt: () => -Infinity, normalAt: (_x, _z, n) => n.set(0, 1, 0),
    treesNear() {}, buildingsNear: () => [], loadedAt: () => true,
    extent: [-100000, -100000, 100000, 100000], rampAt: () => null };
  assert(source.includes('const STEP = 1 / 120;'));
  assert(source.includes('const dt = Math.min(0.1, (now - last) / 1000)'));
  const makeVehicle = kind => {
    const v = kind === 'car' ? new Car(world, { ...TUNING_DEFAULTS }) : new Bike(world);
    const g = new Glider(v, kind === 'bike' ? BIKE_GLIDER : {});
    v.pos.set(0, 1500, 0); v.vel.set(0, 0, 150 / 3.6);
    v.grounded = false; v.airTime = 1; g.toggle();
    assert(g.active); return v;
  };
  const step = 1 / 120;
  let seed = 0x91a2;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const results = [];
  for (const job of jobs) {
    const right = job.run % 4 >= 2, value = right ? 'd' : 'a', steer = right ? 1 : -1;
    const code = job.run % 2 ? (right ? 'KeyD' : 'KeyA') : (right ? 'KeyE' : 'KeyQ');
    const event = { code, key: value, repeat: false, preventDefault() {} };
    const v = makeVehicle(job.kind);
    c.clearKeys(); handlers.get('keydown')(event);
    let acc = 0, wall = 0, heldSteps = 0, releasedSteps = 0, releaseSim = null;
    let stalls = 0, peak = 0, recovery = null, nextSample = 0;
    const samples = [];
    while (wall < 14 - 1e-9) {
      const held = wall < 2 - 1e-9;
      if (!held && releaseSim === null) {
        handlers.get('keyup')({ ...event, key: value.toUpperCase() });
        handlers.get('keydown')({ ...event, repeat: true });
        releaseSim = v.glide.t;
        assert.equal(c.keys.size, 0); assert.equal(c.letters.size, 0);
      }
      if (held) handlers.get('keydown')({ ...event, repeat: true });
      // Boundary split delivers key-up at exactly 2 wall seconds, even amid long frames.
      const rawDt = random() < 0.08 ? 0.2 + random() * 0.3 : 0.008 + random() * 0.045;
      const dt = Math.min(rawDt, (held ? 2 : 14) - wall);
      if (dt > 0.1) stalls++;
      wall += dt; acc += Math.min(0.1, dt); c.readInput();
      assert.equal(c.input.steer, held ? steer : 0, 'production readInput after repeat/key-up');
      while (acc >= step) {
        v.step(step, c.input); acc -= step;
        if (held) { heldSteps++; peak = Math.max(peak, Math.abs(v.glide.bank)); }
        else {
          releasedSteps++;
          if (recovery === null && Math.abs(v.glide.bank) < 0.1) recovery = v.glide.t - releaseSim;
          if (v.glide.t - releaseSim > 6) assert(Math.abs(v.glide.bank) < 0.1, 'bank remained/returned stuck');
        }
        assert(v.glide.active, 'wing folded: incomplete flight');
        assert([...v.pos, ...v.vel, ...v.quat, ...v.ang].every(Number.isFinite));
      }
      if (wall >= nextSample) {
        samples.push({ wall, sim: v.glide.t, bank: v.glide.bank, steer: c.input.steer });
        nextSample = wall + 0.1;
      }
    }
    assert(peak > 0.2 && stalls > 0, 'meaningful steering and slow frames required');
    assert(releasedSteps * step >= 6, 'at least 6 simulated recovery seconds required');
    assert(Math.abs(v.glide.bank) < 0.1, 'final bank stuck');
    // Same steps at regular 120 Hz must give bit-identical physics, independently of RAF grouping.
    const reference = makeVehicle(job.kind);
    for (let i = 0; i < heldSteps + releasedSteps; i++) reference.step(step,
      { throttle: 0, brake: 0, steer: i < heldSteps ? steer : 0, handbrake: false, lean: false });
    for (const field of ['pos', 'vel', 'quat', 'ang']) assert.deepEqual(v[field].toArray(), reference[field].toArray(), field);
    const result = { ...job, code, value, peak, bank: v.glide.bank, recovery, heldSteps, releasedSteps, stalls, samples };
    results.push(result);
    await fs.writeFile(path.join(options.out, `node-${job.kind}-${job.run}.json`), JSON.stringify(result, null, 2));
  }
  const replay = options.replay ? await replayBrowserEvents(source, makeVehicle) : null;
  const summary = { mode: 'node', completed: results.length, stuck: 0, replay,
    worstFinalBank: Math.max(...results.map(r => Math.abs(r.bank))),
    slowestRecoverySimSeconds: Math.max(...results.map(r => r.recovery)),
    method: 'Real car/bike + glider; extracted production key handlers/readInput; both directions, physical/layout keys, held and orphan repeated keydown; seeded irregular 8–53 ms frames and 200–500 ms stalls; 0.1 s clamp + 120 Hz accumulator; 2 s hold and 12 s release; identical to regularly grouped physics steps. No browser event dispatch/rendering tested.' };
  await fs.writeFile(path.join(options.out, 'node-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

// Isolated production input listeners; no duplicated implementation of keys/letters/readInput.
function controlsFor(source) {
  const between = (start, end) => {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert(a >= 0 && b > a, `main.js source boundary: ${start}`);
    return source.slice(a, b);
  };
  const handlers = new Map();
  const context = vm.createContext({
    addEventListener: (type, fn) => handlers.set(type, fn),
    navigator: { getGamepads: () => [] },
    builder: { open: false }, settings: { open: false }, garage: { open: false }, vehicles: { open: false },
    audio: { start() {} },
  });
  vm.runInContext(between('const keys = new Set();', 'const builder = createBuilder') +
    between("addEventListener('keydown', e => {\n  if (e.gameUI", "addEventListener('pointerdown'") +
    between("addEventListener('blur', clearKeys);", '// ---------------------------------------------------------------- camera') +
    '\nglobalThis.controls = { keys, letters, clearKeys, input, readInput };', context);
  return { c: context.controls, handlers };
}


async function replayBrowserEvents(source, makeVehicle) {
  const report = JSON.parse(await fs.readFile(path.join(options.replay, 'summary.json'), 'utf8'));
  assert(report.runs?.length > 0, 'replay needs browser summary.json with event logs');
  const guard = '  if (e.repeat && !keys.has(e.code)) return;';
  assert(source.includes(guard), 'negative control requires the production repeat guard');
  const guarded = controlsFor(source), unguarded = controlsFor(source.replace(guard, ''));
  const results = [];
  for (const run of report.runs) {
    const events = run.events;
    assert(events?.length >= 4, `${run.kind}/${run.run}: missing recorded events`);
    assert(events.every((e, i) => Number.isFinite(e.wall) && (!i || e.wall >= events[i - 1].wall)), 'event order');
    assert(events.at(-1).type === 'keydown' && events.at(-1).repeat && events.at(-2).type === 'keyup',
      'replay expects the recorded orphan-repeat sequence');
    const variants = {};
    for (const [name, { c, handlers }] of [['guarded', guarded], ['unguarded', unguarded]]) {
      c.clearKeys(); c.readInput();
      const v = makeVehicle(run.kind), trace = [];
      let wall = 0, acc = 0, frame = 0;
      // Replay exact event order/fields/times, with deterministic irregular frames between events.
      const advance = end => {
        while (wall < end - 1e-9) {
          const dt = Math.min(end - wall, [1 / 60, 0.2, 1 / 30, 1 / 120, 0.045][frame++ % 5]);
          wall += dt; acc += Math.min(0.1, dt); c.readInput();
          while (acc >= 1 / 120) { v.step(1 / 120, c.input); acc -= 1 / 120; }
          assert(v.glide.active && [...v.pos, ...v.vel, ...v.quat, ...v.ang].every(Number.isFinite));
        }
      };
      for (const event of events) {
        advance(event.wall);
        assert(handlers.has(event.type), `unsupported replay event ${event.type}`);
        handlers.get(event.type)({ ...event, preventDefault() {} });
        c.readInput();
        trace.push({ ...event, keys: [...c.keys], letters: [...c.letters], steer: c.input.steer });
        if (event.type === 'keyup') {
          assert.equal(c.keys.size, 0, 'recorded key-up clears physical key');
          assert.equal(c.letters.size, 0, 'recorded key-up clears its layout mapping');
          assert.equal(c.input.steer, 0, 'readInput clears on key-up, before the injected repeat');
        }
      }
      const releaseSim = v.glide.t;
      advance(events.at(-1).wall + 12);
      variants[name] = { trace, bank: v.glide.bank, steer: c.input.steer, vehicleSteer: v.steer,
        keys: [...c.keys], letters: [...c.letters], recoverySimSeconds: v.glide.t - releaseSim };
      assert(v.glide.t - releaseSim >= 6, 'replay needs enough recovery physics');
      if (name === 'guarded') {
        assert.equal(c.input.steer, 0); assert.equal(c.keys.size, 0); assert.equal(c.letters.size, 0);
        assert(Math.abs(v.glide.bank) < 0.1 && Math.abs(v.steer) < 0.01, 'replayed bank and steering must recover');
      } else {
        assert(Math.abs(c.input.steer) === 1 && Math.abs(v.glide.bank) > 0.8,
          'negative control must reproduce the reported held-key/full-bank signature');
      }
    }
    results.push({ kind: run.kind, run: run.run, ...variants });
  }
  await fs.writeFile(path.join(options.out, 'node-replay.json'), JSON.stringify(results, null, 2));
  return { recordedRuns: results.length, guardedPassed: results.length, unguardedReproduced: results.length,
    worstGuardedBank: Math.max(...results.map(r => Math.abs(r.guarded.bank))),
    method: 'Exact recorded DOM event sequence and wall times; real car/bike/glider; irregular clamped frames. Negative control removes only the repeat guard; both controls assert keys AND letters clear at keyup.' };
}
