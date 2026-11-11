// Arcade car on the heightfield. Fixed 120 Hz step. Car local axes: +z forward, +y up, +x = car's left.
//
// Vertical: four suspension rays (springs) hold the car up and give pitch/roll over terrain.
// Horizontal: arcade model, not tyre physics —
//   * steering sets a target yaw rate (kinematic at low speed, capped by grip at high speed);
//   * grip rotates the velocity toward where the car points (fast normally, slowly while drifting);
//   * drifting starts on the handbrake (or when the car slides too far) and ends when you straighten out.
// A ground "snap" stops the car floating off small crests; big ramps still launch it.
import * as THREE from 'three';
import { buildCarModel, WHEEL_POS } from './carmodel.js';

export const TUNING_DEFAULTS = {
  accel: 17,              // m/s² from standstill
  topSpeed: 270,          // km/h
  brakeDecel: 32,         // m/s²
  steerLock: 0.6,         // rad, low-speed wheel angle
  steerRate: 7,           // how fast steering winds on (1/s)
  cornerGrip: 30,         // m/s² of sideways grip (≈3 g) – sets how tight you turn at speed
  turnResponse: 18,       // how quickly the car's rotation follows the steering (1/s)
  gripAlign: 16,          // how quickly the car stops sliding when not drifting (1/s)
  driftAlign: 2.4,        // the same while drifting – lower = wider drifts
  driftTurn: 1.0,         // how fast the car rotates while drifting (rad/s at full steer)
  driftMaxAngle: 50,      // degrees – the slide never gets wider than this
  driftSpeedLoss: 0.22,   // speed scrubbed per second at full sideways
  driftBoost: 3,          // m/s² extra push while drifting on throttle
  springK: 60000,
  damping: 5600,
  restLength: 0.42,
  snap: 70,               // m/s² pull back to the ground when a crest would lift you off
  downforce: 0.004,       // extra load per (m/s)²
  gravity: 24,
  airControl: 2.6,
  airStabilize: 2.5,
  skimSpeed: 85,          // km/h – faster than this you skip across water, slower you sink in
};
const GRIP = [0.86, 0.8, 0.93, 1.0, 0.9, 0.45, 0.97, 0.98];      // per surface class
const DRAG = [0.25, 0.35, 0.1, 0.0, 0.12, 5.0, 0.0, 0.0];        // extra rolling drag, m/s²
const MASS = 900, WHEELBASE = 2.78;
const HALF = new THREE.Vector3(0.9, 0.38, 2.15);              // inertia only
// hard collision box for the body: sits above the floor so only the tyres touch normal ground
const BOX_C = new THREE.Vector3(0, 0.2, -0.1), BOX_H = new THREE.Vector3(0.8, 0.3, 1.85);
const RADIUS = 0.38;

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _n = new THREE.Vector3(), _c = new THREE.Vector3(),
  _r = new THREE.Vector3(), _F = new THREE.Vector3(), _T = new THREE.Vector3(), _up = new THREE.Vector3(),
  _fw = new THREE.Vector3(), _lt = new THREE.Vector3(), _q = new THREE.Quaternion(), _nAvg = new THREE.Vector3(),
  _vp = new THREE.Vector3(), _hp = new THREE.Vector3();

export class Car {
  constructor(world, tuning) {
    this.world = world; this.t = tuning;
    this.pos = new THREE.Vector3(); this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3(); this.ang = new THREE.Vector3();
    this.steer = 0; this.drifting = false; this.driftDir = 0; this.slip = 0; this.slipSigned = 0;
    this.wheels = WHEEL_POS.map(([x, y, z, front]) => ({
      mount: new THREE.Vector3(x, y + 0.3, z), front, comp: 0, prevComp: 0, contact: false, surf: 0,
      contactPoint: new THREE.Vector3(), spin: 0 }));
    this.mesh = buildCarModel();
    this.surface = 0; this.grounded = false; this.airTime = 0; this.contacts = 0;
    this.latAcc = 0; this.lonAcc = 0; this.hit = 0; this.landing = 0;
    this.safe = []; this.stuck = 0; this.straightT = 0; this.wasGrounded = false;
    this._prevVel = new THREE.Vector3();
    this.prevPos = new THREE.Vector3(); this.prevQuat = new THREE.Quaternion();
    this.renderPos = new THREE.Vector3(); this.renderQuat = new THREE.Quaternion();
  }

