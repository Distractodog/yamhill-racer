// Roof landings on the real tiles and buildings (no rendering): car, bike, fighter jet (+ prop plane) and helicopter
// dropped onto / driven across roofs: a flat downtown McMinnville roof, a pitched town house, campus buildings (flat
// with parapet + rooftop units, gable, hip with a porch), roof edges, roof-to-roof jumps, driving off an edge, a steep
// roof (slides off), a fighter low pass and landing on the Space Museum roof.
// The reference is the DRAWN roof: the game's own building meshes (campusmodel.js / townmodel.js), ray-cast from
// above. Every run asserts: no NaN, no teleport (> 2 m in one 1/120 s step), never inside a building (centre more
// than 0.3 m under its drawn roof), and the scenario's own goal (rests on the roof with every roof contact within
// 5 cm of the drawn roof, slides / falls off, lands on the next roof...).
//   node tools/roof_test.mjs [words]       only scenarios whose name contains one of the words; V=1 prints timelines
//   node tools/roof_test.mjs --src=<dir>/game/src   runs another copy of the game code (before/after comparisons;
//   the drawn reference always comes from this checkout)
// Loads 3 tiles (campus 0_0, McMinnville 10_-6, Space Museum 12_-5): ~400 MB, ~1 min. Run it through the heavy gate.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import * as THREE from 'three';
import { inPoly, partPts } from '../game/src/campus.js';
import { buildCampusGeometry } from '../game/src/campusmodel.js';
import { footprintMeshes, planFootprint, roadContext } from '../game/src/townmodel.js';

const srcArg = process.argv.find(a => a.startsWith('--src='));
const SRC = path.resolve(srcArg ? srcArg.slice(6) : process.env.YR_SRC || 'game/src');
const imp = f => import(pathToFileURL(path.join(SRC, f)).href);
const { makeWorld, makeTileData } = await imp('data.js');
const { readTileData } = await imp('tilepack.js');
const { Car, TUNING_DEFAULTS } = await imp('car.js');
const { Bike } = await imp('bike.js');
const { Jet } = await imp('jet.js');
const { Heli } = await imp('heli.js');
const { applyVehicleType } = await imp('vehicletypes.js');

const A = (process.env.YR_ASSETS || 'game/assets').replace(/\/?$/, '/');
const WJ = JSON.parse(fs.readFileSync(A + 'world.json'));
const W = makeWorld(WJ);
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
for (const [tx, tz] of [[0, 0], [10, -6], [12, -5]]) {
  const d = `${A}tiles/${tx}_${tz}/`;
  W.add(makeTileData(WJ, tx, tz, await readTileData(async f => ab(d + f), WJ.packed)));
}
const DT = 1 / 120, V = !!process.env.V || process.argv.includes('--v');
const traceArg = process.argv.find(a => a.startsWith('--trace='));      // --trace=<s>: every step around that time
const TRACE = traceArg ? +traceArg.slice(8) : null;
const words = process.argv.slice(2).filter(a => !a.startsWith('--'));
const want = name => !words.length || words.some(w => name.includes(w));

// ---------------------------------------------------------------- the drawn buildings
const tileOf = new Map(), roadsOf = new Map();
for (const td of W.tiles.values()) for (const b of td.buildings) tileOf.set(b, td);
const MAT = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), meshes = new Map(), plans = new Map();
const ray = new THREE.Raycaster(), DOWN = new THREE.Vector3(0, -1, 0), _o = new THREE.Vector3();
function planOf(b) {
  if (b.roofBuilding) return b.roofBuilding;
  let p = plans.get(b);
  if (!p) {
    const td = tileOf.get(b);
    if (!roadsOf.has(td)) roadsOf.set(td, roadContext(td.renderRoads));
    plans.set(b, p = planFootprint(b, roadsOf.get(td)));
  }
  return p;
}
function meshOf(b) {
  const key = b.roofBuilding || b;
  let m = meshes.get(key);
  if (!m) {
    const td = tileOf.get(b);
    const geo = b.roofBuilding ? buildCampusGeometry(b.roofBuilding, td.terrainAt) : footprintMeshes(planOf(b), td.terrainAt)?.near;
    m = new THREE.Mesh(geo || new THREE.BufferGeometry(), MAT); m.updateMatrixWorld(); meshes.set(key, m);
  }
  return m;
}
// the highest drawn surface of building b at (x, z), -Infinity if b has none there
function drawnTop(b, x, z) {
  ray.set(_o.set(x, 3000, z), DOWN);
  const hit = ray.intersectObject(meshOf(b), false);
  return hit.length ? hit[0].point.y : -Infinity;
}
const centroid = pts => { let x = 0, z = 0; for (const p of pts) { x += p[0]; z += p[1]; } return [x / pts.length, z / pts.length]; };
const areaOf = pts => { let a = 0; for (let i = 0; i < pts.length; i++) { const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length]; a += x1 * z2 - x2 * z1; } return Math.abs(a) / 2; };
function edgeDist(pts, x, z) {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [x1, z1] = pts[j], [x2, z2] = pts[i], ex = x2 - x1, ez = z2 - z1, L = ex * ex + ez * ez || 1;
    const u = Math.max(0, Math.min(1, ((x - x1) * ex + (z - z1) * ez) / L));
    best = Math.min(best, Math.hypot(x - x1 - ex * u, z - z1 - ez * u));
  }
  return best;
}
// a disc of radius r around (x, z) inside the footprint
const clear = (pts, x, z, r) => inPoly(pts, x, z) && edgeDist(pts, x, z) >= r;
const near = (x, z, r) => W.buildingsNear(x, z, r + 60).filter(b => b.pts?.length >= 3 && b.pts.some(([px, pz]) => Math.hypot(px - x, pz - z) < r + 60));

