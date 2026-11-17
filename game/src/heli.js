import { driftAir } from './wind.js';
// Helicopter: a light single-engine helicopter (Bell 206 / AS350 style), a Garage type of the jet. Fixed 120 Hz step.
// Local axes: +z forward (nose), +y up, +x = left. Arcade and easy:
//   * W / S = collective: climb / descend (a climb-rate controller; hands off holds the height). Near the ground S
//     slows the sink by itself, so holding S sets it down gently.
//   * A / D = yaw (tail rotor) left / right.
//   * ↑ ↓ ← → = tilt the rotor forward / back / left / right; the helicopter flies that way. Rolling at speed turns it
//     (a banked turn). Hands off the arrows: it tilts against its drift, levels itself and slows to a hover.
//   * Modes: 'ground' (on its skids, rotor at idle until you lift), 'air', 'crashed' (wreck tumble like the jet, then
//     back to the last safe spot or the race's air respawn after 4.5 s).
//   * Lands anywhere flat enough (≤ ~20°) on its skids: sink < 6 m/s, < 45 km/h over the ground, near level. Faster,
//     harder, tipped past ~60°, the rotor / tail / nose into the ground, trees, buildings or water = crash.
// World queries only: heightAt / surfaceAt / treesNear / buildingsNear / waterLevelAt (+ terrainAt / loadedAt / extent).
import * as THREE from 'three';
import { Vehicle } from './vehicle.js';
import { GRACE, findGround, airHeight } from './airrespawn.js';
import { Jet } from './jet.js';
import { LEDGE, roofLedge } from './roofs.js';
import { buildHeliModel, HELI_SKIDS, HELI_SKID_H, HELI_BODY } from './models/heli.js';

export const HELI = {
  gravity: 14,
  maxThrust: 2.1,      // × weight at full rotor speed
  spool: 0.55,         // rotor speed change per second (idle 0.35 → flying 1)
  idle: 0.35,
  climb: 10, descend: 11, // m/s at full collective
  vResp: 2.5,          // 1/s: how hard the collective chases the wanted climb rate
  maxTilt: 0.5,        // rad (~29°) at full stick: ~250 km/h flat out
  brakeTilt: 0.012, brakeMax: 0.35,   // hands off: rad of tilt per m/s of drift, and the most it uses to stop
  tiltResp: 3,         // 1/s
  yawRate: 1.5,        // rad/s at full pedal
  bankTurn: 0.55,      // rad/s of banked turn at full sideways stick, cruising
  dragLin: 0.01, dragQuad: 0.00145,  // horizontal drag (1/s, 1/m)
  hoverHold: 0.22,     // 1/s extra drift damping, hands off
  ceiling: 3000,       // m above sea level where the climb runs out
  landSink: 6, landKmh: 45, maxSlope: 0.94, landTilt: 0.85,   // slope / tilt as the up vector's y
};
// The rotor disc tilts the full pitch / roll (that's where the thrust points); the fuselage follows part of it, so a
// flat-out nose-down cruise doesn't swing the tail boom up into the chase camera.
const BODY_PITCH = 0.45, BODY_ROLL = 0.75;
const ROLL = [0.75, 0.9, 0.7, 0.45, 0.6, 1, 0.45, 0.5];          // skid friction × gravity per surface
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

const _up = new THREE.Vector3(), _fw = new THREE.Vector3(), _lt = new THREE.Vector3(), _v = new THREE.Vector3(),
  _w = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion(), _q0 = new THREE.Quaternion(),
  _m = new THREE.Matrix4(), _e = new THREE.Euler(0, 0, 0, 'YXZ');

