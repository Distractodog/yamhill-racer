// MP-4: other players animated like your own vehicle, filmed side by side (director-run; needs Chrome):
//   node tools/mp_anim_shots.mjs [out dir] [--game http://127.0.0.1:8173/] [--relay ws://127.0.0.1:8787] [--only car|bike|jet]
// Starts server/local.mjs (port 8787) and tools/serve.py (port 8173) if they aren't already running. Page H hosts,
// page G joins. On the open field east of campus G drives a fixed manoeuvre in each vehicle — car: accelerate, turn,
// handbrake drift, brake, glider; bike: accelerate, leaned turn, rear-brake slide, wheelie, brake; jet: taxi with the
// nose wheel steered, then flying with stick and rudder, gear folded — while H films G's remote. Both pages use the
// same 3/4 chase camera on G's vehicle (G: its own; H: the remote model). At each moment G's physics is frozen for
// ~0.8 s so H (drawing 120 ms behind) catches up; then both pages are shot and put side by side in
// <out>/<moment>.png (left: G's own screen, right: what H sees). Prints G's own read-outs next to H's remote ones.
// Then H's frame time with 15 animated fake remotes (drifting on gravel, effects on) vs none.
// Checks (FAIL lines, nonzero exit): remote steer / front-wheel angle / springs / body roll / lean / gear match G's
// own within small tolerances at every frozen moment; H's remote drifts during G's drift and lays tyre marks there;
// glider open on both; no page errors; 15 animated remotes add ≤ 2 ms to H's median frame.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { GAME_URL, RELAY_URL, startGame, holdCar, watchErrors } from './lib/startgame.mjs';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const GAME = opt('--game', GAME_URL), RELAY = opt('--relay', RELAY_URL), ONLY = opt('--only', null);
const OUT = args[0] || 'mp-anim-shots';
fs.mkdirSync(OUT, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
const children = [], failures = [], errors = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

const portOpen = (port, host = '127.0.0.1') => new Promise(r => { const s = net.connect(port, host); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
async function ensure(port, cmd, argv, label) {
  if (await portOpen(port)) { console.log(`${label}: already running on ${port}`); return; }
  console.log(`${label}: starting ${cmd} ${argv.join(' ')}`);
  const c = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'inherit'] }); children.push(c);
  for (let i = 0; i < 100 && !(await portOpen(port)); i++) await wait(100);
  if (!(await portOpen(port))) throw Error(`${label} did not start on port ${port}`);
}
process.on('exit', () => children.forEach(c => c.kill()));
const relayPort = +new URL(RELAY.replace(/^ws/, 'http')).port || 8787;
await ensure(relayPort, process.execPath, ['server/local.mjs', String(relayPort)], 'relay');
await ensure(+new URL(GAME).port || 80, 'python3', ['tools/serve.py', String(+new URL(GAME).port || 8173), 'game'], 'game server');

const VW = 960, VH = 600;
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: [`--window-size=${VW},${VH}`, '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
async function open(label) {
  const ctx = await browser.createBrowserContext();                 // own localStorage → own player id / code
  const page = await ctx.newPage();
  await page.setViewport({ width: VW, height: VH });
  watchErrors(page, label, errors);
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.location()?.url || '')) console.log(`console error (${label})`, m.text()); });
  await startGame(page, { url: GAME, relay: RELAY });
  return page;
}
const H = await open('host'), G = await open('guest');
await H.evaluate(async () => { const { mp } = await import('./src/mp/net.js'); mp.setName('Hana Host'); await mp.host(); });
const code = await H.evaluate(async () => (await import('./src/mp/net.js')).mp.me.code);
const gid = await G.evaluate(async code => { const { mp } = await import('./src/mp/net.js'); mp.setName('Gus Guest'); await mp.join(code); return mp.me.id; }, code);
await wait(800);
check((await H.evaluate(() => game.remotes.list().length)) === 1, 'host sees the guest');

const FIELD = { x: 828, z: 480 };              // open farm fields east of campus (tools/drive.mjs FIELD), heading east
// H parks out of the way, still (its camera films G; the world streams around the camera)
await holdCar(H, { x: FIELD.x - 40, z: FIELD.z - 60, yaw: Math.PI / 2 });
await H.evaluate(() => { const v = game.vehicles.current; v.step = () => {}; v.vel.set(0, 0, 0); });

