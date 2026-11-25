// distractodog: one-command real-game evidence, independent of cwd or existing servers.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, realpath, stat, writeFile, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export const DENT_TYPES = ['race', 'sports', 'hatch', 'rally', 'suv', 'truck'];
export const ANALYTICS_URLS = ['https://static.cloudflareinsights.com/beacon.min.js', 'https://cloudflareinsights.com/cdn-cgi/rum'];
export const DENT_HELP = `distractodog car-dent validation (full suite by default)
node /absolute/worktree/tools/car_damage_check.mjs [options]
  --out DIR             Evidence directory (default /tmp/yr-car-dents-review)
  --types LIST          Comma-separated race,sports,hatch,rally,suv,truck (default all)
  --speeds LIST         Timed high (45 m/s),full (type top speed); default high,full
  --samples N           Matched baseline/enabled pairs per type/speed, 2..8 (default 4)
  --timing-only         Skip photographic/Garage/settled scenarios; retain all selected
                        impact/repeated/moving/repair timings and GPU checks (5 PNGs/type)
  --check-only          Check files/Chrome and print the case plan; no port or browser
  --prepare-preview     Copy ignored local Three.js preview fixtures
  --help                Print this help; no file writes, server or browser
Recommended cost rerun: --timing-only --speeds full --samples 4
All six types: 48 measured runs, 24 comparisons, 204 controlled wall approaches
(including 12 warmups), plus 6 GPU checks with 12 helper collisions, 30 GPU PNGs.
Small sample p95 is descriptive and insufficient for high-confidence tail estimates.
YR_DENT_LIMITS JSON configures technical limits; CPU/frame-time budgets are unchanged.
Only known analytics URLs are neutralized in this isolated test, with exact URL logs.
Launcher owns a new OS-chosen 127.0.0.1 port and automatically uses the heavy gate.
Direct runner also accepts --url URL; launcher never accepts an existing server URL.
`;
export function dentOptions(args, env = process.env, allowURL = false) {
  if (args.includes('--help')) return { help: true };
  const o = { out: '/tmp/yr-car-dents-review', types: [...DENT_TYPES], speeds: ['high', 'full'],
    samples: Number(env.YR_DENT_SAMPLES || 4), timingOnly: false, checkOnly: false, preparePreview: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--timing-only') o.timingOnly = true;
    else if (arg === '--check-only') o.checkOnly = true;
    else if (arg === '--prepare-preview') o.preparePreview = true;
    else if (['--out', '--types', '--speeds', '--samples', ...(allowURL ? ['--url'] : [])].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error(`distractodog missing value for ${arg}`);
      const key = arg.slice(2);
      o[key] = ['types', 'speeds'].includes(key) ? value.split(',') : key === 'samples' ? Number(value) : value;
    } else throw Error(`distractodog unknown option ${arg}; use --help`);
  }
  for (const [key, valid] of [['types', DENT_TYPES], ['speeds', ['high', 'full']]]) {
    if (!o[key].length || new Set(o[key]).size !== o[key].length || o[key].some(x => !valid.includes(x))) throw Error(`distractodog invalid --${key}`);
  }
  if (!Number.isInteger(o.samples) || o.samples < 2 || o.samples > 8) throw Error('distractodog --samples / YR_DENT_SAMPLES must be 2..8');
  return o;
}
export function dentCasePlan(o) {
  const groups = o.types.length * o.speeds.length;
  return { types: o.types, speeds: o.speeds, matchedPairs: groups * o.samples, measuredRuns: groups * o.samples * 2,
    comparisons: groups * 4, controlledWallApproaches: groups * (2 + o.samples * 8) + (o.timingOnly ? 0 : o.types.length * 10),
    gpuChecks: o.types.length, gpuHelperCollisions: o.types.length * 2, expectedPNGs: o.types.length * (o.timingOnly ? 5 : 39),
    failurePNGAdditional: true, scope: o.timingOnly ? 'timing + GPU; no Garage/paint/static appearance suite' : 'full suite' };
}
export function dentRunnerArgs(o, url) {
  return ['--url', url, '--out', resolve(o.out), '--types', o.types.join(','), '--speeds', o.speeds.join(','), '--samples', String(o.samples), ...(o.timingOnly ? ['--timing-only'] : [])];
}
export async function dentSources(root = repo) {
  async function source(directory, files) {
    const hashes = {};
    for (const file of files.sort()) hashes[file] = createHash('sha256').update(await readFile(join(directory, file))).digest('hex');
    let commit = null;
    try {
      // Copied/untracked sources must not inherit an unrelated parent checkout's commit.
      execFileSync('git', ['-C', directory, 'ls-files', '--error-unmatch', '--', ...files], { stdio: 'pipe' });
      commit = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch {}
    return { commit, sha256: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), files: hashes,
      note: 'Content hashes identify tested bytes, including dirty/copied/mixed sources; commit is nearest tracked Git HEAD when available.' };
  }
  const gameRoot = await realpath(join(root, 'game'));
  async function jsFiles(dir, prefix = '') {
    const entries = await readdir(join(dir, prefix), { withFileTypes: true }), files = [];
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) files.push(...await jsFiles(dir, name));
      else if (entry.name.endsWith('.js')) files.push(name);
    }
    return files;
  }
  return { game: await source(gameRoot, ['index.html', 'assets/world.json', 'assets/challenges.json', ...((await jsFiles(join(gameRoot, 'src'))).map(f => `src/${f}`))]),
    tools: await source(root, ['tools/car_damage_check.mjs', 'tools/car_damage_shots.mjs', 'tools/lib/cardamageperf.mjs', 'tools/lib/cardamagegpu.mjs', 'tools/lib/cardamagesite.mjs', 'tools/lib/startgame.mjs']) };
}

