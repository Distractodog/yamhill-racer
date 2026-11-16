// Node regression: real vehicle physics, fake peers, no renderer or sockets.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { Bike } from '../game/src/bike.js';
import { Jet } from '../game/src/jet.js';
import { makeTrack } from '../game/src/track.js';
import { createCollisions, resolveCollision, gridPosition, gridTrack, SHAPES } from '../game/src/mp/collide.js';
import { Track, parseState, predictedState } from '../game/src/mp/remotes.js';
import { createRaceCore } from '../game/src/mp/racecore.js';
import { createWorldSettings } from '../game/src/mp/menu.js';
import { Net } from '../game/src/mp/net.js';

const DT = 1 / 120;
const world = { heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3,
  waterLevelAt: () => -Infinity, normalAt: (_x, _z, n) => n.set(0, 1, 0), treesNear() {},
  buildingsNear: () => [], loadedAt: () => true, mapContains: () => true,
  extent: [-100000, -100000, 100000, 100000], spawn: [0, 0], rampAt: () => null };
const input = { throttle: 0, brake: 0, steer: 0, handbrake: false, lean: false,
  jet: { thr: 0, pitch: 0, roll: 0, yaw: 0, hold: false } };
function create(kind = 'car', x = 0, z = 0, yaw = 0) {
  const v = kind === 'car' ? new Car(world, { ...TUNING_DEFAULTS }) : kind === 'bike' ? new Bike(world) : new Jet(world);
  v.reset(x, z, yaw);
  for (let i = 0; i < 120; i++) v.step(DT, input);
  v.savePrev(); return v;
}
const sample = v => ({ v: v.kind, p: v.pos.toArray(), q: v.quat.toArray(), vel: v.vel.toArray(),
  glide: !!v.glide?.active, grounded: v.grounded, mode: v.mode, ghostUntil: v.ghostUntil || 0 });
function sane(v) {
  assert([...v.pos.toArray(), ...v.vel.toArray(), ...v.quat.toArray(), ...v.ang.toArray()].every(Number.isFinite), 'finite state');
  assert(1 - 2 * (v.quat.x ** 2 + v.quat.z ** 2) > 0, 'no flip');
  assert(v.pos.y < 3, 'no launch');
}
function peer() {
  const handlers = new Map();
  return { inGame: true, isHost: true, me: { id: 'A' }, players: new Map([['A', {}], ['B', {}], ['C', {}]]), t: 10000, sent: [],
    now() { return this.t; }, on(t, fn) { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t).add(fn); },
    off(t, fn) { handlers.get(t)?.delete(fn); }, emit(t, m) { for (const fn of handlers.get(t) || []) fn(m); },
    send(m) { this.sent.push(m); } };
}

// Each side resolves only itself. Fake network samples the other real car at 15 Hz.
for (const scenario of ['head-on', 'side-swipe', 'rear-end']) for (const kmh of [60, 150, 300]) {
  const speed = kmh / 3.6, rear = scenario === 'rear-end';
  const a = create('car', 0, -12), b = create('car', scenario === 'side-swipe' ? 1.4 : 0, 12, rear ? 0 : Math.PI);
  a.vel.z = rear ? speed + 5 : speed / 2; b.vel.z = rear ? 5 : -speed / 2;
  const tracks = new Map([['A', { track: new Track() }], ['B', { track: new Track() }]]);
  let hits = 0, maxYaw = 0;
  for (let i = 0; i < 360; i++) {
    const now = 10000 + i * DT * 1000;
    if (i % 8 === 0) for (const [id, v] of [['A', a], ['B', b]]) tracks.get(id).track.receive(parseState(sample(v), now), now);
    for (const v of [a, b]) { v.savePrev(); v.step(DT, input); }
    for (const [v, id, tie] of [[a, 'B', 1], [b, 'A', -1]]) {
      const vy = v.vel.y, y = v.pos.y, pitch = v.ang.x, roll = v.ang.z;
      hits += resolveCollision(v, predictedState(id, now + DT * 1000, tracks), DT, now, tie) ? 1 : 0;
      assert.equal(v.vel.y, vy); assert.equal(v.pos.y, y); assert.equal(v.ang.x, pitch); assert.equal(v.ang.z, roll);
      maxYaw = Math.max(maxYaw, Math.abs(v.ang.y)); sane(v);
    }
    if (Math.abs(a.pos.x - b.pos.x) < 1.8) assert(a.pos.z < b.pos.z, `${scenario} ${kmh}: passed through`);
  }
  assert(hits > 0, `${scenario} ${kmh}: fixture hit`);
  if (scenario === 'side-swipe') assert(maxYaw > 0.001, 'off-centre hit yaws');
  console.log(`PASS ${scenario} ${kmh} km/h: ${hits} contacts, no crossing/flip/launch/NaN`);
}

