// Ramp regression: the real car physics driven through every ramp taper of a test build, both ways:
//   exit:  on the main road 100 m before the meet -> into the added lane -> along the ramp past the gore
//   entry: on the ramp past the gore -> along the lane -> over the lane drop onto the main road, 100 m on
// at 120 km/h by default; prints flips, longest air, NaN, biggest vertical speed change in one step (bumps).
//   node tools/ramp_drive_test.mjs <scratch-assets> [kmh,kmh]
import fs from 'fs';
import * as THREE from 'three';
import { makeWorld, makeTileData, prepRoad } from '../game/src/data.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { readTileData } from '../game/src/tilepack.js';

const A = (process.argv[2] || 'game/assets').replace(/\/?$/, '/');
const SPEEDS = (process.argv[3] || '120').split(',').map(Number);
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const WJ = JSON.parse(fs.readFileSync(A + 'world.json')), W = makeWorld(WJ), raw = {};
for (const [tx, tz] of WJ.tiles) {
  const d = `${A}tiles/${tx}_${tz}/`;
  const data = WJ.packed ? await readTileData(async f => ab(d + f), WJ.packed)
    : { hbuf: ab(d + 'height.bin'), sbuf: ab(d + 'surface.bin'), tbuf: ab(d + 'trees.bin'), pbuf: ab(d + 'ponds.bin'), tile: JSON.parse(fs.readFileSync(d + 'tile.json')) };
  raw[`${tx}_${tz}`] = data.tile; W.add(makeTileData(WJ, tx, tz, data));
}
const strips = Object.values(raw).flatMap(t => t.physPaths.map(p => { const r = prepRoad(p, 0); if (r) r.src = p; return r; }).filter(Boolean));
for (const r of strips) { r.cum = [0]; for (let i = 1; i < r.n; i++) r.cum.push(r.cum[i - 1] + Math.hypot(r.x[i] - r.x[i - 1], r.z[i] - r.z[i - 1])); }
function onStrip(r, s) {
  s = Math.min(Math.max(s, 0), r.cum[r.n - 1]); let i = 0; while (i < r.n - 2 && r.cum[i + 1] < s) i++;
  const t = Math.min(1, Math.max(0, (s - r.cum[i]) / (r.cum[i + 1] - r.cum[i] || 1))), f = a => a[i] + (a[i + 1] - a[i]) * t;
  return { x: f(r.x), z: f(r.z), lx: f(r.lx), lz: f(r.lz) };
}
function proj(r, x, z) {               // [arc s, offset left, distance] on strip r
  let best = null;
  for (let i = 0; i < r.n - 1; i++) {
    const ax = r.x[i], az = r.z[i], ex = r.x[i + 1] - ax, ez = r.z[i + 1] - az, L2 = ex * ex + ez * ez; if (L2 < 1e-6) continue;
    const u = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / L2)), L = Math.sqrt(L2);
    const d = Math.hypot(x - ax - ex * u, z - az - ez * u);
    if (!best || d < best[2]) best = [r.cum[i] + u * L, ((x - ax) * ez - (z - az) * ex) / L, d];
  }
  return best;
}
// tapers: lane add / drop wedges (one end 0 wide) on main strips, the full lane after them, the ramp strip beside it
const tapers = [];
for (const r of strips) for (const [side, s0, s1, w0, w1] of r.src.widen || []) {
  if (w0 !== 0 && w1 !== 0) continue;
  const sN = w0 === 0 ? s0 : s1, dir = w0 === 0 ? 1 : -1, P = onStrip(r, sN);
  if (tapers.some(t => Math.hypot(t.x - P.x, t.z - P.z) < 2)) continue;
  const full = r.src.widen.find(w => w[3] === w[4] && Math.abs((dir > 0 ? w[1] : w[2]) - (dir > 0 ? s1 : s0)) < 0.5);
  if (!full) continue;
  const TP = (dir > 0 ? full[2] : full[1]), lane = Math.max(w0, w1), Q = onStrip(r, TP - dir * 5);
  const qx = Q.x + side * Q.lx * (r.hw + lane / 2), qz = Q.z + side * Q.lz * (r.hw + lane / 2);
  const ramp = strips.filter(o => o !== r && o.osm && /_link/.test(o.osm)).map(o => [o, proj(o, qx, qz)]).filter(([o, p]) => p[2] < 1).sort((a, b) => a[1][2] - b[1][2])[0];
  if (!ramp) continue;
  tapers.push({ r, side, sN, dir, x: P.x, z: P.z, LD: Math.abs(s1 - s0), TP: Math.abs(TP - sN), lane, ramp: ramp[0], rs: ramp[1][0] });
}
const DT = 1 / 120, up = new THREE.Vector3(), fw = new THREE.Vector3();
let worst = { flips: 0, air: 0, jolt: 0, nan: 0 };
for (const t of tapers) {
  const { r, side, sN, dir, LD, TP, lane, ramp } = t, hm = r.hw, D = hm + ramp.hw;
  // route (exit direction): main centre from u = -100, lane change over the wedge, the lane, then the ramp strip
  // (starting after any bridge deck over the main road: physics takes the highest surface, so a car under a deck
  // is lifted onto it; that is the overpass limit for BR-3, not a taper test)
  const route = [], decks = strips.filter(o => o.src.bridge);
  const underDeck = (x, z) => decks.some(o => { const p = proj(o, x, z); return p[2] < o.hw + 8; });
  let u0 = -100;
  for (let u = TP; u >= -100; u -= 2) { const P = onStrip(r, sN + dir * u); if (underDeck(P.x, P.z)) { u0 = u + 20; break; } }
  for (let u = u0; u <= TP; u += 2) {                  // main road: the near lane's centre (hm / 2 out)
    const P = onStrip(r, sN + dir * u), off = u <= 0 ? hm / 2 : u >= LD ? D : hm / 2 + (D - hm / 2) * u / LD;
    route.push([P.x + side * P.lx * off, P.z + side * P.lz * off]);
  }
  if (route.length < 10) { console.log(`${t.x.toFixed(0)},${t.z.toFixed(0)}: taper under a bridge deck, not driven`); continue; }
  // along the ramp away from the meet: the direction where its offset from the main road grows
  const a = onStrip(ramp, t.rs + 10), b = onStrip(ramp, t.rs - 10);
  const away = Math.abs(proj(r, a.x, a.z)[0] - sN) > Math.abs(proj(r, b.x, b.z)[0] - sN) ? 1 : -1;
  // (only along the gore: ramp within ~6 m of the main road's edge; a loop ramp turns hard soon after, no taper test)
  for (let s = t.rs + away * 5; s >= 0 && s <= ramp.cum[ramp.n - 1] && Math.abs(s - t.rs) < 100; s += away * 2) {
    const P = onStrip(ramp, s), q = proj(r, P.x, P.z);
    if (q[1] * side > D + 6) break;
    route.push([P.x, P.z]);
  }
  for (const [name, R] of [['exit', route], ['entry', [...route].reverse()]]) for (const kmh of SPEEDS) {
    const car = new Car(W, { ...TUNING_DEFAULTS }), yaw = Math.atan2(R[3][0] - R[0][0], R[3][1] - R[0][1]);
    car.reset(R[0][0], R[0][1], yaw); car.vel.set(Math.sin(yaw) * kmh / 3.6, 0, Math.cos(yaw) * kmh / 3.6);
    const inp = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    let maxStep = 0, ground = W.heightAt(car.pos.x, car.pos.z);
    let tgt = 0, flips = 0, wasUp = true, air = 0, jolt = 0, vy = 0, nan = false, done = false, surf = new Set(), firstAir = '', firstOff = '';
    for (let i = 0; i < 40 / DT && !done; i++) {
      const v = car.vel.length() * 3.6;
      inp.throttle = v < kmh ? 1 : 0; inp.brake = v > kmh + 15 ? 0.5 : 0;
      const look = 8 + car.vel.length() * 0.2;
      while (R[tgt + 1] && Math.hypot(R[tgt][0] - car.pos.x, R[tgt][1] - car.pos.z) < look) tgt++;
      const [lx, lz] = R[R.length - 1], [px, pz] = R[R.length - 2];        // stop at / past the last point
      if (!R[tgt + 1] && (Math.hypot(lx - car.pos.x, lz - car.pos.z) < 8 || (car.pos.x - lx) * (lx - px) + (car.pos.z - lz) * (lz - pz) > 0)) done = true;
      fw.set(0, 0, 1).applyQuaternion(car.quat);
      let d = Math.atan2(R[tgt][0] - car.pos.x, R[tgt][1] - car.pos.z) - Math.atan2(fw.x, fw.z); d = Math.atan2(Math.sin(d), Math.cos(d));
      inp.steer = Math.max(-1, Math.min(1, -d * 3));
      car.step(DT, inp);
      const nextGround = W.heightAt(car.pos.x, car.pos.z);
      maxStep = Math.max(maxStep, Math.abs(nextGround - ground)); ground = nextGround;
      if (!isFinite(car.pos.x) || !isFinite(car.pos.y)) { nan = true; break; }
      up.set(0, 1, 0).applyQuaternion(car.quat); if (wasUp && up.y < 0) flips++; wasUp = up.y > 0;
      if (car.airTime > 0.3 && !firstAir) firstAir = `${car.pos.x.toFixed(0)},${car.pos.z.toFixed(0)}`;
      air = Math.max(air, car.airTime); if (i > 60) jolt = Math.max(jolt, Math.abs(car.vel.y - vy)); vy = car.vel.y; surf.add(W.surfaceAt(car.pos.x, car.pos.z));
      if (W.surfaceAt(car.pos.x, car.pos.z) !== 3 && !firstOff) firstOff = `${car.pos.x.toFixed(2)},${car.pos.z.toFixed(2)} step ${i} target ${tgt} route distance ${Math.min(...R.map(p => Math.hypot(car.pos.x-p[0],car.pos.z-p[1]))).toFixed(2)}`;
    }
    const end = Math.hypot(R[R.length - 1][0] - car.pos.x, R[R.length - 1][1] - car.pos.z);
    console.log(`${t.x.toFixed(0)},${t.z.toFixed(0)} ${name} ${kmh} km/h: flips ${flips}, longest air ${air.toFixed(2)} s, ` +
      `biggest vertical speed change in one step ${jolt.toFixed(2)} m/s${nan ? ', NaN!' : ''}, ${done ? 'reached the end' : `stopped ${end.toFixed(0)} m short`}, surfaces ${[...surf].join('/')}` +
      (firstAir ? `, first air > 0.3 s at ${firstAir}` : ''));
    console.log('max ground step', maxStep.toFixed(4), firstOff ? `first off asphalt ${firstOff}` : '');
    if (!done || flips || nan || maxStep > 0.15 || [...surf].some(s => s !== 3)) process.exitCode = 1;
    worst = { flips: worst.flips + flips, air: Math.max(worst.air, air), jolt: Math.max(worst.jolt, jolt), nan: worst.nan + (nan ? 1 : 0) };
  }
}
if (!tapers.length) throw new Error('fixture contains no driveable tapers');
console.log(`tapers driven: ${tapers.length} · total flips ${worst.flips}, NaN runs ${worst.nan}, longest air ${worst.air.toFixed(2)} s, biggest step jolt ${worst.jolt.toFixed(2)} m/s`);
