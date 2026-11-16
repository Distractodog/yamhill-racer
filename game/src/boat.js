// Jet ski and speedboat: one hull model, two presets (JETSKI, SPEEDBOAT). Fixed 120 Hz step like the car.
// Local axes: +z forward (bow), +y up, +x = left (port). The model's origin sits on the waterline at rest.
//
//   * Water: wherever waterLevelAt has a level over the ground (ponds and river pools). The hull floats on a damped
//     spring toward the water surface (+ small travelling ripples + the wake it left behind), lifts and trims bow-up
//     through the "hump" as it gets on the plane, and bobs / pitches with the waves under its bow and stern.
//   * Steering: a jet pump only steers with water going through it, so there is little turn at a standstill. The
//     hull carves (sideways slip is soaked up at `latGrip` per second), with a cap on sideways acceleration, so the
//     heavier speedboat turns wider. The jet ski leans hard into a turn, the speedboat banks a little.
//   * Shallow water (depth < minDepth) drags on the hull; ground above the water (a bank, a sand bar, a road) beaches
//     it: it slides to a stop on the hull, and W / S push it slowly along so you can shove it back in.
//   * reset(x, z) on land (picking a boat from the V menu, H, F) finds the nearest water that is big enough within the
//     loaded tiles; none loaded: it holds the boat at the nearest LAUNCH_SPOTS entry while that streams in (like H),
//     then puts it on the water there. R goes back to the last open water you were on. Switching from a boat to a
//     land vehicle puts that on the nearest bank (findBank, used by vehicles.js).
//   * The wake: points dropped behind the stern every WAKE_DT seconds; each spreads out as a ring, so together they
//     make the V behind the boat (drawn as foam strips in syncMesh) and the ridges you bump over when you cross it.
// Physics reads the world only through heightAt / terrainAt / surfaceAt / normalAt / waterLevelAt / treesNear /
// buildingsNear (+ loadedAt / extent).
import * as THREE from 'three';
import { Vehicle } from './vehicle.js';

export const JETSKI = {
  kind: 'jetski', name: 'Jet ski',
  topSpeed: 100,        // km/h on open water
  accel: 12,            // m/s² from standstill
  brake: 9,             // m/s² of reverse thrust while still going forward
  reverse: 3,           // m/s top speed backwards
  turnRate: 1.9,        // rad/s at low/medium speed, full lock
  turnResponse: 10,     // 1/s: how quickly the turn follows the bars (twitchy)
  latGrip: 4.2,         // 1/s: how quickly sideways slip is soaked up
  latMax: 20,           // m/s² most sideways acceleration in a turn
  lean: 0.52,           // rad: lean into a full turn (~30°)
  leanRate: 8,
  twitch: 0.5,          // rad/s of yaw kicked by the ripples at speed
  planeKmh: 24,         // on the plane above this
  rise: 0.12,           // m the hull lifts when on the plane
  hump: 0.13,           // rad of bow-up while getting on the plane
  bobK: 70, bobC: 9,    // heave spring / damping (per unit mass)
  pitchK: 60, pitchC: 11,
  ripple: 0.06,         // m ripple height it rides over
  wake: 0.22,           // m height of its wake ridges
  len: 3.2, beam: 1.15, keel: 0.24, minDepth: 0.35, radius: 0.65,
  gravity: 20,
  landFric: 9,          // m/s² sliding friction on the hull when beached
  push: 2.2,            // m/s shoving it along on land
};
export const SPEEDBOAT = {
  kind: 'boat', name: 'Speedboat',
  topSpeed: 120, accel: 8.5, brake: 7, reverse: 2.6,
  turnRate: 1.05, turnResponse: 3.2, latGrip: 2.3, latMax: 11,
  lean: 0.22, leanRate: 3.5, twitch: 0,
  planeKmh: 32, rise: 0.2, hump: 0.12,
  bobK: 32, bobC: 7.5, pitchK: 26, pitchC: 8,
  ripple: 0.06, wake: 0.35,
  len: 6.4, beam: 2.3, keel: 0.4, minDepth: 0.6, radius: 1.15,
  gravity: 20, landFric: 11, push: 1.6,
};

const WAKE_N = 52, WAKE_DT = 0.12, WAKE_SKIP = 1.0;   // trail points, seconds apart, ignore younger ones for bumps
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _qy = new THREE.Quaternion(), _qp = new THREE.Quaternion(),
  _qr = new THREE.Quaternion(), _X = new THREE.Vector3(1, 0, 0), _Y = new THREE.Vector3(0, 1, 0), _Z = new THREE.Vector3(0, 0, 1);
// small travelling ripples on every pond and river (-1..1, 4–9 m apart); the same for every ride
export const ripple = (x, z, t) => 0.5 * Math.sin(0.9 * x + 0.6 * z + 1.7 * t) + 0.3 * Math.sin(-0.5 * x + 1.3 * z + 2.3 * t)
  + 0.2 * Math.sin(1.4 * x - 0.8 * z + 3.1 * t);

// water at (x, z): its level, or -Infinity (no water, or the ground is above it)
function waterAt(W, x, z) { const wl = W.waterLevelAt(x, z); return wl > W.terrainAt(x, z) ? wl : -Infinity; }

