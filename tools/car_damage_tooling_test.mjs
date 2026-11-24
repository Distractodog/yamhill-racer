// distractodog quick tests: timing guardrails and instrumentation, no browser/port/tiles.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { EventEmitter } from 'node:events';
import { readFile, writeFile, mkdtemp, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dentOptions, dentCasePlan, dentRunnerArgs, dentNetwork, dentSources, ANALYTICS_URLS } from './car_damage_check.mjs';
import { compareFrames, dentLimits, distribution, installDentTiming } from './lib/cardamageperf.mjs';
const limits = dentLimits();
const frame = (cpu, before = 16, after = 16) => ({ stepMs: .1, syncMs: cpu - .2, damageMs: cpu / 2, renderMs: .1, intervalBeforeMs: before, intervalAfterMs: after });
assert.deepEqual(distribution([4, 1, 3, 2]), { count: 4, median: 2, p95: 4, worst: 4 });
assert.throws(() => distribution([])); assert.throws(() => distribution([NaN]));
assert.throws(() => dentLimits('{"unknown":2}')); assert.throws(() => dentLimits('{"impactCpuP95AddedMs":-1}'));
assert(compareFrames([frame(1)], [frame(2)], 'impact', limits).pass);
const cpuFail = compareFrames([frame(1)], [frame(6)], 'impact', limits);
assert(!cpuFail.pass); assert(Math.abs(cpuFail.added.cpuP95Ms - 5) < 1e-9);
// Deformation stalls happen before render; GPU/driver stalls may appear after it.
for (const f of [frame(1, 60, 16), frame(1, 16, 60)]) {
  const result = compareFrames([frame(1)], [f], 'impact', limits);
  assert(!result.pass); assert.equal(result.enabled.frameMs.worst, 60); assert.equal(result.added.slow33Points, 100);
}
assert(!compareFrames([frame(1)], [frame(4)], 'moving', limits).pass);
assert(compareFrames([frame(1)], [frame(6)], 'impact', dentLimits('{"impactCpuP95AddedMs":5}')).pass);

const wall = { pts: [[-20, 0], [20, 0], [20, 20], [-20, 20]], top: 10, h: 10 };
function run(mode) {
  const W = { heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3,
    normalAt: (_x, _z, n = new THREE.Vector3()) => n.set(0, 1, 0), waterLevelAt: () => -Infinity,
    buildingsNear: () => [wall], treesNear() {}, loadedAt: () => true, rampAt: () => 0,
    extent: [-10000, -10000, 10000, 10000], spawn: [0, 0] };
  const c = new Car(W, { ...TUNING_DEFAULTS }); c.reset(0, -1.6, 0); c.vel.set(0, 0, 45);
  const originals = [c.step, c.recordImpact, c.syncMesh, c.damage.update];
  globalThis.game = { vehicles: { current: c } };
  globalThis.dentShots = { mode, kind: 'impact', running: true, measure: true, contacts: [], steps: 0, frame: null };
  installDentTiming(); const s = globalThis.dentShots;
  for (let i = 0; i < 601 && s.running; i++) { c.savePrev(); c.step(1 / 120); c.interpolate(1); c.syncMesh(1 / 60); }
  assert(s.finished && s.contacts.length && s.contactPhysics && s.finalPhysics);
  assert(s.steps > 36, 'follow-through physics must continue after contact');
  assert(s.frame.impact && s.frame.syncMs >= s.frame.damageMs && s.frame.stepMs > 0);
  assert.equal(c.damage.sites.length > 0, mode === 'enabled');
  const result = { contact: s.contactPhysics, final: s.finalPhysics };
  c.reset(0, -10, 0); c.interpolate(0); c.syncMesh(1 / 60);
  assert.equal(c.damage.sites.length, 0); assert.equal(s.frame.applied, c.damage.revision); assert(s.frame.dirty);
  s.restore(); assert.deepEqual([c.step, c.recordImpact, c.syncMesh, c.damage.update], originals);
  return result;
}
assert.deepEqual(run('baseline'), run('enabled'), 'instrumented production collision physics match');
delete globalThis.game; delete globalThis.dentShots;
console.log('distractodog PASS: guardrails catch CPU/before-render/after-render regressions; matched real collision physics and method restoration');