// ---------------------------------------------------------------- picking the buildings
const find = (name, pred) => { for (const td of W.tiles.values()) for (const b of td.buildings) if (pred(b)) return b; throw Error('no building: ' + name); };
const named = name => find(name, b => b.roofBuilding?.name === name && inPoly(b.pts, ...centroid(partPts(b.roofBuilding.parts[0]))));
const DOWNTOWN = [19330, -11110];
function plannedNear([x, z], pred) {
  let best = null, bd = Infinity;
  for (const b of near(x, z, 500)) {
    if (b.roofBuilding) continue;
    const c = centroid(b.pts), d = Math.hypot(c[0] - x, c[1] - z);
    if (d < bd && pred(planOf(b), b)) { best = b; bd = d; }
  }
  if (!best) throw Error('no planned building near ' + [x, z]);
  return best;
}
const flatTown = plannedNear(DOWNTOWN, (p, b) => p.kind === 'commercial' && p.parts.length === 1 && p.parts[0].roof.type === 'flat'
  && clear(b.pts, ...centroid(b.pts), 9));
const gableHouse = plannedNear(DOWNTOWN, p => p.kind === 'house' && p.parts.length === 1 && p.parts[0].roof.type === 'gable' && p.parts[0].roof.pitch > 28);
const hipHouse = plannedNear(DOWNTOWN, p => p.kind === 'house' && p.parts.length === 1 && p.parts[0].roof.type === 'hip' && p.parts[0].roof.pitch > 25);
// the steepest single gable in town (no churches in these tiles: houses go up to ~35°)
const steep = plannedNear(DOWNTOWN, (p, b) => p.parts.length === 1 && p.parts[0].roof.type === 'gable' && p.parts[0].roof.pitch > 33.5);
const gym = named('Gym'), barn = named('Barn 1'), heron = named('Heron Print Shop'), museum = named('Space Museum'), main = named('Main Building');

// a point on a pitched part's roof: a quarter of the way across from one eave, mid-length; yaw along the ridge,
// down = facing down the slope
function onSlope(part) {
  const pts = partPts(part), l01 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), l12 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
  const r = l01 >= l12 ? pts : [pts[1], pts[2], pts[3], pts[0]];
  const a = r[0], u = [(r[1][0] - a[0]) / 2, (r[1][1] - a[1]) / 2], w = [(r[3][0] - a[0]) / 4, (r[3][1] - a[1]) / 4];
  return { x: a[0] + u[0] + w[0], z: a[1] + u[1] + w[1], yaw: Math.atan2(r[1][0] - a[0], r[1][1] - a[1]), down: Math.atan2(-w[0], -w[1]) };
}