// Nearest open water within `radius` m that is deep enough (minDepth + 0.2) with clear water `clear` m round it,
// facing along its longest open stretch. Only loaded tiles count. Returns [x, z, yaw] or null.
export function findWater(W, x0, z0, { minDepth = 0.5, clear = 6, radius = 1400, yaw = null } = {}) {
  const deep = (x, z, d) => waterAt(W, x, z) - W.terrainAt(x, z) >= d;
  const ok = (x, z) => {
    if (!deep(x, z, minDepth + 0.2)) return false;
    for (let a = 0; a < 12; a++) if (!deep(x + Math.sin(a * Math.PI / 6) * clear, z + Math.cos(a * Math.PI / 6) * clear, minDepth * 0.6)) return false;
    return true;
  };
  const run = (x, z, a, max = 80) => { let r = 3; while (r < max && deep(x + Math.sin(a) * r, z + Math.cos(a) * r, minDepth * 0.6)) r += 3; return r; };
  let best = null;
  for (let r = 0; r <= radius && !best; r += 6) {
    const n = Math.max(1, Math.ceil(2 * Math.PI * r / 6));
    let bd = Infinity;
    for (let k = 0; k < n; k++) {
      const a = k / n * 2 * Math.PI, x = x0 + Math.sin(a) * r, z = z0 + Math.cos(a) * r;
      if (waterAt(W, x, z) === -Infinity || !ok(x, z)) continue;
      // on a ring, prefer the spot with the most open water (middle of the river, not its edge)
      const d = -Math.min(run(x, z, a + Math.PI / 2), run(x, z, a - Math.PI / 2), run(x, z, a), run(x, z, a + Math.PI));
      if (d < bd) { bd = d; best = [x, z]; }
    }
  }
  if (!best) return null;
  if (yaw !== null && run(best[0], best[1], yaw) >= 24) return [best[0], best[1], yaw];
  let by = 0, br = -1;
  for (let a = 0; a < Math.PI * 2; a += 0.1) { const r = run(best[0], best[1], a, 400); if (r > br) { br = r; by = a; } }
  return [best[0], best[1], by];
}

// Launch spots for when no water is loaded near you: open water at least 1 m deep with 150–300 m of straight run,
// the best one per tile, then the farthest-apart ones (≥ 4.5 km) inside the map rim. y = water level (camera height
// while the tiles there stream in). Checked by tools/boat_test.mjs.
export const LAUNCH_SPOTS = [
  { name: 'the South Yamhill at Sheridan', x: 3694, z: 1350, y: 52.2 },
  { x: 18620, z: -24796, y: 43.2 }, { x: 29852, z: -868, y: 27.5 }, { x: 17540, z: 12812, y: 60.8 },
  { x: 2548, z: -22100, y: 576.7 }, { x: 16332, z: -5452, y: 30 }, { x: -10076, z: 5252, y: 84.9 },
  { x: 27468, z: -13980, y: 46.9 }, { x: -1020, z: -11740, y: 503.4 }, { x: 8860, z: 9564, y: 55.7 },
  { x: 10212, z: -12196, y: 136.7 }, { x: 26836, z: 7396, y: 49.1 },
];

function insideBuilding(W, x, z, margin) {
  for (const b of W.buildingsNear(x, z, 40)) {
    const pts = b.pts; if (!pts) continue;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [x1, z1] = pts[j], [x2, z2] = pts[i];
      if (((z2 > z) !== (z1 > z)) && (x < (x1 - x2) * (z - z2) / (z1 - z2) + x2)) inside = !inside;
      const ex = x2 - x1, ez = z2 - z1, u = Math.max(0, Math.min(1, ((x - x1) * ex + (z - z1) * ez) / (ex * ex + ez * ez || 1)));
      if (Math.hypot(x - x1 - ex * u, z - z1 - ez * u) < margin) return true;
    }
    if (inside) return true;
  }
  return false;
}
// Dry clearance for a saved return point too: streamed-out neighbours count as unknown, never as dry.
export function dryBankArea(W, x, z, clear = 6) {
  const reach = Math.ceil(clear + 0.75);
  for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
    if (dx * dx + dz * dz > (clear + 0.75) ** 2) continue;
    if (!W.loadedAt(x + dx, z + dz) || waterAt(W, x + dx, z + dz) !== -Infinity) return false;
  }
  return true;
}

// Nearest flat, dry ground next to (x0, z0), facing away from it. `clear` covers the entire vehicle plus a
// water margin, in every heading. Check the whole disc, not just its rim: a narrow inlet can lie between probes.
// Nearly level support is essential: an initially dry car can roll back down a steep bank in under two seconds.
export function findBank(W, x0, z0, { radius = 300, clear = 6 } = {}) {
  const n = new THREE.Vector3(), probes = [], reach = Math.ceil(clear + 0.75);
  // One-metre grid with extra padding keeps at least `clear` metres covered between samples.
  for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
    if (dx * dx + dz * dz <= (clear + 0.75) ** 2) probes.push([dx, dz]);
  }
  const dry = (x, z) => W.loadedAt(x, z) && waterAt(W, x, z) === -Infinity;
  const good = (x, z) => {
    if (!dry(x, z)) return false;
    const h = W.heightAt(x, z, W.terrainAt(x, z) + 1);
    if (W.normalAt(x, z, n, h + 1).y < 0.995) return false;
    if (!dryBankArea(W, x, z, clear)) return false;
    for (const [dx, dz] of probes) {
      if (Math.abs(W.heightAt(x + dx, z + dz, h + 1) - h) > 0.6) return false;
    }
    let tree = false; W.treesNear(x, z, 3.5, () => { tree = true; });
    return !tree && !insideBuilding(W, x, z, 3);
  };
  for (let r = 0; r <= radius; r += 3) {
    const k = Math.max(1, Math.ceil(2 * Math.PI * r / 3));
    for (let i = 0; i < k; i++) {
      const a = i / k * 2 * Math.PI, x = x0 + Math.sin(a) * r, z = z0 + Math.cos(a) * r;
      if (good(x, z)) return [x, z, r ? a : 0];
    }
  }
  return null;
}

