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

if (which === 'all' || which === 'walls') {
  // challenge walls (game/src/track.js): steer hard into the edge, then a bot drives whole routes; the car's centre
  // must never get further out than the road edge
  const { makeTrack } = await import('../game/src/track.js');
  const CH = JSON.parse(fs.readFileSync(A + 'challenges.json'));
  const outside = (c, T) => {           // how far the car centre is past the road edge (m), ≤ 0 inside
    let best = Infinity;
    for (let i = 0; i < T.length - 1; i++) {
      const [ax, az, ah] = T[i], [bx, bz, bh] = T[i + 1], ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
      let t = ((c.pos.x - ax) * ex + (c.pos.z - az) * ez) / L2; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(c.pos.x - ax - ex * t, c.pos.z - az - ez * t) - (ah + (bh - ah) * t);
      if (d < best) best = d;
    }
    return best;
  };
  const sher = CH.find(c => c.id === 'sheridan'), T = sher.track;
  // a straight bit: the first ramp's run-out
  const r0 = sher.ramps[0], fx = Math.sin(r0.yaw), fz = Math.cos(r0.yaw);
  for (const [kmh, ang] of [[100, 0.6], [300, 0.35], [600, 0.2]]) {
    const track = makeTrack(T); let worst = -9, hits = 0, maxHit = 0;
    const sx = r0.x + fx * 60, sz = r0.z + fz * 60, yaw = r0.yaw + ang;     // pointed at the left edge
    const { car } = run(`wall: into the edge at ${kmh} km/h, ${Math.round(ang * 57.3)}°`, sx, sz, yaw, 4, (t, i, c) => {
      if (t === 0) c.vel.set(Math.sin(yaw) * kmh / 3.6, 0, Math.cos(yaw) * kmh / 3.6);
      i.throttle = 1; i.steer = 0;
      const h = track.constrain(c); if (h > 0) { hits++; maxHit = Math.max(maxHit, h); }
      worst = Math.max(worst, outside(c, T));
    }, 0.5);
    console.log(`   furthest past the edge ${worst.toFixed(2)} m · wall contacts ${hits} steps, hardest ${(maxHit * 3.6).toFixed(0)} km/h · end ${(car.vel.length() * 3.6).toFixed(0)} km/h`);
  }
  // bot drives each whole route with walls + ramps on: pure pursuit, speed capped on bends
  for (const c of CH) {
    const track = makeTrack(c.track); W.setRamps(c.ramps);
    const R = c.track, cap = c.id === 'long-walk' ? 110 : 260;
    let tgt = 0, worst = -9, hits = 0, done = false, tEnd = null, slowT = 0, backT = 0, backs = 0;
    const [sx, sz] = R[0], yaw = Math.atan2(R[3][0] - sx, R[3][1] - sz);
    const { car } = run(`walls: bot drives ${c.name}`, sx, sz, yaw, c.length / (cap / 3.6) * 2 + 60, (t, i, k) => {
      if (done) { i.throttle = 0; i.brake = 1; return; }
      const sp = k.vel.length(), look = 10 + sp * 0.5;
      while (R[tgt + 1] && Math.hypot(R[tgt][0] - k.pos.x, R[tgt][1] - k.pos.z) < look) tgt++;
      fw.set(0, 0, 1).applyQuaternion(k.quat);
      let d = Math.atan2(R[tgt][0] - k.pos.x, R[tgt][1] - k.pos.z) - Math.atan2(fw.x, fw.z); d = Math.atan2(Math.sin(d), Math.cos(d));
      i.steer = Math.max(-1, Math.min(1, -d * 2.5));
      // slow for what's coming: heading change over the next ~60 m
      const a = R[Math.min(R.length - 1, tgt + 3)], b = R[Math.min(R.length - 1, tgt + 15)], a0 = R[tgt];
      let turn = Math.atan2(b[0] - a[0], b[1] - a[1]) - Math.atan2(a[0] - a0[0], a[1] - a0[1]); turn = Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)));
      const want = Math.max(50, cap * (1 - turn * 1.2));
      i.throttle = sp * 3.6 < want ? 1 : 0; i.brake = sp * 3.6 > want + 25 ? 1 : 0;
      // stuck (wedged on a tight bend): back up for 1.5 s with the wheel the other way, like a person would
      slowT = sp < 1 ? slowT + DT : 0;
      if (slowT > 1 && backT <= 0) { backT = 1.5; backs++; }
      if (backT > 0) { backT -= DT; i.throttle = 0; i.brake = 1; i.steer = -i.steer; }
      if (track.constrain(k) > 0) hits++;
      worst = Math.max(worst, outside(k, R));
      if (track.index >= R.length - 3) { done = true; tEnd = t; }
    }, 30);
    console.log(`   ${done ? `reached the finish in ${tEnd.toFixed(0)} s` : `DID NOT FINISH (got to ${(track.index / (R.length - 1) * 100).toFixed(0)}%)`} · furthest past the edge ${worst.toFixed(2)} m · wall contact ${hits} steps · backed up ${backs}×`);
  }
  W.setRamps([]);
}

