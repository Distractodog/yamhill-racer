// distractodog: one-command real-game evidence, independent of cwd or existing servers.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
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
  let checkOnly = false, preparePreview = false;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--check-only') checkOnly = true;
    else if (arg === '--prepare-preview') preparePreview = true;
    else if (arg === '--out' && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) out = resolve(process.argv[++i]);
    else throw Error(`Unknown or incomplete argument: ${arg}. Use --out <directory> [--check-only] [--prepare-preview].`);
  }
  await mkdir(out, { recursive: true });
  for (const file of ['game/index.html', 'game/assets/world.json', 'game/assets/challenges.json', 'tools/car_damage_shots.mjs'])
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
      const dest = join(repo, 'tools/node_modules/three', file);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(three, file), dest);
    }
    console.log('distractodog: offline preview fixtures prepared in ignored tools/node_modules/three.');
  }
  if (checkOnly) {
    report.status = 'prepared';
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
    const args = [join(repo, 'tools/car_damage_shots.mjs'), '--url', report.url, '--out', out];
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
