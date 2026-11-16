// BR-1 river screenshots: side views of the South Yamhill at Sheridan, Willamina Creek, and the river in open fields.
//   node tools/river_shots.mjs --out <dir> [--assets <scratch assets dir>[,<dir>...]] [--url http://127.0.0.1:8173/]
// Without --url it serves game/ itself on a free local port; --assets then swaps in the tiles that a scratch build
// (YR_TILES=... YR_ASSETS=<dir> python tools/build_tiles.py) wrote, so river tiles can be looked at before a rebuild
// (e.g. --assets <scratch-a>,<scratch-b> for 2_1,3_1 and -2_2). Every other file comes from game/.
// Per spot: three fixed cameras (from the north bank, along the river from the west, high oblique) with the car
// hidden; prints the ground / water heights at the spot. Page errors exit nonzero. The images need looking at.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const SPOTS = {
  sheridan: { x: 3594, z: 1340 },           // South Yamhill under Bridge Street (no bridge deck yet: BR-2)
  willamina: { x: -3587, z: 3684 },         // Willamina Creek at the road crossing
  fields: { x: 5420, z: 1880 },             // South Yamhill through farm fields east of Sheridan
};
// camera offsets from the spot: [dx, height above the spot's ground, dz]
const CAMS = { north: [0, 10, -60], west: [-75, 6, 0], high: [40, 90, 70] };

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, '')] = args[i + 1];
if (!opt.out) { console.log('usage: node tools/river_shots.mjs --out <dir> [--assets <dir>[,<dir>]] [--url <game url>]'); process.exit(1); }
await fs.mkdir(opt.out, { recursive: true });

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'game');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };
const exists = f => fs.access(f).then(() => true, () => false);
function serve(overlays) {             // static game/ server; tiles found in an overlay folder are served from there
  const srv = http.createServer(async (req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    rel = path.normalize(rel);
    if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); return res.end(); }
    let file = path.join(ROOT, rel);
    const m = rel.split(path.sep);
    if (m[0] === 'assets' && m[1] === 'tiles' && m.length === 4)
      for (const o of overlays) if (await exists(path.join(o, 'tiles', m[2]))) { file = path.join(o, 'tiles', m[2], m[3]); break; }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

const overlays = (opt.assets || '').split(',').filter(Boolean).map(d => path.resolve(d));
for (const o of overlays) {
  const tiles = await fs.readdir(path.join(o, 'tiles')).catch(() => []);
  console.log('scratch tiles from', o + ':', tiles.join(' ') || 'NONE');
}
const server = opt.url ? null : await serve(overlays);
const url = opt.url || `http://127.0.0.1:${server.address().port}/`;
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--window-size=1280,800', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
let failed = false;
try {
  for (const [id, s] of Object.entries(SPOTS)) {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('requestfailed', r => { if (!/cloudflareinsights/.test(r.url())) errors.push('request failed ' + r.url()); });
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => { try { Object.defineProperty(navigator, 'getGamepads', { value: () => [] }); } catch {} });
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.game?.sessionSpawn, { timeout: 120000 });
    if (await page.evaluate(() => game.sessionSpawn.blocked)) {            // finish start-up through the spawn map
      await page.waitForSelector('#fullmap.open canvas', { visible: true, timeout: 30000 });
      const box = await (await page.$('#fullmap canvas')).boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForFunction(() => !game.sessionSpawn.blocked, { timeout: 120000 });
    }
    await page.evaluate(() => {
      document.getElementById('welcome-start')?.click();
      game.garage?.close(); game.challenges.quit(); game.minimap.toggle(false);
    });
    // hold the car on the spot until its tiles are in, then hide it and freeze it
    const info = await page.evaluate(async s => {
      const g = game; g.vehicles.switchTo('car'); const car = g.vehicles.current;
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const until = async (f, label) => { const t = performance.now(); while (!f()) { if (performance.now() - t > 120000) throw Error('timed out: ' + label); await sleep(100); } };
      car.step = () => {}; g.keys.clear();
      const hold = () => { car.pos.set(s.x, car.pos.y, s.z); car.vel.set(0, 0, 0); car._lastLoaded = null; car.savePrev(); car.interpolate(0); };
      hold(); const timer = setInterval(hold, 100);
      try { await until(() => g.world.loadedAt(s.x, s.z) && g.world.pendingTiles() === 0, 'tiles at the spot'); } finally { clearInterval(timer); }
      car.mesh.visible = false;
      const w = g.world.waterLevelAt(s.x, s.z);
      return { ground: g.world.heightAt(s.x, s.z), terrain: g.world.terrainAt(s.x, s.z), water: Number.isFinite(w) ? w : null, surface: g.world.surfaceAt(s.x, s.z) };
    }, s);
    console.log(`${id} (${s.x}, ${s.z}): ground ${info.ground.toFixed(2)} terrain ${info.terrain.toFixed(2)} water ${info.water === null ? '-' : info.water.toFixed(2)} surface ${info.surface}`);
    for (const [cam, [dx, dy, dz]] of Object.entries(CAMS)) {
      await page.evaluate(async (s, pos, base) => {
        const g = game, sleep = ms => new Promise(r => setTimeout(r, ms));
        const fix = () => { g.camera.position.set(...pos); g.camera.up.set(0, 1, 0); g.camera.lookAt(s.x, base + 1, s.z); g.camera.updateProjectionMatrix(); g.camera.updateMatrixWorld(); };
        if (!g._riverRender) { const render = g.renderer.render; g._riverRender = render;
          g.renderer.render = function (scene, cam) { if (cam === g.camera && g._riverFix) g._riverFix(); return render.call(this, scene, cam); }; }
        g._riverFix = fix; fix();
        await sleep(1500);
        const t = performance.now(); while (g.world.pendingTiles() > 0 && performance.now() - t < 60000) await sleep(100);
        await sleep(800);
      }, s, [s.x + dx, info.ground + dy, s.z + dz], info.ground);
      const file = path.join(opt.out, `river-${id}-${cam}.png`);
      await page.screenshot({ path: file });
      console.log('  wrote', file);
    }
    for (const e of errors) { console.log('PAGE ERROR', id, e); failed = true; }
    await page.close();
  }
} finally {
  await browser.close();
  server?.close();
}
process.exit(failed ? 1 : 0);
