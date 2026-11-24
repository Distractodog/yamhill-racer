// Director browser check for every aircraft type (Garage → Jet → Type: Fighter jet, Stealth fighter, Prop plane, Stunt
// plane, Helicopter) in one page. Serves game/ on 127.0.0.1:8173 if nothing is listening there. Run through the gate:
//   node tools/air_shots.mjs --out /tmp/yr-air-shots [--types fighter,heli]
// Per type: Garage preview (the real Type select), on Hwy 18, take-off (side view of the run, then lift-off), in flight
// from behind and the side, banking, approach + touchdown + stopped on Hwy 18 (the helicopter: hover, then S down onto
// the road), and at night on the ground and flying (nav lights, strobe, landing light). Then aircraft-to-aircraft
// Garage swaps in the air, low and high (helicopter ⇄ planes). Prints each shot's state, frame times and page errors and
// writes results.json; exits non-zero on a failed check. Review the PNGs.
// Everything on the road happens on the straight stretch of Hwy 18 west of the fixed jump ramp (assets/ramps.json),
// heading away from it: the ramp is never within 400 m of a take-off run or a landing (checked before each one).
// Every aircraft step is tracked: a crash, a respawn (a jump in position) or a missing air → ground touchdown fails.
// Start-up from tools/lib/startgame.mjs.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { GAME_URL, startGame, holdCar, watchErrors } from './lib/startgame.mjs';

const args = process.argv.slice(2), arg = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
const OUT = arg('--out', '/tmp/yr-air-shots');
const TYPES = arg('--types', 'fighter,stealth,blackbird,prop,stunt,heli').split(',');
// approach speeds for the landing autopilot (a little above each type's stall)
const APPROACH = { fighter: 330, stealth: 345, blackbird: 400, prop: 115, stunt: 165 };
// metres along the road from each start: take-off run + climb-out, and approach + roll-out from 30 m up (a Node run of
// this autopilot on the real map stops the fighter / stealth ~3 km out, the prop / stunt planes ~1 km out)
const RUN = 1500, LANDING = 3600, RAMP_CLEAR = 400;
// the analytics beacon is refused on localhost (CORS): not a game error
const IGNORE = /cloudflareinsights\.com/;
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
const state = () => page.evaluate(() => {
  const v = game.vehicles.current, ud = v.mesh.userData;
  return { kind: v.kind, type: v.type, name: v.name, model: v.mesh.name, mode: v.mode, kmh: Math.round(v.vel.length() * 3.6),
    agl: +(v.agl ?? 0).toFixed(1), bank: Math.round((v.bank ?? v.roll ?? 0) * 57.3), throttle: +(v.throttle ?? 0).toFixed(2),
    gear: +(v.gear ?? 0).toFixed(2), surface: v.surface, msg: v.msgT > 0 ? v.msg : '', finite: [...v.pos, ...v.vel, ...v.quat].every(Number.isFinite),
    spin: +(ud.mainRotor?.rotation.y ?? ud.propeller?.hub.rotation.z ?? 0).toFixed(2), hud: document.getElementById('veh-line')?.textContent || '' };
});
async function shot(type, name, note = '') {
  const s = await state(), file = path.join(OUT, `${type}-${name}.png`);
  await page.screenshot({ path: file }); shots.push({ type, name, note, ...s });
  console.log(`  shot ${file} ${JSON.stringify(s)}`);
  check(s.finite, `${type} ${name}: finite state`);
  return s;
}
const keys = (add, del = []) => page.evaluate((add, del) => { del.forEach(k => game.keys.delete(k)); add.forEach(k => game.keys.add(k)); }, add, del);
const clearKeys = () => page.evaluate(() => game.keys.clear());
// wait for a condition in the page; a timeout is a failed check
const until = (what, cond, timeout = 30000) => page.waitForFunction(cond, { timeout, polling: 50 }).then(() => true, () => false)
  .then(ok => check(ok, `waited for ${what}`));
