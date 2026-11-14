// Glider: G opens a hang-glider wing over the car and switches it to a flying mode until you touch down (or press G
// again, which folds it and drops you). Arcade aerodynamics, tuned to be gentle:
//   * lift and drag from airspeed² and angle of attack; drag grows with lift (≈ 9:1 glide at trim, ~100 km/h)
//   * the wing trims itself to roughly carry the car's weight, so with no input you glide down slowly; S / ↓ pulls
//     the nose up (climb, trade speed for height), W / ↑ pushes it down (dive, trade height for speed)
//   * A / D bank; the tilted lift turns you and the tail swings the nose round (it self-levels when you let go)
//   * too slow or nose too high → stall: lift collapses, the nose drops until you have speed again
//   * touch down upright and not too fast downward → back on your wheels; anything else is a crash and a tumble
// Physics only reads the world through heightAt / normalAt / waterLevelAt / treesNear / buildingsNear, like the car.
import * as THREE from 'three';
import { normalizeGliderColors } from './glidercolors.js';

export const GLIDER = {
  liftK: 0.0386,     // lift (m/s²) = liftK × speed² × CL – at 97 km/h a CL of 0.85 carries the car
  cl0: 0.25, clA: 5, // CL at zero angle of attack, and per radian
  stallA: 0.26,      // stall angle of attack (rad, ≈ 15°)
  cd0: 0.045, cdK: 0.06,  // drag = cd0 + cdK × CL²  (best glide ≈ 9.5:1)
  maxLoad: 3,        // lift never more than 3 × gravity
  maxDrag: 9.8,      // m/s² – drag never brakes harder than ~1 real g (at 1000+ km/h the wing would otherwise be a wall)
  trimMax: 0.12,     // the wing trims itself between these angles of attack
  trimMin: -0.06,
  pitchRate: 0.8,    // rad/s nose up/down at full stick (against the wing's own stability)
  stability: 6,      // how hard the nose is pulled back to the trim angle (1/s, at flying speed)
  rollRate: 1.5,     // rad/s bank rate at full stick
  maxBank: 0.85,     // ≈ 49°
  selfLevel: 0.7,    // 1/s, bank returns to level when you let go
  minGroundKmh: 90,  // on the ground, G needs this much speed (it hops you into the air)
  hop: 6,            // m/s up when opening it on the ground
  landSink: 14,      // m/s – touch down falling faster than this and it's a crash
  landUp: 0.82,      // car's up axis must be within ~35° of vertical to land on the wheels
};

// the dirt bike's glider: a smaller wing over the rider; the bike + rider are much lighter than the car, so the wing
// carries them at lower speed (trim ~80 km/h instead of ~100) and it can hop off the ground from 70 km/h
export const BIKE_GLIDER = {
  params: { liftK: 0.0386 * 1.35, minGroundKmh: 70, hop: 5 },
  bodyR: 0.7,
  model: { H: 1.72, span: 3.5, nose: 1.35, tail: -0.95, tip: -1.05, crossZ: -0.4,
    struts: [[[0.17, 0.42, 0.62], [0, 1.72, 0.62], 0.03], [[-0.17, 0.42, 0.62], [0, 1.72, 0.62], 0.03],
      [[0, 0.45, -0.78], [0, 1.77, -0.6], 0.03]] },
};

const _up = new THREE.Vector3(), _fw = new THREE.Vector3(), _lt = new THREE.Vector3(), _v = new THREE.Vector3(),
  _a = new THREE.Vector3(), _w = new THREE.Vector3(), _t = new THREE.Vector3(), _q = new THREE.Quaternion();
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// one HUD line shared by every vehicle's glider; the vehicle you're in writes it
let hudEl = null, hudLast = null, hudOwner = null;

// Works on any vehicle with the shared outside (vehicle.js): pos / quat / vel / ang, wheels, world, t.gravity, step().
// The vehicle's step hands over to glide.step while it's open. Optional hooks on the vehicle:
//   wheelReach()  – how far below a wheel's mount the tyre reaches (default: the car's spring + tyre)
//   afterGlide()  – called when it folds, so a vehicle with its own orientation state (the bike) can pick it up
//   bail()        – the vehicle's own crash; used instead of the car's tumble
// opts: { params: overrides for GLIDER, model: wing size/placement for buildGliderModel, bodyR: building radius }

