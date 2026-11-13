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
function run(name, x, z, yaw, secs, ctl, every = 0.5, make = () => new Car(W, tuning)) {
  const car = make(); car.reset(x, z, yaw);
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
  const { Bike } = await import('../game/src/bike.js');
  for (const c of CH.filter(c => c.track && (!process.env.ONLY || c.id.includes(process.env.ONLY)))) {           // car + dirt-bike races (jet races have no walls)
    const track = makeTrack(c.track); W.setRamps(c.ramps);
    const isBike = c.vehicle === 'bike', R = c.track, cap = c.id === 'long-walk' ? 110 : isBike ? 90 : 260;
    let tgt = 0, worst = -9, hits = 0, done = false, tEnd = null, slowT = 0, backT = 0, backs = 0;
    const [sx, sz] = R[0], yaw = Math.atan2(R[3][0] - sx, R[3][1] - sz);
    const { car } = run(`walls: bot drives ${c.name}`, sx, sz, yaw, c.length / (cap / 3.6) * 2 + 60, (t, i, k) => {
      if (done) { i.throttle = 0; i.brake = 1; return; }
      const sp = k.vel.length(), look = 10 + sp * 0.5;
      while (R[tgt + 1] && Math.hypot(R[tgt][0] - k.pos.x, R[tgt][1] - k.pos.z) < look) tgt++;
      if (isBike) tgt = Math.min(R.length - 1, track.index + Math.ceil(Math.min(look, 8 + sp * 0.35) / 8));     // bike bot: follow the route itself, don't cut hairpins
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
      if (slowT > 1 && backT <= 0) { backT = 1.5; backs++; if (process.env.WV) console.log('   stuck at', k.pos.x.toFixed(0), k.pos.z.toFixed(0), 'tgt', tgt, 'surf', k.surface, 'contacts', k.contacts, 'pitch', ((k.pitch || 0) * 57.3).toFixed(0), 'gp', ((k.groundPitch || 0) * 57.3).toFixed(0), 'ramp', W.rampAt(k.pos.x, k.pos.z).toFixed(2), 'h', W.heightAt(k.pos.x, k.pos.z).toFixed(1), 'h+3', W.heightAt(k.pos.x + Math.sin(k.heading()) * 3, k.pos.z + Math.cos(k.heading()) * 3).toFixed(1), 'kmh', (k.vel.length() * 3.6).toFixed(0), 'thr', i.throttle, 'steer', i.steer.toFixed(2)); }
      if (backT > 0) { backT -= DT; i.throttle = 0; i.brake = 1; i.steer = -i.steer; }
      const wallHit = track.constrain(k); if (wallHit > 0) hits++;
      if (process.env.TR && Math.hypot(k.pos.x - +process.env.TR.split(',')[0], k.pos.z - +process.env.TR.split(',')[1]) < 15 && (Math.round(t * 120) % 15 === 0 || (t > 180.85 && t < 181.05))) console.log('   tr', 'hit', k.hit.toFixed(1), 'bail', k.msgT > 0 ? k.msg : '', 'water', k.waterDepth.toFixed(2), 'y-h', (k.pos.y - W.heightAt(k.pos.x, k.pos.z)).toFixed(2), 'pitch', (k.pitch*57.3).toFixed(0), 'gp', (k.groundPitch*57.3).toFixed(0), t.toFixed(2), k.pos.x.toFixed(1), k.pos.z.toFixed(1), 'hd', (k.heading() * 57.3).toFixed(0), 'tgtdir', (Math.atan2(R[tgt][0] - k.pos.x, R[tgt][1] - k.pos.z) * 57.3).toFixed(0), 'kmh', (k.vel.length() * 3.6).toFixed(1), 'thr', i.throttle, 'brk', i.brake, 'st', i.steer.toFixed(2), 'wall', wallHit.toFixed(2), 'vf', k.vel.dot(new THREE.Vector3(0,0,1).applyQuaternion(k.quat)).toFixed(2), 'yawRate', (k.yawRate||0).toFixed(2), 'contacts', k.contacts);
      worst = Math.max(worst, outside(k, R));
      if (track.index >= R.length - 3) { done = true; tEnd = t; }
    }, 30, isBike ? () => new Bike(W) : undefined);
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

if (which === 'all' || which === 'bike') {
  // dirt bike (game/src/bike.js): never flips or NaNs; lands jumps; grip per surface; wheelie
  const { Bike, BIKE } = await import('../game/src/bike.js');
  const bt = { ...BIKE, ...(process.env.BTUNE ? JSON.parse(process.env.BTUNE) : {}) };
  const mk = () => new Bike(W, bt);
  const bike = (name, x, z, yaw, secs, ctl, extra = () => {}) => {
    let maxKmh = 0, bails = 0, maxRel = 0, wheelieT = 0, airMax = 0, minUp = 1;
    const { car } = run(name, x, z, yaw, secs, (t, i, c) => {
      i.lean = false; if (!c.grounded && t > 0) { i.throttle = i._t ?? 0; i.brake = i._b ?? 0; } ctl(t, i, c); i._t = i.throttle; i._b = i.brake;
      maxKmh = Math.max(maxKmh, c.vel.length() * 3.6);
      if (c.msgT > 0 && c.msg.startsWith('Bail') && c._lastBail !== c.msgT) { if (!c._bailOn) bails++; c._bailOn = true; } else c._bailOn = false;
      if (c.contacts === 2) maxRel = Math.max(maxRel, Math.abs(c.pitch - c.groundPitch));
      if (c.wheelie) wheelieT += DT;
      airMax = Math.max(airMax, c.airTime);
      minUp = Math.min(minUp, new THREE.Vector3(0, 1, 0).applyQuaternion(c.quat).y);
      extra(t, i, c);
      if (process.env.BV && Math.round(t / DT) % 6 === 0 && (c.airTime > 0 || c.wheels[0].comp > 0.2)) console.log(t.toFixed(2), 'air', c.airTime.toFixed(2), 'pitch', (c.pitch * 57.3).toFixed(0), 'gp', (c.groundPitch * 57.3).toFixed(0), 'rate', c.pitchRate.toFixed(2), 'vy', c.vel.y.toFixed(1), 'thr', i.throttle, 'held', c.heldGas, 'g', c.grounded, 'comp', c.wheels.map(w => w.comp.toFixed(2)).join('/'));
      c.msgT -= DT;
    }, 0.5, mk);
    console.log(`   top ${maxKmh.toFixed(0)} km/h · bails ${bails} · wheelie ${wheelieT.toFixed(1)} s · longest air ${airMax.toFixed(2)} s · lowest up ${minUp.toFixed(2)} · end ${(car.vel.length() * 3.6).toFixed(0)} km/h, pitch ${(car.pitch * 57.3).toFixed(0)}°, ${car.grounded ? 'on the ground' : 'in the air'}${isFinite(car.pos.x) ? '' : ' NaN!'}`);
    return car;
  };
  const [sx, sz] = W.spawn;
  const road = W.placeOn(sx, sz, 3, 80);
  bike('bike: full throttle 20 s on the field', ...FIELD, Math.PI / 2, 20, (t, i) => { i.throttle = 1; });
  const R0 = JSON.parse(fs.readFileSync(A + 'ramps.json'))[0];
  // top speed on Hwy 18 (long straight before the fixed ramp, ramp switched off)
  W.setFixedRamps([]);
  bike('bike: full throttle 25 s on Hwy 18', R0.x - Math.sin(R0.yaw) * 1500, R0.z - Math.cos(R0.yaw) * 1500, R0.yaw, 25, (t, i, c) => {
    i.throttle = 1; const want = R0.yaw; let d = want - c.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); i.steer = Math.max(-1, Math.min(1, -d * 3)); });
  bike('bike: slalom on the field', ...FIELD, Math.PI / 2, 12, (t, i) => { i.throttle = 1; i.steer = t > 3 ? Math.sign(Math.sin(t * 2.5)) : 0; });
  bike('bike: slalom on asphalt (campus road)', ...road, 10, (t, i) => { i.throttle = t < 3 ? 1 : 0.6; i.steer = t > 3 ? Math.sign(Math.sin(t * 3)) : 0; });
  bike('bike: rear-brake slide at 70', ...FIELD, Math.PI / 2, 7, (t, i, c) => { i.throttle = c.vel.length() * 3.6 < 70 || t > 4 ? 1 : 0; i.steer = t > 4 ? 1 : 0; i.handbrake = t > 4 && t < 5; });
  bike('bike: wheelie (Shift + throttle 4 s)', ...FIELD, Math.PI / 2, 8, (t, i) => { i.throttle = 1; i.lean = t > 1.5 && t < 5.5; });
  bike('bike: drop 10 m at 80 km/h, hands off', ...FIELD, Math.PI / 2, 4, (t, i, c) => { if (t === 0) { c.pos.y += 10; c.vel.set(22, 0, 0); } i.throttle = 0; });
  bike('bike: drop 10 m nose-down (holding W)', ...FIELD, Math.PI / 2, 4, (t, i, c) => { if (t === 0) { c.pos.y += 10; c.vel.set(22, 0, 0); } i.throttle = c.grounded ? 0 : 1; });
  W.setFixedRamps([R0]);
  for (const kmh of [80, 140, 200]) {
    const back = 220;
    bike(`bike: Hwy 18 ramp at ${kmh} km/h`, R0.x - Math.sin(R0.yaw) * back, R0.z - Math.cos(R0.yaw) * back, R0.yaw, 12, (t, i, c) => {
      const want = R0.yaw; let d = want - c.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); i.steer = Math.max(-1, Math.min(1, -d * 3));
      const sp = c.vel.length() * 3.6; if (c.grounded) { i.throttle = sp < kmh ? 1 : 0; i.brake = sp > kmh + 15 ? 1 : 0; } });  // in the air: keep holding what you held
  }
  bike('bike: 60 s wander over campus hills', sx, sz + 3, 0, 60, (t, i) => { i.throttle = 1; i.steer = Math.sin(t * 0.7) * 0.6; });
}

