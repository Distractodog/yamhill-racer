import * as THREE from 'three';
import GUI from 'lil-gui';
import { loadWorld, SURFACES } from './world.js';
import { Car, TUNING_DEFAULTS } from './car.js';
import { Effects } from './effects.js';
import { CarAudio } from './audio.js';
import { createMinimap } from './minimap.js';
import { createChallenges } from './challenges.js';

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
try { Object.assign(tuning, JSON.parse(localStorage.getItem('yr-tuning-2') || '{}')); } catch {}
// a browser that saved an old default gets the new one (keeps anything Ethan changed himself)
const OLD_DEFAULTS = { topSpeed: [270, 600], accel: [17], brakeDecel: [32] };
for (const k in OLD_DEFAULTS) if (OLD_DEFAULTS[k].includes(tuning[k])) tuning[k] = TUNING_DEFAULTS[k];
const save = () => { try { localStorage.setItem('yr-tuning-2', JSON.stringify(tuning)); } catch {} };

const loadingEl = document.getElementById('loading');
const world = await loadWorld(renderer, (n, of) => { loadingEl.textContent = `Loading map… ${n}/${of}`; });
scene.add(world.group);
const car = new Car(world, tuning);
scene.add(car.mesh);
const [sx, sz] = world.spawn;
// campus drives are mostly gravel service roads in OpenStreetMap; take asphalt if it is close, else gravel
let spawn = world.placeOn(sx, sz, 3, 80);
if (world.surfaceAt(spawn[0], spawn[1]) !== 3) spawn = world.placeOn(sx, sz, 4, 150);
car.reset(...spawn);
const effects = new Effects(scene);
const audio = new CarAudio();
const minimap = await createMinimap();
const challenges = await createChallenges({ scene, world, car, minimap });
document.getElementById('loading').remove();

const gui = new GUI({ title: 'Car tuning (T)' });
const RANGES = {
  accel: [5, 60, 0.5], topSpeed: [100, 1500, 10], brakeDecel: [10, 100, 1],
  steerLock: [0.2, 0.9, 0.01], steerRate: [2, 20, 0.5], cornerGrip: [10, 60, 0.5], turnResponse: [3, 30, 0.5],
  gripAlign: [2, 30, 0.5], driftAlign: [0.3, 5, 0.05], driftTurn: [0.3, 2.5, 0.05], driftMaxAngle: [15, 80, 1],
  driftSpeedLoss: [0, 1, 0.01], driftBoost: [0, 15, 0.5],
  springK: [20000, 150000, 500], damping: [1000, 15000, 100], restLength: [0.2, 0.9, 0.01], snap: [0, 200, 1],
  downforce: [0, 0.02, 0.0005], gravity: [9.8, 40, 0.2], airControl: [0, 8, 0.1], airStabilize: [0, 8, 0.1],
};
for (const k in RANGES) gui.add(tuning, k, ...RANGES[k]).onChange(save);
gui.add({ reset: () => { Object.assign(tuning, TUNING_DEFAULTS); save(); gui.controllersRecursive().forEach(c => c.updateDisplay()); } }, 'reset').name('Reset to defaults');
gui.add({ copy: () => navigator.clipboard?.writeText(JSON.stringify(tuning, null, 1)) }, 'copy').name('Copy settings');
gui.close();

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
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quat);
  if (Math.hypot(f.x, f.z) < 0.2) f.set(0, 1, 0).applyQuaternion(car.quat).negate();   // nose straight up/down: use the roof
  car.reset(car.pos.x, car.pos.z, Math.atan2(f.x, f.z));
}