export class Glider {
  constructor(car, opts = {}) {
    this.car = car; car.glide = this;
    this.P = { ...GLIDER, ...(opts.params || {}) }; this.bodyR = opts.bodyR ?? 1.5;
    this.active = false; this.open = 0; this.t = 0;
    this.stall = false; this.alpha = 0; this.agl = 0; this.bank = 0; this.lift = 0;
    this.result = '';                      // why it last closed: 'folded' | 'landed' | 'crash' | 'tree' | 'building' | 'water' | 'reset'
    this.msg = ''; this.msgT = 0;
    this.mesh = buildGliderModel(opts.model); this.mesh.visible = false; car.mesh.add(this.mesh);
    this.hud = null;
  }

  say(m, secs = 2.5) { this.msg = m; this.msgT = secs; }

  // height of the lowest wheel above ground or water
  heightAbove() {
    const c = this.car, W = c.world; let low = Infinity;
    for (const wh of c.wheels) {
      (wh.mount ? _w.copy(wh.mount) : _w.set(0, 0, wh.z || 0)).applyQuaternion(c.quat).add(c.pos);
      low = Math.min(low, _w.y - Math.max(W.heightAt(_w.x, _w.z), W.waterLevelAt(_w.x, _w.z)));
    }
    return low - (c.wheelReach ? c.wheelReach() : c.t.restLength + 0.38);
  }

  toggle() {
    if (this.active) { this.fold('folded'); this.say('Glider folded'); return; }
    const c = this.car;
    if (!c.grounded && (c.airTime > 0.15 || this.heightAbove() > 1.5)) { this.deploy(); return; }
    if (c.vel.length() * 3.6 >= this.P.minGroundKmh) {
      _up.set(0, 1, 0).applyQuaternion(c.quat);
      c.vel.addScaledVector(_up, this.P.hop); c.pos.y += 0.25;
      this.deploy(); return;
    }
    this.say(`Glider needs air, or ${this.P.minGroundKmh}+ km/h to hop off the ground`);
  }

  deploy() {
    const c = this.car;
    this.active = true; this.t = 0; this.stall = false; this.result = '';
    c.drifting = false; c.slip = 0; c.ang.multiplyScalar(0.3);
    this.mesh.visible = true;
  }

  // back to driving; the car's own physics (springs, air control, water) takes over from the next step
  fold(why) {
    const c = this.car;
    this.active = false; this.result = why; this.stall = false;
    c.airTime = Math.max(c.airTime, 0.31); c.wasGrounded = false;
    c.afterGlide?.();
  }

  // a reset / teleport / flip: just put it away
  cancel() { if (this.active) this.fold('reset'); this.open = 0; this.mesh.visible = false; }

  crash(why, spin = 1) {
    const c = this.car, sp = c.vel.length();
    this.fold(why);
    const msg = why === 'tree' ? 'Crashed into a tree!' : why === 'building' ? 'Crashed into a building!' : 'Crash landing!';
    if (c.bail) { c.bail(); c.say?.('Bail! ' + msg, 1.8); return; }     // the bike: its own crash (foot down, speed scrubbed)
    _fw.set(0, 0, 1).applyQuaternion(c.quat); _lt.set(1, 0, 0).applyQuaternion(c.quat);
    c.ang.addScaledVector(_fw, (this.bank >= 0 ? 1 : -1) * Math.min(6, 1.5 + sp * 0.06) * spin)
      .addScaledVector(_lt, -Math.min(3, sp * 0.03) * spin);
    c.hit = Math.max(c.hit, Math.min(40, sp * 0.6));
    this.say(msg);
  }

