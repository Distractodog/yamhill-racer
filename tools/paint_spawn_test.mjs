// The Garage paint shows on the very first frame after every way a vehicle appears (Node, no renderer):
//   node tools/paint_spawn_test.mjs
// Owner's report: a black fighter jet was another colour for a few seconds after it spawned, then turned black.
// Paint = black body, plus a red trim, saved like the Garage saves it. After each action the test runs exactly what
// main.js runs before drawing that frame (one cosmetics.update) and checks every Garage-painted material of the
// vehicle you're in; then 5 s of frames must not change it. Paths, for every type of car, bike and aircraft:
// start-up (saved type), V switch, Garage type change (first time and back again: models are reused now), R reset,
// flip, crash + automatic respawn (all five aircraft), a held respawn on ground that loads later (respawnhold.js),
// a repaint in the Garage while the wreck tumbles (the wreck used to put back the paint it had at the crash), a type
// change while wrecked, and another player's copy (mp remotes paintedModel). While wrecked the wreck colour shows.
// (grace = 0 before each forced crash: right after a respawn jet.js would turn the crash into a reset, airrespawn.js)
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createVehicles } from '../game/src/vehicles.js';
import { createCosmetics, paintedModel } from '../game/src/cosmetics.js';
import { createRespawnHold } from '../game/src/respawnhold.js';
import { TUNING_DEFAULTS } from '../game/src/car.js';
import { VEHICLE_TYPES, VEHICLE_TYPE_KEY } from '../game/src/vehicletypes.js';

const BLACK = '000000', TRIM = 'ff0000', SAVE = JSON.stringify(Object.fromEntries(['car', 'bike', 'jet'].map(k => [k, { body: '#000000', trim: '#ff0000', custom: ['body', 'trim'] }])));
let loaded = true;
const world = () => ({ extent: [-1e5, -1e5, 1e5, 1e5], spawn: [0, 0], W: { tile: 2000, tiles: [[0, 0]] }, heightAt: (x, z) => loaded ? 50 : 0, terrainAt: () => 50, groundAt: () => 50,
  surfaceAt: () => 0, normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0), waterLevelAt: () => -Infinity,
  loadedAt: () => loaded, mapContains: () => true, treesNear() {}, buildingsNear: () => [] });
const input = { throttle: 0, brake: 0, steer: 0, handbrake: false, jet: { thr: 0, pitch: 0, roll: 0, yaw: 0 } };
// Garage-painted colours by role; the race car paints vertex colours instead (cosmetics.js bindModel): there a vertex
// still in the factory red counts as body e8402f, a black one as 000000
const FACTORY_RED = new THREE.Color('#e8402f');
const paintOf = (mesh, car = false) => {
  const out = { body: new Set(), trim: new Set() };
  mesh.traverse(o => {
    const r = o.material?.userData?.cosmeticRole; if (out[r]) out[r].add(o.material.color.getHexString());
    const a = car && o.isMesh && !r && o.geometry?.attributes.color;
    if (a) for (let i = 0; i < a.count; i++) {
      const d = c => Math.abs(a.getX(i) - c.r) + Math.abs(a.getY(i) - c.g) + Math.abs(a.getZ(i) - c.b);
      if (d(FACTORY_RED) < .001) out.body.add('e8402f'); else if (d({ r: 0, g: 0, b: 0 }) < .001) out.body.add(BLACK);
    }
  });
  return out;
};
let checks = 0;

function game(types = {}) {
  const store = new Map([['yr-cosmetics-1', SAVE], [VEHICLE_TYPE_KEY, JSON.stringify(types)]]);
  const storage = { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) };
  const prev = globalThis.localStorage; globalThis.localStorage = storage;     // the type selector reads it
  const W = world(), vehicles = createVehicles({ scene: new THREE.Scene(), world: W, tuning: { ...TUNING_DEFAULTS } });
  globalThis.localStorage = prev;
  const cosmetics = createCosmetics(vehicles, { storage });
  const hold = createRespawnHold({ world: W, vehicles: [vehicles.car, vehicles.bike, ...vehicles.aircraft], current: () => vehicles.current });
  // main.js frame, in the order it draws: hold, physics, cosmetics.update, (render)
  const frame = () => { hold.update(1 / 60); const v = vehicles.current; if (!hold.blocked) for (let i = 0; i < 2; i++) { v.savePrev(); v.step(1 / 120, input); } cosmetics.update(1 / 60, vehicles.current); };
  const drawn = (what, { body = BLACK, trim = TRIM } = {}) => {
    cosmetics.update(1 / 60, vehicles.current);          // what runs before this frame is drawn
    const v = vehicles.current, p = paintOf(v.mesh, v.kind === 'car');
    assert(p.body.size, `${what}: ${v.type} has Garage-painted body parts`);
    assert.deepEqual([...p.body], [body], `${what} (${v.kind} ${v.type}): body ${[...p.body]} on the first frame (want ${body})`);
    if (p.trim.size && trim) assert.deepEqual([...p.trim], [trim], `${what} (${v.kind} ${v.type}): trim ${[...p.trim]} (want ${trim})`);
    checks++;
  };
  const holds = (what, secs = 5) => { for (let i = 0; i < secs * 60; i++) { frame(); if (vehicles.current.mode === 'crashed') break; } drawn(`${what}, ${secs} s later`); };
  return { vehicles, cosmetics, hold, frame, drawn, holds, store };
}
const types = kind => VEHICLE_TYPES[kind].map(t => t.id);