// the same 3/4 chase camera on both pages: G on its own vehicle, H on the remote model of G
const CHASE = { car: [7.5, 2.6], bike: [5, 2], jet: [24, 6] };
async function film(page, who) {
  await page.evaluate((who, gid) => {
    const g = game, render = g.renderer.render.bind(g.renderer);
    window.__chase = { dist: 7.5, high: 2.6, side: 0.55 };
    g.renderer.render = function (scene, cam) {
      if (cam === g.camera) {
        let s = null;
        if (who === 'self') s = { p: g.vehicles.current.renderPos, q: g.vehicles.current.renderQuat };
        else { const m = g.remotes.model(gid); if (m?.visible) s = { p: m.position, q: m.quaternion }; }
        if (s) {
          const V = s.p.constructor, f = new V(0, 0, 1).applyQuaternion(s.q); f.y = 0; if (f.lengthSq() < 1e-6) f.set(0, 0, 1); f.normalize();
          const { dist, high, side } = window.__chase, c = Math.cos(side), sn = Math.sin(side);
          const bx = -(f.x * c - f.z * sn), bz = -(f.z * c + f.x * sn);     // behind, swung to the left
          cam.position.set(s.p.x + bx * dist, s.p.y + high, s.p.z + bz * dist); cam.up.set(0, 1, 0);
          cam.lookAt(s.p.x + f.x * 1.5, s.p.y + 0.4, s.p.z + f.z * 1.5); cam.fov = 60; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
        }
      }
      return render(scene, cam);
    };
  }, who, gid);
}
await film(G, 'self'); await film(H, 'remote');
const chase = kind => Promise.all([G, H].map(p => p.evaluate(([d, h]) => Object.assign(window.__chase, { dist: d, high: h }), CHASE[kind])));

// keys on G (physical codes, as the tests do)
const keys = (...codes) => G.evaluate(codes => { game.keys.clear(); for (const c of codes) game.keys.add(c); }, codes);
// G's own read-outs, the same shape as remotes.list().anim
const own = () => G.evaluate(() => {
  const v = game.vehicles.current, ud = v.mesh.userData, r3 = x => Math.round(x * 1000) / 1000;
  return { kind: v.kind, steer: r3(v.steer), drifting: !!v.drifting, lean: r3(v.lean || 0), comp: v.wheels.map(w => w.contact ? r3(w.comp) : -1),
    frontYaw: r3(ud.wheels[0].holder.rotation.y), roll: r3(ud.bodyPivot?.rotation.z ?? ud.lean?.rotation.z ?? 0),
    pitch: r3(ud.bodyPivot?.rotation.x ?? ud.rider?.rotation.x ?? 0), bars: ud.bars ? r3(ud.bars.rotation.y) : null,
    gear: v.kind === 'jet' ? r3(v.gear) : null, flame: v.kind === 'jet' ? (ud.flame.visible ? r3(ud.flame.scale.z) : 0) : null,
    glider: v.glide ? r3(v.glide.open) : 0, speed: Math.round(v.vel.length() * 3.6) };
});
const remote = () => H.evaluate(() => { const r = game.remotes.list()[0]; return r && { ...r.anim, kind: r.kind, far: r.far, fx: game.remotes.stats.fx, marks: game.remotes.fx?.effects.markI ?? 0 }; });
const freeze = on => G.evaluate(on => { const v = game.vehicles.current; if (on) v.step = () => {}; else delete v.step; }, on);

