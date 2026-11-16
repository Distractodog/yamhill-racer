// Multiplayer remotes (game/src/mp/remotes.js) without a renderer: smoothing maths (interpolate, extrapolate, hold,
// snap, late-state blending), mesh lifecycle with a stub `mp` (roster / state / skin / left / closed), level of detail,
// name tags, map dots, and the per-frame cost of 16 remotes.   node tools/mp_remotes_test.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DELAY, MAX_EXTRAP, SNAP, STALE, TAG_HIDE, parseState, pushState, poseAt, Track, bake, createRemotes, makeRemotes } from '../game/src/mp/remotes.js';
import { buildCarModel } from '../game/src/carmodel.js';

const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);
const yawQ = yaw => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
const st = (t, x, z, vx = 0, vz = 0, extra = {}) => parseState({ p: [x, 0, z], q: yawQ(extra.yaw || 0).toArray(), vel: [vx, 0, vz], v: extra.v || 'car', glide: extra.glide }, t);
const P = new THREE.Vector3(), Q = new THREE.Quaternion(), V = new THREE.Vector3();

// ---------------------------------------------------------------- parsing + buffer
assert.equal(parseState({ p: [0, 0, NaN], q: [0, 0, 0, 1] }, 0), null, 'NaN position rejected');
assert.equal(parseState({ p: [0, 0, 0], q: [0, 0, 0, 0] }, 0), null, 'zero quaternion rejected');
assert.equal(parseState({ p: [0, 0], q: [0, 0, 0, 1] }, 0), null, 'short position rejected');
const ps = parseState({ p: [1, 2, 3], q: [0, 0, 0, 2], vel: ['x'], v: 'tank' }, 5);
assert.deepEqual([ps.v, ps.vel, ps.q.w, ps.glide], ['car', [0, 0, 0], 1, false], 'defaults: car, zero vel, normalised q');
for (const v of ['jetski', 'boat']) assert.equal(parseState({ p: [0, 0, 0], q: [0, 0, 0, 1], v }, 0).v, 'car', `${v} sanitizes to car`);
{
  const buf = [];
  assert.ok(pushState(buf, st(100, 0, 0))); assert.ok(pushState(buf, st(166, 1, 0)));
  assert.equal(pushState(buf, st(120, 9, 9)), false, 'older than newest is dropped');
  assert.ok(pushState(buf, st(166, 2, 0))); assert.equal(buf.length, 2); assert.equal(buf[1].p[0], 2, 'same time replaces');
  for (let i = 0; i < 50; i++) pushState(buf, st(200 + i * 66, i, 0));
  assert.ok(buf.length <= 30, 'buffer capped');
  pushState(buf, st(10000, 0, 0), 10000 - DELAY);
  assert.ok(buf.length >= 2 && buf.length <= 3, `old states trimmed (${buf.length})`);
}

// ---------------------------------------------------------------- poseAt: interpolate / extrapolate / hold / early / teleport
{
  const buf = [st(1000, 0, 0, 30, 0), st(1066, 2, 0, 30, 0, { yaw: 0.4 })];
  assert.equal(poseAt([], 0, P, Q), 'none');
  assert.equal(poseAt(buf, 900, P, Q), 'early'); near(P.x, 0);
  assert.equal(poseAt(buf, 1033, P, Q, V), 'interp'); near(P.x, 1); near(V.x, 30);
  near(Q.angleTo(yawQ(0.2)), 0, 1e-6, 'slerp halfway');
  assert.equal(poseAt(buf, 1066 + 100, P, Q), 'extrap'); near(P.x, 2 + 30 * 0.1, 1e-9, 'extrapolates along vel');
  assert.equal(poseAt(buf, 1066 + MAX_EXTRAP, P, Q), 'extrap'); near(P.x, 2 + 30 * 0.3, 1e-9);
  assert.equal(poseAt(buf, 1066 + 2000, P, Q), 'hold'); near(P.x, 2 + 30 * MAX_EXTRAP / 1000, 1e-9, 'holds at the 300 ms point');
  const tp = [st(0, 0, 0), st(66, 500, 0)];        // a reset: 500 m in one frame at standstill
  poseAt(tp, 50, P, Q); near(P.x, 0, 1e-9, 'teleport: no slide');
  const jet = [st(0, 0, 0, 480, 0), st(66, 31.7, 0, 480, 0)];    // 1730 km/h covers 32 m per state: still interpolated
  poseAt(jet, 33, P, Q); near(P.x, 15.85, 1e-6, 'fast jet interpolates');
  // 15 Hz states along a circle: interpolation stays within 0.3 m of the true path at 30 m/s
  const R = 60, w = 30 / R, circ = [];
  for (let t = 0; t <= 2000; t += 66) circ.push(st(t, R * Math.sin(w * t / 1000), R * Math.cos(w * t / 1000), 30 * Math.cos(w * t / 1000), -30 * Math.sin(w * t / 1000)));
  let worst = 0;
  for (let t = 100; t < 1900; t += 7) { poseAt(circ, t, P, Q); worst = Math.max(worst, Math.abs(Math.hypot(P.x, P.z) - R)); }
  assert.ok(worst < 0.3, `circle chord error ${worst}`);
}

