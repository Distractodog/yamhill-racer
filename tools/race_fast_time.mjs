// The race car's real pace on one race: tools/drive.mjs's walls bot (pure pursuit, slowing for bends) without its
// 260 km/h cap, so it runs up to the car's top speed (TUNING_DEFAULTS), with the race's walls and ramps on. Loads only
// the tiles the route crosses. challenge_routes.py's FAST_TIMES (medals of top-speed races) come from this.
//   node tools/race_fast_time.mjs hwy18-top-speed [capKmh]
import fs from 'fs';
import * as THREE from 'three';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { readTileData } from '../game/src/tilepack.js';
import { makeTrack } from '../game/src/track.js';

const id = process.argv[2] || 'hwy18-top-speed';
const A = (process.env.YR_ASSETS || 'game/assets').replace(/\/?$/, '/');
const WJ = JSON.parse(fs.readFileSync(A + 'world.json')), W = makeWorld(WJ);
const c = JSON.parse(fs.readFileSync(A + 'challenges.json')).find(r => r.id === id);
if (!c?.track) throw Error(`no car/bike race ${id}`);
const cap = +(process.argv[3] || TUNING_DEFAULTS.topSpeed || 1000);
// every tile within 300 m of the route
const need = new Set(), T = WJ.tile, have = new Set(WJ.tiles.map(t => t.join('_')));
for (const [x, z] of c.track) for (const dx of [-300, 0, 300]) for (const dz of [-300, 0, 300])
  need.add(`${Math.floor((x + dx + T / 2) / T)}_${Math.floor((z + dz + T / 2) / T)}`);
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
for (const k of need) if (have.has(k)) {
  const [tx, tz] = k.split('_').map(Number), d = `${A}tiles/${k}/`;
  W.add(makeTileData(WJ, tx, tz, await readTileData(async f => ab(d + f), WJ.packed)));
}
const DT = 1 / 120, fw = new THREE.Vector3(), up = new THREE.Vector3();
const R = c.track, track = makeTrack(R); W.setRamps(c.ramps);
const car = new Car(W, { ...TUNING_DEFAULTS });
const [sx, sz] = R[0]; car.reset(sx, sz, Math.atan2(R[3][0] - sx, R[3][1] - sz));
const inp = { throttle: 0, brake: 0, steer: 0, handbrake: false };
let tgt = 0, t = 0, done = null, top = 0, hits = 0, flips = 0, wasUp = true, nan = false;
for (let i = 0; i < (c.length / 30 + 120) / DT && done === null; i++) {
  t = i * DT;
  const sp = car.vel.length(), look = 10 + sp * 0.5;
  while (R[tgt + 1] && Math.hypot(R[tgt][0] - car.pos.x, R[tgt][1] - car.pos.z) < look) tgt++;
  fw.set(0, 0, 1).applyQuaternion(car.quat);
  let d = Math.atan2(R[tgt][0] - car.pos.x, R[tgt][1] - car.pos.z) - Math.atan2(fw.x, fw.z); d = Math.atan2(Math.sin(d), Math.cos(d));
  inp.steer = Math.max(-1, Math.min(1, -d * 2.5));
  const a = R[Math.min(R.length - 1, tgt + 3)], b = R[Math.min(R.length - 1, tgt + 15)], a0 = R[tgt];
  let turn = Math.atan2(b[0] - a[0], b[1] - a[1]) - Math.atan2(a[0] - a0[0], a[1] - a0[1]); turn = Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)));
  const want = Math.max(50, cap * (1 - turn * 1.2));
  inp.throttle = sp * 3.6 < want ? 1 : 0; inp.brake = sp * 3.6 > want + 25 ? 1 : 0;
  car.step(DT, inp);
  const hit = track.constrain(car); if (hit > 0) hits++;
  if (process.argv[4] === 'v' && (i % 120 === 0 || (hit > 0 && hits < 20))) console.log(`   ${t.toFixed(2)} s ${car.pos.x.toFixed(0)},${car.pos.z.toFixed(0)} y-h ${(car.pos.y - W.heightAt(car.pos.x, car.pos.z)).toFixed(1)} ` +
    `${(car.vel.length() * 3.6).toFixed(0)} km/h track ${track.index}/${R.length - 1} tgt ${tgt}${hit > 0 ? ` WALL ${hit.toFixed(1)}` : ''}${car.grounded ? '' : ' air'}`);
  top = Math.max(top, car.vel.length() * 3.6);
  up.set(0, 1, 0).applyQuaternion(car.quat); if (wasUp && up.y < 0) flips++; wasUp = up.y > 0;
  if (!isFinite(car.pos.x) || !isFinite(car.vel.x)) { nan = true; break; }
  if (track.index >= R.length - 3) done = t;
}
console.log(`${c.name} (${c.length} m), car bot capped at ${cap} km/h: ${done !== null ? `finished in ${done.toFixed(1)} s` : `DID NOT FINISH (got to ${(track.index / (R.length - 1) * 100).toFixed(0)}%)`}` +
  ` · top ${top.toFixed(0)} km/h · wall contact ${hits} steps · flips ${flips}${nan ? ' · NaN!' : ''}`);
console.log(`   for comparison: the whole length at 85% of ${cap} km/h = ${(c.length / (cap * 0.85 / 3.6)).toFixed(1)} s`);
process.exit(done !== null && !nan ? 0 : 1);
