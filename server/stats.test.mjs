import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker, { RelayRoom } from './worker.js';
import { Stats, DAY, VISITOR_CAP, ORIGIN } from './stats.mjs';
import { countVisit } from '../game/src/visits.js';
globalThis.crypto ??= webcrypto;

function fixture() {
  const data = new Map();
  let alarm, queue = Promise.resolve();
  const ctx = {
    blockConcurrencyWhile(fn) { const job = queue.then(fn); queue = job.catch(() => {}); return job; },
    storage: {
      get: async key => structuredClone(data.get(key)),
      put: async (key, value) => { for (const [k, v] of typeof key === 'string' ? [[key, value]] : Object.entries(key)) data.set(k, structuredClone(v)); },
      getAlarm: async () => alarm, setAlarm: async value => { alarm = value; },
      list: async ({ prefix, end, limit }) => new Map([...data].filter(([k]) => k.startsWith(prefix) && k < end).sort().slice(0, limit)),
      delete: async keys => { for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k); },
    },
  };
  const stats = new Stats(ctx);
  const env = { STATS_KEY: 'test-key', STATS: { idFromName: name => { assert.equal(name, 'Stats'); return name; }, get: () => stats } };
  const hit = (v = 'a'.repeat(32), country = 'US') => {
    const req = new Request('https://relay/hit', { method: 'POST', headers: { Origin: ORIGIN }, body: JSON.stringify({ v, p: '/yamhill-racer/' }) });
    req.cf = { country };
    return worker.fetch(req, env);
  };
  return { data, ctx, stats, env, hit };
}
const dayKey = () => `day:${new Date().toISOString().slice(0, 10)}`;

test('counts visits, hashed uniques, countries, persistence and 30/day limit; concurrent hits survive', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 35 }, () => f.hit()));
  await f.hit('b'.repeat(32), 'CA');
  assert.deepEqual(f.data.get(dayKey()), { visits: 31, unique: 2, games: 0, countries: { US: 30, CA: 1 } });
  assert.ok([...f.data.keys()].filter(k => k.startsWith('visitor:')).every(k => /:[a-f0-9]{64}$/.test(k)));
  assert.ok(!JSON.stringify([...f.data]).includes('a'.repeat(32)));
  const restored = new Stats(f.ctx);
  await restored.fetch(new Request('https://stats/game', { method: 'POST' }));
  assert.equal(f.data.get(dayKey()).games, 1);
});

test('UTC rollover resets limit; daily alarm retains exactly 35 days even with no visits', async () => {
  const realNow = Date.now;
  let now = Date.parse('2026-11-16T23:59:59Z');
  Date.now = () => now;
  try {
    const f = fixture();
    for (let i = 0; i < 31; i++) await f.hit();
    now += 2000;
    await f.hit();
    assert.equal(f.data.get('day:2026-11-17').visits, 1);
    for (let i = 0; i < 40; i++) {
      const date = new Date(now - i * DAY).toISOString().slice(0, 10);
      f.data.set(`day:${date}`, { visits: 1 });
      f.data.set(`visitor:${date}:test`, 1);
    }
    await f.stats.alarm();
    assert.equal([...f.data.keys()].filter(k => k.startsWith('day:')).length, 35);
    assert.equal([...f.data.keys()].filter(k => k.startsWith('visitor:')).length, 37); // two real retained hashes
    now += 40 * DAY;
    await f.stats.alarm();
    assert.equal(f.data.size, 0);
  } finally { Date.now = realNow; }
});

test('bounded visitor storage stops accepting new IDs at daily cap', async () => {
  const f = fixture();
  f.data.set(dayKey(), { visits: VISITOR_CAP, unique: VISITOR_CAP, games: 0, countries: {} });
  await f.hit();
  assert.equal(f.data.size, 1);
  assert.equal(f.data.get(dayKey()).visits, VISITOR_CAP);
});