export class Boat extends Vehicle {
  static holdPatience = 30000;    // ms holdAt waits for other tiles to finish streaming (tests shorten it)
  constructor(world, tuning = JETSKI) {
    super(world, tuning.kind);
    this.t = tuning; this.name = tuning.name;
    this.yaw = 0; this.yawRate = 0; this.pitch = 0; this.pitchRate = 0; this.lean = 0; this.leanRate = 0;
    this.time = 0; this.plane = 0; this.mode = 'water'; this.shallow = 0; this.beachedT = 0; this.waterSafe = []; this.launching = null;
    this.wake = { x: new Float32Array(WAKE_N), z: new Float32Array(WAKE_N), y: new Float32Array(WAKE_N),
      dx: new Float32Array(WAKE_N), dz: new Float32Array(WAKE_N), age: new Float32Array(WAKE_N).fill(99),
      s: new Float32Array(WAKE_N), v: new Float32Array(WAKE_N), i: 0, t: 0 };
    const hl = tuning.len / 2, hb = tuning.beam / 2;
    // spray points for effects.js (it throws spray off "wheels" touching water, surface 5): stern corners + bow
    this.wheels = [[hb * 0.8, -hl * 0.9, false], [-hb * 0.8, -hl * 0.9, false], [0, hl * 0.45, true]].map(([x, z, front]) =>
      ({ x, z, front, contact: false, surf: 5, comp: 0, contactPoint: new THREE.Vector3(), spin: 0 }));
    this.mesh = tuning.kind === 'boat' ? buildSpeedboatModel() : buildJetSkiModel();
    this.wakeMesh = makeWakeMesh(); this.mesh.add(this.wakeMesh);
    this.cam = tuning.kind === 'boat'
      ? { dist: 8.2, high: 2.7, distPerSpeed: 0.03, nose: [0, 1.75, 0.3], flat: true }
      : { dist: 4.8, high: 1.75, distPerSpeed: 0.024, nose: [0, 1.45, 0.1], roll: 0.12, flat: true };
    this.half = { x: hb, front: hl, back: -hl };              // footprint for the challenge walls
    // no glider on a boat (G): main.js toggles `glide` if the vehicle has one
    this.glide = { active: false, bank: 0, cancel() {}, toggle: () => this.say('No glider on the water', 1.5) };
  }

  setQuat() {
    _qy.setFromAxisAngle(_Y, this.yaw); _qp.setFromAxisAngle(_X, -this.pitch); _qr.setFromAxisAngle(_Z, this.lean);
    this.quat.copy(_qy).multiply(_qp).multiply(_qr);
  }

  // on water: right there if it's open enough, else the nearest water that is; no water loaded nearby: on the spot
  reset(x, z, yaw = null, { launch = true } = {}) {
    const t = this.t, W = this.world;
    this.launching = null;                                      // cancels a launch hold in progress
    const spot = findWater(W, x, z, { minDepth: t.minDepth, clear: t.beam * 2.6, yaw });
    if (!spot && launch) { this.launchFrom(x, z); return; }
    if (spot) [x, z, yaw] = spot; else yaw ??= 0;
    const wl = waterAt(W, x, z);
    this.yaw = yaw; this.yawRate = 0; this.pitch = 0; this.pitchRate = 0; this.lean = 0; this.leanRate = 0; this.plane = 0;
    this.pos.set(x, Number.isFinite(wl) ? wl : W.heightAt(x, z) + t.keel, z);
    this.vel.set(0, 0, 0); this.ang.set(0, 0, 0); this.steer = 0; this.airTime = 0; this.shallow = 0; this.beachedT = 0;
    this.mode = Number.isFinite(wl) ? 'water' : 'land';
    this.wake.age.fill(99); this.wake.t = 0;
    this.setQuat();
    if (!spot) this.say('No open water here', 3);
    this.afterReset();
  }
  // no water loaded near (x, z): go to the nearest launch spot, held still (step does nothing) until its tiles are in
  // (the camera follows the boat there, which streams them), then onto the water. `launchDone` resolves when it's there.
  launchFrom(x, z) {
    const L = LAUNCH_SPOTS.reduce((a, b) => Math.hypot(b.x - x, b.z - z) < Math.hypot(a.x - x, a.z - z) ? b : a);
    this.say(`No river or pond near here: off to ${L.name || 'the nearest launch spot'} (${(Math.hypot(L.x - x, L.z - z) / 1000).toFixed(1)} km)`, 4);
    this.holdAt(L, () => this.reset(L.x, L.z, null, { launch: false }));
  }
  // hold the boat still at {x, z, y} until the ground there has streamed in, then done(). It never lets go onto ground
  // that isn't loaded: past Boat.holdPatience (ms) it stops waiting for other tiles still streaming elsewhere, but not
  // for this one (it says so and keeps holding). Another reset / holdAt, or setting `launching` to null (vehicles.js
  // does on a switch), cancels it. `away`: the hold only loads ground for a land vehicle, so the boat isn't drawn.
  holdAt(L, done, { away = false } = {}) {
    const hold = this.launching = { x: L.x, z: L.z, away }, W = this.world;
    this.pos.set(L.x, L.y ?? this.pos.y, L.z); this.vel.set(0, 0, 0); this.ang.set(0, 0, 0); this.yawRate = 0; this._lastLoaded = null;
    this.mode = 'water'; this.grounded = true; this.onWater = false; this.wake.age.fill(99);
    this.afterReset();
    this.launchDone = (async () => {
      const end = Date.now() + Boat.holdPatience;
      let told = false;
      while (this.launching === hold && (!W.loadedAt(L.x, L.z) || (W.pendingTiles?.() > 0 && Date.now() < end))) {
        if (!told && Date.now() >= end) { told = true; this.say('Still loading the map there…', 4); }
        await new Promise(r => setTimeout(r, 100));
      }
      if (this.launching === hold) { this.launching = null; done(); }
    })();
  }
  // R: the last open water you were on (the land vehicles' safe spots aren't water); none close by (an old ride
  // somewhere else on the map): the nearest water from here
  resetToSafe() {
    const s = this.waterSafe.length > 12 ? this.waterSafe[this.waterSafe.length - 12] : this.waterSafe[0];
    if (s && Math.hypot(s[0] - this.pos.x, s[1] - this.pos.z) < 800) this.reset(s[0], s[1], s[2]);
    else this.reset(this.pos.x, this.pos.z, this.yaw);
  }