  step(dt, input) {
    const c = this.car, W = c.world, P = this.P, g = c.t.gravity;
    this.t += dt;
    c._prevVel.copy(c.vel);
    _up.set(0, 1, 0).applyQuaternion(c.quat);
    _fw.set(0, 0, 1).applyQuaternion(c.quat);
    _lt.set(1, 0, 0).applyQuaternion(c.quat);
    const s = c.vel.length(), q = s * s;
    const vF = c.vel.dot(_fw), vU = c.vel.dot(_up), vL = c.vel.dot(_lt);
    // angle of attack: + when the air comes from below the wing. Flying backwards = fully stalled.
    const alpha = vF > 0.5 ? Math.atan2(-vU, vF) : (s > 2 ? 1.2 : 0);
    const beta = Math.atan2(vL, Math.max(Math.abs(vF), 1));            // sideslip, + = air from the right
    const bank = Math.atan2(_lt.y, _up.y);                              // + = banked right
    this.alpha = alpha; this.bank = bank;

    // ------------------------------------------------ controls → rotation rates (body axes)
    // the wing trims itself to an angle that roughly carries the weight (a little more in a bank)
    // and when falling faster than a gentle glide it asks for more, so a jump turns into a glide instead of a drop
    // (fast: hold height and bleed speed instead; slow: settle into a ~3 m/s sink)
    // (speeds scale with the wing's trim speed: exactly 27 / 22 m/s for the car's wing and gravity)
    const vk = Math.sqrt(g / 24 * (GLIDER.liftK / P.liftK));
    const fall = clamp(-c.vel.y - clamp(2.8 * (27 * vk / Math.max(s, 1)) ** 2, 0.3, 3), 0, 20) * 3;
    const need = (g / Math.max(0.55, Math.cos(bank)) + fall) / (P.liftK * Math.max(q, 1));
    const trim = clamp((need - P.cl0) / P.clA, P.trimMin, P.trimMax + 0.08 * Math.abs(Math.sin(bank)));   // a bit more in a bank
    const fly = Math.min(1, (s / (22 * vk)) ** 2);                             // controls go mushy when slow
    this.stall = alpha > P.stallA;
    let pitchIn = input.brake - input.throttle;                         // S / ↓ = nose up
    if (this.stall && pitchIn > 0) pitchIn = 0;
    let pr = pitchIn * P.pitchRate * (0.3 + 0.7 * fly) + P.stability * fly * (trim - alpha);
    if (this.stall) pr -= 1.4 * Math.min(1, (alpha - P.stallA) * 6 + 0.3);    // stalled: the nose drops
    let rr = input.steer * P.rollRate * (0.4 + 0.6 * fly);
    if (!input.steer) rr -= bank * P.selfLevel;
    if (Math.abs(bank) > P.maxBank && Math.sign(rr) !== -Math.sign(bank)) rr = -(bank - Math.sign(bank) * P.maxBank) * 4;
    const yr = 4 * beta * Math.min(1, s / 12);                          // the tail swings the nose into the airflow
    // +x (left) rotates the nose down, +z (forward) banks right, +y (up) yaws left
    _t.set(0, 0, 0).addScaledVector(_lt, -pr).addScaledVector(_fw, rr).addScaledVector(_up, yr);
    c.ang.lerp(_t, Math.min(1, 10 * dt));

    // ------------------------------------------------ forces (as accelerations)
    const clMax = P.cl0 + P.clA * P.stallA;
    let cl = alpha < P.stallA ? Math.max(-0.6, P.cl0 + P.clA * alpha) : clMax * Math.max(0.5, 1 - (alpha - P.stallA) * 2.5);
    if (vF <= 0.5) cl = 0;
    let L = P.liftK * q * cl;
    L = clamp(L, -P.maxLoad * g, P.maxLoad * g);
    this.lift = L / g;
    // induced drag from the lift you actually get: lift above the load limit is thrown away, so is its drag
    const clEff = q > 1 ? L / (P.liftK * q) : cl;
    const cd = P.cd0 + P.cdK * clEff * clEff + (this.stall ? Math.min(0.3, (alpha - P.stallA) * 1.5 + 0.08) : 0) + 0.3 * Math.sin(beta) ** 2;
    const D = Math.min(P.liftK * q * cd, P.maxDrag);
    _a.set(0, -g, 0);
    if (s > 0.5) {
      _v.copy(c.vel).divideScalar(s);
      _w.crossVectors(_v, _lt); const wl = _w.length();
      if (wl > 1e-3) _a.addScaledVector(_w, L / wl);                   // lift: square to the airflow, in the wing's plane
      _a.addScaledVector(_v, -D);
    }
    _a.addScaledVector(_lt, -vL * 0.6);                                 // side area resists slipping sideways

    c.vel.addScaledVector(_a, dt);
    c.pos.addScaledVector(c.vel, dt);
    const am = c.ang.length();
    if (am > 1e-6) { _q.setFromAxisAngle(_v.copy(c.ang).divideScalar(am), am * dt); c.quat.premultiply(_q).normalize(); }

    // ------------------------------------------------ car bookkeeping (wheels hang, no drifting, no ground contact)
    c.grounded = false; c.contacts = 0; c.airTime += dt; c.slip = 0; c.drifting = false;
    c.onWater = false; c.waterDepth = 0; c.stuck = 0; c.wasGrounded = false;
    c.steer += (input.steer - c.steer) * Math.min(1, 6 * dt);
    for (const wh of c.wheels) { wh.contact = false; wh.comp = 0; wh.spin += vF * dt / 0.38 * Math.exp(-this.t); }
    c.latAcc *= 1 - Math.min(1, 4 * dt); c.lonAcc *= 1 - Math.min(1, 4 * dt);
    if (c.lean !== undefined) { c.lean *= 1 - Math.min(1, 6 * dt); c.pitchRate = 0; c.yawRate = 0; }   // bike: the wing banks it now

    // ------------------------------------------------ touchdown, trees, buildings, map edge
    c.hit = 0;
    this.agl = this.heightAbove();
    if (this.t > 0.3 && this.agl < 0.05) {
      const sink = -c.vel.y, upY = _up.set(0, 1, 0).applyQuaternion(c.quat).y;
      const noseDown = _fw.set(0, 0, 1).applyQuaternion(c.quat).y < -0.5;
      const wet = W.waterLevelAt(c.pos.x, c.pos.z) > W.heightAt(c.pos.x, c.pos.z);
      if (upY > P.landUp && sink < P.landSink && !noseDown) {
        this.fold(wet ? 'water' : 'landed');
        this.say(wet ? 'Splashdown' : sink < 4 ? 'Smooth landing' : 'Landed', 1.8);
      } else this.crash('crash');
      return;
    }
    if (this.t > 0.3) {
      if (c.collideGround) c.collideGround();
      else if (c.pos.y < W.heightAt(c.pos.x, c.pos.z) + 0.25) c.hit = 1;     // a body without a ground box (bike)
      if (c.hit > 0) { this.crash('crash'); return; }
    }
    if (this.hitTree()) return;
    c.collideBuildings(this.bodyR);
    if (c.hit > 6) { this.crash('building'); return; }
    c.keepInBounds();
  }