// Attach BEFORE navigation. No broad host, CORS, HTTP, or console-error exemptions.
export async function dentNetwork(page, url, report) {
  const favicon = new URL('/favicon.ico', url).href;
  report.networkPolicy = { analyticsURLs: [...ANALYTICS_URLS], faviconURL: favicon,
    rationale: 'Isolated performance test: empty the known analytics script before execution and neutralize only its exact beacon endpoint; favicon is not a game asset. Production telemetry is untouched.' };
  report.excludedRequests = []; report.networkEvents = [];
  function excluded(kind, resourceURL, detail = {}) { report.excludedRequests.push({ kind, url: resourceURL, ...detail, rationale: report.networkPolicy.rationale }); }
  function failure(event) { report.networkEvents.push(event); report.errors.push(`distractodog ${event.kind}: ${JSON.stringify(event)}`); }
  const locationOf = m => { try { return m.location() || {}; } catch { return {}; } };
  page.on('console', m => {
    const location = locationOf(m), event = { kind: 'console', type: m.type(), message: m.text(), sourceURL: location.url || null, location };
    if (m.type() === 'error') {
      if (m.text().startsWith('Failed to load resource') && location.url === favicon) excluded('favicon-console', favicon, { location, message: m.text() });
      else failure(event);
    } else if (m.type() === 'warn') { report.networkEvents.push(event); report.warnings.push(JSON.stringify(event)); }
  });
  page.on('pageerror', error => failure({ kind: 'pageerror', name: error.name, message: error.message, stack: error.stack, pageURL: page.url() }));
  page.on('response', response => {
    if (response.status() < 400) return;
    if (response.url() === favicon) excluded('favicon-response', favicon, { status: response.status() });
    else failure({ kind: 'http', url: response.url(), status: response.status(), method: response.request().method(), resourceType: response.request().resourceType() });
  });
  page.on('requestfailed', request => {
    let frameURL; try { frameURL = request.frame()?.url(); } catch {}
    const event = { kind: 'requestfailed', url: request.url(), method: request.method(), resourceType: request.resourceType(), frameURL,
      failure: request.failure(), redirects: request.redirectChain().map(r => r.url()) };
    if (request.url() === favicon) excluded('favicon-requestfailed', favicon, event); else failure(event);
  });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const resourceURL = request.url();
    const respond = async () => {
      if (ANALYTICS_URLS.includes(resourceURL)) {
        excluded('analytics', resourceURL, { method: request.method(), resourceType: request.resourceType() });
        if (resourceURL === ANALYTICS_URLS[0]) await request.respond({ status: 200, contentType: 'text/javascript', body: '/* distractodog: analytics disabled only in isolated validation */' });
        else await request.respond({ status: 204, headers: { 'access-control-allow-origin': new URL(url).origin,
          'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': request.headers()['access-control-request-headers'] || 'content-type' } });
      } else if (resourceURL === favicon) {
        excluded('favicon', resourceURL, { method: request.method() }); await request.respond({ status: 204 });
      } else await request.continue();
    };
    respond().catch(error => failure({ kind: 'interception', url: resourceURL, message: error.message }));
  });
}

