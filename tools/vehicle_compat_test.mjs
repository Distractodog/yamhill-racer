// Legacy storage sanitizers: obsolete selections/colours cannot restore unsupported kinds.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createVehicles, VEHICLES } from '../game/src/vehicles.js';
import { TUNING_DEFAULTS } from '../game/src/car.js';
import { createCosmetics, COSMETIC_KEY, DEFAULT_COSMETICS, sanitizeCosmetics, paintedModel, disposeCosmeticPreview } from '../game/src/cosmetics.js';

const supported = ['car', 'bike', 'jet'];
assert.deepEqual(VEHICLES.map(v => v.kind), supported);
assert.deepEqual(Object.keys(DEFAULT_COSMETICS), supported);
const world = { heightAt: () => 0, terrainAt: () => 0, surfaceAt: () => 3,
  waterLevelAt: () => -Infinity, normalAt: (_x, _z, n) => n.set(0, 1, 0), treesNear() {},
  buildingsNear: () => [], loadedAt: () => true, extent: [-1000, -1000, 1000, 1000] };
const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
try {
  for (const legacy of ['jetski', 'boat']) {
    const saved = new Map([
      ['yr-vehicle-1', legacy],
      [COSMETIC_KEY, JSON.stringify({ [legacy]: { body: '#abcdef' }, car: { body: '#112233' } })],
    ]);
    const storage = { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k) };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    const vehicles = createVehicles({ scene: new THREE.Scene(), world, tuning: { ...TUNING_DEFAULTS } });
    assert.equal(vehicles.current.kind, 'car');
    assert.deepEqual(Object.keys(vehicles.all), supported);
    assert.equal(saved.has('yr-vehicle-1'), false);
    assert.equal(vehicles.switchTo(legacy), false);
    const cosmetics = createCosmetics(vehicles, { storage });
    assert.deepEqual(Object.keys(JSON.parse(saved.get(COSMETIC_KEY))), supported);
    assert.equal(cosmetics.get('car').body, '#112233');
    assert.deepEqual(sanitizeCosmetics(null, legacy), DEFAULT_COSMETICS.car);
    const model = paintedModel(legacy, { body: '#abcdef' });
    assert.equal(model.userData.wheels.length, 4);
    disposeCosmeticPreview(model);
    Object.values(vehicles.all).forEach(v => disposeCosmeticPreview(v.mesh));
  }
} finally {
  if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
  else delete globalThis.localStorage;
}
console.log('PASS supported vehicle list, legacy selection cleanup, saved colour sanitizers and car stand-ins');
