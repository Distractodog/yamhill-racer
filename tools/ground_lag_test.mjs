// Ground lag / loading speed in the real game (headless Chrome; needs the preview server). For each URL (and --runs
// times, median of the runs reported):
//   · map check: the full map (M) opened for 1.5 s and closed, then 2 s where every animation frame must also draw the
//     3D view (renderer.info.render.frame) — a render-skip flag left on after the map closes fails the test;
//   · loading: the car jumps from the spawn to McMinnville, then to the forest: seconds until the ground under it is
//     built and until nothing is pending, tiles built per second;
//   · drives: the car held on a straight line (heading and speed set each frame, everything vertical is the physics) at
//     100 / 300 / 1000 km/h on the campus drive, McMinnville NE 3rd St and through the north forest, --secs each: frame
//     interval median / p95 / p99, % over 20 and 33 ms, long tasks (> 50 ms), draw calls / triangles (median, max),
//     shader programs added, frames with no ground under the car, tiles still pending at the end.
//   node tools/ground_lag_test.mjs [--url http://127.0.0.1:8173/] [--before <url of the old code>] [--runs 3] [--secs 10]
//     [--only campus,town] [--out f.json]
// Headless Chrome is slower than a real browser for every version: compare before → after, not absolute numbers. Use
// the heavy gate. Exit 1 on page errors or a failed map check.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const URL_AFTER = opt('url', 'http://127.0.0.1:8173/'), URL_BEFORE = opt('before'), RUNS = +opt('runs', 3), SECS = +opt('secs', 10);
const PLACES = {
  campus: { x: -542, z: 440, yaw: 1.8, cls: 4 },
  town: { x: 19451, z: -11032, yaw: -1.573, cls: 3 },
  forest: { x: 0, z: -20000, yaw: Math.PI / 2, cls: 1 },
};
const only = opt('only') ? opt('only').split(',') : Object.keys(PLACES), SPEEDS = [100, 300, 1000];
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

async function session(url) {
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760 });
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR', e.message); });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('yr-welcome-hidden-1', '1');
    try { Object.defineProperty(navigator, 'getGamepads', { value: () => [] }); } catch {}
    window.__long = [];
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ entryTypes: ['longtask'] }); } catch {}
  });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.game?.sessionSpawn, { timeout: 120000 });
  const gameUp = (Date.now() - t0) / 1000;
  if (await page.evaluate(() => game.sessionSpawn.blocked)) {            // finish start-up through the spawn map
    await page.waitForSelector('#fullmap.open canvas', { visible: true, timeout: 60000 });
    const box = await (await page.$('#fullmap canvas')).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => !game.sessionSpawn.blocked, { timeout: 180000 });
  }
  const spawned = (Date.now() - t0) / 1000;
  await page.waitForFunction(() => game.world.pendingTiles() === 0, { timeout: 180000 });
  const out = { gameUp, spawned, errors };

  // map check: open the full map, close it, then every frame must draw the 3D view again
  out.map = await page.evaluate(() => new Promise(done => {
    const g = game; g.minimap.toggle(true);
    setTimeout(() => {
      g.minimap.toggle(false);
      const f0 = g.renderer.info.render.frame; let raf = 0; const tEnd = performance.now() + 2000;
      const tick = () => { raf++; if (performance.now() < tEnd) requestAnimationFrame(tick); else done({ frames: raf, drawn: g.renderer.info.render.frame - f0 }); };
      requestAnimationFrame(tick);
    }, 1500);
  }));
  out.map.ok = out.map.drawn >= out.map.frames - 2;

  // loading: jump there, hold the car until the ground under it is built (like main.js goHome), time it
  out.load = {};
  for (const [name, p] of Object.entries({ town: PLACES.town, forest: PLACES.forest })) {
    out.load[name] = await page.evaluate(p => new Promise(done => {
      const g = game, c = g.car, w = g.world, add = w.add; let adds = 0;
      w.add = td => { adds++; return add.call(w, td); };
      const t0 = performance.now(); let ground = null;
      const hold = () => {
        if (!w.loadedAt(p.x, p.z)) { c.pos.set(p.x, c.pos.y, p.z); c.vel.set(0, 0, 0); c._lastLoaded = null; }
        else if (ground === null) { ground = (performance.now() - t0) / 1000; g.teleport(p.x, p.z, p.cls); }
        if (ground !== null && w.pendingTiles() === 0) { w.add = add; const all = (performance.now() - t0) / 1000; done({ ground, all, tiles: adds, perS: adds / all }); }
        else if (performance.now() - t0 > 120000) { w.add = add; done({ ground, all: null, tiles: adds }); }
        else requestAnimationFrame(hold);
      };
      hold();
    }), p);
  }

  // drives on a rail at a fixed speed
  out.drives = {};
  for (const place of only) for (const kmh of SPEEDS) {
    const p = PLACES[place];
    // hold the car there until the ground is built (the game pulls a car on unloaded ground back), then place it
    await page.evaluate(p => new Promise(done => {
      const g = game, c = g.car, w = g.world, t0 = performance.now();
      const hold = () => {
        if (!w.loadedAt(p.x, p.z) || w.pendingTiles() > 0) { c.pos.set(p.x, c.pos.y, p.z); c.vel.set(0, 0, 0); c._lastLoaded = null; }
        else { const q = w.placeOn(p.x, p.z, p.cls) || [p.x, p.z]; c.reset(q[0], q[1], p.yaw); c.safe = []; return done(); }
        if (performance.now() - t0 < 120000) requestAnimationFrame(hold); else done();
      };
      hold();
    }), p);
    out.drives[`${place} ${kmh}`] = await page.evaluate((p, kmh, secs) => new Promise(done => {
      const g = game, c = g.car, w = g.world, info = g.renderer.info, V = kmh / 3.6, fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
      const x0 = c.pos.x, z0 = c.pos.z, dts = [], calls = [], tris = [], prog0 = info.programs?.length ?? 0, long0 = window.__long.length;
      let last = performance.now(), s = 0, noGround = 0;
      g.keys.add('KeyW');
      const tick = now => {
        const dt = Math.min(0.1, (now - last) / 1000); last = now; dts.push(dt * 1000); s += V * dt;
        calls.push(info.render.calls); tris.push(info.render.triangles);
        c.pos.x = x0 + fx * s; c.pos.z = z0 + fz * s; c.vel.x = fx * V; c.vel.z = fz * V;
        // heading of the car's forward (0, 0, 1) (forward = (sin yaw, cos yaw)); turned back onto the line about world up
        const Q = c.quat, h = Math.atan2(2 * (Q.x * Q.z + Q.w * Q.y), 1 - 2 * (Q.x * Q.x + Q.y * Q.y));
        let e = p.yaw - h; e = Math.atan2(Math.sin(e), Math.cos(e));
        if (Math.abs(e) > 1e-4) Q.premultiply(new Q.constructor(0, Math.sin(e / 2), 0, Math.cos(e / 2)));
        if (!w.loadedAt(c.pos.x, c.pos.z)) noGround++;
        if (s < V * secs) requestAnimationFrame(tick);
        else {
          g.keys.delete('KeyW'); c.vel.set(0, 0, 0);
          const d = [...dts].sort((a, b) => a - b), q = f => d[Math.min(d.length - 1, Math.floor(f * d.length))];
          const sc = [...calls].sort((a, b) => a - b), st = [...tris].sort((a, b) => a - b), lt = window.__long.slice(long0);
          done({ frames: d.length, med: q(.5), p95: q(.95), p99: q(.99), over20: 100 * d.filter(x => x > 20).length / d.length, over33: 100 * d.filter(x => x > 33.4).length / d.length,
            longTasks: lt.length, longMs: lt.reduce((a, x) => a + x, 0), callsMed: sc[sc.length >> 1], callsMax: sc.at(-1), trisMed: st[st.length >> 1], trisMax: st.at(-1),
            programsAdded: (info.programs?.length ?? 0) - prog0, noGround, pendingEnd: w.pendingTiles() });
        }
      };
      requestAnimationFrame(tick);
    }), p, kmh, SECS);
  }
  await browser.close();
  return out;
}

