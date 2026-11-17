// Other players in a multiplayer game: their vehicle in their own skin, their glider, a name tag, and a named dot on
// the corner and full maps. Drawing and collision prediction; physics responses live in collide.js.
// Everything comes through `mp` (net.js): roster / joined / left keep the list, 'state' (~15 Hz) moves them, 'skin'
// repaints them.
// Smoothing: states are kept in a short buffer on the relay clock and drawn DELAY ms in the past, between two states;
// when the next one is late the vehicle carries on along its last velocity for up to MAX_EXTRAP ms, then holds. A late
// state that lands somewhere else is blended in over a few frames (a jump of more than SNAP m just snaps).
// Animation: up close a remote is the same model as your own vehicle, moved by the same code: a stand-in "puppet" with
// the vehicle's read-outs (steer, wheel springs, lean, throttle…) filled from the state's extra fields (net.js
// animState, interpolated like the pose) and its tuning from the skin (net.js animTuning) is handed to Car / Bike / Jet syncMesh, Glider update, the tyre marks / dust /
// smoke / splashes of effects.js + drivingfx.js, and for the 4 nearest a quiet CarAudio engine. A state without those
// fields (an older client) is animated from its motion alone. The car / bike are drawn as the skin's type (Sports car,
// SUV, Sport bike…). Lights (lights.js) are glowing lenses only, on while it's dark where you are.
// Speed: each model's plain painted parts are merged per moving part (a car is 5 draw calls), built once per vehicle
// kind and only rebuilt when that player's colours change; far away a plain block stands in for it.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { paintedModel, sanitizeCosmetics } from '../cosmetics.js';
import { Glider, buildGliderModel, BIKE_GLIDER } from '../glider.js';
import { setGliderColors } from '../glidercolors.js';
import { Car, TUNING_DEFAULTS } from '../car.js';
import { Bike, BIKE } from '../bike.js';
import { Jet } from '../jet.js';
import { VEHICLE_TYPES, typeInfo } from '../vehicletypes.js';
import { createVehicleLightLenses } from '../lights.js';
import { Effects } from '../effects.js';
import { DrivingFX } from '../drivingfx.js';
import { CarAudio } from '../audio.js';
import { wheelArch } from '../wheeltravel.js';

export const DELAY = 120;            // ms behind the newest states we draw
export const MAX_EXTRAP = 300;       // ms we carry on past the newest state
export const SNAP = 50;              // m: a correction bigger than this snaps instead of blending
export const STALE = 3000;           // ms without a state → hidden
export const TAG_FADE = 300, TAG_HIDE = 400;     // m: name tag fades out, then hides
export const FAR = { car: 250, bike: 250, jet: 650 };   // m: past this a low-poly block stands in
export const FX_RANGE = 160;         // m: tyre marks, dust, smoke and splashes only this close
export const VOICES = 4, VOICE_RANGE = 180;      // engines heard: the 4 nearest, up to 180 m
const TAG_Y = { car: 1.5, bike: 2.0, jet: 3.6 }, GLIDER_TAG_Y = 1.1;
const KINDS = ['car', 'bike', 'jet'];
const SYNC = { car: Car.prototype.syncMesh, bike: Bike.prototype.syncMesh, jet: Jet.prototype.syncMesh };
const RADIUS = { car: 0.38, bike: 0.34, jet: 0.35 };     // rolling radius the physics spins the wheels with
const REST = { car: 0.09, bike: 0.1, jet: 0.2 };         // spring compression standing still (older clients)
const WB = { car: 2.78, bike: 1.45, jet: 4.4 };          // wheelbase, for a steer guessed from the turn
const fin = v => typeof v === 'number' && Number.isFinite(v);
const finArr = (a, n) => Array.isArray(a) && a.length === n && a.every(fin);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------------------------------------------------------------- smoothing maths (pure, tested in Node)
// The animation fields of a state (see net.js animState), range-checked, or null for an older client without them.
const ANIM_RANGE = { st: [-1, 1], th: [0, 1], br: [0, 1], sl: [-3, 3], la: [-300, 300], lo: [-300, 300], wd: [0, 5],
  ln: [-1.2, 1.2], pr: [-30, 30], gr: [0, 1] };
const ANIM_NUM = Object.keys(ANIM_RANGE);
const surfOf = x => Number.isInteger(x) && x >= 0 && x < 8 ? x : 0;
export function parseAnim(msg) {
  if (!Array.isArray(msg?.w) || !msg.w.length) return null;
  const a = { ab: msg.ab === 1, hb: !!msg.hb, dr: !!msg.dr, ow: !!msg.ow, wl: !!msg.wl, sf: surfOf(msg.sf),
    md: ['g', 'a', 'c'].includes(msg.md) ? msg.md : 'g', jc: [0, 0, 0] };
  for (const k of ANIM_NUM) a[k] = fin(msg[k]) ? clamp(msg[k], ...ANIM_RANGE[k]) : 0;
  a.w = msg.w.slice(0, 4).map(x => fin(x) && x >= 0 ? Math.min(x, 100) : -1);
  a.ws = a.w.map((_, i) => Array.isArray(msg.ws) ? surfOf(msg.ws[i]) : a.sf);
  if (Array.isArray(msg.jc)) for (let i = 0; i < 3; i++) a.jc[i] = fin(msg.jc[i]) ? clamp(msg.jc[i], -1, 1) : 0;
  return a;
}

// The tuning a remote's syncMesh reads (`t`) from its skin's tune (net.js animTuning), range-checked, else defaults
const TUNE_KEYS = { car: { rl: ['restLength', 0.2, 0.9], sl: ['steerLock', 0.2, 0.9] }, bike: { tr: ['travel', 0.1, 0.6] }, jet: {} };
export function parseTune(tune, kind) {
  const t = { restLength: TUNING_DEFAULTS.restLength, steerLock: kind === 'bike' ? BIKE.steerLock : TUNING_DEFAULTS.steerLock, travel: BIKE.travel };
  for (const [k, [name, lo, hi]] of Object.entries(TUNE_KEYS[kind] || {})) if (fin(tune?.[k])) t[name] = clamp(tune[k], lo, hi);
  return t;
}