  // tree crowns, not just trunks: cones for conifers, a ball-ish crown on the top 70% for broadleaf trees.
  // The wing is wide, so it reaches a few metres further than the car.
  hitTree() {
    const c = this.car, W = c.world, reach = 1.2 + 2.6 * this.open;
    let hx = 0, hz = 0, hit = false;
    W.treesNear(c.pos.x, c.pos.z, 16, (tx, tz, tr, h, broad) => {
      if (hit || h === undefined) return;
      const y = c.pos.y - W.terrainAt(tx, tz);
      if (y > h + 0.5 || y < 0) return;
      const crown = broad ? (y > h * 0.3 ? h * 0.3 : tr) : h * 0.15 * (1 - y / h) + tr;
      const d = Math.hypot(c.pos.x - tx, c.pos.z - tz);
      if (d < crown + reach) { hit = true; hx = tx; hz = tz; }
    });
    if (!hit) return false;
    let nx = c.pos.x - hx, nz = c.pos.z - hz; const d = Math.hypot(nx, nz) || 1; nx /= d; nz /= d;
    const vn = c.vel.x * nx + c.vel.z * nz;
    if (vn < 0) { c.vel.x -= nx * vn * 1.2; c.vel.z -= nz * vn * 1.2; }
    c.vel.multiplyScalar(0.4);
    this.crash('tree');
    return true;
  }

  // every frame: unfold / fold animation and the HUD line
  // current = this glider's vehicle is the one you're in (only that one writes the HUD line)
  update(dt, current = true) {
    const target = this.active ? 1 : 0;
    this.open += clamp(target - this.open, -dt * 4, dt * 3);
    const m = this.mesh, e = 1 - (1 - this.open) ** 3;
    m.visible = this.open > 0.01;
    m.scale.set(Math.max(0.05, e), 0.4 + 0.6 * e, 0.5 + 0.5 * e);
    m.position.y = -0.9 * (1 - e);
    this.msgT -= dt;
    if (typeof document === 'undefined') return;
    if (!current) { if (hudOwner === this && hudEl) { hudEl.innerHTML = ''; hudLast = ''; hudOwner = null; } return; }
    if (!hudEl) {
      const hud = document.getElementById('hud'); if (!hud) return;
      hudEl = document.createElement('div'); hudEl.id = 'glide';
      hudEl.style.cssText = 'font-size:14px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums;';
      hud.appendChild(hudEl);
    }
    hudOwner = this;
    let html = '';
    if (this.active) {
      const vs = this.car.vel.y;
      html = `🪂 ${Math.max(0, Math.round(this.agl))} m up · ${vs >= 0 ? '↑' : '↓'} ${Math.abs(vs).toFixed(1)} m/s`;
      if (this.stall) html += ' · <span style="color:#ff5a4a">STALL – push W</span>';
    }
    if (this.msgT > 0) html += `${html ? '<br>' : ''}<span style="opacity:.9">${this.msg}</span>`;
    if (html !== hudLast) { hudEl.innerHTML = html; hudLast = html; }
  }
}