// ---------------------------------------------------------------- Track: late states blend in, big errors snap
{
  const tr = new Track(); let now = 1000;
  tr.receive(st(now, 0, 0, 20, 0), now);
  now += 66; tr.receive(st(now, 1.32, 0, 20, 0), now);
  // the next state is 400 ms late: we extrapolate to 1066 + 300 ms, then hold
  now += 400 + DELAY; tr.pose(now, 1 / 60, P, Q); const before = P.x;
  near(before, 1.32 + 20 * MAX_EXTRAP / 1000, 0.02, 'extrapolated then held');
  // the player had actually stopped 1 m short: the state arrives; what's drawn mustn't jump
  tr.receive(st(now - DELAY, 6, 0, 0, 0), now);
  tr.pose(now, 0, P, Q); near(P.x, before, 1e-6, 'no jump when a late state lands');
  for (let i = 0; i < 120; i++) { now += 1000 / 60; tr.pose(now, 1 / 60, P, Q); }
  near(P.x, 6, 0.01, 'eases onto the real position');
  // a correction over SNAP metres snaps
  const tr2 = new Track(); now = 0;
  tr2.receive(st(0, 0, 0, 200, 0), 0); tr2.receive(st(66, 13.2, 0, 200, 0), 66);
  now = 66 + 300 + DELAY; tr2.pose(now, 1 / 60, P, Q);
  tr2.receive(st(now - DELAY, -200, 0, 0, 0), now); tr2.pose(now, 0, P, Q);
  near(P.x, -200, 1e-6, 'snaps when > SNAP m off'); near(tr2.off.length(), 0);
  // stale after STALE ms
  assert.equal(tr2.stale(now + STALE - 1), false); assert.equal(tr2.stale(now + STALE + 1), true);
  assert.equal(new Track().stale(0), true);
}

// ---------------------------------------------------------------- bake: one draw call, colours carried over
{
  const car = buildCarModel({ paint: 0x2266ff });
  let meshes = 0; car.traverse(o => { if (o.isMesh) meshes++; });
  const b = bake(car);
  const extraCount = b.extras.size;
  assert.equal(extraCount, 0, 'plain car: nothing left unmerged');
  assert.ok(meshes >= 10, `source has ${meshes} meshes`);
  const col = b.mesh.geometry.attributes.color, c = new THREE.Color(0x2266ff);
  let hasPaint = false; for (let i = 0; i < col.count && !hasPaint; i++) hasPaint = Math.abs(col.getX(i) - c.r) + Math.abs(col.getY(i) - c.g) + Math.abs(col.getZ(i) - c.b) < 1e-4;
  assert.ok(hasPaint, 'paint colour baked into vertex colours');
}

