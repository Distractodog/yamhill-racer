import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { countVisit } from '../game/src/visits.js';
function fixture(search = '', hostname = 'distractodog.github.io') {
  let now = 0;
  const store = new Map(), listeners = new Map(), timers = new Map(), bodies = [], fetches = [];
  const scope = { crypto: webcrypto, location: { hostname, search }, screen: { width: 1680 }, Date: { now: () => now },
    localStorage: { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) },
    navigator: { userAgent: 'Mozilla Chrome/1 Safari/1 Edg/1', sendBeacon(url, blob) { bodies.push(blob.text().then(JSON.parse)); return true; } },
    fetch(url, opts) { fetches.push(opts); return Promise.resolve(); },
    document: { hidden: false, addEventListener: (k, f) => listeners.set(k, f), removeEventListener: k => listeners.delete(k) },
    addEventListener: (k, f) => listeners.set(k, f), removeEventListener: k => listeners.delete(k),
    setInterval: (fn, ms) => { timers.set(ms, fn); return ms; }, clearInterval: id => timers.delete(id),
  };
  return { scope, bodies, fetches, store, timers, emit: k => listeners.get(k)?.(), advance: ms => { now += ms; } };
}
test('start/60s heartbeat/end, hidden silence, visible resume and pagehide deduplication', async () => {
  const f = fixture(), tracker = countVisit(f.scope);
  assert.equal(f.timers.has(60000), true);
  const first = await f.bodies[0]; assert.equal(first.event, 'start'); assert.equal(first.browser, 'Edge'); assert.equal(first.screen, 'large');
  f.advance(60000); f.timers.get(60000)();
  assert.equal((await f.bodies[1]).activeMs, 60000);
  f.advance(5000); f.scope.document.hidden = true; f.emit('visibilitychange'); f.emit('pagehide');
  assert.equal(f.bodies.length, 3); assert.equal((await f.bodies[2]).event, 'end');
  f.advance(600000); f.timers.get(60000)(); assert.equal(f.bodies.length, 3);
  f.scope.document.hidden = false; f.emit('visibilitychange');
  assert.equal((await f.bodies[3]).activeMs, 65000);
  f.advance(60000); f.timers.get(60000)(); assert.equal((await f.bodies[4]).activeMs, 125000);
  tracker.stop(); assert.equal(f.timers.size, 0);
  const all = await Promise.all(f.bodies); assert.equal(new Set(all.map(b => b.s)).size, 1); assert.deepEqual(all.map(b => b.seq), [1, 2, 3, 4, 5, 6]);
});
test('nostats and loopback send nothing, blocked storage still works and fetch is keepalive', async () => {
  for (const [q, host] of [['?foo=1&nostats', 'live'], ['', 'localhost'], ['', '127.0.0.1'], ['', '[::1]']]) {
    const f = fixture(q, host); assert.equal(countVisit(f.scope), undefined); assert.equal(f.bodies.length, 0); assert.equal(f.timers.size, 0);
  }
  const f = fixture(); f.scope.localStorage.getItem = () => { throw Error(); }; f.scope.localStorage.setItem = () => { throw Error(); };
  f.scope.navigator.sendBeacon = () => false;
  const tracker = countVisit(f.scope); assert.equal(f.fetches.length, 1); assert.equal(f.fetches[0].keepalive, true); assert.equal(f.fetches[0].credentials, 'omit'); tracker.stop();
});
test('collects gameplay snapshots and race counters; IDs are per load, visitor ID persists', async () => {
  const f = fixture();
  f.scope.game = { vehicles: { current: { kind: 'jet', type: 'stealth' } }, builder: { open: true }, graphics: { mode: 'medium' },
    multiplayer: { mp: { inGame: true, statsGameId: 'unique-game', roomCode: 'ABCDE', me: { name: 'Ada' }, players: new Map([['a', {}], ['b', {}]]) } } };
  const tracker = countVisit(f.scope); tracker.event('race-start'); tracker.event('race-finish', 'gold');
  const b = await f.bodies.at(-1); assert.deepEqual(b.vehicles, ['aircraft:stealth']); assert.equal(b.mp.maxPlayers, 2); assert.equal(b.builder, true); assert.equal(b.graphics, 'medium');
  assert.deepEqual(b.races, { started: 1, finished: 1, medals: { gold: 1, silver: 0, bronze: 0 } }); tracker.stop();
  const other = countVisit(f.scope); const second = await f.bodies.at(-1); assert.equal(second.v, b.v); assert.notEqual(second.s, b.s); other.stop();
});