if (which === 'all' || which === 'jet') {
  // jet (game/src/jet.js): take-off run, top speed, hard turn, stall + recovery, landing, crashes
  const { Jet, JET } = await import('../game/src/jet.js');
  const jt = { ...JET, ...(process.env.JTUNE ? JSON.parse(process.env.JTUNE) : {}) };
  const R0 = JSON.parse(fs.readFileSync(A + 'ramps.json'))[0];
  W.setFixedRamps([]);
  const flight = (name, x, z, yaw, secs, setup, ctl) => {
    const st = { liftoff: null, maxKmh: 0, maxAlt: -1e9, minAgl: 1e9, stallT: 0, crashes: [], landed: null, inverted: 0, maxG: 0, nan: false, modes: '' };
    let lastMode = null;
    const { car } = run(name, x, z, yaw, secs, (t, i, c) => {
      if (t === 0) { i.jet = { thr: 0, pitch: 0, roll: 0, yaw: 0 }; setup?.(c); }
      i.handbrake = false; ctl(t, i.jet, c, i);
      if (c.mode !== lastMode) { st.modes += (st.modes ? '→' : '') + c.mode + '@' + t.toFixed(1); if (lastMode === 'ground' && c.mode === 'air' && !st.liftoff) st.liftoff = [t, c.vel.length() * 3.6, Math.hypot(c.pos.x - x, c.pos.z - z)]; if (c.mode === 'crashed') st.crashes.push(c.msg + (process.env.JC ? ` @${c.pos.x.toFixed(0)},${c.pos.z.toFixed(0)} t${t.toFixed(1)} prevAgl ${c._lastAgl?.toFixed(0)}` : ''));
      if (c.mode === 'air') c._lastAgl = c.agl; if (lastMode === 'air' && c.mode === 'ground') st.landed = [t, -c._prevVel.y, c.vel.length() * 3.6, c.pos.clone()]; lastMode = c.mode; }
      st.maxKmh = Math.max(st.maxKmh, c.vel.length() * 3.6);
      if (c.mode === 'air') { st.maxAlt = Math.max(st.maxAlt, c.agl); st.minAgl = Math.min(st.minAgl, c.agl); st.maxG = Math.max(st.maxG, c.gLoad); if (c.stall) st.stallT += DT; }
      if (new THREE.Vector3(0, 1, 0).applyQuaternion(c.quat).y < 0) st.inverted += DT;
      if (!isFinite(c.pos.x) || !isFinite(c.vel.x)) st.nan = true;
    }, 0.5, () => new Jet(W, jt));
    console.log(`   ${st.modes} · top ${st.maxKmh.toFixed(0)} km/h · highest ${st.maxAlt.toFixed(0)} m${st.liftoff ? ` · lift-off ${st.liftoff[1].toFixed(0)} km/h after ${st.liftoff[2].toFixed(0)} m` : ''} · max ${st.maxG.toFixed(1)} g · stalled ${st.stallT.toFixed(1)} s · upside down ${st.inverted.toFixed(1)} s${st.landed ? ` · landed sink ${st.landed[1].toFixed(1)} m/s at ${st.landed[2].toFixed(0)} km/h` : ''}${st.crashes.length ? ' · crashes: ' + st.crashes.join(', ') : ''} · end ${car.mode}, ${(car.vel.length() * 3.6).toFixed(0)} km/h${st.nan ? ' NaN!' : ''}`);
    return { car, st };
  };
  const hx = Math.sin(R0.yaw), hz = Math.cos(R0.yaw);
  // climb at up to 20 m/s to a height above the ground, then hold it
  const climb = (c, h) => Math.max(-1, Math.min(1, (Math.max(-15, Math.min(20, (h - c.agl) * 0.15, c.airTime * 6)) - c.vel.y) * 0.05));
  const keep = (c, want, J) => { let d = want - c.heading(); d = Math.atan2(Math.sin(d), Math.cos(d)); return Math.max(-1, Math.min(1, -d * 4)); };
  // 1. take-off along Hwy 18: full throttle, nose up past 240 km/h, climb gently
  flight('jet: take-off run on Hwy 18', R0.x - hx * 1600, R0.z - hz * 1600, R0.yaw, 30, null, (t, J, c) => {
    J.thr = 1; J.yaw = c.mode === 'ground' ? keep(c, R0.yaw) : 0;
    J.pitch = c.mode === 'ground' ? (c.v * 3.6 > 240 ? 1 : 0) : climb(c, 300);
  });
  // 2. a field run-up (grass): longer roll
  flight('jet: take-off from the field', ...FIELD, Math.PI / 2, 25, null, (t, J, c) => { J.thr = 1; J.pitch = c.mode === 'ground' ? (c.v * 3.6 > 240 ? 1 : 0) : climb(c, 200); });
  // 3. flat out at 1000 m, heading east
  flight('jet: flat out at 1000 m for 45 s', -4500, -1000, Math.PI / 2, 45, c => c.placeInAir(-4500, 1200, -1000, Math.PI / 2, 900), (t, J, c) => {
    J.thr = 1; J.pitch = Math.max(-1, Math.min(1, (1000 + c.world.heightAt(c.pos.x, c.pos.z) - c.pos.y) * 0.004 - c.vel.y * 0.02)); });
  // 4. hands off for 30 s at 600 km/h: should stay upright, roughly level
  flight('jet: hands off 30 s', -2000, 0, Math.PI / 2, 30, c => c.placeInAir(-2000, 600, 0, Math.PI / 2, 600), (t, J) => { J.thr = 0.5; });
  // 5. hard turn: bank to ~75° and pull for 12 s at 700 km/h
  flight('jet: bank + full pull 12 s', 0, 0, 0, 14, c => c.placeInAir(0, 900, 0, 0, 700), (t, J, c) => {
    J.thr = 1; J.roll = t < 0.6 ? 1 : 0; J.pitch = t > 0.6 && t < 12.6 ? 1 : 0; });
  // 6. full roll (aileron roll) for 3 s and let go
  flight('jet: aileron rolls for 3 s, then let go', 0, 0, 0, 10, c => c.placeInAir(0, 900, 0, 0, 600), (t, J) => { J.thr = 0.6; J.roll = t < 3 ? 1 : 0; });
  // 7. stall: throttle off, hold the stick back; then let go + full throttle
  flight('jet: stall and recover', 0, 0, 0, 30, c => c.placeInAir(0, 1500, 0, 0, 400), (t, J) => { J.thr = t < 14 ? -1 : 1; J.pitch = t < 14 ? 1 : 0; });
  // 8. landing on Hwy 18: from 80 m up, 3 km out, 330 km/h; hold a ~3 m/s descent, flare, brake
  {
    const lx = R0.x - hx * 3400, lz = R0.z - hz * 3400;
    flight('jet: approach + landing on Hwy 18', lx, lz, R0.yaw, 70, c => c.placeInAir(lx, c.world.heightAt(lx, lz) + 1.6 + 80, lz, R0.yaw, 330), (t, J, c, i) => {
      J.yaw = 0; J.roll = 0;
      if (c.mode === 'air') {
        // steer onto the road line (roll toward it), hold the glide slope, keep ~300 km/h
        const along = (c.pos.x - lx) * hx + (c.pos.z - lz) * hz, off = (c.pos.x - lx) * hz - (c.pos.z - lz) * hx;
        const head = Math.atan2(c.vel.x, c.vel.z); let d = R0.yaw - head; d = Math.atan2(Math.sin(d), Math.cos(d));
        const wantBank = Math.max(-0.4, Math.min(0.4, -d * 3 + off * 0.004));
        J.roll = Math.max(-1, Math.min(1, (wantBank - c.bank) * 3));
        const wantVy = c.agl > 6 ? -Math.min(4, Math.max(1.5, c.agl / 15)) : -1.2;
        J.pitch = Math.max(-1, Math.min(1, (wantVy - c.vel.y) * 0.25));
        J.thr = c.vel.length() * 3.6 > 300 ? -1 : 1;
      } else { J.thr = -1; J.pitch = 0; i.handbrake = c.mode === 'ground'; J.yaw = keep(c, R0.yaw); }
    });
  }
  // 9. dive into a field = crash, back on the ground (last safe spot / spawn) after 3 s
  flight('jet: dive into the ground', ...FIELD, 0, 8, c => { c.reset(...FIELD, 0); c.safe = [[...FIELD, 0]]; c.placeInAir(FIELD[0], c.world.heightAt(...FIELD) + 150, FIELD[1], Math.PI / 2, 500); c.safe = [[...FIELD, Math.PI / 2]]; }, (t, J) => { J.thr = 1; J.pitch = -1; });
  // 10. low over the campus forest at 15 m = into the trees
  {
    const [sx, sz] = W.spawn;
    flight('jet: 15 m over the campus woods', sx, sz, 0, 20, c => c.placeInAir(sx, W.heightAt(sx, sz) + 18, sz, 0, 400), (t, J, c) => {
      J.thr = 0.6; J.pitch = Math.max(-1, Math.min(1, (15 - c.agl) * 0.05 - c.vel.y * 0.05)); });
  }
  // 11. taxi on the field: slow, full rudder circle
  flight('jet: taxi circle at ~40 km/h', ...FIELD, 0, 20, null, (t, J, c) => { J.thr = c.v * 3.6 < 40 ? 0.3 : -1; J.yaw = 1; });
  // 12. each jet race: a bot takes off and flies through every ring in order (crossing = through the hole)
  const CHJ = JSON.parse(fs.readFileSync(A + 'challenges.json')).filter(c => c.vehicle === 'jet');
  for (const c of CHJ) {
    let next = 1, done = null, prev = null, rings = 0;
    const G = c.gates;
    const { st } = flight(`jet race: bot flies ${c.name}`, c.start.x, c.start.z, c.start.yaw, 240,
      k => { k.respawn = () => next >= 2 ? [G[next - 1].x, G[next - 1].y, G[next - 1].z, G[next - 1].yaw, 450] : null; }, (t, J, k) => {
      if (done) { J.thr = -1; return; }
      const g = G[next], kmh = k.vel.length() * 3.6;
      if (k.mode === 'ground') { J.thr = 1; J.yaw = keep(k, c.start.yaw); J.pitch = kmh > 240 ? 1 : 0; }
      else if (k.mode === 'air') {
        // proportional navigation toward a point on the ring's axis (250 m before it until close)
        const dist0 = Math.hypot(g.x - k.pos.x, g.z - k.pos.z), lead = Math.min(250, dist0 * 0.5);
        const ax = g.x - Math.sin(g.yaw) * lead, az = g.z - Math.cos(g.yaw) * lead;
        const head = Math.atan2(k.vel.x, k.vel.z), brg = Math.atan2(ax - k.pos.x, az - k.pos.z);
        let d = brg - head; d = Math.atan2(Math.sin(d), Math.cos(d));
        const hd = Math.hypot(ax - k.pos.x, az - k.pos.z), elev = Math.atan2(g.y - k.pos.y, hd);
        const v = k.vel.length(), gr = k.t.gravity;
        let dB = k._brg === undefined ? 0 : brg - k._brg; dB = Math.atan2(Math.sin(dB), Math.cos(dB)); k._brg = brg;
        k._dB = (k._dB ?? 0) * 0.9 + 0.1 * dB / DT;                       // line-of-sight turn rate, smoothed
        const aLat = 3 * v * k._dB + 1.2 * v * d * 0.5;                    // + = needs to turn left
        const R = v * v / (gr * Math.tan(1.3));
        if (dist0 < 2.2 * R && Math.abs(d) > 1.2) k._extend = true;
        if (k._extend && (dist0 > 3 * R || Math.abs(d) < 0.25)) k._extend = false;
        let wantBank = k._extend ? 0 : Math.max(-1.3, Math.min(1.3, -Math.atan2(aLat, gr)));
        if (dist0 < 600 && !k._extend) { let dc = Math.atan2(g.x - k.pos.x, g.z - k.pos.z) - head; dc = Math.atan2(Math.sin(dc), Math.cos(dc)); wantBank = Math.max(-0.6, Math.min(0.6, -dc * 2.5)); }   // final approach: straight at the hole
        J.roll = Math.max(-1, Math.min(1, (wantBank - k.bank) * 3)); J.yaw = 0;
        // height: climb / sink rate toward the ring's height (the jet itself holds height in a bank)
        let wantVy = Math.max(-35, Math.min(35, (g.y - k.pos.y) * Math.max(0.12, Math.min(0.6, 120 / Math.max(hd, 1)))));
        const floor = Math.max(k.world.heightAt(k.pos.x + k.vel.x * 2, k.pos.z + k.vel.z * 2), k.world.heightAt(k.pos.x, k.pos.z)) + 70;
        if (k.pos.y < floor && dist0 > 300) wantVy = Math.max(wantVy, (floor - k.pos.y) * 0.5);
        J.pitch = Math.max(-1, Math.min(1, (wantVy - k.vel.y) * 0.03 + (k._extend ? 0 : Math.min(0.6, Math.abs(d) * 1.5) * Math.abs(Math.sin(k.bank)))));   // pull in the turn
        const path = 0, upA = 0, nWant = 0, base = 0, aUp = 0;
        if (process.env.JB && Math.round(t * 120) % 60 === 0) console.log('   bot', t.toFixed(1), 'ring', next, 'dist', dist0.toFixed(0), 'd°', (d * 57.3).toFixed(0), 'wantBank', (wantBank * 57.3).toFixed(0), 'ext', !!k._extend, 'dy', (k.pos.y - g.y).toFixed(0), 'pitch', J.pitch.toFixed(2), 'bank', (k.bank * 57.3).toFixed(0), 'g', k.gLoad.toFixed(2), 'kmh', (v * 3.6).toFixed(0));
        J.thr = kmh < (Math.abs(d) > 0.3 ? 450 : 600) ? 1 : -1;
      }
      // crossing the ring's plane inside the hole
      const p = [k.pos.x, k.pos.y, k.pos.z];
      if (prev && k.mode !== 'crashed') {
        const fx = Math.sin(g.yaw), fz = Math.cos(g.yaw);
        const d0 = (prev[0] - g.x) * fx + (prev[2] - g.z) * fz, d1 = (p[0] - g.x) * fx + (p[2] - g.z) * fz;
        if (d0 <= 0 && d1 > 0) {
          const u = -d0 / (d1 - d0), ix = prev[0] + (p[0] - prev[0]) * u, iy = prev[1] + (p[1] - prev[1]) * u, iz = prev[2] + (p[2] - prev[2]) * u;
          const lat = (ix - g.x) * Math.cos(g.yaw) - (iz - g.z) * Math.sin(g.yaw);
          const ok = g.y === undefined ? Math.abs(lat) < g.w / 2 + 1.5 : Math.hypot(lat, iy - g.y) <= g.r + 1;
          if (process.env.JV) console.log('   cross ring', next, 'lat', lat.toFixed(1), 'dy', g.y === undefined ? '-' : (iy - g.y).toFixed(1), ok ? 'OK' : 'MISS', 't', t.toFixed(1));
          if (ok) { rings++; next++; k._extend = false; k._dB = 0; k._brg = undefined; if (next >= G.length) done = t; }
        }
      }
      prev = p;
    });
    console.log(`   ${done ? `finished in ${done.toFixed(1)} s` : `DID NOT FINISH (${rings}/${G.length - 1} rings)`}`);
  }
  W.setFixedRamps([R0]);
}