  savePrev() { this.prevPos.copy(this.pos); this.prevQuat.copy(this.quat); }
  interpolate(alpha) {
    // a reset/teleport moves the car far in one step: don't smear it across the map
    if (this.prevPos.distanceToSquared(this.pos) > 100) this.savePrev();
    this.renderPos.lerpVectors(this.prevPos, this.pos, alpha);
    this.renderQuat.slerpQuaternions(this.prevQuat, this.quat, alpha);
  }

  reset(x, z, yaw) {
    const h = this.world.heightAt(x, z);
    this.pos.set(x, h + 0.75, z);
    this.quat.setFromAxisAngle(_v.set(0, 1, 0), yaw);
    this.vel.set(0, 0, 0); this.ang.set(0, 0, 0); this.steer = 0; this.drifting = false;
    this.savePrev?.(); this.renderPos?.copy(this.pos); this.renderQuat?.copy(this.quat);
    for (const w of this.wheels) { w.comp = w.prevComp = 0; }
  }

  resetToSafe() {
    const s = this.safe.length > 40 ? this.safe[this.safe.length - 40] : this.safe[0];
    if (s) this.reset(s[0], s[1], s[2]);
  }

  step(dt, input) {
    const t = this.t, W = this.world;
    this._prevVel.copy(this.vel);
    _up.set(0, 1, 0).applyQuaternion(this.quat);
    _fw.set(0, 0, 1).applyQuaternion(this.quat);
    _lt.set(1, 0, 0).applyQuaternion(this.quat);
    const speed = this.vel.length();

    // ---------------------------------------------------------------- suspension
    _F.set(0, -t.gravity * MASS, 0); _T.set(0, 0, 0); _nAvg.set(0, 0, 0);
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    const skimming = hSpeed * 3.6 > t.skimSpeed;
    let contacts = 0, near = 0;
    const counts = [0, 0, 0, 0, 0, 0, 0, 0];
    const reach = t.restLength + RADIUS;
    for (const wh of this.wheels) {
      _w.copy(wh.mount).applyQuaternion(this.quat).add(this.pos);
      let gh = W.heightAt(_w.x, _w.z);
      const wl = W.waterLevelAt(_w.x, _w.z);
      const wet = wl > gh;
      if (wet && skimming) gh = wl;                       // fast enough: the water surface holds you up
      W.normalAt(_w.x, _w.z, _n);
      if (wet && skimming) _n.set(0, 1, 0);
      const denom = _up.dot(_n);
      const dist = denom > 0.25 ? ((_w.y - gh) * _n.y) / denom : 99;
      wh.prevComp = wh.comp;
      if (dist < reach + 0.7) near++;
      if (dist < reach) {
        wh.contact = true; contacts++;
        wh.comp = Math.min(reach - dist, t.restLength);
        const sc = W.surfaceAt(_w.x, _w.z);
        wh.surf = wet ? 5 : (sc === 5 ? 0 : sc); counts[wh.surf]++;          // dry pond bank counts as grass
        const cv = (wh.comp - wh.prevComp) / dt;
        const Fz = Math.max(0, t.springK * wh.comp + t.damping * cv);
        _r.copy(_w).addScaledVector(_up, -dist).sub(this.pos);
        wh.contactPoint.copy(_r).add(this.pos);
        _F.addScaledVector(_up, Fz);
        addTorque(_T, _r, _up, Fz);
        _nAvg.add(_n);
      } else { wh.contact = false; wh.comp = 0; }
    }
    this.contacts = contacts;
    this.grounded = contacts > 0;
    const firm = contacts >= 2;
    if (contacts) { let b = 0; for (let i = 1; i < 8; i++) if (counts[i] > counts[b]) b = i; this.surface = b; }
    const grip = GRIP[this.surface];
    if (contacts) _nAvg.normalize(); else _nAvg.set(0, 1, 0);
    if (firm) _F.addScaledVector(_nAvg, -t.downforce * speed * speed * MASS);

    // ---------------------------------------------------------------- water: float a bit, heavy drag
    const wlC = W.waterLevelAt(this.pos.x, this.pos.z);
    this.waterDepth = Math.max(0, wlC - (this.pos.y - 0.35));
    if (this.waterDepth > 0) {
      const sub = Math.min(1, this.waterDepth / 0.9);
      _F.y += t.gravity * MASS * sub * 0.7;                                     // buoyancy
      _F.x -= this.vel.x * MASS * 1.4 * sub; _F.z -= this.vel.z * MASS * 1.4 * sub; // water resistance
      _F.y -= this.vel.y * MASS * 2.5 * sub;
    }
    this.onWater = contacts > 0 && counts[5] >= 2;
    if (this.onWater) _F.addScaledVector(this.vel, -MASS * 0.35);          // skimming: water grabs at the tyres

    // ---------------------------------------------------------------- air control
    if (!this.grounded && this.airTime > 0.12) {
      _T.addScaledVector(_lt, (input.throttle - input.brake) * t.airControl * MASS * 0.35);
      _T.addScaledVector(_up, -input.steer * t.airControl * MASS * 0.8);
      _v.crossVectors(_up, _n.set(0, 1, 0));
      _T.addScaledVector(_v, t.airStabilize * MASS * 1.5);
      _w.copy(this.ang).addScaledVector(_up, -this.ang.dot(_up));
      _T.addScaledVector(_w, -t.airStabilize * MASS * 0.6);
    }

    // ---------------------------------------------------------------- integrate forces
    this.vel.addScaledVector(_F, dt / MASS);
    _q.copy(this.quat).invert();
    _v.copy(_T).applyQuaternion(_q);
    const Ix = MASS * (HALF.y ** 2 + HALF.z ** 2) / 3, Iy = MASS * (HALF.x ** 2 + HALF.z ** 2) / 3, Iz = MASS * (HALF.x ** 2 + HALF.y ** 2) / 3;
    _v.set(_v.x / Ix, _v.y / Iy, _v.z / Iz).applyQuaternion(this.quat);
    this.ang.addScaledVector(_v, dt);

    // ---------------------------------------------------------------- steering wheel
    const target = input.steer;
    const rate = (Math.sign(target) !== Math.sign(this.steer) || target === 0) ? t.steerRate * 1.6 : t.steerRate;
    this.steer += Math.sign(target - this.steer) * Math.min(Math.abs(target - this.steer), rate * dt);

    // ---------------------------------------------------------------- arcade driving (on the ground)
    if (contacts) {
      const k = contacts / 4, n = _nAvg;
      _hp.copy(_fw).addScaledVector(n, -_fw.dot(n)).normalize();             // heading on the ground
      _vp.copy(this.vel).addScaledVector(n, -this.vel.dot(n));                // velocity on the ground
      const vPlane = _vp.length(), vf = _vp.dot(_hp), reversing = vf < -0.5;
      // signed slip: angle from velocity to heading (+ = heading is rotated toward the car's left)
      let beta = 0;
      if (vPlane > 2) {
        _v.copy(_vp).multiplyScalar((reversing ? -1 : 1) / vPlane);
        beta = Math.atan2(_c.crossVectors(_v, _hp).dot(n), _v.dot(_hp));
      }
      this.slipSigned = beta; this.slip = Math.abs(beta);

      // drift state
      if (!this.drifting && vf > 12 && ((input.handbrake && Math.abs(this.steer) > 0.2) || this.slip > 0.42)) {
        this.drifting = true; this.driftDir = Math.sign(this.steer) || -Math.sign(beta) || 1;
      }
      if (this.drifting) {
        const counter = this.steer * this.driftDir < -0.2;
        if (!input.handbrake && this.slip < 0.15 && (counter || Math.abs(this.steer) < 0.3)) this.straightT += dt; else this.straightT = 0;
        if (this.straightT > 0.2 || vf < 6) { this.drifting = false; this.straightT = 0; }
      }

      // yaw: chase a target rotation rate
      const wCur = this.ang.dot(n);
      const absV = Math.max(Math.abs(vf), 0.5);
      const cap = t.cornerGrip * grip / absV;
      let wTarget;
      if (this.drifting) {
        // steering into the drift tightens it, counter-steer opens it up and straightens you out
        const dy = THREE.MathUtils.clamp(cap * 1.6, t.driftTurn, 2.6);
        wTarget = -(this.steer * 0.75 + this.driftDir * 0.25) * dy;
      } else {
        const kin = vf * Math.tan(this.steer * t.steerLock) / WHEELBASE;
        wTarget = -Math.sign(kin) * Math.min(Math.abs(kin), cap);
        if (input.handbrake && vf > 5) wTarget *= 1.5;
      }
      this.ang.addScaledVector(n, (wTarget - wCur) * Math.min(1, t.turnResponse * dt) * k);

      // grip: swing the velocity round to where the car points
      if (vPlane > 0.3) {
        let align = (this.drifting ? t.driftAlign : t.gripAlign) * grip * (input.handbrake ? 0.45 : 1);
        if (this.drifting && this.slip > t.driftMaxAngle / 57.3) align *= 4;      // cap the drift angle
        // proportional: the slide settles where rotation rate = align × slip angle
        let turn = beta * (1 - Math.exp(-align * dt));
        if (!this.drifting) { const cap = t.cornerGrip * grip * 1.15 / vPlane * dt; turn = Math.max(-cap, Math.min(cap, turn)); }
        _vp.applyAxisAngle(n, turn * k);
        _vp.multiplyScalar(1 - Math.min(0.5, t.driftSpeedLoss * Math.abs(Math.sin(beta)) * dt * k * (this.drifting ? 1 : 2)));
      }
      // static grip: tyres resist sliding sideways (e.g. gravity across a slope) unless you're drifting
      if (!this.drifting) {
        _c.crossVectors(n, _hp);                                   // car's left, on the ground
        const lat = _vp.dot(_c), lim = t.cornerGrip * grip * 1.2 * dt;
        _vp.addScaledVector(_c, -Math.max(-lim, Math.min(lim, lat)) * k);
      }
      // engine and brakes along the heading
      const vmax = t.topSpeed / 3.6;
      let a = 0;
      if (input.throttle > 0) {
        a = reversing ? t.brakeDecel * input.throttle : input.throttle * t.accel * Math.max(0, 1 - (vf / vmax) ** 2);
        if (this.drifting) a += t.driftBoost * this.slip;
      }
      if (input.brake > 0) {
        if (vf > 1) a -= t.brakeDecel * input.brake;
        else if (vf > -11) a -= input.brake * 9;
      }
      if (input.handbrake) a -= Math.sign(vf) * Math.min(Math.abs(vf) / dt, 7);
      const coast = input.throttle || input.brake ? 0 : 1.2;
      // parked or crawling with no pedals: hold the car on a hill instead of rolling away
      if (!input.throttle && !input.brake && Math.abs(vf) < 2) a -= Math.sign(vf) * Math.min(Math.abs(vf) / dt, 9);
      a -= (DRAG[this.surface] + coast) * Math.sign(vf) * Math.min(1, Math.abs(vf));
      // cornering scrubs a little speed; in a drift the engine pushes mostly along the slide
      a -= Math.abs(this.latAcc) * 0.06;
      if (this.drifting && vPlane > 1) {
        _v.copy(_vp).divideScalar(vPlane);
        _vp.addScaledVector(_v, a * dt * k * 0.75).addScaledVector(_hp, a * dt * k * 0.25);
      } else _vp.addScaledVector(_hp, a * dt * k);
      const vNormal = this.vel.dot(n);                    // read before overwriting (keeps gravity/suspension motion)
      this.vel.copy(_vp).addScaledVector(n, vNormal);
      // damp roll about the heading so the body stays flat through corners (the mesh leans for show)
      this.ang.addScaledVector(_hp, -this.ang.dot(_hp) * Math.min(1, 6 * dt));
    } else {
      this.slip = 0;
    }

    // ground snap: grounded last step, wheels just lifted, not a big launch -> pull back down
    if (!firm && this.wasGrounded && near >= 2 && this.vel.y < 7) this.vel.y -= t.snap * dt;
    if (!this.wasGrounded && firm && this.airTime > 0.3) this.landing = Math.min(1, -this._prevVel.y / 15);
    this.wasGrounded = firm;
    this.airTime = this.grounded ? 0 : this.airTime + dt;

    this.vel.addScaledVector(this.vel, -0.0009 * speed * dt);          // air drag
    this.ang.multiplyScalar(this.grounded ? 1 - 2.5 * dt : 1 - 0.2 * dt);

    this.pos.addScaledVector(this.vel, dt);
    const am = this.ang.length();
    if (am > 1e-6) { _q.setFromAxisAngle(_v.copy(this.ang).divideScalar(am), am * dt); this.quat.premultiply(_q).normalize(); }

    if ((_up.y < 0.3 && speed < 4) || (this.waterDepth > 0.45 && speed < 2.5)) this.stuck += dt; else this.stuck = 0;
    if (this.waterDepth > 0.45) {                          // bogged down in a pond: back to dry land after 3 s
      if (this.stuck > 3) { this.stuck = 0; this.resetToSafe(); return; }
    } else if (this.stuck > 1.0) { this.stuck = 0; this.reset(this.pos.x, this.pos.z, Math.atan2(_fw.x, _fw.z)); return; }

    this.hit = 0;
    this.collideGround();
    this.collideTrees();
    this.collideBuildings();
    this.keepInBounds();

    // accelerations in the car's frame (body lean, camera, sound)
    _v.copy(this.vel).sub(this._prevVel).divideScalar(dt);
    this.latAcc += (_v.dot(_lt) - this.latAcc) * Math.min(1, 8 * dt);
    this.lonAcc += (_v.dot(_fw) - this.lonAcc) * Math.min(1, 8 * dt);
    const fwdSpeed = this.vel.dot(_fw);
    for (const wh of this.wheels) wh.spin += fwdSpeed * dt / RADIUS * (input.handbrake && !wh.front ? 0 : 1);

    if (firm && _up.y > 0.8 && speed > 3 && !this.drifting && !this.onWater && !this.waterDepth) {
      const last = this.safe[this.safe.length - 1];
      if (!last || Math.hypot(last[0] - this.pos.x, last[1] - this.pos.z) > 6) {
        this.safe.push([this.pos.x, this.pos.z, Math.atan2(_fw.x, _fw.z)]); if (this.safe.length > 200) this.safe.shift();
      }
    }
  }

