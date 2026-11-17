// Director browser check for the body lift beside banks (bodyclearance.js, car.js syncMesh, models/racecar.js arms):
// the owner's screenshot had the race car beside a steep dirt bank at the road edge, wheels on the road, its body drawn
// 2–3 m up the bank and the suspension arms stretched down to the wheels like long black sticks. Here each vehicle is
// parked with its outer tyre 10 cm inside the road's edge next to the steepest banks on the map (tools/body_lift_test.mjs
// finds the same sites), then crept along the edge at 25 km/h; screenshots from behind and low (the screenshot's view)
// and from across the road.
//   node tools/body_lift_shots.mjs --out /tmp/yr-body-lift                        this code (YR_URL, default :8173)
//   node tools/body_lift_shots.mjs --out /tmp/yr-body-lift --before <url>         also the old code (a second server)
// Serves game/ on 127.0.0.1:8173 if nothing is listening there. Run through the heavy gate. Each shot prints the drawn
// lift (userData.bodyLift), how far the body's frame is off the road under the car, and the race car's arms (swing,
// stretch); after the fix a parked / creeping upright vehicle must be lifted ≤ 30 cm and the race car's arms asked ≤
// ARM_SWING / ARM_STRETCH (the old code fails here: that's the bug). Page errors fail. Review the PNGs.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { GAME_URL, startGame, holdCar, watchErrors } from './lib/startgame.mjs';
import { ARM_SWING, ARM_STRETCH } from '../game/src/models/racecar.js';

const args = process.argv.slice(2), arg = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
const OUT = arg('--out', '/tmp/yr-body-lift'), BEFORE = arg('--before', null);
const IGNORE = /cloudflareinsights\.com/;
// bank sites: road heading (yaw), the bank's side (+1 = left of travel), and each type's centre with its outer tyre
// 10 cm inside the edge (from the tiles, as tools/body_lift_test.mjs)
const SITES = [
  { name: 'bank-6m', yaw: 1.9532, side: -1, at: { race: [-4099.92, 6271.66], suv: [-4099.94, 6271.61], truck: [-4100.05, 6271.33], dirt: [-4099.5, 6272.7] } },
  { name: 'bank-3m', yaw: -0.0104, side: 1, at: { race: [18155.71, -8831.83], suv: [18155.65, -8831.83], truck: [18155.35, -8831.83], dirt: [18156.83, -8831.81] } },
  { name: 'cutting-3m', yaw: 1.7192, side: -1, at: { race: [-10235.84, 5491.59], suv: [-10235.85, 5491.54], truck: [-10235.89, 5491.24], dirt: [-10235.67, 5492.7] } },
  { name: 'bank-2m', yaw: 2.28, side: 1, at: { race: [8699.43, 396.86], suv: [8699.47, 396.9], truck: [8699.66, 397.13], dirt: [8698.7, 396.01] } },
];
// which vehicles at which sites: the race car everywhere, the others at the two steepest
const RUNS = [...SITES.map(s => [s, 'car', 'race']), ...SITES.slice(0, 2).flatMap(s => [[s, 'car', 'suv'], [s, 'car', 'truck'], [s, 'bike', 'dirt']])];
const LIFT_MAX = 0.3;
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

