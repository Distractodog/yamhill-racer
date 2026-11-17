// Clean Garage wheel paint on every ground type, including cached models and remote copies.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createVehicles } from '../game/src/vehicles.js';
import { createCosmetics, COSMETIC_KEY, DEFAULT_COSMETICS, disposeCosmeticPreview, paintedModel } from '../game/src/cosmetics.js';
import { TUNING_DEFAULTS } from '../game/src/car.js';
import { VEHICLE_TYPES, VEHICLE_TYPE_KEY } from '../game/src/vehicletypes.js';
import { createWarmup } from '../game/src/warmup.js';
import { Effects } from '../game/src/effects.js';
import { bakeParts } from '../game/src/mp/remotes.js';

const world = { extent: [-1e5, -1e5, 1e5, 1e5], spawn: [0, 0],
  heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3,
  normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0), waterLevelAt: () => -Infinity,
  loadedAt: () => true, mapContains: () => true, treesNear() {}, buildingsNear: () => [] };
const colors = { car: '#da219b', bike: '#17b967' };
let checks = 0;
const fx = new Effects(new THREE.Scene(), { shadows: false, caps: { puffs: 1, chips: 1, marks: 1, discs: 16 } });
function checkBlur(model, expected, label) {
  // The rendered overlay hides otherwise correctly painted rims once the wheels spin.
  const wheels = model.userData.wheels.map(() => ({ spin: 0 }));
  fx.tyres = wheels.map(() => ({ spin: 0, w: 0, xrate: 0, blur: 0, extra: 0 }));
  const vehicle = { wheels, kind: model.userData.lean ? 'bike' : 'car' };
  for (let frame = 0; frame < 60; frame++) {
    wheels.forEach(w => { w.spin += 2; }); // 120 rad/s: visible blur on every type
    fx.blur(1 / 60, vehicle, model.userData.wheels); fx.advance(1 / 60);
  }
  assert.equal(fx.discs.count, wheels.length * 2, `${label}: both wheel faces blurred`);
  const color = fx.discs.geometry.getAttribute('aColor'), want = new THREE.Color(expected);
  assert.ok(color, `${label}: blur has the wheel paint, not a hard-coded silver shader`);
  assert.deepEqual(color.updateRanges, [{ start: 0, count: fx.discs.count * 3 }], `${label}: current paint uploaded`);
  for (let i = 0; i < fx.discs.count; i++) {
    assert.ok(Math.abs(color.getX(i) - want.r) + Math.abs(color.getY(i) - want.g) + Math.abs(color.getZ(i) - want.b) < 1e-6,
      `${label}: blur disc ${i} uses the current rim colour`); checks++;
  }
}
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
  checkBlur(vehicles.current.mesh, colors[kind], `${kind}/${id}/${style}: local blur`);
  const batched = paintedModel(kind, cosmetics.get(kind), id);
  bakeParts(batched);
  checkBlur(batched, colors[kind], `${kind}/${id}/${style}: remote blur after batching`);
  // bakeParts uses a shared material; don't dispose that material with this model.
  batched.traverse(o => o.geometry?.dispose());
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
  cosmetics.set(kind, { wheels: '#000000' });
  checkBlur(vehicles.current.mesh, '#000000', `${kind}/${style}: black stays black while spinning`);
  cosmetics.set(kind, { wheels: colors[kind] });
  cosmetics.setWetness(1); cosmetics.update(.2, vehicles.current);
  checkBlur(vehicles.current.mesh, vehicles.current.mesh.userData.wheels[0].spin.children[1].material.color,
    `${kind}/${style}: live wet finish`);
  cosmetics.setWetness(0); cosmetics.wash(kind);
  checkBlur(vehicles.current.mesh, colors[kind], `${kind}/${style}: washed paint`);
}
// Different players share one draw call: each wheel must carry its own colour, not a global shader uniform.
for (const [kind, id] of [['car', 'race'], ['bike', 'dirt']]) {
  const model = paintedModel(kind, { wheels: colors[kind] }, id);
  fx.tyres = model.userData.wheels.map(() => ({ blur: .9, extra: 0 }));
  fx.blur(0, { kind, wheels: fx.tyres }, model.userData.wheels);
  disposeCosmeticPreview(model);
}
fx.advance(0);
assert.equal(fx.discs.count, 12, 'two players in one blur draw');
for (let i = 0; i < 12; i++) {
  const want = new THREE.Color(colors[i < 8 ? 'car' : 'bike']);
  assert.ok(Math.abs(fx.discColor.getX(i) - want.r) + Math.abs(fx.discColor.getY(i) - want.g) + Math.abs(fx.discColor.getZ(i) - want.b) < 1e-6);
  checks++;
}
fx.dispose();
console.log(`PASS wheel colours: ${checks} checks across saved load, warm-up, type changes, switches, resets, previews, remote batching and spinning rims (repaint, wet/wash, mixed players)`);
