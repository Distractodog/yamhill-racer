// Dirt bike. Fixed 120 Hz step like the car. Local axes: +z forward, +y up, +x = left.
//
// The physics body never rolls: it has a heading (yaw) and a pitch, held up by two suspension rays (front fork, rear
// shock) so it pitches over bumps, wheelies and lands through the springs. The lean you see is for show: it is the
// angle a real bike would need for the turn it's making (auto-balanced, it never falls over on its own).
// Horizontal handling is arcade, like the car: steering asks for a yaw rate (capped by grip), grip swings the
// velocity round to where the bike points. Most grip on trails / gravel / grass, less on asphalt, where it also
// reacts quicker to the bars (a bit twitchy). Space = rear brake slide. Shift (+ throttle) = wheelie. In the air
// W / S (or Shift) lean forward / back, and the bike slowly lines itself up with its flight path for the landing.
import * as THREE from 'three';
import { Vehicle } from './vehicle.js';

export const BIKE = {
  accel: 17,            // m/s² from standstill
  topSpeed: 230,        // km/h flat out on dirt / asphalt
  brakeDecel: 26,
  steerLock: 0.75,      // rad at walking pace (shrinks with speed)
  steerRate: 6,
  cornerGrip: 28,       // m/s² sideways grip on dirt
  turnResponse: 12,
  gripAlign: 14,
  slideAlign: 2.2,      // rear-brake slide: how fast it straightens up again
  springK: 18000, damping: 1500, travel: 0.3,
  gravity: 20,
  wheelie: 0.55,        // rad the front lifts to (on throttle)
  airPitch: 2.6,        // rad/s lean rate in the air
  skimSpeed: 70,        // km/h – faster skims across water
};
const GRIP = [0.95, 0.85, 1.0, 0.78, 1.0, 0.45, 0.8, 0.95];     // per surface class (asphalt 0.78: slides earlier)
const TWITCH = [1, 1, 1, 1.7, 1, 1, 1.6, 1];                    // how quickly the bars bite (asphalt / concrete twitchy)
const DRAG = [0.15, 0.35, 0, 0, 0.05, 5, 0, 0];                 // extra rolling drag, m/s²
const MASS = 180, IPITCH = 80, LF = 0.72, LR = -0.73, WB = LF - LR, RADIUS = 0.34;

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _n = new THREE.Vector3(), _c = new THREE.Vector3(),
  _F = new THREE.Vector3(), _up = new THREE.Vector3(), _fw = new THREE.Vector3(), _lt = new THREE.Vector3(),
  _nAvg = new THREE.Vector3(), _vp = new THREE.Vector3(), _hp = new THREE.Vector3(), _qy = new THREE.Quaternion(),
  _qp = new THREE.Quaternion(), _X = new THREE.Vector3(1, 0, 0), _Y = new THREE.Vector3(0, 1, 0);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export class Bike extends Vehicle {
  constructor(world, tuning = BIKE) {
    super(world, 'bike');
    this.name = 'Dirt bike'; this.t = tuning;
    this.yaw = 0; this.pitch = 0; this.pitchRate = 0; this.yawRate = 0; this.lean = 0;
    this.wheelie = false; this.wasGrounded = false; this.groundPitch = 0;
    this.wheels = [LF, LR].map(z => ({ z, front: z > 0, comp: 0, prevComp: 0, contact: false, surf: 0,
      contactPoint: new THREE.Vector3(), spin: 0 }));
    this.mesh = buildBikeModel();
    this.cam = { dist: 3.9, high: 1.45, distPerSpeed: 0.02, nose: [0, 1.25, -0.05] };
    this.half = { x: 0.45, front: 1.0, back: -1.05 };             // footprint for the challenge walls
  }

  setQuat() {
    _qy.setFromAxisAngle(_Y, this.yaw); _qp.setFromAxisAngle(_X, -this.pitch);
    this.quat.copy(_qy).multiply(_qp);
  }

  reset(x, z, yaw) {
    const h = this.world.heightAt(x, z);
    this.pos.set(x, h + 0.6, z); this.yaw = yaw; this.pitch = 0; this.pitchRate = 0; this.yawRate = 0;
    const W = this.world, hf = W.heightAt(x + Math.sin(yaw) * LF, z + Math.cos(yaw) * LF), hr = W.heightAt(x + Math.sin(yaw) * LR, z + Math.cos(yaw) * LR);
    this.pitch = Math.atan2(hf - hr, WB); this.pos.y = Math.max(hf, hr) + 0.58;
    this.setQuat(); this.vel.set(0, 0, 0); this.ang.set(0, 0, 0); this.steer = 0; this.drifting = false; this.lean = 0;
    for (const w of this.wheels) w.comp = w.prevComp = 0;
    this.afterReset();
  }

  step(dt, input) {
    const t = this.t, W = this.world, g = t.gravity;
    this._prevVel.copy(this.vel);
    this.setQuat();
    _up.set(0, 1, 0).applyQuaternion(this.quat);
    _fw.set(0, 0, 1).applyQuaternion(this.quat);
    _lt.set(1, 0, 0).applyQuaternion(this.quat);
    const speed = this.vel.length();
    const hSpeed = Math.hypot(this.vel.x, this.vel.z), skimming = hSpeed * 3.6 > t.skimSpeed;
    const reach = t.travel + RADIUS;

    // ------------------------------------------------ suspension: two rays along the body's down axis
    _F.set(0, -g * MASS, 0); _nAvg.set(0, 0, 0);
    let torque = 0, contacts = 0, near = 0, wet = 0, bottom = 0;
    for (const wh of this.wheels) {
      _w.copy(_fw).multiplyScalar(wh.z).add(this.pos);
      let gh = W.heightAt(_w.x, _w.z);
      const wl = W.waterLevelAt(_w.x, _w.z), onW = wl > gh;
      if (onW && skimming) gh = wl;
      W.normalAt(_w.x, _w.z, _n); if (onW && skimming) _n.set(0, 1, 0);
      const denom = _up.dot(_n);
      const dist = denom > 0.25 ? ((_w.y - gh) * _n.y) / denom : 99;
      wh.prevComp = wh.comp;
      if (dist < reach + 0.6) near++;
      if (dist < reach) {
        wh.contact = true; contacts++;
        wh.comp = Math.min(reach - dist, t.travel);
        bottom = Math.max(bottom, RADIUS - dist);                 // springs bottomed out: push the bike up
        const sc = W.surfaceAt(_w.x, _w.z);
        wh.surf = onW ? 5 : (sc === 5 ? 0 : sc); if (onW) wet++;
        const Fz = Math.max(0, t.springK * wh.comp + t.damping * (wh.comp - wh.prevComp) / dt);
        _F.addScaledVector(_up, Fz);
        torque += Fz * wh.z;                                      // + = nose up
        wh.contactPoint.copy(_w).addScaledVector(_up, -dist);
        _nAvg.add(_n);
      } else { wh.contact = false; wh.comp = 0; }
    }
    this.contacts = contacts; this.grounded = contacts > 0;
    const rear = this.wheels[1].contact, front = this.wheels[0].contact;
    if (contacts) {
      _nAvg.normalize();
      const s = W.surfaceAt(this.pos.x, this.pos.z); this.surface = wet ? 5 : (s === 5 ? 0 : s);
    } else _nAvg.set(0, 1, 0);
    this.onWater = wet > 0;
    // the ground's pitch under the bike (wheelie / landing reference)
    const hx = Math.sin(this.yaw), hz = Math.cos(this.yaw);
    this.groundPitch = Math.atan2(W.heightAt(this.pos.x + hx * LF, this.pos.z + hz * LF) - W.heightAt(this.pos.x + hx * LR, this.pos.z + hz * LR), WB);

    // ------------------------------------------------ water
    const wlC = W.waterLevelAt(this.pos.x, this.pos.z);
    this.waterDepth = Math.max(0, wlC - (this.pos.y - 0.45));
    if (this.waterDepth > 0) {
      const sub = Math.min(1, this.waterDepth / 0.8);
      _F.y += g * MASS * sub * 0.6;
      _F.x -= this.vel.x * MASS * 1.6 * sub; _F.z -= this.vel.z * MASS * 1.6 * sub; _F.y -= this.vel.y * MASS * 2.5 * sub;
    }
    if (this.onWater) _F.addScaledVector(this.vel, -MASS * 0.4);

    // ------------------------------------------------ pitch: springs + wheelie + air lean + auto-balance
    const rel = this.pitch - this.groundPitch;
        this.wheelie = false;
    if (contacts) {
      if (input.lean && rear) {                                   // wheelie: hold the front up at a set angle
        const target = (input.throttle ? t.wheelie : t.wheelie * 0.55);
        torque += (9000 * (target - rel) - 1100 * this.pitchRate);
        this.wheelie = !front;
      }
      if (rel > 0.95) torque -= 20000 * (rel - 0.95) + 2000 * Math.max(0, this.pitchRate);    // never loops over
      if (rel < -0.6) torque += 20000 * (-0.6 - rel) - 2000 * Math.min(0, this.pitchRate);
      this.pitchRate += torque / IPITCH * dt;
      this.pitchRate *= 1 - Math.min(1, 1.5 * dt);
    } else {
      // keys already held at take-off don't lean you (you're still on the gas from the run-up); press them again
      if (!input.throttle) this.heldGas = false; else if (this.airTime < 0.3) this.heldGas = true;
      if (!input.brake) this.heldBrake = false; else if (this.airTime < 0.3) this.heldBrake = true;
      const fwd = this.heldGas ? 0 : input.throttle, back = Math.max(this.heldBrake ? 0 : input.brake, input.lean ? 1 : 0);
      const want = (back - fwd) * t.airPitch;
      // hands off: slowly line up with the flight path (so jumps land on both wheels)
      const path = Math.atan2(this.vel.y, Math.max(hSpeed, 1));
      const assist = (fwd || back) ? 0 : clamp((path * 0.8 - this.pitch) * 2.2, -1.5, 1.5);
      this.pitchRate += (want + assist - this.pitchRate) * Math.min(1, 5 * dt);
    }

    // ------------------------------------------------ steering (bars)
    const surfTwitch = contacts ? TWITCH[this.surface] : 1;
    const rate = (Math.sign(input.steer) !== Math.sign(this.steer) || !input.steer ? 1.6 : 1) * t.steerRate * surfTwitch;
    this.steer += Math.sign(input.steer - this.steer) * Math.min(Math.abs(input.steer - this.steer), rate * dt);

    this.vel.addScaledVector(_F, dt / MASS);

    // ------------------------------------------------ arcade riding on the ground
    if (contacts) {
      const grip = GRIP[this.surface], k = contacts / 2, n = _nAvg;
      _hp.copy(_fw).addScaledVector(n, -_fw.dot(n)).normalize();
      _vp.copy(this.vel).addScaledVector(n, -this.vel.dot(n));
      const vPlane = _vp.length(), vf = _vp.dot(_hp), reversing = vf < -0.5;
      let beta = 0;
      if (vPlane > 2) { _v.copy(_vp).multiplyScalar((reversing ? -1 : 1) / vPlane); beta = Math.atan2(_c.crossVectors(_v, _hp).dot(n), _v.dot(_hp)); }
      this.slipSigned = beta; this.slip = Math.abs(beta);
      this.drifting = !!input.handbrake && vf > 5 && rear;
      // yaw rate from the bars, capped by grip; a front wheel in the air steers nothing
      const lock = t.steerLock / (1 + Math.abs(vf) / 16);
      const kin = vf * Math.tan(this.steer * lock) / WB;
      const cap = t.cornerGrip * grip / Math.max(Math.abs(vf), 0.5);
      let wT = -Math.sign(kin) * Math.min(Math.abs(kin), cap * (this.drifting ? 1.7 : 1));
      if (!front) wT *= 0.25;
      this.yawRate += (wT - this.yawRate) * Math.min(1, t.turnResponse * surfTwitch * dt) * k;
      // grip: swing the velocity round to where the bike points (slowly while sliding)
      if (vPlane > 0.3) {
        const align = (this.drifting ? t.slideAlign : t.gripAlign) * grip;
        let turn = beta * (1 - Math.exp(-align * dt));
        if (!this.drifting) { const c = t.cornerGrip * grip * 1.15 / vPlane * dt; turn = clamp(turn, -c, c); }
        _vp.applyAxisAngle(n, turn * k);
        _vp.multiplyScalar(1 - Math.min(0.5, 0.3 * Math.abs(Math.sin(beta)) * dt * k));
      }
      if (!this.drifting) {                                        // tyres resist sliding down a side slope
        _c.crossVectors(n, _hp);
        const lat = _vp.dot(_c), lim = t.cornerGrip * grip * 1.2 * dt;
        _vp.addScaledVector(_c, -clamp(lat, -lim, lim) * k);
      }
      // engine, brakes, drag (only the rear wheel drives)
      const vmax = t.topSpeed / 3.6 * 1.02;
      let a = 0;
      if (input.throttle > 0 && rear) a = reversing ? t.brakeDecel * input.throttle : input.throttle * t.accel * Math.max(0, 1 - (vf / vmax) ** 2);
      if (input.brake > 0) { if (vf > 1) a -= t.brakeDecel * input.brake * (front ? 1 : 0.5); else if (vf > -6) a -= input.brake * 6; }
      if (this.drifting) a -= Math.sign(vf) * Math.min(Math.abs(vf) / dt, 5);
      if (!input.throttle && !input.brake && Math.abs(vf) < 1.5) a -= Math.sign(vf) * Math.min(Math.abs(vf) / dt, 8);
      a -= (DRAG[this.surface] + (input.throttle || input.brake ? 0 : 1.0)) * Math.sign(vf) * Math.min(1, Math.abs(vf));
      _vp.addScaledVector(_hp, a * dt * k);
      const vN = this.vel.dot(n);
      this.vel.copy(_vp).addScaledVector(n, vN);
    } else {
      this.slip = 0; this.drifting = false;
      this.yawRate += (-input.steer * 1.2 - this.yawRate) * Math.min(1, 3 * dt);
    }

    // ground snap over small crests; landing check
    const firm = contacts === 2;
    if (!contacts && this.wasGrounded && near >= 1 && this.vel.y < 5) this.vel.y -= 50 * dt;
    if (contacts && this.airTime > 0.25) {
      const sink = -this._prevVel.y, rel2 = this.pitch - this.groundPitch;
      if (Math.abs(rel2) > 1.0 || sink > 32) this.bail();
      else this.landing = Math.min(1, sink / 18);
    }
    if (contacts) { this.heldGas = input.throttle > 0; this.heldBrake = input.brake > 0; }
    this.wasGrounded = contacts > 0;
    this.airTime = contacts ? 0 : this.airTime + dt;

    // air drag (light; top speed is mostly the engine limit)
    this.vel.addScaledVector(this.vel, -0.00012 * speed * dt);

    // ------------------------------------------------ integrate
    this.pos.addScaledVector(this.vel, dt);
    this.yaw += this.yawRate * dt;
    this.pitch = clamp(this.pitch + this.pitchRate * dt, -1.2, 1.2);
    this.setQuat();
    this.ang.set(0, this.yawRate, 0);

    // bottomed-out springs / body in the ground: push up, kill the speed into the ground
    if (bottom > 0) {
      this.pos.addScaledVector(_nAvg, bottom);
      const vn = this.vel.dot(_nAvg); if (vn < 0) { this.vel.addScaledVector(_nAvg, -vn); this.hit = Math.max(this.hit, -vn * 0.4); }
    }
    const gC = W.heightAt(this.pos.x, this.pos.z);
    if (this.pos.y < gC + 0.25) {                                // the body itself hit the ground
      this.pos.y = gC + 0.25; if (this.vel.y < 0) this.vel.y = 0;
      if (Math.abs(this.pitch - this.groundPitch) > 0.6) this.bail(); else this.pitchRate += (this.groundPitch - this.pitch) * 8 * dt;
    }

    if (this.waterDepth > 0.4 && speed < 2.5) this.stuck += dt; else this.stuck = 0;
    if (this.stuck > 3) { this.stuck = 0; this.resetToSafe(); return; }

    this.hit = 0;
    const tr = this.collideTrees(0.45, [-0.6, 0.0, 0.6]);
    if (tr > 0) { this.drifting = false; this.yawRate *= 0.5; }
    this.collideBuildings(0.7);
    this.keepInBounds();

    this.trackAccel(dt);
    for (const wh of this.wheels) wh.spin += this.vel.dot(_fw) * dt / RADIUS;
    // the lean a real bike would need for this turn (+ = leaning right)
    const vf = this.vel.dot(_fw);
    const want = contacts ? clamp(-Math.atan2(vf * this.yawRate, g * 0.6), -0.85, 0.85) : this.lean * 0.98;
    this.lean += (want - this.lean) * Math.min(1, 8 * dt);
    if (firm && speed > 3 && !this.drifting && !this.onWater && !this.waterDepth && Math.abs(this.pitch - this.groundPitch) < 0.2) this.rememberSafe();
  }

  // a landing too far off the ground's angle: the rider puts a foot down, bike scrubs most of its speed
  bail() {
    this.vel.multiplyScalar(0.35); this.pitch = this.groundPitch; this.pitchRate = 0;
    this.hit = Math.max(this.hit, 20); this.landing = 1;
    this.say('Bail! Rough landing', 1.8);
  }

  hudInfo() {
    return `${this.wheelie ? 'WHEELIE · ' : ''}${this.drifting ? 'SLIDE · ' : ''}`;
  }

  syncMesh(dt) {
    const m = this.mesh, ud = m.userData;
    m.position.copy(this.renderPos); m.quaternion.copy(this.renderQuat);
    ud.lean.rotation.z = this.lean;
    ud.bars.rotation.y = -this.steer * 0.45;
    this.wheels.forEach((wh, i) => {
      const w = ud.wheels[i];
      w.holder.position.y = -(this.t.travel - (wh.contact ? wh.comp : 0));
      w.spin.rotation.x = wh.spin;
    });
    ud.rider.rotation.x = clamp(-this.pitchRate * 0.05 + (this.wheelie ? -0.15 : 0.12), -0.35, 0.35);
  }
}

