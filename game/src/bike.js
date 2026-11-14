// Dirt bike. Fixed 120 Hz step like the car. Local axes: +z forward, +y up, +x = left.
//
// The physics body has a heading (yaw) and a pitch, held up by two suspension rays (fork + shock), so it pitches
// over bumps, wheelies, stoppies and soaks up landings through the springs. It never falls over: lean is its own
// state, but auto-balanced.
//   * Lean: the bars ask for a lean (more the faster you go, none at walking pace); the bike tips in and out
//     smoothly, and the lean is what turns it (yaw rate = g·tan(lean) / speed), so a turn tightens as you lean in.
//     At walking pace the bars steer directly.
//   * Grip: past the tyres' grip a loose surface (dirt, gravel, grass, forest) lets the rear step out; on throttle
//     while leaned it steps out on purpose (power slide: hold it with the gas, catch it by letting off or steering
//     into it). Asphalt grips harder, but asked for too much the front washes wide (scrubs speed, no crash).
//     Space = rear-brake slide.
//   * Bumps: grass, forest floor, gravel and trails have small bumps the suspension rides over (asphalt is smooth).
//   * Shift = wheelie: W lifts the front, let off and it drops, so you balance it with taps of the throttle. Braking
//     hard from speed lifts the rear a little (stoppie). Both are capped so it never loops or flips.
//   * Air: W / S (or Shift) lean forward / back (keys held from the take-off don't count), A / D turn the bike in the
//     air (scrub); hands off it slowly lines up with its flight path. Landing far off line is a bail.
import * as THREE from 'three';
import { Vehicle } from './vehicle.js';

export const BIKE = {
  accel: 20,            // m/s² from standstill
  topSpeed: 230,        // km/h flat out on trail / asphalt
  brakeDecel: 26,
  steerLock: 0.6,       // rad of bar at walking pace
  steerRate: 5,
  maxLean: 1.0,         // rad (~57°) at speed: full lock asks a bit more than asphalt's grip (front washes)
  leanSpring: 40, leanDamp: 11,   // how quickly it tips in / out
  cornerGrip: 24,       // m/s² sideways grip on trail (× GRIP per surface)
  turnResponse: 10,
  gripAlign: 12,        // how quickly the slide straightens when you're not asking for one
  powerSlide: 1.6,      // rad/s of extra rotation from throttle in a leaned turn on loose ground
  slideAlign: 2.0,      // rear-brake slide: how fast it straightens up again
  springK: 15000, damping: 1250, travel: 0.32,       // fork; the shock is 25% stiffer
  gravity: 17,          // lighter than the car's 24: floatier jumps
  wheelie: 0.6,         // rad: the front's balance point in a wheelie
  airPitch: 2.6,        // rad/s lean rate in the air
  airYaw: 1.6,          // rad/s turn in the air
  skimSpeed: 70,        // km/h – faster skims across water
};
// per surface class: grass, forest floor, trail, asphalt, gravel, water, concrete, running track
const GRIP = [0.9, 0.8, 1.0, 1.05, 0.95, 0.45, 1.05, 1.05];     // asphalt grips most…
const LOOSE = [1, 1, 1, 0, 1, 1, 0, 0.3];                      // …but only loose ground lets the rear step out
const DRAG = [1.4, 3.0, 0, 0, 0.3, 5, 0, 0];                   // extra rolling drag, m/s² (grass / forest are slower)
const BUMP = [0.04, 0.06, 0.02, 0, 0.03, 0, 0, 0.01];        // bump height, m
const MASS = 180, IPITCH = 80, LF = 0.72, LR = -0.73, WB = LF - LR, RADIUS = 0.34;

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _n = new THREE.Vector3(), _c = new THREE.Vector3(),
  _F = new THREE.Vector3(), _up = new THREE.Vector3(), _fw = new THREE.Vector3(), _lt = new THREE.Vector3(),
  _nAvg = new THREE.Vector3(), _vp = new THREE.Vector3(), _hp = new THREE.Vector3(), _qy = new THREE.Quaternion(),
  _qp = new THREE.Quaternion(), _X = new THREE.Vector3(1, 0, 0), _Y = new THREE.Vector3(0, 1, 0);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// small bumps in the ground the tyres ride over (-1..1, ~1–3 m apart); same everywhere for every ride