// side by side: G's own screen | H's view of G
const composer = await browser.newPage();
await composer.setViewport({ width: VW * 2 + 12, height: VH + 40 });
async function pair(name, note = '') {
  const [a, b] = await Promise.all([G.screenshot({ encoding: 'base64' }), H.screenshot({ encoding: 'base64' })]);
  const cap = t => `<div style="color:#fff;font:600 15px system-ui;padding:8px 10px">${t}</div>`;
  await composer.setContent(`<body style="margin:0;background:#111;display:flex;gap:12px">
    <div>${cap(`Guest's own screen — ${name}`)}<img src="data:image/png;base64,${a}" width="${VW}" height="${VH}"></div>
    <div>${cap(`Host's view of the guest — ${name} ${note}`)}<img src="data:image/png;base64,${b}" width="${VW}" height="${VH}"></div></body>`);
  const file = path.join(OUT, name + '.png'); await composer.screenshot({ path: file }); console.log('  shot', file);
}
// a frozen moment: G holds still, H catches up, both are shot, read-outs compared
const TOL = { steer: 0.05, frontYaw: 0.04, comp: 0.02, roll: 0.012, pitch: 0.02, lean: 0.05, bars: 0.03, gear: 0.05 };
async function moment(name, extra = () => true) {
  await freeze(true); await wait(800);
  const [g, h] = [await own(), await remote()];
  console.log(`  ${name}\n    guest  ${JSON.stringify(g)}\n    remote ${JSON.stringify(h)}`);
  const bad = [];
  if (!h || h.kind !== g.kind || h.far) bad.push('not drawn up close');
  else {
    for (const k of ['steer', 'frontYaw', 'roll', 'pitch', 'lean', 'bars', 'gear']) if (g[k] !== null && h[k] !== null && Math.abs(g[k] - h[k]) > TOL[k]) bad.push(`${k} ${h[k]} vs ${g[k]}`);
    g.comp.forEach((c, i) => { const r = h.comp[i]; if ((c < 0) !== (r < 0) || Math.abs(c - r) > TOL.comp) bad.push(`wheel ${i} spring ${r} vs ${c}`); });
    if (g.kind === 'jet' && (g.flame > 0) !== (h.flame > 0)) bad.push(`flame ${h.flame} vs ${g.flame}`);
  }
  check(!bad.length && extra(g, h), `${name}: remote matches the guest's own (${bad.join('; ') || 'steer, wheels, springs, roll / lean'})`);
  await pair(name);
  await freeze(false);
  return { g, h };
}
// play a timeline of [seconds, keys] on G, stopping at the named moments: [seconds, keys, momentName?]
async function play(steps) {
  for (const [secs, codes, name, extra] of steps) {
    await keys(...codes); await wait(secs * 1000);
    if (name) await moment(name, extra);
  }
  await keys();
}

if (!ONLY || ONLY === 'car') {
  await chase('car');
  await holdCar(G, { ...FIELD, yaw: Math.PI / 2, kind: 'car' }); await wait(1200);
  let driftSeen = false, marks0 = (await remote())?.marks || 0;
  await play([
    [1.6, ['KeyW'], 'car-1-accelerate'],
    [1.0, ['KeyW', 'KeyD'], 'car-2-turn-right'],
    [0.4, ['KeyW', 'KeyD', 'Space']],
    [0.6, ['KeyW', 'KeyD'], 'car-3-drift', (g, h) => { driftSeen = g.drifting && h.drifting; return true; }],
    [0.8, ['KeyW', 'KeyD'], 'car-4-drift-held'],
    [0.5, ['KeyS'], 'car-5-brake'],
  ]);
  const marks = ((await remote())?.marks || 0) - marks0;
  check(driftSeen, 'the remote drifts while the guest drifts');
  check(marks > 0, `the remote laid tyre marks on the host's screen (${marks} pieces)`);
  // glider: lift 25 m, open the wing
  await G.evaluate(() => { const v = game.vehicles.current; v.pos.y += 25; v.vel.set(15, 0, 0); game.glider.deploy(); });
  await wait(1500);
  await moment('car-6-glider', (g, h) => g.glider > 0.9 && h.glider > 0.9);
}
if (!ONLY || ONLY === 'bike') {
  await chase('bike');
  await holdCar(G, { ...FIELD, yaw: Math.PI / 2, kind: 'bike' }); await wait(1200);
  await play([
    [2.0, ['KeyW'], 'bike-1-accelerate'],
    [1.2, ['KeyW', 'KeyA'], 'bike-2-lean-left'],
    [0.8, ['KeyW', 'KeyA', 'Space'], 'bike-3-slide'],
    [0.8, ['KeyW', 'ShiftLeft'], 'bike-4-wheelie'],
    [0.6, ['KeyS'], 'bike-5-brake'],
  ]);
}
if (!ONLY || ONLY === 'jet') {
  await chase('jet');
  await holdCar(G, { ...FIELD, yaw: Math.PI / 2, kind: 'jet' }); await wait(1200);
  await play([[3.0, ['KeyW', 'KeyD'], 'jet-1-taxi']]);
  await G.evaluate(() => { const v = game.vehicles.current; v.placeInAir(v.pos.x, v.pos.y + 150, v.pos.z, Math.PI / 2, 450); });
  await wait(1500);
  await play([[1.2, ['ArrowRight', 'ArrowDown', 'KeyA'], 'jet-2-flying']]);
}

// H's frame time: 0 remotes vs 15 animated fake remotes (drifting on gravel, effects on), same spot and camera
await G.browserContext().close();
await wait(1500);
await H.bringToFront();
await H.evaluate(async X => {
  const g = game, sleep = ms => new Promise(r => setTimeout(r, ms)), y = g.world.heightAt(X.x, X.z);
  const render = g.renderer.render;
  g.renderer.render = function (scene, cam) {
    if (cam === g.camera) { cam.position.set(X.x - 30, y + 14, X.z - 40); cam.up.set(0, 1, 0); cam.lookAt(X.x, y, X.z + 30); cam.fov = 70; cam.updateProjectionMatrix(); cam.updateMatrixWorld(); }
    return render.call(this, scene, cam);
  };
  while (g.world.pendingTiles() > 0) await sleep(100);
  await sleep(2000);
}, FIELD);
const frames = label => H.evaluate(async () => {
  const ts = []; let last = performance.now(); const t0 = last;
  await new Promise(r => { const f = now => { ts.push(now - last); last = now; if (now - t0 < 10000) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f); });
  ts.shift(); ts.sort((a, b) => a - b);
  return { frames: ts.length, median: +ts[ts.length >> 1].toFixed(2), p95: +ts[Math.floor(ts.length * 0.95)].toFixed(2), remotes: game.remotes.count, calls: game.renderer.info.render.calls };
}).then(r => { console.log(`  ${label}:`, JSON.stringify(r)); return r; });
const base1 = await frames('0 remotes ');
await H.evaluate(async X => {
  const { mp } = await import('./src/mp/net.js'), kinds = ['car', 'bike', 'jet'], y = game.world.heightAt(X.x, X.z), start = performance.now();
  window.__fakes = setInterval(() => {                 // 15 players at 15 Hz on circles 15–99 m around the spot
    const t = (performance.now() - start) / 1000;
    for (let i = 0; i < 15; i++) {
      const a = t * 0.5 + i * 0.42, rad = 15 + i * 6, yaw = a + Math.PI / 2 - 0.4, k = kinds[i % 3], jetUp = k === 'jet' && i % 2;
      game.remotes.receive({ t: 'state', from: 'fake' + i, srvT: mp.now(), v: k, p: [X.x + rad * Math.sin(a), y + (jetUp ? 40 : k === 'jet' ? 1.6 : 0.5), X.z + 30 + rad * Math.cos(a)],
        q: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], vel: [rad * 0.5 * Math.cos(a), 0, -rad * 0.5 * Math.sin(a)], ts: mp.now(),
        st: -0.8, th: 1, dr: k === 'car' ? 1 : 0, hb: k === 'car' ? 1 : 0, sl: 0.5, la: 18, sf: 4, ln: k === 'bike' ? 0.6 : 0,
        w: k === 'jet' ? (jetUp ? [-1, -1, -1] : [20, 20, 20]) : k === 'bike' ? [10, 8] : [9, 9, 9, 9], md: jetUp ? 'a' : 'g', gr: jetUp ? 0 : 1, jc: [0.4, 0.6, 0] });
    }
  }, 66);
}, FIELD);
await wait(3000);
const loaded = await frames('15 animated remotes');
const st = await H.evaluate(() => ({ ...game.remotes.stats }));
console.log('  remotes.update', st.ms.toFixed(3), 'ms avg (model builds excluded):', JSON.stringify(st));
const file = path.join(OUT, 'host-15-animated-remotes.png'); await H.screenshot({ path: file }); console.log('  shot', file);
await H.evaluate(() => { clearInterval(window.__fakes); for (let i = 0; i < 15; i++) game.remotes.receive({ t: 'left', id: 'fake' + i }); });
await wait(1500);
const base2 = await frames('0 remotes again');
const baseMedian = (base1.median + base2.median) / 2, grow = loaded.median - baseMedian;
console.log(`frame time median: 0 remotes ${baseMedian.toFixed(2)} ms, 15 animated remotes ${loaded.median} ms → +${grow.toFixed(2)} ms; p95 ${base1.p95} / ${base2.p95} → ${loaded.p95}`);
check(st.visible === 15 && st.near === 15 && st.fx > 0, `15 animated remotes measured (${st.near} near, ${st.fx} with effects)`);
check(grow <= 2, `15 animated remotes add ≤ 2 ms to the median frame (+${grow.toFixed(2)} ms)`);
check(st.ms < 1, `remotes.update under 1 ms per frame (${st.ms.toFixed(3)})`);
check(errors.length === 0, `no page errors (${errors.length})`);
await browser.close();
console.log(failures.length ? `FAILED: ${failures.join('; ')}` : 'PASS mp anim shots');
process.exit(failures.length ? 1 : 0);