export class Heli extends Vehicle {
  constructor(world, tuning = HELI) {
    super(world, 'jet');                 // a type of the jet: races, garage, multiplayer and HUD treat it as one
    this.name = 'Helicopter'; this.type = 'heli'; this.t = tuning;
    this.help = 'W/S up/down · A/D turn · arrows tilt to fly that way (let go to hover) · land gently on flat ground';
    this.mode = 'ground'; this.rotor = tuning.idle; this.throttle = this.rotor; this.yaw = 0; this.pitch = 0; this.roll = 0;
    this.agl = 0; this.idleT = 99; this.crashT = 0; this.gear = 1; this.respawn = null; this.steep = false;
    this.grace = 0; this.graceAir = false; this.lastRespawn = null;   // respawn crash grace (airrespawn.js)
    this._acc = new THREE.Vector3();
    this.wheels = HELI_SKIDS.map(([x, z], i) => ({ x, z, front: i < 2, contact: false, surf: 0, comp: 0, contactPoint: new THREE.Vector3(), spin: 0 }));
    this.mesh = buildHeliModel();
    // chase camera (main.js updateCamera): behind and level, a little further back than the car's
    this.cam = { dist: 10.5, high: 3.4, distPerSpeed: 0.05, nose: [0, 0.75, 1.9] };
    this.half = { x: 1.3, front: 2.6, back: -6.6 };
  }

  // body pose from the disc tilt: yaw, then nose-down pitch, then roll right
  setPose() {
    _e.set(this.pitch * BODY_PITCH, this.yaw, this.roll * BODY_ROLL); this.quat.setFromEuler(_e);
  }

  // on the skids: the four skid ends on the ground (roofs and bridge decks count when they are under the skids).
  // Leaves the ground's up vector in _up.
  groundPose(x, z, yaw, y) {
    const W = this.world, s = Math.sin(yaw), c = Math.cos(yaw), h = [];
    for (const [gx, gz] of HELI_SKIDS) { const px = x + c * gx + s * gz, pz = z - s * gx + c * gz; h.push([px, W.heightAt(px, pz, y), pz]); }
    // skid ends hanging over a roof's edge rest on it, level, while the centre is over the roof (terrain: unchanged)
    if (roofLedge(W, h) && W.heightAt(x, z, y) > h.top - LEDGE) for (const p of h.off) p[1] = h.top;
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const F = mid(h[0], h[1]), B = mid(h[2], h[3]), L = mid(h[0], h[2]), R = mid(h[1], h[3]);
    _fw.set(F[0] - B[0], F[1] - B[1], F[2] - B[2]).normalize();
    _lt.set(L[0] - R[0], L[1] - R[1], L[2] - R[2]).normalize();
    _up.crossVectors(_fw, _lt).normalize(); _lt.crossVectors(_up, _fw).normalize();
    _m.makeBasis(_lt, _up, _fw); this.quat.setFromRotationMatrix(_m);
    this.tiltFromBody();
    return (F[1] + B[1]) / 2 + HELI_SKID_H * _up.y;
  }

  tiltFromBody() {
    _e.setFromQuaternion(this.quat, 'YXZ');
    this.pitch = clamp(_e.x / BODY_PITCH, -this.t.maxTilt, this.t.maxTilt); this.roll = clamp(_e.z / BODY_ROLL, -this.t.maxTilt, this.t.maxTilt);
  }

  // y: the height the spot was recorded at (a respawn's safe spot), so ground above it (a bridge deck) doesn't count
  reset(x, z, yaw, y) {
    this.mode = 'ground'; this.yaw = yaw; this.rotor = this.t.idle; this.throttle = this.rotor; this.idleT = 99;
    this.crashT = 0; this.burning = false; this.steep = false; this.mesh.userData.wreck(false);
    // the ground queries (roofs) go by where the helicopter is: reset where it stands (a vehicle switch, F, a type change)
    // poses it from its height, so a roof under it holds; a new spot is posed from ground level there (airrespawn.js)
    if (this.pos.x !== x || this.pos.z !== z) this.pos.set(x, this.world.terrainAt?.(x, z) ?? 0, z);
    this.vel.set(0, 0, 0);
    this.pos.y = this.groundPose(x, z, yaw, y);
    this.vel.set(0, 0, 0); this.ang.set(0, 0, 0); this._acc.set(0, 0, 0); this.airTime = 0; this.agl = 0;
    this.grounded = true;
    this.afterReset();
  }

