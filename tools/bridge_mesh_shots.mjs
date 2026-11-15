// BR-4 bridge mesh screenshots: side, under and driver's views at the audited bridges and overpasses (BR-0 rows).
//   node tools/bridge_mesh_shots.mjs --out <dir> [--assets <scratch assets dir>[,<dir>...]] [--url http://127.0.0.1:8173/] [--only BR-009,BR-005]
// Without --url it serves game/ itself on a free local port; --assets then swaps in the tiles that a scratch build
// (YR_TILES=2_1,3_1 YR_ASSETS=<dir> python tools/build_tiles.py) wrote, so decks can be looked at before a rebuild
// (e.g. --assets <scratch-a>,<scratch-b> for 2_1,3_1 and 9_-4,10_-5). Every other file comes from game/.
// --audit <bridges-audit.json> replaces the short spot list with every audit row; omit --assets for rebuilt tiles.
// Per spot (car hidden and frozen): `side` 60 m off the deck, square to it; `under` low beside the river / on the road
// below, looking at the crossing; `driver` on the deck 40 m before the spot, looking along it. Prints the deck's
// heights every 10 m and whether the strip under the spot carries `bridge`. Page errors exit nonzero. Look at the images.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

let SPOTS = {
  'BR-009': { x: 3594, z: 1340, name: 'Sheridan Bridge (truss) over the South Yamhill' },
  'creek': { x: 5418, z: 1737, name: 'Hwy 18 creek bridge' },
  'BR-013': { x: 5147, z: 1811, name: 'Hwy 18 over the South Yamhill' },
  'BR-005': { x: 3570, z: 2382, name: 'S Bridge St over Hwy 18', under: true },
  'BR-001': { x: 20388, z: -10446, name: 'SE Three Mile Ln over a track', under: true },
  'BR-002': { x: 19443, z: -9115, name: 'SE Booth Bend Rd over the McMinnville bypass', under: true },
  'BR-003': { x: 20659, z: -10000, name: 'OR 18SP over the McMinnville bypass', under: true },
  'BR-004': { x: 17654, z: -8790, name: 'Hwy 18 over the W McMinnville bypass', under: true },
};

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, '')] = args[i + 1];
if (opt.audit) {
  const audit = JSON.parse(await fs.readFile(opt.audit, 'utf8'));
  SPOTS = Object.fromEntries((audit.rows || audit).map(r => {
    const tags = r.tags?.[r.deck_way_id] || {};
    const supported = r.roads?.some(p => p.way_id === r.deck_way_id && p.rendered_class);
    return [r.id, { x: r.x, z: r.z, name: `${r.type}: ${r.under}`, under: ['overpass', 'underpass'].includes(r.type),
      expectBridge: !!supported && !!tags.bridge && !['no', 'false', '0'].includes(tags.bridge) }];
  }));
}
if (!opt.out) { console.log('usage: node tools/bridge_mesh_shots.mjs --out <dir> [--assets <dir>[,<dir>]] [--audit <audit.json>] [--url <game url>] [--only BR-009,...]'); process.exit(1); }
await fs.mkdir(opt.out, { recursive: true });
const only = opt.only ? new Set(opt.only.split(',')) : null;

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
    if (only && !only.has(id)) continue;
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('requestfailed', r => errors.push('request failed ' + r.url()));
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
    // hold the car on the spot until its tiles are in, then hide + freeze it; find the deck strip and its direction
    const info = await page.evaluate(async s => {
      const g = game; g.vehicles.switchTo('car'); const car = g.vehicles.current;
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const until = async (f, label) => { const t = performance.now(); while (!f()) { if (performance.now() - t > 120000) throw Error('timed out: ' + label); await sleep(100); } };
      g.keys.clear(); g.setCam(2);
      const hold = () => {
        const y = g.world.loadedAt(s.x, s.z) ? g.world.heightAt(s.x, s.z) + .75 : car.pos.y;
        car.pos.set(s.x, y, s.z); car.vel.set(0, 0, 0); car.ang.set(0, 0, 0);
        car._lastLoaded = null; car.savePrev(); car.interpolate(0);
      };
      car.step = hold; hold(); g.camera.position.set(s.x, car.pos.y + 5, s.z);
      const timer = setInterval(hold, 100);
      try { await until(() => g.world.loadedAt(s.x, s.z) && g.world.pendingTiles() === 0, 'tiles at the spot'); } finally { clearInterval(timer); }
      car.mesh.visible = false;
      // nearest render strip to the spot (a `bridge` one if any within 25 m): its direction there; then the nearest
      // other strip within 20 m crossing it (the road below an overpass)
      const segs = [];
      for (const p of g.world.tileAt(s.x, s.z)?.sourcePaths || []) for (let i = 0; i < p.pts.length - 1; i++) {
        const [ax, az] = p.pts[i], [bx, bz] = p.pts[i + 1], ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez; if (L2 < 1e-6) continue;
        const u = Math.min(1, Math.max(0, ((s.x - ax) * ex + (s.z - az) * ez) / L2));
        segs.push({ p, d: Math.hypot(ax + ex * u - s.x, az + ez * u - s.z), dx: ex / Math.sqrt(L2), dz: ez / Math.sqrt(L2) });
      }
      const pick = (ok, score) => segs.filter(ok).reduce((b, q) => (!b || score(q) < score(b) ? q : b), null);
      const best = pick(() => true, q => q.d - (q.p.bridge && q.d < 25 ? 1000 : 0));
      const dx = best ? best.dx : 1, dz = best ? best.dz : 0;
      const low = pick(q => !q.p.bridge && q.d < 20 && Math.abs(q.dx * dx + q.dz * dz) < 0.8, q => q.d);
      const side = low ? [low.dx, low.dz] : [-dz, dx];
      const prof = [];
      for (let t = -60; t <= 60; t += 10) {
        const x = s.x + dx * t, z = s.z + dz * t;
        prof.push([t, +g.world.heightAt(x, z).toFixed(2), +g.world.terrainAt(x, z).toFixed(2)]);
      }
      const w = g.world.waterLevelAt(s.x, s.z);
      return { deck: g.world.heightAt(s.x, s.z), terrain: g.world.terrainAt(s.x, s.z), water: Number.isFinite(w) ? w : null,
        strip: best && { bridge: best.p.bridge || false, cls: best.p.cls, d: +best.d.toFixed(1) },
        below: low && { cls: low.p.cls, d: +low.d.toFixed(1) }, dx, dz, side, prof };
    }, s);
    console.log(`${id} ${s.name} (${s.x}, ${s.z}): deck ${info.deck.toFixed(2)} terrain ${info.terrain.toFixed(2)} ` +
      `water ${info.water === null ? '-' : info.water.toFixed(2)} strip ${JSON.stringify(info.strip)} below ${JSON.stringify(info.below)}`);
    console.log('  along the deck [m, heightAt, terrain]:', JSON.stringify(info.prof));
    if (!info.strip?.bridge && s.expectBridge !== false) { console.log('PAGE ERROR', id, 'expected bridge strip missing from loaded tiles'); failed = true; }
    const geometry = await page.evaluate(() => {
      const meshes = []; game.world.group.traverse(o => {
        if (o.name === 'bridges' || o.name === 'bridges-far') meshes.push({ name: o.name, visible: o.visible, triangles: o.geometry.attributes.position.count / 3 });
      }); return meshes;
    });
    console.log('  bridge meshes:', JSON.stringify(geometry));
    const { dx, dz } = info, nx = -dz, nz = dx;                          // square to the deck
    const views = {
      side: { pos: [s.x + nx * 60, info.deck + 3, s.z + nz * 60], look: [s.x, info.deck - 2, s.z] },
      under: { side: s.under ? info.side : [nx, nz] },                 // placed in the page: lower road / river bank
      driver: { pos: [s.x - dx * 40, null, s.z - dz * 40], look: [s.x + dx * 40, null, s.z + dz * 40] },
    };
    for (const [cam, v] of Object.entries(views)) {
      await page.evaluate(async (s, v, cam, under) => {
        const g = game, sleep = ms => new Promise(r => setTimeout(r, ms)), W = g.world;
        let pos = v.pos, look = v.look;
        if (cam === 'driver') {
          pos = [pos[0], W.heightAt(pos[0], pos[2]) + 1.4, pos[2]]; look = [look[0], W.heightAt(look[0], look[2]) + 1.0, look[2]];
        } else if (cam === 'under') {
          // overpass: 35 m out along the road below (terrain there is that road), eye 1.7 m up, looking under the deck;
          // river: 35 m off to the side, at the bank / water, looking up at the deck
          const [nx, nz] = v.side, x = s.x + nx * 35, z = s.z + nz * 35, y = W.terrainAt(x, z);
          pos = [x, y + 1.7, z]; look = [s.x, under ? y + 3 : W.terrainAt(s.x, s.z) + 3, s.z];
        }
        const fix = () => { g.camera.position.set(...pos); g.camera.up.set(0, 1, 0); g.camera.lookAt(...look); g.camera.updateProjectionMatrix(); g.camera.updateMatrixWorld(); };
        if (!g._deckRender) { const render = g.renderer.render; g._deckRender = render;
          g.renderer.render = function (scene, c) { if (c === g.camera && g._deckFix) g._deckFix(); return render.call(this, scene, c); }; }
        g._deckFix = fix; fix();
        await sleep(1500);
        const t = performance.now(); while (W.pendingTiles() > 0 && performance.now() - t < 60000) await sleep(100);
        await sleep(800);
      }, s, v, cam, !!s.under);
      const perf = await page.evaluate(async () => {
        const frames = []; let last = performance.now();
        for (let i = 0; i < 120; i++) { await new Promise(requestAnimationFrame); const now = performance.now(); frames.push(now - last); last = now; }
        frames.sort((a, b) => a - b);
        return { median: frames[60], p95: frames[114], over20: frames.filter(t => t > 20).length / frames.length, triangles: game.renderer.info.render.triangles, calls: game.renderer.info.render.calls };
      });
      console.log('  frame times', cam, JSON.stringify(perf));
      const file = path.join(opt.out, `bridge-${id}-${cam}.png`);
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
