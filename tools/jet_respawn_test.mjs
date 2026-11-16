// Jet / helicopter crash respawns and R resets onto ground that has to stream in first (respawnhold.js).
//   node tools/jet_respawn_test.mjs             Node: a streaming stand-in world (tiles load ~1.5 s after they're wanted
//                                               and drop beyond 2.6 km, heightAt 0 where unloaded, like world.js/data.js)
//   node tools/jet_respawn_test.mjs --browser   also the real game (server at YR_URL, default http://127.0.0.1:8173/)
// Node: the frame loop of main.js in miniature (hold.update, 120 Hz steps unless held, camera = vehicle, streaming).
// Every respawn must end on loaded ground at the chosen spot, at the right height, in ground mode (or in the air for a
// race's air respawn), and stay there for 3 s: no pull-back to the crash site, no second crash, never under the
// ground. Cases: near (already loaded: placed at once, as before), 5 km back (tiles dropped), at the map edge, no safe
// spot (map spawn), a race air respawn, the helicopter, car + bike R, and 30 seeded crashes all over the map. The
// same far case without the hold is run too and must show the old bug (so the test can see it).
// Slow / failing loads: the spot's tile takes 40 s (longer than the hold's 30 s timeout): physics stays paused and it
// is placed there once loaded, never on unloaded ground; a spot whose tile never loads falls back after the timeout to
// a loaded safe spot. Vehicle switches during a hold (the real vehicles.js: V car → jet, V jet → bike, a Garage type
// change jet → helicopter during a race air respawn) hand the hold to the new vehicle, placed the same way.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRespawnHold } from '../game/src/respawnhold.js';
import { Jet, JET } from '../game/src/jet.js';
import { Heli } from '../game/src/heli.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { Bike, BIKE } from '../game/src/bike.js';
import { createVehicles } from '../game/src/vehicles.js';

const T = 2000, LOAD_R = 1300, DROP_R = 2600, DT = 1 / 60;
const TILES = []; for (let tx = -3; tx <= 3; tx++) for (let tz = -2; tz <= 2; tz++) TILES.push([tx, tz]);
const terrain = (x, z) => 60 + 25 * Math.sin(x / 700) + 18 * Math.cos(z / 530);
const tileIndex = (x, z) => [Math.round(x / T), Math.round(z / T)];
const key = (tx, tz) => `${tx},${tz}`;
const available = new Set(TILES.map(([a, b]) => key(a, b)));

// slow: { 'tx,tz': frames } tiles that take longer to load; broken: tiles that never load
function makeWorld({ delayFrames = 90, slow = {}, broken = new Set() } = {}) {
  const loaded = new Set(), wantedAt = new Map();
  const at = (x, z) => loaded.has(key(...tileIndex(x, z)));
  const h = (x, z) => at(x, z) ? terrain(x, z) : 0;
  const world = {
    W: { tile: T, tiles: TILES }, extent: [-3.5 * T, -2.5 * T, 3.5 * T, 2.5 * T], spawn: [0, 0], tiles: loaded,
    loadedAt: at, tileIndex, key,
    mapContains(x, z, m = 0) { for (const dx of [-m, m]) for (const dz of [-m, m]) if (!available.has(key(...tileIndex(x + dx, z + dz)))) return false; return true; },
    heightAt: h, terrainAt: h, groundAt: h, rampAt: () => 0, surfaceAt: () => 0, waterLevelAt: () => -Infinity,
    normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0), treesNear() {}, buildingsNear: () => [],
    frame: 0,
    // world.js update(): tiles within LOAD_R of the focus load (here: after delayFrames), beyond DROP_R they drop
    stream(fx, fz) {
      this.frame++;
      for (const [tx, tz] of TILES) {
        const k = key(tx, tz), dx = Math.max(tx * T - T / 2 - fx, 0, fx - tx * T - T / 2), dz = Math.max(tz * T - T / 2 - fz, 0, fz - tz * T - T / 2), d = Math.hypot(dx, dz);
        if (d > DROP_R) { loaded.delete(k); wantedAt.delete(k); continue; }
        if (d < LOAD_R && !loaded.has(k) && !broken.has(k)) { if (!wantedAt.has(k)) wantedAt.set(k, this.frame); if (this.frame - wantedAt.get(k) >= (slow[k] ?? delayFrames)) loaded.add(k); }
      }
    },
    loadAround(x, z) { for (let i = 0; i <= delayFrames + 1; i++) this.stream(x, z); },
    pendingTiles: () => [...wantedAt.keys()].filter(k => !loaded.has(k)).length,
  };
  return world;
}
const idle = { throttle: 0, brake: 0, steer: 0, handbrake: false, jet: { thr: 0, pitch: 0, roll: 0, yaw: 0 } };
const rand = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(12345);