  // height of the water surface at (x, z): level + ripples + wake ridges (level -Infinity: no water)
  surfaceY(level, x, z) {
    if (level === -Infinity) return level;
    const k = this.wake; let h = level + this.t.ripple * ripple(x, z, this.time);
    for (let i = 0; i < WAKE_N; i++) {
      const a = k.age[i]; if (a < WAKE_SKIP || a > 6) continue;
      const r = a * k.v[i], d = Math.hypot(x - k.x[i], z - k.z[i]) - r;
      if (d > 2.5 || d < -2.5) continue;
      h += this.t.wake * k.s[i] * Math.exp(-a / 2.5 - d * d);
    }
    return h;
  }

  step(dt, input) {
    if (this.launching) { this.pos.x = this.launching.x; this.pos.z = this.launching.z; this.vel.set(0, 0, 0); this._lastLoaded = null; return; }
    const t = this.t, W = this.world, g = t.gravity, hl = t.len / 2 * 0.8, hb = t.beam / 2;
    this._prevVel.copy(this.vel); this.time += dt; this.hit = 0;
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);   // forward (s, c), left (c, -s)
    const p = this.pos;

    // ---------------------------------------------- what's under the hull: water level / ground at bow, centre, stern
    let wet = 0, levelSum = 0, floor = -Infinity, depth = -Infinity;
    const lv = [0, 0, 0], gr = [0, 0, 0];
    [hl, 0, -hl].forEach((zo, i) => {
      const x = p.x + s * zo, z = p.z + c * zo, w = waterAt(W, x, z);
      let gnd = W.heightAt(x, z, p.y);
      if (w > -Infinity && gnd > w + 0.5) gnd = W.terrainAt(x, z);    // a bridge deck over the water, not the bed
      lv[i] = w; gr[i] = gnd;
      if (w > -Infinity) { wet++; levelSum += w; }
      if (i === 1) depth = w - W.terrainAt(x, z);
    });
    floor = Math.max(gr[1], (gr[0] + gr[2]) / 2) + t.keel;
    this.mode = depth > 0.06 ? 'water' : 'land';
    this.shallow = this.mode === 'water' ? clamp((t.minDepth - depth) / t.minDepth, 0, 1) : 0;

    const vf0 = this.vel.x * s + this.vel.z * c, kmh = Math.abs(vf0) * 3.6;
    this.plane += (clamp((kmh - t.planeKmh * 0.55) / (t.planeKmh * 0.75), 0, 1) - this.plane) * Math.min(1, 3 * dt);

    // ---------------------------------------------- heave: float on the water surface (or rest on the ground)
    let support = 0, sB = -Infinity, sS = -Infinity;
    const level = wet ? levelSum / wet : -Infinity;
    if (wet) {
      sB = this.surfaceY(lv[0] > -Infinity ? lv[0] : level, p.x + s * hl, p.z + c * hl);
      sS = this.surfaceY(lv[2] > -Infinity ? lv[2] : level, p.x - s * hl, p.z - c * hl);
      const target = (sB + sS) / 2 + t.rise * this.plane, sub = target - p.y;
      support = clamp((sub + 0.25) / 0.12, 0, 1);              // 0 = clear of the water (off a wake), 1 = floating
      this.vel.y += (-g + support * (g + t.bobK * sub - t.bobC * this.vel.y)) * dt;
    } else this.vel.y -= g * dt;
    const onGround = p.y <= floor + 0.03;
    this.grounded = support > 0 || onGround;
    this.onWater = support > 0 && this.mode === 'water';
    this.waterDepth = 0;                                         // a hull floats: never "under water" for the effects

    // ---------------------------------------------- driving
    let vf = vf0, vl = this.vel.x * c - this.vel.z * s;
    const inp = { throttle: input.throttle || 0, brake: input.brake || 0, steer: input.steer || 0 };
    this.steer += clamp(inp.steer - this.steer, -8 * dt, 8 * dt);
    let wantYaw = 0;
    if (this.mode === 'water' && support > 0) {
      const vmax = t.topSpeed / 3.6 * (1 - 0.8 * this.shallow);
      let a = 0;
      if (inp.throttle) a += vf < -0.5 ? t.brake * inp.throttle : t.accel * inp.throttle * Math.max(0, 1 - (vf / vmax) ** 2);
      if (inp.brake) a -= vf > 0.5 ? t.brake * inp.brake : vf > -t.reverse ? 3 * inp.brake : 0;
      if (!inp.throttle && !inp.brake) a -= Math.sign(vf) * Math.min(Math.abs(vf) / dt, 1.4 + 0.0035 * vf * vf);
      a -= Math.sign(vf) * Math.min(Math.abs(vf) / dt, Math.abs(this.yawRate) * Math.abs(vf) * 0.12 + this.shallow * (1 + 0.4 * Math.abs(vf)));
      vf += a * dt * support;
      vl *= Math.exp(-t.latGrip * dt * support);
      // the pump steers with water going through it: little at a standstill, a bit less flat out
      const av = Math.abs(vf), auth = clamp((av + 1.2 * inp.throttle) / 6, 0, 1) * (1 - 0.3 * clamp((av - 12) / 25, 0, 1));
      wantYaw = -this.steer * t.turnRate * auth * (vf < -0.5 ? -1 : 1);
      if (av > 1 && Math.abs(wantYaw * av) > t.latMax) wantYaw = Math.sign(wantYaw) * t.latMax / av;   // heavier: wider
      wantYaw += t.twitch * this.plane * ripple(p.x * 0.7, p.z * 0.7, this.time * 1.9) * (sB - sS > 0 ? 1 : 0.6);
      this.yawRate += (wantYaw - this.yawRate) * Math.min(1, t.turnResponse * dt);
      this.beachedT = 0;
    } else if (this.grounded) {
      // beached (or touching ground): the hull slides to a stop; W / S shove it slowly along; slopes pull it downhill
      W.normalAt(p.x, p.z, _n, p.y);
      let ax = g * _n.x * _n.y, az = g * _n.z * _n.y;
      const want = (inp.throttle - inp.brake) * t.push, pushing = want !== 0 && Math.abs(vf) < t.push * 1.6;
      if (pushing) { vf += clamp(want - vf, -6 * dt, 6 * dt); vl *= Math.exp(-6 * dt); }
      const sp = Math.hypot(vf, vl), fr = Math.min(sp / dt, (t.landFric + 0.25 * sp) * (pushing ? 0.2 : 1));
      if (sp > 1e-6) { vf -= vf / sp * fr * dt; vl -= vl / sp * fr * dt; }
      const slope = Math.hypot(ax, az);
      if (slope < t.landFric * 0.7 && sp < 0.5 && !pushing) ax = az = 0;      // too gentle to slide on its own
      vf += (ax * s + az * c) * dt; vl += (ax * c - az * s) * dt;
      wantYaw = -this.steer * 0.6 * clamp(Math.abs(vf) / 1.5, 0, 1) * Math.sign(vf);
      this.yawRate += (wantYaw - this.yawRate) * Math.min(1, 6 * dt);
      if (this.mode === 'land' && this.beachedT === 0 && sp > 2) this.say('Beached! W / S push it back into the water', 2.5);
      this.beachedT += dt;
    } else {
      this.yawRate *= Math.exp(-1.5 * dt);                       // in the air off a wake: no grip, no thrust
      vf -= 0.0004 * vf * Math.abs(vf) * dt;
    }
    this.vel.x = s * vf + c * vl; this.vel.z = c * vf - s * vl;
    this.slipSigned = Math.atan2(vl, Math.max(Math.abs(vf), 2)); this.slip = Math.abs(this.slipSigned);
    this.drifting = false;