const cam = mode => page.evaluate(mode => { window.__airCam = mode; }, mode);
const frames = ms => page.evaluate(ms => new Promise(done => {
  const t = []; let last = performance.now(); const end = last + ms;
  const f = now => { t.push(now - last); last = now; if (now < end) requestAnimationFrame(f); else { t.sort((a, b) => a - b); done({ median: +t[t.length >> 1].toFixed(1), p95: +t[Math.floor(t.length * 0.95)].toFixed(1), slowPct: +(100 * t.filter(d => d > 20).length / t.length).toFixed(1) }); } };
  requestAnimationFrame(f);
}), ms);
// flight log of the current aircraft from now on (mode changes, crashes, biggest one-step jump, closest ramp)
const track = () => page.evaluate(() => window.__startTrack());
const tracked = () => page.evaluate(() => { const { vehicle, prev, ...T } = window.__track; return T; });
// Garage → Jet tab → Type select, like a player. `place` runs in the same page task that opens the Garage (which freezes
// physics), so the returned position is exactly where the aircraft is when the type changes.
async function chooseType(type, place = null) {
  const before = await page.evaluate(place => {
    if (place) window.__place(game.vehicles.current, place);
    game.garage.show(); return game.vehicles.current.pos.toArray();
  }, place);
  await page.click('#cosmetic-garage [data-kind="jet"]');
  const sel = '#cosmetic-garage select[name="vehicleType"]';
  await page.waitForSelector(sel, { visible: true });
  await page.select(sel, type); await wait(700);
  const after = await page.evaluate(sel => { const v = game.vehicles.current; return { chosen: game.vehicles.getType('jet'), type: v.type, mode: v.mode, pos: v.pos.toArray(), options: [...document.querySelector(sel).options].map(o => o.value) }; }, sel);
  return { before, ...after };
}