// one main.js frame: hold, physics unless held, interpolation, camera = vehicle, streaming. v: a vehicle or a getter
// for the one you're in (vehicles.current)
function frame(vehicle, world, hold) {
  hold?.update(DT);
  const v = typeof vehicle === 'function' ? vehicle() : vehicle;
  if (!hold?.blocked) for (let i = 0; i < 2; i++) { v.savePrev(); v.step(1 / 120, idle); if (hold?.blocked) break; }
  v.interpolate(1); world.stream(v.renderPos.x, v.renderPos.z);
}
const clearance = v => v.pos.y - terrain(v.pos.x, v.pos.z);
const HEIGHT = { jet: [1.0, 2.4], heli: [0, 3], car: [0, 1.6], bike: [0, 1.6] };
const kindOf = v => v instanceof Heli ? 'heli' : v.kind;

// Run until the respawn is placed, then 3 s more. spot: where the respawn must end (x, z). Returns a summary.
// heldAt: where it waits (default: the spot); onFrame(frame number, held) runs each frame (switches)
function followRespawn(vehicle, world, hold, spot, { air = false, start = () => {}, label, heldAt = spot, onFrame = () => {} }) {
  const cur = typeof vehicle === 'function' ? vehicle : () => vehicle;
  start();
  let frames = 0, heldFrames = 0, placedAt = null, worstJump = 0, lowest = Infinity, crashes = 0, last = cur().pos.clone(), v = cur();
  const limit = 60 * 60;
  while (frames++ < limit) {
    onFrame(frames, !!hold?.blocked);                       // (a switch here is seen by the next hold.update)
    const wasCrashed = cur().mode === 'crashed';
    frame(cur, world, hold); v = cur();
    if (hold?.blocked) {
      heldFrames++;
      assert(hold.holding.vehicle === v, `${label}: the hold is on the vehicle you're in (${v.kind})`);
      assert(Math.hypot(v.pos.x - heldAt[0], v.pos.z - heldAt[1]) < 1, `${label}: held at the spot`); last.copy(v.pos); continue;
    }
    if (v.mode === 'crashed') { last.copy(v.pos); if (placedAt !== null) crashes++; continue; }
    if (placedAt === null) {
      placedAt = frames;
      assert(world.loadedAt(v.pos.x, v.pos.z), `${label}: placed on loaded ground`);
      assert(Math.hypot(v.pos.x - spot[0], v.pos.z - spot[1]) < (air ? 6 : 2), `${label}: placed at the spot (${Math.hypot(v.pos.x - spot[0], v.pos.z - spot[1]).toFixed(1)} m off)`);
      if (air) { const up = kindOf(v) === 'heli' ? 30 : 40;     // placeInAir's floor: jet 40 m, helicopter 30 m
        assert(v.mode === 'air' && clearance(v) >= up - 1, `${label}: an air respawn flies ≥ ${up} m up (${v.mode}, ${clearance(v).toFixed(1)} m)`); }
      else { const [lo, hi] = HEIGHT[kindOf(v)]; assert(clearance(v) > lo - 0.01 && clearance(v) < hi, `${label}: on the ground (${clearance(v).toFixed(2)} m)`); }
      last.copy(v.pos); continue;
    }
    worstJump = Math.max(worstJump, v.pos.distanceTo(last)); last.copy(v.pos);
    lowest = Math.min(lowest, clearance(v));
    if (wasCrashed !== (v.mode === 'crashed')) crashes++;
    if (frames - placedAt > 180) break;
  }
  assert(placedAt !== null, `${label}: respawned within 60 s`);
  assert(worstJump < 3, `${label}: no jump after placing (worst ${worstJump.toFixed(1)} m/frame)`);
  assert(crashes === 0 && v.mode !== 'crashed', `${label}: no second crash`);
  if (!air) assert(lowest > -0.3, `${label}: never under the ground (${lowest.toFixed(2)} m)`);
  return { label, held: +(heldFrames * DT).toFixed(2), placed: +(placedAt * DT).toFixed(2), worstJump: +worstJump.toFixed(2), lowest: +lowest.toFixed(2) };
}
function crashAt(v, world, x, z, yaw = 0, kmh = 900) {
  world.loadAround(x, z);
  v.placeInAir(x, terrain(x, z) + 150, z, yaw, kmh); v._lastLoaded = [x, z];
  for (let i = 0; i < 30; i++) frame(v, world, null);       // flying, streaming follows
  v.crash('impact');
}
const rows = [];
function setup(Ctor, tuning) { const world = makeWorld(), v = new Ctor(world, tuning); const hold = createRespawnHold({ world, vehicles: [v] }); return { world, v, hold }; }

