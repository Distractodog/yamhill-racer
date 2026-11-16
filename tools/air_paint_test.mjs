// Garage paint survives resets and wrecks on every aircraft type (Node, no renderer):  node tools/air_paint_test.mjs
// For each jet type: paint it (body red, trim green) through createCosmetics, then a normal reset, a crash (wreck
// colours), the wreck's respawn and a reset again; after each, cosmetics.update() runs and the painted materials must
// show the custom paint (or the wreck colour while wrecked). Also a repaint while wrecked shows after the respawn.
// (grace = 0 before each forced crash: right after a respawn jet.js would turn the crash into a reset, airrespawn.js)
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createVehicles } from '../game/src/vehicles.js';
import { createCosmetics } from '../game/src/cosmetics.js';
import { TUNING_DEFAULTS } from '../game/src/car.js';
import { VEHICLE_TYPES } from '../game/src/vehicletypes.js';

const flat = () => ({ extent: [-1e5, -1e5, 1e5, 1e5], spawn: [0, 0], heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0,
  surfaceAt: () => 3, normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0), waterLevelAt: () => -Infinity,
  loadedAt: () => true, mapContains: () => true, treesNear() {}, buildingsNear: () => [] });
const store = new Map(), storage = { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) };
const vehicles = createVehicles({ scene: new THREE.Scene(), world: flat(), tuning: { ...TUNING_DEFAULTS } });
const cosmetics = createCosmetics(vehicles, { storage });
const input = { throttle: 0, brake: 0, steer: 0, handbrake: false, jet: { thr: 0, pitch: 0, roll: 0, yaw: 0 } };
// colours of the materials the Garage paints, by role
const paint = mesh => { const out = {}; mesh.traverse(o => { const r = o.material?.userData?.cosmeticRole; if (r === 'body' || r === 'trim') (out[r] ||= new Set()).add(o.material.color.getHexString()); }); return out; };
const settle = v => { for (let i = 0; i < 3; i++) cosmetics.update(0.25, v); };
const expect = (v, body, trim, what) => {
  settle(v); const p = paint(v.mesh);
  assert.deepEqual([...p.body], [body], `${v.type} ${what}: body ${[...p.body]} (want ${body})`);
  assert.deepEqual([...p.trim], [trim], `${v.type} ${what}: trim ${[...p.trim]} (want ${trim})`);
};
const rows = [];
for (const { id } of VEHICLE_TYPES.jet) {
  vehicles.setType('jet', id); vehicles.switchTo('jet');
  const v = vehicles.current; assert.equal(v.type, id);
  const ud = v.mesh.userData, wreckHex = new THREE.Color(ud.wreckColor ?? 0x3a3a3a).getHexString();
  assert(paint(v.mesh).body?.size && paint(v.mesh).trim?.size, `${id}: Garage-painted body and trim materials`);
  cosmetics.set('jet', { body: '#ff0000', trim: '#00ff00' });
  expect(v, 'ff0000', '00ff00', 'painted');
  v.reset(0, 0, 0); expect(v, 'ff0000', '00ff00', 'after a reset');
  v.reset(0, 0, 0); expect(v, 'ff0000', '00ff00', 'after a second reset');
  // crash: wreck colours while it tumbles (the wreck look wins over the Garage paint until the respawn)
  v.placeInAir(0, 200, 0, 0, 300); v.grace = 0; v.crash('impact'); assert.equal(v.mode, 'crashed');
  const wrecked = paint(v.mesh); assert(wrecked.body.has(wreckHex), `${id}: wreck colour while crashed (${[...wrecked.body]})`);
  for (let i = 0; i < 120 * 6 && v.mode === 'crashed'; i++) { v.savePrev(); v.step(1 / 120, input); }
  assert.notEqual(v.mode, 'crashed', `${id}: respawned`);
  expect(v, 'ff0000', '00ff00', 'after the wreck respawn');
  // repaint, then crash and respawn again: the new paint comes back
  cosmetics.set('jet', { body: '#0000ff', trim: '#ffff00' });
  v.placeInAir(0, 200, 0, 0, 300); v.grace = 0; v.crash('impact');
  for (let i = 0; i < 120 * 6 && v.mode === 'crashed'; i++) { v.savePrev(); v.step(1 / 120, input); }
  v.reset(0, 0, 0); expect(v, '0000ff', 'ffff00', 'after a repaint, a second wreck and a reset');
  rows.push(id);
  cosmetics.reset('jet');
}
vehicles.setType('jet', 'fighter');
console.log(`PASS aircraft paint: ${rows.join(', ')} keep Garage paint through resets, wrecks and respawns`);
