import assert from 'node:assert/strict';
import { raceLoadPoints, raceGroundProgress, createRaceLoadState } from '../game/src/raceloading.js';

const race = { start: { x: 990, z: 990 }, route: [[990,990],[990,1490],[2490,1490]], gates: [] };
const points = raceLoadPoints(race);
assert(points.some(([x,z]) => x === 1240 && z === 1240), 'neighbour across a start tile corner');
assert(points.some(([x,z]) => x === 1490 && z === 1490), 'first kilometre follows the bend');
assert(!points.some(([x]) => x > 1490), 'does not request the whole far course');
assert.equal(raceGroundProgress({ loadedAt: () => false }, points), 0);
assert.equal(raceGroundProgress({ loadedAt: () => true }, points), 1);
assert.equal(raceGroundProgress({ loadedAt: (x) => x < 0, mapContains: x => x < 0 }, [[-1,0],[1,0]]), 1, 'ignore absent map tiles');
assert.equal(raceGroundProgress({ loadedAt: () => false, mapContains: () => false }, [[1,0]]), 0, 'the start itself is always required');
let clock = 0;
const now = () => clock, ready = { ground: 1, furniture: true, compiled: true };
const load = createRaceLoadState({ now });
assert.equal(load.update({ ground: .5 }).progress, .4);
assert.equal(load.update(ready).phase, 'loading', 'minimum display time');
clock = 800;
assert.equal(load.update({ ...ready, compiled: false }).phase, 'loading', 'wait for shaders');
assert.equal(load.update({ ...ready, furniture: false }).phase, 'loading', 'wait for arches and barriers');
assert.equal(load.update({ ...ready, ground: .99 }).phase, 'loading', 'wait for every required tile');
assert.equal(load.update(ready).phase, 'fading');
clock = 1049; assert.equal(load.update(ready).phase, 'fading');
clock = 1050; assert.equal(load.update(ready).phase, 'done');
clock = 0; const stalled = createRaceLoadState({ now });
clock = 19999; assert.equal(stalled.update().phase, 'loading');
clock = 20000; assert.equal(stalled.update().timedOut, true);
clock = 20250; assert.equal(stalled.update().phase, 'done', 'timeout releases even failed downloads/compiler');
for (const missing of [{ ground: 0 }, { ground: .99 }, { furniture: false }, { compiled: false }]) {
  clock = 0; const stalled = createRaceLoadState({ now });
  clock = 19999; assert.equal(stalled.update({ ...ready, ...missing }).phase, 'loading');
  clock = 20000; assert.equal(stalled.update({ ...ready, ...missing }).phase, 'fading');
  clock = 20250; assert.equal(stalled.update({ ...ready, ...missing }).phase, 'done');
  stalled.cancel(); assert.equal(stalled.update(ready).phase, 'cancelled', 'cancel beats timeout/fade');
}
clock = 0; const frozenRelay = createRaceLoadState({ now, sync: { at: 60000, now: () => 0 } });
clock = 20000; assert.equal(frozenRelay.update(ready).phase, 'fading', 'relay cannot hold loading past deadline');
clock = 20250; assert.equal(frozenRelay.update(ready).phase, 'done');
clock = 0; let relay = 1000;
const sync = { at: 10000, now: () => relay }, mp = createRaceLoadState({ now, sync });
clock = 800; assert.equal(mp.update(ready).phase, 'waiting');
relay = 7000; assert.equal(mp.update(ready).phase, 'fading');
clock = 1050; assert.equal(mp.update(ready).phase, 'done');
assert.equal(sync.at, 10000, 'readiness never moves relay GO');
clock = 0; const late = createRaceLoadState({ now, sync });
clock = 4000; relay = 12000;
assert.equal(late.update(ready).phase, 'fading', 'late player catches up immediately');
clock = 4250; assert.equal(late.update(ready).phase, 'done');
late.cancel(); assert.equal(late.update(ready).phase, 'cancelled');
console.log('PASS race loading: route coverage, map edges, real readiness, shader/furniture gates, minimum, fade, timeout, cancellation, early/late relay clock');

// Exercise the real manager too: the preparation gate owns placement, shader readiness and cancellation.
const THREE = await import('three');
const { Car, TUNING_DEFAULTS } = await import('../game/src/car.js');
const { createRespawnHold } = await import('../game/src/respawnhold.js');
const { buildRaceBarrierModel } = await import('../game/src/racebarriermodel.js');
const { createChallenges } = await import('../game/src/challenges.js');
const element = () => ({ style: {}, append() {}, querySelectorAll: () => [], getContext: () => ({ fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, fill() {} }) });
globalThis.document = { createElement: element, head: element(), body: element() };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.addEventListener = () => {};
const fixture = { id: 'loading', name: 'Loading', start: { x: 0, z: 0, yaw: 0 }, route: [[0,0],[0,100]], gates: [0,100].map(z => ({ x: 0, z, yaw: 0, w: 16 })) };
globalThis.fetch = async url => ({ ok: true, json: async () => url.endsWith('challenges.json') ? [fixture] : [] });
let loaded = false, pinned = [], returnPoint = null, compileStarted = false, finishCompile;
const world = { heightAt: () => 12, terrainAt: () => 12, groundAt: () => 12, surfaceAt: () => 3, waterLevelAt: () => -Infinity,
  normalAt: (_x,_z,n) => n.set(0,1,0), treesNear() {}, buildingsNear: () => [], rampAt: () => null,
  extent: [-1000,-1000,1000,1000], loadedAt: x => x < -500 || loaded, setRaceReturnPoint: p => { returnPoint = p; }, pendingTiles: () => loaded ? 0 : 2, setRaceLoadPoints: points => { pinned = points; } };
