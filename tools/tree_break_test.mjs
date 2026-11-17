// Real committed trees and vehicle collision code; one tile keeps this check small.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { makeWorld, makeTileData, trunkRadius } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { Bike, BIKE } from '../game/src/bike.js';
import { Jet, JET } from '../game/src/jet.js';
import { Glider } from '../game/src/glider.js';
import { applyVehicleType, VEHICLE_TYPES } from '../game/src/vehicletypes.js';
import { createTreeBreaks, treeId, TREE_REGROW_MS, connectTreeBreaks } from '../game/src/treebreak.js';
import { createTreeBreakFX } from '../game/src/treebreakfx.js';

const manifest = JSON.parse(fs.readFileSync('game/assets/world.json'));
const world = makeWorld(manifest);
const raw = await readTileData(f => {
  const b = fs.readFileSync(`game/assets/tiles/0_0/${f}`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}, manifest.packed);
const tile = makeTileData(manifest, 0, 0, raw); world.add(tile);
const records = Array.from({ length: tile.treeCount }, (_, i) => ({ i, x: tile.trees[i * 4], z: tile.trees[i * 4 + 1], h: tile.trees[i * 4 + 2], broad: tile.trees[i * 4 + 3], id: treeId(0, 0, i) }));
const small = records.find(t => t.h <= 8 && t.h >= 5 && Math.abs(t.x) < 800 && Math.abs(t.z) < 800 && world.normalAt(t.x, t.z).y > .99 && !world.buildingsNear(t.x, t.z).some(b => b.pts.some(p => Math.hypot(p[0] - t.x, p[1] - t.z) < 15)));
const medium = records.find(t => t.h >= 16 && t.h <= 20);
const large = records.reduce((a, b) => a.h > b.h ? a : b);
assert(small && medium && large.h >= 32, 'committed tile supplies small, medium and largest trees');
let cases = 0;
for (const kind of ['car', 'bike']) for (const spec of VEHICLE_TYPES[kind]) {
  const car = kind === 'car' ? new Car(world, { ...TUNING_DEFAULTS }) : new Bike(world, { ...BIKE });
  applyVehicleType(car, spec.id);
  // Keep the real tree query and terrain, isolating the selected trunk from neighbouring trees.
  let target;
  car.world.treesNear = (x, z, r, cb) => world.treesNear(x, z, r, (...args) => { if (args[5] === target.id) cb(...args); });
  for (target of [small, medium, large]) for (const kmh of [50, 100, 150, 250, 400]) {
    world.treeBreaks.update(Infinity);
    car.reset(target.x, target.z - 4, 0); car.quat.identity(); car.ang.set(0, 0, 0);
    const radius = kind === 'car' ? 1.15 * (car.typePhysics?.width ?? 1) : .45;
    const nose = kind === 'car' ? 1.4 * (car.typePhysics?.length ?? 1) : .6;
    car.pos.set(target.x, world.heightAt(target.x, target.z) + .8, target.z - nose - radius - trunkRadius(target.h, target.broad) + .02);
    car.vel.set(0, 0, kmh / 3.6);
    if (kind === 'car') car.collideTrees(); else car.collideTrees(.45, [-.6, 0, .6]);
    const size = Math.min(1, Math.max(0, (target.h - 8) / 24));
    const threshold = kind === 'bike' ? (target.h <= 8 ? 150 : Infinity) : (spec.id === 'truck' ? 70 + 70 * size : (spec.id === 'suv' ? 110 : 150) + (spec.id === 'suv' ? 140 : 100) * size);
    const broke = world.treeBreaks.broken.has(target.id), expected = kmh >= threshold;
    assert.equal(broke, expected, `${kind}/${spec.id} ${target.h}m at ${kmh}: threshold ${threshold}`);
    if (broke) {
      const loss = 1 - car.vel.length() / (kmh / 3.6);
      const [lo, hi] = kind === 'bike' ? [.65, .75] : spec.id === 'truck' ? [.1, .2] : [.3, .5];
      assert(loss >= lo - 1e-8 && loss <= hi + 1e-8, `${spec.id} loss ${loss}`);
      assert(car.vel.z > 0, 'continues forward');
      let found = false; world.treesNear(target.x, target.z, 2, (...a) => { if (a[5] === target.id) found = true; });
      assert(!found, 'broken tree removed from collisions');
    } else assert(car.vel.z < 0, 'old trunk bounce retained');
    assert([...car.pos, ...car.vel, ...car.quat, ...car.ang].every(Number.isFinite));
    assert(new THREE.Vector3(0, 1, 0).applyQuaternion(car.quat).y > .99, 'no impact flip');
    cases++;
  }
  // Full 120 Hz integration through a small tree, with speed comfortably clear of the boundary.
  target = small; world.treeBreaks.update(Infinity); car.reset(target.x, target.z - 6, 0); car.vel.set(0, 0, 400 / 3.6);
  for (let i = 0; i < 8; i++) car.step(1 / 120, { throttle: 0, brake: 0, steer: 0, handbrake: false });
  assert(world.treeBreaks.broken.has(target.id), `${spec.id} full step reaches and breaks tree: ${JSON.stringify({ small, pos: car.pos, vel: car.vel })}`);
  assert([...car.pos, ...car.vel, ...car.quat].every(Number.isFinite));
  assert(new THREE.Vector3(0, 1, 0).applyQuaternion(car.quat).y > 0, `${spec.id} full step no flip`);
  console.log(`${kind}/${spec.id}: 15 size/speed cases + full physics pass`);
}

// Fast tangential swipes use the normal speed, never the total speed.
world.treeBreaks.update(Infinity);
const swipe = new Car(world, { ...TUNING_DEFAULTS }); swipe.type = 'truck';
swipe.reset(small.x, small.z - 2, 0); swipe.quat.identity(); swipe.vel.set(400 / 3.6, 0, 1);
swipe.world.treesNear = (x, z, r, cb) => cb(small.x, small.z, trunkRadius(small.h, small.broad), small.h, small.broad, small.id);
swipe.collideTrees(); assert(!world.treeBreaks.broken.has(small.id));

// Airframe and glider clipping vs the existing hard-hit paths.
for (const kind of ['jet', 'glider']) {
  const vehicle = kind === 'jet' ? new Jet(world, { ...JET }) : new Car(world, { ...TUNING_DEFAULTS });
  const collider = kind === 'jet' ? vehicle : new Glider(vehicle);
  if (kind === 'glider') collider.open = 1;
  const h = medium.h, y = h * .6, tr = trunkRadius(h, medium.broad);
  const crown = medium.broad ? h * .3 : h * .15 * (1 - y / h) + tr;
  vehicle.world.treesNear = (x, z, r, cb) => { if (!tile.brokenTrees.has(medium.i)) cb(medium.x, medium.z, tr, h, medium.broad, medium.id); };
  for (const hard of [false, true]) {
    world.treeBreaks.update(Infinity); vehicle.pos.set(medium.x + (hard ? .1 : crown + 1), world.terrainAt(medium.x, medium.z) + y, medium.z);
    vehicle.vel.set(-100, 0, 0);
    assert.equal(collider.hitTree(), hard, `${kind} ${hard ? 'hard hit' : 'wing clip'}`);
    assert.equal(world.treeBreaks.broken.has(medium.id), !hard);
  }
}

world.treeBreaks.update(Infinity); assert(world.breakTree(small.id));
world.remove(0, 0); world.add(tile); assert(tile.brokenTrees.has(small.i), 'survives tile unload');
world.treeBreaks.update(Infinity); assert(!tile.brokenTrees.has(small.i), 'regrows loaded tile');
let now = 0; const state = createTreeBreaks(() => true, () => now);
assert(state.break('0_0:1')); now = TREE_REGROW_MS - 1; state.update(); assert.equal(state.broken.size, 1);
now++; state.update(); assert.equal(state.broken.size, 0);
assert(state.break('0_0:2', { dx: 10, dz: 0 })); assert.equal(state.broken.get('0_0:2').dz, 0);
assert(!state.break('bogus'));
assert(!world.breakTree('999_999:0'));

const sent = [], handlers = new Map();
const disconnect = connectTreeBreaks(world, { me: { id: 'me' }, send: m => sent.push(m), on: (t, f) => { handlers.set(t, f); return () => handlers.delete(t); } });
world.breakTree(small.id); assert.deepEqual(sent, [{ t: 'tree-break', id: small.id }]);
handlers.get('tree-break')({ id: medium.id, from: 'peer' }); assert.equal(sent.length, 1); assert(tile.brokenTrees.has(medium.i));
world.remove(0, 0); handlers.get('tree-break')({ id: large.id, from: 'peer' }); world.add(tile); assert(tile.brokenTrees.has(large.i));
disconnect(); world.treeBreaks.update(Infinity);

// Late joins: host snapshots are chunked, preserve remaining lifetime, and do not replay effects/audio.
let syncNow = 1000;
const hostState = createTreeBreaks(() => true, () => syncNow), guestState = createTreeBreaks(() => true, () => syncNow);
const hostEvents = new Map(), guestEvents = new Map(), packets = [], restored = [], sounds = [];
const hostMP = { me: { id: 'host' }, isHost: true, send: m => packets.push(m), on: (t, f) => { hostEvents.set(t, f); return () => hostEvents.delete(t); } };
const guestMP = { me: { id: 'guest' }, isHost: false, players: new Map([['host', { host: true }], ['peer', { host: false }]]), now: () => syncNow + 3600000,
  send: () => assert.fail('snapshot must not echo'), on: (t, f) => { guestEvents.set(t, f); return () => guestEvents.delete(t); } };
for (let i = 0; i < 260; i++) hostState.break(`0_0:${i}`);
const offHost = connectTreeBreaks({ treeBreaks: hostState }, hostMP), offGuest = connectTreeBreaks({ treeBreaks: guestState }, guestMP, { treeBreak: e => sounds.push(e) });
guestState.onChange(e => restored.push(e));
syncNow += 120000;
hostEvents.get('joined')({ player: { id: 'guest' } });
assert.deepEqual(packets.map(p => p.trees.length), [128, 128, 4]);
assert.equal(packets[0].trees[0].remainingMs, 180000);
guestEvents.get('tree-sync')({ ...packets[0], from: 'peer', srvT: syncNow });
assert.equal(guestState.broken.size, 0, 'only host snapshots accepted');
const sentAt = syncNow; syncNow += 50;
for (const p of packets) guestEvents.get('tree-sync')({ ...p, from: 'host', srvT: sentAt });
assert.equal(guestState.broken.size, 260);
assert(restored.every(e => e.snapshot && e.remote)); assert.equal(sounds.length, 0);
assert.equal(guestState.broken.get('0_0:0').until, hostState.broken.get('0_0:0').until + 50, 'remaining TTL survives an unsynchronized client clock (plus delivery delay)');
for (const p of packets) guestEvents.get('tree-sync')({ ...p, from: 'host', srvT: sentAt });
assert.equal(restored.length, 260, 'duplicate snapshot does not replay effects or restart lifetime');
syncNow = 301050; guestState.update(); assert.equal(guestState.broken.size, 0);
packets.length = 0; hostEvents.get('joined')({ player: { id: 'later' } }); assert.equal(packets.length, 0, 'expired trees excluded');
offHost(); offGuest(); assert.equal(hostEvents.size + guestEvents.size, 0);

// Renderer state without WebGL: both LODs, chunk isolation, top cap, reattach, regrowth.
const scene = new THREE.Group(), geometry = new THREE.ConeGeometry(1, 1, 5), material = new THREE.MeshLambertMaterial();
const indices = records.slice(0, 20).map(t => t.i);
const near = new THREE.InstancedMesh(geometry, material, 20), far = new THREE.InstancedMesh(geometry, material, 20);
const mats = new Float32Array(tile.treeCount * 16), matrix = new THREE.Matrix4();
for (const [i, index] of indices.entries()) {
  matrix.makeTranslation(tile.trees[index * 4], 0, tile.trees[index * 4 + 1]); matrix.toArray(mats, index * 16);
  near.setMatrixAt(i, matrix); far.setMatrixAt(i, matrix); near.setColorAt(i, new THREE.Color('green'));
}
const treeSlots = new Int32Array(tile.treeCount * 2).fill(-1);
indices.forEach((index, slot) => { treeSlots[index * 2] = 0; treeSlots[index * 2 + 1] = slot; });
const other = new THREE.InstancedMesh(geometry, material, 1), view = { td: tile, group: new THREE.Group(), treeMats: mats, treeSlots, treeLods: [{ near, far }, { near: other, far: other }] };
const fx = createTreeBreakFX(world, scene, [geometry, geometry], new Map([[world.key(0, 0), view]]), () => {});
let compilations = 0;
const camera = new THREE.PerspectiveCamera(), renderer = { async compileAsync(models, cam, target) {
  compilations++; assert.equal(cam, camera); assert.equal(target, scene);
  assert.equal(models.children.length, 13); assert(models.children.every(m => m.visible));
  assert.equal(models.children.filter(m => m.material.transparent).length, 12);
  assert(scene.children.filter(g => g.isGroup).every(g => !g.visible), 'actual tops remain hidden during compilation');
} };
await fx.warmup(renderer, camera, scene); await fx.warmup(renderer, camera, scene);
assert.equal(compilations, 1); assert(fx.warmed);
world.treeBreaks.restore(treeId(0, 0, indices[0]), 5000);
assert.equal(fx.activeTops, 0, 'old snapshot only draws the stump');
world.treeBreaks.update(Infinity);
for (const i of indices) world.breakTree(treeId(0, 0, i));
assert.equal(fx.activeTops, 12); assert.equal(other.instanceMatrix.version, 0);
near.getMatrixAt(0, matrix); assert.equal(matrix.elements[0], 0);
far.getMatrixAt(0, matrix); assert.equal(matrix.elements[0], 0);
fx.attach(view); assert.equal(fx.activeTops, 12);
for (let t = 0; t < 11; t += .05) fx.update(t);
assert.equal(fx.activeTops, 0);
world.treeBreaks.update(Infinity); near.getMatrixAt(0, matrix); assert.equal(matrix.elements[0], 1);
fx.dispose();
console.log(`PASS: ${cases} committed-tree collision cases; step integration, air clips, state, multiplayer and render lifecycle`);
