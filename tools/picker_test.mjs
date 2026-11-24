// V picker logic without a browser (Node, no renderer):  node tools/picker_test.mjs
// 1) stat bars (vehiclestats.js): 1–5 for every type, every stat's best type of a vehicle has 5, sensible order.
// 2) vehicles.choose (what the picker calls): vehicle + type in one go from the ground and in flight (an aircraft type
//    swap keeps flying at the same height, jet ↔ helicopter swaps the slot's vehicle), same choice = no-op, a refused
//    switch changes nothing, a respawn hold moves to the chosen vehicle.
// 3) thumbnail paint (cosmetics.colorsFor / paintType): the player's colour on every type, factory colours where none.
// The picker's DOM, keys and pictures: tools/picker_shots.mjs (browser).
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createVehicles } from '../game/src/vehicles.js';
import { createCosmetics } from '../game/src/cosmetics.js';
import { TUNING_DEFAULTS } from '../game/src/car.js';
import { VEHICLE_TYPES, buildVehicleTypeModel } from '../game/src/vehicletypes.js';
import { typeStats } from '../game/src/vehiclestats.js';
import { createRespawnHold } from '../game/src/respawnhold.js';

// 1) stats
const rows = [];
for (const [kind, types] of Object.entries(VEHICLE_TYPES)) {
  const all = types.map(t => ({ kind, type: t.id, ...typeStats(kind, t.id) }));
  for (const s of all) for (const k of ['top', 'handling', 'offroad']) assert(Number.isInteger(s[k]) && s[k] >= 1 && s[k] <= 5, `${kind}/${s.type} ${k} = ${s[k]}`);
  for (const k of ['top', 'handling', 'offroad']) assert(all.some(s => s[k] === 5), `${kind}: some type has 5 ${k}`);
  rows.push(...all.map(({ labels, ...s }) => s));
}
const st = (kind, id) => typeStats(kind, id);
assert(st('car', 'sports').top >= st('car', 'race').top && st('car', 'race').top > st('car', 'truck').top, 'car top speeds');
assert(st('car', 'truck').offroad === 5 && st('car', 'sports').offroad === 1, 'truck best off-road, sports car worst');
assert(st('car', 'suv').offroad > st('car', 'hatch').offroad, 'SUV beats the hatchback off-road');
assert(st('bike', 'sport').top > st('bike', 'dirt').top && st('bike', 'dirt').offroad > st('bike', 'sport').offroad, 'bikes');
assert(st('jet', 'blackbird').top === 5 && st('jet', 'stealth').top < st('jet', 'blackbird').top && st('jet', 'heli').offroad === 5 && st('jet', 'prop').offroad > st('jet', 'fighter').offroad, 'aircraft');
console.table(rows);

// 2) choose
const loaded = { far: true };
const flat = () => ({ extent: [-1e5, -1e5, 1e5, 1e5], spawn: [0, 0], heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0,
  surfaceAt: () => 3, normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0), waterLevelAt: () => -Infinity,
  loadedAt: x => x > -3000 || loaded.far, mapContains: () => true, treesNear() {}, buildingsNear: () => [] });