const fmt = (x, d = 1) => x == null || Number.isNaN(x) ? '—' : (+x).toFixed(d);
const results = {};
let failed = false;
for (const [label, url] of [['before', URL_BEFORE], ['after', URL_AFTER]].filter(([, u]) => u)) {
  const runs = [];
  for (let r = 0; r < RUNS; r++) {
    const s = await session(url); runs.push(s);
    if (s.errors.length || !s.map.ok) failed = true;
    console.log(`${label} run ${r + 1}: game up ${fmt(s.gameUp)} s, spawned ${fmt(s.spawned)} s, map check ${s.map.ok ? 'ok' : 'FAIL'} (${s.map.drawn}/${s.map.frames} frames drawn after closing)`
      + `, McMinnville ground ${fmt(s.load.town.ground, 2)} s all ${fmt(s.load.town.all, 2)} s, forest ground ${fmt(s.load.forest.ground, 2)} s all ${fmt(s.load.forest.all, 2)} s`);
  }
  // per measure, the median over the runs
  const m = f => med(runs.map(f).filter(x => x != null));
  const sum = { gameUp: m(s => s.gameUp), spawned: m(s => s.spawned), mapOk: runs.every(s => s.map.ok),
    load: Object.fromEntries(['town', 'forest'].map(k => [k, { ground: m(s => s.load[k].ground), all: m(s => s.load[k].all), perS: m(s => s.load[k].perS) }])),
    drives: Object.fromEntries(Object.keys(runs[0].drives).map(k => [k, Object.fromEntries(Object.keys(runs[0].drives[k]).map(f => [f, m(s => s.drives[k][f])]))])) };
  results[label] = { url, runs, median: sum };
}
console.log(`\nmedians of ${RUNS} run(s)${URL_BEFORE ? ' (before → after)' : ''}`);
const pair = (f, d = 1) => URL_BEFORE ? `${fmt(f(results.before.median), d)} → ${fmt(f(results.after.median), d)}` : fmt(f(results.after.median), d);
console.log(`start-up: game up ${pair(r => r.gameUp)} s, spawned ${pair(r => r.spawned)} s`);
for (const k of ['town', 'forest']) console.log(`load ${k}: ground under ${pair(r => r.load[k].ground)} s, all ${pair(r => r.load[k].all)} s, tiles/s ${pair(r => r.load[k].perS)}`);
console.log('drive'.padEnd(13), ['med ms', 'p95', 'p99', '% >20', '% >33', 'long tasks', 'calls', 'M tris', 'programs+', 'no ground'].map(h => h.padStart(14)).join(''));
for (const k of Object.keys(results.after.median.drives)) {
  const c = (f, d = 1) => pair(r => f(r.drives[k]), d).padStart(14);
  console.log(k.padEnd(13), c(d => d.med), c(d => d.p95), c(d => d.p99), c(d => d.over20), c(d => d.over33), c(d => d.longTasks, 0), c(d => d.callsMed, 0), c(d => d.trisMed / 1e6, 2), c(d => d.programsAdded, 0), c(d => d.noGround, 0));
}
if (opt('out')) fs.writeFileSync(opt('out'), JSON.stringify(results, null, 1));
if (failed) { console.log('FAIL: page errors or the 3D view not drawn every frame after the map closed'); process.exit(1); }