    // ---------------------------------------------- integrate
    p.addScaledVector(this.vel, dt);
    this.yaw += this.yawRate * dt;
    if (p.y < floor) {                                          // hull on the ground / the bed: stop sinking into it
      if (this.vel.y < -4) { this.landing = Math.min(1, -this.vel.y / 16); this.hit = Math.max(this.hit, -this.vel.y * 0.3); }
      p.y = floor; if (this.vel.y < 0) this.vel.y = 0;
    }
    const wasAir = this.airTime;
    this.airTime = this.grounded ? 0 : this.airTime + dt;
    if (this.grounded && wasAir > 0.3 && this._prevVel.y < -5) this.landing = Math.min(1, -this._prevVel.y / 14);

    // ---------------------------------------------- trim and lean
    const bell = Math.exp(-(((kmh - t.planeKmh * 0.7) / (t.planeKmh * 0.4)) ** 2));
    let pitchWant;
    if (this.mode === 'water' && support > 0) {
      pitchWant = t.hump * bell * (0.4 + 0.6 * inp.throttle) + 0.025 * this.plane + Math.atan2(sB - sS, 2 * hl) * 0.8
        + (inp.throttle ? 0.015 : 0) - (inp.brake && vf > 3 ? 0.03 : 0);
    } else if (this.grounded) pitchWant = Math.atan2(gr[0] - gr[2], 2 * hl);
    else pitchWant = this.pitch;
    this.pitchRate += (t.pitchK * (pitchWant - this.pitch) - t.pitchC * this.pitchRate) * dt;
    this.pitch = clamp(this.pitch + this.pitchRate * dt, -0.5, 0.5);
    let leanWant = 0;
    if (this.mode === 'water' && support > 0) {
      leanWant = clamp(-Math.atan(vf * this.yawRate / g) * (t.lean / 0.6), -t.lean, t.lean);
      leanWant += 0.4 * Math.atan2(this.surfaceY(level, p.x + c * hb, p.z - s * hb) - this.surfaceY(level, p.x - c * hb, p.z + s * hb), t.beam);
    } else if (this.grounded) {
      W.normalAt(p.x, p.z, _n, p.y); leanWant = Math.atan2(-(_n.x * c - _n.z * s), _n.y);
    }
    this.lean += (leanWant - this.lean) * Math.min(1, t.leanRate * dt);
    this.setQuat();
    this.ang.set(0, this.yawRate, 0);

    // ---------------------------------------------- collisions
    const tr = this.collideTrees(t.radius, t.kind === 'boat' ? [-2, 0, 2] : [-0.9, 0.9]);
    if (tr > 0) this.yawRate *= 0.5;
    this.collideBuildings(t.radius + 0.2);
    this.keepInBounds();
    this.trackAccel(dt);

