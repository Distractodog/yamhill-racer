import assert from 'node:assert/strict';
import { createWind, driftAir } from '../game/src/wind.js';
import { createWorldSettings } from '../game/src/mp/menu.js';
import * as THREE from 'three';
import { Jet, JET } from '../game/src/jet.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { Bike } from '../game/src/bike.js';
import { Glider, BIKE_GLIDER } from '../game/src/glider.js';
import { Heli } from '../game/src/heli.js';
import { applyVehicleType } from '../game/src/vehicletypes.js';
const world = {
  heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 0,
  normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0),
  waterLevelAt: () => -Infinity, treesNear() {}, buildingsNear: () => [], loadedAt: () => true,
  extent: [-1e6, -1e6, 1e6, 1e6], spawn: [0, 0],
};
let sun = true, race = false;
const make = (seed = 42, w = world) => createWind({ seed, world: w, sunny: () => sun, racing: () => race });
const a = make(), b = make();
for (let t = 0; t < 3600; t += 3) {
  a.update(3); b.update(3);
  const low = { ...a.sample(0, 10, 0) }, high = { ...a.sample(0, 800, 0) };
  assert.deepEqual(high, b.sample(0, 800, 0));
  assert(high.speed >= low.speed && high.speed * 3.6 <= 25);
  const before = { ...a.sample(0, 800, 0) }; a.update(1 / 120); b.update(1 / 120);
  const after = a.sample(0, 800, 0);
  assert(Math.hypot(before.x - after.x, before.z - after.z) < .002, 'slow drift without gust jumps');
}
const c = a.column(-2, 3);
assert(c.radius >= 40 && c.radius <= 100 && c.birds >= 3 && c.birds <= 6);
assert.equal(a.sample(c.x, 100, c.z).y, c.lift);
assert(a.sample(c.x, 800, c.z).y < c.lift);
assert.equal(a.sample(c.x, 1100, c.z).y, 0);
assert.equal(a.sample(c.x + c.radius, 100, c.z).y, 0);
sun = false; assert.equal(a.sample(c.x, 100, c.z).y, 0); assert.equal(a.columnsNear(0, 0).length, 0); sun = true;
race = true; assert.deepEqual(a.sample(c.x, 100, c.z), { x: 0, y: 0, z: 0, speed: 0 }); assert.equal(a.columnsNear(0, 0).length, 0); race = false;
for (const surface of [1, 3, 5, 6]) assert.equal(make(42, { ...world, surfaceAt: () => surface }).column(-2, 3), null);
assert.equal(make(42, { ...world, waterLevelAt: () => 1 }).column(-2, 3), null);
assert.equal(make(42, { ...world, heightAt: () => undefined }).column(-2, 3), null);
assert.equal(make(42, { ...world, treesNear(x, z, r, cb) { cb(x, z, 1); } }).column(-2, 3), null);
assert.equal(make(42, { ...world, buildingsNear: () => [{ pts: [[c.x, c.z], [c.x + 10, c.z], [c.x, c.z + 10]] }] }).column(-2, 3), null);
const guest = make(777); guest.follow(a.clock()); assert.deepEqual(guest.sample(c.x, 100, c.z), a.sample(c.x, 100, c.z)); guest.unfollow(); assert.equal(guest.seed, 777);
// Real vehicle integrations: a constant air mass gives exact advection without altering airspeed/controls.
const flow = { sample: () => ({ x: 3, z: 2, y: 3, speed: Math.sqrt(13) }) };
const input = { throttle: 0, brake: 0, steer: 0, handbrake: false, jet: { thr: 0, pitch: 0, roll: 0, yaw: 0 } };
for (const type of ['prop', 'stunt', 'fighter', 'heli', 'glider', 'bikeglider', 'car', 'bike']) {
  function vehicle() {
    let v;
    if (type === 'heli') v = new Heli(world);
    else if (['car', 'glider'].includes(type)) v = new Car(world, { ...TUNING_DEFAULTS });
    else if (['bike', 'bikeglider'].includes(type)) v = new Bike(world);
    else { v = new Jet(world, { ...JET }); applyVehicleType(v, type); }
    v.reset(0, 0, 0); v.pos.y = 300; v.vel.set(0, 0, 40); v.mode = 'air'; v.grounded = false;
    if (type.includes('glider')) { const g = new Glider(v, type === 'bikeglider' ? BIKE_GLIDER : undefined); g.deploy(); }
    return v;
  }
  const calm = vehicle(), windy = vehicle(); windy.wind = flow;
  for (let i = 0; i < 120; i++) { calm.step(1 / 120, input); windy.step(1 / 120, input); }
  const response = ['car', 'bike'].includes(type) ? 0 : type === 'heli' ? .2 : type === 'fighter' ? .025 : 1;
  assert(Math.abs(windy.pos.x - calm.pos.x - 3 * response) < 1e-7, `${type} horizontal drift`);
  assert(Math.abs(windy.pos.y - calm.pos.y - 3 * response) < 1e-7, `${type} thermal lift`);
  assert(windy.vel.distanceTo(calm.vel) < 1e-9, `${type} airspeed preserved`);
}
// World-message sharing, authorization, own-weather mode and disconnect restoration.
const listeners = new Map(), sent = [];
let poll;
const mp = { inGame: true, isHost: true, players: new Map([['host', { host: true }]]),
  on(t, fn) { listeners.set(t, fn); }, off(t) { listeners.delete(t); }, send(m) { sent.push(m); } };