  collideGround() {
    const W = this.world;
    let worst = 0;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      _w.set(BOX_C.x + sx * BOX_H.x, BOX_C.y + sy * BOX_H.y, BOX_C.z + sz * BOX_H.z).applyQuaternion(this.quat).add(this.pos);
      const pen = W.heightAt(_w.x, _w.z) - _w.y;
      if (pen > worst) { worst = pen; _r.copy(_w).sub(this.pos); }
    }
    if (worst > 0) {
      W.normalAt(this.pos.x, this.pos.z, _n);
      this.pos.addScaledVector(_n, worst);
      _v.copy(this.ang).cross(_r).add(this.vel);
      const vn = _v.dot(_n);
      if (vn < 0) {
        this.vel.addScaledVector(_n, -vn * 1.1);
        this.ang.multiplyScalar(0.85);
        this.ang.addScaledVector(_v.crossVectors(_r, _n), -vn * 0.05);
        this.hit = Math.max(this.hit, -vn * 0.5);
      }
    }
  }

  collideTrees() {
    const R = 1.15;
    for (const zo of [-1.4, 0, 1.4]) {
      _w.set(0, 0, zo).applyQuaternion(this.quat).add(this.pos);
      if (_w.y - this.world.heightAt(_w.x, _w.z) > 14) continue;
      this.world.treesNear(_w.x, _w.z, R + 1.2, (tx, tz, tr) => {
        const dx = _w.x - tx, dz = _w.z - tz, d = Math.hypot(dx, dz), min = R + tr;
        if (d < min && d > 1e-4) {
          const nx = dx / d, nz = dz / d, pen = min - d;
          this.pos.x += nx * pen; this.pos.z += nz * pen; _w.x += nx * pen; _w.z += nz * pen;
          const vn = this.vel.x * nx + this.vel.z * nz;
          if (vn < 0) {
            this.vel.x -= nx * vn * 1.3; this.vel.z -= nz * vn * 1.3;
            this.vel.multiplyScalar(0.82);
            this.ang.y += Math.sign(zo) * (nx * _fw.z - nz * _fw.x) * vn * 0.05;
            this.hit = Math.max(this.hit, -vn); this.drifting = false;
          }
        }
      });
    }
  }

  collideBuildings() {
    const R = 1.5;
    for (const b of this.world.buildingsNear(this.pos.x, this.pos.z)) {
      if (!b.pts || this.pos.y > b.top + 1) continue;
      const pts = b.pts; let inside = false, bestD = Infinity, bx = 0, bz = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [x1, z1] = pts[j], [x2, z2] = pts[i];
        if (((z2 > this.pos.z) !== (z1 > this.pos.z)) && (this.pos.x < (x1 - x2) * (this.pos.z - z2) / (z1 - z2) + x2)) inside = !inside;
        const ex = x2 - x1, ez = z2 - z1, L = ex * ex + ez * ez || 1;
        const u = Math.max(0, Math.min(1, ((this.pos.x - x1) * ex + (this.pos.z - z1) * ez) / L));
        const cx = x1 + ex * u, cz = z1 + ez * u, d = Math.hypot(this.pos.x - cx, this.pos.z - cz);
        if (d < bestD) { bestD = d; bx = cx; bz = cz; }
      }
      if (!inside && bestD >= R) continue;
      let nx = this.pos.x - bx, nz = this.pos.z - bz; const d = Math.hypot(nx, nz) || 1; nx /= d; nz /= d;
      if (inside) { nx = -nx; nz = -nz; }
      const pen = inside ? R + bestD : R - bestD;
      this.pos.x += nx * pen; this.pos.z += nz * pen;
      const vn = this.vel.x * nx + this.vel.z * nz;
      if (vn < 0) { this.vel.x -= nx * vn * 1.3; this.vel.z -= nz * vn * 1.3; this.vel.multiplyScalar(0.85); this.hit = Math.max(this.hit, -vn); this.drifting = false; }
    }
  }

  keepInBounds() {
    // edge of the map, or a tile that hasn't streamed in yet: bounce back
    const [x0, z0, x1, z1] = this.world.extent, m = 6;
    if (this.pos.x < x0 + m) { this.pos.x = x0 + m; this.vel.x = Math.abs(this.vel.x) * 0.3; }
    if (this.pos.x > x1 - m) { this.pos.x = x1 - m; this.vel.x = -Math.abs(this.vel.x) * 0.3; }
    if (this.pos.z < z0 + m) { this.pos.z = z0 + m; this.vel.z = Math.abs(this.vel.z) * 0.3; }
    if (this.pos.z > z1 - m) { this.pos.z = z1 - m; this.vel.z = -Math.abs(this.vel.z) * 0.3; }
    if (!this.world.loadedAt(this.pos.x, this.pos.z) && this._lastLoaded) {
      this.pos.x = this._lastLoaded[0]; this.pos.z = this._lastLoaded[1]; this.vel.x *= -0.3; this.vel.z *= -0.3;
    } else this._lastLoaded = [this.pos.x, this.pos.z];
  }

  syncMesh(dt) {
    const m = this.mesh, ud = m.userData;
    m.position.copy(this.renderPos); m.quaternion.copy(this.renderQuat);
    // body lean: roll toward the outside of the turn, squat / dive with throttle and brake
    const roll = THREE.MathUtils.clamp(this.latAcc * 0.0045, -0.09, 0.09);
    const pitch = THREE.MathUtils.clamp(-this.lonAcc * 0.0028, -0.06, 0.06);
    ud.bodyPivot.rotation.z += (roll - ud.bodyPivot.rotation.z) * Math.min(1, dt * 10);
    ud.bodyPivot.rotation.x += (pitch - ud.bodyPivot.rotation.x) * Math.min(1, dt * 10);
    this.wheels.forEach((wh, i) => {
      const g = ud.wheels[i];
      const drop = wh.contact ? (this.t.restLength - wh.comp) : this.t.restLength;
      g.holder.position.y = g.restY + 0.3 - drop - (RADIUS - g.r);
      g.holder.rotation.y = wh.front ? -this.steer * this.t.steerLock * 0.9 : 0;
      g.spin.rotation.x = wh.spin;
    });
  }
}

function addTorque(T, r, dir, mag) { T.x += (r.y * dir.z - r.z * dir.y) * mag; T.y += (r.z * dir.x - r.x * dir.z) * mag; T.z += (r.x * dir.y - r.y * dir.x) * mag; }
