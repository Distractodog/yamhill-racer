import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby, LobbyState } from './lobby.mjs';
import { Room } from './relay.mjs';
import worker, { RelayRoom } from './worker.js';
const id = n => String(n).padStart(12, '0');
const socket = () => ({ messages: [], send(text) { this.messages.push(JSON.parse(text)); }, close() {},
  serializeAttachment(a) { this.attachment = structuredClone(a); }, deserializeAttachment() { return this.attachment; } });
const hello = (host = false) => ({ t: host ? 'hello' : 'join-request', name: host ? 'Host' : 'Guest', code: 'ABCDE', host, skin: { vehicle: 'car' } });
const last = (ws, type) => ws.messages.filter(m => m.t === type).at(-1);
function fixture(admission) {
  let time = 1000;
  const room = new Room('ABCDE', { now: () => time, ...(admission ? { admission } : {}) });
  const send = (ws, m) => room.receive(ws, JSON.stringify(m));
  const open = (n, host = false) => { const ws = socket(); room.connect(id(n), ws); send(ws, hello(host)); return ws; };
  const host = open(1, true);
  return { room, host, send, open, advance: ms => { time += ms; room.expire(); } };
}
function context(sockets = [], data = new Map()) {
  let ready;
  const ctx = { data, getWebSockets: () => sockets, waitUntil: p => p,
    blockConcurrencyWhile(fn) { ready = fn(); }, get ready() { return ready; },
    storage: { get: async k => data.get(k), put: async (k, v) => data.set(k, structuredClone(v)), delete: async k => data.delete(k),
      setAlarm: async at => data.set('alarm', at), deleteAlarm: async () => data.delete('alarm') } };
  return ctx;
}
async function adapterFixture() {
  const lobbyCtx = context(), lobby = new Lobby(lobbyCtx); await lobbyCtx.ready;
  const env = { LOBBY: { idFromName: () => 'public', get: () => lobby } };
  const ctx = context(), relay = new RelayRoom(ctx, env); await ctx.ready;
  relay.room.code = 'ABCDE';
  const host = socket(); relay.room.connect(id(1), host);
  await relay.webSocketMessage(host, JSON.stringify(hello(true)));
  return { lobby, lobbyCtx, env, relay, ctx, host };
}
test('register, heartbeat, player counts, explicit leave and expiry at 30 seconds', () => {
  let now = 0; const l = new LobbyState({ now: () => now });
  const entry = { id: 'ABCDE', name: 'Host', players: 1, max: 16, created: 0 };
  l.update(entry); assert.deepEqual(l.list(), [entry]);
  now = 10000; l.update({ ...entry, players: 2 }); now = 39999;
  assert.equal(l.list()[0].players, 2); now = 40000; assert.deepEqual(l.list(), []);
  l.update(entry); l.update({ id: 'ABCDE', players: 0 }); assert.deepEqual(l.list(), []);
});
test('one pending globally; 5 requests per minute across rooms and reconnects; stale releases cannot unlock another request', () => {
  let now = 0; const l = new LobbyState({ now: () => now });
  assert.equal(l.claim('guest', 'roomA'), null);
  assert.equal(l.claim('guest', 'roomB'), 'request-pending');
  l.release('guest', 'roomA'); assert.equal(l.claim('guest', 'roomB'), null);
  l.release('guest', 'roomA'); assert.equal(l.claim('guest', 'roomC'), 'request-pending');
  l.release('guest', 'roomB');
  for (let i = 0; i < 3; i++) { assert.equal(l.claim('guest', 'next'), null); l.release('guest', 'next'); }
  assert.equal(l.claim('guest', 'sixth'), 'rate-limit');
  now = 60000; assert.equal(l.claim('guest', 'sixth'), null);
  now += 30000; assert.equal(l.claim('guest', 'expired'), null);
});
test('pending guests cannot see roster/world or send game traffic; only host accepts; admitted guest gets existing world/layout', () => {
  const f = fixture(), { room, host, send, open } = f;
  send(host, { t: 'world', mode: 'host', settings: { tuning: { car: { accel: 42 } } } });
  send(host, { t: 'layout', revision: 'one', index: 0, total: 1, data: '{}' });
  const guest = open(2), other = open(3);
  assert.equal(room.players.length, 1); assert.equal(last(host, 'join-request').name, 'Guest');
  assert.deepEqual(guest.messages.map(m => m.t), ['join-pending']);
  send(guest, { t: 'join-accept', id: id(2) }); send(other, { t: 'state' });
  send(guest, hello()); assert.equal(host.messages.filter(m => m.t === 'join-request').length, 2);
  assert.equal(last(host, 'state'), undefined); assert.equal(room.players.length, 1);
  send(host, { t: 'join-accept', id: id(2) });
  assert.deepEqual(guest.messages.map(m => m.t), ['join-pending', 'roster', 'world', 'layout']);
  assert.equal(room.players.length, 2); assert.equal(last(host, 'join-resolved').id, id(2));
  assert.equal(last(other, 'roster'), undefined);
  send(guest, { t: 'invite', raceId: 'campus' }); assert.equal(last(host, 'invite').from, id(2));
  send(guest, { t: 'join-policy', anyone: true }); assert.equal(room.host.anyone, false);
});
test('decline, auto-decline at 30 s, cancellation, host departure and no legacy hello bypass', () => {
  const { room, host, send, open, advance } = fixture();
  const denied = open(2); send(host, { t: 'join-decline', id: id(2) });
  assert.equal(last(denied, 'join-declined').name, 'Host'); assert.equal(room.session(denied), undefined);
  const expired = open(3); advance(29999); assert.ok(room.session(expired)); send(host, { t: 'heartbeat' }); advance(1);
  assert.equal(last(expired, 'join-declined').name, 'Host'); send(host, { t: 'join-accept', id: id(3) }); assert.equal(room.players.length, 1);
  const cancelled = open(4); room.leave(cancelled); assert.equal(last(host, 'join-resolved').id, id(4));
  const legacy = socket(); room.connect(id(5), legacy); send(legacy, { ...hello(), t: 'hello' }); assert.equal(last(legacy, 'closed').reason, 'approval-required');
  const waiting = open(6); room.leave(host); assert.equal(last(waiting, 'closed').reason, 'host-left');
});
test('open joining is off by default; host opts in; pending requests do not reserve player slots', () => {
  const { room, host, open, send } = fixture();
  const waiting = open(2); assert.equal(room.players.length, 1);
  send(host, { t: 'join-policy', anyone: true });
  for (let n = 3; n <= 17; n++) open(n);
  assert.equal(room.players.length, 16);
  send(host, { t: 'join-accept', id: id(2) });
  assert.equal(last(waiting, 'closed').reason, 'full'); assert.equal(room.players.length, 16);
  assert.equal(last(open(18), 'closed').reason, 'full');
});
test('Lobby Durable Object survives hibernation; only public GET route exposes listing', async () => {
  const { lobby, lobbyCtx, env } = await adapterFixture();
  const response = await worker.fetch(new Request('https://relay/lobby'), env);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).games[0].players, 1);
  const claim = () => lobby.fetch(new Request('https://lobby/claim', { method: 'POST', body: JSON.stringify({ id: id(2), key: 'test' }) }));
  assert.equal((await (await claim()).json()).reason, null);
  const freshCtx = context([], lobbyCtx.data), restored = new Lobby(freshCtx); await freshCtx.ready;
  const res = await restored.fetch(new Request('https://lobby/claim', { method: 'POST', body: JSON.stringify({ id: id(2), key: 'another' }) }));
  assert.equal((await res.json()).reason, 'request-pending');
  assert.equal((await worker.fetch(new Request('https://relay/claim', { method: 'POST' }), env)).status, 400);
  assert.equal((await worker.fetch(new Request('https://relay/lobby', { method: 'POST' }), env)).status, 400);
});
test('Room DO persists pending guests, admission changes and host policy; alarm declines after hibernation and releases lease', async () => {
  const { relay, host, env, ctx, lobby } = await adapterFixture();
  const guest = socket(); relay.room.connect(id(2), guest);
  await relay.webSocketMessage(guest, JSON.stringify(hello()));
  assert.equal(guest.attachment.session.pending.name, 'Guest'); assert.ok(ctx.data.get('alarm'));
  const restoredCtx = context([host, guest], ctx.data), restored = new RelayRoom(restoredCtx, env); await restoredCtx.ready;
  await restored.webSocketMessage(host, JSON.stringify({ t: 'join-accept', id: id(2) }));
  assert.equal(guest.attachment.session.player.id, id(2)); assert.equal(guest.attachment.session.pending, undefined);
  assert.equal(lobby.state.requests.get(id(2)).until, 0);
  assert.equal(lobby.state.list()[0].players, 2); assert.ok(ctx.data.get('alarm'), 'host lease keeps an alarm armed');
  await restored.webSocketMessage(host, JSON.stringify({ t: 'join-policy', anyone: true }));
  assert.equal(host.attachment.session.anyone, true);
  await restored.webSocketMessage(host, JSON.stringify({ t: 'join-policy', anyone: false }));
  const waiting = socket(); restored.room.connect(id(3), waiting); await restored.webSocketMessage(waiting, JSON.stringify(hello()));
  const againCtx = context([host, guest, waiting], ctx.data), again = new RelayRoom(againCtx, env); await againCtx.ready;
  const deadline = again.room.session(waiting).expires;
  again.room.host.heartbeat = deadline - 10000;
  again.room.now = () => deadline - 1; await again.webSocketMessage(host, JSON.stringify({ t: 'heartbeat' }));
  again.room.now = () => deadline; await again.alarm();
  assert.equal(last(waiting, 'join-declined').name, 'Host'); assert.equal(waiting.attachment.session, null);
  assert.equal(lobby.state.requests.get(id(3)).until, 0);
  await again.webSocketClose(host); assert.deepEqual(lobby.state.list(), []);
});
test('DO global budget denies another room request and cleans rejected attachments', async () => {
  const { relay, env, lobby } = await adapterFixture();
  const guest = socket(); relay.room.connect(id(2), guest); await relay.webSocketMessage(guest, JSON.stringify(hello()));
  const ctx = context(), other = new RelayRoom(ctx, env); await ctx.ready; other.room.code = 'FGHJK';
  const host = socket(); other.room.connect(id(8), host);
  await other.webSocketMessage(host, JSON.stringify({ ...hello(true), code: 'FGHJK' }));
  const duplicate = socket(); other.room.connect(id(2), duplicate);
  await other.webSocketMessage(duplicate, JSON.stringify(hello()));
  assert.equal(last(duplicate, 'closed').reason, 'request-pending'); assert.equal(duplicate.attachment.session, null);
  await relay.webSocketClose(guest); assert.equal(lobby.state.requests.get(id(2)).until, 0);
  const next = socket(); other.room.connect(id(2), next); await other.webSocketMessage(next, JSON.stringify(hello()));
  assert.ok(next.attachment.session.pending);
});
test('request preparation handles cancellation and duplicate messages during Lobby I/O', async () => {
  const { relay, lobby } = await adapterFixture();
  const guest = socket(); relay.room.connect(id(2), guest);
  const call = relay.lobby.call.bind(relay.lobby); let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  relay.lobby.call = async (path, body) => {
    const result = await call(path, body);
    if (path === 'claim') { started(); await new Promise(resolve => { release = resolve; }); }
    return result;
  };
  const first = relay.webSocketMessage(guest, JSON.stringify(hello())); await begun;
  await relay.webSocketMessage(guest, JSON.stringify(hello()));
  assert.equal(relay.room.players.length, 1); assert.equal(last(guest, 'join-pending'), undefined);
  await relay.webSocketMessage(guest, JSON.stringify({ t: 'leave' })); release(); await first;
  assert.equal(lobby.state.requests.get(id(2)).until, 0);
  assert.equal(guest.attachment.session, null);
});
test('largest allowed pending/host attachments remain below Cloudflare 2 KiB after heartbeat and chat', async () => {
  const { relay, host } = await adapterFixture();
  const skin = { vehicle: 'car', data: '' }; skin.data = 'x'.repeat(1024 - JSON.stringify(skin).length);
  relay.room.host.player.name = '\u0000'.repeat(128); relay.room.host.player.skin = skin;
  await relay.webSocketMessage(host, JSON.stringify({ t: 'heartbeat' }));
  await relay.webSocketMessage(host, JSON.stringify({ t: 'chat', text: 'hello' }));
  const guest = socket(); relay.room.connect(id(2), guest);
  await relay.webSocketMessage(guest, JSON.stringify({ ...hello(), name: '\u0000'.repeat(128), skin }));
  for (const ws of [host, guest]) {
    const bytes = new TextEncoder().encode(JSON.stringify(ws.attachment)).length;
    assert.ok(bytes < 2048, `${bytes} attachment bytes`);
  }
});

