import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker, { RelayRoom } from './worker.js';
import { Lobby } from './lobby.mjs';
import { Stats, DAY, VISITOR_CAP, RECORD_CAP, ORIGIN, peakConcurrent, renderStats } from './stats.mjs';
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
      list: async ({ prefix, end, limit }) => {
        const entries = [...data].filter(([k]) => k.startsWith(prefix) && (!end || k < end)).sort();
        return new Map(limit == null ? entries : entries.slice(0, limit));
      },
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
const pacificDate = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const dayKey = () => `day:${pacificDate(Date.now())}`;

async function checkGameCount(f, expected, day = pacificDate(Date.now())) {
  const html = await (await f.stats.fetch(new Request('https://stats/stats'))).text();
  const row = html.match(new RegExp(`<tr><td>${day}</td><td>\\d+</td><td>\\d+</td><td>(\\d+)</td>`));
  assert.ok(row, `daily row for ${day}`);
  assert.equal(Number(row[1]), expected);
  return html;
}

test('counts visits, hashed uniques, countries, persistence and 30/day limit; concurrent hits survive', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 35 }, () => f.hit()));
  await f.hit('b'.repeat(32), 'CA');
  assert.deepEqual(f.data.get(dayKey()), { visits: 31, unique: 2, countries: { US: 30, CA: 1 } });
  assert.ok([...f.data.keys()].filter(k => k.startsWith('visitor:')).every(k => /:[a-f0-9]{64}$/.test(k)));
  assert.ok(!JSON.stringify([...f.data]).includes('a'.repeat(32)));
  const restored = new Stats(f.ctx);
  await restored.fetch(new Request('https://stats/game', { method: 'POST' }));
  await checkGameCount(f, 0);
});

test('Pacific rollover resets limit; daily alarm retains 60 days even with no visits', async () => {
  const realNow = Date.now;
  let now = Date.parse('2026-11-17T07:59:59Z');
  Date.now = () => now;
  try {
    const f = fixture();
    for (let i = 0; i < 31; i++) await f.hit();
    now += 2000;
    await f.hit();
    assert.equal(f.data.get('day:2026-11-17').visits, 1);
    for (let i = 0; i < 65; i++) {
      const date = pacificDate(now - i * DAY);
      f.data.set(`day:${date}`, { visits: 1 });
      f.data.set(`visitor:${date}:test`, 1);
    }
    await f.stats.alarm();
    assert.equal([...f.data.keys()].filter(k => k.startsWith('day:')).length, 60);
    assert.equal([...f.data.keys()].filter(k => k.startsWith('visitor:')).length, 62); // two real retained hashes
    now += 65 * DAY;
    await f.stats.alarm();
    assert.deepEqual([...f.data.keys()], []);
  } finally { Date.now = realNow; }
});

test('bounded visitor storage stops accepting new IDs at daily cap', async () => {
  const f = fixture();
  f.data.set(dayKey(), { visits: VISITOR_CAP, unique: VISITOR_CAP, games: 0, countries: {} });
  await f.hit();
  assert.equal(f.data.size, 1); // daily row only
  assert.equal(f.data.get(dayKey()).visits, VISITOR_CAP);
});