// A buffered state: { t (relay ms), v, p:[x,y,z], q:Quaternion, vel:[x,y,z], glide, a (animation or null) }.
// Returns null for a bad message.
export function parseState(msg, t) {
  if (!msg || !finArr(msg.p, 3) || !finArr(msg.q, 4) || !fin(t)) return null;
  const q = new THREE.Quaternion(...msg.q); if (q.lengthSq() < 1e-6) return null;
  return { t, v: KINDS.includes(msg.v) ? msg.v : 'car', p: msg.p.slice(), q: q.normalize(),
    vel: finArr(msg.vel, 3) ? msg.vel.slice() : [0, 0, 0], glide: !!msg.glide, a: parseAnim(msg),
    grounded: msg.grounded === true, mode: msg.mode, ghostUntil: fin(msg.ghostUntil) ? msg.ghostUntil : 0 };
}

// Add a state in time order (a repeat of the newest time replaces it) and drop what's too old to be drawn again.
export function pushState(buf, s, renderT = -Infinity) {
  const last = buf[buf.length - 1];
  if (last && s.t < last.t) return false;            // out of order: older than what we have
  if (last && s.t === last.t) buf[buf.length - 1] = s; else buf.push(s);
  while (buf.length > 2 && (buf[1].t < renderT - 500 || buf.length > 30)) buf.shift();
  return true;
}

// Pose at relay time t from the buffer (oldest first) into outP (Vector3), outQ (Quaternion), outV (Vector3, optional).
// Returns 'none' (empty), 'early' (before the oldest), 'interp', 'extrap' (past the newest, ≤ MAX_EXTRAP) or 'hold'.
export function poseAt(buf, t, outP, outQ, outV) {
  const n = buf.length; if (!n) return 'none';
  const put = (s, dt = 0) => {
    outP.set(s.p[0] + s.vel[0] * dt, s.p[1] + s.vel[1] * dt, s.p[2] + s.vel[2] * dt); outQ.copy(s.q);
    outV?.set(...s.vel);
  };
  if (t <= buf[0].t) { put(buf[0]); return 'early'; }
  const b = buf[n - 1];
  if (t >= b.t) {
    const late = t - b.t; put(b, Math.min(late, MAX_EXTRAP) / 1000);
    return late <= MAX_EXTRAP ? 'extrap' : 'hold';
  }
  let i = n - 1; while (i > 0 && buf[i - 1].t > t) i--;
  const A = buf[i - 1], B = buf[i], u = (t - A.t) / (B.t - A.t);
  // a teleport (reset, respawn): don't slide across the map, jump when the newer state's time comes
  const gap = Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1], B.p[2] - A.p[2]);
  const fast = Math.max(Math.hypot(...A.vel), Math.hypot(...B.vel)) * (B.t - A.t) / 1000;
  if (gap > SNAP + 1.5 * fast) { put(A); return 'interp'; }
  outP.set(A.p[0] + (B.p[0] - A.p[0]) * u, A.p[1] + (B.p[1] - A.p[1]) * u, A.p[2] + (B.p[2] - A.p[2]) * u);
  outQ.slerpQuaternions(A.q, B.q, u);
  outV?.set(A.vel[0] + (B.vel[0] - A.vel[0]) * u, A.vel[1] + (B.vel[1] - A.vel[1]) * u, A.vel[2] + (B.vel[2] - A.vel[2]) * u);
  return 'interp';
}

// Animation fields at relay time t, interpolated between the same two states as the pose (numbers blend; flags, the
// surface and the jet's mode come from the nearer state; a wheel in the air doesn't sink halfway). Writes into `out`
// (keeps its arrays) and returns it, or null when neither state has them (an older client).
export function animAt(buf, t, out = { w: [], ws: [], jc: [0, 0, 0] }) {
  const n = buf.length; if (!n) return null;
  let A = buf[n - 1], B = A, u = 0;
  if (t <= buf[0].t) A = B = buf[0];
  else if (t < buf[n - 1].t) {
    let i = n - 1; while (i > 0 && buf[i - 1].t > t) i--;
    A = buf[i - 1]; B = buf[i]; u = (t - A.t) / (B.t - A.t);
  }
  let a = A.a, b = B.a;
  if (!a && !b) return null;
  if (!a || !b) { a = b = a || b; u = 0; }
  const near = u < 0.5 ? a : b;
  for (const k of ANIM_NUM) out[k] = a[k] + (b[k] - a[k]) * u;
  for (const k of ['ab', 'hb', 'dr', 'ow', 'wl', 'sf', 'md']) out[k] = near[k];
  out.w.length = out.ws.length = near.w.length;
  for (let i = 0; i < near.w.length; i++) {
    const x = a.w[i] ?? -1, y = b.w[i] ?? -1;
    out.w[i] = x < 0 || y < 0 ? (u < 0.5 ? x : y) : x + (y - x) * u;
    out.ws[i] = near.ws[i];
  }
  for (let i = 0; i < 3; i++) out.jc[i] = a.jc[i] + (b.jc[i] - a.jc[i]) * u;
  return out;
}

// A smoothed player: the buffer plus a correction offset that absorbs jumps when a state arrives after we already
// extrapolated past it. receive() and pose() are all the per-player maths; meshes are built elsewhere.
export class Track {
  constructor() {
    this.buf = []; this.off = new THREE.Vector3(); this.qOff = new THREE.Quaternion(); this.lastRecv = -Infinity;
    this._p = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._p2 = new THREE.Vector3(); this._q2 = new THREE.Quaternion();
  }
  receive(s, now) {
    const renderT = now - DELAY, had = this.buf.length > 0;
    if (had) poseAt(this.buf, renderT, this._p, this._q);
    if (!pushState(this.buf, s, renderT)) return false;
    this.lastRecv = now;
    if (!had) return true;
    poseAt(this.buf, renderT, this._p2, this._q2);
    // keep what is drawn where it was: off = (old pose + old offset) − new pose
    this.off.add(this._p).sub(this._p2);
    this.qOff.multiply(this._q2.invert().premultiply(this._q)).normalize();   // qOff ← qOff · qOld · qNew⁻¹
    if (this.off.length() > SNAP) { this.off.set(0, 0, 0); this.qOff.identity(); }
    return true;
  }
  // pose at local frame time `now` (relay clock); dt eases the correction away. Returns poseAt's mode.
  pose(now, dt, outP, outQ, outV) {
    const mode = poseAt(this.buf, now - DELAY, outP, outQ, outV);
    const k = Math.exp(-dt * 6);
    this.off.multiplyScalar(k); if (this.off.lengthSq() < 1e-6) this.off.set(0, 0, 0);
    this.qOff.slerp(_qI, 1 - Math.exp(-dt * 8));
    outP.add(this.off); outQ.premultiply(this.qOff);
    return mode;
  }
  stale(now) { return !this.buf.length || now - this.lastRecv > STALE; }
  get latest() { return this.buf[this.buf.length - 1]; }
}
const _qI = new THREE.Quaternion();