// ---------------------------------------------------------------- lifecycle with a stub mp
function stubMp(id = 'me') {
  const ls = new Map(); let t = 50000;
  return {
    me: { id, code: 'ABCDE', name: 'Me' }, inGame: true, isHost: false, players: new Map(),
    now: () => t, advance(ms) { t += ms; },
    on(type, fn) { if (!ls.has(type)) ls.set(type, new Set()); ls.get(type).add(fn); },
    off(type, fn) { ls.get(type)?.delete(fn); },
    emit(type, msg) { for (const f of ls.get(type) || []) f(msg); },
    listeners: () => [...ls.values()].reduce((n, s) => n + s.size, 0), send() {},
  };
}
const skin = (vehicle, body, glider) => ({ vehicle, colors: { body }, glider });
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.3, 2200);
let markerFn = null; const minimap = { setExtraMarkers: f => { markerFn = f; } };
const mp = stubMp();
const R = await createRemotes({ scene, camera, minimap, mp });
assert.equal(typeof markerFn, 'function', 'minimap hook registered');
assert.ok(mp.listeners() >= 8, 'listens to mp');
const group = scene.getObjectByName('mp-remotes'); assert.ok(group);
const roster = [{ id: 'me', name: 'Me', host: false }, { id: 'a', name: 'Alice', host: true, skin: skin('car', '#1188ff') }, { id: 'b', name: 'Bob', skin: skin('bike', '#22cc44', { wing: '#123456' }) }];
for (const p of roster) mp.players.set(p.id, p);
mp.emit('roster', { t: 'roster', players: roster });
assert.equal(R.count, 2, 'two remotes, not me');
const send = (from, x, z, extra = {}) => mp.emit('state', { t: 'state', from, srvT: mp.now(), p: [x, extra.y || 0, z], q: yawQ(extra.yaw || 0).toArray(), vel: extra.vel || [0, 0, 0], v: extra.v || 'car', glide: !!extra.glide, ts: mp.now() });
const frame = (ms = 1000 / 60) => { mp.advance(ms); R.update(ms / 1000); };
const byId = id => R.list().find(r => r.id === id);
camera.position.set(0, 2, -10); camera.lookAt(0, 0, 0);
send('a', 0, 0); send('b', 5, 0, { v: 'bike' }); send('me', 9, 9);
for (let i = 0; i < 10; i++) { frame(); if (i % 4 === 0) { send('a', 0, 0); send('b', 5, 0, { v: 'bike' }); } }
assert.equal(R.count, 2, 'my own state is ignored');
assert.deepEqual([byId('a').visible, byId('a').kind, byId('b').kind], [true, 'car', 'bike']);
near(byId('a').x, 0, 1e-6); near(byId('b').x, 5, 1e-6);
assert.equal(byId('a').body, '#1188ff', 'their own colours'); assert.equal(byId('a').tag, true, 'name tag shown near');
assert.equal(byId('a').host, true);
const remoteRoot = id => group.children.filter(o => o.name === 'mp-remote')[[...R.list()].findIndex(r => r.id === id)];
const drawCalls = root => { let n = 0; root.traverseVisible(o => { if (o.isMesh) n++; }); return n; };
assert.equal(drawCalls(remoteRoot('a')), 0, 'near: no stand-in block');
assert.ok(drawCalls(R.model('a')) <= 5, `near car is ≤ 5 draw calls: body + 4 wheels (${drawCalls(R.model('a'))})`);
// skin change: colour follows, mesh rebuilt
mp.emit('skin', { t: 'skin', from: 'a', skin: skin('car', '#ff00aa') });
frame(); assert.equal(byId('a').body, '#ff00aa');
let found = false; R.model('a').traverseVisible(o => { if (o.isMesh && o.geometry.attributes.color) { const a = o.geometry.attributes.color, c = new THREE.Color('#ff00aa'); for (let i = 0; i < a.count && !found; i++) found = Math.abs(a.getX(i) - c.r) + Math.abs(a.getY(i) - c.g) + Math.abs(a.getZ(i) - c.b) < 1e-4; } });
assert.ok(found, 'rebuilt body carries the new paint');
// switch vehicle to the jet, then glide on the bike
send('a', 0, 0, { v: 'jet' }); for (let i = 0; i < 12; i++) frame();
assert.equal(byId('a').kind, 'jet');
// the jet flame grows with speed, and the change reaches its world matrix (what the renderer draws)
const flameOf = root => { let f = null; root.traverse(o => { if (o.isMesh && o.material.blending === THREE.AdditiveBlending) f = o; }); return f; };
const flameLength = speed => {
  for (let i = 0; i < 12; i++) { if (i % 4 === 0) send('a', 0, 0, { v: 'jet', vel: [0, 0, speed] }); frame(); }
  scene.updateMatrixWorld(true); const f = flameOf(R.model('a'));
  return f.visible ? new THREE.Vector3().setFromMatrixColumn(f.matrixWorld, 2).length() : 0;
};
const slowFlame = flameLength(20), fastFlame = flameLength(250);
assert.ok(slowFlame > 0 && fastFlame > slowFlame * 1.5, `flame world length follows speed (${slowFlame.toFixed(2)} → ${fastFlame.toFixed(2)})`);
assert.equal(flameLength(0), 0, 'no flame standing still');
for (let i = 0; i < 30; i++) { if (i % 4 === 0) send('b', 5, 0, { v: 'bike', glide: true, y: 20 }); frame(); }
assert.equal(byId('b').glide, true);
const glider = R.model('b').children.find(o => o.isMesh && o.material.side === THREE.DoubleSide);
assert.ok(glider?.visible, 'glider open while gliding');
const sail = new THREE.Color('#123456'), gc = glider.geometry.attributes.color;
let wing = false; for (let i = 0; i < gc.count && !wing; i++) wing = Math.abs(gc.getX(i) - sail.r) < 1e-4 && Math.abs(gc.getZ(i) - sail.b) < 1e-4;
assert.ok(wing, 'glider in their wing colour');
for (let i = 0; i < 40; i++) { if (i % 4 === 0) send('b', 5, 0, { v: 'bike', glide: false, y: 20 }); frame(); }
assert.equal(glider.visible, false, 'glider folds away');
// far: low-poly stand-in, tag hidden past TAG_HIDE, full model not built for someone only ever seen far away
mp.players.set('c', { id: 'c', name: 'Cara', skin: skin('car', '#ffaa00') });
send('c', 0, 900); for (let i = 0; i < 10; i++) { if (i % 4 === 0) send('c', 0, 900); frame(); }
const cRoot = remoteRoot('c');
assert.deepEqual([byId('c').far, byId('c').tag, byId('c').name], [true, false, 'Cara']);
assert.equal(drawCalls(cRoot), 1, 'far = one block');
assert.equal(R.model('c'), null, 'no full model built while far');
send('c', 0, TAG_HIDE - 50); for (let i = 0; i < 12; i++) { if (i % 4 === 0) send('c', 0, TAG_HIDE - 50); frame(); }
assert.deepEqual([byId('c').far, byId('c').tag], [true, true], 'tag back inside 400 m, still the block past 220 m');
send('c', 0, 30); for (let i = 0; i < 20; i++) { if (i % 4 === 0) send('c', 0, 30); frame(); }
assert.equal(byId('c').far, false, 'full model up close');
// stale: hidden after STALE ms without states, shown again when they come back
for (let t = 0; t < STALE + 200; t += 100) { if (t % 400 === 0) { send('a', 0, 0, { v: 'jet' }); send('c', 0, 30); } frame(100); }
assert.equal(byId('b').visible, false, 'no state for 3 s → hidden'); assert.equal(byId('a').visible, true);
send('b', 5, 0, { v: 'bike' }); for (let i = 0; i < 12; i++) frame();
assert.equal(byId('b').visible, true, 'back when states return');
// minimap dots: corner draws everyone (edge-clamped), full map only who is on screen
const calls = [];
const ctx = { canvas: { width: 200, height: 200 }, save() {}, restore() {}, beginPath() {}, fill() {}, stroke() {}, strokeText() {}, fillText: (t, x, y) => calls.push(['text', t]), arc: (x, y) => calls.push(['dot', x, y]) };
markerFn(ctx, (x, z) => [100 + x, 100 + z], 1, 'corner');
assert.equal(calls.filter(c => c[0] === 'dot').length, 3, 'a dot for each remote');
assert.ok(calls.some(c => c[1] === 'Alice') && calls.some(c => c[1] === 'Bob'), 'named');
calls.length = 0; markerFn(ctx, (x, z) => [100 + x * 10, 100 + z * 10], 1, 'full');
assert.equal(calls.filter(c => c[0] === 'dot').length, 2, 'full map skips Cara off-screen');
// leave / roster / closed / dispose clean up
const before = group.children.length;
mp.emit('left', { t: 'left', id: 'c' }); assert.equal(R.count, 2); assert.equal(group.children.length, before - 3, 'stand-in, tag and model removed');
mp.emit('roster', { t: 'roster', players: roster.filter(p => p.id !== 'b') }); assert.deepEqual(R.list().map(r => r.id), ['a']);
mp.emit('joined', { t: 'joined', player: { id: 'd', name: 'Dee' } }); assert.equal(R.count, 2);
mp.emit('closed', { t: 'closed', reason: 'no-host' }); assert.equal(R.count, 0); assert.equal(group.children.length, 0, 'closed clears all');
send('a', 0, 0); assert.equal(R.count, 1); mp.inGame = false; frame(); assert.equal(R.count, 0, 'leaving the game clears');
mp.inGame = true; R.dispose(); assert.equal(mp.listeners(), 0, 'dispose unsubscribes'); assert.equal(markerFn, null); assert.equal(group.parent, null);
// no mp at all (single player): inert but safe
const solo = makeRemotes({ scene, camera, minimap: null, mp: null }); solo.update(1 / 60); solo.receive({ t: 'state', from: 'x', p: [0, 0, 0], q: [0, 0, 0, 1] }); assert.equal(solo.count, 1); solo.dispose();