  // R / crash: a race gives an air respawn (the last ring passed); else the last safe spot
  resetToSafe() {
    if (this.respawn) { const r = this.respawn(); if (r) { this.respawnInAir(...r); return; } }
    const s = this.safe.length > 40 ? this.safe[this.safe.length - 40] : this.safe[0];
    if (s) this.respawnAt(s);
    else if (this.mode === 'crashed') { const [sx, sz] = this.world.spawn; this.respawnAt([sx, sz, 0]); }
  }
  // respawns as for the jet (airrespawn.js): on the skids on a level, clear spot, or in the air; then GRACE s of grace
  footing(x, z, yaw, y) {
    return findGround(this, x, z, yaw, { yRef: y, pose: (px, pz, pyaw, py) => this.groundPose(px, pz, pyaw, py), body: HELI_BODY, reach: 5.5 });
  }
  respawnAt([x, z, yaw, y]) {
    const g = this.footing(x, z, yaw, y);
    this.reset(g.x, g.z, yaw, g.y);
    this.lastRespawn = { ground: [x, z, yaw, y] }; this.grace = GRACE; this.graceAir = false;
  }
  respawnInAir(x, y, z, yaw, kmh = 150) {
    this.placeInAir(x, airHeight(this.world, x, z, yaw, Math.min(kmh, 150), y), z, yaw, kmh);
    this.lastRespawn = { air: [x, y, z, yaw, kmh] }; this.grace = GRACE; this.graceAir = true;
  }
  recover() {
    const sp = this.vel.length(), yaw = sp > 3 ? Math.atan2(this.vel.x, this.vel.z) : this.yaw;
    if (this.graceAir) this.placeInAir(this.pos.x, airHeight(this.world, this.pos.x, this.pos.z, yaw, 150, this.pos.y), this.pos.z, yaw, 150);
    else { const g = this.footing(this.pos.x, this.pos.z, yaw); this.reset(g.x, g.z, yaw); }
  }
  // flying at (x, y, z) heading yaw, rotor up to speed (a jet's 450 km/h becomes the helicopter's cruise)
  placeInAir(x, y, z, yaw, kmh = 150) {
    this.reset(x, z, yaw);
    this.mode = 'air'; this.grounded = false; this.rotor = 1; this.throttle = 1; this.idleT = 0;
    this.pos.y = Math.max(y, this.world.heightAt(x, z) + 30);
    this.pitch = 0; this.roll = 0; this.setPose();
    this.vel.set(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(Math.min(kmh, 150) / 3.6);
    for (const wh of this.wheels) wh.contact = false;
    this.afterReset();
  }
  // F: level it where it is (in the air), or back on the skids
  flipUpright() {
    if (this.mode !== 'air') { this.reset(this.pos.x, this.pos.z, this.yaw); return; }
    this.pitch = 0; this.roll = 0; this.setPose(); this.ang.set(0, 0, 0);
  }

  step(dt, input) {
    const J = input.jet || { thr: 0, pitch: 0, roll: 0, yaw: 0 };
    this._prevVel.copy(this.vel);
    this.hit = 0;
    if (this.grace > 0 && this.mode !== 'crashed') this.grace -= dt;
    if (this.mode === 'crashed') {
      this.rotor = Math.max(0, this.rotor - dt * 0.5); this.throttle = this.rotor;
      this.stepWreck(dt);
      if (this.crashT > 4.5) this.resetToSafe();
      return;
    }
    // rotor: idles on the ground, spools up with any input (and stays up a few seconds after landing)
    const busy = J.thr > 0 || J.pitch || J.roll || J.yaw;
    this.idleT = this.mode === 'air' || busy ? 0 : this.idleT + dt;
    const want = this.mode === 'air' || this.idleT < 4 ? 1 : this.t.idle;
    this.rotor += clamp(want - this.rotor, -this.t.spool * dt, this.t.spool * dt);
    this.throttle = this.rotor;
    if (this.mode === 'ground') this.stepGround(dt, J); else this.stepAir(dt, J);
    this.trackAccel(dt);
  }

  // skids on the ground: slides to a stop, turns on the spot with the rotor up, lifts with W once it's spooled
  stepGround(dt, J) {
    const t = this.t, W = this.world, g = t.gravity;
    this.grounded = true; this.airTime = 0; this.contacts = 4; this.agl = 0;
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    let fric = 0, wet = false;
    for (const wh of this.wheels) {
      const px = this.pos.x + c * wh.x + s * wh.z, pz = this.pos.z - s * wh.x + c * wh.z, gy = W.heightAt(px, pz, this.pos.y);
      const sc = W.surfaceAt(px, pz, this.pos.y); wh.surf = sc; wh.contact = true; wh.comp = 0.2;
      if (W.waterLevelAt(px, pz) > gy + 0.3) wet = true;
      fric += (ROLL[sc] ?? 0.7) / 4;
      wh.contactPoint.set(px, gy, pz);
    }
    this.surface = W.surfaceAt(this.pos.x, this.pos.z, this.pos.y);
    if (wet) { this.crash('water'); return; }
    // lift-off
    if (J.thr > 0 && this.rotor > 0.9 && !J.hold) { this.toAir(); this.vel.y = 2; return; }
    // skids slide to a stop
    const hs = Math.hypot(this.vel.x, this.vel.z), dec = fric * g * dt;
    if (hs <= dec) { this.vel.x = 0; this.vel.z = 0; } else { this.vel.x -= this.vel.x / hs * dec; this.vel.z -= this.vel.z / hs * dec; }
    const yawRate = this.rotor > 0.8 && !J.hold ? -J.yaw * t.yawRate * 0.6 : 0;
    this.yaw = wrap(this.yaw + yawRate * dt);
    const nx = this.pos.x + this.vel.x * dt, nz = this.pos.z + this.vel.z * dt;
    const ny = this.groundPose(nx, nz, this.yaw, this.pos.y + 1);
    // the ground fell away from under it (slid off an edge): it's flying
    if (ny < this.pos.y - 1.5) { this.toAir(); return; }
    this.vel.y = hs < 0.01 ? 0 : (ny - this.pos.y) / dt;
    this.pos.set(nx, ny, nz);
    this.ang.set(0, yawRate, 0);
    const hit = Math.max(this.collideTrees(1.2, [-5, 0, 1.5], 0.2, 0.3), this.collideBuildings(2.2));
    if (hit > 8) { this.crash('impact'); return; }
    this.keepInBounds();
    if (hs < 1) this.rememberSafe();
    this.slip = 0; this.drifting = false; this.steer = J.yaw;
  }

  toAir() {
    this.mode = 'air'; this.grounded = false; this.contacts = 0; this.airTime = 0; this.steep = false;
    this.tiltFromBody(); this.yaw = _e.y;
    for (const wh of this.wheels) { wh.contact = false; wh.comp = 0; }
  }

  stepAir(dt, J) {
    const t = this.t, W = this.world, g = t.gravity, v = this.vel;
    this.grounded = false; this.contacts = 0; this.airTime += dt;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);           // heading forward; left = (fz, -fx)
    const vF = v.x * fx + v.z * fz, vL = v.x * fz - v.z * fx, hs = Math.hypot(v.x, v.z);
    // ------------------------------------------------ attitude: the stick tilts the rotor; hands off tilts against the drift
    const pitchT = J.pitch ? -J.pitch * t.maxTilt : clamp(-vF * t.brakeTilt, -t.brakeMax, t.brakeMax);
    const rollT = J.roll ? J.roll * t.maxTilt : clamp(vL * t.brakeTilt, -t.brakeMax, t.brakeMax);
    const k = Math.min(1, t.tiltResp * dt);
    this.pitch += (pitchT - this.pitch) * k; this.roll += (rollT - this.roll) * k;
    // yaw: pedals, plus a banked turn at speed, plus a little weathervane into the flight path when cruising
    const turn = clamp((hs - 8) / 20, 0, 1);
    const carve = -turn * (this.roll / t.maxTilt) * t.bankTurn;
    let yawRate = -J.yaw * t.yawRate + carve;
    if (!J.yaw && vF > 15) yawRate += wrap(Math.atan2(v.x, v.z) - this.yaw) * 0.8 * turn;
    this.yaw = wrap(this.yaw + yawRate * dt);
    this.setPose();
    this.ang.set(0, yawRate, 0);
    // ------------------------------------------------ collective: thrust along the rotor axis to make the wanted climb rate
    const gh = W.heightAt(this.pos.x, this.pos.z, this.pos.y), water = W.waterLevelAt(this.pos.x, this.pos.z);
    this.agl = this.pos.y - HELI_SKID_H - Math.max(gh, water);
    let vyT = J.thr > 0 ? J.thr * t.climb : J.thr * Math.min(t.descend, 1.2 + Math.max(0, this.agl) * 0.6);   // sink eases near the ground
    vyT = Math.min(vyT, (t.ceiling - this.pos.y) * 0.2);
    if (J.hold) vyT = Math.min(vyT, 0);
    _up.set(0, 1, 0).applyQuaternion(_q.setFromEuler(_e.set(this.pitch, this.yaw, this.roll)));    // the rotor disc's axis
    const tMax = t.maxThrust * g * this.rotor * this.rotor;
    const T = clamp((g + (vyT - v.y) * t.vResp) / Math.max(_up.y, 0.3), 0, tMax);
    _v.copy(_up).multiplyScalar(T); _v.y -= g;
    const drag = t.dragLin + t.dragQuad * hs + (!J.pitch && !J.roll ? t.hoverHold : 0);
    _v.x -= v.x * drag; _v.z -= v.z * drag; _v.y -= v.y * 0.1;
    v.addScaledVector(_v, dt);
    const ca = Math.cos(carve * dt), sa = Math.sin(carve * dt), vx = v.x;   // a banked turn carries the flight path round
    v.x = vx * ca + v.z * sa; v.z = -vx * sa + v.z * ca;
    this._acc.copy(_v);
    driftAir(this, dt, 0.2);
    this.pos.addScaledVector(v, dt);
    Jet.prototype.edgeTurn.call(this);                                  // the jet's map-edge turn-back
    _e.setFromQuaternion(this.quat, 'YXZ'); this.yaw = _e.y;
    this.slip = 0; this.drifting = false; this.steer = J.yaw;
    // ------------------------------------------------ ground (skids first), rotor / nose / tail strikes, trees, buildings
    _up.set(0, 1, 0).applyQuaternion(this.quat);
    if (_up.y < 0.5) { this.crash('tipped'); return; }
    if (this.airTime > 0.15 && this.skidsAGL() < 0) { this.touchDown(); if (this.mode !== 'air') return; }
    let scrape = 0;
    for (const [x, y, z] of HELI_BODY) {
      _w.set(x, y, z).applyQuaternion(this.quat).add(this.pos);
      const pen = Math.max(W.heightAt(_w.x, _w.z, _w.y + 0.5), W.waterLevelAt(_w.x, _w.z)) - _w.y;
      if (pen <= 0) continue;
      // the tail touching down gently in a flare just bumps; the nose, the rotor or anything harder is a crash
      if (z < -6 && y < 1 && -v.y < t.landSink && hs < 20) scrape = Math.max(scrape, pen);
      else { this.crash(y > 1 ? 'rotor' : 'impact'); return; }
    }
    if (scrape) { this.pos.y += scrape; if (v.y < 0) v.y = 0; this.hit = Math.max(this.hit, 3); }
    if (this.agl < 45 && this.hitTree()) { this.crash('tree'); return; }
    if (this.agl < 80 && this.collideBuildings(3.2) > 6) { this.crash('building'); return; }
    this.keepInBounds(false);
    // low over flat dry open ground: a safe spot to come back to
    if (this.agl < 40 && hs < 30 && water < gh && this.flatAt(this.pos.x, this.pos.z)) this.rememberSafe();
  }

