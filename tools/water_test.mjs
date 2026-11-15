// Water physics test (game/src/water.js, car.js, bike.js) on the committed tiles, headless, no server.
// Car and dirt bike drive into a campus pond and the South Yamhill river at 30 / 80 / 150 km/h; sit still in
// shallow water; drive out of it; drop into deep water at rest; glide down onto the water. Checks: no NaN, height
// oscillation < 0.1 m once settled, deep water → back on a dry bank. Exit code 1 on any failure.
//   node tools/water_test.mjs            (all)        V=1 prints a timeline per run
//   node tools/water_test.mjs river car  (filter by words in the run name)
import fs from 'fs';
import * as THREE from 'three';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { Bike, BIKE } from '../game/src/bike.js';
import { Glider, BIKE_GLIDER } from '../game/src/glider.js';
import { RIVER, deepestPond, approach as findApproach } from './lib/water.mjs';

const A = (process.env.YR_ASSETS || 'game/assets').replace(/\/?$/, '/');
const WJ = JSON.parse(fs.readFileSync(A + 'world.json'));
const W = makeWorld(WJ);
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const have = new Set(WJ.tiles.map(([a, b]) => a + ',' + b));
async function load(x, z) {                      // the tile under (x, z) and its 8 neighbours
  const cx = Math.floor((x + 1000) / 2000), cz = Math.floor((z + 1000) / 2000);
  for (let tz = cz - 1; tz <= cz + 1; tz++) for (let tx = cx - 1; tx <= cx + 1; tx++) {
    if (!have.has(tx + ',' + tz) || W.has(tx, tz)) continue;
    const d = `${A}tiles/${tx}_${tz}/`;
    W.add(makeTileData(WJ, tx, tz, await readTileData(async f => ab(d + f), WJ.packed)));
  }
}
const DT = 1 / 120, filter = process.argv.slice(2);
const wl = (x, z) => W.waterLevelAt(x, z), wet = (x, z) => wl(x, z) > -Infinity;
const depth = (x, z) => wl(x, z) - W.heightAt(x, z);

// ---------------------------------------------------------------- sites
await load(...RIVER);
await load(0, 0);
const pond = deepestPond(W, 0, 0);                // a campus-area pond (real ponds only, not river pools)
const approach = c => findApproach(W, c);

// a shallow spot: wheels in, body at most just touching (water 0.1–0.55 m deep under the middle and 2 m around it),
// nearest to `c`. (The committed river banks are near-vertical: the nearest such water is usually a pond's edge.)
function shallow([cx, cz]) {
  let best = null;
  for (let dz = -80; dz <= 80; dz += 1) for (let dx = -80; dx <= 80; dx += 1) {
    const x = cx + dx, z = cz + dz;
    const ok = [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]].every(([a, b]) => { const d = depth(x + a, z + b); return d > 0.1 && d < 0.55; });
    if (ok && (!best || dx * dx + dz * dz < best.d2)) best = { x, z, d2: dx * dx + dz * dz };
  }
  return best;
}

// heights one per physics step. Turning points (ignoring wiggles under 5 mm); an oscillation is a there-and-back
// within 3 s (bobbing, bouncing, jitter): the smaller of the two swings. Slowly following a sloping bed isn't one.
function oscillation(ys) {
  const ext = [];                                   // [y, step]
  ys.forEach((y, i) => {
    if (!ext.length) { ext.push([y, i]); return; }
    const last = ext[ext.length - 1][0], dir = ext.length > 1 ? Math.sign(last - ext[ext.length - 2][0]) : 0;
    if (!dir) { if (Math.abs(y - last) > 0.005) ext.push([y, i]); }
    else if (Math.sign(y - last) === dir) ext[ext.length - 1] = [y, i];   // still going the same way
    else if (Math.abs(y - last) > 0.005) ext.push([y, i]);               // turned round
  });
  let osc = 0;
  for (let i = 2; i < ext.length; i++) {
    if ((ext[i][1] - ext[i - 2][1]) * DT > 3) continue;
    osc = Math.max(osc, Math.min(Math.abs(ext[i][0] - ext[i - 1][0]), Math.abs(ext[i - 1][0] - ext[i - 2][0])));
  }
  return osc;
}

