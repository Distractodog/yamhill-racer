// Director: screenshots of the shaped Hatchback and SUV (game/src/models/hatch.js, suv.js) in the real game.
// Serve game/ on 127.0.0.1:8173 (python3 tools/serve.py 8173 game) and run through the heavy-check gate:
//   node tools/model_shots_hatchsuv.mjs --out /tmp/yr-hatchsuv [--types hatch,suv]
// Per type: Garage preview; parked on a road from front 3/4, rear 3/4, side, top, low front, front wheel steered;
// driving at speed (chase camera and a roadside camera); night front 3/4 and rear 3/4 braking (lit lenses + beam).
// Writes <out>/results.json (page errors, triangles, draw calls, frame times). PNGs need visual review.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { GAME_URL, startGame, holdCar, watchErrors } from './lib/startgame.mjs';

const args = process.argv.slice(2), opt = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
const out = opt('--out', '/tmp/yr-hatchsuv'), types = opt('--types', 'hatch,suv').split(',');
const SPOT = { x: 19451, z: -11032, yaw: -1.573 };          // straight road (tools/lights_shots.mjs)
fs.mkdirSync(out, { recursive: true });
const report = { errors: [], shots: [], stats: [] }, wait = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 760 }); page.setDefaultTimeout(120000);
  watchErrors(page, 'game', report.errors);
  page.on('console', m => { if (m.type() === 'error' && !(m.location()?.url || '').includes('favicon') && !/cloudflareinsights/.test(m.text() + (m.location()?.url || ''))) report.errors.push(m.text()); });
  await startGame(page, { url: GAME_URL, hold: { ...SPOT, kind: 'car' } });
  // Camera hook: while shotCam is set, the camera sits at an offset in the car's frame (+x left, +z forward) or at a
  // fixed world point, looking at the car (or at one wheel). Physics can be frozen so parked shots are still.
  await page.evaluate(() => {
    const g = game, render = g.renderer.render.bind(g.renderer);
    window.shotCam = null;
    g.renderer.render = (scene, camera) => {
      const s = shotCam, v = g.vehicles.current;
      if (s) {
        const p = v.mesh.position.clone(), target = s.wheel != null ? v.mesh.userData.wheels[s.wheel].holder.getWorldPosition(p.clone()) : p.clone().setY(p.y + (s.lookY ?? .3));
        if (s.fixed) camera.position.set(...s.fixed);
        else camera.position.copy(p).add(new THREE_V(...s.at).applyQuaternion(v.mesh.quaternion));
        camera.lookAt(target); camera.updateMatrixWorld();
      }
      render(scene, camera);
    };
    window.THREE_V = g.camera.position.constructor;
    window.freeze = on => { for (const v of Object.values(g.vehicles.all)) { if (on && !v._shotStep) { v._shotStep = v.step; v.step = () => {}; } if (!on && v._shotStep) { v.step = v._shotStep; delete v._shotStep; } } };
  });
  const shot = async (name, extra = {}) => {
    await wait(700);
    const file = `${name}.png`; await page.screenshot({ path: path.join(out, file) });
    const info = await page.evaluate(() => ({ type: game.vehicles.current.type, kmh: Math.round(game.vehicles.current.vel.length() * 3.6),
      triangles: game.renderer.info.render.triangles, calls: game.renderer.info.render.calls }));
    report.shots.push({ file, ...info, ...extra }); console.log(file, info);
  };
  for (const id of types) {
    await page.evaluate(id => { game.challenges.quit?.(); game.vehicles.switchTo('car'); game.vehicles.setType('car', id); game.atmosphere.setPreset('midday', false); }, id);
    await holdCar(page, SPOT);
    // Garage preview
    await page.evaluate(() => game.garage.show()); await page.click('#cosmetic-garage [data-kind="car"]');
    await shot(`${id}-garage`);
    await page.evaluate(() => game.garage.close());
    // parked
    await page.evaluate(() => { freeze(true); game.keys.clear(); });
    const views = { front34: { at: [3.6, 1.4, 4.4] }, rear34: { at: [-3.8, 1.7, -4.6] }, side: { at: [6, .8, 0] }, top: { at: [.01, 8, 0], lookY: 0 },
      lowfront: { at: [2.4, .25, 4.2], lookY: .1 }, wheel: { at: [2.2, .2, 2.2], wheel: 0 } };
    for (const [name, cam] of Object.entries(views)) {
      await page.evaluate(cam => { shotCam = cam; }, cam);
      if (name === 'wheel') await page.evaluate(() => { const v = game.vehicles.current; v.steer = 1; });
      await shot(`${id}-${name}`);
      await page.evaluate(() => { game.vehicles.current.steer = 0; });
    }
    // driving at speed: chase camera, then a roadside camera 70 m ahead
    const ahead = await page.evaluate(spot => {
      shotCam = null; freeze(false); const v = game.vehicles.current; v.reset(spot.x, spot.z, spot.yaw); game.setCam(0); game.keys.add('KeyW');
      const fx = Math.sin(spot.yaw), fz = Math.cos(spot.yaw), x = spot.x + fx * 90 + fz * 7, z = spot.z + fz * 90 - fx * 7;
      return [x, game.world.heightAt(x, z) + 1.6, z];
    }, SPOT);
    await wait(2300); await shot(`${id}-driving-chase`);
    await page.evaluate(fixed => { shotCam = { fixed, lookY: .4 }; }, ahead);
    await wait(500); await shot(`${id}-driving-roadside`);
    // frame times while driving
    report.stats.push(await page.evaluate(async id => {
      let last = performance.now(); const s = [];
      await new Promise(r => { const f = now => { s.push(now - last); last = now; if (s.length < 90) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f); });
      s.sort((a, b) => a - b); return { type: id, medianMs: +s[45].toFixed(1), p95Ms: +s[85].toFixed(1), kmh: Math.round(game.vehicles.current.vel.length() * 3.6) };
    }, id));
    await page.evaluate(() => { game.keys.clear(); shotCam = null; });
    // night, lights on, braking at the back
    await holdCar(page, SPOT);
    await page.evaluate(() => { game.atmosphere.setPreset('night', false); freeze(true); shotCam = { at: [3.4, 1.3, 5.2] }; });
    await wait(1200); await shot(`${id}-night-front34`);
    await page.evaluate(() => { game.keys.add('KeyS'); shotCam = { at: [-3.6, 1.5, -5] }; });
    await wait(800); await shot(`${id}-night-rear34-braking`);
    await page.evaluate(() => { game.keys.clear(); freeze(false); shotCam = null; game.atmosphere.setPreset('midday', false); });
  }
} catch (e) { report.errors.push(`script: ${e.message}`); console.error(e); }
finally {
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2)); await browser.close();
}
console.log(report.errors.length ? `FAIL: ${report.errors.length} errors (see results.json)` : `PASS: no page errors. Review the PNGs in ${out}.`);
process.exit(report.errors.length ? 1 : 0);