// Roof-to-roof jump: a flat roof with a run-up of 14 m toward a gap of 2.5–7 m and a flat roof 0.3–4 m lower beyond
function findJump() {
  const [cx, cz] = DOWNTOWN;
  const flats = near(cx, cz, 450).filter(b => {
    const p = planOf(b); return p.parts.every(q => q.roof.type === 'flat') && areaOf(b.pts) > 250;
  });
  const out = [];
  for (const a of flats) {
    const [ax, az] = centroid(a.pts), topA = drawnTop(a, ax, az);
    if (!clear(a.pts, ax, az, 2.5)) continue;
    for (let k = 0; k < 8; k++) {
      const ang = k * Math.PI / 4, dx = Math.sin(ang), dz = Math.cos(ang);
      let s = 0; while (s < 200 && inPoly(a.pts, ax + dx * s, az + dz * s)) s += 0.5;
      if (s < 16) continue;
      const lane = t => [-2, 0, 2].map(o => [ax + dx * t + dz * o, az + dz * t - dx * o]);
      // run-up 14 m before the edge, two metres either side of the line
      if (![2, 6, 10, 14].every(back => lane(s - back).every(([x, z]) => inPoly(a.pts, x, z) && Math.abs(drawnTop(a, x, z) - topA) < 0.05))) continue;
      let gap = s, landing = null;
      for (; gap < s + 7.5; gap += 0.5) {
        const [x, z] = [ax + dx * gap, az + dz * gap];
        landing = flats.find(b => b !== a && inPoly(b.pts, x, z));
        if (landing) break;
      }
      if (!landing || gap - s < 2.5) continue;
      const topB = drawnTop(landing, ax + dx * (gap + 3), az + dz * (gap + 3));
      if (!(topB < topA - 0.3 && topB > topA - 4)) continue;
      if (![3, 6, 9].every(f => lane(gap + f).every(([x, z]) => inPoly(landing.pts, x, z) && Math.abs(drawnTop(landing, x, z) - topB) < 0.05))) continue;
      out.push({ a, b: landing, x: ax + dx * (s - 14), z: az + dz * (s - 14), yaw: ang, gap: gap - s, drop: topA - topB });
    }
  }
  out.sort((p, q) => p.gap - q.gap);
  return out[0];
}

// ---------------------------------------------------------------- vehicles and runs
function make(kind) {
  if (kind === 'car') return new Car(W, { ...TUNING_DEFAULTS });
  if (kind === 'bike') return new Bike(W);
  if (kind === 'heli') return new Heli(W);
  const j = new Jet(W);
  if (kind === 'prop') applyVehicleType(j, 'prop');
  return j;
}
const AIR = new Set(['jet', 'prop', 'heli']);
// put v above (x, z) at height y, falling at `sink` m/s, moving `fwd` m/s along yaw
function drop(v, kind, x, z, yaw, y, sink = 2, fwd = 0) {
  v.reset(x, z, yaw);
  v.pos.set(x, y, z);
  if (kind === 'heli') { v.toAir(); v.rotor = 1; v.throttle = 1; v.idleT = 0; }
  else if (AIR.has(kind)) { v.mode = 'air'; v.gear = 1; v.airTime = 1; v.throttle = 0; }
  v.vel.set(Math.sin(yaw) * fwd, -sink, Math.cos(yaw) * fwd);
  v.savePrev();
}
const idle = () => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, jet: { thr: 0, pitch: 0, roll: 0, yaw: 0 } });

