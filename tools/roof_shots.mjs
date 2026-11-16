// Director browser check for roofs (roofs.js): screenshots in the real game of
//   1. the car parked on a flat roof (campus Gym: parapet + rooftop units), chase camera and a side view;
//   2. the car on a pitched roof (campus Barn 1, 22° gable), across the slope;
//   3. the helicopter landed on a roof (Gym), after an S descent;
//   4. the car jumping from one McMinnville Third Street roof to the next (run-up, in the air, landed).
// Serves game/ on 127.0.0.1:8173 if nothing is listening there. Run through the gate:
//   node tools/roof_shots.mjs --out /tmp/yr-roof-shots
// Each shot prints the vehicle state (mode, on a roof, wheel contacts vs the roof height, camera height over the roof)
// and the frame times; a NaN, a teleport (> 2 m in one physics step), a page error, the car not resting on the roof or
// the camera inside the building fails. Review the PNGs. Start-up from tools/lib/startgame.mjs.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { GAME_URL, startGame, holdCar, watchErrors } from './lib/startgame.mjs';

const args = process.argv.slice(2), arg = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
const OUT = arg('--out', '/tmp/yr-roof-shots');
const IGNORE = /cloudflareinsights\.com/;
// the Gym roof, Barn 1, and the Third Street run-up (tools/roof_test.mjs finds the same jump: 2.5 m gap, 2.3 m down)
const GYM = { x: -510.5, z: 172 }, GYM_SIDE = { x: -540, z: 178 }, BARN = 'Barn 1', JUMP = { x: 19327.24, z: -11056.93, yaw: Math.PI, kmh: 79 };
fs.mkdirSync(OUT, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
const failures = [], errors = [], shots = [], children = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); return ok; };
const portOpen = port => new Promise(r => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
const port = +new URL(GAME_URL).port || 80;
if (!(await portOpen(port))) {
  console.log(`game server: starting tools/serve.py ${port} game`);
  children.push(spawn('python3', ['tools/serve.py', String(port), 'game'], { stdio: ['ignore', 'ignore', 'inherit'] }));
  for (let i = 0; i < 100 && !(await portOpen(port)); i++) await wait(100);
}
process.on('exit', () => children.forEach(c => c.kill()));

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--window-size=1280,800', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
let page;
// vehicle state against the roof under it: wheel contacts minus the roof there, the camera's height over the roof under it
const state = () => page.evaluate(() => {
  const v = game.vehicles.current, W = v.world, cam = game.camera.position, top = (x, z) => W.roofUnder(x, z, 1e5);
  const roof = top(v.pos.x, v.pos.z), camRoof = top(cam.x, cam.z);
  const contacts = v.wheels.filter(w => w.contact).map(w => +(w.contactPoint.y - top(w.contactPoint.x, w.contactPoint.z)).toFixed(3));
  return { kind: v.kind, type: v.type, mode: v.mode, kmh: Math.round(v.vel.length() * 3.6), grounded: v.grounded, onRoof: W.onRoof(),
    pos: v.pos.toArray().map(q => +q.toFixed(2)), overRoof: +(v.pos.y - roof).toFixed(2), contacts,
    camOverRoof: Number.isFinite(camRoof) ? +(cam.y - camRoof).toFixed(2) : null, finite: [...v.pos, ...v.vel, ...v.quat].every(Number.isFinite),
    msg: v.msgT > 0 ? v.msg : '', jump: +window.__jump.toFixed(2) };
});
const frames = ms => page.evaluate(ms => new Promise(done => {
  const t = []; let last = performance.now(); const end = last + ms;
  const f = now => { t.push(now - last); last = now; if (now < end) requestAnimationFrame(f); else { t.sort((a, b) => a - b); done({ median: +t[t.length >> 1].toFixed(1), p95: +t[Math.floor(t.length * 0.95)].toFixed(1) }); } };
  requestAnimationFrame(f);
}), ms);
const cam = mode => page.evaluate(mode => { window.__roofCam = mode; }, mode);
async function shot(name, view = null) {
  await cam(view); await wait(250);
  const s = await state(), file = path.join(OUT, `${name}${view ? '-' + view : ''}.png`);
  await page.screenshot({ path: file }); shots.push({ name, view, ...s });
  console.log(`  shot ${file} ${JSON.stringify(s)}`);
  check(s.finite, `${name}: finite state`);
  check(s.jump <= 2, `${name}: no teleport (biggest step so far ${s.jump} m)`);
  if (!view && s.camOverRoof !== null) check(s.camOverRoof > 0.3, `${name}: chase camera above the roof under it (${s.camOverRoof} m)`);
  await cam(null);
  return s;
}
// put the current vehicle `above` m over the highest roof at (x, z), facing yaw, at `kmh` along yaw
const drop = (x, z, yaw, above, kmh = 0) => page.evaluate((x, z, yaw, above, kmh) => {
  const v = game.vehicles.current, roof = v.world.roofUnder(x, z, 1e5);
  v.pos.set(x, roof + 3, z); v.vel.set(0, 0, 0); v.reset(x, z, yaw);
  v.pos.y = roof + above; v.vel.set(Math.sin(yaw) * kmh / 3.6, 0, Math.cos(yaw) * kmh / 3.6);
  v.safe = []; v._lastLoaded = null; v.savePrev(); window.__jump = 0;
  return roof;
}, x, z, yaw, above, kmh);
const keys = (add, del = []) => page.evaluate((add, del) => { del.forEach(k => game.keys.delete(k)); add.forEach(k => game.keys.add(k)); }, add, del);
const restsOnRoof = (s, what) => {
  check(s.onRoof && s.grounded, `${what}: on the roof (onRoof ${s.onRoof}, grounded ${s.grounded})`);
  check(s.contacts.length >= 2 && s.contacts.every(c => Math.abs(c) < 0.05), `${what}: wheels on the drawn roof (${s.contacts.join(', ')} m)`);
};

try {
  page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
  watchErrors(page, 'game', errors);
  page.on('console', m => {
    if (m.type() !== 'error' || /favicon/.test(m.location()?.url || '') || IGNORE.test(`${m.text()} ${m.location()?.url || ''}`)) return;
    errors.push(m.text()); console.log('console error', m.text());
  });
  await startGame(page);
  // a side camera on demand, and the biggest one-step jump of whichever vehicle is driven
  await page.evaluate(() => {
    window.__jump = 0;
    const r = game.renderer, render = r.render.bind(r);
    r.render = (scene, c) => {
      const v = game.vehicles.current, mode = window.__roofCam;
      if (mode) {
        const V = c.position.constructor, p = v.renderPos, fw = new V(0, 0, 1).applyQuaternion(v.renderQuat).setY(0).normalize(), right = new V(-fw.z, 0, fw.x);
        c.position.copy(p).addScaledVector(right, mode === 'side' ? 14 : 9).addScaledVector(fw, mode === 'side' ? 0 : 9).add(new V(0, mode === 'side' ? 2.5 : 6, 0));
        c.up.set(0, 1, 0); c.lookAt(p); c.updateMatrixWorld();
      }
      render(scene, c);
    };
    for (const v of [game.vehicles.car, game.vehicles.bike, ...game.vehicles.aircraft]) {
      const step = v.step.bind(v);
      v.step = (dt, input) => { const x = v.pos.x, y = v.pos.y, z = v.pos.z, out = step(dt, input);
        if (v === game.vehicles.current) window.__jump = Math.max(window.__jump, Math.hypot(v.pos.x - x, v.pos.y - y, v.pos.z - z)); return out; };
    }
  });

  // 1. car parked on the Gym's flat roof
  await holdCar(page, { ...GYM_SIDE, yaw: 0, kind: 'car' });
  await drop(GYM.x, GYM.z, 0.4, 1.5); await wait(3000);
  console.log('  frames on the roof', JSON.stringify(await frames(2000)));
  restsOnRoof(await shot('1-car-flat-roof'), 'car on the Gym roof');
  await shot('1-car-flat-roof', 'side'); await shot('1-car-flat-roof', 'quarter');

  // 2. car on a pitched roof (Barn 1), across the slope, halfway between the ridge and an eave
  const barn = await page.evaluate(name => {
    const b = game.world.buildingsNear(115, 617, 200).find(b => b.roofBuilding?.name === name), p = b.roofBuilding.parts[0], r = p.rect;
    const a = r.a * Math.PI / 180, long = r.L >= r.W, u = long ? [Math.cos(a), Math.sin(a)] : [-Math.sin(a), Math.cos(a)], w = [-u[1], u[0]];
    const W = long ? r.W : r.L;
    return { x: r.c[0] + w[0] * W / 4, z: r.c[1] + w[1] * W / 4, yaw: Math.atan2(u[0], u[1]) };
  }, BARN);
  await holdCar(page, { x: barn.x + 25, z: barn.z + 25, yaw: 0, kind: 'car' });
  await drop(barn.x, barn.z, barn.yaw, 1.2); await wait(3000);
  restsOnRoof(await shot('2-car-pitched-roof'), 'car on the Barn roof');
  await shot('2-car-pitched-roof', 'side'); await shot('2-car-pitched-roof', 'quarter');

  // 3. helicopter: descend with S onto the Gym roof, land, sit
  await page.evaluate(() => { game.vehicles.setType('jet', 'heli'); game.vehicles.switchTo('jet'); });
  await holdCar(page, { ...GYM_SIDE, yaw: 0 });
  await page.evaluate(GYM => { const v = game.vehicles.current, roof = v.world.roofUnder(GYM.x, GYM.z, 1e5); v.placeInAir(GYM.x, roof + 12, GYM.z, 0, 0); v.pos.y = roof + 12; v.vel.set(0, 0, 0); v.savePrev(); window.__jump = 0; }, GYM);
  await keys(['KeyS']); await wait(1500);
  await shot('3-heli-descending', 'quarter');
  const landed = await page.waitForFunction(() => game.vehicles.current.mode === 'ground', { timeout: 20000, polling: 50 }).then(() => true, () => false);
  await keys([], ['KeyS']); await wait(1500);
  check(landed, 'heli landed');
  const hs = await shot('3-heli-on-roof');
  check(hs.mode === 'ground' && hs.onRoof && hs.contacts.every(c => Math.abs(c) < 0.05), `heli skids on the drawn roof (${hs.contacts.join(', ')})`);
  await shot('3-heli-on-roof', 'side');

  // 4. car: Third Street roof → the next roof across a 2.5 m gap, 2.3 m lower
  await page.evaluate(() => game.vehicles.switchTo('car'));
  await holdCar(page, { x: JUMP.x + 30, z: JUMP.z, yaw: 0, kind: 'car' });
  await drop(JUMP.x, JUMP.z, JUMP.yaw, 0.8, JUMP.kmh);
  await keys(['KeyW']); await wait(300);
  await shot('4-roof-jump-runup', 'side');
  await page.waitForFunction(() => !game.vehicles.current.grounded && game.vehicles.current.airTime > 0.15, { timeout: 4000, polling: 20 }).catch(() => {});
  await keys([], ['KeyW']);
  await shot('4-roof-jump-air', 'side');
  await page.waitForFunction(() => game.vehicles.current.grounded && game.vehicles.current.airTime === 0, { timeout: 4000, polling: 20 }).catch(() => {});
  await keys(['KeyS']); await wait(1200); await keys([], ['KeyS']); await wait(800);
  const js = await shot('4-roof-jump-landed');
  restsOnRoof(js, 'car on the next roof');
  check(js.pos[2] < JUMP.z - 30, `car crossed to the next roof (z ${js.pos[2]})`);
  await shot('4-roof-jump-landed', 'side');
} catch (e) {
  check(false, `script: ${e.message}`);
} finally {
  check(!errors.length, `no page errors (${errors.length})`);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ shots, failures, errors }, null, 1));
  await browser.close();
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nall roof shots ok', '→', OUT);
  process.exitCode = failures.length ? 1 : 0;
}