test('guest-driven roster publications retain the host timestamp and cannot renew expired discovery', () => {
  let now = 0; const lobby = new LobbyState({ now: () => now });
  const entry = { id: 'ABCDE', name: 'Host', players: 1, created: 0, seen: 0 };
  lobby.update(entry); now = 29999; lobby.update({ ...entry, players: 2 });
  assert.equal(lobby.list()[0].players, 2);
  now = 30000; assert.deepEqual(lobby.list(), []);
  lobby.update({ ...entry, players: 1 }); assert.deepEqual(lobby.list(), []);
});

test('combat policy and sender hit bucket survive Durable Object hibernation', async () => {
  const { relay, host, env, ctx } = await adapterFixture();
  const guest = socket(); relay.room.connect(id(2), guest);
  await relay.webSocketMessage(guest, JSON.stringify(hello()));
  await relay.webSocketMessage(host, JSON.stringify({ t: 'join-accept', id: id(2) }));
  const hit = { t: 'hit', to: id(2), k: 'shell', n: 0, d: 80, p: [0,0,0] };
  await relay.webSocketMessage(host, JSON.stringify(hit));
  assert.equal(host.attachment.session.hitTokens, 63);
  await relay.webSocketMessage(host, JSON.stringify({ t: 'weapons-policy', enabled: false }));
  assert.equal(host.attachment.session.weapons, false);
  const wakeCtx = context([host, guest], ctx.data), wake = new RelayRoom(wakeCtx, env); await wakeCtx.ready;
  assert.equal(wake.room.host.weapons, false); assert.equal(wake.room.host.hitTokens, 63);
  await wake.webSocketMessage(host, JSON.stringify(hit)); assert.equal(guest.messages.filter(m => m.t === 'hit').length, 1);
  const late = socket(); wake.room.connect(id(3), late); await wake.webSocketMessage(late, JSON.stringify(hello()));
  await wake.webSocketMessage(host, JSON.stringify({ t: 'join-accept', id: id(3) })); assert.equal(last(late, 'roster').weapons, false);
  await wake.webSocketMessage(host, JSON.stringify({ t: 'weapons-policy', enabled: true }));
  assert.equal(last(guest, 'weapons-policy').enabled, true);
  await wake.webSocketMessage(host, JSON.stringify(hit)); assert.equal(guest.messages.filter(m => m.t === 'hit').length, 2);
});
