// No browser, socket, or external dependency: exercise the runner's exact request policy.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { exclusion, watchNetwork } from './lib/mp-browser-network.mjs';
const origin = 'http://127.0.0.1:12345', relay = 'ws://127.0.0.1:23456';
const page = new EventEmitter(), errors = [], logs = [];
page.url = () => origin + '/?nostats=1';
page.setRequestInterception = async value => assert.equal(value, true);
await watchNetwork(page, 'Mock', origin, relay, errors, logs);
function request(url, method = 'GET') {
  const actions = [];
  page.emit('request', { url: () => url, method: () => method,
    respond: value => { actions.push(value); }, continue: () => { actions.push('continue'); }, abort: () => { actions.push('abort'); } });
  assert.equal(actions.length, 1);
  return actions[0];
}
for (const url of ['https://static.cloudflareinsights.com/beacon.min.js', 'https://cloudflareinsights.com/cdn-cgi/rum', origin + '/favicon.ico']) {
  assert(exclusion(url, origin)); assert.equal(request(url).status, 200);
}
assert.equal(errors.length, 0); assert.equal(logs.length, 3);
for (const url of [origin + '/src/main.js', relay.replace('ws:', 'http:') + '/lobby',
  'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js', 'data:text/plain,ok', 'blob:' + origin + '/id']) assert.equal(request(url), 'continue');
for (const url of ['https://static.cloudflareinsights.com/beacon.min.js?unexpected=1',
  'https://cloudflareinsights.com/other', 'https://example.com/favicon.ico', origin + '/other/favicon.ico',
  'https://static.cloudflareinsights.com.evil.test/beacon.min.js', 'https://cdn.jsdelivr.net/npm/unexpected/index.js',
  'https://example.com/analytics']) {
  assert.equal(exclusion(url, origin), null);
  // Local paths proceed so their genuine HTTP failures are captured; foreign traffic is blocked.
  assert.equal(request(url), url.startsWith(origin + '/') ? 'continue' : 'abort');
}
const before = errors.length;
page.emit('console', { type: () => 'error', text: () => 'analytics text is still a genuine error', location: () => ({ url: origin + '/src/main.js', lineNumber: 9, columnNumber: 2 }) });
page.emit('pageerror', Error('uncaught'));
page.emit('requestfailed', { url: () => origin + '/asset.bin', failure: () => ({ errorText: 'net::ERR_ABORTED' }) });
page.emit('response', { status: () => 404, url: () => origin + '/other/favicon.ico' });
assert.equal(errors.length, before + 4);
assert(errors[before].includes('/src/main.js:9:2'));
console.log('PASS exact network opt-outs, unknown traffic rejection, console URLs, page/request/HTTP failures');

// Fail/interruption before server startup: exercise evidence writing and exit without opening sockets.
const { mkdtemp, writeFile, readFile } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { pathToFileURL, fileURLToPath } = await import('node:url');
const { spawn } = await import('node:child_process');
const temp = await mkdtemp(join(tmpdir(), 'yr-mp-runner-mock-'));
const loader = join(temp, 'loader.mjs');
await writeFile(loader, `export async function resolve(specifier, context, next) {
  if (specifier === 'puppeteer-core') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
    process.env.MP_MOCK_INTERRUPT ? "console.log('MOCK_IMPORT_READY'); await new Promise(r => setTimeout(r, 500)); export default {};" : "throw Error('MOCK_IMPORT_FAILURE');") };
  return next(specifier, context);
}`);
for (const interrupt of [false, true]) {
  const evidence = join(temp, interrupt ? 'interrupted' : 'failed');
  const child = spawn(process.execPath, ['--loader', pathToFileURL(loader).href,
    fileURLToPath(new URL('./mp_lifecycle_browser.mjs', import.meta.url)), evidence], {
    env: { ...process.env, MP_MOCK_INTERRUPT: interrupt ? '1' : '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', signalled = false;
  child.stdout.on('data', data => {
    output += data;
    if (interrupt && !signalled && output.includes('MOCK_IMPORT_READY')) { signalled = true; child.kill('SIGTERM'); }
  });
  child.stderr.on('data', data => { output += data; });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(deadline);
  assert.equal(code, 1, output);
  const report = JSON.parse(await readFile(join(evidence, 'report.json'), 'utf8'));
  assert.equal(report.status, 'fail');
  assert(report.logs.join('').includes(interrupt ? 'Interrupted by SIGTERM' : 'MOCK_IMPORT_FAILURE'));
  assert.deepEqual(report.sources, {}, 'No server/source reads before mocked import ends');
}
console.log('PASS runner import-failure/SIGTERM cleanup and retained reports (no sockets/browser)');