// 0) the bug, without the hold: a crash 5 km from the safe spot
{
  const world = makeWorld(), v = new Jet(world, { ...JET }), spot = [-5000, 0];
  world.loadAround(...spot); v.reset(...spot, 0); v.safe = [[...spot, 0]];
  crashAt(v, world, 0, 0, Math.PI / 2);
  let f = 0; while (v.mode === 'crashed' && f++ < 600) frame(v, world, null);
  const placed = { off: Math.hypot(v.pos.x - spot[0], v.pos.z - spot[1]), clear: clearance(v), loaded: world.loadedAt(v.pos.x, v.pos.z) };
  for (let i = 0; i < 4; i++) frame(v, world, null);
  const after = Math.hypot(v.pos.x - spot[0], v.pos.z - spot[1]);
  const bug = !placed.loaded && (placed.clear < -10 || after > 100);
  console.log(`without the hold: placed on ${placed.loaded ? 'loaded' : 'UNLOADED'} ground ${placed.clear.toFixed(0)} m from the real terrain height, ` +
    `then ${after.toFixed(0)} m from the safe spot after 4 frames (pulled back toward the wreck)`);
  assert(bug, 'the old behaviour (no hold) shows the bug in this stand-in world');
}
// 1) near: already loaded, placed at once (no hold)
{
  const { world, v, hold } = setup(Jet, { ...JET }), spot = [300, 200];
  world.loadAround(0, 0); v.reset(...spot, 1); v.safe = [[...spot, 1]];
  const r = followRespawn(v, world, hold, spot, { label: 'jet near', start: () => crashAt(v, world, 0, 0) });
  assert.equal(r.held, 0, 'near: no hold'); rows.push(r);
}
// 2) far: 5 km back, tiles dropped while flying away
for (const [Ctor, name, tuning] of [[Jet, 'jet', { ...JET }], [Heli, 'heli', undefined]]) {
  const { world, v, hold } = setup(Ctor, tuning), spot = [-5000, 0];
  world.loadAround(...spot); v.reset(...spot, 0); v.safe = [[...spot, 0]];
  const r = followRespawn(v, world, hold, spot, { label: `${name} 5 km back`, start: () => crashAt(v, world, 0, 0, Math.PI / 2, name === 'heli' ? 150 : 900) });
  assert(r.held > 0.5, `${name} far: held while the ground loaded`); rows.push(r);
}
// 3) map edge: the safe spot 25 m inside the map's east edge
{
  const { world, v, hold } = setup(Jet, { ...JET }), spot = [3.5 * T - 25, 600];
  world.loadAround(...spot); v.reset(...spot, -Math.PI / 2); v.safe = [[...spot, -Math.PI / 2]];
  rows.push(followRespawn(v, world, hold, spot, { label: 'jet at the map edge', start: () => crashAt(v, world, -2000, 0, -Math.PI / 2) }));
}
// 4) no safe spot: back to the map's spawn point (far away)
{
  const { world, v, hold } = setup(Jet, { ...JET });
  v.safe = [];
  rows.push(followRespawn(v, world, hold, [0, 0], { label: 'jet, no safe spot (map spawn)', start: () => crashAt(v, world, 5500, 3000, 0) }));
}
// 5) race air respawn (the last ring) far away
{
  const { world, v, hold } = setup(Jet, { ...JET }), ring = [-4500, -3000];
  v.respawn = () => [ring[0], 30, ring[1], 0.5, 450];        // a low ring: placeInAir keeps ≥ 40 m above the ground
  const r = followRespawn(v, world, hold, ring, { air: true, label: 'jet race air respawn', start: () => crashAt(v, world, 3000, 2000, 0) });
  rows.push(r);
}
// 6) R in the car and on the bike to a far safe spot
for (const [Ctor, name, tuning] of [[Car, 'car', { ...TUNING_DEFAULTS }], [Bike, 'bike', { ...BIKE }]]) {
  const { world, v, hold } = setup(Ctor, tuning), spot = [4800, -1500];
  world.loadAround(0, 0); v.reset(0, 0, 0); for (let i = 0; i < 30; i++) frame(v, world, hold);
  v.safe = [[...spot, 2]];
  rows.push(followRespawn(v, world, hold, spot, { label: `${name} R 5 km`, start: () => v.resetToSafe() }));
}
// 7) 30 seeded crashes all over the map, safe spots 0.2–9 km from the crash
{
  const { world, v, hold } = setup(Jet, { ...JET });
  let held = 0;
  for (let i = 0; i < 30; i++) {
    const px = (rand() - 0.5) * 6.6 * T, pz = (rand() - 0.5) * 4.6 * T, cx = (rand() - 0.5) * 6.6 * T, cz = (rand() - 0.5) * 4.6 * T;
    v.safe = [[px, pz, rand() * 6]];
    const r = followRespawn(v, world, hold, [px, pz], { label: `seeded #${i + 1}`, start: () => crashAt(v, world, cx, cz, rand() * 6, 300 + rand() * 1200) });
    if (r.held) held++;
  }
  rows.push({ label: '30 seeded crashes', held: `${held} held`, placed: 'all', worstJump: '<3', lowest: '>-0.3' });
}
// 8) the spot's tile takes 40 s, longer than the 30 s timeout; the crash site is 5 km away (dropped): no loaded
//    fallback, so physics stays paused past the timeout and it is placed at the spot once that has loaded
{
  const spot = [-4000, 0], world = makeWorld({ slow: { [key(-2, 0)]: 40 * 60 } }), v = new Jet(world, { ...JET });
  const hold = createRespawnHold({ world, vehicles: [v] });
  v.safe = [[...spot, 0]];
  const r = followRespawn(v, world, hold, spot, { label: 'spot loads after 40 s (> timeout)', start: () => crashAt(v, world, 1000, 0, Math.PI / 2) });
  assert(r.held > 38, `held past the timeout until the spot loaded (${r.held} s)`); rows.push(r);
}
// 9) the spot's tile never loads: after the timeout, the newest loaded safe spot (1.5 km away, in a tile that streams in
//    around the held spot) — never the unloaded spot
{
  const spot = [-4000, 0], fall = [-2500, 0], world = makeWorld({ broken: new Set([key(-2, 0)]) }), v = new Car(world, { ...TUNING_DEFAULTS });
  const hold = createRespawnHold({ world, vehicles: [v] });
  world.loadAround(3000, 0); v.reset(3000, 0, 0); for (let i = 0; i < 10; i++) frame(v, world, hold);
  v.safe = [[...spot, 0], [...fall, 1]];          // R takes safe[0] (fewer than 40 spots): the broken one
  const r = followRespawn(v, world, hold, fall, { heldAt: spot, label: 'spot never loads: loaded fallback after the timeout', start: () => v.resetToSafe() });
  assert(r.held > 29.9, `waited the timeout first (${r.held} s)`); rows.push(r);
}
// 10) switching vehicles during a hold (the real vehicles.js): the hold moves to the vehicle you're in now
{
  const run = (label, { kind = 'car', air = false, crash = air, switchAt = 20, doSwitch, expectKind, expectAir = false }) => {
    const world = makeWorld(), vehicles = createVehicles({ scene: new THREE.Scene(), world, tuning: { ...TUNING_DEFAULTS } });
    const hold = createRespawnHold({ world, vehicles: [vehicles.car, vehicles.bike, ...vehicles.aircraft], current: () => vehicles.current });
    const spot = [-4500, 600];
    world.loadAround(1500, 0); vehicles.switchTo(kind); const v = vehicles.current; v.reset(1500, 0, 0);
    let start;
    if (air) { v.respawn = () => [spot[0], 30, spot[1], 0.5, 450]; start = () => crashAt(v, world, 1500, 0, 0); }
    else { v.safe = [[...spot, 1]]; start = crash ? () => crashAt(v, world, 1500, 0, 0) : () => v.resetToSafe(); }
    let switched = false;
    const r = followRespawn(() => vehicles.current, world, hold, spot, { air: expectAir, label, start,
      onFrame: (f, held) => { if (held && !switched && (f > switchAt)) { doSwitch(vehicles); switched = true; } } });
    assert(switched, `${label}: switched during the hold`);
    assert.equal(vehicles.current.kind === 'jet' && vehicles.current.mesh.userData.mainRotor ? 'heli' : vehicles.current.kind, expectKind, `${label}: placed the new vehicle`);
    rows.push(r);
  };
  run('V car → jet while held', { kind: 'car', doSwitch: vs => vs.switchTo('jet'), expectKind: 'jet' });
  run('V jet → bike while held (crash respawn)', { kind: 'jet', crash: true, doSwitch: vs => vs.switchTo('bike'), expectKind: 'bike', switchAt: 300 });
  run('Garage jet → helicopter in a race air respawn', { kind: 'jet', air: true, switchAt: 300, doSwitch: vs => vs.setType('jet', 'heli'), expectKind: 'heli', expectAir: true });
}
console.table(rows);