    // ---------------------------------------------- wake trail + spray points + safe spots
    const k = this.wake;
    for (let i = 0; i < WAKE_N; i++) k.age[i] += dt;
    k.t += dt;
    if (k.t >= WAKE_DT) {
      k.t = 0;
      const i = k.i = (k.i + 1) % WAKE_N, sv = Math.hypot(this.vel.x, this.vel.z);
      k.x[i] = p.x - s * hl; k.z[i] = p.z - c * hl; k.y[i] = wet ? level : p.y; k.dx[i] = s; k.dz[i] = c; k.age[i] = 0;
      k.s[i] = this.onWater ? clamp(sv / 12, 0, 1) : 0; k.v[i] = 0.3 * sv + 0.4;
    }
    const sp = this.vel.length();
    for (const w of this.wheels) {
      const x = p.x + c * w.x + s * w.z, z = p.z - s * w.x + c * w.z;
      w.contact = this.onWater ? sp > 3 && (w.front ? bell > 0.3 && inp.throttle > 0 : this.plane > 0.15 || Math.abs(this.yawRate) > 0.4) : onGround;
      w.surf = this.onWater ? 5 : W.surfaceAt(x, z, p.y) === 5 ? 0 : W.surfaceAt(x, z, p.y);
      w.contactPoint.set(x, this.onWater ? p.y - 0.05 : floor - t.keel, z);
    }
    this.surface = this.onWater ? 5 : this.wheels[0].surf;
    if (this.onWater && depth > t.minDepth + 0.3 && sp > 2) {
      const last = this.waterSafe[this.waterSafe.length - 1];
      if (!last || Math.hypot(last[0] - p.x, last[1] - p.z) > 8) { this.waterSafe.push([p.x, p.z, this.yaw]); if (this.waterSafe.length > 120) this.waterSafe.shift(); }
    }
  }

  hudInfo() {
    if (this.mode === 'land' && this.grounded) return 'BEACHED · W / S push · R back to the water · ';
    if (this.shallow > 0.2) return 'SHALLOW · ';
    return !this.grounded && this.airTime > 0.2 ? 'AIR · ' : '';
  }

  syncMesh(dt) {
    const m = this.mesh, ud = m.userData;
    m.position.copy(this.renderPos); m.quaternion.copy(this.renderQuat);
    m.visible = !this.launching?.away;
    poseBoatParts(ud, this.steer, this.lean);
    updateWake(this.wakeMesh, this.wake, this.renderPos, this.yaw, this.t, this.onWater);
  }
}
// the moving parts of a boat model (also other players' boats, mp/remotes.js): bars / wheel turn, the rider leans
export function poseBoatParts(ud, steer, lean) {
  if (ud.bars) ud.bars.rotation.y = -steer * 0.45;
  if (ud.wheel) ud.wheel.rotation.z = steer * 1.6;
  if (ud.rider) ud.rider.rotation.z = lean * 0.35;      // hangs off the inside a little more than the hull
}

// ---------------------------------------------------------------- wake foam (world space, child of the boat mesh so it
// comes and goes with it; its matrix stays identity)
function makeWakeMesh() {
  const n = (WAKE_N + 1) * 3 * 2, g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('across', new THREE.BufferAttribute(new Float32Array(n), 1));
  const idx = [];
  for (let strip = 0; strip < 3; strip++) for (let i = 0; i < WAKE_N; i++) {
    const a = (strip * (WAKE_N + 1) + i) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  g.setIndex(idx);
  const across = g.attributes.across.array;
  for (let i = 0; i < n; i += 2) { across[i] = -1; across[i + 1] = 1; }
  const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2,
    vertexShader: 'attribute float alpha; attribute float across; varying float vA; varying float vU;' +
      'void main(){ vA = alpha; vU = across; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying float vA; varying float vU; void main(){ float e = 1.0 - abs(vU);' +
      ' gl_FragColor = vec4(0.94, 0.97, 1.0, vA * (0.35 + 0.65 * e) * smoothstep(0.0, 0.35, e)); }',
  }));
  mesh.name = 'wake'; mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.matrixWorldAutoUpdate = false;
  mesh.renderOrder = 3; mesh.castShadow = false;
  return mesh;
}
// three strips per trail point: the two spreading arms of the V and the churned water straight behind
function updateWake(mesh, k, rp, yaw, t, live) {
  const P = mesh.geometry.attributes.position.array, A = mesh.geometry.attributes.alpha.array;
  const hb = t.beam / 2, sx = Math.sin(yaw), cz = Math.cos(yaw);
  for (let strip = 0; strip < 3; strip++) for (let j = 0; j <= WAKE_N; j++) {
    // j = 0: at the stern now; then the trail points newest first
    let x, z, y, dx, dz, age, str, v;
    if (j === 0) { x = rp.x - sx * t.len * 0.42; z = rp.z - cz * t.len * 0.42; y = rp.y; dx = sx; dz = cz; age = 0; str = live ? k.s[k.i] : 0; v = k.v[k.i]; }
    else { const i = (k.i - j + 1 + WAKE_N) % WAKE_N; x = k.x[i]; z = k.z[i]; y = k.y[i]; dx = k.dx[i]; dz = k.dz[i]; age = k.age[i]; str = k.s[i]; v = k.v[i]; }
    if (age > 6) { const q = (strip * (WAKE_N + 1) + j) * 2, pr = q - 2; for (const e of [0, 1]) { for (let d = 0; d < 3; d++) P[(q + e) * 3 + d] = j ? P[(pr + e) * 3 + d] : 0; A[q + e] = 0; } continue; }
    const lx = dz, lz = -dx, o = ((strip * (WAKE_N + 1)) + j) * 2;
    let off = 0, w;
    if (strip === 2) w = hb * (0.7 + age * 0.35);
    else { off = (strip ? -1 : 1) * (hb * 0.8 + age * v); w = 0.35 + age * 0.45; }
    const fade = str * Math.exp(-age / (strip === 2 ? 1.2 : 2.2)) * (strip === 2 ? 0.75 : 0.6);
    for (const [q, side] of [[0, -1], [1, 1]]) {
      P[(o + q) * 3] = x + lx * (off + side * w); P[(o + q) * 3 + 1] = y + 0.04; P[(o + q) * 3 + 2] = z + lz * (off + side * w);
      A[o + q] = fade;
    }
  }
  mesh.geometry.attributes.position.needsUpdate = true; mesh.geometry.attributes.alpha.needsUpdate = true;
}