// The remote's vehicle read-outs, the way its own vehicle class has them, from interpolated animation fields `a`
// (or, for an older client, guessed from the motion). r keeps what is integrated over frames (wheel spin, the
// measured turn); V = velocity, F = forward, U = up (world); `moving` = false while holding a late player in place.
export function animate(pz, a, r, V, F, dt, moving = true) {
  const kind = pz.kind, inp = pz.input, J = inp.jet, vf = moving ? V.dot(F) : 0, speed = moving ? V.length() : 0;
  if (a) {
    pz.steer = a.st; inp.throttle = a.th; inp.brake = a.br; inp.handbrake = a.hb;
    pz.drifting = a.dr; pz.slip = a.sl; pz.latAcc = a.la; pz.lonAcc = a.lo;
    pz.surface = a.sf; pz.onWater = a.ow; pz.waterDepth = a.wd;
    pz.wheels.forEach((wh, i) => { const c = a.w[i] ?? -1; wh.contact = c >= 0; wh.comp = Math.max(0, c) / 100; wh.surf = a.ws[i] ?? a.sf; });
    pz.lean = a.ln; pz.pitchRate = a.pr; pz.wheelie = a.wl;
    pz.throttle = a.th; pz.gear = a.gr; pz.mode = a.md === 'a' ? 'air' : a.md === 'c' ? 'crashed' : 'ground';
    J.pitch = a.jc[0]; J.roll = a.jc[1]; J.yaw = a.jc[2]; J.thr = 0;
  } else {
    // an older client: steer from the turn (kinematic), body lean from the measured accelerations, wheels at rest
    const k = Math.min(1, dt * 8), lat = vf * r.yawRate;
    pz.steer += (clamp(Math.atan(-r.yawRate * WB[kind] / Math.max(Math.abs(vf), 3)) / pz.t.steerLock, -1, 1) - pz.steer) * k;
    pz.latAcc += (lat - pz.latAcc) * k;
    pz.lonAcc += ((dt > 0 ? clamp((vf - r.vf) / dt, -80, 80) : 0) - pz.lonAcc) * k;
    pz.wheels.forEach(wh => { wh.contact = true; wh.comp = REST[kind]; wh.surf = pz.surface; });
    inp.throttle = pz.lonAcc > 1 ? 1 : 0; inp.brake = pz.lonAcc < -8 ? 1 : 0;
    pz.lean += (clamp(-Math.atan(speed * r.yawRate / 17), -1, 1) - pz.lean) * k;   // lean = atan(v·ω / g)
    pz.throttle = speed < 3 ? 0 : clamp(speed / 250, 0.05, 1); pz.gear = speed < 85 ? 1 : 0; pz.mode = speed > 60 ? 'air' : 'ground';
  }
  if (kind === 'jet') {
    const brake = a?.ab && pz.mode !== 'crashed' ? 1 : 0;
    pz.speedBrake = (pz.speedBrake || 0) + clamp(brake - (pz.speedBrake || 0), -dt * 3, dt * 3);
  }
  r.vf = vf;
  if (!moving) { pz.latAcc = pz.lonAcc = 0; inp.throttle = 0; }
  pz.grounded = pz.wheels.some(w => w.contact);
  pz.airTime = pz.grounded ? 0 : pz.airTime + dt;
  pz.burning = pz.mode === 'crashed';
  // wheels roll with the speed over the ground (a locked rear on the handbrake; the jet's spin down in the air)
  const radius = pz.typePhysics?.radius ?? RADIUS[kind];
  for (const wh of pz.wheels) {
    if (kind === 'jet' && pz.mode !== 'ground') wh.spin *= 1 - Math.min(1, dt);
    else wh.spin += vf * dt / radius * (kind === 'car' && inp.handbrake && !wh.front ? 0 : 1);
  }
}

// ---------------------------------------------------------------- meshes
const BODY_MAT = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const SAIL_MAT = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
const SHARED = new Set([BODY_MAT, SAIL_MAT]);
const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _c = new THREE.Color();

const plain = o => o.isMesh && o.geometry && o.material?.isMeshLambertMaterial && !o.material.transparent && !o.material.map;
// a mesh's geometry as position / normal / colour (colour = material colour, or `color`, × any vertex colour), moved by matrix
function coloured(o, matrix, color = o.material.color) {
  const mat = o.material, g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(name)) g.deleteAttribute(name);
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count, col = new Float32Array(n * 3), src = mat.vertexColors ? g.attributes.color : null;
  _c.copy(color);
  for (let i = 0; i < n; i++) {
    col[i * 3] = _c.r * (src ? src.getX(i) : 1); col[i * 3 + 1] = _c.g * (src ? src.getY(i) : 1); col[i * 3 + 2] = _c.b * (src ? src.getZ(i) : 1);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.clearGroups(); g.applyMatrix4(matrix);
  return g;
}

// Bake the visible meshes under `start` into one vertex-coloured geometry in `root`'s frame. Plain Lambert parts are
// merged; textured / see-through parts (decals) come back as separate meshes in `extras` (Map original → copy)
// sharing their geometry and material. Used for the glider, which has no moving parts.
export function bake(root, { start = root, skip = new Set(), material = BODY_MAT } = {}) {
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const parts = [], extras = new Map(), used = new Set();
  const walk = o => {
    if (!o.visible || skip.has(o)) return;
    if (o.isMesh && o.geometry) {
      _m.multiplyMatrices(_inv, o.matrixWorld);
      if (plain(o)) { parts.push(coloured(o, _m)); used.add(o.geometry); used.add(o.material); }
      else {
        const copy = new THREE.Mesh(o.geometry, o.material);
        copy.matrixAutoUpdate = false; copy.matrix.copy(_m); copy.renderOrder = o.renderOrder; copy.castShadow = false;
        extras.set(o, copy);
      }
    }
    for (const c of o.children) walk(c);
  };
  walk(start);
  const geo = parts.length ? mergeGeometries(parts) : new THREE.BufferGeometry();
  parts.forEach(g => g.dispose());
  const mesh = new THREE.Mesh(geo, material); mesh.castShadow = true;
  for (const e of extras.values()) mesh.add(e);
  return { mesh, extras, used };
}