// ---------------------------------------------------------------- new kinds and types, lights
// Supported types and legacy kind sanitizers use the same paint and light pipeline.
{
  const m3 = stubMp(), scene3 = new THREE.Scene();
  let dark = 0;
  const R3 = makeRemotes({ scene: scene3, camera, mp: m3, fx: false, night: () => dark });
  camera.position.set(0, 3, -25); camera.lookAt(0, 0, 0);
  const people = [['t', 'car', 'truck', 0], ['s', 'bike', 'sport', 6], ['j', 'jetski', undefined, 12], ['o', 'boat', undefined, 20], ['x', 'car', 'bogus', -8]];
  m3.emit('roster', { t: 'roster', players: people.map(([id, vehicle, type]) => ({ id, name: id, skin: { vehicle, type, colors: { body: '#3366cc' } } })) });
  const by = id => R3.list().find(r => r.id === id);
  const st = (id, v, x, extra = {}) => m3.emit('state', { t: 'state', from: id, srvT: m3.now(), p: [x, 0, 0], q: (extra.q || yawQ(0)).toArray(), vel: [0, 0, 8], v, ts: m3.now(), ...extra.a });
  const go = (n, extra = {}) => { for (let i = 0; i < n; i++) { if (i % 4 === 0) for (const [id, v, , x] of people) st(id, v, x, extra[id] || {}); m3.advance(1000 / 60); R3.update(1 / 60); } };
  go(16);
  assert.deepEqual(people.map(([id]) => [by(id).kind, by(id).type, by(id).model]),
    [['car', 'truck', 'car-truck'], ['bike', 'sport', 'bike-sport'], ['car', 'race', by('j').model], ['car', 'race', by('o').model], ['car', 'race', by('x').model]],
    'kind + type → that model (an unknown type falls back to the Race car)');
  assert.notEqual(by('x').model, 'car-truck');
  for (const id of ['j', 'o']) assert.equal(by(id).model, by('x').model, 'legacy kind uses the car stand-in');
  // Legacy animation packets can have three contacts and a leaning pose; the car stays valid.
  const lean = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), .3);
  go(16, { j: { q: lean, a: { st: .8, ln: .3, w: [0, 0, -1] } }, o: { a: { st: -.6, ln: .1, w: [0, 0, 0] } } });
  for (const id of ['j', 'o']) {
    assert.equal(by(id).kind, 'car');
    assert.ok(R3.model(id).position.toArray().every(Number.isFinite));
  }
  // an older client (no animation fields): the static model, posed, no crash
  go(8, { j: { a: {} } }); assert.equal(by('j').visible, true);
  // lights: off by day, lenses at night (no light sources), brake lights with the brake, the type's own anchors
  const lightsOf = id => by(id).anim.lights, isLight = root => { let n = 0; root.traverse(o => { if (o.isLight) n++; }); return n; };
  assert.deepEqual(people.map(([id]) => lightsOf(id).length), [0, 0, 0, 0, 0], 'day: no lenses lit');
  dark = 1; go(8, { t: { a: { br: 1, w: [9, 9, 9, 9] } }, x: { a: { w: [9, 9, 9, 9] } } });
  assert.deepEqual(lightsOf('t').sort(), ['head', 'head', 'tail', 'tail'], 'truck: two head + two tail');
  assert.deepEqual(lightsOf('s').sort(), ['head', 'tail'], 'sport bike: one each');
  for (const id of ['j', 'o']) assert.ok(['head', 'tail'].every(k => lightsOf(id).includes(k)), `${id}: car head and tail lights`);
  const tailI = id => { let v = 0; R3.model(id).traverse(o => { if (o.name === 'vehicle-light-tail') v = Math.max(v, o.material.emissiveIntensity); }); return v; };
  assert.ok(tailI('t') > tailI('x'), 'braking truck: brighter tail lights');
  assert.equal(isLight(scene3), 0, 'remotes add no light sources');
  const truckHead = R3.model('t').getObjectByName('vehicle-light-head');
  assert.ok(truckHead.parent.parent === R3.model('t').userData.lightMount, 'lenses ride on the type model\'s body');
  // type change in the skin rebuilds the model; disposal clears the lenses
  m3.emit('skin', { t: 'skin', from: 't', skin: { vehicle: 'car', type: 'hatch', colors: { body: '#3366cc' } } }); go(8);
  assert.equal(by('t').model, 'car-hatch');
  dark = 0; go(4); assert.equal(lightsOf('t').length, 0, 'lights off again by day');
  R3.dispose(); assert.equal(scene3.children.length, 0);
  console.log('PASS new kinds/types: truck, sport bike, legacy kind sanitizers; older client; lenses at night with brake lights; no light sources; type change rebuilds');
}

