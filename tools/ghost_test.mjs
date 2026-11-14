import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GHOST_KEY, GHOST_LIMITS, ghostCourse, validGhost, createGhostRecorder, ghostPoseAt, saveGhost, loadGhost, createGhost } from '../game/src/ghost.js';
const values = new Map(), storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) };
const ch = { id: 'test', vehicle: 'car', start: { x: 0, z: 0, yaw: 0 }, gates: [{ x: 0, z: 0 }, { x: 0, z: 100 }] };
const vehicle = { kind: 'car', pos: new THREE.Vector3(), quat: new THREE.Quaternion() }, course = ghostCourse(ch);
const recorder = createGhostRecorder(course, 'car', vehicle);
for (let i = 1; i <= 120; i++) { vehicle.pos.x = i / 12; vehicle.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), i / 120); recorder.sample(i / 120, vehicle); }
const run = recorder.finish(1, vehicle);
assert.equal(run.samples.length, 21); assert.ok(validGhost(run, course));
const p = new THREE.Vector3(), q = new THREE.Quaternion();
assert.ok(ghostPoseAt(run, .525, p, q)); assert.ok(Math.abs(p.x - 5.25) < 1e-9);
assert.ok(q.angleTo(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .525)) < 1e-7);
assert.equal(ghostPoseAt(run, 1.1, p, q), false);
assert.equal(saveGhost(storage, run), true); assert.deepEqual(loadGhost(storage, course, 'car'), run);
assert.equal(loadGhost(storage, course, 'bike'), null); assert.equal(loadGhost(storage, ghostCourse({ ...ch, gates: [] }), 'car'), null);
const slower = structuredClone(run); slower.time = 2; slower.samples = slower.samples.map(s => [s[0] * 2, ...s.slice(1)]);
assert.equal(saveGhost(storage, slower), false); assert.equal(loadGhost(storage, course, 'car').time, 1);
const faster = structuredClone(run); faster.time = .5; faster.samples = faster.samples.map(s => [s[0] / 2, ...s.slice(1)]);
assert.equal(saveGhost(storage, faster), true); assert.equal(loadGhost(storage, course, 'car').time, .5);
for (const raw of ['{broken', 'null', '{}', '[null]', JSON.stringify([{ ...run, samples: [[0, null]] }]), 'x'.repeat(GHOST_LIMITS.bytes + 1)]) {
 values.set(GHOST_KEY, raw); assert.equal(loadGhost(storage, course, 'car'), null);
}
assert.equal(saveGhost({ getItem: () => { throw Error('private'); }, setItem: () => { throw Error('quota'); } }, run), false);
for (const patch of [{ time: Infinity }, { samples: [[0, 0, 0, 0, 0, 0, 0, 0], run.samples.at(-1)] }, { samples: [...run.samples].reverse() }, { kind: 'unknown' }]) assert.equal(validGhost({ ...run, ...patch }, course), false);
values.clear(); for (let i = 0; i < 12; i++) assert.equal(saveGhost(storage, { ...run, course: `car:${i}` }), true);
assert.equal(JSON.parse(values.get(GHOST_KEY)).length, GHOST_LIMITS.races);
const tooLong = createGhostRecorder(course, 'car', vehicle); tooLong.sample(601, vehicle); assert.equal(tooLong.finish(601, vehicle), null);
const jump = structuredClone(run); jump.samples[11][1] += 1000;
assert.equal(ghostPoseAt(jump, .525, p, q), false);
// Exercise scene ownership, restart/quit, incompatible vehicle, and save-only-best.
values.clear(); saveGhost(storage, run); const scene = new THREE.Scene(), ghost = createGhost({ scene, storage });
ghost.start(ch, vehicle); ghost.update(.2, vehicle); assert.equal(scene.children.length, 1);
const mesh = scene.children[0]; assert.equal(mesh.name, 'race-ghost'); assert.ok(mesh.material.transparent); assert.equal(mesh.material.depthWrite, false); assert.equal(mesh.castShadow, false);
ghost.start(ch, vehicle); assert.equal(scene.children.length, 1); assert.equal(mesh.parent, null);
ghost.update(.2, { ...vehicle, kind: 'bike' }); assert.equal(scene.children.length, 0);
ghost.start(ch, vehicle); ghost.stop(); assert.equal(scene.children.length, 0);
values.clear(); ghost.start(ch, vehicle); ghost.update(.2, vehicle); ghost.finish(.3, vehicle, false); assert.equal(values.size, 0);
ghost.start(ch, vehicle); ghost.update(.2, vehicle); ghost.finish(.3, vehicle, true); assert.ok(loadGhost(storage, course, 'car')); assert.equal(scene.children.length, 0);
for (const kind of ['bike', 'jet']) {
 const c = { ...ch, vehicle: kind }; saveGhost(storage, { ...run, course: ghostCourse(c), kind });
 ghost.start(c, { ...vehicle, kind }); ghost.update(.2, { ...vehicle, kind }); assert.equal(scene.children.length, 1); ghost.stop();
}
console.log('PASS: 20 Hz capture, pose interpolation, faster-only persistence, course/vehicle isolation, corrupt/quota-safe bounded storage, reset gaps, all vehicle silhouettes, restart/quit/switch cleanup.');
// Integration: a real challenge countdown/finish/retry/quit drives the ghost hooks.
const originalGlobals = { document: globalThis.document, localStorage: globalThis.localStorage, fetch: globalThis.fetch, addEventListener: globalThis.addEventListener };
try {
 values.clear(); globalThis.localStorage = storage;
 const context = { fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, fill() {} };
 const element = () => ({ style: {}, append() {}, appendChild() {}, querySelectorAll: () => [], getContext: () => context });
 globalThis.document = { createElement: element, head: element(), body: element() }; globalThis.addEventListener = () => {};
 const race = { ...ch, name: 'Ghost integration', length: 10, route: [[0, 0], [0, 10]], gates: [{ x: 0, z: 0, yaw: 0, w: 20 }, { x: 0, z: 10, yaw: 0, w: 20 }] };
 globalThis.fetch = async url => ({ ok: true, json: async () => url.endsWith('challenges.json') ? [race] : [] });
 const world = { loadedAt: () => true, pendingTiles: () => 0, heightAt: () => 0, setRamps() {}, setFixedRamps() {} };
 const driver = { kind: 'car', pos: new THREE.Vector3(), quat: new THREE.Quaternion(), vel: new THREE.Vector3(), safe: [], reset(x, z, yaw) { this.pos.set(x, 1, z); this.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw); } };
 const { createChallenges } = await import('../game/src/challenges.js');
 const scene2 = new THREE.Scene(), races = await createChallenges({ scene: scene2, world, car: driver, minimap: {} });
 await races.start(0); assert.equal(races.state, 'countdown'); races.update(3.1); assert.equal(races.state, 'running');
 for (let i = 1; i <= 10; i++) { driver.pos.z = i; races.update(.1); }
 assert.equal(races.state, 'finished'); assert.ok(loadGhost(storage, ghostCourse(race), 'car'));
 await races.start(0); races.update(3.1); races.update(.1); assert.ok(scene2.children.some(o => o.name === 'race-ghost' && o.visible));
 races.quit(); assert.equal(scene2.children.some(o => o.name === 'race-ghost'), false);
 console.log('PASS: actual challenge countdown, finish, best-run save, retry replay, and quit integration.');
} finally { Object.assign(globalThis, originalGlobals); }