// Raw rates remain visible, but fractional-ms boundary crossings cannot decide a pass.
const frames = ms => ms.map(t => frame(1, t, t));
for (const [a, b] of [
  [[33.1, 33.2, 33.8, 34.4], [33.3, 33.6, 33.9, 34.3]],
  [[33.1, 33.3, 33.5, 33.8], [33.2, 33.4, 33.7, 34.1]],
]) {
  const comparison = compareFrames(frames(a), frames(b), 'repair', limits);
  assert.equal(comparison.added.slow33Points, 25); assert.equal(comparison.materialSlow.slow33Points, 0); assert(comparison.pass);
  assert(comparison.p95Confidence.includes('Insufficient'));
}
// Genuine multi-ms stalls still fail even below the 8ms p95 limit, and with an
// unchanged 60ms outlier. Different rendered frame counts use duration ranks.
for (const [a, b, metric] of [
  [[32.9, 32.9], [35.1, 35.1], 'slow33Points'],
  [[19.9, 19.9], [22.1, 22.1], 'slow20Points'],
  [[32, 32, 32, 60], [35, 35, 35, 60], 'slow33Points'],
  [[32, 60], [35, 35, 60, 60], 'slow33Points'],
]) {
  const comparison = compareFrames(frames(a), frames(b), 'repair', limits);
  assert(!comparison.pass); assert(comparison.checks.some(x => x.metric === metric && !x.pass));
}
assert(!compareFrames([frame(1, 33.2)], [frame(8, 33.4)], 'impact', limits).pass, 'CPU guardrail unchanged despite cadence jitter');

const focused = dentOptions(['--timing-only', '--speeds', 'full', '--samples', '4'], {});
assert.deepEqual(dentCasePlan(focused), { types: ['race', 'sports', 'hatch', 'rally', 'suv', 'truck'], speeds: ['full'], matchedPairs: 24,
  measuredRuns: 48, comparisons: 24, controlledWallApproaches: 204, gpuChecks: 6, gpuHelperCollisions: 12,
  expectedPNGs: 30, failurePNGAdditional: true, scope: 'timing + GPU; no Garage/paint/static appearance suite' });
const full = dentCasePlan(dentOptions([], {}));
assert.equal(full.controlledWallApproaches, 468); assert.equal(full.expectedPNGs, 234); assert.equal(full.measuredRuns, 96);
const forwarded = dentRunnerArgs(focused, 'http://127.0.0.1:23456/');
const parsed = dentOptions(forwarded, {}, true);
assert.equal(parsed.timingOnly, true); assert.deepEqual(parsed.speeds, ['full']); assert.equal(parsed.url, 'http://127.0.0.1:23456/');
for (const args of [['--types', 'race,bogus'], ['--types', 'race,race'], ['--speeds', 'low'], ['--samples', '9'], ['--samples'], ['--url', 'http://stale/']]) assert.throws(() => dentOptions(args, {}));
assert.deepEqual(dentOptions(['--help'], { YR_DENT_SAMPLES: 'bad' }), { help: true });

class FakePage extends EventEmitter {
  async setRequestInterception(v) { this.interception = v; }
  url() { return 'http://127.0.0.1:23456/'; }
}
function request(url, type = 'script') {
  return { url: () => url, method: () => 'GET', resourceType: () => type, headers: () => ({}),
    frame: () => ({ url: () => 'http://127.0.0.1:23456/' }), redirectChain: () => [], failure: () => ({ errorText: 'net::ERR_FAILED' }),
    async respond(response) { this.response = response; }, async continue() { this.continued = true; } };
}
const page = new FakePage(), network = { author: 'distractodog', errors: [], warnings: [] };
await dentNetwork(page, page.url(), network); assert(page.interception);
for (const url of [...ANALYTICS_URLS, page.url() + 'favicon.ico']) {
  const r = request(url); page.emit('request', r); await new Promise(setImmediate);
  assert(r.response && !r.continued); assert(network.excludedRequests.some(e => e.url === url && e.rationale));
}
for (const url of ['https://static.cloudflareinsights.com/beacon.min.js?unknown=1', 'https://cloudflareinsights.com/other', page.url() + 'assets/favicon.ico', page.url() + 'src/car.js']) {
  const r = request(url); page.emit('request', r); await new Promise(setImmediate); assert(r.continued && !r.response);
}
const missing = page.url() + 'assets/missing.bin';
page.emit('response', { status: () => 404, url: () => missing, request: () => request(missing, 'fetch') });
page.emit('console', { type: () => 'error', text: () => 'Failed to load resource: 404', location: () => ({ url: missing, lineNumber: 12, columnNumber: 3 }) });
page.emit('requestfailed', request(missing, 'fetch'));
page.emit('pageerror', Object.assign(Error('runtime fixture'), { stack: `fixture at ${page.url()}src/car.js:12:3` }));
assert.equal(network.errors.length, 4); assert(network.errors.slice(0, 3).every(x => x.includes(missing)));
assert(network.errors[3].includes('src/car.js:12:3')); assert.equal(network.networkEvents[1].location.lineNumber, 12); assert.equal(network.networkEvents[1].sourceURL, missing);
page.emit('console', { type: () => 'error', text: () => 'Failed to load resource: 404', location: () => ({ url: page.url() + 'favicon.ico' }) });
assert.equal(network.errors.length, 4);
page.emit('console', { type: () => 'error', text: () => 'CORS error mentioning cloudflareinsights.com/cdn-cgi/rum', location: () => ({}) });
page.emit('console', { type: () => 'error', text: () => 'Failed to load resource: unidentified 404 favicon', location: () => ({}) });
assert.equal(network.errors.length, 6, 'No broad CORS, analytics, favicon-text or unidentified 404 suppression');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const copy = await mkdtemp('/tmp/yr-dent-source-fixture-');
for (const file of ['game/index.html', 'game/src/car.js', 'game/assets/world.json', 'game/assets/challenges.json',
  'tools/car_damage_check.mjs', 'tools/car_damage_shots.mjs', 'tools/lib/cardamageperf.mjs', 'tools/lib/cardamagegpu.mjs', 'tools/lib/cardamagesite.mjs', 'tools/lib/startgame.mjs']) {
  await mkdir(dirname(join(copy, file)), { recursive: true }); await writeFile(join(copy, file), file);
}
const before = await dentSources(copy); assert.equal(before.game.commit, null); assert.equal(before.tools.commit, null);
await writeFile(join(copy, 'game/src/car.js'), 'changed game');
const after = await dentSources(copy); assert.notEqual(before.game.sha256, after.game.sha256); assert.equal(before.tools.sha256, after.tools.sha256);
const helpOut = join(copy, 'help-must-not-write');
for (const file of ['tools/car_damage_check.mjs', 'tools/car_damage_shots.mjs']) {
  const help = execFileSync(process.execPath, [join(root, file), '--help', '--out', helpOut], { cwd: copy, env: { ...process.env, CHROME_PATH: '/no-chrome', YR_DENT_SAMPLES: 'bad' }, encoding: 'utf8' });
  assert(help.includes('--timing-only') && help.includes('204 controlled wall approaches'));
}
await assert.rejects(stat(helpOut));