export async function runDentCheck() {
  if (process.argv.includes('--help')) { console.log(DENT_HELP); return; }
  let server, child, interrupted = false, killTimer;
  const report = { author: 'distractodog', repo, status: 'preparing' };
  let out = resolve('/tmp/yr-car-dents-review');
  const signal = () => {
    interrupted = true;
    if (server) { server.close(); server.closeAllConnections(); }
    if (child?.pid) {
      // The gate and browser runner share this process group, so cancellation reaches both.
      try { process.kill(-child.pid, 'SIGINT'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
    }
  };
  process.on('SIGINT', signal);
  process.on('SIGTERM', signal);
  try {
    const options = dentOptions(process.argv.slice(2));
    const { checkOnly, preparePreview } = options;
    out = resolve(options.out); report.plan = dentCasePlan(options);
    report.sources = await dentSources();
    await mkdir(out, { recursive: true });
    for (const file of ['game/index.html', 'game/assets/world.json', 'game/assets/challenges.json', 'tools/car_damage_shots.mjs', 'tools/lib/cardamageperf.mjs', 'tools/lib/cardamagegpu.mjs'])
      await access(join(repo, file), constants.R_OK);
    for (const name of ['puppeteer-core', 'three']) require.resolve(name);
    report.chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    await access(report.chrome, constants.X_OK);
    const gate = join(homedir(), 'argus-runs', '.heavy', 'heavy');
    report.gate = await access(gate, constants.X_OK).then(() => gate, () => null);
    if (preparePreview) {
      // Plain, ignored files: Argus browse deliberately cannot follow node_modules symlinks.
      const three = dirname(dirname(require.resolve('three')));
      for (const file of ['build/three.module.js', 'examples/jsm/math/ConvexHull.js', 'examples/jsm/utils/BufferGeometryUtils.js']) {
        const dest = join(repo, 'tools/node_modules/car-damage-three', file);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(join(three, file), dest);
      }
      console.log('distractodog: offline preview fixtures prepared in ignored tools/node_modules/car-damage-three.');
    }
    if (checkOnly) {
      report.status = 'prepared';
      console.log('distractodog case plan: ' + JSON.stringify(report.plan));
      console.log(`distractodog: preparation passed; Chrome and dependencies present; heavy gate ${report.gate ? 'available' : 'unavailable (runner will run directly)'}. No port bound or browser launched.`);
    } else {
      const root = await realpath(join(repo, 'game'));
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.wav': 'audio/wav' };
      server = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
          if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
          const path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
          let file = await realpath(resolve(root, `.${path}`));
          if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
          if ((await stat(file)).isDirectory()) file = await realpath(join(file, 'index.html'));
          if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
          const info = await stat(file);
          if (!info.isFile()) throw Error('Not a file');
          res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Content-Length': info.size });
          if (req.method === 'HEAD') res.end();
          else createReadStream(file).on('error', () => res.destroy()).pipe(res);
        } catch (e) { res.writeHead(e instanceof URIError ? 400 : 404); res.end(); }
      });
      await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
      if (interrupted) throw Error('Interrupted');
      report.url = `http://127.0.0.1:${server.address().port}/`;
      console.log(`distractodog: serving this worktree at ${report.url}; evidence: ${out}`);
      const args = [join(repo, 'tools/car_damage_shots.mjs'), ...dentRunnerArgs(options, report.url)];
      const code = await new Promise((ok, fail) => {
        child = spawn(report.gate || process.execPath, report.gate ? [process.execPath, ...args] : args,
          { cwd: repo, stdio: 'inherit', detached: true });
        child.once('error', fail);
        child.once('exit', (code, sig) => { report.runnerSignal = sig; ok(code); });
      });
      if (interrupted || code !== 0) throw Error(`Screenshot runner ${interrupted ? 'interrupted' : `failed (exit ${code}, signal ${report.runnerSignal})`}`);
      report.status = 'passed';
    }
  } catch (e) {
    report.status = interrupted ? 'interrupted' : 'failed'; report.error = e.message;
    console.error(`distractodog: ${e.message}. Existing report/PNGs are preserved in ${out}; see launcher-report.json. Full-game validation has not passed.`);
    process.exitCode = interrupted ? 130 : 1;
  } finally {
    clearTimeout(killTimer);
    if (server) { await new Promise(ok => { server.close(ok); server.closeAllConnections(); }); }
    process.off('SIGINT', signal); process.off('SIGTERM', signal);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'launcher-report.json'), JSON.stringify(report, null, 2) + '\n');
  }

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runDentCheck();
