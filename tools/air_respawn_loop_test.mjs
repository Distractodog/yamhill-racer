// Aircraft respawns must never crash again (owner: "sometimes when I respawn the plane it spawns a little in the air,
// comes down on its nose and crashes, and it loops over and over").   node tools/air_respawn_loop_test.mjs [--quick]
// Real map data (a block of tiles around campus + Sheridan, McMinnville, and a stretch of the north map edge). For every
// aircraft type (fighter, stealth, prop, stunt through jet.js; helicopter through heli.js) × 50 respawn spots — roads,
// hills, beside buildings, bridge decks and the roads under them, the map edge, random ground — the respawn is made
// both ways the game makes it: after a crash (wreck tumble, then the automatic respawn) and by R in flight. After each
// one: 5 s with hands off. Pass: 0 crashes within 5 s of a respawn (so no loop), on its gear (ground mode), level-ish
// and on the ground (not floating, not under it), and no leftover spin.
// A failure prints the spot, the type, what happened and when (V=1: every respawn).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { Jet, JET } from '../game/src/jet.js';
import { Heli } from '../game/src/heli.js';
import { applyVehicleType, VEHICLE_TYPES } from '../game/src/vehicletypes.js';

const A = (process.env.YR_ASSETS || 'game/assets').replace(/\/?$/, '/');
const WJ = JSON.parse(fs.readFileSync(A + 'world.json'));
const W = makeWorld(WJ);
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const have = new Set(WJ.tiles.map(t => t.join()));
const BOXES = [[-2, -1, 3, 1], [8, -7, 11, -4], [0, -14, 4, -12]];           // campus + Sheridan, McMinnville, north edge
const QUICK = process.argv.includes('--quick'), PER = QUICK ? 12 : 50;
let loaded = 0;
for (const [x0, z0, x1, z1] of BOXES) for (let tx = x0; tx <= x1; tx++) for (let tz = z0; tz <= z1; tz++) {
  if (!have.has(`${tx},${tz}`)) continue;
  const d = `${A}tiles/${tx}_${tz}/`;
  W.add(makeTileData(WJ, tx, tz, await readTileData(async f => ab(d + f), WJ.packed))); loaded++;
}
const rand = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(4242);
const T = WJ.tile, tiles = [...W.tiles.values()];
const inLoaded = (x, z, r = 60) => [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]].every(([a, b]) => W.loadedAt(x + a, z + b));
const randomPoint = () => { const t = tiles[Math.floor(rand() * tiles.length)]; return [t.x0 + 80 + rand() * (T - 160), t.z0 + 80 + rand() * (T - 160)]; };
const dry = (x, z) => W.waterLevelAt(x, z) < W.terrainAt(x, z) - 0.2;