try {
  page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
  watchErrors(page, 'game', errors);
  page.on('console', m => {
    if (m.type() !== 'error' || /favicon/.test(m.location()?.url || '') || IGNORE.test(`${m.text()} ${m.location()?.url || ''}`)) return;
    errors.push(m.text()); console.log('console error', m.text());
  });
  await startGame(page);
  const RAMPS = await page.evaluate(() => fetch('./assets/ramps.json').then(r => r.json()));
  // side / front-quarter camera (the game's own camera otherwise), an autopilot and the flight log on whichever aircraft
  // fills the jet slot
  await page.evaluate(ramps => {
    window.__ramps = ramps;
    const r = game.renderer, render = r.render.bind(r);
    r.render = (scene, cam) => {
      const mode = window.__airCam, v = game.vehicles.current;
      if (mode) {
        const V = cam.position.constructor, p = v.renderPos, q = v.renderQuat;
        const fw = new V(0, 0, 1).applyQuaternion(q).setY(0).normalize(), right = new V(-fw.z, 0, fw.x);
        if (mode === 'side') cam.position.copy(p).addScaledVector(right, v.mesh.userData.mainRotor ? 16 : 17).add(new V(0, 1.6, 0));
        else cam.position.copy(p).addScaledVector(fw, 11).addScaledVector(right, 7).add(new V(0, 1.6, 0));
        cam.up.set(0, 1, 0); cam.lookAt(p); cam.updateMatrixWorld();
      }
      render(scene, cam);
    };
    for (const v of game.vehicles.aircraft) {
      const step = v.step.bind(v);
      v.step = (dt, input) => {
        if (window.__auto && v === game.vehicles.current) { input.jet = { ...input.jet }; window.__auto(v, input.jet, input); }
        const out = step(dt, input), T = window.__track;
        if (T && T.vehicle === v) {
          if (v.mode !== T.modes[T.modes.length - 1]) { T.modes.push(v.mode); if (v.mode === 'crashed') T.crashes.push(v.msg); }
          if (T.prev) T.jump = Math.max(T.jump, Math.hypot(v.pos.x - T.prev[0], v.pos.y - T.prev[1], v.pos.z - T.prev[2]));
          T.prev = v.pos.toArray();
          for (const R of window.__ramps) T.minRamp = Math.min(T.minRamp, Math.hypot(v.pos.x - R.x, v.pos.z - R.z));
        }
        return out;
      };
    }
    window.__startTrack = () => { const v = game.vehicles.current; window.__track = { modes: [v.mode], crashes: [], jump: 0, prev: null, minRamp: Infinity, vehicle: v }; };
    // put the aircraft in the air at { x, z, yaw, agl, kmh }, exactly `agl` above the ground
    window.__place = (v, { x, z, yaw, agl, kmh }) => {
      v.placeInAir(x, 0, z, yaw, v.mesh.userData.mainRotor ? 0 : kmh);
      v.pos.y = game.world.heightAt(x, z) + agl + (v.air?.gearH ?? 1.6); v.afterReset();
    };
  }, RAMPS);
  // Hwy 18 runs straight for ~4.3 km west of the ramp ([0] in ramps.json) along its heading: start 500 m from the
  // ramp facing away from it, so it falls behind
  const R0 = RAMPS[0], hx = Math.sin(R0.yaw), hz = Math.cos(R0.yaw);
  const ROAD = { x: R0.x - hx * 500, z: R0.z - hz * 500, yaw: R0.yaw + Math.PI };
  // closest any ramp comes to `len` m of road ahead of `p`
  const rampGap = (p, len) => Math.min(...RAMPS.map(R => {
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw), s = Math.max(0, Math.min(len, (R.x - p.x) * fx + (R.z - p.z) * fz));
    return Math.hypot(R.x - p.x - fx * s, R.z - p.z - fz * s);
  }));
  check(rampGap(ROAD, Math.max(RUN, LANDING)) > RAMP_CLEAR, `no ramp within ${RAMP_CLEAR} m of the take-off / landing stretch (closest ${rampGap(ROAD, LANDING).toFixed(0)} m)`);

  for (const type of TYPES) {
    console.log(`\n== ${type}`);
    const heli = type === 'heli';
    await page.evaluate(() => { window.__auto = null; window.__airCam = null; window.__track = null; game.keys.clear(); game.atmosphere.setPreset('midday', false); });
    await holdCar(page, { ...ROAD, kind: 'jet' });
    // ---- Garage preview
    const g = await chooseType(type);
    check(g.chosen === type && g.type === type && ['fighter', 'stealth', 'blackbird', 'prop', 'stunt', 'heli'].every(t => g.options.includes(t)), `Garage: ${type} chosen (${g.options.join(', ')})`);
    await shot(type, '01-garage', 'Garage preview');
    await page.evaluate(() => game.garage.close());
    // ---- on Hwy 18
    await holdCar(page, { ...ROAD, kind: 'jet' });
    await page.evaluate(() => game.setCam(0)); await wait(800);
    let s = await shot(type, '02-on-the-road', 'parked on Hwy 18');
    check(s.type === type && s.mode === 'ground' && s.surface === 3, `${type}: on the road (${s.name}, ${s.model}, surface ${s.surface})`);
    // ---- take-off
    await track();
    if (heli) {
      await keys(['KeyW']); await until('lift-off', () => game.vehicles.current.mode === 'air' && game.vehicles.current.agl > 6);
      await cam('side'); await wait(150); await shot(type, '03-takeoff-side', 'lifting off (side)'); await cam(null);
      await until('climb to 60 m', () => game.vehicles.current.agl > 60); await clearKeys();
    } else {
      await keys(['KeyW']);
      await until('take-off speed', () => game.vehicles.current.vel.length() * 3.6 > game.vehicles.current.t.rotateKmh * 0.8, 45000);
      await cam('side'); await wait(150); await shot(type, '03-takeoff-roll-side', 'take-off run (side)'); await cam(null);
      await keys(['ArrowDown']); await until('lift-off', () => game.vehicles.current.mode === 'air', 30000);
      await keys([], ['ArrowDown']); await wait(2500);
    }
    s = await shot(type, '04-liftoff', 'climbing out');
    let T = await tracked();
    check(s.mode === 'air' && T.modes[0] === 'ground' && !T.crashes.length && T.jump < 20 && T.minRamp > RAMP_CLEAR,
      `${type}: took off from the road (${s.kmh} km/h, ${s.agl} m; modes ${T.modes.join(' → ')}, ramp ≥ ${T.minRamp.toFixed(0)} m)`);
    await clearKeys();
    // ---- in flight: behind, side, banked
    if (heli) await page.evaluate(() => { window.__auto = (k, J) => { J.thr = k.agl < 120 ? 1 : 0; J.pitch = 1; }; });
    else await page.evaluate(p => {
      const v = game.vehicles.current; window.__place(v, { ...p, agl: 160, kmh: Math.min(v.air.airKmh, 600) });
      v.throttle = 0.8; window.__auto = (k, J) => { J.thr = 0; }; window.__startTrack();
    }, ROAD);
    if (heli) await track();
    const ft = await frames(heli ? 8000 : 2500);
    s = await shot(type, '05-flight-behind', `chase camera (frames ${JSON.stringify(ft)})`);
    check(s.mode === 'air', `${type}: flying (${s.kmh} km/h)`);
    await cam('side'); await wait(300); await shot(type, '06-flight-side', 'side view'); await cam(null);
    await page.evaluate(heli => {
      window.__auto = heli ? (k, J) => { J.thr = 0; J.pitch = 1; J.roll = 1; }
        : (k, J) => { J.thr = 0; J.roll = Math.max(-1, Math.min(1, (0.8 - k.bank) * 3)); };
    }, heli);
    await wait(1800);
    s = await shot(type, '07-flight-bank', 'banked turn');
    T = await tracked();
    check(s.mode === 'air' && Math.abs(s.bank) > 10 && T.modes.join() === 'air' && T.jump < 20, `${type}: banks into a turn (${s.bank}°), no crash (modes ${T.modes.join(' → ')})`);
    // ---- landing on Hwy 18, heading away from the ramp
    await page.evaluate(() => { window.__auto = null; }); await clearKeys();
    await holdCar(page, { ...ROAD, kind: 'jet' });
    if (heli) {
      await page.evaluate(p => { window.__place(game.vehicles.current, { ...p, agl: 40, kmh: 0 }); window.__startTrack(); }, ROAD);
      await wait(1500); await shot(type, '08-hover', 'hovering over the road');
      await keys(['KeyS']); await until('descent to 4 m', () => game.vehicles.current.agl < 4, 40000);
      await cam('side'); await wait(100); await shot(type, '09-approach-side', 'coming down with S (side)'); await cam(null);
      await until('touchdown', () => game.vehicles.current.mode !== 'air', 20000); await wait(400);
      await shot(type, '10-touchdown', 'on the skids');
      await clearKeys();
    } else {
      await page.evaluate(({ p, approach }) => {
        const v = game.vehicles.current, { x, z, yaw } = p; window.__place(v, { ...p, agl: 30, kmh: approach });
        window.__auto = (k, J, input) => {
          J.yaw = 0; J.roll = 0;
          if (k.mode === 'air') {
            const hx = Math.sin(yaw), hz = Math.cos(yaw), off = (k.pos.x - x) * hz - (k.pos.z - z) * hx;
            let d = yaw - Math.atan2(k.vel.x, k.vel.z); d = Math.atan2(Math.sin(d), Math.cos(d));
            J.roll = Math.max(-1, Math.min(1, (Math.max(-0.35, Math.min(0.35, -d * 3 + off * 0.01)) - k.bank) * 3));
            const wantVy = k.agl > 5 ? -Math.min(3, Math.max(1.5, k.agl / 15)) : -0.8;
            J.pitch = Math.max(-1, Math.min(1, (wantVy - k.vel.y) * 0.25));
            J.thr = k.vel.length() * 3.6 > approach ? -1 : 0.6;
          } else { J.thr = -1; J.pitch = 0; input.handbrake = true; }
        };
        window.__startTrack();
      }, { p: ROAD, approach: APPROACH[type] });
      await until('final approach below 18 m', () => game.vehicles.current.agl < 18, 60000);
      await cam('side'); await wait(150); await shot(type, '09-approach-side', 'final approach (side)'); await cam(null);
      await until('touchdown', () => game.vehicles.current.mode !== 'air', 60000); await wait(400);
      await shot(type, '10-touchdown', 'touchdown');
    }
    await until('stopped', () => game.vehicles.current.vel.length() < 0.5 && game.vehicles.current.mode === 'ground', 40000);
    s = await shot(type, '11-landed', 'stopped');
    T = await tracked();
    const touched = T.modes[0] === 'air' && T.modes.includes('ground') && !T.modes.includes('crashed');
    check(touched && !T.crashes.length && T.jump < 20 && s.mode === 'ground' && s.kmh < 2 && s.surface === 3 && T.minRamp > RAMP_CLEAR,
      `${type}: air → ground touchdown on Hwy 18, stopped, no crash or respawn (modes ${T.modes.join(' → ')}${T.crashes.length ? `, crashes: ${T.crashes.join(', ')}` : ''}, biggest step ${T.jump.toFixed(1)} m, surface ${s.surface}, ramp ≥ ${T.minRamp.toFixed(0)} m, "${s.msg}")`);
    await page.evaluate(() => { window.__auto = null; window.__track = null; });
    // ---- night
    await page.evaluate(() => game.atmosphere.setPreset('night', false));
    await holdCar(page, { ...ROAD, kind: 'jet' }); await wait(1500);
    const lights = await page.evaluate(() => ({ on: game.vehicleLights.on, beam: game.vehicleLights.beam, landingLight: !!game.vehicles.current.mesh.userData.landingLight,
      lenses: game.vehicleLights.lenses?.group.children.filter(o => o.visible).map(o => o.name.replace('vehicle-light-', '')) || [] }));
    console.log('  lights', JSON.stringify(lights));
    check(lights.on && ['left', 'right'].every(n => lights.lenses.includes(n)) && lights.beam === lights.landingLight,
      `${type}: night nav lights on, landing light beam ${lights.landingLight ? 'on' : 'none (lens only)'}`);
    await shot(type, '12-night-ground', 'night, on the road');
    if (heli) { await keys(['KeyW']); await until('night lift-off to 25 m', () => game.vehicles.current.agl > 25); await clearKeys(); }
    else await page.evaluate(p => { const v = game.vehicles.current; window.__place(v, { ...p, agl: 120, kmh: Math.min(v.air.airKmh, 600) }); window.__auto = (k, J) => { J.thr = 0; }; }, ROAD);
    await wait(1500); await shot(type, '13-night-flight-behind', 'night flight (chase)');
    await cam('side'); await wait(300); await shot(type, '14-night-flight-side', 'night flight (side)'); await cam(null);
    await page.evaluate(() => { window.__auto = null; game.atmosphere.setPreset('midday', false); });
  }

  // ---- aircraft ⇄ aircraft in the air: Garage swaps while flying, high and just above the road. The aircraft is placed
  // and the Garage opened in one page task (physics stops while it is open), so `before` is the exact swap position.
  console.log('\n== in-air swaps');
  await holdCar(page, { ...ROAD, kind: 'jet' }); await chooseType('fighter'); await page.evaluate(() => game.garage.close());
  for (const agl of [150, 4]) {
    let from = 'fighter';
    for (const to of ['heli', 'prop', 'heli', 'stealth', 'blackbird', 'stunt', 'heli', 'fighter']) {
      const r = await chooseType(to, { ...ROAD, agl, kmh: 300 });
      const moved = Math.hypot(...r.pos.map((p, i) => p - r.before[i]));
      check(r.type === to && r.mode === 'air' && moved < 1e-6, `swap ${from} → ${to} at ${agl} m: still flying where it was (${r.mode}, moved ${moved.toExponential(1)} m)`);
      if (to === 'heli' && agl === 4) await shot(`swap-${agl}m`, `${from}-to-${to}`, 'just swapped low over the road');
      await page.evaluate(() => game.garage.close()); from = to;
    }
  }
} finally {
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ shots, errors, failures }, null, 2));
  await browser.close();
}
const real = errors.filter(e => !IGNORE.test(e));
if (real.length) console.log('PAGE ERRORS:\n  ' + real.join('\n  '));
check(!real.length, 'no page errors');
console.log(failures.length ? `\nFAILED: ${failures.join('; ')}` : `\nPASS · screenshots in ${OUT} (look at them)`);
process.exit(failures.length ? 1 : 0);