  flatAt(x, z) {
    const W = this.world, h = W.heightAt(x, z);
    return Math.abs(W.heightAt(x + 3, z) - h) < 1 && Math.abs(W.heightAt(x, z + 3) - h) < 1 &&
      Math.abs(W.heightAt(x - 3, z) - h) < 1 && Math.abs(W.heightAt(x, z - 3) - h) < 1;
  }

  // skid ends on a roof's edge with the centre past it: true, and out = the flat way off it (from the centroid of the
  // ends on the roof to the centroid of those hanging over the drop). Terrain ledges: false (old behaviour).
  ledgeAway(out) {
    const W = this.world, s = Math.sin(this.yaw), c = Math.cos(this.yaw), h = [];
    for (const [gx, gz] of HELI_SKIDS) { const px = this.pos.x + c * gx + s * gz, pz = this.pos.z - s * gx + c * gz; h.push([px, W.heightAt(px, pz, this.pos.y), pz]); }
    if (!roofLedge(W, h) || W.heightAt(this.pos.x, this.pos.z, this.pos.y) > h.top - LEDGE) return false;
    let hx = 0, hz = 0, nh = 0, lx = 0, lz = 0, nl = 0;
    for (const p of h) if (h.off.includes(p)) { lx += p[0]; lz += p[2]; nl++; } else { hx += p[0]; hz += p[2]; nh++; }
    out.set(lx / nl - hx / nh, 0, lz / nl - hz / nh);
    const L = Math.hypot(out.x, out.z) || 1; out.x /= L; out.z /= L;
    return true;
  }