test('private route hides missing/wrong/unconfigured key and renders 30 rows and totals', async () => {
  const f = fixture();
  for (const suffix of ['', '?key=wrong']) assert.equal((await worker.fetch(new Request(`https://relay/stats${suffix}`), f.env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://relay/stats?key=test-key'), { ...f.env, STATS_KEY: undefined })).status, 404);
  await f.hit();
  const response = await worker.fetch(new Request('https://relay/stats?key=test-key'), f.env);
  const html = await response.text();
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((html.match(/<tr><td>\d{4}-/g) || []).length, 30);
  assert.ok(html.includes('30-day totals') && html.includes('<td>US</td><td>1</td>'));
  assert.ok(html.includes('counted when at least two players are in the same game'));
});

test('hit enforces origin, input and size; allows safelisted beacon and OPTIONS', async () => {
  const f = fixture();
  for (const [init, status] of [
    [{ method: 'POST', body: '{}' }, 403],
    [{ method: 'POST', headers: { Origin: ORIGIN }, body: '{}' }, 400],
    [{ method: 'POST', headers: { Origin: ORIGIN }, body: 'x'.repeat(1025) }, 413],
    [{ method: 'GET', headers: { Origin: ORIGIN } }, 405],
    [{ method: 'OPTIONS', headers: { Origin: ORIGIN } }, 204],
  ]) assert.equal((await worker.fetch(new Request('https://relay/hit', init), f.env)).status, status);
  assert.equal((await f.hit()).headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('client sends one beacon, keeps separate ID, skips tests/nostats, falls back on refusal/error', async () => {
  const store = new Map();
  let beacons = [], fetches = [];
  const scope = { location: { hostname: 'distractodog.github.io', search: '', pathname: '/yamhill-racer/' },
    navigator: { sendBeacon: (...args) => { beacons.push(args); return true; } }, crypto: webcrypto,
    localStorage: { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) },
    fetch: (...args) => { fetches.push(args); return Promise.resolve(); } };
  countVisit(scope);
  assert.equal(beacons.length, 1); assert.equal(fetches.length, 0);
  const first = JSON.parse(await beacons[0][1].text());
  countVisit(scope);
  assert.equal(JSON.parse(await beacons[1][1].text()).v, first.v);
  assert.deepEqual([...store.keys()], ['yr-visitor-1']);
  for (const hostname of ['localhost', '127.0.0.1']) countVisit({ ...scope, location: { ...scope.location, hostname } });
  countVisit({ ...scope, location: { ...scope.location, search: '?nostats' } });
  assert.equal(beacons.length, 2);
  scope.navigator.sendBeacon = () => false; countVisit(scope);
  scope.navigator.sendBeacon = () => { throw Error(); }; countVisit(scope);
  assert.equal(fetches.length, 2);
  assert.equal(fetches[0][1].keepalive, true);
  scope.localStorage.getItem = () => { throw Error(); };
  assert.doesNotThrow(() => countVisit(scope));
});

test('counts once when a guest joins; survives later joins and hibernation; new room counts again', async () => {
  const f = fixture();
  let pending = [];
  const sockets = [];
  const socket = () => ({ send() {}, close() {}, serializeAttachment(v) { this.attachment = v; }, deserializeAttachment() { return this.attachment; } });
  const ctx = { ...f.ctx, getWebSockets: () => sockets, waitUntil: p => pending.push(p) };
  const relay = new RelayRoom(ctx, f.env);
  await ctx.blockConcurrencyWhile(async () => {});
  const host = socket(), guest = socket(), rejected = socket();
  relay.room.code = 'ABCDE';
  const hello = host => JSON.stringify({ t: 'hello', name: 'Player', code: 'ABCDE', host, skin: { vehicle: 'car' } });
  relay.room.connect('000000000001', host);
  await relay.webSocketMessage(host, hello(true));
  await relay.webSocketMessage(host, hello(true));
  assert.equal(f.data.get(dayKey())?.games ?? 0, 0);
  relay.room.connect('000000000002', guest);
  await relay.webSocketMessage(guest, hello(false));
  await Promise.all(pending);
  assert.equal(f.data.get(dayKey()).games, 1);
  const second = socket();
  relay.room.connect('000000000005', second);
  await relay.webSocketMessage(second, hello(false));
  await relay.webSocketClose(second);
  const rejoin = socket();
  relay.room.connect('000000000006', rejoin);
  await relay.webSocketMessage(rejoin, hello(false));
  relay.room.connect('000000000003', rejected);
  await relay.webSocketMessage(rejected, hello(true));
  await Promise.all(pending);
  assert.equal(f.data.get(dayKey()).games, 1);
  sockets.push(host, guest, rejoin);
  const restored = new RelayRoom(ctx, f.env);
  await ctx.blockConcurrencyWhile(async () => {});
  const another = socket();
  restored.room.connect('000000000007', another);
  await restored.webSocketMessage(another, hello(false));
  await Promise.all(pending);
  assert.equal(f.data.get(dayKey()).games, 1);
  const freshSockets = [];
  const fresh = new RelayRoom({ ...ctx, getWebSockets: () => freshSockets }, f.env);
  await ctx.blockConcurrencyWhile(async () => {});
  const replacement = socket();
  fresh.room.code = 'ABCDE';
  fresh.room.connect('000000000004', replacement);
  await fresh.webSocketMessage(replacement, hello(true));
  const newGuest = socket();
  fresh.room.connect('000000000008', newGuest);
  await fresh.webSocketMessage(newGuest, hello(false));
  await Promise.all(pending);
  assert.equal(f.data.get(dayKey()).games, 2);
});

test('stats failures cannot reject host hello', async () => {
  const f = fixture();
  const pending = [];
  const ctx = { ...f.ctx, getWebSockets: () => [], waitUntil: p => pending.push(p) };
  const relay = new RelayRoom(ctx, { STATS: { idFromName() { throw Error('unavailable'); } } });
  await ctx.blockConcurrencyWhile(async () => {});
  const ws = { send() {}, serializeAttachment() {} };
  relay.room.code = 'ABCDE';
  relay.room.connect('000000000001', ws);
  await relay.webSocketMessage(ws, JSON.stringify({ t: 'hello', name: 'Host', code: 'ABCDE', host: true, skin: { vehicle: 'car' } }));
  assert.ok(relay.room.host);
});