// Every ground vehicle pairing, both orientations, responds and preserves momentum by symmetry.
const GROUND = ['car', 'bike', 'jet'];
for (const kindA of GROUND) for (const kindB of GROUND) {
  const a = create(kindA), b = create(kindB, 0, (SHAPES[kindA].l + SHAPES[kindB].l) / 2 - 0.1, Math.PI);
  // Ground origins differ (jet gear vs car wheels), with actual overlapping body heights.
  a.vel.z = 10; b.vel.z = -10;
  const sa = sample(a), sb = sample(b), momentum = a.vel.z * SHAPES[kindA].mass + b.vel.z * SHAPES[kindB].mass;
  assert(resolveCollision(a, sb)); assert(resolveCollision(b, sa));
  assert(Math.abs(a.vel.z * SHAPES[kindA].mass + b.vel.z * SHAPES[kindB].mass - momentum) < 1e-6);
  assert(a.vel.z < b.vel.z, 'pair bounces apart');
  if (kindA === 'jet') assert(Math.abs(a.v - a.vel.z) < 1e-6, 'taxi speed updated');
  sane(a); sane(b);
}
console.log('PASS all 9 ground vehicle mass pairings and jet taxi speed');

// An entire bike width can be crossed in one sample: swept SAT must still intercept.
{
  const a = create('bike', 1.5, 0, Math.PI / 2), b = create('bike');
  a.prevPos.x = -2; a.vel.x = 300 / 3.6;
  assert(resolveCollision(a, sample(b)), 'swept narrow contact');
}
// Host off and SP are genuine pass-through; no calls into prediction when disabled.
for (const inGame of [false, true]) {
  const mp = peer(); mp.inGame = inGame;
  const a = create('car', 0, -10), b = create(); a.vel.z = 60 / 3.6;
  let calls = 0;
  const collisions = createCollisions({ mp, player: () => a, predictedState: () => { calls++; return sample(b); }, enabled: () => false });
  for (let i = 0; i < 240; i++) { a.savePrev(); a.step(DT, input); collisions.step(DT); }
  assert(a.pos.z > b.pos.z + 5); assert.equal(calls, 0); collisions.dispose();
}
// Ghost both sides, exact expiry, all reset paths, airborne/glider/height exclusions and stale data.
{
  const mp = peer(), a = create(), b = create('car', 0, 4.4), oldReset = a.reset;
  const collisions = createCollisions({ mp, player: () => a, vehicles: [a], predictedState: () => sample(b) });
  a.reset(0, 0, 0); assert.equal(a.ghostUntil, 13000); a.grounded = true;
  assert.equal(resolveCollision(a, sample(b), DT, 12999), false);
  assert.equal(resolveCollision(a, sample(b), DT, 13000), true);
  a.ghostUntil = 0; b.ghostUntil = 13000;
  assert.equal(resolveCollision(a, sample(b), DT, 12999), false);
  b.ghostUntil = 0;
  for (const override of [{ grounded: false }, { glide: true }, { p: [0, 100, 0] }, { v: 'jet', mode: 'air' }]) {
    assert.equal(resolveCollision(a, { ...sample(b), ...override }, DT, 20000), false);
  }
  a.glide = { active: true }; assert.equal(resolveCollision(a, sample(b)), false); a.glide = null;
  const track = new Track(), tracks = new Map([['B', { track }]]);
  track.receive(parseState({ ...sample(b), vel: [10, 0, 0], ghostUntil: 14000 }, 10000), 10000);
  assert.equal(predictedState('B', 10200, tracks).p[0], b.pos.x + 2);
  assert.equal(predictedState('B', 10200, tracks).ghostUntil, 14000);
  assert.equal(predictedState('B', 10301, tracks), null); assert.equal(predictedState('missing', 10000, tracks), null);
  mp.t = 20000; a.safe = [[0, 0, 0]]; a.resetToSafe(); assert.equal(a.ghostUntil, 23000);
  collisions.dispose(); assert.equal(a.reset, oldReset);
  // Small taps leave all angular components and vertical speed untouched.
  a.ghostUntil = 0; a.grounded = true; a.vel.z = 1; a.ang.set(0, 0, 0);
  assert(resolveCollision(a, sample(b))); assert.equal(a.ang.length(), 0);
}
console.log('PASS bump-off/SP pass-through, reset/remote ghost expiry, air/glider/height/stale exclusions and small taps');