// 11) a race start supersedes a waiting respawn hold (challenges.js placeCar → onPlace → hold.cancel, as main.js wires
//     it): (a) a far R hold is waiting when the race starts; (b) the race start is still loading and a respawn hold
//     begins while the race waits for it. Either way the car ends at the race start, the hold is gone, and it stays put.
{
  const THREE_ = THREE, el = () => ({ style: {}, append() {}, querySelectorAll: () => [], getContext: () => ({ fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, fill() {} }) });
  globalThis.document = { createElement: el, head: el(), body: el() };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.addEventListener = () => {};
  const { createChallenges } = await import('../game/src/challenges.js');
  for (const [label, startAt, holdDuring] of [['race start while a far R hold waits', [600, 300], false], ['respawn hold begins while the race start loads', [-4200, -1800], true]]) {
    const world = makeWorld(), v = new Car(world, { ...TUNING_DEFAULTS });
    let hold = null;
    const race = { id: 'r', name: 'R', start: { x: startAt[0], z: startAt[1], yaw: 0 }, gates: [0, 100, 200].map(z => ({ x: startAt[0], z: startAt[1] + z, yaw: 0, w: 16 })) };
    globalThis.fetch = async url => ({ ok: true, json: async () => url.endsWith('challenges.json') ? [race] : [] });
    const ch = await createChallenges({ scene: new THREE_.Scene(), world, car: v, minimap: { open: false }, onPlace: () => hold.cancel() });
    hold = createRespawnHold({ world, vehicles: [v] });
    world.loadAround(0, 0); v.reset(0, 0, 0); for (let i = 0; i < 10; i++) frame(v, world, hold);
    const far = [4800, 1500];
    if (!holdDuring) { v.safe = [[...far, 0]]; v.resetToSafe(); assert(hold.blocked, `${label}: the R hold is waiting`); }
    let placed = false, triggered = false;
    ch.start(0).then(() => { placed = true; });
    for (let t = 0; !placed && t < 200; t++) {           // ~9 frames per placeCar wait (150 ms)
      for (let i = 0; i < 9; i++) frame(v, world, hold);
      if (holdDuring && !triggered && t === 2) { v.safe = [[...far, 0]]; v.resetToSafe(); triggered = true; assert(hold.blocked, `${label}: a hold began during the race's wait`); }
      await new Promise(r => setTimeout(r, 150));
    }
    assert(placed, `${label}: the race placed the car`);
    assert(!hold.blocked, `${label}: the hold was dropped`);
    for (let i = 0; i < 180; i++) frame(v, world, hold);
    const off = Math.hypot(v.pos.x - startAt[0], v.pos.z - startAt[1]);
    assert(off < 5, `${label}: still at the race start 3 s later (${off.toFixed(0)} m off)`);
    assert(world.loadedAt(v.pos.x, v.pos.z) && !hold.blocked, `${label}: on loaded ground, no hold`);
    rows.push({ label, held: '-', placed: 'race start', worstJump: '-', lowest: '-' });
  }
}
console.table(rows.slice(-2));

