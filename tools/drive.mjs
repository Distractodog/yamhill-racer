// Headless test drives: runs the real car physics on the real world data, prints numbers.
import fs from 'fs';
import * as THREE from 'three';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
const A = 'game/assets/';
const WJ = JSON.parse(fs.readFileSync(A + 'world.json'));
const W = makeWorld(WJ);
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
for (const [tx, tz] of WJ.tiles) {
  const d = `${A}tiles/${tx}_${tz}/`;
  W.add(makeTileData(WJ, tx, tz, { hbuf: ab(d + 'height.bin'), sbuf: ab(d + 'surface.bin'), tbuf: ab(d + 'trees.bin'),
    pbuf: ab(d + 'ponds.bin'), tile: JSON.parse(fs.readFileSync(d + 'tile.json')) }));
}
// ponds as {level, x0, z0, x1, z1} from the tiles' pond grids
W.ponds = (() => {
  const box = new Map();
  for (const t of W.tiles.values()) for (let i = 0; i < t.NN; i++) for (let j = 0; j < t.NN; j++) {
    const k = t.pondId[i * t.NN + j]; if (!k || t.pondLevel[k] === undefined) continue;
    const x = t.gx0 + j * WJ.hstep, z = t.gz0 + i * WJ.hstep, b = box.get(k) || { level: t.pondLevel[k], x0: x, x1: x, z0: z, z1: z };
    b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x); b.z0 = Math.min(b.z0, z); b.z1 = Math.max(b.z1, z); box.set(k, b);
  }
  return [...box.values()];
})();
const tuning = { ...TUNING_DEFAULTS, ...(process.env.TUNE ? JSON.parse(process.env.TUNE) : {}) };
const DT = 1 / 120, up = new THREE.Vector3(), fw = new THREE.Vector3();
function run(name, x, z, yaw, secs, ctl, every = 0.5) {
  const car = new Car(W, tuning); car.reset(x, z, yaw);
  const inp = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  const rows = []; let t = 0, flips = 0, wasUp = true, maxAir = 0, t100 = null, bad = false;
  for (let i = 0; i < secs / DT; i++) {
    t = i * DT; ctl(t, inp, car); car.step(DT, inp);
    up.set(0, 1, 0).applyQuaternion(car.quat);
    const kmh = car.vel.length() * 3.6;
    if (t100 === null && kmh >= 100) t100 = t;
    if (wasUp && up.y < 0) flips++; wasUp = up.y > 0;
    maxAir = Math.max(maxAir, car.airTime);
    if (!isFinite(car.pos.x)) { bad = true; break; }
    if (i % Math.round(every / DT) === 0) {
      fw.set(0, 0, 1).applyQuaternion(car.quat);
      const side = car.slipSigned * 57.3;
      rows.push(`${t.toFixed(1).padStart(5)}s ${kmh.toFixed(0).padStart(4)}km/h up${up.y.toFixed(2)} yawRate${car.ang.y.toFixed(2).padStart(6)} slip°${side.toFixed(0).padStart(4)} ${car.drifting ? "DRIFT" : ""} ${car.grounded ? 'G' : 'air'} surf${car.surface}`);
    }
  }
  console.log(`\n== ${name}: 0-100 ${t100 ? t100.toFixed(1) + 's' : '—'}, flips ${flips}, longest air ${maxAir.toFixed(2)}s${bad ? ', NaN!' : ''}`);
  if (process.env.V) console.log(rows.join('\n'));
  return { car, rows };
}
const which = process.argv[2] || 'all';
const FIELD = [828, 480];        // open farm fields east of campus
if (which === 'all' || which === 'accel') run('accel 30s on field', ...FIELD, Math.PI / 2, 30, (t, i) => { i.throttle = 1; }, 2);
if (which === 'all' || which === 'turn') run('full lock at ~110 km/h', ...FIELD, Math.PI / 2, 9, (t, i, c) => {
  i.throttle = c.vel.length() * 3.6 < 110 || t > 5 ? 1 : 0; i.steer = t > 5 ? 1 : 0; }, 0.25);
if (which === 'all' || which === 'slalom') run('slalom 100+ km/h', ...FIELD, Math.PI / 2, 12, (t, i) => { i.throttle = 1; i.steer = t > 3 ? Math.sign(Math.sin(t * 2.5)) : 0; }, 0.25);
if (which === 'all' || which === 'drift2') run('drift: handbrake tap, hold steer, then counter-steer', ...FIELD, Math.PI / 2, 9, (t, i) => {
  i.throttle = 1; i.steer = t < 3 ? 0 : t < 6.5 ? 1 : t < 7.2 ? -0.6 : 0; i.handbrake = t > 3 && t < 3.35; }, 0.25);
