// Clean Garage wheel paint on every ground type, including cached models and remote copies.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createVehicles } from '../game/src/vehicles.js';
import { createCosmetics, COSMETIC_KEY, DEFAULT_COSMETICS, disposeCosmeticPreview, paintedModel } from '../game/src/cosmetics.js';
import { TUNING_DEFAULTS } from '../game/src/car.js';
import { VEHICLE_TYPES, VEHICLE_TYPE_KEY } from '../game/src/vehicletypes.js';
import { createWarmup } from '../game/src/warmup.js';

const world = { extent: [-1e5, -1e5, 1e5, 1e5], spawn: [0, 0],
  heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3,
  normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0), waterLevelAt: () => -Infinity,
  loadedAt: () => true, mapContains: () => true, treesNear() {}, buildingsNear: () => [] };
const colors = { car: '#da219b', bike: '#17b967' };
let checks = 0;
function check(model, expected, label) {
  const hex = expected.slice(1).toLowerCase();
  for (const [i, wheel] of model.userData.wheels.entries()) {
    // Check the actual rim slot independently of role registration, so an untagged silver rim fails too.
    assert.equal(wheel.spin.children[1].material.color.getHexString(), hex, `${label}: wheel ${i} rim`);
    const hub = wheel.spin.children.at(-1);
    assert.equal(hub.material.color.getHexString(), hex, `${label}: wheel ${i} cosmetic disc`);
    checks += 2;
  }
  model.traverse(o => {
    if (o.material?.userData.cosmeticRole === 'wheels') {
      assert.equal(o.material.color.getHexString(), hex, `${label}: rim/spokes/spare at either LOD`); checks++;
    }
  });
}
function game(kind, id, wheelStyle) {
  const saved = new Map([[COSMETIC_KEY, JSON.stringify(Object.fromEntries(Object.entries(colors).map(([k, wheels]) => [k, { wheels, wheelStyle, custom: ['wheels'] }])))],
    [VEHICLE_TYPE_KEY, JSON.stringify({ [kind]: id })]]);
  const storage = { getItem: k => saved.get(k), setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k) };
  const previous = globalThis.localStorage;
  let vehicles;
  try {
    globalThis.localStorage = storage;
    vehicles = createVehicles({ scene: new THREE.Scene(), world, tuning: { ...TUNING_DEFAULTS } });
  } finally { globalThis.localStorage = previous; }
  const cosmetics = createCosmetics(vehicles, { storage });
  return { vehicles, cosmetics };
}
for (const style of ['factory', 'sport', 'rally']) for (const kind of ['car', 'bike']) for (const { id } of VEHICLE_TYPES[kind]) {
  const { vehicles, cosmetics } = game(kind, id, style);
  const inspect = label => {
    cosmetics.update(0, vehicles.current); // main.js also paints paused frames
    check(vehicles.all[kind].mesh, colors[kind], `${kind}/${id}/${style}: ${label}`);
  };
  inspect('saved load');
  // Exercise startup shader warm-up without a renderer or asynchronous work.
  const warmup = createWarmup({ renderer: { compile() {} }, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), vehicles, cosmetics });
  while (!warmup.done) warmup.step();
  inspect('warm-up');
  vehicles.switchTo(kind); inspect('vehicle switch');
  for (let round = 0; round < 2; round++) for (const type of VEHICLE_TYPES[kind]) {
    vehicles.setType(kind, type.id); inspect(`type ${type.id}, round ${round}`);
    vehicles.current.reset(0, 0, 0); inspect('reset');
    vehicles.current.safe = [[0, 0, 0]]; vehicles.current.resetToSafe(); inspect('reset to safe');
    const other = kind === 'car' ? 'bike' : 'car';
    vehicles.switchTo(other); vehicles.switchTo(kind); inspect('switch back');
    check(cosmetics.createPreview(kind), colors[kind], 'Garage preview');
    const remote = paintedModel(kind, cosmetics.get(kind), type.id);
    check(remote, colors[kind], 'remote'); disposeCosmeticPreview(remote);
  }
  cosmetics.reset(kind);
  check(vehicles.all[kind].mesh, DEFAULT_COSMETICS[kind].wheels, 'Garage factory reset');
  cosmetics.set(kind, { wheels: colors[kind] });
  inspect('Garage repaint after reset');
}
console.log(`PASS wheel colours: ${checks} rim/disc/spoke checks across saved load, warm-up, type changes, switches, resets, previews and remotes`);
