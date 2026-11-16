// Ramp marking visual QA at three RJ-1 audited taper meets: both driver directions and 40 m above.
// node tools/ramp_mark_shots.mjs --out <dir> --assets <scratch-sh>,<scratch-w>,<scratch-mc>
// Optional --url http://127.0.0.1:8173/ for an existing server (omit --assets), --only RJ-001,RJ-004,RJ-045.
// Without --url, uses the same temporary no-cache tile-overlay server as bridge_deck_shots.mjs.
// Plain scratch tiles are adapted in memory for the current packed-v3 game reader; game files stay untouched.
// Adds an overhead-gore close-up at the lane separation when taper metadata is available.
// Records page errors and 5 s frame timings per view; compare the same views against the baseline branch.
// --audit <ramps-audit.json> captures every audit row; omit --assets to use the rebuilt world.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

let SPOTS = {
  'RJ-001': { x: 3621, z: 2363, name: 'Sheridan highway exit' },
  'RJ-004': { x: 20268, z: -9741, name: 'McMinnville highway exit' },
  'RJ-045': { x: 17438, z: -8664, name: 'West bypass left merge' },
};

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, '')] = args[i + 1];
if (opt.audit) {
  const audit = JSON.parse(await fs.readFile(opt.audit, 'utf8'));
  SPOTS = Object.fromEntries((audit.rows || audit).map(r => [r.id, {
    x: r.x, z: r.z, name: `${r.type}: ${r.main?.name || r.main?.ref || r.id}`,
  }]));
}
if (!opt.out) { console.log('usage: node tools/ramp_mark_shots.mjs --out <dir> [--assets <dir>[,<dir>]] [--audit <audit.json>] [--url <game url>] [--only RJ-001,...]'); process.exit(1); }
await fs.mkdir(opt.out, { recursive: true });
const only = opt.only ? new Set(opt.only.split(',')) : null;
if (only) for (const id of only) if (!SPOTS[id]) throw Error(`Unknown spot ${id}; choose ${Object.keys(SPOTS).join(', ')}`);
if (opt.url && opt.assets) throw Error("--assets needs this script's overlay server; omit --url to serve scratch tiles.");

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'game');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };
// Build the exact tile -> source mapping before opening a port or launching Chrome. First overlay wins.
const overlays = (opt.assets || '').split(',').filter(Boolean).map(d => path.resolve(d));
const sources = new Map();
const baseWorld = JSON.parse(await fs.readFile(path.join(ROOT, 'assets/world.json'), 'utf8'));
for (const dir of overlays) {
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'world.json'), 'utf8'));
  if (manifest.packed && manifest.packed !== 3) throw Error(`${dir}: unsupported packed format ${manifest.packed}; use plain or packed-v3 scratch tiles`);
  for (const key of ['tile','hstep','hn','hm','surfN']) if (manifest[key] !== baseWorld[key])
    throw Error(`${dir}: ${key}=${manifest[key]} differs from game assets (${baseWorld[key]})`);
  const tiles = (await fs.readdir(path.join(dir, 'tiles'), { withFileTypes: true }))
    .filter(e => e.isDirectory() && /^-?\d+_-?\d+$/.test(e.name)).map(e => e.name).sort();
  console.log('scratch tiles from', dir + ':', tiles.join(' ') || 'NONE');
  for (const tile of tiles) {
    if (sources.has(tile)) { console.log(`  ${tile}: using earlier overlay ${sources.get(tile).dir}`); continue; }
    const plain = !manifest.packed;
    const names = plain ? ['height.bin','surface.bin','trees.bin','ponds.bin','tile.json','ground.png']
      : ['height.bin.gz','surface.bin.gz','trees.bin.gz','ponds.bin.gz','tile.json.gz','ground.webp'];
    for (const name of names) try { await fs.access(path.join(dir, 'tiles', tile, name)); }
      catch { throw Error(`${dir}: scratch tile ${tile} is missing ${name}`); }
    sources.set(tile, { dir, plain });
  }
}
const tileId = s => `${Math.floor((s.x + baseWorld.tile / 2) / baseWorld.tile)}_${Math.floor((s.z + baseWorld.tile / 2) / baseWorld.tile)}`;
for (const [id, s] of Object.entries(SPOTS)) {
  if (only && !only.has(id)) continue;
  const tile = tileId(s), source = sources.get(tile);
  console.log(`${id} (${s.x}, ${s.z}): tile ${tile}; source ${source ? source.dir : opt.url || 'game/assets'}`);
  if (overlays.length && !source) throw Error(`${id}: tile ${tile} is not provided by any --assets folder; supply its scratch assets or remove this spot with --only`);
  if (!baseWorld.tiles.some(([x,z]) => `${x}_${z}` === tile)) throw Error(`${id}: tile ${tile} is absent from the game world manifest`);
}
// Keep the published reader for v3 tiles. Only fetchReader-created closures for plain overlays use raw files.
// The query import loads the original module, rather than recursively importing this adapter.
const plainTiles = [...sources].filter(([,source]) => source.plain).map(([tile]) => tile);
const readerAdapter = `
import * as packed from './tilepack.js?rj2-native=1';
export * from './tilepack.js?rj2-native=1';
const plainTiles = new Set(${JSON.stringify(plainTiles)});
export function fetchReader(dir) {
  const read = packed.fetchReader(dir);
  read.rj2Plain = plainTiles.has(new URL(dir, location.href).pathname.split('/').at(-2));
  return read;
}
export async function readTileData(read, version) {
  if (!read.rj2Plain) return packed.readTileData(read, version);
  const [hbuf,sbuf,tbuf,pbuf,json] = await Promise.all(['height.bin','surface.bin','trees.bin','ponds.bin','tile.json'].map(read));
  return {hbuf,sbuf,tbuf,pbuf,tile:JSON.parse(new TextDecoder().decode(json))};
}
`;
function serve() {
  const logged = new Set();
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    rel = path.normalize(rel);
    if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); return res.end(); }
    if (rel === 'src/tilepack.js' && plainTiles.length && !url.searchParams.has('rj2-native')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); return res.end(readerAdapter);
    }
    let file = path.join(ROOT, rel), source;
    const m = rel.split(path.sep);
    if (m[0] === 'assets' && m[1] === 'tiles' && m.length === 4 && sources.has(m[2])) {
      source = sources.get(m[2]);
      // groundFile() still requests webp; createImageBitmap decodes the actual PNG bytes by their MIME type.
      const name = source.plain && m[3] === 'ground.webp' ? 'ground.png' : m[3];
      file = path.join(source.dir, 'tiles', m[2], name);
      if (!logged.has(m[2])) { logged.add(m[2]); console.log(`serving scratch tile ${m[2]} from ${source.dir} (${source.plain ? 'plain adapter' : 'packed v3'})`); }
    }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store',
        ...(source ? { 'X-Ramp-Scratch-Tile': m[2] } : {}) });
      res.end(body);
    } catch {
      if (source) console.error(`scratch tile ${m[2]}: cannot serve ${m[3]} from ${file}`);
      res.writeHead(404); res.end();
    }
  });
  return new Promise((ok, fail) => { srv.once('error', fail); srv.listen(0, '127.0.0.1', () => ok(srv)); });
}