// start-up with each saved type, then V into it
for (const kind of ['car', 'bike', 'jet']) for (const id of types(kind)) {
  const g = game({ [kind]: id });
  g.vehicles.switchTo(kind); g.drawn(`start-up with ${kind} ${id} saved, V`); g.holds(`start-up ${kind} ${id}`, 1);
}
// one session: V switches, every type (twice: first build, then the reused model), R, F, crash respawns
const g = game();
for (const kind of ['bike', 'jet', 'car', 'jet', 'bike', 'car']) { g.vehicles.switchTo(kind); g.drawn(`V to ${kind}`); }
for (const kind of ['car', 'bike', 'jet']) {
  g.vehicles.switchTo(kind);
  for (const round of [1, 2]) for (const id of [...types(kind).slice(1), types(kind)[0]]) {
    g.vehicles.setType(kind, id); g.drawn(`Garage type ${kind} ${id} (round ${round})`);
    const v = g.vehicles.current;
    v.safe = [[40, 0, 0]]; v.resetToSafe(); g.drawn(`R reset in ${id}`);
    (v.flipUpright || (() => v.reset(v.pos.x, v.pos.z, 0))).call(v); g.drawn(`F in ${id}`);
    if (kind === 'jet') {
      v.placeInAir(0, 300, 0, 0, 400); g.drawn(`air start ${id}`);
      v.grace = 0; v.crash('impact'); const wreck = new THREE.Color(v.mesh.userData.wreckColor ?? 0x3a3a3a).getHexString();
      for (let i = 0; i < 60; i++) g.frame();
      assert([...paintOf(v.mesh).body].every(h => h === wreck), `${id}: the wreck colour holds while it tumbles (wear isn't painted over it)`);
      let f = 0; while (v.mode === 'crashed' && f++ < 600) g.frame();
      assert.notEqual(v.mode, 'crashed', `${id} respawned`);
      g.drawn(`crash respawn ${id}`); g.holds(`crash respawn ${id}`);
    }
  }
}
// the Garage repaints while the wreck tumbles: the respawn shows the new paint at once (not the paint from the crash)
for (const id of types('jet')) {
  const s = game({ jet: id }); s.vehicles.switchTo('jet'); const v = s.vehicles.current;
  s.cosmetics.set('jet', { body: '#ffffff' }); v.placeInAir(0, 300, 0, 0, 400); v.grace = 0; v.crash('impact');
  for (let i = 0; i < 30; i++) s.frame();
  s.cosmetics.set('jet', { body: '#000000' });
  let f = 0; while (v.mode === 'crashed' && f++ < 600) s.frame();
  s.drawn(`${id}: repainted black during the wreck, respawn`); s.holds(`${id} repainted during the wreck`);
  // a type change while wrecked
  v.placeInAir(0, 300, 0, 0, 400); v.grace = 0; v.crash('impact'); for (let i = 0; i < 30; i++) s.frame();
  const other = types('jet').find(t => t !== id); s.vehicles.setType('jet', other); s.drawn(`${id} → ${other} while wrecked`);
  s.vehicles.setType('jet', id); s.drawn(`back to ${id}`); s.holds(`back to ${id} after a wrecked type change`);
}
// a respawn held on ground that hasn't loaded: paint right when it is placed
{
  const s = game(); s.vehicles.switchTo('jet'); const v = s.vehicles.current;
  v.safe = [[3000, 0, 0]]; v.placeInAir(0, 300, 0, 0, 400); v.grace = 0; v.crash('impact');
  loaded = false; let f = 0; while (v.mode === 'crashed' && f++ < 600) s.frame();
  assert(s.hold.blocked, 'respawn held on unloaded ground'); s.drawn('held respawn (waiting for the ground)');
  for (let i = 0; i < 30; i++) s.frame(); loaded = true; s.frame();
  assert(!s.hold.blocked && v.mode === 'ground', 'placed once loaded'); s.drawn('held respawn placed'); s.holds('held respawn placed');
}
// another player's black jet of every type (mp/remotes.js)
for (const id of types('jet')) {
  const p = paintOf(paintedModel('jet', { body: '#000000', trim: '#ff0000' }, id));
  assert(p.body.size === 0 || [...p.body].every(h => h === BLACK), `remote ${id}: ${[...p.body]}`); checks++;
}
console.log(`PASS paint on every spawn path: ${checks} checks (start-up, V, every Garage type twice, R, F, crash respawns, held respawn, repaint during a wreck, type change while wrecked, remote copies)`);
