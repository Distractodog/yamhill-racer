import * as THREE from 'three';
import GUI from 'lil-gui';
import { loadWorld } from './world.js';
import { createRimRing } from './rimring.js';
import { Car, TUNING_DEFAULTS } from './car.js';
import { Effects } from './effects.js';
import { CarAudio } from './audio.js';
import { createMinimap } from './minimap.js';
import { createChallenges } from './challenges.js';
import { createPinGuide } from './pin.js';
import { Glider, BIKE_GLIDER } from './glider.js';
import { createVehicles } from './vehicles.js';
import { BIKE } from './bike.js';
import { JET } from './jet.js';
import { createSettings } from './settings.js';
import { makeRim } from './rim.js';

const settings = createSettings();

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0xa9cbe3);
scene.background = SKY;
scene.fog = new THREE.Fog(0xb4cfe0, 250, 1500);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.3, 2200);

scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a5a3a, 1.4));
const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const SH = 60;
Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 60, far: 260 });
sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.04;   // small bias: shadows start right at the tyres
scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(-0.45, 0.8, 0.35).normalize();

// ---------------------------------------------------------------- tuning (remembered per browser)
const tuning = { ...TUNING_DEFAULTS };
// Saved values are only taken for known settings and when they're real numbers (a NaN is saved as null, which
// would zero that setting for good; settings from an older build that aren't in the menu any more are dropped).
function loadSaved(key, target, defaults, ranges) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch {}
  for (const k in saved) {
    const v = saved[k];
    if (!(k in defaults) || (ranges && !(k in ranges)) || typeof v !== typeof defaults[k] || (typeof v === 'number' && !Number.isFinite(v))) continue;
    target[k] = ranges ? Math.min(ranges[k][1], Math.max(ranges[k][0], v)) : v;
  }
}
loadSaved('yr-tuning-2', tuning, TUNING_DEFAULTS);
// a browser that saved an old default gets the new one (keeps anything Ethan changed himself)
const OLD_DEFAULTS = { topSpeed: [270, 600], accel: [17], brakeDecel: [32] };
for (const k in OLD_DEFAULTS) if (OLD_DEFAULTS[k].includes(tuning[k])) tuning[k] = TUNING_DEFAULTS[k];
const save = () => { try { localStorage.setItem('yr-tuning-2', JSON.stringify(tuning)); } catch {} };

const loadingEl = document.getElementById('loading');
const world = await loadWorld(renderer, (n, of) => { loadingEl.textContent = `Loading map… ${n}/${of}`; });
const rim = makeRim(world.W.rim);
scene.add(world.group);
const rimRing = createRimRing({ scene, rim: world.W.rim });
// vehicles (vehicles.js): `car` below is a stand-in for whichever vehicle you're in (V switches)
const bikeTuning = { ...BIKE }, jetTuning = { ...JET };
// what the Settings menu can change (min, max, step); only these are saved and loaded back
const BIKE_RANGES = { accel: [5, 40, 0.5], topSpeed: [80, 500, 5], cornerGrip: [10, 50, 0.5], steerLock: [0.3, 1.2, 0.01], wheelie: [0.2, 0.9, 0.01], gravity: [9.8, 30, 0.2] };
const JET_RANGES = { thrust: [6, 40, 0.5], liftK: [0.001, 0.005, 0.0001], rollRate: [0.5, 5, 0.1], maxG: [3, 12, 0.5], gravity: [9.8, 30, 0.2] };
loadSaved('yr-tuning-bike-1', bikeTuning, BIKE, BIKE_RANGES);
loadSaved('yr-tuning-jet-1', jetTuning, JET, JET_RANGES);
const vehicles = createVehicles({ scene, world, tuning, bikeTuning, jetTuning, canSwitch: kind => {
  // switching vehicle mid-race ends the race (each race belongs to one vehicle)
  if (challenges.state !== 'idle' && challenges.vehicle !== kind) challenges.quit();
  return true;
} });
const car = vehicles.player;
const glider = new Glider(vehicles.car);         // G opens a hang-glider wing over the car (glider.js)
const bikeGlider = new Glider(vehicles.bike, BIKE_GLIDER);   // …and a smaller one over the dirt bike
const [sx, sz] = world.spawn;
// campus drives are mostly gravel service roads in OpenStreetMap; take asphalt if it is close, else gravel
let spawn = world.placeOn(sx, sz, 3, 80);
if (world.surfaceAt(spawn[0], spawn[1]) !== 3) spawn = world.placeOn(sx, sz, 4, 150);
car.reset(...spawn);
const effects = new Effects(scene);
const audio = new CarAudio();
const minimap = await createMinimap();
const challenges = await createChallenges({ scene, world, car, minimap, vehicles });
const pinGuide = createPinGuide({ scene, world, car, minimap, challenges });
document.getElementById('loading').remove();