// Runs v for secs with ctl(t, input, v); watches the buildings bs. Returns the numbers the checks use.
function run(v, kind, secs, bs, ctl = () => {}) {
  const inp = idle(), r = { nan: false, maxJump: 0, inside: 0, insideDepth: 0, roofErr: 0, roofContacts: 0, onRoof: {}, rest: Infinity,
    leftRoofAt: null, minY: Infinity, crashed: false, landed: false, rows: [] };
  const hist = [];
  const last = new THREE.Vector3().copy(v.pos);
  for (let i = 0; i < secs / DT; i++) {
    const t = i * DT;
    const wreck = v.mode === 'crashed';
    v.savePrev(); ctl(t, inp, v); v.step(DT, inp);
    const p = v.pos;
    if (![p.x, p.y, p.z, v.vel.x, v.vel.y, v.vel.z].every(Number.isFinite)) { r.nan = true; break; }
    if (wreck && v.mode !== 'crashed') { r.respawned = true; last.copy(p); }       // a crash's respawn is not a teleport
    if (r.respawned) break;
    const d = last.distanceTo(p);
    if (d > r.maxJump) { r.maxJump = d; r.jumpAt = `${t.toFixed(2)} s: ${[last.x, last.y, last.z].map(q => q.toFixed(2))} → ${[p.x, p.y, p.z].map(q => q.toFixed(2))}`; }
    last.copy(p);
    if (v.mode === 'crashed' && !r.crashed) { r.crashed = true; r.crashAt = t; r.crashMsg = v.msg; if (V) r.rows.push(`  crash at ${t.toFixed(2)} s: ${v.msg}`); }
    r.minY = Math.min(r.minY, p.y);
    let on = null;
    for (const b of v.mode === 'crashed' ? [] : bs) {       // (a tumbling wreck has no building collisions)
      if (!inPoly(b.pts, p.x, p.z)) continue;
      const top = drawnTop(b, p.x, p.z);
      if (p.y < top - 0.3 && top > W.terrainAt(p.x, p.z) + 1) { r.inside++; r.insideDepth = Math.max(r.insideDepth, top - p.y); }
    }
    // contacts on a roof: each against the drawn roof under it (not within 0.45 m of a footprint edge: parapet rims)
    const grounded = AIR.has(kind) ? v.mode === 'ground' : v.grounded;
    if (grounded) {
      for (const wh of v.wheels) {
        if (!wh.contact) continue;
        const c = wh.contactPoint, ground = W.terrainAt(c.x, c.z);
        for (const b of bs) {
          const top = drawnTop(b, c.x, c.z);
          if (!(top > ground + 1) || Math.abs(c.y - top) > 1.5) continue;
          on = b; r.onRoof[bs.indexOf(b)] = (r.onRoof[bs.indexOf(b)] || 0) + 1;
          if (edgeDist(b.pts, c.x, c.z) < 0.45) continue;
          r.roofContacts++; r.roofErr = Math.max(r.roofErr, Math.abs(c.y - top));
        }
      }
      if (AIR.has(kind) && on && !r.landed) { r.landed = true; r.landedAt = t; }
    }
    if (r.everOn && !on && r.leftRoofAt === null && !grounded) r.leftRoofAt = t;
    if (on) { r.everOn = true; r.leftRoofAt = null; }
    hist.push([p.x, p.y, p.z]);
    if (TRACE !== null && Math.abs(t - TRACE) < 0.06) console.log(`  ${t.toFixed(3)} pos ${[p.x, p.y, p.z].map(q => q.toFixed(3))} vel ${[v.vel.x, v.vel.y, v.vel.z].map(q => q.toFixed(2))} ` +
      `${grounded ? 'G' : 'air'} wheels ${v.wheels.map(w => w.contact ? w.contactPoint.y.toFixed(2) : '-').join(' ')} hit ${v.hit?.toFixed?.(2)} onRoof ${v.world.onRoof?.()} under ${v.world.heightAt(p.x, p.z, p.y).toFixed(2)} pitch ${v.pitch?.toFixed?.(2)}`);
    if (V && i % 30 === 0) r.rows.push(`${t.toFixed(2).padStart(5)}s pos ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)} v ${v.vel.length().toFixed(1)} ${grounded ? 'G' : 'air'}${on ? ' roof' + bs.indexOf(on) : ''} ${v.mode || ''}`);
  }
  // jitter: how far the centre wanders over the last second
  const tail = hist.slice(-120);
  if (tail.length) r.rest = Math.max(...[0, 1, 2].map(k => Math.max(...tail.map(q => q[k])) - Math.min(...tail.map(q => q[k]))));
  r.end = v.pos.clone(); r.endOn = (() => { for (const b of bs) if (inPoly(b.pts, v.pos.x, v.pos.z) && v.pos.y > drawnTop(b, v.pos.x, v.pos.z) - 0.3) return bs.indexOf(b); return -1; })();
  if (V) console.log(r.rows.join('\n'));
  return r;
}

// ---------------------------------------------------------------- checks
let fails = 0, passes = 0;
const results = [];
function check(name, r, goals) {
  const bad = [];
  if (r.nan) bad.push('NaN');
  if (r.maxJump > 2) bad.push(`teleport ${r.maxJump.toFixed(2)} m in one step (${r.jumpAt})`);
  if (V) console.log(`  biggest step ${r.jumpAt}`);
  if (r.inside) bad.push(`inside a building ${r.inside} steps (up to ${r.insideDepth.toFixed(2)} m under its roof)`);
  for (const [ok, msg] of goals) if (!ok) bad.push(msg);
  const line = `${bad.length ? 'FAIL' : 'ok  '} ${name.padEnd(34)} roof contacts ${String(r.roofContacts).padStart(5)} worst ${r.roofContacts ? (r.roofErr * 100).toFixed(1).padStart(5) + ' cm' : '   — '}` +
    `  jump ${r.maxJump.toFixed(2)} m  rest-wander ${Number.isFinite(r.rest) ? (r.rest * 100).toFixed(1) : '—'} cm  end ${r.endOn >= 0 ? 'on roof ' + r.endOn : 'off roofs'}` +
    (bad.length ? '\n       ' + bad.join('; ') : '');
  console.log(line);
  results.push({ name, ok: !bad.length, bad });
  if (bad.length) fails++; else passes++;
}
const restsOn = (r, i = 0) => [
  [r.endOn === i, `does not end on roof ${i} (end ${r.end.x.toFixed(1)} ${r.end.y.toFixed(2)} ${r.end.z.toFixed(1)})`],
  [r.roofContacts > 50, `too few roof contacts (${r.roofContacts}): never really landed`],
  [r.roofErr < 0.05, `rests ${(r.roofErr * 100).toFixed(1)} cm off the drawn roof`],
  [r.rest < 0.05, `jitters: centre wanders ${(r.rest * 100).toFixed(1)} cm in the last second`],
];
const roofOf = (b, x, z) => drawnTop(b, x, z);