// Merge, in place, each group's plain painted meshes into one vertex-coloured mesh in that group's frame. Every group
// stays (wheel holders and spinners, body pivot, lean, bars, rider, control surfaces, gear legs), so the vehicle's own
// syncMesh moves the model exactly as it moves yours; decals and the jet flame stay as they are.
// keep: meshes left as they are (the jet's canopy, which its wreck look hides). recolor { mats, color }: a second set
// of vertex colours where the parts painted with those materials take that colour (the jet's blackened wreck), kept
// on the merged mesh as userData.colors { normal, alt } for setColors.
export function bakeParts(model, material = BODY_MAT, { keep = new Set(), recolor = null } = {}) {
  const groups = []; model.traverse(o => { if (!o.isMesh) groups.push(o); });
  for (const g of groups) {
    const merged = g.children.filter(o => plain(o) && o.visible && !o.children.length && !keep.has(o));
    if (!merged.length) continue;
    merged.forEach(o => o.updateMatrix());
    const parts = merged.map(o => coloured(o, o.matrix));
    const mesh = new THREE.Mesh(mergeGeometries(parts), material); mesh.castShadow = merged.some(o => o.castShadow);
    if (recolor && merged.some(o => recolor.mats.has(o.material))) {
      const normal = mesh.geometry.attributes.color.array.slice(), alt = normal.slice();
      let at = 0;
      merged.forEach((o, i) => {
        if (recolor.mats.has(o.material)) {
          const c = coloured(o, o.matrix, recolor.color); alt.set(c.attributes.color.array, at); c.dispose();
        }
        at += parts[i].attributes.color.array.length;
      });
      mesh.userData.colors = { normal, alt };
    }
    parts.forEach(p => p.dispose());
    for (const o of merged) { g.remove(o); o.geometry.dispose(); }
    g.add(mesh);
  }
  return model;
}
// switch every merged mesh with a second colour set (bakeParts recolor) to it, or back
export function setColors(model, alt) {
  model.traverse(o => {
    const c = o.userData.colors; if (!c) return;
    const a = o.geometry.attributes.color; a.array.set(alt ? c.alt : c.normal); a.needsUpdate = true;   // same buffer: nothing leaks on the GPU
  });
}
// the jet's wreck look on a merged copy: its own wreck() (shape, bent controls, canopy gone) + the blackened paint
function wreckLook(model, on) { model.userData.wreck(on); setColors(model, on); }
// free a model's geometries, materials and textures (not the shared materials, nor what `keep` still uses)
function disposeTree(root, keep = new Set()) {
  root.removeFromParent();
  root.traverse(o => {
    if (o.geometry && !keep.has(o.geometry)) o.geometry.dispose();
    if (o.material && !SHARED.has(o.material) && !keep.has(o.material)) { o.material.map?.dispose(); o.material.dispose(); }
  });
}

// The stand-in for one remote vehicle: the read-outs its vehicle class's syncMesh (and effects / audio) use
function makePuppet(kind, model, tune) {
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
  return { kind, mesh: model, t: tune, pos, quat, renderPos: pos, renderQuat: quat, vel: new THREE.Vector3(),
    wheels: model.userData.wheels.map(g => ({ front: g.front, comp: REST[kind], contact: true, surf: 0, contactPoint: new THREE.Vector3(), spin: 0 })),
    steer: 0, latAcc: 0, lonAcc: 0, slip: 0, drifting: false, surface: 0, grounded: true, airTime: 0, onWater: false, waterDepth: 0,
    hit: 0, landing: 0, lean: 0, pitchRate: 0, wheelie: false, throttle: 0, gear: 1, mode: 'ground', burning: false,
    glide: { active: false }, input: { throttle: 0, brake: 0, handbrake: false, jet: { thr: 0, pitch: 0, roll: 0, yaw: 0 } } };
}

// One player's vehicle of one kind (and type: Sports car, Sport bike…), painted, merged per part, with its puppet and
// its lights as glowing lenses (lights.js; no light sources); the glider comes later if needed
function buildBody(kind, colors, tune, type = null) {
  const model = paintedModel(kind, colors, type), ud = model.userData;
  // Resolve fallback arches before batching replaces the source geometry. SYNC applies the same
  // visual soft stop as the local vehicle, including older clients' standing-spring fallback.
  if (kind === 'car' || kind === 'bike') ud.wheels.forEach((_, i) => wheelArch(model, i));
  bakeParts(model, BODY_MAT, kind === 'jet' ? { keep: new Set([ud.canopy]), recolor: { mats: new Set(ud.wreckMats), color: new THREE.Color(ud.wreckColor) } } : {});
  model.visible = false;
  if (kind === 'jet') ud.setGear(1);
  const pz = makePuppet(kind, model, tune);
  pz.type = typeInfo(kind, type)?.id || type;
  pz.typePhysics = type ? typeInfo(kind, type)?.physics || null : null;      // Car syncMesh: wheel radius, body lean
  const lenses = createVehicleLightLenses(model, kind);                        // after the merge: lenses stay their own
  return { kind, type, model, pz, lenses, anim: { w: [], ws: [], jc: [0, 0, 0] }, wreck: false, gp: null };
}
function disposeBody(b) { b.lenses.dispose(); disposeTree(b.model); }

function buildGlider(kind, palette) {
  const model = buildGliderModel(kind === 'bike' ? BIKE_GLIDER.model : undefined);
  setGliderColors(model, palette);
  const b = bake(model, { material: SAIL_MAT });
  disposeTree(model, new Set([...b.extras.values()].flatMap(e => [e.geometry, e.material])));
  return b.mesh;
}
// skin.glider may be one palette ({wing, stripe, accent}) or one per vehicle ({car:{…}, bike:{…}})
const gliderPalette = (glider, kind) => glider && typeof glider === 'object' ? (glider.wing ? glider : glider[kind] || {}) : {};