const gui = new GUI({ title: 'Vehicle tuning', container: document.getElementById('tuning-controls') });
const fc = gui.addFolder('Car');
const RANGES = {
  accel: [5, 60, 0.5], topSpeed: [100, 1500, 10], brakeDecel: [10, 100, 1],
  steerLock: [0.2, 0.9, 0.01], steerRate: [2, 20, 0.5], cornerGrip: [10, 60, 0.5], turnResponse: [3, 30, 0.5],
  gripAlign: [2, 30, 0.5], driftAlign: [0.3, 5, 0.05], driftTurn: [0.3, 2.5, 0.05], driftMaxAngle: [15, 80, 1],
  driftSpeedLoss: [0, 1, 0.01], driftBoost: [0, 15, 0.5],
  springK: [20000, 150000, 500], damping: [1000, 15000, 100], restLength: [0.2, 0.9, 0.01], snap: [0, 200, 1],
  downforce: [0, 0.02, 0.0005], gravity: [9.8, 40, 0.2], airControl: [0, 8, 0.1], airStabilize: [0, 8, 0.1],
};
for (const k in RANGES) fc.add(tuning, k, ...RANGES[k]).onChange(save);
fc.add({ reset: () => { Object.assign(tuning, TUNING_DEFAULTS); save(); gui.controllersRecursive().forEach(c => c.updateDisplay()); } }, 'reset').name('Reset to defaults');
fc.add({ copy: () => navigator.clipboard?.writeText(JSON.stringify(tuning, null, 1)) }, 'copy').name('Copy settings');
const pick = (o, ranges) => Object.fromEntries(Object.keys(ranges).map(k => [k, o[k]]));
const saveB = () => { try { localStorage.setItem('yr-tuning-bike-1', JSON.stringify(pick(bikeTuning, BIKE_RANGES))); localStorage.setItem('yr-tuning-jet-1', JSON.stringify(pick(jetTuning, JET_RANGES))); } catch {} };
const fb = gui.addFolder('Dirt bike'); for (const [k, r] of Object.entries(BIKE_RANGES)) fb.add(bikeTuning, k, ...r).onChange(saveB);
const fj = gui.addFolder('Jet'); for (const [k, r] of Object.entries(JET_RANGES)) fj.add(jetTuning, k, ...r).onChange(saveB);
fb.close(); fj.close();
gui.add({ resetV: () => { Object.assign(bikeTuning, BIKE); Object.assign(jetTuning, JET); saveB(); gui.controllersRecursive().forEach(c => c.updateDisplay()); } }, 'resetV').name('Reset bike + jet');
gui.open();

// H: back to the Delphian campus from anywhere (waits for the campus tiles to stream in first)
async function goHome() {
  const [hx, hz] = world.spawn;
  for (let k = 0; k < 60 && !(world.loadedAt(hx, hz) && world.pendingTiles() === 0); k++) {
    car.pos.set(hx, car.pos.y, hz); car.vel.set(0, 0, 0); car._lastLoaded = null;
    await new Promise(r => setTimeout(r, 200));
  }
  let s = world.placeOn(hx, hz, 3, 80);
  if (world.surfaceAt(s[0], s[1]) !== 3) s = world.placeOn(hx, hz, 4, 150);
  car.reset(...s); car.safe = []; car._lastLoaded = null;
}