test('stored daily counters and legacy ID-less reports cannot inflate record-derived MP totals after migration', async () => {
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-11-17T20:00:00Z');
  try {
    const f = fixture();
    f.data.set('migration:mp-reset-1', true);
    f.data.set('day:2026-11-17', { visits: 7, unique: 6, games: 8, countries: { CA: 7 } });
    f.data.set('game:joined', { id: 'joined', start: Date.now() - 1000, last: Date.now(), maxPlayers: 2, names: ['Host', 'Guest'] });
    f.data.set('game:solo', { id: 'solo', start: Date.now() - 3000, last: Date.now(), maxPlayers: 1, names: ['Host'] });
    for (let i = 0; i < 8; i++) await f.stats.fetch(new Request('https://stats/game', { method: 'POST', body: '{}' }));
    for (const stats of [f.stats, new Stats(f.ctx)]) {
      const html = await checkGameCount({ ...f, stats }, 1);
      assert.equal((html.match(/MP games with 2\+ players<\/dt><dd>1<\/dd>/g) || []).length, 3);
      assert.ok(html.includes('<td>30-day totals</td><td>7</td><td>6</td><td>1</td>'));
      const table = html.split('<h2>Multiplayer games</h2>')[1].split('<h2>Per day</h2>')[0];
      assert.equal((table.match(/<tr><td>/g) || []).length, 2);
      assert.ok(table.includes('Host, Guest'));
    }
    assert.deepEqual(f.data.get('day:2026-11-17'), { visits: 7, unique: 6, games: 8, countries: { CA: 7 } });
  } finally { Date.now = realNow; }
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
    [{ method: 'POST', headers: { Origin: ORIGIN }, body: 'x'.repeat(8193) }, 413],
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
  const hello = host => JSON.stringify({ t: host ? 'hello' : 'join-request', name: 'Player', code: 'ABCDE', host, skin: { vehicle: 'car' } });
  relay.room.connect('000000000001', host);
  await relay.webSocketMessage(host, hello(true));
  await relay.webSocketMessage(host, hello(true));
  await relay.webSocketMessage(host, JSON.stringify({ t: 'join-policy', anyone: true }));
  await checkGameCount(f, 0);
  relay.room.connect('000000000002', guest);
  await relay.webSocketMessage(guest, hello(false));
  await Promise.all(pending);
  await checkGameCount(f, 1);
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
  await checkGameCount(f, 1);
  sockets.push(host, guest, rejoin);
  const restored = new RelayRoom(ctx, f.env);
  await ctx.blockConcurrencyWhile(async () => {});
  const another = socket();
  restored.room.connect('000000000007', another);
  await restored.webSocketMessage(another, hello(false));
  await Promise.all(pending);
  await checkGameCount(f, 1);
  const freshSockets = [];
  const fresh = new RelayRoom({ ...ctx, getWebSockets: () => freshSockets }, f.env);
  await ctx.blockConcurrencyWhile(async () => {});
  const replacement = socket();
  fresh.room.code = 'ABCDE';
  fresh.room.connect('000000000004', replacement);
  await fresh.webSocketMessage(replacement, hello(true));
  await fresh.webSocketMessage(replacement, JSON.stringify({ t: 'join-policy', anyone: true }));
  const newGuest = socket();
  fresh.room.connect('000000000008', newGuest);
  await fresh.webSocketMessage(newGuest, hello(false));
  await Promise.all(pending);
  await checkGameCount(f, 2);
});

