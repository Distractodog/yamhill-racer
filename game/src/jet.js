// Jet. Fixed 120 Hz step. Local axes: +z forward (nose), +y up, +x = left wing.
//
// Two modes:
//   * ground: rolls on its three wheels along the ground under them (nose-wheel steering, brakes, rolling drag per
//     surface). ↓ (nose up) past ~230 km/h rotates the nose; once the wings make more lift than the weight it flies.
//     Ground that drops away faster than gravity (a crest, a ramp lip, a bank) also throws it into the air.
//   * air: lift / drag / thrust from airspeed² and angle of attack (stall above ~17°). The stick asks for g's
//     (fly-by-wire, arcade): hands off it holds its flight path and holds height in a bank; ↓ pulls up to 8 g;
//     ←/→ roll, A/D rudder; too slow → it can't make the lift it's asked for → STALL, the nose drops.
//     Touch down on the wheels gently (sink < 8 m/s, wings near level, nose not down, < 500 km/h) → ground mode;
//     anything else (or the wing / nose / tail in the ground, trees, buildings, water) is a crash: wreck + smoke,
//     then back to the last safe spot (or the challenge's respawn point) after 3 s.
// World queries only: heightAt / surfaceAt / normalAt / treesNear / buildingsNear / waterLevelAt (+ terrainAt).
import * as THREE from 'three';
import { Vehicle } from './vehicle.js';

export const JET = {
  gravity: 12,
  thrust: 16,          // m/s² at full throttle (≈ 1.3 × weight)
  throttleRate: 0.6,   // lever travel per second
  liftK: 0.0023,       // lift (m/s²) = liftK × speed² × CL
  cl0: 0.1, clA: 3.5,  // CL at 0 angle of attack, per radian
  stallA: 0.30,        // ≈ 17°
  cd0: 0.028, cdK: 0.1,
  maxG: 8, minG: -2.5,
  rollRate: 2.6,       // rad/s at full stick
  yawRate: 0.5,
  rotateKmh: 230,      // nose can come up from this speed on the ground
  brakes: 9,           // m/s²
  landSink: 8, landKmh: 500, landUp: 0.9,
};
const ROLL = [1.6, 3.5, 1.2, 0.25, 0.8, 0, 0.3, 0.6];      // rolling drag per surface, m/s² (water = crash)
const GEAR_H = 1.6;                                         // centre of mass above the ground on the wheels
const GEAR = [[0, 3.6], [1.4, -0.8], [-1.4, -0.8]];         // nose, left main, right main (x, z)
const BODY = [[0, 0, 6.6], [0, 0.2, -6.2], [4.9, 0.05, -1.6], [-4.9, 0.05, -1.6], [0, 2.6, -5.6]];  // nose, tail, tips, fin
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const _up = new THREE.Vector3(), _fw = new THREE.Vector3(), _lt = new THREE.Vector3(), _v = new THREE.Vector3(),
  _a = new THREE.Vector3(), _w = new THREE.Vector3(), _t = new THREE.Vector3(), _q = new THREE.Quaternion(),
  _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _X = new THREE.Vector3(1, 0, 0);

export class Jet extends Vehicle {
  constructor(world, tuning = JET) {
    super(world, 'jet');
    this.name = 'Jet'; this.t = tuning;
    this.mode = 'ground'; this.throttle = 0; this.yaw = 0; this.v = 0; this.rot = 0; this.vy = 0;
    this.alpha = 0; this.bank = 0; this.gLoad = 1; this.stall = false; this.stallT = 0; this.agl = 0;
    this.pullUp = false; this.crashT = 0; this.gear = 1; this.respawn = null;
    this._acc = new THREE.Vector3();
    this.wheels = GEAR.map(([x, z], i) => ({ x, z, front: i === 0, contact: false, surf: 0, comp: 0, contactPoint: new THREE.Vector3(), spin: 0 }));
    this.mesh = buildJetModel();
    this.cam = { jet: true };
    this.half = { x: 4.9, front: 6.6, back: -6.2 };
  }