// ---------------------------------------------------------------- 16 remotes: per-frame cost
{
  const m2 = stubMp(), scene2 = new THREE.Scene(), R2 = makeRemotes({ scene: scene2, camera, mp: m2 });
  camera.position.set(0, 3, -40); camera.lookAt(0, 0, 0);
  const kinds = ['car', 'bike', 'jet'], ids = Array.from({ length: 16 }, (_, i) => 'p' + i);
  m2.emit('roster', { t: 'roster', players: ids.map((id, i) => ({ id, name: 'Racer' + (100 + i), skin: skin(kinds[i % 3], '#' + (0x123456 * (i + 1) % 0xffffff).toString(16).padStart(6, '0')) })) });
  let t = 0;
  const tick = () => {
    for (const [i, id] of ids.entries()) {
      const a = t / 1000 * 0.5 + i, r = 20 + i * 15;   // circles from 20 m to 245 m: some near, some far
      m2.emit('state', { t: 'state', from: id, srvT: m2.now(), p: [r * Math.sin(a), 1, r * Math.cos(a)], q: yawQ(a + Math.PI / 2).toArray(), vel: [r * 0.5 * Math.cos(a), 0, -r * 0.5 * Math.sin(a)], v: kinds[i % 3], glide: i === 4 });
    }
  };
  // warm-up builds every model once
  for (let f = 0; f < 120; f++) { if (f % 4 === 0) tick(); m2.advance(1000 / 60); t += 1000 / 60; R2.update(1 / 60); }
  const N = 1200; let total = 0, worst = 0;
  for (let f = 0; f < N; f++) {
    if (f % 4 === 0) tick();                              // 15 Hz states from 16 players
    m2.advance(1000 / 60); t += 1000 / 60;
    const a = performance.now(); R2.update(1 / 60); const ms = performance.now() - a; total += ms; worst = Math.max(worst, ms);
  }
  // receiving states is part of the cost too
  const b0 = performance.now(); for (let k = 0; k < 100; k++) { tick(); m2.advance(66); R2.update(0.066); } const per15 = (performance.now() - b0) / 100;
  let calls16 = 0; scene2.traverseVisible(o => { if (o.isMesh || o.isSprite) calls16++; });
  const vis = R2.list(); const nearN = vis.filter(r => !r.far).length;
  console.log(`16 remotes: update ${(total / N).toFixed(3)} ms avg, ${worst.toFixed(3)} ms worst; 16 states + update ${per15.toFixed(3)} ms; ${nearN} near / ${16 - nearN} far; ${calls16} visible meshes+tags`);
  assert.equal(vis.filter(r => r.visible).length, 16);
  assert.ok(total / N < 0.5, 'update well under 1 ms per frame in Node');
  // animated up close: car / bike = body + wheels (5), jet = body, 4 control surfaces, 3 legs, 3 wheels, flame (12)
  assert.ok(calls16 <= 16 * 8 + 4, `draw calls stay small (${calls16})`);
  R2.dispose();
}
console.log('PASS mp remotes: parse/buffer, interpolate/extrapolate/hold/teleport, late-state blend + snap, stale, bake, roster/state/skin/vehicle/glider lifecycle, far stand-in, tags, map dots, cleanup, 16-remote cost');