// Grid stays separated and inside the extended corridor (16 slots, every vehicle, rotated start).
for (const kind of GROUND) for (const yaw of [0, 0.8, Math.PI]) {
  const start = { x: 25, z: 40, yaw }, points = [[25, 40, 6], [25 + Math.sin(yaw) * 200, 40 + Math.cos(yaw) * 200, 6]];
  const track = makeTrack(gridTrack(points, start, 16, kind));
  const slots = Array.from({ length: 16 }, (_, i) => gridPosition(start, i, kind));
  for (let i = 0; i < 16; i++) {
    const p = slots[i], v = create(kind, p.x, p.z, yaw), before = v.pos.clone();
    track.constrain(v); assert(v.pos.distanceTo(before) < 1e-6, `walls must not squash ${kind} ${yaw} slot ${i}: ${v.pos.distanceTo(before)}`);
    assert((p.x - start.x) * Math.sin(yaw) + (p.z - start.z) * Math.cos(yaw) < 0, 'behind start');
    for (let j = 0; j < i; j++) assert(Math.hypot(p.x - slots[j].x, p.z - slots[j].z) >= 7.99);
  }
}
{
  const mp = peer(), starts = [], timers = { setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {} };
  const challenges = { state: 'idle', list: [{ id: 'race', start: { x: 0, z: 0, yaw: 0 } }], start: (i, opts) => starts.push(opts) };
  const core = createRaceCore({ mp, challenges, timers });
  core.invite('race', ['B', 'C']); const inviteId = mp.sent[0].inviteId;
  mp.emit('invite-reply', { from: 'C', inviteId, accept: true });
  mp.emit('invite-reply', { from: 'B', inviteId, accept: true });
  assert.deepEqual(core.active.players, ['A', 'C', 'B']); assert.deepEqual(starts[0].grid, { x: -4, z: -8, yaw: 0 });
  assert.equal(starts[0].gridCount, 3); assert.equal(starts[0].sync.at, mp.now() + 5000); core.dispose();
  const settings = createWorldSettings({ mp, tuning: { car: {}, bike: {}, jet: {} }, atmosphere: { preset: 'day' }, timers });
  mp.emit('connected'); assert.equal(mp.sent.at(-1).settings.bump, true);
  settings.setBump(false); assert.equal(mp.sent.at(-1).settings.bump, false);
  mp.isHost = false; mp.players.set('host', { host: true });
  settings.setBump(true); assert.equal(settings.bump, false, 'guests cannot toggle');
  mp.emit('world', { from: 'host', mode: 'own', settings: { bump: true } }); assert.equal(settings.bump, true);
  mp.emit('world', { from: 'host', mode: 'own', settings: { bump: false } }); assert.equal(settings.bump, false);
  mp.emit('disconnected'); assert.equal(settings.bump, true); settings.dispose();
}
// Actual Net serializer includes the collision metadata.
{
  const net = new Net({ storage: null }), a = create('jet'); a.ghostUntil = 12345;
  net.inGame = true; net.setVehicleSource(() => ({ vehicle: a })); const sent = []; net.send = m => sent.push(m);
  net._tick(); const state = sent.find(m => m.t === 'state');
  assert.equal(state.ghostUntil, 12345); assert.equal(state.grounded, true); assert.equal(state.mode, 'ground');
}
console.log('PASS 16-slot grids/walls, accept order, host/guest settings and Net ghost metadata');
// Cheap far rejection with a full room; the director measures real frame times separately.
{
  const mp = peer(), a = create(), remote = sample(create('car', 1000, 1000));
  mp.players = new Map(Array.from({ length: 16 }, (_, i) => [String(i), {}])); mp.players.delete('A');
  const c = createCollisions({ mp, player: () => a, predictedState: () => remote });
  const t = performance.now(); for (let i = 0; i < 10000; i++) c.step(DT);
  console.log(`16 far peers: ${((performance.now() - t) / 10000).toFixed(4)} ms/step`); c.dispose();
}