  // ---------------------------------------------------------------- ground pose from the three wheels
  groundPose(x, z, yaw, rot) {
    const W = this.world, s = Math.sin(yaw), c = Math.cos(yaw);
    const pt = ([gx, gz]) => { const px = x + c * gx + s * gz, pz = z - s * gx + c * gz; return [px, W.heightAt(px, pz), pz]; };
    const N = pt(GEAR[0]), L = pt(GEAR[1]), R = pt(GEAR[2]);
    const mx = (L[0] + R[0]) / 2, my = (L[1] + R[1]) / 2, mz = (L[2] + R[2]) / 2;
    _fw.set(N[0] - mx, N[1] - my, N[2] - mz).normalize();
    _lt.set(L[0] - R[0], L[1] - R[1], L[2] - R[2]).normalize();
    _up.crossVectors(_fw, _lt).normalize(); _lt.crossVectors(_up, _fw).normalize();
    _m.makeBasis(_lt, _up, _fw); this.quat.setFromRotationMatrix(_m);
    if (rot) { _q.setFromAxisAngle(_X, -rot); this.quat.multiply(_q); }
    // centre: above the point between the mains and the nose wheel
    const gy = my + (N[1] - my) * (0.8 / 4.4);
    return gy + GEAR_H * _up.y;
  }

  reset(x, z, yaw) {
    this.mode = 'ground'; this.yaw = yaw; this.v = 0; this.rot = 0; this.vy = 0; this.throttle = 0;
    this.crashT = 0; this.stall = false; this.gear = 1; this.mesh.userData.wreck(false);
    this.pos.set(x, this.groundPose(x, z, yaw, 0), z);
    this.vel.set(0, 0, 0); this.ang.set(0, 0, 0); this.steer = 0; this.burning = false; this._acc.set(0, 0, 0); this.stallT = 0; this.airTime = 0;
    this.afterReset();
  }