const bumps = (x, z) => 0.55 * Math.sin(x * 2.3 + z * 1.1) * Math.sin(z * 2.9 - x * 0.7) + 0.45 * Math.sin(x * 4.7 - z * 3.9 + 1.3);

export class Bike extends Vehicle {
  constructor(world, tuning = BIKE) {
    super(world, 'bike');
    this.name = 'Dirt bike'; this.t = tuning;
    this.yaw = 0; this.pitch = 0; this.pitchRate = 0; this.yawRate = 0; this.lean = 0; this.leanRate = 0;
    this.washout = false; this.stoppie = false;
    this.wheelie = false; this.wasGrounded = false; this.groundPitch = 0;
    this.wheels = [LF, LR].map(z => ({ z, front: z > 0, comp: 0, prevComp: 0, contact: false, surf: 0,
      contactPoint: new THREE.Vector3(), spin: 0 }));
    this.mesh = buildBikeModel();
    this.cam = { dist: 3.9, high: 1.45, distPerSpeed: 0.02, nose: [0, 1.25, -0.05], roll: 0.18 };   // roll: camera leans with the bike
    this.half = { x: 0.45, front: 1.0, back: -1.05 };             // footprint for the challenge walls
  }

  setQuat() {
    _qy.setFromAxisAngle(_Y, this.yaw); _qp.setFromAxisAngle(_X, -this.pitch);
    this.quat.copy(_qy).multiply(_qp);
  }

  reset(x, z, yaw) {
    this.glide?.cancel();
    const h = this.world.heightAt(x, z);
    this.pos.set(x, h + 0.6, z); this.yaw = yaw; this.pitch = 0; this.pitchRate = 0; this.yawRate = 0;
    const W = this.world, hf = W.heightAt(x + Math.sin(yaw) * LF, z + Math.cos(yaw) * LF), hr = W.heightAt(x + Math.sin(yaw) * LR, z + Math.cos(yaw) * LR);
    this.pitch = Math.atan2(hf - hr, WB); this.pos.y = Math.max(hf, hr) + 0.58;
    this.setQuat(); this.vel.set(0, 0, 0); this.ang.set(0, 0, 0); this.steer = 0; this.drifting = false; this.lean = 0; this.leanRate = 0;
    for (const w of this.wheels) w.comp = w.prevComp = 0;
    this.afterReset();
  }

