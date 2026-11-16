import assert from 'node:assert/strict';
import { createWorldSettings } from '../game/src/mp/menu.js';
import { createDayCycle } from '../game/src/daycycle.js';
class FakeNet {
  me = { id: 'guest' }; inGame = true; isHost = false; players = new Map([['host', { host: true }]]); listeners = new Map(); sent = [];
  on(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, new Set()); this.listeners.get(t).add(fn); }
  off(t, fn) { this.listeners.get(t)?.delete(fn); }
  emit(t, msg = {}) { this.listeners.get(t)?.forEach(fn => fn(msg)); }
  send(msg) { this.sent.push(msg); }
}
const timeouts = new Map(); let poll, tick = 0;
const timers = { setInterval(fn) { poll = fn; return 1; }, clearInterval() { poll = null; }, setTimeout(fn, ms) { assert.equal(ms, 300); timeouts.set(++tick, fn); return tick; }, clearTimeout(id) { timeouts.delete(id); } };
const mp = new FakeNet(), tuning = { car: { accel: 23 }, bike: { accel: 14 }, jet: { thrust: 11 } };
let locked = false, refreshes = 0;
// Applying or restoring world state must never use the persistent atmosphere path.
const atmosphere = { preset: 'golden', setPreset(id, persist) { assert.equal(persist, false); this.preset = id; } };
const own = structuredClone(tuning);
const controller = createWorldSettings({ mp, tuning, atmosphere, timers, lock: value => { locked = value; }, refresh: () => refreshes++ });
const remote = { t: 'world', from: 'host', mode: 'host', settings: { tuning: { car: { accel: 40 }, bike: { accel: 30 }, jet: { thrust: 25 } }, atmosphere: { preset: 'night' } } };
mp.emit('world', { ...remote, from: 'impostor' }); assert.deepEqual(tuning, own);
mp.emit('world', remote); assert.equal(locked, true); assert.equal(tuning.car.accel, 40); assert.equal(atmosphere.preset, 'night');
mp.emit('world', { ...remote, settings: { ...remote.settings, tuning: { car: { accel: 50 } } } });
mp.emit('world', { ...remote, mode: 'own' }); assert.deepEqual(tuning, own); assert.equal(atmosphere.preset, 'golden'); assert.equal(locked, false);
// A second host-mode transition snapshots newly chosen personal settings.
tuning.car.accel = 29;
for (const event of ['kicked', 'closed', 'disconnected']) { mp.emit('world', remote); mp.emit(event); assert.equal(tuning.car.accel, 29); assert.equal(atmosphere.preset, 'golden'); assert.equal(locked, false); }
mp.isHost = true; mp.emit('connected'); assert.equal(mp.sent.length, 1); assert.equal(mp.sent[0].mode, 'host');
tuning.car.accel = 32; poll(); tuning.bike.accel = 18; poll(); assert.equal(timeouts.size, 1); for (const fn of timeouts.values()) fn(); timeouts.clear();
assert.equal(mp.sent.length, 2); assert.equal(mp.sent[1].settings.tuning.bike.accel, 18);
atmosphere.preset = 'midday'; poll(); assert.equal(timeouts.size, 1); for (const fn of timeouts.values()) fn(); timeouts.clear(); assert.equal(mp.sent.at(-1).settings.atmosphere.preset, 'midday');
controller.setMode('own'); assert.equal(mp.sent.at(-1).mode, 'own');
mp.isHost = false; const count = mp.sent.length; controller.setMode('host'); assert.equal(mp.sent.length, count);
controller.dispose(); assert.equal(poll, null); assert.equal([...mp.listeners.values()].every(set => set.size === 0), true); assert.ok(refreshes > 0);
// Day/night cycle (daycycle.js): the host sends its clock with every change and every 30 s; a guest follows it and
// goes back to its own settings afterwards.
{
  const hostCycle = createDayCycle({ seed: 2 }), guestCycle = createDayCycle({ seed: 8, settings: { cycle: false, look: 'golden', weather: 'clear' } });
  const hostNet = new FakeNet(); hostNet.isHost = true; hostNet.me = { id: 'host' };
  const hostWorld = createWorldSettings({ mp: hostNet, tuning: structuredClone(own), atmosphere: hostCycle, timers });
  hostNet.emit('connected'); const first = hostNet.sent.at(-1).settings.atmosphere;
  assert.equal(first.cycle, true); assert.equal(first.time, 0); assert.equal(first.speed, 1); assert.equal(typeof first.raining, 'boolean');
  for (let i = 0; i < 100; i++) hostCycle.update(1);
  for (let i = 0; i < 299; i++) poll();
  assert.equal(hostNet.sent.length, 1, 'no clock resend before 30 s'); poll(); assert.equal(hostNet.sent.length, 2, 'clock resent every 30 s');
  assert.equal(hostNet.sent.at(-1).settings.atmosphere.time, 100);
  hostCycle.jump('night'); poll(); assert.equal(timeouts.size, 1, 'a jump is a change'); for (const fn of timeouts.values()) fn(); timeouts.clear();
  const sent = hostNet.sent.at(-1); assert.equal(sent.settings.atmosphere.time, 33 * 60);
  hostWorld.dispose();
  const guestNet = new FakeNet(), guestWorld = createWorldSettings({ mp: guestNet, tuning: structuredClone(own), atmosphere: guestCycle, timers });
  guestNet.emit('world', { ...sent, from: 'host' });
  assert(guestCycle.following); assert.equal(guestCycle.phase, 'night'); assert.equal(guestCycle.settings.cycle, true);
  guestNet.emit('world', { ...sent, from: 'host', mode: 'own' });
  assert(!guestCycle.following); assert.deepEqual(guestCycle.settings, { cycle: false, look: 'golden', weather: 'clear' });
  guestNet.emit('world', { ...sent, from: 'host' }); guestNet.emit('disconnected'); assert(!guestCycle.following);
  guestWorld.dispose();
}
console.log('PASS: world sync, repeated snapshots/restores, all disconnect paths, host authorization, debounce, atmosphere persistence, disposal, day/night clock + weather to guests');