if (which === 'all' || which === 'glider') {
  // G glider (game/src/glider.js): off the Hwy 18 ramp with and without it, a gentle glide from a height over the
  // fields, a held pull-up (stall), a banked turn, a dive into the ground, G on the ground, a tree, a pond
  const { Glider } = await import('../game/src/glider.js');
  const R0 = JSON.parse(fs.readFileSync(A + 'ramps.json'))[0];
  W.setFixedRamps([R0]);
  const fx = Math.sin(R0.yaw), fz = Math.cos(R0.yaw);
  const res = {};
  const glide = (name, x, z, yaw, secs, setup, ctl = () => {}) => {
    let G, st = { stallT: 0, maxSink: 0, deployed: null, closed: null, peak: -1e9, minUp: 1, nan: false, start: null };
    const { car } = run(name, x, z, yaw, secs, (t, i, c) => {
      if (t === 0) { G = new Glider(c); setup(c, G); }
      i.throttle = 0; i.brake = 0; i.steer = 0;
      ctl(t, i, c, G);
      if (G.active) {
        if (!st.deployed) st.deployed = [c.pos.x, c.pos.z, c.pos.y, t];
        if (G.stall) st.stallT += DT;
        st.maxSink = Math.max(st.maxSink, -c.vel.y); st.peak = Math.max(st.peak, c.pos.y);
      } else if (st.deployed && !st.closed) st.closed = [c.pos.x, c.pos.z, c.pos.y, t, G.result, -c._prevVel.y, c.vel.length() * 3.6];
      if (![c.pos.x, c.pos.y, c.vel.x, c.quat.w].every(isFinite)) st.nan = true;
    }, 0.5);
    up.set(0, 1, 0).applyQuaternion(car.quat);
    const d = st.deployed, e = st.closed;
    const flown = d && e ? Math.hypot(e[0] - d[0], e[1] - d[1]) : 0;
    console.log(`   ${d ? `opened at ${d[3].toFixed(1)} s` : 'glider not opened'} · ${e ? `closed at ${e[3].toFixed(1)} s: ${e[4]}, ${flown.toFixed(0)} m flown, ` +
      `dropped ${(d[2] - e[2]).toFixed(0)} m (peak +${(st.peak - d[2]).toFixed(0)} m), touchdown sink ${e[5].toFixed(1)} m/s at ${e[6].toFixed(0)} km/h` : 'still flying'}` +
      ` · stalled ${st.stallT.toFixed(1)} s · end ${car.grounded ? 'on wheels' : 'in the air'}, upright ${up.y.toFixed(2)}${st.nan ? ' · NaN!' : ''}`);
    return { car, G, st, flown };
  };
  // off the ramp at 250 km/h: plain jump vs glider opened 0.3 s after take-off
  const sx = R0.x - fx * 60, sz = R0.z - fz * 60;
  for (const withG of [false, true]) {
    let off = null, land = null, onRamp = false;
    const { car } = glide(`Hwy 18 ramp at 250 km/h${withG ? ', glider opened in the air' : ', plain jump'}`, sx, sz, R0.yaw, 30,
      c => c.vel.set(fx * 250 / 3.6, 0, fz * 250 / 3.6),
      (t, i, c, G) => {
        i.throttle = !off && c.vel.length() * 3.6 < 250 ? 1 : 0;
        if (W.rampAt(c.pos.x, c.pos.z) > 0) onRamp = true;
        if (onRamp && !off && !c.grounded && W.rampAt(c.pos.x, c.pos.z) === 0) off = [c.pos.x, c.pos.z, t];
        if (withG && off && !G.active && !G.result && t > off[2] + 0.3) G.toggle();
        if (off && !land && (c.grounded || (G.result && G.result !== 'folded'))) land = [c.pos.x, c.pos.z];
      });
    res[withG ? 'gl' : 'plain'] = off && land ? Math.hypot(land[0] - off[0], land[1] - off[1]) : 0;
    console.log(`   take-off → first touchdown ${res[withG ? 'gl' : 'plain'].toFixed(0)} m`);
  }
  console.log(`   glider carried you ${(res.gl / Math.max(1, res.plain)).toFixed(1)}× as far as the plain jump`);
  // opened at top speed: should bleed speed gently (drag ≤ 1 g), not stop dead
  for (const kmh of [600, 1200]) {
    const marks = [];
    glide(`glider opened at ${kmh} km/h, 60 m up, hands off`, ...FIELD, Math.PI / 2, 12,
      (c, G) => { c.pos.y += 60; c.vel.set(kmh / 3.6, 0, 0); c.airTime = 1; G.toggle(); },
      (t, i, c) => { if (t === 0) marks.y0 = c.pos.y;
        for (const m of [0.5, 2, 5]) if (marks.length < 3 && t >= m && marks.length === [0.5, 2, 5].indexOf(m)) marks.push([c.vel.length() * 3.6, c.pos.y - marks.y0]); });
    console.log(`   after 0.5 s / 2 s / 5 s: ${marks.map(([v, h]) => `${v.toFixed(0)} km/h ${h >= 0 ? '+' : ''}${h.toFixed(0)} m`).join(' / ')}`);
  }
  // gentle glide from 60 m over the open fields, no input → should land upright
  const g1 = glide('glide from 60 m at 110 km/h, hands off', ...FIELD, Math.PI / 2, 40,
    (c, G) => { c.pos.y += 60; c.vel.set(110 / 3.6, 0, 0); c.airTime = 1; G.toggle(); });
  if (g1.st.closed) console.log(`   glide ratio ${(g1.flown / (g1.st.deployed[2] - g1.st.closed[2])).toFixed(1)} : 1`);
  // hold S (nose up) the whole way: should climb, stall, drop the nose, recover, never NaN
  glide('glide from 60 m, holding S (pull up) all the way', ...FIELD, Math.PI / 2, 40,
    (c, G) => { c.pos.y += 60; c.vel.set(110 / 3.6, 0, 0); c.airTime = 1; G.toggle(); }, (t, i) => { i.brake = 1; });
  // bank right for 5 s, then let go
  {
    let h0 = null, h1 = null;
    glide('glide from 80 m, bank right (D) 5 s then let go', ...FIELD, Math.PI / 2, 40,
      (c, G) => { c.pos.y += 80; c.vel.set(110 / 3.6, 0, 0); c.airTime = 1; G.toggle(); },
      (t, i, c) => { i.steer = t > 1 && t < 6 ? 1 : 0; if (t > 0.9 && h0 === null) h0 = Math.atan2(c.vel.x, c.vel.z); if (t > 7 && h1 === null) h1 = Math.atan2(c.vel.x, c.vel.z); });
    let dh = (h1 - h0) * 57.3; dh = ((dh + 540) % 360) - 180;
    console.log(`   heading changed ${dh.toFixed(0)}° (negative = turned right; wraps past ±180°)`);
  }
  // hold W (dive) from 40 m: nose-first into the ground = crash
  glide('dive (holding W) from 40 m', ...FIELD, Math.PI / 2, 12,
    (c, G) => { c.pos.y += 40; c.vel.set(110 / 3.6, 0, 0); c.airTime = 1; G.toggle(); }, (t, i) => { i.throttle = 1; });
  // G on the ground: too slow (refused), fast enough (hops up and flies)
  for (const kmh of [50, 150]) glide(`G on the ground at ${kmh} km/h`, ...FIELD, Math.PI / 2, 12,
    c => c.vel.set(kmh / 3.6, 0, 0), (t, i, c, G) => { if (Math.abs(t - 0.5) < DT / 2) G.toggle(); i.throttle = t < 0.5 ? 1 : 0; });
  // a tall tree straight ahead at crown height
  {
    let tree = null;
    for (let z = -400; z < 900 && !tree; z += 37) for (let x = -900; x < 900 && !tree; x += 37)
      W.treesNear(x, z, 20, (tx, tz, tr, h) => { if (!tree && h > 25) tree = [tx, tz, h]; });
    const [tx, tz, th] = tree, ty = W.terrainAt(tx, tz) + th * 0.6;
    const { G } = glide(`fly at a ${th.toFixed(0)} m tree at 60% of its height`, tx - 150, tz, Math.PI / 2, 15,
      (c, G) => { c.reset(tx - 150, tz, Math.PI / 2); c.pos.y = ty; c.vel.set(100 / 3.6, 0, 0); c.airTime = 1; G.toggle(); });
    console.log(`   ${G.result === 'tree' ? 'hit the tree' : 'DID NOT HIT THE TREE (' + G.result + ')'}`);
  }
  // a pond: glide down onto it slowly → lands in the water and the car's water physics take over
  {
    const p = [...W.ponds].sort((a, b) => (b.x1 - b.x0) * (b.z1 - b.z0) - (a.x1 - a.x0) * (a.z1 - a.z0))[0];
    const cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2;
    let maxDepth = 0;
    const { G } = glide('glide down onto the biggest pond', cx, cz, 0, 8,
      (c, G) => { c.pos.y = p.level + 6; c.vel.set(0, -1, 70 / 3.6); c.airTime = 1; G.toggle(); },
      (t, i, c) => { maxDepth = Math.max(maxDepth, c.waterDepth || 0); });
    console.log(`   closed as '${G.result}', then max water depth ${maxDepth.toFixed(2)} m`);
  }
  W.setFixedRamps([]);
}