const store = new Map(), storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
globalThis.localStorage = storage;
let allow = true;
const vehicles = createVehicles({ scene: new THREE.Scene(), world: flat(), tuning: { ...TUNING_DEFAULTS }, canSwitch: () => allow });
const cosmetics = createCosmetics(vehicles, { storage });
const cur = () => `${vehicles.current.kind}/${vehicles.getType(vehicles.current.kind)}`;
vehicles.current.reset(100, 50, 0.3);
assert.equal(cur(), 'car/race');
assert(vehicles.choose('bike'), 'choose bike'); assert.equal(cur(), 'bike/dirt');
assert.equal(vehicles.current.pos.x.toFixed(1), '100.0', 'bike placed where the car was');
assert(vehicles.choose('car', 'suv')); assert.equal(cur(), 'car/suv'); assert.equal(vehicles.car.type, 'suv');
assert(vehicles.car.mesh.parent, 'the SUV model is in the scene');
assert(vehicles.choose('car', 'suv')); assert.equal(cur(), 'car/suv', 'same choice: no change');
assert(vehicles.choose('jet', 'prop')); assert.equal(cur(), 'jet/prop'); assert.equal(vehicles.current.mode === 'air', false, 'from the ground: on the ground');
// in flight: another aircraft type keeps flying at this height; the helicopter takes the slot in the air
vehicles.current.placeInAir(0, 300, 0, 0, 250);
assert(vehicles.choose('jet', 'stunt')); assert.equal(cur(), 'jet/stunt');
assert.equal(vehicles.current.mode, 'air'); assert(Math.abs(vehicles.current.pos.y - 300) < 0.01, `stunt kept its height (${vehicles.current.pos.y})`);
assert(vehicles.choose('jet', 'heli')); assert.equal(cur(), 'jet/heli');
assert(vehicles.current.mesh.userData.mainRotor, 'the helicopter flies the slot');
assert.equal(vehicles.current.mode, 'air'); assert(Math.abs(vehicles.current.pos.y - 300) < 0.01, `helicopter kept its height (${vehicles.current.pos.y})`);
assert(vehicles.choose('jet', 'fighter')); assert.equal(cur(), 'jet/fighter'); assert.equal(vehicles.current.mode, 'air');
assert(!vehicles.current.mesh.userData.mainRotor, 'back to the jet');
// refused (canSwitch false): nothing changes, type included
allow = false;
assert.equal(vehicles.choose('car', 'truck'), false); assert.equal(cur(), 'jet/fighter'); assert.equal(vehicles.getType('car'), 'suv');
allow = true;
assert(vehicles.choose('car', 'race')); assert.equal(cur(), 'car/race');
// a respawn hold (unloaded ground) moves to the vehicle chosen during it
{
  const hold = createRespawnHold({ world: flat(), vehicles: [vehicles.car, vehicles.bike, ...vehicles.aircraft], current: () => vehicles.current });
  loaded.far = false;
  vehicles.current.safe = [[-4000, 0, 0]]; vehicles.current.resetToSafe();
  assert(hold.blocked, 'R onto unloaded ground holds');
  assert(vehicles.choose('jet', 'heli')); hold.update(0.1);
  assert(hold.blocked && hold.holding.vehicle === vehicles.current && vehicles.current.mesh.userData.mainRotor, 'the hold is the helicopter\'s now');
  loaded.far = true; hold.update(0.1);
  assert(!hold.blocked && Math.abs(vehicles.current.pos.x + 4000) < 1, `placed at the held spot (${vehicles.current.pos.x})`);
  assert(vehicles.choose('car', 'race'));
}

// 3) thumbnail paint
cosmetics.set('jet', { body: '#123456' });
assert.equal(cosmetics.colorsFor('jet', 'stealth').body, '#123456', 'your body colour on the stealth');
assert.equal(cosmetics.colorsFor('jet', 'stealth').trim, VEHICLE_TYPES.jet.find(t => t.id === 'stealth').colors.trim, 'stealth factory trim where none picked');
assert.equal(cosmetics.colorsFor('car', 'sports').trim, '#17181b', 'sports car factory trim');
for (const [kind, types] of Object.entries(VEHICLE_TYPES)) for (const { id } of types) {
  const model = buildVehicleTypeModel(kind, id); cosmetics.paintType(kind, id, model);
  const want = new THREE.Color(cosmetics.colorsFor(kind, id).body).getHexString(), seen = new Set();
  model.traverse(o => { if (o.material?.userData?.cosmeticRole === 'body') seen.add(o.material.color.getHexString()); });
  const verts = []; model.traverse(o => { if (kind === 'car' && o.geometry?.attributes.color) verts.push(o); });
  assert(seen.size ? [...seen].every(h => h === want) : verts.length, `${kind}/${id}: thumbnail model painted (${[...seen]} want ${want})`);
}
console.log('PASS picker: stat bars 1–5 per type, choose vehicle + type (ground, in flight, helicopter slot, refused, respawn hold), thumbnail paint');

assert(st('jet', 'airliner').top < st('jet', 'fighter').top && st('jet', 'airliner').handling < st('jet', 'fighter').handling, 'jumbo is slower and steadier');