// ---------------------------------------------------------------- input
const keys = new Set();
addEventListener('keydown', e => {
  keys.add(e.code);
  audio.start();
  if (e.code === 'KeyR') car.resetToSafe();
  if (e.code === 'KeyF') flipUpright();
  if (e.code === 'KeyH') goHome();
  if (e.code === 'KeyT') gui._closed ? gui.open() : gui.close();
  if (e.code === 'KeyC') camMode = (camMode + 1) % 3;
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
function readInput() {
  const k = c => keys.has(c);
  input.throttle = (k('KeyW') || k('ArrowUp')) ? 1 : 0;
  input.brake = (k('KeyS') || k('ArrowDown')) ? 1 : 0;
  input.steer = ((k('KeyD') || k('ArrowRight')) ? 1 : 0) - ((k('KeyA') || k('ArrowLeft')) ? 1 : 0);
  input.handbrake = k('Space');
  const gp = navigator.getGamepads?.()[0];
  if (gp) {
    const ax = gp.axes[0]; if (Math.abs(ax) > 0.12) input.steer = ax;
    if (gp.buttons[7]?.value > 0.05) input.throttle = gp.buttons[7].value;
    if (gp.buttons[6]?.value > 0.05) input.brake = gp.buttons[6].value;
    if (gp.buttons[0]?.pressed) input.handbrake = true;
  }
}

// ---------------------------------------------------------------- camera
// Chase cam that follows the car's heading with a little lag, so drifts show the car sideways.
let camMode = 0;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), tmp = new THREE.Vector3(), fw = new THREE.Vector3();
let camYaw = null, camPitch = 0, camY = null, shakeT = 0, shake = 0;
function updateCamera(dt) {
  fw.set(0, 0, 1).applyQuaternion(car.renderQuat);
  const sp = car.vel.length();
  const yaw = Math.atan2(fw.x, fw.z);
  if (camYaw === null) camYaw = yaw;
  let d = yaw - camYaw; d = Math.atan2(Math.sin(d), Math.cos(d));
  camYaw += d * Math.min(1, dt * (car.drifting ? 3.5 : 11));
  // follow the hill's overall slope (sampled 8 m ahead and behind), not the car's bounce over each ground
  // triangle – copying every little pitch and bob is what made the view shake at speed
  const rp = car.renderPos, hx = Math.sin(camYaw), hz = Math.cos(camYaw);
  const slope = Math.atan2(world.terrainAt(rp.x + hx * 8, rp.z + hz * 8) - world.terrainAt(rp.x - hx * 8, rp.z - hz * 8), 16);
  const airborne = !car.grounded && car.airTime > 0.2;
  camPitch += ((airborne ? camPitch : slope * 0.6) - camPitch) * Math.min(1, dt * 3);
  if (camY === null) camY = rp.y;
  camY += (rp.y - camY) * Math.min(1, dt * (airborne ? 4 : 7));
  // shake: only impacts and hard landings
  shake = Math.max(shake * Math.exp(-dt * 6), car.hit * 0.025, car.landing * 0.35);
  car.landing *= Math.exp(-dt * 8);
  const amp = shake;
  shakeT += dt * 31;
  if (camMode === 2) {          // nose cam
    tmp.set(0, 0.62, 0.9).applyQuaternion(car.renderQuat).add(car.renderPos);
    camera.position.copy(tmp);
    camLook.copy(tmp).add(fw.multiplyScalar(10));
    camera.up.set(0, 1, 0).applyQuaternion(car.renderQuat);
  } else {
    const dist = camMode === 1 ? 12 : 5.4 + Math.min(sp, 75) * 0.022, high = camMode === 1 ? 4.5 : 1.85;
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
  const fov = 66 + Math.min(sp * 3.6, 280) * 0.085 + (car.lonAcc > 4 ? 2 : 0);
  camera.fov += (fov - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- loop
const STEP = 1 / 120;
let acc = 0, last = performance.now(), fps = 60, frames = 0, fpsT = 0;
const speedEl = document.getElementById('speed'), infoEl = document.getElementById('info');
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  readInput();
  challenges.holdInput(input);
  acc += dt;
  while (acc >= STEP) { car.savePrev(); car.step(STEP, input); challenges.constrain(); acc -= STEP; }
  challenges.update(dt);
  car.interpolate(acc / STEP);          // draw the car between physics steps so motion is smooth
  car.input = input;
  car.syncMesh(dt);
  car.mesh.updateMatrixWorld(true);
  effects.update(dt, car);
  audio.update(car, input, dt);
  updateCamera(dt);
  world.updateLOD(camera.position, car.vel);
  world.updateShadows(car.renderPos);
  sun.position.copy(car.renderPos).addScaledVector(SUN_DIR, 160);   // shadow camera spans 60..260 m from the sun
  sun.target.position.copy(car.renderPos);
  renderer.render(scene, camera);
  minimap.update(car.renderPos.x, car.renderPos.z, Math.atan2(fw.set(0, 0, 1).applyQuaternion(car.renderQuat).x, -fw.z), car.vel.length(), dt);
  frames++; fpsT += dt;
  if (fpsT > 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
  const kmh = Math.round(car.vel.length() * 3.6);
  speedEl.innerHTML = `${kmh}<small>km/h</small>`;
  infoEl.textContent = `${car.drifting ? 'DRIFT · ' : ''}${SURFACES[car.surface]} · ${Math.round(fps)} fps`;
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
// for debugging / automated test drives
window.game = { scene, sun, effects, setCam: m => { camMode = m; }, teleport: (x, z, cls = 2) => { car.reset(...world.placeOn(x, z, cls)); car.safe = []; }, car, world, input, keys, tuning, camera, renderer, minimap, challenges };