  // R / crash: a challenge can give an air respawn (last ring passed, flying); else the last safe ground spot
  resetToSafe() {
    if (this.respawn) { const r = this.respawn(); if (r) { this.placeInAir(...r); return; } }
    super.resetToSafe();
    if (this.mode === 'crashed') { const [sx, sz] = this.world.spawn; this.reset(sx, sz, 0); }
  }
  placeInAir(x, y, z, yaw, kmh = 450) {
    this.reset(x, z, yaw);
    this.mode = 'air'; this.gear = 0; this.throttle = 0.7;
    this.pos.y = Math.max(y, this.world.heightAt(x, z) + 40);
    this.quat.setFromAxisAngle(_v.set(0, 1, 0), yaw);
    this.vel.set(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(kmh / 3.6);
    this.afterReset();
  }
  // F: wings level and nose on the horizon (in the air), or back on the wheels where you are
  flipUpright() {
    if (this.mode !== 'air') { this.reset(this.pos.x, this.pos.z, this.heading()); return; }
    const yaw = Math.atan2(this.vel.x, this.vel.z), s = this.vel.length();
    this.quat.setFromAxisAngle(_v.set(0, 1, 0), yaw); this.vel.set(Math.sin(yaw) * s, 0, Math.cos(yaw) * s); this.ang.set(0, 0, 0);
  }

  step(dt, input) {
    const J = input.jet || { thr: 0, pitch: 0, roll: 0, yaw: 0 };
    this._prevVel.copy(this.vel);
    this.throttle = clamp(this.throttle + J.thr * this.t.throttleRate * dt, 0, 1);
    this.hit = 0;
    if (this.mode === 'crashed') {
      this.stepWreck(dt);
      if (this.crashT > 4.5) this.resetToSafe();
      return;
    }
    if (this.mode === 'ground') this.stepGround(dt, J, input); else this.stepAir(dt, J, input);
    this.trackAccel(dt);
    this.gear += ((this.mode === 'ground' || this.agl < 60 ? 1 : 0) - this.gear) * Math.min(1, dt * 1.2);
  }

  stepGround(dt, J, input) {
    const t = this.t, W = this.world, g = t.gravity;
    this.grounded = true; this.airTime = 0; this.contacts = 3; this.agl = 0;
    // surface + water under the wheels
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    let worstRoll = 0, wet = false;
    for (const wh of this.wheels) {
      const px = this.pos.x + c * wh.x + s * wh.z, pz = this.pos.z - s * wh.x + c * wh.z;
      const sc = W.surfaceAt(px, pz); wh.surf = sc; wh.contact = true; wh.comp = 0.2;
      if (W.waterLevelAt(px, pz) > W.heightAt(px, pz)) wet = true;
      worstRoll = Math.max(worstRoll, ROLL[sc] ?? 1);
      wh.contactPoint.set(px, W.heightAt(px, pz), pz);
    }
    this.surface = W.surfaceAt(this.pos.x, this.pos.z);
    if (wet && Math.abs(this.v) > 2) { this.crash('water'); return; }
    // lift from the wings at the rotation angle (takes weight off the wheels; enough of it = take-off)
    const q = this.v * this.v;
    const cl = t.cl0 + t.clA * (this.rot + 0.035);
    const L = this.v > 0 ? t.liftK * q * cl : 0;
    const load = Math.max(0, 1 - L / g);
    let a = this.throttle * t.thrust - t.liftK * q * (t.cd0 + t.cdK * cl * cl + 0.012) * Math.sign(this.v);
    a -= worstRoll * load * Math.sign(this.v) * Math.min(1, Math.abs(this.v));
    if (J.hold) { this.v = 0; a = 0; }                          // race countdown: held on the brakes
    else if (input.handbrake || J.brake) {
      if (Math.abs(this.v) < 1.5 && this.throttle < 0.9) { this.v = 0; a = 0; } else a -= t.brakes * Math.sign(this.v) * Math.min(1, Math.abs(this.v));
    } else if (!this.throttle && Math.abs(this.v) < 0.5) { this.v = 0; a = 0; }
    this.v += a * dt;
    // nose-wheel steering (A/D) + rudder at speed
    this.steer += (J.yaw - this.steer) * Math.min(1, 6 * dt);
    const lock = 0.6 / (1 + Math.abs(this.v) / 12);
    const yawRate = -(this.v * Math.tan(this.steer * lock) / 4.4) * load - this.steer * 0.12 * Math.min(1, Math.abs(this.v) / 60);
    this.yaw += yawRate * dt;
    // rotation: ↓ lifts the nose once fast enough (max ~13°, tail strike)
    const rotKmh = this.v * 3.6;
    if (J.pitch > 0 && rotKmh > t.rotateKmh) this.rot = Math.min(0.22, this.rot + 0.3 * J.pitch * dt);
    else this.rot = Math.max(0, this.rot - 0.25 * dt);
    // follow the ground
    const nx = this.pos.x + Math.sin(this.yaw) * this.v * dt, nz = this.pos.z + Math.cos(this.yaw) * this.v * dt;
    const ny = this.groundPose(nx, nz, this.yaw, this.rot);
    const vyNew = (ny - this.pos.y) / dt;
    _fw.set(0, 0, 1).applyQuaternion(this.quat);
    // ground falling away faster than gravity can follow (crest / ramp lip): it's in the air
    if (ny < this.pos.y - 2 || (vyNew < this.vy - g * dt * 1.2 - 0.05 && this.v > 50)) {
      this.toAir(); this.vel.set(Math.sin(this.yaw) * this.v, this.vy, Math.cos(this.yaw) * this.v); return;
    }
    this.vy = vyNew;
    this.pos.set(nx, ny, nz);
    this.vel.set(Math.sin(this.yaw) * this.v, this.vy, Math.cos(this.yaw) * this.v);
    this.ang.set(0, yawRate, 0);
    for (const wh of this.wheels) wh.spin += this.v * dt / 0.35;
    if (L > g * 1.02 && this.v > 0) { this.toAir(); this.vel.y = Math.max(this.vy, 1); return; }
    // obstacles: trunks along the fuselage, buildings
    const hit = Math.max(this.collideTrees(1.3, [-4, 0, 4], 0.2, 0.3), this.collideBuildings(2.6));
    if (hit > 9) { this.crash('impact'); return; }
    if (hit > 0) { this.v = Math.min(this.v, 2); }
    this.keepInBounds();
    if (this.v > 3 && this.rot === 0) this.rememberSafe();
    this.slip = 0; this.drifting = false;
  }

  toAir() {
    this.mode = 'air'; this.grounded = false; this.contacts = 0; this.airTime = 0; this.stallT = 0;
    this.ang.set(0, 0, 0);
    for (const wh of this.wheels) { wh.contact = false; wh.comp = 0; }
  }

  // height of the lowest wheel above ground / water
  wheelsAGL() {
    const W = this.world; let low = Infinity;
    for (const [x, z] of GEAR) {
      _w.set(x, -GEAR_H, z).applyQuaternion(this.quat).add(this.pos);
      low = Math.min(low, _w.y - Math.max(W.heightAt(_w.x, _w.z), W.waterLevelAt(_w.x, _w.z)));
    }
    return low;
  }

  stepAir(dt, J, input) {
    const t = this.t, W = this.world, g = t.gravity;
    this.grounded = false; this.contacts = 0; this.airTime += dt;
    _up.set(0, 1, 0).applyQuaternion(this.quat);
    _fw.set(0, 0, 1).applyQuaternion(this.quat);
    _lt.set(1, 0, 0).applyQuaternion(this.quat);
    const s = this.vel.length(), q = s * s;
    const vF = this.vel.dot(_fw), vU = this.vel.dot(_up), vL = this.vel.dot(_lt);
    const alpha = vF > 1 ? Math.atan2(-vU, vF) : (s > 2 ? 1.2 : 0);
    const beta = Math.atan2(vL, Math.max(Math.abs(vF), 1));
    const bank = Math.atan2(_lt.y, _up.y);
    this.alpha = alpha; this.bank = bank;
    const auth = clamp(s / 70, 0.15, 1);

    // ------------------------------------------------ fly-by-wire: stick → g's → wanted angle of attack
    const path = Math.atan2(this.vel.y, Math.hypot(this.vel.x, this.vel.z));
    const base = clamp(Math.cos(path) / Math.max(0.5, Math.abs(Math.cos(bank))), 0, 2) * Math.sign(Math.cos(bank) || 1);
    let nCmd = J.pitch >= 0 ? base + J.pitch * (t.maxG - base) : base + J.pitch * (base - t.minG);
    const clNeed = nCmd * g / (t.liftK * Math.max(q, 100));
    // alpha limiter just below the stall, unless you yank the stick all the way back
    const aMax = J.pitch > 0.9 ? t.stallA + 0.14 : t.stallA - 0.03;
    let alphaT = clamp((clNeed - t.cl0) / t.clA, -0.3, aMax);
    // stalled: past the stall angle, or too slow to make the lift asked for even at the limit (mushing)
    const clMax0 = t.cl0 + t.clA * t.stallA;
    this.stall = alpha > t.stallA || (clNeed > clMax0 && nCmd > 0.5 && alpha > aMax - 0.05 && s < Math.sqrt(g / (t.liftK * clMax0)) * 1.05);
    this.stallT = this.stall ? this.stallT + dt : 0;
    if (this.stallT > 0.6) alphaT = Math.min(alphaT, t.stallA - 0.08);           // stalled a while: the nose drops
    // how fast the flight path itself is turning in the pitch plane (from the last step's acceleration)
    _v.copy(this.vel).divideScalar(Math.max(s, 1));
    _w.crossVectors(_v, _lt);                                                   // "up" square to the flight path
    const wPath = s > 5 ? this._acc.dot(_w) / s : 0;
    let pr = wPath + 5 * (alphaT - alpha) * auth;
    if (this.stall && this.stallT > 0.3) pr -= 0.3 + Math.max(0, alpha - t.stallA) * 2;
    pr = clamp(pr, -2.5, 2.5);
    let rr = J.roll * t.rollRate * auth;
    if (!J.roll && Math.abs(bank) < 1.2) rr = clamp(-bank * 0.8, -0.6, 0.6);  // gentle wings-level when you let go
    if (this.stall && this.stallT > 0.4) rr += Math.sin(this.airTime * 7) * 0.4; // wing rock
    const yr = -J.yaw * t.yawRate * auth + 3 * beta * Math.min(1, s / 40);
    _t.set(0, 0, 0).addScaledVector(_lt, -pr).addScaledVector(_fw, rr).addScaledVector(_up, yr);
    this.ang.lerp(_t, Math.min(1, 10 * dt));

    // ------------------------------------------------ forces
    const clMax = t.cl0 + t.clA * t.stallA;
    let cl = alpha < t.stallA ? Math.max(-0.9, t.cl0 + t.clA * alpha) : clMax * Math.max(0.35, 1 - (alpha - t.stallA) * 2.5);
    if (vF <= 1) cl = 0;
    let L = clamp(t.liftK * q * cl, t.minG * g * 1.2, t.maxG * g * 1.15);
    const clEff = q > 1 ? L / (t.liftK * q) : cl;
    const cd = t.cd0 + t.cdK * clEff * clEff + this.gear * 0.012 + (this.stall ? 0.15 : 0) + 0.4 * Math.sin(beta) ** 2;
    const D = t.liftK * q * cd;
    _a.set(0, -g, 0);
    if (s > 0.5) {
      _w.crossVectors(_v, _lt); const wl = _w.length();
      if (wl > 1e-3) _a.addScaledVector(_w, L / wl);
      _a.addScaledVector(_v, -D);
    }
    _a.addScaledVector(_fw, this.throttle * t.thrust);
    _a.addScaledVector(_lt, -vL * 0.8);
    this.gLoad = L / g;
    this.vel.addScaledVector(_a, dt);
    this._acc.copy(_a);
    this.pos.addScaledVector(this.vel, dt);
    this.edgeTurn();
    const am = this.ang.length();
    if (am > 1e-6) { _q.setFromAxisAngle(_v.copy(this.ang).divideScalar(am), am * dt); this.quat.premultiply(_q).normalize(); }
    this.slip = 0; this.drifting = false; this.steer += (J.yaw - this.steer) * Math.min(1, 6 * dt);
    for (const wh of this.wheels) { wh.contact = false; wh.spin *= 1 - dt; }

    // ------------------------------------------------ ground, trees, buildings
    const gh = W.heightAt(this.pos.x, this.pos.z);
    this.agl = this.pos.y - GEAR_H - Math.max(gh, W.waterLevelAt(this.pos.x, this.pos.z));
    const descent = -this.vel.y;
    this.pullUp = this.agl < 200 && descent > 3 && this.agl / descent < 5;
    if (this.airTime > 0.2 && this.wheelsAGL() < 0) {
      _up.set(0, 1, 0).applyQuaternion(this.quat); _fw.set(0, 0, 1).applyQuaternion(this.quat);
      const sink = -this.vel.y, kmh = s * 3.6, slide = Math.abs(this.vel.dot(_lt.set(1, 0, 0).applyQuaternion(this.quat)));
      const wet = W.waterLevelAt(this.pos.x, this.pos.z) > W.heightAt(this.pos.x, this.pos.z);
      if (!wet && _up.y > t.landUp && sink < t.landSink && _fw.y > -0.12 && kmh < t.landKmh && slide < 12 && this.gear > 0.8) this.land(sink);
      else this.crash(wet ? 'water' : sink >= t.landSink ? 'hard' : 'impact');
      return;
    }
    let scrape = 0;
    for (const [x, y, z] of BODY) {
      _w.set(x, y, z).applyQuaternion(this.quat).add(this.pos);
      const pen = W.heightAt(_w.x, _w.z) - 0.1 - _w.y;
      if (pen > 0) {
        // a tail scrape (nose high on take-off / landing, barely sinking) just bumps; anything else is a crash
        _up.set(0, 1, 0).applyQuaternion(this.quat);
        if (-this.vel.y < 4 && _up.y > 0.8 && z < -5) scrape = Math.max(scrape, pen);
        else { this.crash('impact'); return; }
      }
    }
    if (scrape) { this.pos.y += scrape; if (this.vel.y < 0) this.vel.y = 0; this.hit = Math.max(this.hit, 4); }
    if (this.agl < 45 && this.hitTree()) { this.crash('tree'); return; }
    if (this.agl < 120 && this.collideBuildings(3.5) > 0) { this.crash('building'); return; }
    this.keepInBounds(false);
  }

  // Turn before leaving the actual tile set, including its jagged edges and gaps.
  // Unloaded tiles still count as map: streaming delays must not cause false turnbacks.
  edgeTurn() {
    const W = this.world, p = this.pos, m = 8;
    const contains = W.mapContains || ((x, z, r = 0) => {
      const [x0, z0, x1, z1] = W.extent;
      return x >= x0 + r && x <= x1 - r && z >= z0 + r && z <= z1 - r;
    });
    const speed = Math.hypot(this.vel.x, this.vel.z), lead = 30 / (speed || 1);
    if (contains(p.x, p.z, m) && contains(p.x + this.vel.x * lead, p.z + this.vel.z * lead, m)) return;
    let turn = Math.PI;
    if (!contains(p.x, p.z, m)) {
      // Also recover saved/teleported positions already outside the map. Pick the nearest
      // tile interior, then face into it; don't repeatedly flip at a corner.
      const T = W.W?.tile;
      const boxes = T ? W.W.tiles.map(([tx, tz]) => [tx * T - T / 2, tz * T - T / 2, tx * T + T / 2, tz * T + T / 2]) : [W.extent];
      let best = null, d2 = Infinity;
      for (const [x0, z0, x1, z1] of boxes) {
        const x = clamp(p.x, x0 + 40, x1 - 40), z = clamp(p.z, z0 + 40, z1 - 40);
        const d = (x - p.x) ** 2 + (z - p.z) ** 2;
        if (d < d2) { d2 = d; best = [x, z, (x0 + x1) / 2, (z0 + z1) / 2]; }
      }
      if (!best) return;
      p.x = best[0]; p.z = best[1];
      turn = Math.atan2(best[2] - p.x, best[3] - p.z) - Math.atan2(this.vel.x, this.vel.z);
    }
    _q.setFromAxisAngle(_v.set(0, 1, 0), turn);
    this.quat.premultiply(_q); this.vel.applyQuaternion(_q); this._acc.applyQuaternion(_q); this.ang.applyQuaternion(_q);
    this.savePrev(); this.say('Edge of the map: turned back', 2);
  }

  land(sink) {
    _fw.set(0, 0, 1).applyQuaternion(this.quat);
    this.yaw = Math.atan2(_fw.x, _fw.z);
    this.v = Math.max(0, this.vel.x * Math.sin(this.yaw) + this.vel.z * Math.cos(this.yaw));
    this.mode = 'ground'; this.rot = clamp(Math.asin(clamp(_fw.y, -1, 1)), 0, 0.22); this.vy = 0;
    this.pos.y = this.groundPose(this.pos.x, this.pos.z, this.yaw, this.rot);
    this.landing = Math.min(1, sink / 9); this.stall = false; this.pullUp = false;
    if (this.airTime > 1.5) this.say(sink < 2.5 ? 'Smooth landing' : 'Landed', 2);   // not for every hop off a bump
  }

  // A wreck retains its impact momentum; the rotating body contacts the terrain and rebounds.
  stepWreck(dt) {
    this.crashT += dt; this.throttle = 0;
    this.vel.y -= this.t.gravity * dt;
    this.vel.multiplyScalar(Math.exp(-0.12 * dt));
    this.pos.addScaledVector(this.vel, dt);
    const spin = this.ang.length();
    if (spin > 1e-6) {
      _q.setFromAxisAngle(_v.copy(this.ang).divideScalar(spin), spin * dt);
      this.quat.premultiply(_q).normalize();
    }
    let penetration = -Infinity;
    for (const [x, y, z] of [[0, -0.7, 0], ...BODY]) {
      _w.set(x, y, z).applyQuaternion(this.quat).add(this.pos);
      penetration = Math.max(penetration, Math.max(this.world.heightAt(_w.x, _w.z), this.world.waterLevelAt(_w.x, _w.z)) - _w.y);
    }
    this.grounded = penetration > 0;
    if (this.grounded) {
      this.pos.y += penetration;
      const impact = Math.max(0, -this.vel.y);
      this.vel.y = impact > 1.5 ? impact * 0.48 : 0;
      this.vel.x *= 0.82; this.vel.z *= 0.82;
      this.ang.multiplyScalar(0.72);
      this.hit = impact;
    }
    this.ang.multiplyScalar(Math.exp(-0.22 * dt));
    this.edgeTurn();
    this.agl = Math.max(0, this.pos.y - this.world.heightAt(this.pos.x, this.pos.z));
  }

  crash(why) {
    if (this.mode === 'crashed') return;
    this.mode = 'crashed'; this.crashT = 0; this.burning = true; this.grounded = false;
    this.hit = Math.max(this.hit, 40); this.landing = 1;
    // Keep position and attitude at impact rather than teleporting to a flat wreck on the ground.
    this.vel.multiplyScalar(0.7);
    this.ang.set(1.8, 0.7, 2.4);
    this.throttle = 0; this.gear = 0;
    this.stall = false; this.pullUp = false;
    this.mesh.userData.wreck(true);
    this.say(why === 'water' ? 'Splash! Crashed into the water' : why === 'tree' ? 'Crashed into the trees!' :
      why === 'building' ? 'Crashed into a building!' : why === 'hard' ? 'Crashed: came down too hard' : 'Crashed!', 4.5);
  }

  // tree crowns (like the glider): cones for conifers, a ball-ish crown on broadleaf trees; wings reach 4.9 m
  hitTree() {
    const W = this.world; let hit = false;
    W.treesNear(this.pos.x, this.pos.z, 30, (tx, tz, tr, h, broad) => {
      if (hit || h === undefined) return;
      const y = this.pos.y - W.terrainAt(tx, tz);
      if (y > h + 1 || y < 0) return;
      const crown = broad ? (y > h * 0.3 ? h * 0.3 : tr) : h * 0.15 * (1 - y / h) + tr;
      if (Math.hypot(this.pos.x - tx, this.pos.z - tz) < crown + 4) hit = true;
    });
    return hit;
  }

  hudInfo() {
    if (this.mode === 'crashed') return 'CRASHED · back in a moment (R now)';
    const thr = `THR ${Math.round(this.throttle * 100)}%`;
    if (this.mode === 'ground') {
      const hint = this.v * 3.6 > this.t.rotateKmh ? ' · ↓ to lift the nose' : this.throttle < 0.3 && this.v < 3 ? ' · hold W to throttle up' : '';
      return `${thr} · on the ground${hint} · `;
    }
    const vs = this.vel.y;
    let h = `${thr} · ALT ${Math.max(0, Math.round(this.agl))} m · ${vs >= 0 ? '↑' : '↓'}${Math.abs(vs).toFixed(0)} m/s · ${this.gLoad.toFixed(1)} g`;
    if (this.stall) h += ' · <span style="color:#ff5a4a">STALL – nose down, more throttle</span>';
    else if (this.pullUp) h += ' · <span style="color:#ffb02e">PULL UP</span>';
    return h + ' · ';
  }

  syncMesh(dt) {
    const m = this.mesh, ud = m.userData;
    m.position.copy(this.renderPos); m.quaternion.copy(this.renderQuat);
    ud.setGear(this.gear);
    ud.flame.scale.set(1, 1, 0.3 + this.throttle * 1.4);
    ud.flame.material.opacity = 0.25 + this.throttle * 0.6;
    ud.flame.visible = this.mode !== 'crashed' && this.throttle > 0.02;
    ud.noseWheel.rotation.y = -this.steer * 0.5;
    // control surfaces for show
    const J = this.input?.jet || { pitch: 0, roll: 0, yaw: 0 };
    ud.elevator.rotation.x = -J.pitch * 0.35; ud.rudder.rotation.y = -J.yaw * 0.4;
    ud.aileronL.rotation.x = J.roll * 0.35; ud.aileronR.rotation.x = -J.roll * 0.35;
  }
}

// ---------------------------------------------------------------- model: a small swept-wing jet, white with orange
export function buildJetModel() {
  const root = new THREE.Group(); root.name = 'jet';
  const M = (c, o = {}) => new THREE.MeshLambertMaterial({ color: c, flatShading: true, ...o });
  const white = M(0xeef0f2), orange = M(0xff6a1a), dark = M(0x2a2e36), glass = M(0x1b3550, { emissive: 0x0a1a2a });
  white.userData.cosmeticRole = 'body'; orange.userData.cosmeticRole = 'trim';
  const add = (geo, mat, x = 0, y = 0, z = 0, parent = root) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };
  // fuselage: an 8-sided tube, tapered nose and tail
  const fus = new THREE.CylinderGeometry(0.75, 0.6, 9, 8).rotateX(Math.PI / 2); add(fus, white, 0, 0, -0.4);
  add(new THREE.ConeGeometry(0.75, 3.2, 8).rotateX(Math.PI / 2), white, 0, 0, 5.7);
  add(new THREE.ConeGeometry(0.22, 0.6, 8).rotateX(Math.PI / 2), dark, 0, 0, 7.4);
  add(new THREE.CylinderGeometry(0.62, 0.5, 1.0, 8).rotateX(Math.PI / 2), dark, 0, 0, -5.3);   // nozzle
  const canopy = add(new THREE.SphereGeometry(0.55, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), glass, 0, 0.45, 2.6);
  canopy.scale.set(0.9, 0.9, 2.6);
  add(new THREE.BoxGeometry(0.25, 0.05, 6), orange, 0, 0.74, -0.6);                          // spine stripe
  // swept wings (flat plates with a little thickness)
  const plate = (pts, thick) => {
    const sh = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, z)));
    return new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: false }).rotateX(Math.PI / 2).translate(0, thick / 2, 0);
  };
  const wing = plate([[0.6, 1.6], [4.9, -1.2], [4.9, -2.0], [0.6, -2.6]], 0.12);
  add(wing, white); add(wing.clone().scale(-1, 1, 1), white);
  add(new THREE.BoxGeometry(0.5, 0.13, 0.9), orange, 4.75, 0, -1.6); add(new THREE.BoxGeometry(0.5, 0.13, 0.9), orange, -4.75, 0, -1.6);
  const pivot = (x, y, z) => { const g = new THREE.Group(); g.position.set(x, y, z); root.add(g); return g; };
  const aileronL = pivot(3.2, 0, -2.2), aileronR = pivot(-3.2, 0, -2.2);
  add(new THREE.BoxGeometry(2.4, 0.08, 0.45), orange, 0, 0, -0.22, aileronL); add(new THREE.BoxGeometry(2.4, 0.08, 0.45), orange, 0, 0, -0.22, aileronR);
  const elevator = pivot(0, 0.1, -5.0);
  const tail = plate([[0.4, 0.8], [2.4, -0.6], [2.4, -1.1], [0.4, -1.0]], 0.08);
  add(tail, white, 0, 0, 0, elevator); add(tail.clone().scale(-1, 1, 1), white, 0, 0, 0, elevator);
  // fin + rudder
  const fin = new THREE.ExtrudeGeometry(new THREE.Shape([[0, 0], [-1.9, 0], [-2.4, 2.6], [-1.6, 2.6]].map(([z, y]) => new THREE.Vector2(z, y))), { depth: 0.1, bevelEnabled: false })
    .rotateY(Math.PI / 2).translate(-0.05, 0.4, -3.6);
  add(fin, white);
  const rudder = pivot(0, 0.5, -5.95);
  add(new THREE.BoxGeometry(0.1, 2.2, 0.5), orange, 0, 1.1, -0.2, rudder);
  // intakes
  for (const s of [1, -1]) add(new THREE.BoxGeometry(0.45, 0.7, 2.2), dark, s * 0.85, -0.15, 0.6);
  // exhaust flame
  const flame = add(new THREE.ConeGeometry(0.45, 2.2, 10, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -1.1),
    new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending }), 0, 0, -5.8);
  flame.castShadow = false;
  // landing gear: legs + wheels, folded away in flight
  const gearGroup = new THREE.Group(); root.add(gearGroup);
  const wheels = [];
  let noseWheel = null;
  for (const [i, [x, z]] of GEAR.entries()) {
    const leg = new THREE.Group(); leg.position.set(x, -0.3, z); gearGroup.add(leg);
    add(new THREE.CylinderGeometry(0.07, 0.07, 1.0, 6), dark, 0, -0.5, 0, leg);
    const holder = new THREE.Group(); holder.position.set(0, -GEAR_H + 0.35 + 0.3, 0); leg.add(holder);
    const spin = new THREE.Group(); holder.add(spin);
    add(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 10).rotateZ(Math.PI / 2), dark, 0, 0, 0, spin);
    if (i === 0) noseWheel = holder;
    wheels.push({ holder, spin, r: 0.35, front: i === 0, leg });
  }
  const setGear = k => {
    for (const w of wheels) { w.leg.scale.y = Math.max(0.05, k); w.leg.visible = k > 0.06; }
  };
  // wreck look: blackened and the flame out
  const mats = [white, orange];
  const base = mats.map(m => m.color.getHex());
  const wreck = on => {
    mats.forEach((m, i) => m.color.setHex(on ? 0x3a3a3a : base[i]));
    // Crumpled airframe, bent controls and shattered canopy remain attached while tumbling.
    root.scale.set(on ? 1.15 : 1, on ? 0.65 : 1, on ? 0.78 : 1);
    canopy.visible = !on;
    elevator.rotation.z = on ? 0.65 : 0;
    rudder.rotation.z = on ? -0.8 : 0;
    aileronL.rotation.z = on ? 1.1 : 0;
    aileronR.rotation.z = on ? -0.7 : 0;
  };
  root.userData = { wheels, setGear, flame, noseWheel, elevator, rudder, aileronL, aileronR, wreck, blob: [9.8, 13] };
  return root;
}
