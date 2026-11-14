// Flight hitch test: flies the jet low and fast along fixed routes and records every frame time, so map streaming
// spikes show up as long frames. node tools/flight_test.mjs [--kmh 1200] [--alt 120] [--route town|country|all]
// [--url http://127.0.0.1:8173/] [--profile]   (needs the preview server)
//
// Each route waits until the start is fully loaded, then carries the jet along the line at a steady speed (the jet's
// physics is switched off for the run, so it is the same every time). Reports frames, the worst frame,
// frames over 33 ms and over 50 ms, p95/p99, and frames the game never drew (its frame threw). --profile adds a
// sampling CPU profile and lists what ran inside the long tasks (contiguous busy stretches over 33 ms).
import puppeteer from 'puppeteer-core';

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i < 0 ? def : (process.argv[i + 1] ?? true); };
const KMH = +arg('kmh', 1200), ALT = +arg('alt', 120), URL = arg('url', 'http://127.0.0.1:8173/');
const PROFILE = process.argv.includes('--profile');
const ROUTES = {
  // west → east along NE 3rd St, straight over downtown McMinnville
  town: { x0: 11000, z0: -11032, x1: 27000, z1: -11032 },
  // the McMinnville stretch only (also exists on the older 51-tile map, for A/B against old commits)
  mcm: { x0: 15500, z0: -11032, x1: 23000, z1: -11032 },
  // west → east through farmland and forest south of Sheridan, no town on the line
  country: { x0: -2000, z0: 13000, x1: 14000, z1: 13000 },
};
const pick = arg('route', 'all');
const routes = pick === 'all' ? ['town', 'country'] : [pick];

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760 });
page.setDefaultTimeout(180000);
const errors = [];
page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR', e.message); });
await page.evaluateOnNewDocument(() => localStorage.setItem('yr-welcome-hidden-1', '1'));
await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(() => window.game && game.world.pendingTiles() === 0, { timeout: 120000 });
await page.evaluate(() => { game.vehicles.switchTo?.('jet'); game.minimap.toggle?.(false); });

const cdp = await page.createCDPSession();
const results = [];
for (const name of routes) {
  const R = ROUTES[name];
  // park at the start and let it load fully
  await page.evaluate(async (R, ALT) => {
    const g = window.game, c = g.car;
    for (let k = 0; k < 300 && !(g.world.loadedAt(R.x0, R.z0) && g.world.pendingTiles() === 0); k++) {
      const y = (g.world.heightAt(R.x0, R.z0) || 0) + ALT;
      c.pos.set(R.x0, y, R.z0); c.prevPos.copy(c.pos); c.renderPos.copy(c.pos); c.vel.set(0, 0, 0);
      await new Promise(r => setTimeout(r, 100));
    }
    await new Promise(r => setTimeout(r, 1500));
  }, R, ALT);
  if (PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
  const r = await page.evaluate((R, KMH, ALT) => new Promise(done => {
    const g = window.game, c = g.car, V = KMH / 3.6, veh = g.vehicles?.current || c;
    veh.step = () => {};                 // no physics during the run: the route is scripted (older builds have no spawn pause)
    const L = Math.hypot(R.x1 - R.x0, R.z1 - R.z0), ux = (R.x1 - R.x0) / L, uz = (R.z1 - R.z0) / L;
    const yaw = Math.atan2(ux, uz), q = c.quat.clone().setFromAxisAngle({ x: 0, y: 1, z: 0, isVector3: true }, yaw);
    let last = performance.now(), s = 0, y = (g.world.heightAt(R.x0, R.z0) || 0) + ALT;
    const ft = [], missing = [], info = g.renderer.info.render; let lastRender = info.frame, skipped = 0;
    const tick = now => {
      const dt = (now - last) / 1000; last = now; ft.push(dt * 1000);
      if (info.frame === lastRender) skipped++; lastRender = info.frame;     // the game's frame threw before drawing
      s += V * Math.min(dt, 0.1);
      const x = R.x0 + ux * s, z = R.z0 + uz * s;
      if (!g.world.loadedAt(x, z)) missing.push(Math.round(s));
      else y += ((g.world.heightAt(x, z) + ALT) - y) * Math.min(1, dt * 2);
      c.pos.set(x, y, z); c.prevPos.copy(c.pos); c.renderPos.copy(c.pos); c.vel.set(ux * V, 0, uz * V);
      c.quat.copy(q); c.prevQuat?.copy(q); c.renderQuat?.copy(q);
      if (s < L) requestAnimationFrame(tick);
      else {
        delete veh.step;
        done({ ft, missing: missing.length, skipped });
      }
    };
    requestAnimationFrame(tick);
  }), R, KMH, ALT);
  let prof = null;
  if (PROFILE) prof = (await cdp.send('Profiler.stop')).profile;
  const ft = r.ft.slice(1), sorted = [...ft].sort((a, b) => a - b), q = p => sorted[Math.floor((sorted.length - 1) * p)];
  const row = { route: name, kmh: KMH, frames: ft.length, worstMs: +sorted.at(-1).toFixed(1), over33: ft.filter(v => v > 33.4).length,
    over50: ft.filter(v => v > 50).length, p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), median: +q(0.5).toFixed(1),
    noGround: r.missing, notDrawn: r.skipped };
  results.push(row);
  console.log(JSON.stringify(row));
  if (prof) longTasks(prof);
}
console.log(errors.length ? `${errors.length} page errors` : 'no page errors');
await browser.close();
process.exit(errors.length ? 1 : 0);

// what ran during busy stretches longer than 33 ms (inclusive time per function, each counted once per sample)
function longTasks(p) {
  const byId = new Map(p.nodes.map(n => [n.id, n])), parent = new Map();
  for (const n of p.nodes) for (const ch of n.children || []) parent.set(ch, n.id);
  const label = n => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`;
  const idle = id => { const f = byId.get(id).callFrame.functionName; return f === '(idle)' || f === '(program)' && false; };
  let t = p.startTime, run = [], runStart = t;
  const tasks = [];
  for (let i = 0; i < p.samples.length; i++) {
    t += p.timeDeltas[i];
    if (idle(p.samples[i])) { if (run.length) tasks.push({ dur: (t - runStart) / 1000, run }); run = []; runStart = t; }
    else { if (!run.length) runStart = t; run.push([p.samples[i], p.timeDeltas[i + 1] || 0]); }
  }
  const long = tasks.filter(x => x.dur > 33);
  const incl = new Map(), self = new Map();
  let total = 0;
  for (const tk of long) for (const [id, dt] of tk.run) {
    total += dt; const seen = new Set();
    self.set(label(byId.get(id)), (self.get(label(byId.get(id))) || 0) + dt);
    for (let k = id; k != null; k = parent.get(k)) { const l = label(byId.get(k)); if (!seen.has(l)) { seen.add(l); incl.set(l, (incl.get(l) || 0) + dt); } }
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `  ${(v / 1000).toFixed(0).padStart(6)} ms  ${k}`).join('\n');
  console.log(`long tasks: ${long.length}, ${(total / 1000).toFixed(0)} ms in them; longest ${long.map(x => x.dur.toFixed(0)).sort((a, b) => b - a).slice(0, 8).join(', ')} ms`);
  console.log('inclusive:\n' + top(incl, 40));
  console.log('self:\n' + top(self, 20));
}