// ---------------------------------------------------------------- model
// low-poly motocross bike + rider. Origin = centre of mass (~0.56 m above the ground at rest); the lean group pivots
// on the ground line so the bike tips over its tyres.
export function buildBikeModel() {
  const root = new THREE.Group(); root.name = 'bike';
  const lean = new THREE.Group(); lean.position.y = -0.54; root.add(lean);
  const body = new THREE.Group(); body.position.y = 0.54; lean.add(body);
  const M = c => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
  const orange = M(0xff7a1a), black = M(0x1d1f24), grey = M(0x8a9099), white = M(0xf2f2ee), blue = M(0x2a5bd7), skin = M(0xd9a27a);
  const box = (w, h, d, mat, x, y, z, rx = 0, parent = body) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.rotation.x = rx;
    m.castShadow = true; parent.add(m); return m;
  };
  // frame, tank, seat, side panels, fenders, engine, exhaust
  box(0.12, 0.1, 0.9, grey, 0, 0.05, -0.05, 0.25);
  box(0.36, 0.22, 0.5, orange, 0, 0.3, 0.22, -0.12);            // tank / shrouds
  box(0.28, 0.08, 0.75, black, 0, 0.36, -0.28, 0.05);           // seat
  box(0.34, 0.2, 0.36, white, 0, 0.2, -0.45, 0.2);              // side panel with number plate
  box(0.18, 0.04, 0.55, orange, 0, 0.42, -0.72, -0.35);         // rear fender
  box(0.16, 0.04, 0.42, orange, 0, 0.14, 0.86, 0.25);           // front fender
  box(0.26, 0.26, 0.3, grey, 0, -0.08, 0.05);                   // engine
  box(0.08, 0.08, 0.6, grey, -0.16, 0.12, -0.4, -0.25);         // exhaust
  // front fork + bars (steer with the bars group)
  const bars = new THREE.Group(); bars.position.set(0, 0.42, 0.5); bars.rotation.x = -0.45; body.add(bars);
  box(0.05, 0.75, 0.05, grey, 0.09, -0.32, 0, 0, bars); box(0.05, 0.75, 0.05, grey, -0.09, -0.32, 0, 0, bars);
  box(0.72, 0.04, 0.04, black, 0, 0.08, 0, 0, bars);
  box(0.22, 0.16, 0.04, white, 0, -0.02, 0.06, 0, bars);        // number board
  // wheels
  const wheels = [];
  for (const [z, front] of [[0.72, true], [-0.73, false]]) {
    const holder = new THREE.Group(); holder.position.set(0, -0.2, z); body.add(holder);
    const spin = new THREE.Group(); holder.add(spin);
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, front ? 0.11 : 0.14, 12).rotateZ(Math.PI / 2), black);
    tyre.castShadow = true; spin.add(tyre);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.16, 8).rotateZ(Math.PI / 2), grey); spin.add(hub);
    for (let k = 0; k < 4; k++) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.5, 0.02), grey); s.rotation.x = k * Math.PI / 4; spin.add(s); }
    wheels.push({ holder, spin, r: 0.34, front, restY: -0.2 });
  }
  // rider: legs, torso, arms, helmet
  const rider = new THREE.Group(); rider.position.set(0, 0.42, -0.2); body.add(rider);
  for (const s of [1, -1]) {
    box(0.13, 0.42, 0.14, blue, s * 0.17, -0.05, 0.12, 0.9, rider);     // thigh
    box(0.12, 0.42, 0.12, black, s * 0.2, -0.3, 0.3, -0.2, rider);       // shin + boot
    box(0.1, 0.4, 0.1, white, s * 0.24, 0.42, 0.33, -1.0, rider);        // arm
    box(0.09, 0.09, 0.09, black, s * 0.3, 0.3, 0.6, 0, rider);           // glove
  }
  box(0.4, 0.55, 0.26, white, 0, 0.42, 0.05, 0.35, rider);              // jersey
  box(0.3, 0.12, 0.2, orange, 0, 0.55, 0.12, 0.35, rider);              // stripe
  const helmet = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 1), orange); helmet.position.set(0, 0.82, 0.24);
  helmet.castShadow = true; rider.add(helmet);
  box(0.22, 0.08, 0.14, black, 0, 0.8, 0.38, 0, rider);                 // goggles
  box(0.12, 0.06, 0.16, orange, 0, 0.7, 0.42, 0.4, rider);              // chin guard
  root.userData = { lean, bars, wheels, rider, blob: [0.9, 2.0] };
  return root;
}