// ---------------------------------------------------------------- model: hang-glider wing on two struts over the car
// defaults = the car's wing; the bike passes a smaller one (wing height, half-span, nose / tail / tip z, struts)
export function buildGliderModel(o = {}) {
  const H = o.H ?? 2.0;                            // wing height above the vehicle's centre
  const SPAN = o.span ?? 4.7, NZ = o.nose ?? 1.7, TZ = o.tail ?? -1.25, TIPZ = o.tip ?? -1.35, f = SPAN / 4.7;
  const nose = [0, H + 0.05, NZ], tail = [0, H + 0.12, TZ];
  const pos = [], col = [], panels = [];
  const palette = normalizeGliderColors(o.colors);
  const C = [palette.stripe, palette.wing, palette.accent].map(c => new THREE.Color(c));
  const tri = (a, b, c, k) => { pos.push(...a, ...b, ...c); for (let i = 0; i < 3; i++) { col.push(C[k].r, C[k].g, C[k].b); panels.push(k); } };
  const lerp = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);
  for (const s of [1, -1]) {
    const tip = [s * SPAN, H - 0.12, TIPZ];
    const N = 6;
    for (let i = 0; i < N; i++) {
      const u0 = i / N, u1 = (i + 1) / N;
      const sag = u => [0, -0.18 * Math.sin(Math.PI * u), 0];            // the sail billows down between the tubes
      const add = (p, d) => p.map((v, k) => v + d[k]);
      const l0 = lerp(nose, tip, u0), l1 = lerp(nose, tip, u1);
      const t0 = add(lerp(tail, tip, u0), sag(u0)), t1 = add(lerp(tail, tip, u1), sag(u1));
      const k = i === 0 ? 0 : i % 2 ? 1 : 2;
      if (s > 0) { tri(l0, t0, l1, k); tri(l1, t0, t1, k); } else { tri(l0, l1, t0, k); tri(l1, t1, t0, k); }
    }
  }
  const sail = new THREE.BufferGeometry();
  sail.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  sail.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  sail.userData.gliderPanels = panels;
  sail.computeVertexNormals();
  const g = new THREE.Group(); g.name = 'glider';
  const wing = new THREE.Mesh(sail, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, flatShading: true }));
  wing.name = 'glider-sail'; wing.castShadow = true; g.add(wing);
  const tube = new THREE.MeshLambertMaterial({ color: 0x2b2e35 });
  const rod = (a, b, r = 0.035) => {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), L = A.distanceTo(B);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L, 6), tube);
    m.position.copy(A).add(B).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    m.castShadow = true; g.add(m);
  };
  rod(nose, tail, 0.045);                                          // keel
  rod(nose, [SPAN, H - 0.12, TIPZ]); rod(nose, [-SPAN, H - 0.12, TIPZ]);    // leading edges
  const CZ = o.crossZ ?? -0.55;
  rod([-2.2 * f, H - 0.02, CZ], [2.2 * f, H - 0.02, CZ], 0.03);   // cross bar
  for (const [a, b, r] of o.struts || [[[0.42, 0.28, 0.1], [0, H, 0.05], 0.04], [[-0.42, 0.28, 0.1], [0, H, 0.05], 0.04],
    [[0, 0.5, -0.9], [0, H + 0.05, -0.5], 0.035]]) rod(a, b, r);   // struts down to the vehicle
  // small tail fin on the keel
  const fin = new THREE.BufferGeometry();
  fin.setAttribute('position', new THREE.Float32BufferAttribute([0, H + 0.12, TZ, 0, H + 0.12, TZ + 0.65 * f, 0, H + 0.12 + 0.63 * f, TZ - 0.1 * f], 3));
  fin.computeVertexNormals();
  const tailFin = new THREE.Mesh(fin, new THREE.MeshLambertMaterial({ color: palette.wing, side: THREE.DoubleSide }));
  tailFin.name = 'glider-fin'; g.add(tailFin);
  return g;
}