// the browser part: the real game, real streaming (needs the dev server)
if (process.argv.includes('--browser')) {
  const puppeteer = (await import('puppeteer-core')).default;
  const { startGame, watchErrors } = await import('./lib/startgame.mjs');
  const { hitchSuite } = await import('./lib/hitchprobe.mjs');
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--window-size=1280,800', '--use-angle=metal', '--enable-gpu'] });
  const errors = [];
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 }); watchErrors(page, 'game', errors);
    await startGame(page, { storage: { 'yr-cosmetics-1': JSON.stringify({ jet: { body: '#000000', custom: ['body'] } }) } });
    page.setDefaultTimeout(0);
    // R near / 5 km out and back, jet crash respawns near / 5 km out and back, three times each
    const report = await page.evaluate(`(${hitchSuite.toString()})(window, { only: ['reset', 'crash'], repeat: 3, settle: 1500 })`);
    console.table(report.rows.map(r => ({ action: r.label, 'worst ms': r.worst, top: r.top, note: r.note }))); report.notes.forEach(n => console.log('note:', n));
    assert.deepEqual(report.fails, [], report.fails.join('\n'));
    assert.deepEqual(errors, [], 'no page errors');
    console.log('PASS browser: R resets and jet crash respawns (near, far, 3 times each) placed on loaded ground at their spot, paint shown on the first frame');
  } finally { await browser.close(); }
} else console.log('browser part not run (add --browser with the dev server running)');
console.log('PASS jet respawn: held until the ground is built, then placed cleanly; near respawns unchanged');