async function session(label, url) {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
  watchErrors(page, label, errors);
  page.on('console', m => {
    if (m.type() !== 'error' || /favicon/.test(m.location()?.url || '') || IGNORE.test(`${m.text()} ${m.location()?.url || ''}`)) return;
    errors.push(`${label}: ${m.text()}`); console.log(`console error (${label})`, m.text());
  });
  await startGame(page, { url });
  // the camera: behind and low on the bank's side, looking past the car (the owner's view), or across the road at it
  await page.evaluate(() => {
    const r = game.renderer, render = r.render.bind(r);
    r.render = (scene, c) => {
      const v = game.vehicles.current, view = window.__liftCam;
      if (view) {
        const V = c.position.constructor, p = v.renderPos, fw = new V(0, 0, 1).applyQuaternion(v.renderQuat).setY(0).normalize();
        const left = new V(fw.z, 0, -fw.x), s = view.side, ground = v.world.heightAt(p.x, p.z, p.y + 1);
        if (view.mode === 'rear') c.position.copy(p).addScaledVector(fw, -5.5).addScaledVector(left, s * 0.6).setY(ground + 1.3);
        else c.position.copy(p).addScaledVector(left, -s * 9).addScaledVector(fw, 1.5).setY(ground + 1.6);
        c.up.set(0, 1, 0); c.lookAt(p.x, ground + 0.6, p.z); c.updateMatrixWorld();
      }
      render(scene, c);
    };
  });
  return page;
}
// what's drawn: lift, the body frame's height off the road under the car, the race car's arms
const state = page => page.evaluate(() => {
  const v = game.vehicles.current, ud = v.mesh.userData, p = v.renderPos, up = v.mesh.up.clone().set(0, 1, 0).applyQuaternion(v.renderQuat);
  const arms = ud.linkage?.extent?.();
  return { kind: v.kind, type: v.type, kmh: Math.round(Math.hypot(v.vel.x, v.vel.z) * 3.6), upright: +up.y.toFixed(2),
    lift: +(ud.bodyLift ?? 0).toFixed(3), overRoad: +(p.y - v.world.heightAt(p.x, p.z, p.y + 1)).toFixed(2),
    arms: arms ? { swing: +(arms.wantSwing ?? arms.swing).toFixed(2), stretch: +(arms.wantStretch ?? arms.stretch).toFixed(2) } : null,
    finite: [...v.pos, ...v.vel, ...v.quat].every(Number.isFinite) };
});
async function shot(page, label, name, view, site) {
  await page.evaluate((view, side) => { window.__liftCam = { mode: view, side }; }, view, site.side); await wait(300);
  const s = await state(page), file = path.join(OUT, `${name}-${view}${BEFORE ? '-' + label : ''}.png`);
  await page.screenshot({ path: file }); shots.push({ label, name, view, file, ...s });
  console.log(`  ${label} ${file} ${JSON.stringify(s)}`);
  if (label === 'after') {
    check(s.finite, `${name}: finite state`);
    if (s.upright > 0.9) check(s.lift <= LIFT_MAX, `${name} ${view}: body drawn ${s.lift} m off its wheels (≤ ${LIFT_MAX})`);
    if (s.arms) check(s.arms.swing <= ARM_SWING && s.arms.stretch <= ARM_STRETCH, `${name} ${view}: arms asked ${s.arms.swing} rad ×${s.arms.stretch}`);
  }
  await page.evaluate(() => { window.__liftCam = null; });
}
async function runAll(label, url) {
  const page = await session(label, url);
  for (const [site, kind, type] of RUNS) {
    const [x, z] = site.at[type], name = `${site.name}-${type}`;
    await page.evaluate((kind, type) => { game.vehicles.choose(kind, type); }, kind, type);
    await holdCar(page, { x, z, yaw: site.yaw, kind });
    await wait(2500);                                              // settle, parked
    await shot(page, label, `${name}-parked`, 'rear', site); await shot(page, label, `${name}-parked`, 'across', site);
    // creep along the edge at 25 km/h (held on the line: heading and speed set each frame for 1.5 s)
    await page.evaluate(async (x, z, yaw) => {
      const v = game.vehicles.current, t0 = performance.now(), fx = Math.sin(yaw), fz = Math.cos(yaw);
      while (performance.now() - t0 < 1500) {
        const d = (performance.now() - t0) / 1000 * 25 / 3.6;
        v.pos.x = x + fx * d; v.pos.z = z + fz * d; v.vel.x = fx * 25 / 3.6; v.vel.z = fz * 25 / 3.6;
        await new Promise(r => requestAnimationFrame(r));
      }
    }, x, z, site.yaw);
    await shot(page, label, `${name}-creep`, 'rear', site);
  }
  await page.close();
}

try {
  if (BEFORE) await runAll('before', BEFORE);
  await runAll('after', GAME_URL);
} catch (e) {
  check(false, `script: ${e.message}`);
} finally {
  check(!errors.length, `no page errors (${errors.length})`);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ shots, failures, errors }, null, 1));
  await browser.close();
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nall body lift shots ok', '→', OUT);
  process.exitCode = failures.length ? 1 : 0;
}