  // height of the lowest skid end above ground / water
  skidsAGL() {
    const W = this.world; let low = Infinity;
    for (const [x, z] of HELI_SKIDS) {
      _w.set(x, -HELI_SKID_H, z).applyQuaternion(this.quat).add(this.pos);
      low = Math.min(low, _w.y - Math.max(W.heightAt(_w.x, _w.z, _w.y + 1), W.waterLevelAt(_w.x, _w.z)));
    }
    return low;
  }

  // a skid touched: land if it's gentle on flat ground, bump off if it's gentle on a slope, else crash
  touchDown() {
    const t = this.t, W = this.world, v = this.vel;
    const sink = -v.y, kmh = Math.hypot(v.x, v.z) * 3.6;
    const wet = W.waterLevelAt(this.pos.x, this.pos.z) > W.heightAt(this.pos.x, this.pos.z, this.pos.y) + 0.3;
    _n.set(0, 1, 0).applyQuaternion(this.quat); _q0.copy(this.quat);
    const pitch = this.pitch, roll = this.roll;
    const y = this.groundPose(this.pos.x, this.pos.z, this.yaw, this.pos.y);
    const groundUp = _up.y, level = _n.dot(_up);
    this.quat.copy(_q0); this.pitch = pitch; this.roll = roll;
    if (wet) { this.crash('water'); return; }
    // the centre is past a roof's edge with skid ends on top: a touch the ground would allow (not too hard, not too
    // fast, not tipped: its own up vector, as the pose across a ledge says nothing) bumps off the edge and slides clear
    if (sink < t.landSink && kmh < 100 && _n.y >= 0.5 && this.ledgeAway(_v)) {
      v.y = Math.max(0, sink * 0.3); v.x += _v.x * 1.5; v.z += _v.z * 1.5;
      if (sink > 1) { this.hit = Math.max(this.hit, sink); this.landing = Math.min(1, sink / 8); }
      return;
    }
    if (sink >= t.landSink) { this.crash('hard'); return; }
    if (kmh > 100 || level < 0.5) { this.crash('impact'); return; }
    if (groundUp > t.maxSlope && kmh < t.landKmh && level > t.landTilt) { this.land(sink, y); return; }
    // gentle, but too steep / too fast / tilted: bump off and keep flying
    this.steep = groundUp <= t.maxSlope;
    this.pos.y = Math.max(this.pos.y, y);
    v.y = Math.max(0, sink * 0.3); v.x *= 0.92; v.z *= 0.92;
    if (sink > 1) { this.hit = Math.max(this.hit, sink); this.landing = Math.min(1, sink / 8); }
  }