const car = new Car(world, { ...TUNING_DEFAULTS });
const hold = createRespawnHold({ world, vehicles: [car], current: () => car });
const ch = await createChallenges({ scene: new THREE.Scene(), world, car, minimap: {}, onPlace: () => hold.cancel(), compileRace: () => {
  compileStarted = true; return new Promise(resolve => { finishCompile = resolve; });
} });
const start = ch.start(0);
assert.equal(ch.blocked, true); assert(pinned.length > 0);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
await sleep(70); assert.equal(compileStarted, false, 'no compile before course readiness');
loaded = true;
await sleep(70); assert.equal(compileStarted, true); assert.equal(ch.state, 'placing');
finishCompile(); await start;
assert.equal(ch.blocked, false); assert.equal(ch.state, 'countdown'); assert.equal(car.pos.y > 12, true); assert.equal(pinned.length, 0);
ch.quit(); loaded = false;
car.reset(-800, 0, .4);
const departure = car.pos.clone();
const cancelled = ch.start(0);
assert.equal(returnPoint.x, -800, 'retain departure ground while destination streams');
hold.request(car); assert(hold.blocked, 'reproduce a respawn requested while loading');
ch.quit();
assert(!hold.blocked && !ch.blocked, 'cancel releases both holds');
assert(car.pos.equals(departure), 'cancel returns to departure');
assert(world.loadedAt(car.pos.x, car.pos.z), 'cancel returns onto loaded ground');
assert.equal(returnPoint, null, 'cancel releases departure pin');
for (let i = 0; i < 120; i++) {
  hold.update(1 / 120);
  if (!hold.blocked && !ch.blocked) car.step(1 / 120, { throttle: 1, brake: 0, steer: 0, handbrake: false });
}
assert(car.pos.distanceTo(departure) > 1 && world.loadedAt(car.pos.x, car.pos.z), 'can drive on loaded ground after cancellation');
car.pos.set(123,40,456);
await cancelled;
assert.equal(ch.state, 'idle'); assert.equal(car.pos.x, 123); assert.equal(pinned.length, 0, 'cancel clears pinned tiles and stale placement');
console.log('PASS race manager: blocks physics, requests course, waits for compile, resets on real ground, cancellation cleanup');

// A barrier may straddle the preparation radius or an absent manifest tile. Only loadable segments block readiness,
// and both endpoints are requested (the midpoint alone is not enough for a long segment across a tile boundary).
const segments = [{ ax: -200, az: 0, bx: 200, bz: 0 }, { ax: 0, az: 0, bx: 1, bz: 0, absent: true }];
const model = buildRaceBarrierModel({ segments, prepare: () => false, canLoad: s => !s.absent });
assert.deepEqual(model.loadPoints([[0, 0]]), [[-200, 0], [200, 0]]);
assert.equal(model.readyNear([[0, 0]]), false);
assert.equal(model.readyNear([[1000, 0]]), true);
model.dispose();
const absent = buildRaceBarrierModel({ segments: [segments[1]], prepare: () => false, canLoad: () => false });
assert.equal(absent.readyNear([[0, 0]]), true, 'absent manifest tile never blocks furniture readiness');
absent.dispose();

// Exercise the real async manager deadline without waiting 20 wall-clock seconds for each failure.
const realPerformance = globalThis.performance;
globalThis.performance = { now: () => clock };
try {
  for (const failure of ['compiler', 'neighbour', 'furniture', 'start']) {
    ch.quit(); loaded = failure !== 'start'; car.reset(-800, 0, .4);
    const home = car.pos.clone(); clock = 0;
    world.loadedAt = (x, z) => x < -500 || (loaded && !(failure === 'furniture' && z === 100));
    world.raceLoadProgress = () => failure === 'neighbour' ? .9 : Number(loaded);
    const pendingStart = ch.start(0);
    await sleep(70);
    clock = 20000; await sleep(70);
    clock = 20300; await pendingStart;
    assert.equal(ch.loadingStatus.timedOut, true, failure);
    assert.equal(ch.blocked, false, failure);
    assert.equal(hold.blocked, false, failure);
    assert.equal(ch.state, failure === 'start' ? 'idle' : 'countdown', failure);
    if (failure === 'start') assert(car.pos.equals(home), 'unavailable start returns home instead of racing on missing ground');
  }
  // A late shader promise from the cancelled load cannot move the player or restart the race.
  ch.quit(); loaded = true; clock = 0; world.raceLoadProgress = () => 1; car.reset(-800, 0, .4);
  const old = ch.start(0); await sleep(70); const finishOld = finishCompile;
  const replacement = ch.start(0); await sleep(70);
  ch.quit(); finishOld(); finishCompile();
  await Promise.all([old, replacement]);
  assert.equal(ch.state, 'idle'); assert.equal(car.pos.x, -800); assert.equal(hold.blocked, false);
} finally { globalThis.performance = realPerformance; ch.quit(); }
console.log('PASS stalled compiler/tiles deadline, missing-start safe return, replacement/cancel and late completion');