console.log(`roof test (${path.relative(process.cwd(), SRC) || SRC}): flat downtown #${flatTown.pts.length}pt @${centroid(flatTown.pts).map(Math.round)}, ` +
  `gable house @${centroid(gableHouse.pts).map(Math.round)} ${planOf(gableHouse).parts[0].roof.pitch.toFixed(0)}°, hip house @${centroid(hipHouse.pts).map(Math.round)}, ` +
  `steep @${centroid(steep.pts).map(Math.round)} ${planOf(steep).parts[0].roof.pitch.toFixed(0)}°`);

// (1) flat downtown roof (planned commercial, parapet), (3) campus Gym (flat + parapet + rooftop units)
for (const [label, b, kinds] of [['downtown flat', flatTown, ['car', 'bike', 'jet', 'prop', 'heli']], ['campus Gym', gym, ['car', 'bike', 'jet', 'heli']]]) {
  for (const kind of kinds) {
    const name = `${label} drop: ${kind}`; if (!want(name)) continue;
    // aircraft without the speed to fly: just above their gear (a jet stalls and noses in from higher up)
    const [x, z] = b === gym ? [-510.5, 172] : centroid(b.pts), top = roofOf(b, x, z), v = make(kind);
    drop(v, kind, x, z, 0.3, top + (kind === 'heli' ? 6 : AIR.has(kind) ? v.air.gearH + 0.3 : 3), kind === 'heli' ? 0 : AIR.has(kind) ? 1 : 2);
    const r = run(v, kind, kind === 'heli' ? 10 : 6, [b], (t, i) => { if (kind === 'heli') i.jet.thr = -0.6; });
    check(name, r, [...restsOn(r), [!r.crashed, 'crashed']]);
  }
}
// (2) pitched town roofs and (3) campus pitched roofs: land, then ride the slope; never float or sink
for (const [label, b, part] of [['town gable house', gableHouse, planOf(gableHouse).parts[0]], ['town hip house', hipHouse, planOf(hipHouse).parts[0]],
  ['campus barn gable', barn, barn.roofBuilding.parts[0]], ['campus Heron hip', heron, heron.roofBuilding.parts[0]]]) {
  for (const kind of ['car', 'bike', 'heli']) {
    const name = `${label}: ${kind}`; if (!want(name)) continue;
    const s = onSlope(part), top = roofOf(b, s.x, s.z), v = make(kind);
    drop(v, kind, s.x, s.z, s.yaw, top + (kind === 'heli' ? 5 : 2), kind === 'heli' ? 0 : 1);
    const r = run(v, kind, 6, near(s.x, s.z, 30), (t, i) => { if (kind === 'heli') i.jet.thr = -0.35; });
    check(name, r, [[r.roofContacts > 20 || kind === 'heli', `never rode the roof (${r.roofContacts} contacts)`], [!r.crashed || kind === 'heli', 'crashed'],
      [r.roofErr < 0.05, `rides ${(r.roofErr * 100).toFixed(1)} cm off the drawn roof`]]);
  }
}
// the steepest roof here, pointing down it, no brakes: rolls / slides down and off the eave, lands below
for (const kind of ['car', 'bike']) {
  const name = `steep roof slides off: ${kind}`;
  if (!want(name)) continue;
  const part = planOf(steep).parts[0], s = onSlope(part), top = roofOf(steep, s.x, s.z), v = make(kind);
  drop(v, kind, s.x, s.z, s.down, top + 1.2, 0.5);
  const r = run(v, kind, 7, near(s.x, s.z, 30));
  check(name, r, [[r.roofContacts > 20, 'never touched the roof'], [r.endOn < 0, 'still on the roof after 7 s'], [r.roofErr < 0.05, `${(r.roofErr * 100).toFixed(1)} cm off the drawn roof`],
    [r.minY < top - 2, 'never came down']]);
}
// campus Main Building: tower over a lower roof is a wall from the roof; a car dropped next to the tower stays out
{
  const name = 'campus Main roof by the tower: car';
  if (want(name)) {
    const parts = main.roofBuilding.parts, centre = parts.find(p => p.name === 'centre'), tower = parts.find(p => p.name === 'tower');
    const tc = tower.rect.c, cc = centroid(partPts(centre)), dx = cc[0] - tc[0], dz = cc[1] - tc[1], L = Math.hypot(dx, dz);
    // on the centre roof, 7 m from the tower centre, driving at the tower
    let x = tc[0] + dx / L * 7, z = tc[1] + dz / L * 7;
    if (!inPoly(partPts(centre), x, z) || inPoly(partPts(tower), x, z)) { x = cc[0]; z = cc[1]; }
    const top = roofOf(main, x, z), v = make('car');
    drop(v, 'car', x, z, Math.atan2(-dx, -dz), top + 1.5, 1);
    const r = run(v, 'car', 5, [main], (t, i) => { i.throttle = t > 1.5 ? 0.4 : 0; });
    const towerTop = main.roofBuilding.floor + tower.h;
    check(name, r, [[r.roofContacts > 50, 'never on the roof'], [r.roofErr < 0.05, `${(r.roofErr * 100).toFixed(1)} cm off the drawn roof`],
      [!inPoly(partPts(tower), r.end.x, r.end.z) || r.end.y > towerTop, 'drove into the tower']]);
  }
}
// Gym rooftop unit: a wall from the roof (drive at it, stay out of it)
{
  const name = 'campus Gym rooftop unit: car';
  if (want(name)) {
    const box = gym.roofBuilding.parts[0].boxes[0], v = make('car'), x = box.c[0], z = box.c[1] + 9, top = roofOf(gym, x, z);
    drop(v, 'car', x, z, Math.PI, top + 1, 0.5);
    let into = 0;
    const bp = partPts({ rect: box });
    const r = run(v, 'car', 5, [gym], (t, i, c) => { i.throttle = t > 1 ? 0.5 : 0; if (inPoly(bp, c.pos.x, c.pos.z) && c.pos.y < gym.roofBuilding.floor + box.y1) into++; });
    check(name, r, [[!into, `inside the rooftop unit ${into} steps`], [r.endOn === 0, 'left the roof'], [r.roofErr < 0.05, `${(r.roofErr * 100).toFixed(1)} cm off the drawn roof`]]);
  }
}
// (4) roof edge: centre 0.4 m inside the edge (rests or tips off cleanly) and 0.8 m outside (falls off cleanly)
for (const kind of ['car', 'bike', 'heli', 'jet']) {
  for (const off of [0.4, -0.8]) {
    const name = `Gym edge ${off > 0 ? 'inside' : 'outside'} ${Math.abs(off)} m: ${kind}`; if (!want(name)) continue;
    // the Gym's south wall (z max), facing along it
    const zEdge = Math.max(...gym.pts.map(p => p[1])), x = -510.5, z = zEdge - off - (kind === 'jet' ? 0 : 0), v = make(kind);
    const top = roofOf(gym, x, Math.min(z, zEdge - 0.5));
    drop(v, kind, x, z, Math.PI / 2, top + (kind === 'heli' ? 4 : kind === 'jet' ? v.air.gearH + 0.3 : 2.5), kind === 'heli' ? 0 : 1.5);
    const r = run(v, kind, 6, [gym], (t, i) => { if (kind === 'heli') i.jet.thr = -0.35; });
    const goals = [[r.endOn === 0 ? r.roofErr < 0.05 : r.end.y < top - 2, r.endOn === 0 ? `rests ${(r.roofErr * 100).toFixed(1)} cm off the roof` : `hangs at the edge (y ${r.end.y.toFixed(2)}, roof ${top.toFixed(2)})`]];
    if (off < 0 && kind !== 'heli') goals.push([r.endOn < 0, 'stood on air past the edge']);
    // a jet whose wing is over the roof as it drops past the edge strikes it: a crash is fair there, not on the roof
    if (kind !== 'jet' || off > 0) goals.push([!r.crashed, 'crashed']);
    check(name, r, goals);
  }
}
// (5) roof to roof: a flat roof, a gap of 2.5–7 m, a lower flat roof
const J = findJump();
if (J) console.log(`jump: gap ${J.gap.toFixed(1)} m, drop ${J.drop.toFixed(2)} m from ${J.x.toFixed(2)}, ${J.z.toFixed(2)} yaw ${J.yaw.toFixed(4)}`);
// Parapets are solid like walls, so a car can't drive off a flat roof: the hop starts in the air 4 m before roof A's
// edge, 2.5 m up at 79 km/h (clear of A's parapet), crosses the gap and lands on B
for (const kind of ['car', 'bike']) {
  const name = `roof-to-roof hop over the parapet: ${kind}`; if (!want(name) || !J) continue;
  const v = make(kind), x = J.x + Math.sin(J.yaw) * 10, z = J.z + Math.cos(J.yaw) * 10, top = roofOf(J.a, x, z);
  drop(v, kind, x, z, J.yaw, top + 2.5, 0, 22);
  const r = run(v, kind, 4, [J.a, J.b], (t, i, c) => { i.brake = t > 0.8 && c.vel.length() > 2 ? 1 : 0; });
  check(name, r, [[r.onRoof[1] > 20, 'never landed on the next roof'], [r.roofErr < 0.05, `${(r.roofErr * 100).toFixed(1)} cm off the drawn roof`]]);
}
// (6) driving at a roof's edge: the parapet (as drawn: 0.9 m downtown commercial, 0.45 m on Third Street) stops the
// vehicle, slow or fast: never through it, never launched up it (no more than 0.3 m above its resting height)
const parapetRoofs = [['0.9 m parapet', flatTown, ...centroid(flatTown.pts)]];
if (J) parapetRoofs.push(['0.45 m parapet', J.a, J.x + Math.sin(J.yaw) * 6, J.z + Math.cos(J.yaw) * 6]);
for (const [label, b, x, z] of parapetRoofs) for (const kind of ['car', 'bike', 'jet']) for (const kmh of kind === 'jet' ? [20] : kind === 'car' ? [10, 70, 150] : [10, 70]) {
  const name = `${label}, drive at it at ${kmh} km/h: ${kind}`; if (!want(name)) continue;
  const top = roofOf(b, x, z), v = make(kind);
  // the nearest edge direction (or, for the hop roof, straight at the gap)
  let best = null;
  if (b === J?.a) best = [J.yaw, 0];
  else for (let k = 0; k < 16; k++) { const a = k * Math.PI / 8; let s = 0; while (inPoly(b.pts, x + Math.sin(a) * s, z + Math.cos(a) * s)) s += 0.25; if (!best || s < best[1]) best = [a, s]; }
  drop(v, kind, x, z, best[0], top + (kind === 'jet' ? v.air.gearH + 0.05 : 0.8), 0, kmh / 3.6);
  if (kind === 'jet') { v.mode = 'ground'; v.v = kmh / 3.6; }
  let rest = Infinity, rise = -Infinity, out = 0, closest = Infinity;
  const r = run(v, kind, 5, [b], (t, i, c) => {
    if (kind !== 'jet') i.throttle = c.vel.length() < kmh / 3.6 ? 0.6 : 0;
    const above = c.pos.y - top;
    if (t > 0.5 && c.grounded) rest = Math.min(rest, above);
    if (t > 0.5) rise = Math.max(rise, above);
    if (!inPoly(b.pts, c.pos.x, c.pos.z)) out++;
    closest = Math.min(closest, edgeDist(b.pts, c.pos.x, c.pos.z));
  });
  // it got there: the centre within its nose length (+ a little) of the parapet
  const reach = (v.half?.front ?? 2.2) + 0.5;
  check(name, r, [[closest < reach, `never reached the parapet (closest ${closest.toFixed(2)} m)`], [r.endOn === 0, 'left the roof'], [!out, `centre past the parapet ${out} steps`], [!r.crashed, 'crashed'],
    [rise - rest < 0.3, `launched: ${(rise - rest).toFixed(2)} m above its resting height`], [r.roofErr < 0.05, `${(r.roofErr * 100).toFixed(1)} cm off the drawn roof`]]);
}
// jets on the Space Museum's big flat roof: a low pass (stays flying) and landings on the gear
{
  const pts = museum.pts, zl = -10386, x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0])), top = roofOf(museum, x0 + 60, zl);
  if (want('museum low pass: jet')) {     // from the east (the tall Aviation Building is on the west side)
    const v = make('jet'); drop(v, 'jet', x1 + 250, zl, -Math.PI / 2, top + 6, 0, 330 / 3.6); v.gear = 0; v.throttle = 0.5;
    const r = run(v, 'jet', 4, [museum]);
    check('museum low pass: jet', r, [[!r.crashed, 'crashed'], [v.mode === 'air', 'not flying'], [!r.landed, 'touched the roof'], [r.minY > top + 2, `sank to ${(r.minY - top).toFixed(1)} m over the roof`]]);
  }
  for (const [kind, kmh] of [['jet', 250], ['prop', 90]]) {
    const name = `museum gear landing: ${kind}`; if (!want(name)) continue;
    const v = make(kind); drop(v, kind, x0 + 4, zl, Math.PI / 2, top + v.air.gearH + 0.8, 1.2, kmh / 3.6);
    const r = run(v, kind, 8, [museum], (t, i) => { i.handbrake = v.mode === 'ground'; i.jet.pitch = v.mode === 'air' ? 0.15 : 0; });
    // a gentle gear touchdown is not a crash (the fighter can't stop in 164 m: it may hit the far parapet later)
    check(name, r, [[r.landed, 'never landed on the roof'], [r.roofErr < 0.05, `gear ${(r.roofErr * 100).toFixed(1)} cm off the drawn roof`],
      [!r.crashed || r.crashAt > r.landedAt + 1.5, `crashed ${(r.crashAt - (r.landedAt ?? 0)).toFixed(2)} s after touching down: ${r.crashMsg}`],
      [kind !== 'prop' || r.endOn === 0, 'prop plane did not stop on the roof']]);
  }
  // flown at 300 km/h into the roof's east edge, the gear 0.5 m (and 2 m) below its top: a crash, as into the ground
  for (const below of [0.5, 2]) {
    const name = `museum fast low pass into the roof edge, gear ${below} m below the top: jet`; if (!want(name)) continue;
    const v = make('jet'); drop(v, 'jet', x1 + 120, zl, -Math.PI / 2, top + v.air.gearH - below, 0, 300 / 3.6); v.throttle = 0.5;
    const r = run(v, 'jet', 3, [museum]);
    check(name, r, [[r.crashed && r.crashAt < 2, `no crash (${r.crashMsg ?? 'flew on'})`], [!(r.landed && r.landedAt < (r.crashAt ?? Infinity)), 'landed on the edge it flew into']]);
  }
}
// Hotel / Third Street landmark row and the downtown roof with a helicopter: lands, sits, lifts off again
{
  const name = 'downtown heli land + lift off'; if (want(name)) {
    const [x, z] = centroid(flatTown.pts), top = roofOf(flatTown, x, z), v = make('heli');
    drop(v, 'heli', x, z, 0, top + 6, 0);
    const r = run(v, 'heli', 11, [flatTown], (t, i) => { i.jet.thr = t < 7 ? -0.6 : 1; });
    check(name, r, [[r.landed, 'never landed'], [v.mode === 'air' && v.pos.y > top + 5, 'did not lift off again'], [!r.crashed, 'crashed']]);
  }
}
// switching vehicle on a roof (vehicles.js switchTo: the next vehicle starts from this one's height) keeps you on it;
// driving around a roof leaves no respawn spot there (R would put you inside the building)
{
  const name = 'switch car → bike → heli on the Gym roof; no safe spots on roofs';
  if (want(name)) {
    const [x, z] = [-510.5, 172], top = roofOf(gym, x, z), car = make('car');
    drop(car, 'car', x, z, 0, top + 1, 0.5);
    const r = run(car, 'car', 6, [gym], (t, i) => { i.throttle = t > 1 && t < 2.2 ? 0.5 : 0; i.brake = t > 2.2 && car.vel.length() > 1 ? 1 : 0; i.steer = 0.3; });
    const goals = [[r.endOn === 0, 'car left the roof'], [!car.safe.length, `${car.safe.length} safe spots remembered on the roof`]];
    let from = car;
    for (const kind of ['bike', 'heli']) {
      const next = make(kind);
      next.pos.copy(from.pos); next.vel.set(0, 0, 0); next.reset(from.pos.x, from.pos.z, 0);
      const rr = run(next, kind, 2, [gym]);
      goals.push([rr.endOn === 0 && Math.abs(next.pos.y - from.pos.y) < 2, `${kind} not on the roof after the switch (y ${next.pos.y.toFixed(2)})`], [rr.maxJump <= 2, `${kind} jumped ${rr.maxJump.toFixed(2)} m`]);
      from = next;
    }
    check(name, r, goals);
  }
}
console.log(`\n${passes} passed, ${fails} failed`);
if (fails) process.exitCode = 1;