  land(sink, y) {
    this.mode = 'ground'; this.grounded = true; this.steep = false;
    this.pos.y = y; this.vel.y = 0;
    this.groundPose(this.pos.x, this.pos.z, this.yaw, this.pos.y);
    this.landing = Math.min(1, sink / 7);
    for (const wh of this.wheels) wh.contact = true;
  }

  // like the jet's wreck: keeps its momentum, tumbles, bounces on the ground
  stepWreck(dt) {
    this.crashT += dt;
    this.vel.y -= this.t.gravity * dt;
    this.vel.multiplyScalar(Math.exp(-0.15 * dt));
    this.pos.addScaledVector(this.vel, dt);
    const spin = this.ang.length();
    if (spin > 1e-6) { _q.setFromAxisAngle(_v.copy(this.ang).divideScalar(spin), spin * dt); this.quat.premultiply(_q).normalize(); }
    let pen = -Infinity;
    for (const [x, y, z] of [[0, -1.2, 0], ...HELI_BODY]) {
      _w.set(x, y, z).applyQuaternion(this.quat).add(this.pos);
      pen = Math.max(pen, Math.max(this.world.heightAt(_w.x, _w.z, _w.y), this.world.waterLevelAt(_w.x, _w.z)) - _w.y);
    }
    this.grounded = pen > 0;
    if (this.grounded) {
      this.pos.y += pen;
      const impact = Math.max(0, -this.vel.y);
      this.vel.y = impact > 1.5 ? impact * 0.4 : 0;
      this.vel.x *= 0.8; this.vel.z *= 0.8;
      this.ang.multiplyScalar(0.7);
      this.hit = impact;
    }
    this.ang.multiplyScalar(Math.exp(-0.25 * dt));
    Jet.prototype.edgeTurn.call(this);
    this.agl = Math.max(0, this.pos.y - this.world.heightAt(this.pos.x, this.pos.z, this.pos.y));
  }