// ---------------------------------------------------------------- one run
const results = [];
function run(name, vehicle, x, z, yaw, secs, { kmh = 0, ctl = () => {}, setup = () => {}, expect = 'any' } = {}) {
  if (filter.length && !filter.every(f => name.includes(f))) return;
  const v = vehicle === 'bike' ? new Bike(W, { ...BIKE }) : new Car(W, { ...TUNING_DEFAULTS });
  v.reset(x, z, yaw);
  if (kmh) v.vel.set(Math.sin(yaw) * kmh / 3.6, 0, Math.cos(yaw) * kmh / 3.6);
  setup(v);
  const inp = { throttle: 0, brake: 0, steer: 0, handbrake: false, lean: false };
  const ys = [], lines = [];
  let enterT = null, enterKmh = 0, rebounds = 0, rising = false, stayed = null, respawn = null, nan = false, maxUnder = 0, leftWater = null, inWaterT = 0;
  for (let i = 0; i < secs / DT; i++) {
    const t = i * DT;
    if (respawn === null && enterT === null && kmh) {      // hold the entry speed (brake down a steep bank)
      const s = v.vel.length() * 3.6; inp.throttle = s < kmh ? 1 : 0; inp.brake = s > kmh + 2 ? 1 : 0;
    }
    if (respawn) { inp.throttle = inp.brake = inp.steer = 0; } else ctl(t, inp, v);   // on the bank: hands off
    const px = v.pos.x, pz = v.pos.z;
    v.step(DT, inp);
    v.msgT = (v.msgT || 0) - DT;
    if (![v.pos.x, v.pos.y, v.pos.z, v.vel.x, v.vel.y, v.quat.w].every(Number.isFinite)) { nan = true; break; }
    const jumped = Math.hypot(v.pos.x - px, v.pos.z - pz) > 6;
    const inW = v.waterDepth > 0 || v.onWater || v.wheels.some(w => w.surf === 5 && w.contact) || (v.waterSub || 0) > 0;
    if (jumped && respawn === null) respawn = { t, x: v.pos.x, z: v.pos.z, from: [px, pz], dist: Math.hypot(v.pos.x - px, v.pos.z - pz) };
    // on the bank: 0.5–3 s after the respawn it stays put and dry (doesn't roll back in)
    if (respawn && t - respawn.t > 0.5 && t - respawn.t < 3) {
      if (!stayed) stayed = { x: v.pos.x, z: v.pos.z, ok: true };
      if (Math.hypot(v.pos.x - stayed.x, v.pos.z - stayed.z) > 1.5 || wet(v.pos.x, v.pos.z)) stayed.ok = false;
    }
    if (inW && enterT === null && respawn === null) { enterT = t; enterKmh = v.vel.length() * 3.6; }
    if (inW && respawn === null) inWaterT += DT;
    if (enterT !== null && respawn === null && !inW && leftWater === null && t - enterT > 0.5) leftWater = t;
    maxUnder = Math.max(maxUnder, v.underT || 0);          // the vehicle's own "fully under" timer
    if (!respawn) ys.push([t, v.pos.y, inW]);
    // rebounds: the body moving up out of the water faster than 0.5 m/s after it was going down (not skimming)
    if (inW && !respawn && !v.onWater) { if (v.vel.y > 0.5 && !rising) { rising = true; if (t - enterT > 0.05) rebounds++; } else if (v.vel.y < 0) rising = false; }
    if (process.env.V && i % 12 === 0) lines.push(`  ${t.toFixed(1).padStart(5)}s y${v.pos.y.toFixed(2).padStart(7)} vy${v.vel.y.toFixed(2).padStart(6)} ${(v.vel.length() * 3.6).toFixed(0).padStart(4)}km/h` +
      ` wl-y ${(wl(v.pos.x, v.pos.z) - v.pos.y).toFixed(2).padStart(6)} sub ${(v.waterSub || 0).toFixed(2)} flood ${(v.flood || 0).toFixed(2)} contacts ${v.contacts}` +
      ` up ${new THREE.Vector3(0, 1, 0).applyQuaternion(v.quat).y.toFixed(2)} pitch° ${(Math.asin(new THREE.Vector3(0, 0, 1).applyQuaternion(v.quat).y) * 57.3).toFixed(0)}` +
      ` ${inW ? 'WET' : ''} ${v.msgT > 0 ? v.msg : ''}${v.hudInfo ? v.hudInfo() : ''}`);
  }
  // oscillation once settled: in the water from 1.5 s after entering (the whole sit-still run after 1.5 s). The
  // height's turning points (ignoring wiggles under 5 mm); an oscillation is a there-and-back: the smaller of two
  // swings in a row. A smooth float → sink → rest on the bed has no there-and-back, a bob or a bounce does.
  const t0 = (enterT ?? 0) + 1.5;
  const seg = [];                                       // the first stretch in the water (not a later dip back in)
  for (const p of ys) { if (p[0] < t0) continue; if (!p[2] && expect !== 'sit') break; seg.push(p); }
  const osc = oscillation(seg.map(p => p[1]));
  // after a respawn: dry spot, sits still
  let bankOk = null;
  if (respawn) {
    bankOk = !wet(respawn.x, respawn.z) && [0, 1, 2, 3, 4, 5, 6, 7].every(a => !wet(respawn.x + Math.sin(a * 0.785) * 3, respawn.z + Math.cos(a * 0.785) * 3));
    respawn.edge = 0; for (let r = 0; r < 40; r += 0.5) { let w2 = false; for (let a = 0; a < 16; a++) if (wet(respawn.x + Math.sin(a * 0.39) * r, respawn.z + Math.cos(a * 0.39) * r)) w2 = true; if (w2) { respawn.edge = r; break; } }
  }
  const endWet = wet(v.pos.x, v.pos.z) && depth(v.pos.x, v.pos.z) > 0.3;
  const fails = [];
  if (nan) fails.push('NaN');
  if (osc >= 0.1) fails.push(`oscillation ${osc.toFixed(3)} m`);
  if (expect === 'respawn' && !respawn) fails.push('never went back to the bank');
  if (respawn && !bankOk) fails.push('respawned in the water');
  if (respawn && stayed && !stayed.ok) fails.push('did not stay put on the bank');
  if (rebounds > 1) fails.push(`${rebounds} rebounds`);
  if (expect === 'sit' && respawn) fails.push('respawned while sitting in shallow water');
  if (expect === 'out' && (endWet || respawn || wet(v.pos.x, v.pos.z))) fails.push('did not drive out');
  if (expect !== 'sit' && endWet && !respawn) fails.push(`still in deep water at the end (${depth(v.pos.x, v.pos.z).toFixed(1)} m)`);
  const outcome = respawn ? `back on the bank at ${respawn.t.toFixed(1)} s (${respawn.dist.toFixed(0)} m away, ${respawn.edge.toFixed(1)} m from the water)`
    : leftWater !== null ? `out of the water at ${leftWater.toFixed(1)} s` : endWet ? 'in deep water' : wet(v.pos.x, v.pos.z) ? 'in shallow water' : 'on land';
  console.log(`${fails.length ? 'FAIL' : 'ok  '} ${name}: entered ${enterT === null ? 'never' : `${enterT.toFixed(1)} s at ${enterKmh.toFixed(0)} km/h`} · ${outcome}` +
    ` · in water ${inWaterT.toFixed(1)} s · fully under ${maxUnder.toFixed(1)} s · oscillation ${osc.toFixed(3)} m · rebounds ${rebounds} · end ${(v.vel.length() * 3.6).toFixed(0)} km/h${fails.length ? ' · ' + fails.join(', ') : ''}`);
  if (process.env.V) console.log(lines.join('\n'));
  results.push({ name, fails });
  return v;
}