test('lobby and game records share admitted roster; pending requests never count and hibernation never recounts', async () => {
  const f = fixture(), l = fixture();
  const lobby = new Lobby(l.ctx);
  await l.ctx.blockConcurrencyWhile(async () => {});
  f.env.LOBBY = { idFromName: () => 'public', get: () => lobby };
  const pending = [], sockets = [];
  const ctx = { ...f.ctx, getWebSockets: () => sockets, waitUntil: p => pending.push(p) };
  let relay = new RelayRoom(ctx, f.env);
  await ctx.blockConcurrencyWhile(async () => {});
  relay.room.code = 'ABCDE';
  const send = (ws, message) => relay.webSocketMessage(ws, JSON.stringify(message));
  const open = (id, name, host = false) => {
    const ws = { messages: [], send(text) { this.messages.push(JSON.parse(text)); }, close() {},
      serializeAttachment(v) { this.attachment = structuredClone(v); }, deserializeAttachment() { return this.attachment; } };
    sockets.push(ws); relay.room.connect(id, ws);
    return [ws, { t: host ? 'hello' : 'join-request', name, code: 'ABCDE', host, skin: { vehicle: 'car' } }];
  };
  const check = async (count, peak, games) => {
    await Promise.all(pending);
    const listing = await (await worker.fetch(new Request('https://relay/lobby'), f.env)).json();
    assert.equal(listing.games[0]?.players ?? 0, count);
    const record = f.data.get(`game:${relay.stats.game?.id || gameId}`);
    assert.equal(record.maxPlayers, peak);
    await checkGameCount(f, games);
    assert.equal(relay.counted, games > 0 && count > 0);
    return record;
  };
  const [host, hostHello] = open('000000000001', 'Host', true);
  await send(host, hostHello);
  const gameId = relay.stats.game.id;
  await check(1, 1, 0);
  const [guest, guestHello] = open('000000000002', 'Guest');
  await send(guest, guestHello);
  await check(1, 1, 0);
  await send(host, { t: 'join-accept', id: '000000000002' });
  await check(2, 2, 1);
  assert.equal(guest.messages.filter(m => m.t === 'stats-game').at(-1).id, gameId);
  const [declined, declinedHello] = open('000000000003', 'Declined');
  await send(declined, declinedHello);
  await send(host, { t: 'join-decline', id: '000000000003' });
  await check(2, 2, 1);
  relay = new RelayRoom(ctx, f.env);
  await ctx.blockConcurrencyWhile(async () => {});
  assert.equal(relay.stats.game.id, gameId);
  await send(host, { t: 'heartbeat' });
  await check(2, 2, 1);
  await relay.webSocketClose(guest);
  await check(1, 2, 1);
  await relay.webSocketClose(host);
  const ended = await check(0, 2, 1);
  assert.deepEqual(ended.names, ['Host', 'Guest']);
  assert.ok(ended.end);
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

const sessionRequest = (f, event, seq, values = {}) => {
  const r = new Request('https://relay/hit', { method: 'POST', headers: { Origin: ORIGIN }, body: JSON.stringify({
    v: 'visitor_1234567890123456', s: 'session_1234567890123456', event, seq, activeMs: 0,
    offset: 480, screen: 'large', browser: 'Chrome', vehicles: ['car:race'], races: { started: 0, finished: 0 }, ...values,
  }) });
  r.cf = { country: 'US' };
  return worker.fetch(r, f.env);
};
const sessions = f => [...f.data].filter(([k]) => k.startsWith('session:')).map(([, v]) => v);

test('session start, heartbeat, end, duplicate/out-of-order reports, resume and distinct browser sessions', async () => {
  const realNow = Date.now; let now = Date.parse('2026-11-17T20:00:00Z'); Date.now = () => now;
  try {
    const f = fixture();
    assert.equal((await sessionRequest(f, 'start', 1)).status, 204);
    await sessionRequest(f, 'start', 1);
    assert.equal(f.data.get(dayKey()).visits, 1);
    now += 60000;
    await sessionRequest(f, 'heartbeat', 2, { activeMs: 60000, vehicles: ['bike:dirt'], builder: true, graphics: 'high',
      mp: { id: 'test-game', code: 'ABCDE', nickname: '<Ada>', maxPlayers: 4 }, races: { started: 2, finished: 1, medals: { gold: 1 } } });
    let s = sessions(f)[0];
    assert.equal(s.activeMs, 60000); assert.equal(s.end, null); assert.equal(s.builder, true);
    assert.deepEqual(s.vehicles, ['car:race', 'bike:dirt']); assert.equal(s.races.medals.gold, 1);
    assert.equal(s.mpGames[0].maxPlayers, 4); assert.equal(s.nickname, '<Ada>');
    now += 10000; await sessionRequest(f, 'end', 3, { activeMs: 70000 });
    await sessionRequest(f, 'heartbeat', 2, { activeMs: 1 });
    s = sessions(f)[0]; assert.equal(s.end, now); assert.equal(s.activeMs, 70000);
    now += 600000; await sessionRequest(f, 'heartbeat', 4, { activeMs: 70000 });
    now += 60000; await sessionRequest(f, 'heartbeat', 5, { activeMs: 130000 });
    s = sessions(f)[0]; assert.equal(s.activeMs, 130000); assert.equal(s.spans.length, 2);
    assert.equal(s.last - s.start, 730000); // hidden interval is not active time
    await sessionRequest(f, 'start', 1, { s: 'session_other_1234567890' });
    assert.equal(sessions(f).length, 2); assert.equal(f.data.get(dayKey()).unique, 1);
    assert.ok(!JSON.stringify([...f.data]).includes('visitor_1234567890123456'));
  } finally { Date.now = realNow; }
});

test('missing end uses last heartbeat, unknown heartbeat does not create a session, metadata is whitelisted', async () => {
  const realNow = Date.now; let now = Date.parse('2026-11-17T20:00:00Z'); Date.now = () => now;
  try {
    const f = fixture();
    await sessionRequest(f, 'heartbeat', 1); assert.equal(sessions(f).length, 0);
    await sessionRequest(f, 'start', 1, { browser: 'full UA', screen: '1234x5678', ip: 'do-not-store', vehicles: ['car:race', 'http://private'], location: 'private' });
    now += 60000; await sessionRequest(f, 'heartbeat', 2, { activeMs: 60000 });
    const last = now; now += DAY;
    const s = sessions(f)[0]; assert.equal(s.last, last); assert.equal(s.end, null);
    const html = await (await worker.fetch(new Request('https://relay/stats?key=test-key'), f.env)).text();
    assert.ok(html.includes('(last report)')); assert.ok(html.includes('1.0 min / 1.0 min'));
    assert.ok(html.includes('Sessions') && html.includes('Multiplayer games') && html.includes('<svg'));
    const stored = JSON.stringify([...f.data]); assert.ok(!stored.includes('do-not-store') && !stored.includes('full UA') && !stored.includes('1234x5678'));
  } finally { Date.now = realNow; }
});

test('session and game details expire and stay capped, including when no visitors arrive', async () => {
  const f = fixture(), now = Date.now();
  for (let i = 0; i <= RECORD_CAP; i++) f.data.set(`session:seed${i}`, { start: now - i });
  f.data.set('session:expired', { start: now - 61 * DAY });
  f.data.set('game:expired', { start: now - 61 * DAY });
  await f.stats.alarm();
  assert.equal(sessions(f).length, RECORD_CAP); assert.equal(f.data.has('game:expired'), false);
  await sessionRequest(f, 'start', 1); assert.equal(sessions(f).length, RECORD_CAP);
});

test('peak concurrence excludes hidden intervals and deduplicates tabs; private page escapes nicknames', () => {
  const list = [
    { visitor: 'a', spans: [{ start: 0, last: 10 }, { start: 30, last: 40 }] },
    { visitor: 'a', spans: [{ start: 1, last: 9 }] },
    { visitor: 'b', spans: [{ start: 12, last: 29 }] },
  ];
  assert.equal(peakConcurrent(list, 0, 40), 1);
  list.push({ visitor: 'c', spans: [{ start: 5, last: 15 }] });
  assert.equal(peakConcurrent(list, 0, 40), 2);
  const html = renderStats([{ day: pacificDate(Date.now()), visits: 1, unique: 1, games: 1, countries: { US: 1 } }], [], [
    { id: '<script>', code: 'ABCDE', start: Date.now(), last: Date.now(), host: '<img onerror=x>', maxPlayers: 2, names: ['<svg onload=x>'] },
  ]);
  assert.ok(html.includes('&lt;img onerror=x&gt;') && !html.includes('<img onerror=x>'));
});

test('play time splits across Pacific midnight and uses DST calendar days', async () => {
  const realNow = Date.now; let now = Date.parse('2026-11-17T07:59:30Z'); Date.now = () => now;
  try {
    const f = fixture(); await sessionRequest(f, 'start', 1);
    now += 60000; await sessionRequest(f, 'heartbeat', 2, { activeMs: 60000 });
    const s = sessions(f)[0]; assert.deepEqual(s.playByDay, { '2026-11-16': 30000, '2026-11-17': 30000 });
    assert.equal(f.data.get('day:2026-11-16').visits, 1); assert.equal(f.data.has('day:2026-11-17'), false);
    const html = await (await worker.fetch(new Request('https://relay/stats?key=test-key'), f.env)).text();
    assert.ok(html.includes('Nov 16, 2026') && html.includes('11:59 PM'));
    assert.ok(html.includes('0.5 min'));
    now = Date.parse('2026-11-01T09:30:00Z'); // second 1:30 AM when DST ends
    const dst = fixture();
    const dstHtml = await (await worker.fetch(new Request('https://relay/stats?key=test-key'), dst.env)).text();
    assert.equal((dstHtml.match(/<td>2026-11-01<\/td>/g) || []).length, 1);
    assert.equal((dstHtml.match(/<td>2026-10-31<\/td>/g) || []).length, 1);
  } finally { Date.now = realNow; }
});

test('relay game reports retain host, names, peak and end; same code can have separate games', async () => {
  const realNow = Date.now; let now = Date.parse('2026-11-17T20:00:00Z'); Date.now = () => now;
  try {
    const f = fixture();
    const report = values => f.stats.fetch(new Request('https://stats/game', { method: 'POST', body: JSON.stringify({ id: 'one', code: 'ABCDE', host: 'Maple', count: 1, names: ['Maple'], ...values }) }));
    await report({}); const start = now;
    assert.equal(f.data.get(dayKey()), undefined); // solo host is visible but not a 2+ game
    now += 1000; await report({ count: 3, names: ['Maple', 'River', 'Aspen'] });
    await report({ count: 2, names: ['Maple', 'Oak'] }); await checkGameCount(f, 1);
    now += 5000; await report({ count: 0, names: [] });
    const game = f.data.get('game:one'); assert.equal(game.start, start); assert.equal(game.end, now); assert.equal(game.maxPlayers, 3);
    assert.deepEqual(game.names, ['Maple', 'River', 'Aspen', 'Oak']);
    await report({ id: 'two', count: 2 }); await checkGameCount(f, 2);
    assert.equal(f.data.get('game:two').code, game.code);
  } finally { Date.now = realNow; }
});

test('MP days follow Pacific participation, not room creation or UTC; rejoining counts once each day', async () => {
  const realNow = Date.now;
  let now = Date.parse('2026-11-17T07:58:00Z'); Date.now = () => now;
  try {
    const f = fixture();
    const report = count => f.stats.fetch(new Request('https://stats/game', { method: 'POST', body: JSON.stringify({ id: 'overnight', count }) }));
    await report(1);
    now += 180000; // Nov 17 Pacific; room started Nov 16
    await report(2); await report(1); await report(2); await report(3);
    await checkGameCount(f, 0, '2026-11-16');
    await checkGameCount(f, 1);
    now += DAY;
    await report(1); await checkGameCount(f, 0);
    await report(2); await report(1); await report(2);
    const html = await checkGameCount(f, 1);
    assert.deepEqual(f.data.get('game:overnight').mpDays, ['2026-11-17', '2026-11-18']);
    assert.equal((html.match(/MP games with 2\+ players<\/dt><dd>1<\/dd>/g) || []).length, 3);
    assert.ok(html.includes('<td>30-day totals</td><td>0</td><td>0</td><td>2</td>'));
    assert.equal(f.data.get(dayKey()), undefined); // no separate daily MP counter
  } finally { Date.now = realNow; }
});

test('all retained games used by totals are visible beyond the former 500-row table limit', async () => {
  const f = fixture(), now = Date.now();
  for (let i = 0; i < 501; i++) f.data.set(`game:seed${i}`, { id: `seed${i}`, start: now - i, last: now, maxPlayers: 2, names: [] });
  const html = await checkGameCount(f, 501);
  const table = html.split('<h2>Multiplayer games</h2>')[1].split('<h2>Per day</h2>')[0];
  assert.equal((table.match(/<tr><td>/g) || []).length, 501);
  assert.equal((html.match(/MP games with 2\+ players<\/dt><dd>501<\/dd>/g) || []).length, 3);
});


test('solo rooms never count and removing a retained record removes it from every MP total', async () => {
  const f = fixture();
  for (const id of ['solo-a', 'solo-b', 'joined']) {
    for (const count of id === 'joined' ? [1, 2, 1, 2, 0] : [1, 1, 0]) {
      await f.stats.fetch(new Request('https://stats/game', { method: 'POST', body: JSON.stringify({ id, count }) }));
    }
  }
  await checkGameCount(f, 1);
  f.data.delete('game:joined');
  const html = await checkGameCount(f, 0);
  assert.equal((html.match(/MP games with 2\+ players<\/dt><dd>0<\/dd>/g) || []).length, 3);
  assert.equal(f.data.has(dayKey()), false);
});