// ---------------------------------------------------------------- models
// A low-poly planing hull from cross-sections (stern → bow): each section [z, half width, deck y, stripe y, chine y,
// keel y]. Bands: deck edge → stripe (body), stripe → chine (trim), chine → keel (bottom). Flat-shaded.
function hullMeshes(sections, mats) {
  const ring = ([z, w, deck, stripe, chine, keel]) => [[w, deck, z], [w, stripe, z], [w * 0.92, chine, z], [0, keel, z], [-w * 0.92, chine, z], [-w, stripe, z], [-w, deck, z]];
  const rings = sections.map(ring), bands = [[0, 1, 'body'], [1, 2, 'trim'], [2, 3, 'bottom'], [3, 4, 'bottom'], [4, 5, 'trim'], [5, 6, 'body']];
  const pos = { body: [], trim: [], bottom: [], deck: [] };
  const quad = (out, a, b, c, d) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i < rings.length - 1; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    for (const [a, b, m] of bands) quad(pos[m], r0[a], r1[a], r1[b], r0[b]);
    quad(pos.deck, r0[6], r1[6], r1[0], r0[0]);
  }
  const st = rings[0];                                           // transom
  for (let k = 1; k < 6; k++) pos.bottom.push(...st[0], ...st[k], ...st[k + 1]);
  const root = new THREE.Group();
  for (const [m, arr] of Object.entries(pos)) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();                                    // materials are double-sided: winding doesn't matter
    const mesh = new THREE.Mesh(g, mats[m]); mesh.castShadow = true; root.add(mesh);
  }
  return root;
}
const lambert = (c, o = {}) => new THREE.MeshLambertMaterial({ color: c, flatShading: true, side: THREE.DoubleSide, ...o });
function riderParts(box, parent, mats, { seated = false } = {}) {
  const { jacket, gloves, helmet, dark, skin } = mats;
  for (const sd of [1, -1]) {
    if (seated) {
      box(0.14, 0.14, 0.46, jacket, sd * 0.13, 0.02, 0.2, 0, parent);       // thigh, forward on the seat
      box(0.12, 0.44, 0.12, jacket, sd * 0.13, -0.2, 0.42, 0.15, parent);    // shin
    } else {
      box(0.13, 0.44, 0.14, jacket, sd * 0.2, -0.05, 0.14, 0.75, parent);   // thigh
      box(0.12, 0.42, 0.12, dark, sd * 0.23, -0.25, 0.3, -0.25, parent);    // shin + boot
    }
    box(0.1, 0.4, 0.1, jacket, sd * 0.24, 0.42, 0.3, -1.0, parent);         // arm
    box(0.09, 0.09, 0.09, gloves, sd * 0.28, 0.3, 0.56, 0, parent);         // glove
  }
  box(0.4, 0.55, 0.26, jacket, 0, 0.42, 0.04, seated ? 0.1 : 0.32, parent);   // torso
  if (!seated) box(0.44, 0.3, 0.3, mats.vest, 0, 0.5, 0.06, 0.32, parent);      // life vest
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 1), helmet);
  head.position.set(0, seated ? 0.84 : 0.8, seated ? 0.1 : 0.2); head.castShadow = true; parent.add(head);
  if (seated) { box(0.2, 0.06, 0.14, skin, 0, 0.78, 0.2, 0, parent); box(0.36, 0.03, 0.22, helmet, 0, 0.9, 0.2, 0, parent); }   // face, cap peak
  else box(0.22, 0.08, 0.14, dark, 0, 0.8, 0.34, 0, parent);                  // goggles
}

// jet ski: 3.2 m long. Rider standing-crouched like the dirt bike's, hands on the bars.
export function buildJetSkiModel() {
  const root = new THREE.Group(); root.name = 'jetski';
  const body = lambert(0x13a3c9), trim = lambert(0xffd23a), bottom = lambert(0xe9ecef), deck = lambert(0x2a2e36),
    dark = lambert(0x1d1f24), grey = lambert(0x8a9099), helmet = lambert(0xffffff), jacket = lambert(0x1d1f24),
    gloves = lambert(0xff7a1a), vest = lambert(0xffd23a), skin = lambert(0xd9a27a);
  for (const [role, mat] of Object.entries({ body, trim, helmet, jacket, gloves })) mat.userData.cosmeticRole = role;
  vest.userData.cosmeticRole = 'trim';
  //            z     w     deck  stripe chine  keel
  root.add(hullMeshes([[-1.6, 0.55, 0.3, 0.12, -0.08, -0.24], [-0.6, 0.58, 0.34, 0.14, -0.08, -0.25], [0.5, 0.52, 0.38, 0.16, -0.06, -0.22],
    [1.2, 0.34, 0.42, 0.22, 0.04, -0.1], [1.6, 0.04, 0.44, 0.36, 0.3, 0.22]], { body, trim, bottom, deck }));
  const box = (w, h, d, mat, x, y, z, rx = 0, parent = root) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.rotation.x = rx; m.castShadow = true; parent.add(m); return m;
  };
  box(0.7, 0.2, 0.9, body, 0, 0.44, 0.75, -0.12);                // engine cowl / nose hump
  box(0.42, 0.18, 1.2, dark, 0, 0.47, -0.25);                    // seat
  box(0.36, 0.06, 1.1, trim, 0, 0.57, -0.25);                    // seat stripe
  box(0.3, 0.34, 0.3, body, 0, 0.7, 0.4, 0.5);                   // steering pod
  box(0.3, 0.12, 0.1, deck, 0, 0.26, -1.62);                     // pump nozzle
  const bars = new THREE.Group(); bars.position.set(0, 0.9, 0.44); root.add(bars);
  box(0.7, 0.04, 0.04, grey, 0, 0, 0, 0, bars);
  box(0.06, 0.06, 0.12, dark, 0.33, 0, 0, 0, bars); box(0.06, 0.06, 0.12, dark, -0.33, 0, 0, 0, bars);
  const rider = new THREE.Group(); rider.position.set(0, 0.62, -0.2); root.add(rider);
  riderParts(box, rider, { jacket, gloves, helmet, dark, skin, vest });
  const hb = 0.58;
  root.userData = {
    bars, rider, wheels: [], blob: [1.2, 3.2],
    decalSpots: [[0.5, 0.17, hb + 0.012, 0.23, -0.9, 0, Math.PI / 2], [0.5, 0.17, -hb - 0.012, 0.23, -0.9, 0, -Math.PI / 2]],
    lights: { head: [new THREE.Vector3(0, 0.45, 1.25)], tail: [new THREE.Vector3(0.2, 0.32, -1.6), new THREE.Vector3(-0.2, 0.32, -1.6)],
      nav: { left: new THREE.Vector3(0.4, 0.45, 0.85), right: new THREE.Vector3(-0.4, 0.45, 0.85), tail: new THREE.Vector3(0, 0.62, -0.9) } },   // left = port (red)
  };
  return root;
}