const server = opt.url ? null : await serve();
const url = opt.url || `http://127.0.0.1:${server.address().port}/`;
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--window-size=1280,800', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
let failed = false;
try {
  for (const [id, s] of Object.entries(SPOTS)) {
    if (only && !only.has(id)) continue;
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => { errors.push(e.message); console.error('PAGE ERROR', id, e.message); });
    page.on('console', msg => { if (msg.type() === 'error' && !/cloudflareinsights/.test(msg.text() + (msg.location()?.url || ''))) console.error('PAGE CONSOLE', id, msg.text()); });
    page.on('response', r => { if (r.status() >= 400 && /\/assets\/tiles\//.test(r.url())) {
      const message = `tile response ${r.status()} ${r.url()}`; errors.push(message); console.error('PAGE ERROR', id, message);
    } });
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
    // hold the car on the spot until its tiles are in, then hide + freeze it; find the through strip and its direction
    const info = await page.evaluate(async s => {
      const g = game; g.vehicles.switchTo('car'); const car = g.vehicles.current;
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      // Keep both physics and the 100 ms timer pinned, even when a startup/menu pause skips physics.
      // Nose camera follows renderPos immediately, so streaming cannot stay at the previous camera position.
      g.keys.clear(); g.setCam(2);
      const hold = () => {
        const y = g.world.loadedAt(s.x,s.z) ? g.world.heightAt(s.x,s.z) + .75 : car.pos.y;
        car.pos.set(s.x, y, s.z); car.vel.set(0,0,0); car.ang.set(0,0,0); car._lastLoaded = null;
        car.savePrev(); car.interpolate(0);
      };
      car.step = hold; hold();
      g.camera.position.set(s.x,car.pos.y+5,s.z);
      const timer = setInterval(hold,100), start = performance.now();
      try {
        while (!g.world.loadedAt(s.x,s.z) || g.world.pendingTiles() > 0) {
          hold();
          if (performance.now()-start>120000) throw Error(`timed out: tile ${s.tile} at (${s.x},${s.z}); loadedAt=${g.world.loadedAt(s.x,s.z)}, pending=${g.world.pendingTiles()}, loadedTiles=${g.world.loadedTiles()}, car=(${car.pos.x},${car.pos.z}), camera=(${g.camera.position.x},${g.camera.position.z})`);
          await sleep(100);
        }
      } finally { clearInterval(timer); }
      hold();
      car.mesh.visible = false;
      // Prefer the widened through road over a nearby ramp.
      const segs = [];
      for (const p of g.world.tileAt(s.x, s.z)?.sourcePaths || []) for (let i = 0; i < p.pts.length - 1; i++) {
        const [ax, az] = p.pts[i], [bx, bz] = p.pts[i + 1], ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez; if (L2 < 1e-6) continue;
        const u = Math.min(1, Math.max(0, ((s.x - ax) * ex + (s.z - az) * ez) / L2));
        segs.push({ p, d: Math.hypot(ax + ex * u - s.x, az + ez * u - s.z), dx: ex / Math.sqrt(L2), dz: ez / Math.sqrt(L2) });
      }
      const pick = (ok, score) => segs.filter(ok).reduce((b, q) => (!b || score(q) < score(b) ? q : b), null);
      const best = pick(() => true, q => q.d - (q.p.widen && q.d < 30 ? 1000 : 0));
      const dx = best ? best.dx : 1, dz = best ? best.dz : 0;
      let gore = null;
      if (best?.p.widen) {
        const p = best.p, arc = [0];
        for (let i = 1; i < p.pts.length; i++) arc.push(arc[i-1] + Math.hypot(p.pts[i][0]-p.pts[i-1][0],p.pts[i][1]-p.pts[i-1][1]));
        const at = s => { let i=0; while(i<arc.length-2 && arc[i+1]<s)i++;
          const t=(s-arc[i])/Math.max(1e-6,arc[i+1]-arc[i]);
          return p.pts[i].map((v,k)=>v+(p.pts[i+1][k]-v)*t); };
        const wedges=p.widen.filter(q=>q[3]!==q[4]).map(q=>({q,meet:at(q[3]===0?q[1]:q[2])}));
        wedges.sort((a,b)=>Math.hypot(a.meet[0]-s.x,a.meet[1]-s.z)-Math.hypot(b.meet[0]-s.x,b.meet[1]-s.z));
        const wedge=wedges[0];
        if(wedge) {
          const q=wedge.q, joint=q[3]===0?q[2]:q[1];
          const full=p.widen.find(w=>w[0]===q[0] && w[3]===w[4] && (Math.abs(w[1]-joint)<.1||Math.abs(w[2]-joint)<.1));
          if(full) { const nose=at(Math.abs(full[1]-joint)<.1?full[2]:full[1]);
            const L=Math.hypot(nose[0]-wedge.meet[0],nose[1]-wedge.meet[1]);
            gore=[nose[0]+(nose[0]-wedge.meet[0])/L*15,nose[1]+(nose[1]-wedge.meet[1])/L*15]; }
        }
      }
      return { gore, deck: g.world.heightAt(s.x, s.z),
        strip: best && { cls: best.p.cls, widen: best.p.widen || [], distance: +best.d.toFixed(1) }, lane: best ? Math.min(3.5, best.p.w / 4) : 3, dx, dz };
    }, {...s,tile:tileId(s)});
    console.log(`${id} ${s.name} (${s.x}, ${s.z}): ${JSON.stringify(info.strip)}`);
    const { dx, dz } = info;
    const views = {
      forward: { pos: [s.x - dx * 40 - dz * info.lane, null, s.z - dz * 40 + dx * info.lane], look: [s.x + dx * 90 - dz * info.lane, null, s.z + dz * 90 + dx * info.lane] },
      reverse: { pos: [s.x + dx * 40 + dz * info.lane, null, s.z + dz * 40 - dx * info.lane], look: [s.x - dx * 90 + dz * info.lane, null, s.z - dz * 90 - dx * info.lane] },
      overhead: { pos: [s.x, info.deck + 40, s.z], look: [s.x + dx * .01, info.deck, s.z + dz * .01] },
    };
    if (info.gore) views['overhead-gore'] = { pos: [info.gore[0], info.deck + 40, info.gore[1]],
      look: [info.gore[0] + dx * .01, info.deck, info.gore[1] + dz * .01] };
    for (const [cam, v] of Object.entries(views)) {
      await page.evaluate(async (s, v, cam) => {
        const g = game, sleep = ms => new Promise(r => setTimeout(r, ms)), W = g.world;
        let pos = v.pos, look = v.look;
        if (cam.startsWith('overhead')) {
          const y = W.heightAt(pos[0], pos[2]); pos[1] = y + 40; look[1] = y;
        } else {
          pos = [pos[0], W.heightAt(pos[0], pos[2]) + 1.4, pos[2]]; look = [look[0], W.heightAt(look[0], look[2]) + 1.0, look[2]];
        }
        const fix = () => { g.camera.position.set(...pos); g.camera.up.set(0, 1, 0); g.camera.lookAt(...look); g.camera.updateProjectionMatrix(); g.camera.updateMatrixWorld(); };
        if (!g._rampRender) { const render = g.renderer.render; g._rampRender = render;
          g.renderer.render = function (scene, c) { if (c === g.camera && g._rampFix) g._rampFix(); return render.call(this, scene, c); }; }
        g._rampFix = fix; fix();
        await sleep(1500);
        const t = performance.now(); while (W.pendingTiles() > 0 && performance.now() - t < 60000) await sleep(100);
        await sleep(800);
      }, s, v, cam);
      const perf = await page.evaluate(async () => {
        const dt = []; let last = performance.now(), start = last;
        await new Promise(resolve => { const frame = t => { dt.push(t - last); last = t;
          if (t - start < 5000) requestAnimationFrame(frame); else resolve(); }; requestAnimationFrame(frame); });
        dt.sort((a,b) => a-b);
        return { median: dt[Math.floor(dt.length*.5)], p95: dt[Math.floor(dt.length*.95)],
          slowPct: 100*dt.filter(t=>t>20).length/dt.length, ...game.renderer.info.render };
      });
      console.log('  frame timings', cam, JSON.stringify(perf));
      const file = path.join(opt.out, `ramp-${id}-${cam}.png`);
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