if (which === 'all' || which === 'drift') run('handbrake turn at 80', ...FIELD, Math.PI / 2, 7, (t, i, c) => {
  i.throttle = t < 4 ? 1 : 0.3; i.steer = t > 4 ? 1 : 0; i.handbrake = t > 4 && t < 4.6; }, 0.2);
if (which === 'all' || which === 'drop') run('drop 12 m at 120 km/h', ...FIELD, Math.PI / 2, 4, (t, i, c) => {
  if (t === 0) { c.pos.y += 12; c.vel.set(33, 0, 0); } i.throttle = 1; }, 0.2);
if (which === 'all' || which === 'hills') {
  const [sx, sz] = W.spawn;
  run('60 s wander over campus hills', sx, sz + 3, 0, 60, (t, i) => { i.throttle = 1; i.steer = Math.sin(t * 0.7) * 0.6; }, 3);
}
if (which === 'stuck') {
  const [sx, sz] = W.spawn;
  const { car } = run('wander (stuck check)', sx, sz + 3, 0, 33, (t, i) => { i.throttle = 1; i.steer = Math.sin(t * 0.7) * 0.6; }, 3);
  let trees = 0; W.treesNear(car.pos.x, car.pos.z, 3, () => trees++);
  const b = W.buildings.filter(b => b.pts.some(([x, z]) => Math.hypot(x - car.pos.x, z - car.pos.z) < 30)).length;
  console.log('pos', car.pos.x.toFixed(1), car.pos.z.toFixed(1), 'trees within 3 m', trees, 'buildings near', b, 'contacts', car.contacts, 'comps', car.wheels.map(w => w.comp.toFixed(2)).join(' '));
}
if (which === 'all' || which === 'slope') {
  // steepest open spot near campus; park across the slope (facing along the contour) and let go
  let best = null;
  for (let z = 200; z < 700; z += 6) for (let x = -800; x < -300; x += 6) {
    if (W.surfaceAt(x, z) !== 0) continue;
    let near = 0; W.treesNear(x, z, 6, () => near++); if (near) continue;
    const n = W.normalAt(x, z); if (n.y > 0.94 && n.y < 0.97 && (!best || n.y < best[2])) best = [x, z, n.y, n];
  }
  const [x, z, ny, n] = best;
  const yaw = Math.atan2(-n.z, n.x);      // facing along the contour, so the slope falls away to one side
  const { car } = run(`parked across a ${(Math.acos(ny) * 57.3).toFixed(0)}° slope`, x, z, yaw, 5, () => {}, 1);
  console.log('   slid', Math.hypot(car.pos.x - x, car.pos.z - z).toFixed(2), 'm in 5 s');
  const r2 = run('driving across it at 40 km/h', x, z, yaw, 4, (t, i, c) => { i.throttle = c.vel.length() < 11 ? 1 : 0; }, 1);
  console.log('   slip at end', (r2.car.slipSigned * 57.3).toFixed(1), '°');
}

if (which === 'all' || which === 'water') {
  // biggest pond: drive straight across it fast, and slowly
  const p = [...W.ponds].sort((a, b) => (b.x1 - b.x0) * (b.z1 - b.z0) - (a.x1 - a.x0) * (a.z1 - a.z0))[0];
  const pcx = (p.x0 + p.x1) / 2, pcz = (p.z0 + p.z1) / 2;
  // pick the approach direction with no trees or buildings in the way for 80 m
  let bestA = 0, bestClear = -1;
  for (let a = 0; a < Math.PI * 2; a += 0.1) {
    let clear = 0;
    for (let r = 0; r < 110; r += 2) { let hit = 0; W.treesNear(pcx + Math.sin(a) * r, pcz + Math.cos(a) * r, 3, () => hit++); if (hit) break; clear = r; }
    if (clear > bestClear) { bestClear = clear; bestA = a; }
  }
  const startR = Math.min(bestClear, 90);
  const sx0 = pcx + Math.sin(bestA) * startR, sz0 = pcz + Math.cos(bestA) * startR, yaw = bestA + Math.PI;
  console.log('   approach clear for', bestClear, 'm; starting', startR.toFixed(0), 'm from the pond centre');
  for (const [label, kmh] of [['fast (150 km/h)', 150], ['slow (50 km/h)', 50]]) {
    let entered = null, maxDepth = 0;
    const { car, rows } = run('pond ' + label, sx0, sz0, yaw, 8, (t, i, c) => {
      if (t === 0) { c.vel.set(Math.sin(yaw) * kmh / 3.6, 0, Math.cos(yaw) * kmh / 3.6); }
      i.throttle = 0.5;
      if (entered === null && (c.onWater || c.waterDepth > 0)) entered = [t, c.vel.length() * 3.6];
      maxDepth = Math.max(maxDepth, c.waterDepth || 0);
    }, 0.5);
    console.log('   entered water at', entered ? entered[0].toFixed(1) + 's, ' + entered[1].toFixed(0) + ' km/h' : 'never',
      '· max depth', maxDepth.toFixed(2), 'm · end', (car.vel.length() * 3.6).toFixed(0), 'km/h, travelled', Math.hypot(car.pos.x - sx0, car.pos.z - sz0).toFixed(0), 'm');
  }
}