// speedboat: 6.4 m runabout. Open cockpit, wrap-round windscreen, seated driver at the wheel, engine hatch aft.
export function buildSpeedboatModel() {
  const root = new THREE.Group(); root.name = 'speedboat';
  const body = lambert(0xf4f4ef), trim = lambert(0xc8202e), bottom = lambert(0x2a3442), deck = lambert(0xe9e2d0),
    dark = lambert(0x1d1f24), grey = lambert(0x8a9099), seat = lambert(0xd9d4c6), helmet = lambert(0x20242a),
    jacket = lambert(0x2f6db5), gloves = lambert(0x20242a), skin = lambert(0xd9a27a),
    glass = lambert(0x9fd3ef, { transparent: true, opacity: 0.45, depthWrite: false });
  for (const [role, mat] of Object.entries({ body, trim, helmet, jacket, gloves })) mat.userData.cosmeticRole = role;
  //            z     w     deck  stripe chine  keel
  root.add(hullMeshes([[-3.2, 1.08, 0.62, 0.3, -0.12, -0.4], [-1.5, 1.15, 0.66, 0.32, -0.12, -0.42], [0.6, 1.1, 0.7, 0.34, -0.1, -0.38],
    [2.0, 0.78, 0.78, 0.42, 0.04, -0.2], [2.9, 0.34, 0.84, 0.56, 0.3, 0.05], [3.2, 0.04, 0.86, 0.72, 0.6, 0.45]], { body, trim, bottom, deck }));
  const box = (w, h, d, mat, x, y, z, rx = 0, parent = root, ry = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.rotation.set(rx, ry, 0); m.castShadow = true; parent.add(m); return m;
  };
  // cockpit on the deck: floor mat, side coamings, seats, dash, engine hatch aft
  box(1.8, 0.03, 3.0, grey, 0, 0.68, -0.7);                       // cockpit floor mat
  box(0.07, 0.3, 3.6, body, 1.04, 0.8, -0.9); box(0.07, 0.3, 3.6, body, -1.04, 0.8, -0.9);   // side coamings
  box(1.9, 0.26, 1.0, body, 0, 0.78, -2.6);                       // engine hatch
  box(1.5, 0.04, 0.8, trim, 0, 0.92, -2.6);                       // hatch stripe
  box(1.9, 0.3, 0.6, seat, 0, 0.83, -1.55);                       // rear bench
  box(1.9, 0.5, 0.16, seat, 0, 1.12, -1.9, -0.12);                // …and its back
  for (const sx of [0.45, -0.45]) {
    box(0.55, 0.3, 0.55, seat, sx, 0.83, -0.2);                   // bucket seats
    box(0.55, 0.6, 0.14, seat, sx, 1.2, -0.5, -0.15);
  }
  box(1.9, 0.4, 0.35, dark, 0, 0.88, 0.55, -0.35);                // dash
  box(0.5, 0.06, 0.18, grey, -0.45, 1.08, 0.5, -0.35);            // gauges
  // wheel on the starboard side (local -x), the driver behind it
  const wheel = new THREE.Group(); wheel.position.set(-0.45, 1.2, 0.36); wheel.rotation.x = -0.9; root.add(wheel);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.025, 4, 10), dark); rim.castShadow = true; wheel.add(rim);
  box(0.3, 0.03, 0.03, dark, 0, 0, 0, 0, wheel);
  const rider = new THREE.Group(); rider.position.set(-0.45, 0.98, -0.25); root.add(rider);
  riderParts(box, rider, { jacket, gloves, helmet, dark, skin }, { seated: true });
  // windscreen: three raked panels round the front of the cockpit, with a dark frame on top
  const pane = (w, x, z, ry) => {
    const g = new THREE.Group(); g.position.set(x, 1.06, z); g.rotation.set(-0.55, ry, 0); root.add(g);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.5), glass); m.position.y = 0.25; g.add(m);
    box(w, 0.035, 0.035, dark, 0, 0.5, 0, 0, g);
  };
  pane(1.0, 0, 0.78, 0); pane(0.6, 0.76, 0.62, 0.6); pane(0.6, -0.76, 0.62, -0.6);
  box(0.05, 0.05, 1.0, grey, 0.7, 0.92, 1.6); box(0.05, 0.05, 1.0, grey, -0.7, 0.92, 1.6);   // bow rails
  box(0.3, 0.5, 0.35, dark, 0, 0.1, -3.32);                       // outdrive leg
  box(0.04, 0.6, 0.04, grey, 0, 1.2, -2.95);                      // stern light mast
  const hb = 1.15;
  root.userData = {
    wheel, rider, wheels: [], blob: [2.3, 6.4],
    decalSpots: [[0.9, 0.3, hb + 0.012, 0.47, -1.6, 0, Math.PI / 2], [0.9, 0.3, -hb - 0.012, 0.47, -1.6, 0, -Math.PI / 2]],
    lights: { head: [new THREE.Vector3(0.3, 0.85, 2.9), new THREE.Vector3(-0.3, 0.85, 2.9)],
      tail: [new THREE.Vector3(0.6, 0.72, -3.22), new THREE.Vector3(-0.6, 0.72, -3.22)],
      nav: { left: new THREE.Vector3(0.7, 0.95, 1.9), right: new THREE.Vector3(-0.7, 0.95, 1.9), tail: new THREE.Vector3(0, 1.52, -2.95) } },   // left = port (red)
  };
  return root;
}
