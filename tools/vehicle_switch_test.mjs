// Fast regressions for Garage activation and V during H's streaming pause.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createVehicles } from '../game/src/vehicles.js';
import { TUNING_DEFAULTS } from '../game/src/car.js';
import { VEHICLE_TYPES } from '../game/src/vehicletypes.js';
import { createSpawn } from '../game/src/spawn.js';
import { createVehiclePicker } from '../game/src/vehiclepicker.js';

const world = { heightAt: () => 0, terrainAt: () => 0, surfaceAt: () => 3,
  normalAt: (_x, _z, n) => n.set(0, 1, 0), waterLevelAt: () => -Infinity,
  treesNear() {}, buildingsNear: () => [], loadedAt: () => true,
  mapContains: () => true, extent: [-10000, -10000, 10000, 10000], pendingTiles: () => 0 };
let allowed = true, calls = 0;
const saved = new Map();
globalThis.localStorage = { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k) };
const vs = createVehicles({ scene: new THREE.Scene(), world, tuning: { ...TUNING_DEFAULTS }, canSwitch: () => { calls++; return allowed; } });
for (const from of ['car', 'bike', 'heli']) for (const { id } of VEHICLE_TYPES.jet) {
  vs.setType('jet', 'heli'); vs.switchTo(from === 'heli' ? 'jet' : from);
  assert(vs.setType('jet', id, { activate: true }));
  assert.equal(vs.current, vs.jet, `${from} → Garage ${id}`);
  assert.equal(vs.getType('jet'), id);
}
vs.switchTo('bike');
allowed = false; calls = 0;
assert.equal(vs.setType('jet', 'heli', { activate: true }), false);
assert.equal(calls, 1); assert.equal(vs.current, vs.bike, 'race refusal cannot be bypassed, even for selected type');
allowed = true;
globalThis.localStorage.setItem = () => { throw Error('storage unavailable'); };
assert.equal(vs.setType('jet', 'heli', { activate: true }), false);
assert.equal(vs.current, vs.jet, 'storage failure does not prevent entering aircraft');
vs.switchTo('car'); vs.setType('jet', 'fighter');
assert.equal(vs.current, vs.car, 'background type changes do not activate');

// Opening/rendering V is read-only: the policy is consulted only for a choice.
const handlers = [];
// Small DOM stand-in: exercise the real picker render/key paths without a renderer or browser.
const element = (dataset = {}) => {
  const children = new Map(), classes = new Set();
  return { dataset, style: { setProperty() {} }, append() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {},
    classList: { toggle(k, on) { on ? classes.add(k) : classes.delete(k); }, add(k) { classes.add(k); }, remove(k) { classes.delete(k); }, contains: k => classes.has(k) },
    querySelector(sel) { if (!children.has(sel)) children.set(sel, Object.assign(element(), { parentElement: this })); return children.get(sel); },
    querySelectorAll: () => [], contains: () => false,
    focus() { document.activeElement = this; }, blur() { document.activeElement = null; } };
};
const cards = ['car', 'bike', 'jet'].map(kind => element({ kind }));
const rows = ['car', 'bike', 'jet'].map(kind => element({ kind }));
const chips = Object.entries(VEHICLE_TYPES).flatMap(([kind, types]) => types.map(t => element({ kind, type: t.id })));
const root = element();
root.querySelectorAll = sel => sel === '.vp-card' ? cards : sel === '.vp-row' ? rows :
  sel.startsWith('.vp-chip') ? chips.filter(c => !sel.includes('data-kind') || sel.includes(`"${c.dataset.kind}"`)) : [];
const head = element(), body = element();
globalThis.document = { createElement: tag => tag === 'section' ? root : element(), head, body };
globalThis.addEventListener = (_name, fn) => handlers.push(fn);
let policyCalls = 0;
const picker = createVehicles({ scene: new THREE.Scene(), world, tuning: { ...TUNING_DEFAULTS }, canSwitch: () => { policyCalls++; return true; } });
createVehiclePicker({ vehicles: picker });
const press = code => handlers.at(-1)({ code, preventDefault() {}, stopImmediatePropagation() {} });
press('KeyV'); assert(picker.open); assert.equal(policyCalls, 0, 'opening picker must not quit a race');
press('Digit3'); assert.equal(picker.current, picker.jet); assert.equal(policyCalls, 1);
delete globalThis.document;

let handler, choose;
globalThis.addEventListener = (_name, fn) => { handler = fn; };
const spawn = createSpawn();
let pickerOpen = false;
spawn.start({ world, vehicles: { get open() { return pickerOpen; } }, car: vs.player, clearKeys() {}, challenges: { quit() {} }, settings: { closeWelcome() {}, showWelcome() {} },
  minimap: { pickSpawn(fn) { choose = fn; }, toggle() {} } });
const stopped = code => { let stop = false; handler({ code, preventDefault() {}, stopImmediatePropagation() { stop = true; } }); return stop; };
assert(stopped('KeyV'), 'initial spawn still blocks V');
assert(!spawn.pickerAllowed, 'picker cannot open on the initial spawn map');
await choose(0, 0);
let ready = false;
world.loadedAt = () => ready;
const home = spawn.goHome();
assert(spawn.blocked);
assert(spawn.pickerAllowed, 'picker can open while home streams');
for (const code of ['KeyV', 'Digit3', 'Numpad3', 'ArrowDown', 'Enter', 'Escape']) assert(!stopped(code), `home loading passes ${code}`);
assert(stopped('KeyW'), 'driving remains paused');
pickerOpen = true;
for (const code of ['ArrowLeft', 'ArrowRight', 'Tab', 'Space', 'NumpadEnter', 'KeyA', 'KeyW'])
  assert(!stopped(code), `open picker receives ${code} during home loading`);
pickerOpen = false;
vs.switchTo('jet'); ready = true; await home;
assert.equal(vs.current, vs.jet); assert(!spawn.blocked);
console.log('PASS Garage activation from car/bike/heli for all aircraft, selected type, race refusal, storage failure, background selection, V during H loading');