// Real challenge placement + GO clock, with the project's minimal DOM shim (no browser rendering).
{
  const { Scene } = await import('three');
  const { createChallenges } = await import('../game/src/challenges.js');
  const previous = Object.fromEntries(['document', 'localStorage', 'addEventListener', 'fetch'].map(k => [k, globalThis[k]]));
  const canvas = { fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, fill() {} };
  const element = () => ({ style: {}, append() {}, querySelectorAll: () => [], getContext: () => canvas });
  globalThis.document = { createElement: element, head: element(), body: element() };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.addEventListener = () => {};
  const race = { id: 'grid', name: 'Grid test', start: { x: 0, z: 0, yaw: 0 },
    track: [[0, 0, 4], [0, 100, 4]], route: [[0, 0], [0, 100]], gates: [{ x: 0, z: 0, yaw: 0, w: 8 }, { x: 0, z: 100, yaw: 0, w: 8 }] };
  globalThis.fetch = async url => ({ ok: true, json: async () => url.endsWith('challenges.json') ? [race] : [] });
  const mp = peer(), v = create(), grid = gridPosition(race.start, 15);
  const collisions = createCollisions({ mp, player: () => v, vehicles: [v], predictedState: () => null });
  const ch = await createChallenges({ scene: new Scene(), world: { ...world, pendingTiles: () => 0 }, car: v, minimap: { open: false } });
  await ch.start(0, { mp: true, grid, gridCount: 16, sync: { at: 15000, now: () => mp.now() } });
  assert.equal(ch.state, 'countdown'); assert.equal(v.pos.x, grid.x); assert.equal(v.pos.z, grid.z);
  const before = v.pos.clone(); ch.constrain(); assert(v.pos.distanceTo(before) < 1e-6);
  assert.equal(v.ghostUntil, 18000, 'ghost lasts until three seconds after GO, not after placement');
  mp.t = 15000; ch.update(DT); assert.equal(ch.state, 'running');
  v.grounded = true;
  const remote = { ...sample(v), p: [v.pos.x, v.pos.y, v.pos.z + 4.4], ghostUntil: 0 };
  assert.equal(resolveCollision(v, remote, DT, 17999), false);
  assert.equal(resolveCollision(v, remote, DT, 18000), true);
  ch.quit(); collisions.dispose();
  for (const [k, value] of Object.entries(previous)) if (value === undefined) delete globalThis[k]; else globalThis[k] = value;
  console.log('PASS actual challenge grid placement, wall clearance, synchronized GO and exact 3-second immunity');
}