  step(dt, input) {
    if (this.glide?.active) { this.glide.step(dt, input); return; }     // flying under the glider (glider.js)
    const t = this.t, W = this.world, g = t.gravity;
    this._prevVel.copy(this.vel);
    this.setQuat();
    _up.set(0, 1, 0).applyQuaternion(this.quat);
    _fw.set(0, 0, 1).applyQuaternion(this.quat);
    _lt.set(1, 0, 0).applyQuaternion(this.quat);
    const speed = this.vel.length();
    const hSpeed = Math.hypot(this.vel.x, this.vel.z), skimming = hSpeed * 3.6 > t.skimSpeed;
    const reach = t.travel + RADIUS;

    // ------------------------------------------------ suspension: two rays along the body's down axis (+ bumps)
    _F.set(0, -g * MASS, 0); _nAvg.set(0, 0, 0);
    let torque = 0, contacts = 0, near = 0, wet = 0, bottom = 0;
    for (const wh of this.wheels) {
      _w.copy(_fw).multiplyScalar(wh.z).add(this.pos);
      let gh = W.heightAt(_w.x, _w.z);
      const wl = W.waterLevelAt(_w.x, _w.z), onW = wl > gh;
      const sc = W.surfaceAt(_w.x, _w.z);
      if (onW && skimming) gh = wl; else if (!onW) gh += bumps(_w.x, _w.z) * BUMP[sc];
      W.normalAt(_w.x, _w.z, _n); if (onW && skimming) _n.set(0, 1, 0);
      const denom = _up.dot(_n);
      const dist = denom > 0.25 ? ((_w.y - gh) * _n.y) / denom : 99;
      wh.prevComp = wh.comp;
      if (dist < reach + 0.6) near++;
      if (dist < reach) {
        wh.contact = true; contacts++;
        wh.comp = Math.min(reach - dist, t.travel);
        bottom = Math.max(bottom, RADIUS - dist);                 // springs bottomed out: push the bike up
        wh.surf = onW ? 5 : (sc === 5 ? 0 : sc); if (onW) wet++;
        const stiff = wh.front ? 1 : 1.25;
        const Fz = Math.max(0, t.springK * stiff * wh.comp + t.damping * stiff * (wh.comp - wh.prevComp) / dt);
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

    // ------------------------------------------------ bars
    const rate = (Math.sign(input.steer) !== Math.sign(this.steer) || !input.steer ? 1.8 : 1) * t.steerRate;
    this.steer += Math.sign(input.steer - this.steer) * Math.min(Math.abs(input.steer - this.steer), rate * dt);
    const vfNow = this.vel.dot(_fw);

    // ------------------------------------------------ pitch: springs + wheelie / stoppie + air lean + auto-balance
    const rel = this.pitch - this.groundPitch;
    this.wheelie = false; this.stoppie = false;
    if (contacts) {
      if (input.lean && rear && vfNow > -1) {
        // wheelie: gas lifts the front (more the further down it is), off the gas it falls back; balance point = t.wheelie
        const lift = input.throttle ? Math.max(0, 2500 + 7000 * (t.wheelie - rel)) : 0;
        torque += lift - 900 * this.pitchRate * (input.throttle ? 0.6 : 1);
        this.wheelie = !front;
      }
      // stoppie: hard on the brakes from speed, the rear comes up a little
      if (input.brake && !input.lean && front && vfNow > 8) {
        const want = -Math.min(0.32, 0.25 * input.brake * Math.min(1, (vfNow - 8) / 15));
        torque += 9000 * (want - rel) - 800 * this.pitchRate;
        this.stoppie = !rear;
      }
      if (rel > 1.0) torque -= 20000 * (rel - 1.0) + 2500 * Math.max(0, this.pitchRate);    // never loops over
      if (rel < -0.4) torque += 20000 * (-0.4 - rel) - 2500 * Math.min(0, this.pitchRate);  // never goes over the bars
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

    this.vel.addScaledVector(_F, dt / MASS);

    // ------------------------------------------------ riding on the ground: lean → turn, grip, slides
    let leanWant;
    if (contacts) {
      const n = _nAvg, k = contacts / 2, grip = GRIP[this.surface], loose = LOOSE[this.surface];
      _hp.copy(_fw).addScaledVector(n, -_fw.dot(n)).normalize();
      _vp.copy(this.vel).addScaledVector(n, -this.vel.dot(n));
      const vPlane = _vp.length(), vf = _vp.dot(_hp), reversing = vf < -0.5, av = Math.abs(vf);
      let beta = 0;                                                // slip: + = nose rotated left of where it's going
      if (vPlane > 2) { _v.copy(_vp).multiplyScalar((reversing ? -1 : 1) / vPlane); beta = Math.atan2(_c.crossVectors(_v, _hp).dot(n), _v.dot(_hp)); }
      // the lean the bars ask for: none at walking pace, up to maxLean from ~60 km/h
      const leanMax = t.maxLean * clamp((av - 2) / 14, 0, 1);
      leanWant = this.steer * leanMax;
      // turn rate: from the lean at speed, straight from the bars at walking pace
      const wLean = -Math.sign(vf) * g * Math.tan(this.lean) / Math.max(av, 3);
      const wBars = -vf * Math.tan(this.steer * t.steerLock) / WB;
      const b = clamp((av - 3) / 6, 0, 1);
      let wT = wBars * (1 - b) + wLean * b;
      // grip limit: sideways acceleration the tyres can hold
      const gripA = t.cornerGrip * grip, latA = Math.abs(vf * wT);
      this.washout = false;
      if (latA > gripA && av > 4) {
        if (loose < 0.5) {                                         // asphalt: the front washes wide, speed scrubs off
          wT *= gripA / latA; this.washout = true;
        } else wT *= 1 - 0.35 * (1 - gripA / latA);               // dirt: it turns, but the rear lets go (below)
      }
      // power slide: gas in a leaned turn on loose ground rotates the bike further into the turn
      const slideIn = loose * input.throttle * clamp((Math.abs(this.lean) - 0.15) / 0.35, 0, 1) * clamp((av - 5) / 8, 0, 1)
        * Math.max(0, 1 - (vf / (t.topSpeed / 3.6)) ** 2);        // only while the engine still has push (not flat out)
      wT += -Math.sign(this.lean) * t.powerSlide * slideIn;
      this.drifting = !!input.handbrake && vf > 5 && rear;
      if (this.drifting) wT += -this.steer * 1.2;                  // rear brake: swing it round with the bars
      if (!front) wT *= 0.3;                                       // front in the air steers little
      // a slide never goes past ~45°: past that the rear is pulled back in
      if (Math.abs(beta) > 0.75) wT -= Math.sign(beta) * (Math.abs(beta) - 0.75) * 6;
      this.yawRate += (wT - this.yawRate) * Math.min(1, t.turnResponse * dt) * k;
      // the velocity follows the nose: fast with grip, slowly while sliding
      if (vPlane > 0.3) {
        let align = t.gripAlign * grip;
        if (this.drifting) align = t.slideAlign;
        else if (loose > 0.5 && latA > gripA) align *= 0.35;       // past the grip on dirt: it slides
        if (slideIn > 0.05) align *= 0.35 / (0.35 + slideIn);      // on the gas: the slide holds
        if (this.steer * beta > 0.05 && !this.drifting) align *= 2; // steering into the slide catches it
        if (!input.throttle && !this.drifting) align *= 1.4;       // off the gas: it hooks up
        const turn = beta * (1 - Math.exp(-align * dt));
        _vp.applyAxisAngle(n, turn * k);
        _vp.multiplyScalar(1 - Math.min(0.5, (0.35 * Math.abs(Math.sin(beta)) + (this.washout ? 0.25 : 0)) * dt * k));
      }
      this.slipSigned = beta; this.slip = Math.abs(beta);
      if (!this.drifting && this.slip < 0.15) {                    // tyres resist sliding down a side slope
        _c.crossVectors(n, _hp);
        const lat = _vp.dot(_c), lim = gripA * 1.2 * dt;
        _vp.addScaledVector(_c, -clamp(lat, -lim, lim) * k);
      }
      // engine (rear wheel), brakes, drag
      const vmax = t.topSpeed / 3.6 * 1.02;
      let a = 0;
      if (input.throttle > 0 && rear) a = reversing ? t.brakeDecel * input.throttle : input.throttle * t.accel * Math.max(0, 1 - (vf / vmax) ** 2) * (1 - 0.3 * this.slip);
      if (input.brake > 0) { if (vf > 1) a -= t.brakeDecel * input.brake * (front ? 1 : 0.4); else if (vf > -6) a -= input.brake * 6; }
      if (this.drifting) a -= Math.sign(vf) * Math.min(av / dt, 5);
      if (!input.throttle && !input.brake && av < 1.5) a -= Math.sign(vf) * Math.min(av / dt, 8);
      a -= (DRAG[this.surface] + (input.throttle || input.brake ? 0 : 1.0)) * Math.sign(vf) * Math.min(1, av);
      _vp.addScaledVector(_hp, a * dt * k);
      const vN = this.vel.dot(n);
      this.vel.copy(_vp).addScaledVector(n, vN);
    } else {
      this.slip = 0; this.drifting = false; this.washout = false;
      // in the air A / D turn the bike (and lay it over a little: a scrub); the bars centre
      this.yawRate += (-input.steer * t.airYaw - this.yawRate) * Math.min(1, 3 * dt);
      leanWant = input.steer * 0.5;
    }
    // lean: a damped spring toward what's asked (tips in and out smoothly)
    this.leanRate += ((leanWant - this.lean) * t.leanSpring - this.leanRate * t.leanDamp) * dt;
    this.lean = clamp(this.lean + this.leanRate * dt, -1.05, 1.05);

    // ground snap over small crests; landing check
    const firm = contacts === 2;
    if (!contacts && this.wasGrounded && near >= 1 && this.vel.y < 4) this.vel.y -= 40 * dt;
    if (contacts && this.airTime > 0.25) {
      const sink = -this._prevVel.y, rel2 = this.pitch - this.groundPitch;
      let yawOff = 0;
      if (hSpeed > 8) { yawOff = Math.atan2(this.vel.x, this.vel.z) - this.yaw; yawOff = Math.abs(Math.atan2(Math.sin(yawOff), Math.cos(yawOff))); }
      if (Math.abs(rel2) > 1.0 || sink > 30 || yawOff > 0.8) this.bail();
      else {
        this.landing = Math.min(1, sink / 16);
        if (yawOff > 0.15) this.vel.multiplyScalar(1 - 0.4 * (yawOff - 0.15));   // landing a bit sideways scrubs speed
      }
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
    if (firm && speed > 3 && !this.drifting && this.slip < 0.2 && !this.onWater && !this.waterDepth && Math.abs(this.pitch - this.groundPitch) < 0.2) this.rememberSafe();
  }

  // glider hooks: how far the tyres reach below the axles, and picking the bike's yaw / pitch back up from the
  // orientation the wing left it in (the wing can bank it; the bike body can't roll, so the bank becomes the lean)
  wheelReach() { return this.t.travel + RADIUS; }
  afterGlide() {
    _fw.set(0, 0, 1).applyQuaternion(this.quat); _lt.set(1, 0, 0).applyQuaternion(this.quat); _up.set(0, 1, 0).applyQuaternion(this.quat);
    this.yaw = Math.atan2(_fw.x, _fw.z); this.pitch = clamp(Math.asin(clamp(_fw.y, -1, 1)), -1.2, 1.2);
    this.lean = clamp(Math.atan2(_lt.y, _up.y), -0.85, 0.85);
    this.pitchRate = 0; this.yawRate = 0; this.leanRate = 0; this.ang.set(0, 0, 0);
    this.heldGas = true; this.heldBrake = true;                     // keys held for the glide don't lean you on landing
    this.setQuat();
  }

  // a landing too far off the ground's angle: the rider puts a foot down, bike scrubs most of its speed
  bail() {
    this.vel.multiplyScalar(0.35); this.pitch = this.groundPitch; this.pitchRate = 0;
    this.hit = Math.max(this.hit, 20); this.landing = 1;
    this.say('Bail! Rough landing', 1.8);
  }

  hudInfo() {
    return `${this.wheelie ? 'WHEELIE · ' : ''}${this.stoppie ? 'STOPPIE · ' : ''}${this.drifting || this.slip > 0.25 ? 'SLIDE · ' : ''}${this.washout ? 'FRONT WASHING OUT · ' : ''}`;
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
  const helmetMat = M(0xff7a1a), jacketMat = M(0xf2f2ee), gloveMat = M(0x1d1f24), wheelMat = M(0x8a9099);
  for (const [role, material] of Object.entries({ body: orange, trim: white, helmet: helmetMat, jacket: jacketMat, gloves: gloveMat, wheels: wheelMat })) material.userData.cosmeticRole = role;
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
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.16, 8).rotateZ(Math.PI / 2), wheelMat); spin.add(hub);
    for (let k = 0; k < 4; k++) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.5, 0.02), wheelMat); s.rotation.x = k * Math.PI / 4; spin.add(s); }
    wheels.push({ holder, spin, r: 0.34, front, restY: -0.2 });
  }
  // rider: legs, torso, arms, helmet
  const rider = new THREE.Group(); rider.position.set(0, 0.42, -0.2); body.add(rider);
  for (const s of [1, -1]) {
    box(0.13, 0.42, 0.14, jacketMat, s * 0.17, -0.05, 0.12, 0.9, rider);     // thigh
    box(0.12, 0.42, 0.12, black, s * 0.2, -0.3, 0.3, -0.2, rider);       // shin + boot
    box(0.1, 0.4, 0.1, jacketMat, s * 0.24, 0.42, 0.33, -1.0, rider);        // arm
    box(0.09, 0.09, 0.09, gloveMat, s * 0.3, 0.3, 0.6, 0, rider);           // glove
  }
  box(0.4, 0.55, 0.26, jacketMat, 0, 0.42, 0.05, 0.35, rider);              // jersey
  box(0.3, 0.12, 0.2, orange, 0, 0.55, 0.12, 0.35, rider);              // stripe
  const helmet = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 1), helmetMat); helmet.position.set(0, 0.82, 0.24);
  helmet.castShadow = true; rider.add(helmet);
  box(0.22, 0.08, 0.14, black, 0, 0.8, 0.38, 0, rider);                 // goggles
  box(0.12, 0.06, 0.16, helmetMat, 0, 0.7, 0.42, 0.4, rider);              // chin guard
  root.userData = { lean, bars, wheels, rider, blob: [0.9, 2.0] };
  return root;
}