// F: put the car back on its wheels right where it is, facing the way it was pointing (keeps the clock running)
function flipUpright() {
  if (vehicles.current.flipUpright) { vehicles.current.flipUpright(); return; }
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quat);
  if (Math.hypot(f.x, f.z) < 0.2) f.set(0, 1, 0).applyQuaternion(car.quat).negate();   // nose straight up/down: use the roof
  car.reset(car.pos.x, car.pos.z, Math.atan2(f.x, f.z));
}

// ---------------------------------------------------------------- input
const keys = new Set();                 // physical keys held (e.code)
// The letter each held key prints on this keyboard layout, so the key *labelled* W is throttle on AZERTY / Dvorak too
// (there it sends code KeyZ / Comma). Physical WASD keeps working as well.
const letters = new Map();              // e.code → 'KeyW' etc. from e.key
const clearKeys = () => { keys.clear(); letters.clear(); };
settings.ready(clearKeys, () => {
  vehicles.close(); challenges.closeMenu(); if (minimap.open) minimap.toggle(false);
});
addEventListener('keydown', e => {
  if (e.gameUI) return;
  keys.add(e.code);
  if (/^[a-z]$/i.test(e.key)) letters.set(e.code, 'Key' + e.key.toUpperCase());
  audio.start();
  if (e.code === 'KeyR') car.resetToSafe();
  if (e.code === 'KeyF') flipUpright();
  if (e.code === 'KeyH') goHome();
  if (e.code === 'KeyC') camMode = (camMode + 1) % 3;
  if (e.code === 'KeyG' && !e.repeat) { if (vehicles.current.glide) vehicles.current.glide.toggle(); else vehicles.current.say?.('The jet has its own wings', 1.5); }
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', e => { keys.delete(e.code); letters.delete(e.code); });
addEventListener('blur', clearKeys);
addEventListener('visibilitychange', clearKeys);
const held = c => keys.has(c) || [...letters.values()].includes(c);
// Gamepad: the first one with the standard (Xbox-style) layout, and only once it has been touched. Other devices
// (joysticks, wheels, odd drivers) number their buttons differently or read "pressed" at rest: one like that used to
// force the jet's throttle down and hold the brakes every frame, so W seemed to do nothing.
const padRest = new Map();              // gamepad index → resting snapshot, or 'live' once something moved
addEventListener('gamepaddisconnected', e => padRest.delete(e.gamepad.index));
function activePad() {
  for (const gp of navigator.getGamepads?.() || []) {
    if (!gp || gp.connected === false || gp.mapping !== 'standard') continue;
    const r = padRest.get(gp.index);
    if (r === 'live') return gp;
    const snap = gp.buttons.map(b => (b.value > 0.5 || b.pressed) ? 1 : 0).join('') + '|' + gp.axes.map(a => Math.round(a * 2)).join(',');
    if (r === undefined) padRest.set(gp.index, snap);
    else if (snap !== r) { padRest.set(gp.index, 'live'); return gp; }
  }
  return null;
}
const input = { throttle: 0, brake: 0, steer: 0, handbrake: false, lean: false, jet: { thr: 0, pitch: 0, roll: 0, yaw: 0 } };
function readInput() {
  const k = c => !settings.open && held(c);
  input.throttle = (k('KeyW') || k('ArrowUp')) ? 1 : 0;
  input.brake = (k('KeyS') || k('ArrowDown')) ? 1 : 0;
  input.steer = ((k('KeyD') || k('ArrowRight')) ? 1 : 0) - ((k('KeyA') || k('ArrowLeft')) ? 1 : 0);
  input.handbrake = k('Space');
  input.lean = k('ShiftLeft') || k('ShiftRight');
  // jet: W/S throttle lever, ↑/↓ pitch (↓ = nose up, like pulling a stick), ←/→ roll, A/D rudder / nose wheel
  const J = input.jet;
  J.thr = (k('KeyW') ? 1 : 0) - (k('KeyS') ? 1 : 0);
  J.pitch = (k('ArrowDown') ? 1 : 0) - (k('ArrowUp') ? 1 : 0);
  J.roll = (k('ArrowRight') ? 1 : 0) - (k('ArrowLeft') ? 1 : 0);
  J.yaw = (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0);
  const gp = activePad();
  if (gp && !settings.open) {
    const ax = gp.axes[0]; if (Math.abs(ax) > 0.12) input.steer = ax;
    if (gp.buttons[7]?.value > 0.05) input.throttle = gp.buttons[7].value;
    if (gp.buttons[6]?.value > 0.05) input.brake = gp.buttons[6].value;
    if (gp.buttons[0]?.pressed) input.handbrake = true;
    if (gp.buttons[1]?.pressed) input.lean = true;
    if (!J.thr) J.thr = (gp.buttons[7]?.value > 0.05 ? gp.buttons[7].value : 0) - (gp.buttons[6]?.value > 0.05 ? gp.buttons[6].value : 0);   // W/S win
    if (Math.abs(gp.axes[3] ?? 0) > 0.12) J.pitch = gp.axes[3];
    if (Math.abs(gp.axes[2] ?? 0) > 0.12) J.roll = gp.axes[2];
    if (Math.abs(ax) > 0.12) J.yaw = ax;
  }
}

// ---------------------------------------------------------------- camera
// Chase cam that follows the car's heading with a little lag, so drifts show the car sideways.
let camMode = 0;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), tmp = new THREE.Vector3(), fw = new THREE.Vector3();
let glideCam = 0;                       // 0 = driving camera, 1 = gliding camera (pulled back, follows the flight path)
let camYaw = null, camPitch = 0, camY = null, shakeT = 0, shake = 0;
const jUp = new THREE.Vector3(), jDir = new THREE.Vector3();
const jLastPos = new THREE.Vector3(), jMove = new THREE.Vector3();
let jFollowing = false;
// jet: chase camera behind the flight path that rolls part way with the wings; cockpit view on C
function updateJetCamera(dt) {
  const v = vehicles.current, rp = v.renderPos;
  fw.set(0, 0, 1).applyQuaternion(v.renderQuat); jUp.set(0, 1, 0).applyQuaternion(v.renderQuat);
  const sp = v.vel.length();
  if (sp > 30 && v.mode === 'air') jDir.copy(v.vel).divideScalar(sp).lerp(fw, 0.45).normalize(); else jDir.copy(fw);
  shake = Math.max(shake * Math.exp(-dt * 6), v.hit * 0.02, v.landing * 0.4); v.landing *= Math.exp(-dt * 8); shakeT += dt * 31;
  const roll = v.mode === 'air' ? 0.6 : 0.2;
  const upB = tmp.set(0, 1, 0).lerp(jUp, roll).normalize();
  if (camMode === 2) {
    camera.position.copy(rp).addScaledVector(jUp, 1.05).addScaledVector(fw, 2.9);
    camLook.copy(camera.position).add(fw.clone().multiplyScalar(50));
    camera.up.copy(jUp);
  } else {
    const dist = camMode === 1 ? 46 : 19 + Math.min(sp, 300) * 0.012, high = camMode === 1 ? 12 : 4.6;
    const target = fw.clone().copy(rp).addScaledVector(jDir, -dist).addScaledVector(upB, high);
    // Carry the camera with the rendered jet before easing changes in the viewing offset.
    // Smoothing absolute positions made the jet outrun the camera, triggering repeated snaps.
    jMove.subVectors(rp, jLastPos);
    if (!jFollowing || jMove.lengthSq() > 10000) camPos.copy(target);
    else camPos.add(jMove).lerp(target, 1 - Math.exp(-dt * (v.mode === 'air' ? 9 : 14)));
    const gh = world.heightAt(camPos.x, camPos.z) + 1.2; if (camPos.y < gh) camPos.y = gh;
    camera.position.copy(camPos);
    camera.position.x += Math.sin(shakeT * 1.3) * shake; camera.position.y += Math.sin(shakeT * 1.7 + 1) * shake;
    camLook.copy(rp).addScaledVector(jDir, 25).addScaledVector(upB, 2);
    camera.up.copy(upB);
  }
  jLastPos.copy(rp); jFollowing = camMode !== 2;
  camera.lookAt(camLook);
  camYaw = Math.atan2(fw.x, fw.z); camY = rp.y; camPitch = 0;
  const fov = 68 + Math.min(sp * 3.6, 1500) * 0.012;
  camera.fov += (fov - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix();
}
function updateCamera(dt) {
  if (vehicles.current.cam?.jet) { updateJetCamera(dt); return; }
  jFollowing = false;
  const vc = vehicles.current.cam || {};
  fw.set(0, 0, 1).applyQuaternion(car.renderQuat);
  const sp = car.vel.length();
  const gl = car.glide?.active, hs = Math.hypot(car.vel.x, car.vel.z);
  glideCam += ((gl ? 1 : 0) - glideCam) * Math.min(1, dt * 1.5);
  const yaw = gl && hs > 4 ? Math.atan2(car.vel.x, car.vel.z) : Math.atan2(fw.x, fw.z);
  if (camYaw === null) camYaw = yaw;
  let d = yaw - camYaw; d = Math.atan2(Math.sin(d), Math.cos(d));
  camYaw += d * Math.min(1, dt * (car.drifting ? 3.5 : gl ? 4 : 11));
  // follow the hill's overall slope (sampled 8 m ahead and behind), not the car's bounce over each ground
  // triangle – copying every little pitch and bob is what made the view shake at speed
  const rp = car.renderPos, hx = Math.sin(camYaw), hz = Math.cos(camYaw);
  const slope = Math.atan2(world.terrainAt(rp.x + hx * 8, rp.z + hz * 8) - world.terrainAt(rp.x - hx * 8, rp.z - hz * 8), 16);
  const airborne = !car.grounded && car.airTime > 0.2;
  const pathPitch = Math.atan2(car.vel.y, hs + 1);                   // gliding: look along the glide path
  camPitch += ((gl ? pathPitch * 0.8 : airborne ? camPitch : slope * 0.6) - camPitch) * Math.min(1, dt * 3);
  if (camY === null) camY = rp.y;
  camY += (rp.y - camY) * Math.min(1, dt * (airborne ? 4 : 7));
  // shake: only impacts and hard landings
  shake = Math.max(shake * Math.exp(-dt * 6), car.hit * 0.025, car.landing * 0.35);
  car.landing *= Math.exp(-dt * 8);
  const amp = shake;
  shakeT += dt * 31;
  if (camMode === 2) {          // nose cam
    tmp.set(...(vc.nose || [0, 0.62, 0.9])).applyQuaternion(car.renderQuat).add(car.renderPos);
    camera.position.copy(tmp);
    camLook.copy(tmp).add(fw.multiplyScalar(10));
    camera.up.set(0, 1, 0).applyQuaternion(car.renderQuat);
  } else {
    let dist = camMode === 1 ? 12 : (vc.dist ?? 5.4) + Math.min(sp, 75) * (vc.distPerSpeed ?? 0.022), high = camMode === 1 ? 4.5 : (vc.high ?? 1.85);
    if (glideCam > 0.001) { dist += (13 + Math.min(sp, 60) * 0.05 - dist) * glideCam; high += (2.8 - high) * glideCam; }
    const cx = Math.sin(camYaw), cz = Math.cos(camYaw);
    tmp.set(car.renderPos.x - cx * dist, camY + high - Math.sin(camPitch) * dist, car.renderPos.z - cz * dist);
    camPos.lerp(tmp, 1 - Math.exp(-dt * 22));
    const gh = world.heightAt(camPos.x, camPos.z) + 0.9;
    if (camPos.y < gh) camPos.y = gh;
    camera.position.copy(camPos);
    camera.position.x += Math.sin(shakeT * 1.3) * amp; camera.position.y += Math.sin(shakeT * 1.7 + 1) * amp;
    camLook.set(car.renderPos.x + cx * 5, camY + 0.9 + Math.sin(camPitch) * 5, car.renderPos.z + cz * 5);
    camera.up.set(0, 1, 0);
  }
  camera.lookAt(camLook);
  if (glideCam > 0.001 && camMode !== 2) camera.rotateZ(-car.glide.bank * 0.3 * glideCam);   // lean into the bank a little
  if (vc.roll && camMode !== 2 && !(glideCam > 0.001)) camera.rotateZ(-car.lean * vc.roll);   // bike: the view leans a little with it
  const fov = 66 + Math.min(sp * 3.6, 280) * 0.085 + (car.lonAcc > 4 ? 2 : 0);
  camera.fov += (fov - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- loop
const STEP = 1 / 120;
let acc = 0, last = performance.now(), fps = 60, frames = 0, fpsT = 0;
const speedEl = document.getElementById('speed'), infoEl = document.getElementById('info');
const vmsgEl = Object.assign(document.createElement('div'), { id: 'veh-msg' }); document.getElementById('hud').append(vmsgEl);
// bike / jet read-out (throttle, height, warnings…) sits above the speed, clear of the help text bottom-right
const vlineEl = Object.assign(document.createElement('div'), { id: 'veh-line' });
vlineEl.style.cssText = 'font-size:14px;font-weight:700;margin-bottom:4px;font-variant-numeric:tabular-nums;';
speedEl.before(vlineEl);
// Debug readout (F8, or open the game with ?debug): what this browser actually sends the game, so a player can
// screenshot it when a control doesn't work on their machine.
const BUILD = '2026-11-13 input fix';
const dbgEl = Object.assign(document.createElement('pre'), { id: 'debug-readout' });
dbgEl.style.cssText = 'position:fixed;left:8px;top:64px;z-index:50;margin:0;padding:8px 10px;max-width:min(560px,calc(100vw - 16px));' +
  'background:rgba(0,0,0,.72);color:#e8f0e8;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;border-radius:6px;pointer-events:none;';
dbgEl.hidden = !/[?&]debug\b/.test(location.search);
document.body.append(dbgEl);
addEventListener('keydown', e => { if (e.code === 'F8' && !e.repeat) { dbgEl.hidden = !dbgEl.hidden; e.preventDefault(); } });
let dbgT = 0;
function updateDebug(dt) {
  if (dbgEl.hidden || (dbgT -= dt) > 0) return;
  dbgT = 0.2;
  const v = vehicles.current, J = input.jet, f2 = x => (+x).toFixed(2);
  const held = [...keys].map(c => letters.has(c) && letters.get(c) !== c ? `${c}→${letters.get(c).slice(3)}` : c).join(' ') || '(none)';
  const pads = [...(navigator.getGamepads?.() || [])].filter(Boolean).map(gp => {
    const st = gp.mapping !== 'standard' ? 'IGNORED (not standard layout)' : padRest.get(gp.index) === 'live' ? 'in use' : 'waiting to be touched';
    const ax = gp.axes.map((a, i) => Math.abs(a) > 0.05 ? `a${i}=${f2(a)}` : '').filter(Boolean).join(' ');
    const bt = gp.buttons.map((b, i) => b.pressed || b.value > 0.05 ? `b${i}=${f2(b.value)}` : '').filter(Boolean).join(' ');
    return `  #${gp.index} ${gp.id.slice(0, 48)} [${gp.mapping || 'no mapping'}] ${st}\n     ${ax || 'axes at rest'} · ${bt || 'no buttons'}`;
  });
  let saved = ''; try { saved = localStorage.getItem('yr-tuning-jet-1') || '(none)'; } catch { saved = '(blocked)'; }
  dbgEl.textContent = [
    `DEBUG (F8 hides) · build ${BUILD}`,
    `${navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 110)}`,
    `page focused: ${document.hasFocus() ? 'yes' : 'NO – click the game'} · typing in: ${document.activeElement?.tagName || '-'} · fps ${Math.round(fps)}`,
    `menus: settings ${settings.open ? 'OPEN (game keys off)' : 'closed'} · vehicle ${vehicles.open ? 'open' : 'closed'} · map ${minimap.open ? 'open' : 'closed'}`,
    `keys held: ${held}`,
    `game input: throttle ${f2(input.throttle)} brake ${f2(input.brake)} steer ${f2(input.steer)} space ${input.handbrake ? 'on' : 'off'}`,
    `jet input: thr ${f2(J.thr)} pitch ${f2(J.pitch)} roll ${f2(J.roll)} yaw ${f2(J.yaw)}${J.hold ? ' · HELD (race start)' : ''}`,
    v.kind === 'jet' ? `jet: ${v.mode} · lever ${Math.round(v.throttle * 100)}% · thrust ${v.t.thrust} · lever rate ${v.t.throttleRate}/s` : `vehicle: ${v.kind}`,
    `saved jet settings: ${saved.slice(0, 120)}`,
    `gamepads: ${pads.length ? '\n' + pads.join('\n') : 'none'}`,
  ].join('\n');
}
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  readInput();
  challenges.holdInput(input);
  acc += dt;
  while (acc >= STEP) { car.savePrev(); car.step(STEP, input); challenges.constrain(); rim?.constrain(car); acc -= STEP; }
  challenges.update(dt);
  car.interpolate(acc / STEP);          // draw the car between physics steps so motion is smooth
  car.input = input;
  car.syncMesh(dt);
  glider.update(dt, vehicles.current === vehicles.car); bikeGlider.update(dt, vehicles.current === vehicles.bike);
  car.mesh.updateMatrixWorld(true);
  effects.update(dt, car);
  audio.update(car, input, dt);
  updateCamera(dt);
  world.updateLOD(camera.position, car.vel);
  world.updateShadows(car.renderPos);
  sun.position.copy(car.renderPos).addScaledVector(SUN_DIR, 160);   // shadow camera spans 60..260 m from the sun
  sun.target.position.copy(car.renderPos);
  pinGuide.update(dt);
  rimRing?.update(car.renderPos);
  renderer.render(scene, camera);
  minimap.update(car.renderPos.x, car.renderPos.z, Math.atan2(fw.set(0, 0, 1).applyQuaternion(car.renderQuat).x, -fw.z), car.vel.length(), dt);
  frames++; fpsT += dt;
  if (fpsT > 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
  const kmh = Math.round(car.vel.length() * 3.6);
  speedEl.innerHTML = `${kmh}<small>km/h</small>`;
  const v = vehicles.current;
  const info = `${v.kind === 'car' ? 'Car' : v.name}${car.drifting ? ' · DRIFT' : ''}`;
  if (info !== infoEl._last) { infoEl.innerHTML = info; infoEl._last = info; }
  const vline = v.hudInfo ? v.hudInfo().replace(/ · $/, '') : '';
  if (vline !== vlineEl._last) { vlineEl.innerHTML = vline; vlineEl._last = vline; }
  v.msgT = (v.msgT || 0) - dt;
  const msg = v.msgT > 0 && v.kind !== 'car' ? v.msg : '';
  if (msg !== vmsgEl._last) { vmsgEl.textContent = msg; vmsgEl._last = msg; }
  updateDebug(dt);
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
// for debugging / automated test drives
window.game = { scene, sun, effects, setCam: m => { camMode = m; }, teleport: (x, z, cls = 2) => { car.reset(...world.placeOn(x, z, cls)); car.safe = []; }, car, world, input, keys, tuning, camera, renderer, minimap, challenges, pinGuide };
window.game.glider = glider; window.game.bikeGlider = bikeGlider;
window.game.vehicles = vehicles;
// Every fresh load starts in the car; V still switches vehicles during play.