const timers = { setInterval(fn) { poll = fn; }, clearInterval() {}, setTimeout() {}, clearTimeout() {} };
const controller = createWorldSettings({ mp, wind: a, tuning: { car: {}, bike: {}, jet: {} }, atmosphere: {}, timers });
listeners.get('connected')(); assert.deepEqual(sent[0].settings.wind, a.clock());
for (let i = 0; i < 300; i++) poll(); assert.equal(sent.length, 2);
mp.isHost = false; const ownSeed = a.seed;
listeners.get('world')({ from: 'bad', mode: 'own', settings: { wind: { seed: 9, time: 10 } } }); assert.equal(a.seed, ownSeed);
listeners.get('world')({ from: 'host', mode: 'own', settings: { wind: { seed: 9, time: 10 } } }); assert.equal(a.seed, 9); assert.equal(a.time, 10);
listeners.get('disconnected')(); assert.equal(a.seed, ownSeed); controller.dispose();
const p = { pos: { x: 0, y: 0, z: 0 }, wind: a }; a.enabled = false; driftAir(p, 1); assert.deepEqual(p.pos, { x: 0, y: 0, z: 0 });
console.log('PASS: seeded field, speed/height bounds, smoothness, thermal footprint/lift/weather/race rules, real aircraft/ground integrations, multiplayer clock + authorization + restoration');

// Optional small real-map smoke check (four tiles, heavy gate); does not load the whole map.
if (process.argv.includes('--real')) {
  const fs = await import('node:fs/promises');
  const { makeWorld, makeTileData } = await import('../game/src/data.js');
  const { readTileData } = await import('../game/src/tilepack.js');
  const WJ = JSON.parse(await fs.readFile('game/assets/world.json', 'utf8')), W = makeWorld(WJ);
  for (const [tx, tz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    W.add(makeTileData(WJ, tx, tz, await readTileData(async name => {
      const b = await fs.readFile(`game/assets/tiles/${tx}_${tz}/${name}`);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }, WJ.packed)));
  }
  const realWind = createWind({ seed: 42, world: W, sunny: () => true });
  const sites = realWind.columnsNear(700, 700, 1800);
  assert(sites.length > 0, 'real fields provide bird-marked thermals');
  for (const c of sites) {
    assert.equal(W.surfaceAt(c.x, c.z), 0);
    assert(realWind.sample(c.x, c.ground + 100, c.z).y >= 2);
  }
  const nearby = sites.sort((a, b) => Math.hypot(a.x + 542, a.z - 440) - Math.hypot(b.x + 542, b.z - 440))[0];
  console.log(`PASS: ${sites.length} real-map thermals; nearest campus site ${JSON.stringify(nearby)}`);
}