// far stand-ins: one shared block per kind, coloured per player
let standGeo = null;
function standGeometry(kind) {
  if (!standGeo) {
    const box = (w, h, d, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    standGeo = {
      car: mergeGeometries([box(1.9, 0.45, 4.3, 0, -0.05, 0), box(0.6, 0.45, 1.2, 0, 0.35, -0.3), box(1.6, 0.1, 0.5, 0, 0.8, -2.0)]),
      bike: mergeGeometries([box(0.35, 0.9, 1.9, 0, -0.1, 0), box(0.4, 0.8, 0.4, 0, 0.75, -0.15)]),
      jet: mergeGeometries([box(1.4, 1.4, 14, 0, 0, 0.3), box(9.6, 0.15, 2.8, 0, 0, -1.2), box(4.8, 0.12, 1.4, 0, 0.1, -5.3), box(0.15, 2.4, 1.6, 0, 1.6, -4.9)]),
    };
  }
  return standGeo[kind];
}

function tagTexture(name, color, host) {
  if (typeof document === 'undefined') return { map: null, aspect: 4 };
  const c = document.createElement('canvas'), ctx = c.getContext('2d'), px = 44, font = `700 ${px}px system-ui, sans-serif`;
  ctx.font = font;
  const label = (host ? '★ ' : '') + name, w = Math.ceil(Math.min(ctx.measureText(label).width, 560)) + 60, h = 64;
  c.width = w; c.height = h;
  ctx.fillStyle = 'rgba(12,20,16,.78)'; ctx.beginPath(); ctx.roundRect(2, 2, w - 4, h - 4, 14); ctx.fill();
  ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(10, 14, 12, h - 28, 5); ctx.fill();
  ctx.font = font; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText(label, 34, h / 2 + 2, w - 44);
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  return { map, aspect: w / h };
}

// ---------------------------------------------------------------- engines
// Which remotes get one of the `n` engine voices: the nearest within `range` ({ id, dist } list → ids, nearest first)
export function pickVoices(cands, n = VOICES, range = VOICE_RANGE) {
  return cands.filter(c => c.dist < range).sort((a, b) => a.dist - b.dist).slice(0, n).map(c => c.id);
}
// how loud another player's engine is at `dist` m (yours plays at 1): quiet, ~1/distance, gone at VOICE_RANGE
export function voiceLevel(dist) {
  return 0.4 * Math.min(1, 10 / Math.max(dist, 1)) * clamp((VOICE_RANGE - dist) / (VOICE_RANGE * 0.25), 0, 1);
}

// swap one remote's own effect state into a shared effects object, run its drive, and keep what changed
function driveWith(fx, state, dt, car, ...args) {
  const keep = {};
  for (const k in state) { keep[k] = fx[k]; fx[k] = state[k]; }
  fx.drive(dt, car, ...args);
  for (const k in state) { state[k] = fx[k]; fx[k] = keep[k]; }
}

// ---------------------------------------------------------------- the remotes
let live = null;                       // the remotes in play, for predictedState
// Async because it loads net.js itself (so main.js needs no second import of it); tests pass a stub `mp`.
export async function createRemotes(opts = {}) {
  let mp = opts.mp;
  if (!mp) try { ({ mp } = await import('./net.js')); } catch (e) { console.warn('Multiplayer remotes: net.js not loaded', e); }
  return makeRemotes({ ...opts, mp });
}

// Where player `id` is predicted to be at relay time atMs (between / past its last states, as drawn, without the
// visual correction): { p:[x,y,z], q:[x,y,z,w], vel:[x,y,z], v, glide, airborne }, or null (unknown or stale).
// Also carries what collide.js reads: grounded, mode, ghostUntil. `players` (optional Map id → { track }) lets tests
// predict from their own tracks, judged stale against atMs.
export function predictedState(id, atMs, players = null) {
  if (players) return predictFrom(players.get(id), atMs, atMs);
  return live ? live.predictedState(id, atMs) : null;
}
function predictFrom(r, atMs, nowMs) {
  if (!r || !fin(atMs) || r.track.stale(nowMs)) return null;
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = r.track.latest, a = s.a;
  if (atMs - s.t > MAX_EXTRAP) return null;        // too stale to be an obstacle
  poseAt(r.track.buf, atMs, p, q, v);
  const airborne = s.glide || (a ? (s.v === 'jet' ? a.md !== 'g' : a.w.every(c => c < 0)) : false);
  return { p: p.toArray(), q: q.toArray(), vel: v.toArray(), v: s.v, glide: s.glide, airborne,
    grounded: s.grounded, mode: s.mode, ghostUntil: s.ghostUntil };
}

// world (optional): ground heights for the tyre marks; audio (optional): your CarAudio, whose context the other
// players' engines share once it has started; fx: false = no effects (or { effects, driving } to use given ones);
// night: () => 0..1, how dark it is here (atmosphere.night): other players' lights glow when it's above 0
export function makeRemotes({ scene, camera, minimap, mp = null, world = null, audio = null, fx: fxOpt, night = () => 0 } = {}) {
  const group = new THREE.Group(); group.name = 'mp-remotes'; scene?.add(group);
  const players = new Map();             // id → remote
  const now = () => (mp?.now ? mp.now() : performance.now());
  const myId = () => mp?.me?.id;
  // ms = smoothed per-frame cost without one-off model builds (buildMs = total time spent building models)
  const stats = { count: 0, visible: 0, near: 0, fx: 0, voices: 0, ms: 0, buildMs: 0 };
  let building = 0, clock = 0;
  const timed = fn => { const a = performance.now(), v = fn(); building += performance.now() - a; return v; };
  const P = new THREE.Vector3(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), F = new THREE.Vector3(), U = new THREE.Vector3(),
    W = new THREE.Vector3(), R = new THREE.Vector3();

  // shared tyre marks / dust / smoke / splashes for every remote, made when the first one comes near
  let fx = fxOpt === false ? null : fxOpt || undefined, fxIdle = Infinity;
  const fxReady = () => {
    if (fx === undefined) fx = scene ? { effects: new Effects(scene, { shadows: false }), driving: new DrivingFX(scene) } : null;
    return fx;
  };
  // engine voices: { voice: CarAudio, gain, pan, owner: remote | null, idle }
  const slots = [];

  function colorsFor(r, kind) { return r.colors[kind] || null; }
  function bodyColor(r, kind) { return sanitizeCosmetics(colorsFor(r, kind), kind).body; }
  function applySkin(r, skin) {
    if (!skin || typeof skin !== 'object') return;
    const kind = KINDS.includes(skin.vehicle) ? skin.vehicle : ['jetski', 'boat'].includes(skin.vehicle) ? 'car' : null;
    // tuning (spring length, steering lock, travel) only retunes the puppet; paint rebuilds the model
    if (kind) { r.tune[kind] = parseTune(skin.tune, kind); if (r.bodies[kind]) r.bodies[kind].pz.t = r.tune[kind]; }
    // the type (car: race / sports / hatch / suv / truck, bike: dirt / sport), checked against vehicletypes.js
    const type = kind && VEHICLE_TYPES[kind] ? typeInfo(kind, skin.type).id : null;
    const sig = JSON.stringify([skin.colors, skin.glider, type]);
    if (kind && sig !== r.skinSig[kind]) {
      r.skinSig[kind] = sig; r.colors[kind] = skin.colors || null; r.glider[kind] = gliderPalette(skin.glider, kind); r.type[kind] = type;
      if (r.bodies[kind]) { disposeBody(r.bodies[kind]); r.bodies[kind] = null; }
      if (kind === r.kind) r.standMat.color.set(bodyColor(r, kind));
      r.tagSig = '';
    }
  }
  function add(id, info = {}) {
    let r = players.get(id);
    if (!r) {
      const root = new THREE.Group(); root.name = 'mp-remote'; root.visible = false;
      const stand = new THREE.Mesh(standGeometry('car'), new THREE.MeshLambertMaterial({ color: 0xe8402f, flatShading: true }));
      stand.visible = false; root.add(stand);
      const tag = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true, fog: false, sizeAttenuation: false }));
      tag.renderOrder = 20; tag.visible = false; tag.center.set(0.5, 0);
      group.add(root, tag);
      r = { id, name: 'Racer', host: false, track: new Track(), root, stand, standMat: stand.material, tag, tagSig: '', tagAspect: 4,
        kind: null, bodies: Object.fromEntries(KINDS.map(k => [k, null])), colors: {}, glider: {}, skinSig: {}, tune: {}, type: {},
        far: false, heading: null, yawRate: 0, vf: 0, dist: Infinity, shown: false, x: 0, z: 0,
        fxState: { e: Effects.vehicleState(), d: DrivingFX.vehicleState() } };
      players.set(id, r);
    }
    if (typeof info.name === 'string' && info.name) r.name = info.name.slice(0, 24);
    if ('host' in info) r.host = !!info.host;
    applySkin(r, info.skin);
    return r;
  }
  function remove(id) {
    const r = players.get(id); if (!r) return;
    for (const k of KINDS) if (r.bodies[k]) disposeBody(r.bodies[k]);
    r.standMat.dispose(); r.tag.material.map?.dispose(); r.tag.material.dispose();
    r.root.removeFromParent(); r.tag.removeFromParent();
    for (const s of slots) if (s.owner === r) s.owner = null;
    players.delete(id);
  }
  const clear = () => { for (const id of [...players.keys()]) remove(id); };
  function roster(list) {
    const seen = new Set();
    for (const p of list || []) { if (!p?.id || p.id === myId()) continue; seen.add(p.id); add(p.id, p); }
    for (const id of [...players.keys()]) if (!seen.has(id)) remove(id);
  }
  const rosterList = msg => Array.isArray(msg?.players) ? msg.players : mp?.players ? [...mp.players.values()] : [];

  // every relay message we care about; also the test / debug entry point
  function receive(msg) {
    if (!msg || typeof msg !== 'object') return;
    const t = msg.t;
    if (t === 'roster') roster(rosterList(msg));
    else if (t === 'joined') { if (msg.player?.id && msg.player.id !== myId()) add(msg.player.id, msg.player); }
    else if (t === 'left') remove(msg.id);
    else if (t === 'skin') { if (msg.from && msg.from !== myId()) add(msg.from, { skin: msg.skin }); }
    else if (t === 'state') {
      if (!msg.from || msg.from === myId()) return;
      const n = now();
      // the relay's clock when it forwarded this; if our clock isn't synced yet, use when it arrived
      const st = fin(msg.srvT) && Math.abs(msg.srvT - n) < 2000 ? msg.srvT : n;
      const s = parseState(msg, st); if (!s) return;
      const r = players.get(msg.from) || add(msg.from, mp?.players?.get?.(msg.from) || {});
      r.track.receive(s, n);
    } else if (t === 'disconnected' || t === 'closed' || t === 'kicked') clear();
  }
  const TYPES = ['roster', 'joined', 'left', 'skin', 'state', 'disconnected', 'closed', 'kicked'];
  const handlers = TYPES.map(type => [type, msg => receive(type === 'roster' ? { t: 'roster', players: rosterList(msg) } : { ...msg, t: type })]);
  if (mp?.on) for (const [type, fn] of handlers) mp.on(type, fn);
  if (mp?.players?.size) roster([...mp.players.values()]);

  function switchKind(r, kind) {
    for (const k of KINDS) if (r.bodies[k]) r.bodies[k].model.visible = false;
    r.stand.geometry = standGeometry(kind); r.standMat.color.set(bodyColor(r, kind));
    r.kind = kind; r.tagSig = ''; r.heading = null; r.yawRate = 0;
    r.fxState = { e: Effects.vehicleState(), d: DrivingFX.vehicleState() };
  }
  // the full model is built the first time this player comes near in this vehicle, then kept
  function ensureBody(r, kind) {
    if (!r.bodies[kind]) { r.bodies[kind] = timed(() => buildBody(kind, colorsFor(r, kind), r.tune[kind] || parseTune(null, kind), r.type[kind] || null)); group.add(r.bodies[kind].model); }
    return r.bodies[kind];
  }
  // the glider rides on the vehicle's model like yours does (glider.js), and opens / folds through Glider.update
  function ensureGlider(r, b) {
    if (!b.gp) {
      const mesh = timed(() => buildGlider(b.kind, r.glider[b.kind] || {})); mesh.visible = false; b.model.add(mesh);
      b.gp = { active: false, open: 0, msgT: 0, mesh };
    }
    return b.gp;
  }

  // one near remote, moved by its vehicle's own code; returns whether it drove the effects
  function animateBody(r, b, s, mode, dt) {
    const pz = b.pz, kind = b.kind, moving = mode !== 'hold' && mode !== 'early';
    pz.renderPos.copy(P); pz.renderQuat.copy(Q); pz.vel.copy(moving ? V : W.set(0, 0, 0));
    pz.world = world;                                           // syncMesh keeps the drawn body above this ground
    animate(pz, animAt(r.track.buf, now() - DELAY, b.anim), r, V, F, dt, moving);
    (pz.mesh.userData.syncMesh || SYNC[kind]).call(pz, dt);     // a type with its own animation (helicopter rotors)
    if (kind === 'jet') {
      const wreck = pz.mode === 'crashed';
      if (wreck !== b.wreck) { b.wreck = wreck; wreckLook(pz.mesh, wreck); }
    } else {
      pz.glide.active = s.glide;
      if (s.glide || b.gp) { const gp = ensureGlider(r, b); gp.active = s.glide; Glider.prototype.update.call(gp, dt, false); }
    }
    // lights: on when it's dark here; brake lights from their brake / handbrake; the jet's strobe on the shared clock
    const dark = night() || 0;
    const braking = kind !== 'jet' && s.grounded && !s.glide
      ? Math.max(pz.input.brake || 0, pz.input.handbrake ? 1 : 0) : 0;
    b.lenses.update({ night: dark, on: dark > 0, brake: braking, time: clock, distance: r.dist });
    if (r.dist > FX_RANGE || !fxReady()) return false;
    // where the tyres touch: under each wheel holder along the body's up (the ground, if we have it)
    U.set(0, 1, 0).applyQuaternion(Q);
    pz.wheels.forEach((wh, i) => {
      if (!wh.contact) return;
      const g = b.model.userData.wheels[i];
      g.holder.getWorldPosition(wh.contactPoint).addScaledVector(U, -g.r);
      if (world?.heightAt) { const h = world.heightAt(wh.contactPoint.x, wh.contactPoint.z, wh.contactPoint.y); if (fin(h)) wh.contactPoint.y = h; }
    });
    driveWith(fx.effects, r.fxState.e, dt, pz);
    driveWith(fx.driving, r.fxState.d, dt, pz, false);
    return true;
  }

  function updateVoices(dt, near) {
    const ctx = audio?.ctx;
    if (!ctx) { stats.voices = 0; return; }
    const want = new Set(pickVoices(near).map(id => players.get(id)));
    for (const s of slots) if (s.owner && !want.has(s.owner)) s.owner = null;
    for (const r of want) {
      if (slots.some(s => s.owner === r)) continue;
      let s = slots.find(x => !x.owner);
      if (!s && slots.length < VOICES) {
        const gain = ctx.createGain(), pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        gain.gain.value = 0; if (pan) gain.connect(pan).connect(ctx.destination); else gain.connect(ctx.destination);
        s = { voice: new CarAudio({ ctx, out: gain }), gain, pan, owner: null, idle: 0 }; slots.push(s);
      }
      if (s) { s.owner = r; s.voice.gear = 1; }
    }
    const t = ctx.currentTime, right = camera ? R.setFromMatrixColumn(camera.matrixWorld, 0) : null;
    let n = 0;
    for (const s of slots) {
      const r = s.owner, b = r?.bodies[r.kind];
      if (!r || !b) {
        s.gain.gain.setTargetAtTime(0, t, 0.1);
        if ((s.idle += dt) > 5) s.voice.stop();            // silent a while: stop its sources until it's needed again
        continue;
      }
      s.idle = 0; n++;
      if (!s.voice.ctx) s.voice.start();
      s.voice.update(b.pz, b.pz.input, dt);
      s.gain.gain.setTargetAtTime(voiceLevel(r.dist), t, 0.08);
      if (s.pan && right && camera) s.pan.pan.setTargetAtTime(clamp(W.copy(b.pz.renderPos).sub(camera.position).dot(right) / Math.max(r.dist, 1), -1, 1) * 0.7, t, 0.08);
    }
    stats.voices = n;
  }

  // particles age once per frame until the last ones have faded, also after everyone left (nothing hangs in the air)
  function ageFx(dt) { if (fx && (fxIdle += dt) < 4) { fx.effects.advance(dt); fx.driving.advance(dt); } }

  function update(dt) {
    clock += dt || 0;
    if (mp && mp.inGame === false && players.size) clear();
    if (!players.size) {
      stats.count = stats.visible = stats.near = stats.fx = 0;
      ageFx(dt);
      if (slots.length) updateVoices(dt, []);
      return;
    }
    const t0 = performance.now(), n = now(), cam = camera?.position; building = 0;
    let visible = 0, nearN = 0, fxN = 0;
    const heard = [];
    for (const r of players.values()) {
      if (r.track.stale(n)) {
        r.root.visible = r.tag.visible = r.shown = false;
        if (r.kind && r.bodies[r.kind]) r.bodies[r.kind].model.visible = false;
        continue;
      }
      const mode = r.track.pose(n, dt, P, Q, V), s = r.track.latest, kind = s.v;
      if (r.kind !== kind) switchKind(r, kind);
      r.root.position.copy(P); r.root.quaternion.copy(Q);
      r.root.visible = r.shown = true; r.x = P.x; r.z = P.z; visible++;
      const dist = cam ? cam.distanceTo(P) : 0; r.dist = dist;
      // the turn, measured (older clients' steer / lean are guessed from it)
      F.set(0, 0, 1).applyQuaternion(Q);
      const h = Math.atan2(F.x, F.z);
      if (r.heading !== null && dt > 0) {
        let dh = h - r.heading; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        r.yawRate += (dh / dt - r.yawRate) * Math.min(1, dt * 8);
      }
      r.heading = h;
      // level of detail with a little hysteresis
      const farAt = FAR[kind]; r.far = r.far ? dist > farAt * 0.9 : dist > farAt;
      const body = r.far ? r.bodies[kind] : ensureBody(r, kind);
      if (body) body.model.visible = !r.far;
      r.stand.visible = r.far;
      if (!r.far) {
        nearN++;
        if (animateBody(r, body, s, mode, dt)) { fxN++; fxIdle = 0; }
        heard.push({ id: r.id, dist });
      }
      // name tag: same size on screen, a little smaller further off, fades out from TAG_FADE to TAG_HIDE m
      const tag = r.tag;
      if (dist < TAG_HIDE) {
        const sig = `${r.name}|${r.host}|${kind}|${bodyColor(r, kind)}`;
        if (sig !== r.tagSig) {
          r.tagSig = sig; tag.material.map?.dispose();
          const tex = tagTexture(r.name, bodyColor(r, kind), r.host);
          tag.material.map = tex.map; tag.material.needsUpdate = true; r.tagAspect = tex.aspect;
        }
        const k = 0.048 * (1 - 0.25 * THREE.MathUtils.clamp((dist - 20) / 130, 0, 1));   // ≈ 26 px tall at 20 m, 20 px from 150 m
        tag.scale.set(k * r.tagAspect, k, 1);
        tag.material.opacity = THREE.MathUtils.clamp((TAG_HIDE - dist) / (TAG_HIDE - TAG_FADE), 0, 1);
        tag.position.set(P.x, P.y + TAG_Y[kind] + ((body?.gp?.open || 0) > 0.5 ? GLIDER_TAG_Y : 0), P.z);
        tag.visible = true;
      } else tag.visible = false;
    }
    ageFx(dt);
    updateVoices(dt, heard);
    stats.count = players.size; stats.visible = visible; stats.near = nearN; stats.fx = fxN;
    stats.ms += (performance.now() - t0 - building - stats.ms) * 0.05; stats.buildMs += building;
  }

  const predicted = (id, atMs) => predictFrom(players.get(id), atMs, now());

  // named dots on the maps: minimap.js calls this with its canvas, world → canvas mapping and pixel ratio
  function drawMarkers(ctx, map, d, view) {
    if (!players.size) return;
    const W = ctx.canvas.width, H = ctx.canvas.height, m = 9 * d;
    ctx.save(); ctx.lineJoin = 'round'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.font = `700 ${(view === 'full' ? 13 : 11) * d}px system-ui, sans-serif`;
    for (const r of players.values()) {
      if (!r.shown) continue;
      let [a, b] = map(r.x, r.z); const inside = a > m && a < W - m && b > m && b < H - m;
      if (!inside) {
        if (view === 'full') continue;
        const dx = a - W / 2, dy = b - H / 2, k = Math.min((W / 2 - m) / Math.abs(dx || 1e-9), (H / 2 - m) / Math.abs(dy || 1e-9));
        a = W / 2 + dx * k; b = H / 2 + dy * k;
      }
      ctx.beginPath(); ctx.arc(a, b, (inside ? 5.5 : 4) * d, 0, Math.PI * 2);
      ctx.fillStyle = bodyColor(r, r.kind || 'car'); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.8 * d; ctx.stroke();
      if (!inside) continue;
      ctx.lineWidth = 3 * d; ctx.strokeStyle = '#000b'; ctx.strokeText(r.name, a, b - 7 * d);
      ctx.fillStyle = '#fff'; ctx.fillText(r.name, a, b - 7 * d);
    }
    ctx.restore();
  }
  minimap?.setExtraMarkers?.(drawMarkers);

  function dispose() {
    clear(); group.removeFromParent();
    if (mp?.off) for (const [type, fn] of handlers) mp.off(type, fn);
    minimap?.setExtraMarkers?.(null);
    for (const s of slots) { s.voice.stop(); s.gain.disconnect(); s.pan?.disconnect(); }
    slots.length = 0;
    if (fx && !fxOpt) {
      for (const o of [fx.effects.marks, fx.effects.points]) { o.removeFromParent(); o.geometry.dispose(); o.material.dispose(); }
      fx.driving.dispose();
    }
    if (live === api) live = null;
  }
  // what is drawn for each remote (tests, browser scripts); `anim` = the near model's moving parts
  const r3 = x => Math.round(x * 1000) / 1000;
  const animOf = r => {
    const b = r.kind && !r.far ? r.bodies[r.kind] : null; if (!b) return null;
    const pz = b.pz, ud = b.model.userData;
    return { steer: r3(pz.steer), throttle: r3(pz.input.throttle), drifting: pz.drifting, lean: r3(pz.lean),
      comp: pz.wheels.map(w => w.contact ? r3(w.comp) : -1), spin: pz.wheels.map(w => r3(w.spin)),
      frontYaw: r3(ud.wheels[0]?.holder.rotation.y ?? 0), roll: r3(ud.bodyPivot?.rotation.z ?? ud.lean?.rotation.z ?? 0),
      pitch: r3(ud.bodyPivot?.rotation.x ?? ud.rider?.rotation.x ?? 0), bars: ud.bars ? r3(ud.bars.rotation.y) : null,
      wheel: ud.wheel ? r3(ud.wheel.rotation.z) : null,
      gear: b.kind === 'jet' ? r3(pz.gear) : null, flame: b.kind === 'jet' ? (ud.flame?.visible ? r3(ud.flame.scale.z) : 0) : null, rotor: ud.mainRotor ? r3(ud.mainRotor.rotation.y) : null,
      glider: b.gp ? r3(b.gp.open) : 0,
      lights: b.lenses.group.visible ? b.lenses.group.children.filter(o => o.visible).map(o => o.name.replace('vehicle-light-', '')) : [] };
  };
  const list = () => [...players.values()].map(r => ({ id: r.id, name: r.name, host: r.host, kind: r.kind, type: r.kind ? r.type[r.kind] || null : null,
    model: r.kind && !r.far ? r.bodies[r.kind]?.model.name || null : null, visible: r.shown,
    far: r.far, glide: !!r.track.latest?.glide, x: r.root.position.x, y: r.root.position.y, z: r.root.position.z, dist: r.dist,
    tag: r.tag.visible, body: r.kind ? bodyColor(r, r.kind) : null, anim: animOf(r) }));
  const api = { group, update, receive, drawMarkers, dispose, list, stats, predictedState: predicted,
    get count() { return players.size; }, get fx() { return fx; }, model: id => { const r = players.get(id); return r?.kind ? r.bodies[r.kind]?.model || null : null; } };
  live = api;
  return api;
}