  crash(why) {
    if (this.mode === 'crashed') return;
    if (this.grace > 0) { this.recover(); return; }      // just respawned: never a wreck (no respawn loop)
    this.mode = 'crashed'; this.crashT = 0; this.burning = true; this.grounded = false;
    this.hit = Math.max(this.hit, 40); this.landing = 1;
    this.vel.multiplyScalar(0.6);
    this.ang.set(1.2, 2.5, 1.6);
    for (const wh of this.wheels) wh.contact = false;
    this.mesh.userData.wreck(true);
  }

  // tree crowns (like the jet's): the main rotor reaches 5 m
  hitTree() {
    const W = this.world; let hit = false;
    W.treesNear(this.pos.x, this.pos.z, 18, (tx, tz, tr, h, broad) => {
      if (hit || h === undefined) return;
      const y = this.pos.y - HELI_SKID_H - W.terrainAt(tx, tz);
      if (y > h + 0.5 || y < -3) return;
      const crown = broad ? (y > h * 0.3 ? h * 0.3 : tr) : h * 0.15 * (1 - Math.max(0, y) / h) + tr;
      if (Math.hypot(this.pos.x - tx, this.pos.z - tz) < crown + 4.6) hit = true;
    });
    return hit;
  }

  hudInfo() {
    if (this.mode === 'crashed') return '';
    if (this.mode === 'ground') {
      const hint = this.rotor < 0.9 ? (this.idleT < 4 ? ' · rotor spooling up…' : ' · hold W to lift off') : ' · W to lift off';
      return `ROTOR ${Math.round(this.rotor * 100)}% · on the ground${hint} · `;
    }
    const vs = this.vel.y;
    let h = `ALT ${Math.max(0, Math.round(this.agl))} m · ${vs >= 0 ? '↑' : '↓'}${Math.abs(vs).toFixed(0)} m/s`;
    if (this.steep) h += ' · <span style="color:#ffb02e">too steep to land here</span>';
    return h + ' · ';
  }

  syncMesh(dt) { this.mesh.userData.syncMesh.call(this, dt); }
}