// ---------------------------------------------------------------- the runs
const sites = [['pond', [pond.x, pond.z]], ['river', RIVER]];
console.log(`pond: id ${pond.id} at ${pond.x.toFixed(0)},${pond.z.toFixed(0)}, ${pond.d.toFixed(1)} m deep · river: South Yamhill at ${RIVER}, ${depth(...RIVER).toFixed(1)} m deep`);
for (const [site, c] of sites) {
  const ap = approach(c);
  if (!ap) { console.log(`FAIL ${site}: no clear approach`); results.push({ name: site, fails: ['no approach'] }); continue; }
  console.log(`${site}: approach from ${ap.x.toFixed(0)},${ap.z.toFixed(0)} heading ${(ap.yaw * 57.3 % 360).toFixed(0)}°, ${ap.run.toFixed(0)} m of dry run-up`);
  for (const vehicle of ['car', 'bike']) {
    for (const kmh of [30, 80, 150]) {
      // drive in at kmh and keep the throttle down (the player holding W): below skimSpeed it must still sink
      const skim = (vehicle === 'bike' ? BIKE : TUNING_DEFAULTS).skimSpeed;
      run(`${site} ${vehicle} ${kmh} km/h`, vehicle, ap.x, ap.z, ap.yaw, 22, { kmh, expect: kmh < skim * 0.95 ? 'respawn' : 'any',
        ctl: (t, i, v) => { if (v.waterDepth > 0 || v.onWater) { i.throttle = 1; i.brake = 0; } } });
    }
    // on the water at about skimSpeed, half throttle, turning: the old per-wheel skim / sink switch bounced here
    run(`${site} ${vehicle} circling on the water near skimSpeed`, vehicle, c[0], c[1], ap.yaw, 18, {
      setup: v => { v.pos.y = wl(...c) + 0.6; v.vel.set(Math.sin(ap.yaw) * 90 / 3.6, 0, Math.cos(ap.yaw) * 90 / 3.6); },
      ctl: (t, i) => { i.throttle = 0.5; i.steer = 0.4; } });
    run(`${site} ${vehicle} dropped in at rest`, vehicle, c[0], c[1], ap.yaw, 14, { expect: 'respawn', setup: v => { v.pos.y = wl(...c) + 1.5; } });
    const sh = shallow(c);
    if (!sh) { console.log(`     ${site}: no shallow spot near`); continue; }
    run(`${site} ${vehicle} sitting still in shallow water`, vehicle, sh.x, sh.z, ap.yaw, 8, { expect: 'sit' });
    // drive out: point at the nearest dry ground
    let out = 0, outR = 1e9;
    for (let a = 0; a < Math.PI * 2; a += 0.05) for (let r = 1; r < 60; r++) if (!wet(sh.x + Math.sin(a) * r, sh.z + Math.cos(a) * r)) { if (r < outR) { outR = r; out = a; } break; }
    run(`${site} ${vehicle} driving out of shallow water`, vehicle, sh.x, sh.z, out, 6, { expect: 'out', ctl: (t, i) => { i.throttle = 1; } });
  }
  // glide down onto the water at 70 km/h
  for (const vehicle of ['car', 'bike']) {
    run(`${site} ${vehicle} glider touchdown on the water`, vehicle, c[0] - Math.sin(ap.yaw) * 20, c[1] - Math.cos(ap.yaw) * 20, ap.yaw, 16, { expect: 'respawn',
      setup: v => { const G = new Glider(v, vehicle === 'bike' ? BIKE_GLIDER : {}); v.pos.y = wl(...c) + 5; v.vel.set(Math.sin(ap.yaw) * 70 / 3.6, -1, Math.cos(ap.yaw) * 70 / 3.6); v.airTime = 1; G.toggle(); } });
  }
}
// ---------------------------------------------------------------- flat test pool: how much shallow water slows you
// A stub world: flat dry ground at 0 m for x < 0, for x ≥ 0 water at 0 m over a flat bed `d` m down. Full throttle +x.
function pool(d) {
  const lv = x => (d > 0 && x >= 0 ? 0 : -Infinity), bed = x => (d > 0 && x >= 0 ? -d : 0);
  return { extent: [-1e5, -1e5, 1e5, 1e5], tiles: new Map(), heightAt: bed, terrainAt: bed, groundAt: bed,
    surfaceAt: x => (lv(x) > 0 ? 5 : 3), waterLevelAt: x => lv(x), normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0),
    treesNear() {}, buildingsNear: () => [], loadedAt: () => true, mapContains: () => true, rampAt: () => 0 };
}
function flat(vehicle, d, kmh, secs, x0 = 10) {
  const v = vehicle === 'bike' ? new Bike(pool(d), { ...BIKE }) : new Car(pool(d), { ...TUNING_DEFAULTS });
  v.reset(x0, 0, Math.PI / 2); v.vel.set(kmh / 3.6, 0, 0);
  const inp = { throttle: 1, brake: 0, steer: 0, handbrake: false, lean: false }, ys = [];
  let nan = false, wetT = null, skimT = 0;
  for (let i = 0; i < secs / DT; i++) {
    v.step(DT, inp);
    if (wetT === null && v.pos.x >= 0) wetT = i * DT;
    if (wetT !== null && skimT === 0 && (v.waterSub || 0) > 0.3) skimT = i * DT - wetT;   // sank into it
    if (![v.pos.x, v.pos.y, v.vel.x].every(Number.isFinite)) { nan = true; break; }
    if (i * DT > 1.5) ys.push(v.pos.y);
    if (process.env.V && i % 12 === 0) console.log(`  ${vehicle} d${d} ${(i * DT).toFixed(1)}s x${v.pos.x.toFixed(0)} y${v.pos.y.toFixed(2)} vy${v.vel.y.toFixed(2)} ${(v.vel.length() * 3.6).toFixed(0)}km/h` +
      ` pitch° ${(Math.asin(new THREE.Vector3(0, 0, 1).applyQuaternion(v.quat).y) * 57.3).toFixed(0)} contacts ${v.contacts} plane ${v.wheels.map(w => (w.plane || 0).toFixed(2))} sub ${(v.waterSub || 0).toFixed(2)}`);
  }
  return { kmh: v.vel.length() * 3.6, osc: oscillation(ys), nan, skimT: skimT || (wetT === null ? 0 : secs - wetT) };
}
if (!filter.length || filter.includes('flat')) {
  for (const vehicle of ['car', 'bike']) {
    const dry = flat(vehicle, 0, 0, 6), wade = flat(vehicle, 0.3, 0, 6), fast = flat(vehicle, 0.3, 150, 4.2, -20), deep = flat(vehicle, 2, 150, 4.2, -20);
    const fails = [];
    for (const r of [dry, wade, fast, deep]) { if (r.nan) fails.push('NaN'); if (r.osc >= 0.1) fails.push(`oscillation ${r.osc.toFixed(3)} m`); }
    if (wade.kmh > dry.kmh * 0.45) fails.push('shallow water barely slows it');
    if (fast.skimT < 2 || deep.skimT < 2) fails.push('fast entry did not skim');
    console.log(`${fails.length ? 'FAIL' : 'ok  '} flat pool ${vehicle}: full throttle 6 s from rest — dry ${dry.kmh.toFixed(0)} km/h, in 0.3 m of water ${wade.kmh.toFixed(0)} km/h` +
      ` (oscillation ${wade.osc.toFixed(3)} m) · in at 150 km/h, full throttle: 0.3 m deep skims ${fast.skimT.toFixed(1)} s, ${fast.kmh.toFixed(0)} km/h` +
      ` at the end; 2 m deep skims ${deep.skimT.toFixed(1)} s, ${deep.kmh.toFixed(0)} km/h at the end (oscillation ${Math.max(fast.osc, deep.osc).toFixed(3)} m)${fails.length ? ' · ' + fails.join(', ') : ''}`);
    results.push({ name: `flat pool ${vehicle}`, fails });
  }
}

const bad = results.filter(r => r.fails.length);
console.log(`\n${results.length - bad.length}/${results.length} runs ok${bad.length ? ' · FAILED: ' + bad.map(r => r.name).join('; ') : ''}`);
process.exit(bad.length ? 1 : 0);