// Preserve the original lifecycle checks with mocked sockets/processes. Also verify that
// focused flags reach the child and existing evidence survives a failure.
const sourcePath = join(root, 'tools/car_damage_check.mjs'), original = await readFile(sourcePath, 'utf8');
for (const scenario of ['success', 'failure', 'interrupt', 'bind-failure']) {
  const out = await mkdtemp('/tmp/yr-dent-launcher-');
  await writeFile(join(out, 'existing.png'), 'preserve me');
  let closed = 0, disconnected = 0, spawned = false;
  const fakeProcess = new EventEmitter();
  Object.assign(fakeProcess, { argv: ['node', sourcePath, '--out', out, '--timing-only', '--speeds', 'full', '--samples', '4'], env: process.env, execPath: process.execPath,
    kill: (_pid, sig) => { assert.equal(sig, 'SIGINT'); setImmediate(() => child.emit('exit', null, sig)); } });
  const child = Object.assign(new EventEmitter(), { pid: 123456 });
  const server = Object.assign(new EventEmitter(), {
    listen: (port, host, ok) => { assert.equal(port, 0); assert.equal(host, '127.0.0.1'); setImmediate(() => scenario === 'bind-failure' ? server.emit('error', Error('fixture bind denied')) : ok()); },
    address: () => ({ port: 23456 }), close: cb => { closed++; cb?.(); }, closeAllConnections: () => disconnected++,
  });
  globalThis.dentMock = { process: fakeProcess, createServer: () => server, spawn: (_exe, args, opts) => {
    spawned = true; assert.equal(opts.cwd, root); assert(opts.detached);
    assert(args.includes('--url') && args.includes('http://127.0.0.1:23456/')); assert(args.includes(out));
    assert(args.includes('--timing-only')); assert.equal(args[args.indexOf('--speeds') + 1], 'full');
    setImmediate(() => scenario === 'interrupt' ? fakeProcess.emit('SIGINT') : child.emit('exit', scenario === 'failure' ? 7 : 0, null));
    return child;
  } };
  const source = original.replace("import { createServer } from 'node:http';", 'const { createServer } = globalThis.dentMock;')
    .replace("import { spawn } from 'node:child_process';", 'const { spawn, process } = globalThis.dentMock;')
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(sourcePath).href));
  await import('data:text/javascript;base64,' + Buffer.from(source + `\n// ${scenario}`).toString('base64'));
  const report = JSON.parse(await readFile(join(out, 'launcher-report.json')));
  assert.equal(report.author, 'distractodog'); assert(closed && disconnected); assert.equal(spawned, scenario !== 'bind-failure');
  assert.equal(report.status, scenario === 'success' ? 'passed' : scenario === 'interrupt' ? 'interrupted' : 'failed');
  assert.equal(fakeProcess.exitCode, scenario === 'success' ? undefined : scenario === 'interrupt' ? 130 : 1);
  assert.equal(fakeProcess.listenerCount('SIGINT'), 0); assert.equal(report.plan.measuredRuns, 48);
  assert(report.sources.game.sha256 && report.sources.tools.sha256); assert.equal(await readFile(join(out, 'existing.png'), 'utf8'), 'preserve me');
  console.log(`distractodog PASS launcher ${scenario}: focused arguments, metadata, report, cleanup and preserved evidence`);
}
delete globalThis.dentMock;
console.log('distractodog PASS: boundary-jitter/genuine-stall tests, strict resource attribution, exact analytics/favicon exclusions, CLI/case counts, source hashes and repair sync');