// ---- respawn spots by kind (each [x, z, yaw, kind]); safe spots are where an aircraft stood, so all on dry ground
function spots() {
  const out = [], push = (x, z, yaw, kind) => { if (inLoaded(x, z) && dry(x, z)) out.push([x, z, yaw, kind]); return true; };
  const roads = tiles.flatMap(t => t.roads || []).filter(r => r.n > 8);
  const bridges = roads.filter(r => r.bridge);
  const want = { road: 10, hill: 8, building: 8, bridge: 6, under: 4, edge: 6, random: 8 };
  const count = k => out.filter(s => s[3] === k).length;
  for (let guard = 0; guard < 20000 && out.length < Object.values(want).reduce((a, b) => a + b); guard++) {
    if (count('road') < want.road) { const r = roads[Math.floor(rand() * roads.length)], i = 1 + Math.floor(rand() * (r.n - 2)); push(r.x[i], r.z[i], Math.atan2(r.x[i + 1] - r.x[i], r.z[i + 1] - r.z[i]), 'road'); continue; }
    if (count('hill') < want.hill) {
      const [x, z] = randomPoint(), s = Math.hypot(W.terrainAt(x + 5, z) - W.terrainAt(x - 5, z), W.terrainAt(x, z + 5) - W.terrainAt(x, z - 5)) / 10;
      if (s > 0.12) push(x, z, rand() * 6.28, 'hill'); continue;
    }
    if (count('building') < want.building) {
      const [x, z] = randomPoint(), b = W.buildingsNear(x, z).find(b => b.pts?.length > 2);
      if (b) { const [px, pz] = b.pts[0], cx = b.pts.reduce((s, p) => s + p[0], 0) / b.pts.length, cz = b.pts.reduce((s, p) => s + p[1], 0) / b.pts.length, d = Math.hypot(px - cx, pz - cz) || 1;
        push(px + (px - cx) / d * 7, pz + (pz - cz) / d * 7, rand() * 6.28, 'building'); }
      continue;
    }
    if (bridges.length && count('bridge') < want.bridge) { const r = bridges[Math.floor(rand() * bridges.length)], i = Math.floor(r.n / 2); push(r.x[i], r.z[i], Math.atan2(r.x[i + 1] - r.x[i - 1], r.z[i + 1] - r.z[i - 1]), 'bridge'); continue; }
    if (bridges.length && count('under') < want.under) {   // beside / under a deck: 12–25 m off its middle, sideways
      const r = bridges[Math.floor(rand() * bridges.length)], i = Math.floor(r.n / 2), dx = r.x[i + 1] - r.x[i - 1], dz = r.z[i + 1] - r.z[i - 1], d = Math.hypot(dx, dz) || 1, o = 12 + rand() * 13;
      push(r.x[i] - dz / d * o, r.z[i] + dx / d * o, Math.atan2(dx, dz), 'under'); continue;
    }
    if (count('edge') < want.edge) { const x = (rand() * 5) * T - T / 2 + 200 + rand() * 600, z = -14 * T - T / 2 + 30 + rand() * 60; push(x, z, Math.PI * (rand() < .5 ? 0 : 1) + rand() - .5, 'edge'); continue; }
    if (count('random') < want.random) { const [x, z] = randomPoint(); push(x, z, rand() * 6.28, 'random'); continue; }
    if (!bridges.length) { want.bridge = 0; want.under = 0; }
  }
  return out;
}
const SPOTS = spots().slice(0, PER);
const idle = { throttle: 0, brake: 0, steer: 0, handbrake: false, jet: { thr: 0, pitch: 0, roll: 0, yaw: 0 } };
const TYPES = VEHICLE_TYPES.jet.map(t => t.id);
// counts grace saves (a crash turned into a reset): a good respawn needs none
function make(id) {
  const v = id === 'heli' ? new Heli(W) : new Jet(W, { ...JET }); if (id !== 'fighter' && id !== 'heli') applyVehicleType(v, id);
  const recover = v.recover.bind(v); v.recover = () => { v._saves = (v._saves || 0) + 1; recover(); };
  return v;
}
const step = v => { v.savePrev(); v.step(1 / 120, idle); };
const up = new THREE.Vector3();
// one respawn; returns a problem string or null
// where: 'far' = flying 250 m away, 120 m up; 'near' = a low pass right over the spot (the wreck ends up beside it,
// so a second crash there would loop)
function respawn(v, [x, z, yaw, kind], how, where) {
  v.safe = [[x, z, yaw]]; v.respawn = null;
  const d = where === 'near' ? 5 + rand() * 30 : 250, a = rand() * 6.28, fx = x + d * Math.sin(a), fz = z + d * Math.cos(a);
  v.placeInAir(fx, W.heightAt(fx, fz) + (where === 'near' ? 10 + rand() * 40 : 120), fz, rand() * 6.28, v instanceof Heli ? 120 : 350);
  v.pos.y = W.heightAt(fx, fz) + (where === 'near' ? 10 + rand() * 40 : 120); v.afterReset();
  for (let i = 0; i < (where === 'near' ? 3 : 30); i++) step(v);
  if (how === 'crash') { v.crash('impact'); let n = 0; while (v.mode === 'crashed' && n++ < 120 * 10) step(v); if (v.mode === 'crashed') return 'never respawned'; }
  else v.resetToSafe();
  const y0 = v.pos.y, g0 = W.heightAt(v.pos.x, v.pos.z, v.pos.y);
  // the respawn may move up to 45 m to level, clear ground (airrespawn.js findGround)
  if (Math.hypot(v.pos.x - x, v.pos.z - z) > 50) return `respawned ${Math.hypot(v.pos.x - x, v.pos.z - z).toFixed(0)} m from its spot`;
  let firstAir = null, worstSpin = 0; const saves0 = v._saves || 0;
  for (let i = 1; i <= 120 * 5; i++) {
    step(v);
    if ((v._saves || 0) > saves0) return `would have crashed ${(i / 120).toFixed(2)} s after the respawn (caught by the grace)`;
    if (v.mode === 'air' && firstAir === null) firstAir = i / 120;
    worstSpin = Math.max(worstSpin, v.ang.length());
    if (v.mode === 'crashed') return `CRASHED ${(i / 120).toFixed(2)} s after the respawn (${v.msg}); placed ${(y0 - g0).toFixed(2)} m over the ground under it` +
      `${firstAir !== null ? `, airborne from ${firstAir.toFixed(2)} s` : ''}; deck/roof vs terrain here ${(W.heightAt(x, z) - W.terrainAt(x, z)).toFixed(1)} m`;
  }
  if (v.mode !== 'ground') return `not on its gear 5 s later (mode ${v.mode}${firstAir !== null ? `, airborne from ${firstAir.toFixed(2)} s` : ''})`;
  up.set(0, 1, 0).applyQuaternion(v.quat);
  if (up.y < 0.85) return `not level: up.y ${up.y.toFixed(2)}`;
  if (worstSpin > 1.5) return `spinning after the respawn (${worstSpin.toFixed(2)} rad/s)`;
  const clear = v.pos.y - W.heightAt(v.pos.x, v.pos.z, v.pos.y);
  if (clear < 0 || clear > 3) return `${clear.toFixed(2)} m over the ground 5 s later`;
  return null;
}
const problems = [], counts = {};
for (const id of TYPES) {
  const v = make(id);
  let n = 0;
  for (const spot of SPOTS) for (const [how, where] of [['crash', 'far'], ['crash', 'near'], ['R', 'far'], ['R', 'near']]) {
    const p = respawn(v, spot, how, where); n++;
    if (process.env.V) console.log(id, how, where, spot[3], spot.slice(0, 2).map(Math.round).join(','), p || 'ok');
    if (p) problems.push(`${id} ${how} (${where}) at ${spot[3]} (${spot[0].toFixed(0)}, ${spot[1].toFixed(0)}, yaw ${spot[2].toFixed(2)}): ${p}`);
  }
  counts[id] = n;
}
// the grace itself: a crash forced 1 s after a respawn leaves no wreck and doesn't chain; 30 crash → respawn cycles
// in a row at one spot each end on the gear; and every jet race ring's air respawn, hands off for 8 s, never crashes
const ringNeed = JSON.parse(fs.readFileSync(A + 'challenges.json')).filter(c => c.vehicle === 'jet');
for (const id of TYPES) {
  const v = make(id), spot = SPOTS.find(s => s[3] === 'building') || SPOTS[0];
  v.safe = [spot.slice(0, 3)]; v.placeInAir(spot[0], W.heightAt(spot[0], spot[1]) + 60, spot[1], 0, 300); v.crash('impact');
  let n = 0; while (v.mode === 'crashed' && n++ < 1200) step(v);
  for (let i = 0; i < 120; i++) step(v);
  v.crash('impact');
  if (v.mode === 'crashed') problems.push(`${id}: a crash 1 s after a respawn made a wreck (grace)`);
  for (let i = 0; i < 120 * 5; i++) { step(v); if (v.mode === 'crashed') { problems.push(`${id}: crashed after a grace save`); break; } }
  for (let c = 0; c < 30; c++) {
    v.placeInAir(spot[0] + 20, W.heightAt(spot[0], spot[1]) + 15, spot[1] + 10, c, 250); v.grace = 0; v.crash('impact');
    let k = 0; while (v.mode === 'crashed' && k++ < 1200) step(v);
    for (let i = 0; i < 120 * 5 && v.mode !== 'crashed'; i++) step(v);
    if (v.mode !== 'ground') { problems.push(`${id}: cycle ${c + 1} ended ${v.mode}`); break; }
  }
  const rings = [];
  for (const c of ringNeed) c.gates.forEach((g, gi) => { if (gi >= 1 && W.loadedAt(g.x, g.z)) rings.push([c.name, gi, g]); });
  for (const [name, gi, g] of rings) {
    v.respawn = () => [g.x, g.y, g.z, g.yaw, 450];
    v.placeInAir(g.x, g.y + 200, g.z, 0, 300); v.grace = 0; v.crash('impact');
    let k = 0; while (v.mode === 'crashed' && k++ < 1200) step(v);
    const saves0 = v._saves || 0;
    for (let i = 0; i < 120 * 8; i++) { step(v); if (v.mode === 'crashed' || (v._saves || 0) > saves0) { problems.push(`${id}: ${name} ring ${gi} air respawn crashed ${(i / 120).toFixed(1)} s later, hands off`); break; } }
  }
  v.respawn = null;
  counts[id] += 32 + rings.length;
}
const kinds = Object.fromEntries([...new Set(SPOTS.map(s => s[3]))].map(k => [k, SPOTS.filter(s => s[3] === k).length]));
console.log(`${loaded} tiles · ${SPOTS.length} spots per type ${JSON.stringify(kinds)} · respawns ${JSON.stringify(counts)}`);
if (problems.length) console.log(problems.slice(0, 40).join('\n') + (problems.length > 40 ? `\n… ${problems.length - 40} more` : ''));
assert.equal(problems.length, 0, `${problems.length} bad respawns`);
console.log(`PASS aircraft respawn: ${Object.values(counts).reduce((a, b) => a + b)} respawns of ${TYPES.join(', ')} (crash and R, wreck far / beside the spot, ` +
  `30-cycle chains, race-ring air respawns): 0 crashes and 0 grace saves within 5 s, all on their gear, level, no spin; a forced crash in the grace leaves no wreck`);