if (which === 'all' || which === 'ramps') {
  // challenge jump ramps: drive along the route (steering to follow it) into a ramp at fixed speeds; judge the
  // jump + 3 s after landing. Also hit one the wrong way at 100 km/h.
  const CH = JSON.parse(fs.readFileSync(A + 'challenges.json'));
  const picks = [['sheridan', 0], ['sheridan', 2], ['willamina', 3], ['long-walk', 0], ['long-walk', 2]];
  for (const [id, k] of picks) {
    const c = CH.find(c => c.id === id), r = c.ramps[k]; if (!r) continue;
    W.setRamps(c.ramps);
    const R = c.route;
    let ri = 0, bd = 1e9; R.forEach(([x, z], i) => { const d = Math.hypot(x - r.x, z - r.z); if (d < bd) { bd = d; ri = i; } });
    const cases = id === 'long-walk' ? [[80, 1], [150, 1], [80, -1]] : [[100, 1], [250, 1], [500, 1], [1000, 1], [100, -1]];
    for (const [kmh, dir] of cases) {
      // start 40 m before the ramp (forwards) or past its back end (wrong way), lined up with it; the placer
      // keeps 30 m before a ramp straight
      const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw), back = dir > 0 ? -40 : 31 + 40;
      const sx = r.x + fx * back, sz = r.z + fz * back, yaw = dir > 0 ? r.yaw : r.yaw + Math.PI;
      const si = ri;
      let top = 0, onRamp = false, passed = false, airStart = null, flown = 0, after = null, fl = 0, wasUp = true;
      let tgt = si, steerOn = false;
      const { car } = run(`ramp ${id}#${k} at ${kmh} km/h${dir < 0 ? ' (wrong way)' : ''}`, sx, sz, yaw, 40 / (kmh / 3.6) + 6, (t, i, c) => {
        if (t === 0) c.vel.set(Math.sin(yaw) * kmh / 3.6, 0, Math.cos(yaw) * kmh / 3.6);
        i.throttle = c.vel.length() * 3.6 < kmh ? 1 : 0;
        if (W.rampAt(c.pos.x, c.pos.z) > 0) onRamp = true; else if (onRamp) passed = true;
        if (onRamp) top = Math.max(top, c.pos.y - W.groundAt(c.pos.x, c.pos.z));
        if (passed && !c.grounded && airStart === null) airStart = [c.pos.x, c.pos.z];
        if (airStart && c.grounded && !flown) flown = Math.hypot(c.pos.x - airStart[0], c.pos.z - airStart[1]);
        if (onRamp) { up.set(0, 1, 0).applyQuaternion(c.quat); if (wasUp && up.y < 0) fl++; wasUp = up.y > 0; }
        // pure pursuit: aim at the route point ~25 m + 0.4 s ahead
        const look = 25 + c.vel.length() * 0.4;
        if (!steerOn) { if (onRamp) steerOn = true; else return; }      // hold straight until on the ramp
        while (R[tgt + dir] && Math.hypot(R[tgt][0] - c.pos.x, R[tgt][1] - c.pos.z) < look) tgt += dir;
        fw.set(0, 0, 1).applyQuaternion(c.quat);
        let d = Math.atan2(R[tgt][0] - c.pos.x, R[tgt][1] - c.pos.z) - Math.atan2(fw.x, fw.z); d = Math.atan2(Math.sin(d), Math.cos(d));
        i.steer = Math.max(-1, Math.min(1, -d * 3));      // +steer = right = smaller yaw
      }, 0.5);
      up.set(0, 1, 0).applyQuaternion(car.quat);
      console.log(`   ${onRamp ? '' : 'MISSED THE RAMP · '}peak ${top.toFixed(1)} m above the road · flew ${flown.toFixed(0)} m · flips from the jump ${fl} · end ${(car.vel.length() * 3.6).toFixed(0)} km/h, upright ${up.y.toFixed(2)}, ${car.grounded ? 'on wheels' : 'in the air'}`);
    }
  }
  W.setRamps([]);
}
