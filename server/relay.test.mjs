import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, roomAddress } from './relay.mjs';
import worker, { RelayRoom } from './worker.js';

const code = 'ABCDE';
const id = n => String(n).padStart(12, '0');
const skin = { vehicle: 'car', colors: { body: '#ff0000' }, glider: {} };
const hello = (host = false) => ({ t: host ? 'hello' : 'join-request', name: '<Racer>', code, host, skin });
const socket = () => ({
  messages: [], closes: [],
  send(text) { this.messages.push(JSON.parse(text)); },
  close(...args) { this.closes.push(args); },
  serializeAttachment(a) { this.attachment = structuredClone(a); },
  deserializeAttachment() { return this.attachment; },
});
function fixture() {
  let time = 1000;
  const room = new Room(code, { now: () => time });
  const send = (s, msg) => room.receive(s, JSON.stringify(msg));
  const join = (n, host = false) => {
    const s = socket();
    room.connect(id(n), s);
    send(s, hello(host));
    if (!host && room.session(s)?.pending) {
      const owner = [...room.clients].find(([, session]) => session.player?.host)?.[0];
      if (owner) send(owner, { t: 'join-accept', id: id(n) });
      s.messages = s.messages.filter(m => m.t !== 'join-pending');
    }
    return s;
  };
  const host = join(1, true);
  return { room, host, join, send, tick: n => { time += n; } };
}
const ofType = (s, type) => s.messages.filter(m => m.t === type);

test('host sends bounded tree snapshots only to the joining player', () => {
  const { host, join, send } = fixture(), guest = join(2), other = join(3);
  const msg = { t: 'tree-sync', to: id(2), trees: [{ id: '-2_3:17', remainingMs: 120000, extra: true }], from: 'forged' };
  send(host, msg);
  assert.deepEqual(ofType(guest, 'tree-sync'), [{ t: 'tree-sync', to: id(2), from: id(1), srvT: 1000,
    trees: [{ id: '-2_3:17', remainingMs: 120000 }] }]);
  assert.equal(ofType(host, 'tree-sync').length, 0);
  assert.equal(ofType(other, 'tree-sync').length, 0);
  send(other, msg); // A peer cannot forge a host snapshot.
  for (const trees of [null, {}, Array(129).fill(msg.trees[0]), [null], [{ id: 'bad', remainingMs: 12 }],
    [{ id: '0_0:1', remainingMs: 0 }], [{ id: '0_0:1', remainingMs: -1 }], [{ id: '0_0:1', remainingMs: 300001 }]]) send(host, { ...msg, trees });
  send(host, { ...msg, to: id(99) });
  assert.equal(ofType(guest, 'tree-sync').length, 1);
});

test('tree breaks broadcast stable IDs with authoritative sender and reject malformed IDs', () => {
  const { host, join, send } = fixture(), guest = join(2);
  send(guest, { t: 'tree-break', id: '-2_3:17', from: 'forged', extra: true });
  const expected = { t: 'tree-break', id: '-2_3:17', from: id(2), srvT: 1000 };
  assert.deepEqual(ofType(host, 'tree-break'), [expected]);
  assert.deepEqual(ofType(guest, 'tree-break'), [expected]);
  for (const value of [null, 17, {}, '0_0:-1', '0_0:1000000', 'bad', '0_0:1\n']) send(guest, { t: 'tree-break', id: value });
  assert.equal(ofType(host, 'tree-break').length, 1);
});

test('URL codes and IDs follow contract', () => {
  assert.deepEqual(roomAddress(`https://relay/room/ABCDE?id=${id(1)}`), { code, id: id(1) });
  for (const url of ['/room/ABCDI', '/room/abcde', '/room/ABCDEF', '/room/ABCDE/extra', '/']) {
    assert.equal(roomAddress(`https://relay${url}?id=${id(1)}`), null);
  }
  assert.equal(roomAddress('https://relay/room/ABCDE?id=short'), null);
});

test('hello joins with unfiltered names; joined goes to peers and roster to everyone', () => {
  const { room, host, join } = fixture();
  const guest = join(2);
  assert.equal(ofType(guest, 'joined').length, 0);
  assert.equal(ofType(host, 'joined')[0].player.name, '<Racer>');
  const roster = ofType(guest, 'roster')[0];
  assert.deepEqual(roster.players, room.players);
  assert.equal(roster.players[0].host, true);
  assert.equal(roster.players[1].host, false);
  assert.deepEqual(roster.players[1].skin, skin);
});

test('guest without host, invalid hello, duplicate IDs and competing hosts close cleanly', () => {
  const empty = new Room(code);
  const orphan = socket();
  empty.connect(id(1), orphan);
  empty.receive(orphan, JSON.stringify(hello()));
  assert.deepEqual(orphan.messages, [{ t: 'closed', reason: 'no-host' }]);
  assert.equal(empty.clients.size, 0);
  const { room, host, join, send } = fixture();
  const duplicate = socket();
  assert.equal(room.connect(id(1), duplicate), false);
  assert.equal(duplicate.messages[0].reason, 'duplicate-id');
  assert.equal(join(2, true).messages[0].reason, 'host-conflict');
  const wrong = socket();
  room.connect(id(3), wrong);
  send(wrong, { ...hello(), skin: {} });
  assert.equal(wrong.messages[0].reason, 'invalid-hello');
  const early = socket();
  room.connect(id(4), early);
  send(early, { t: 'state' });
  assert.equal(early.messages[0].reason, 'hello-required');
  send(host, hello(true)); // Repeated hello cannot modify identity or host status.
  assert.equal(room.players.length, 1);
  const mismatched = new Room(code);
  const s = socket();
  mismatched.connect(id(5), s);
  mismatched.receive(s, JSON.stringify({ ...hello(true), code: 'FGHJK' }));
  assert.equal(s.messages[0].reason, 'host-conflict');
});

test('16 includes host; 17th rejected; guest departure frees slot', () => {
  const { room, host, join } = fixture();
  const guests = Array.from({ length: 15 }, (_, n) => join(n + 2));
  assert.equal(room.players.length, 16);
  const full = join(17);
  assert.equal(full.messages[0].reason, 'full');
  assert.equal(full.closes.length, 1);
  room.leave(guests[0]);
  assert.equal(ofType(host, 'left').at(-1).id, id(2));
  assert.equal(ofType(host, 'roster').at(-1).players.length, 15);
  join(17);
  assert.equal(room.players.length, 16);
});

test('state stamps identity/time, excludes sender and enforces 40Hz per sender', () => {
  const { host, join, send, tick } = fixture();
  const guest = join(2);
  const state = { t: 'state', v: 'bike', p: [1, 2, 3], q: [0, 0, 0, 1], vel: [4, 5, 6], glide: true, ts: 123, from: 'forged', srvT: -1 };
  send(host, state);
  assert.deepEqual(ofType(guest, 'state')[0], { ...state, from: id(1), srvT: 1000 });
  assert.equal(ofType(host, 'state').length, 0);
  tick(24); send(host, state);
  assert.equal(ofType(guest, 'state').length, 1);
  send(guest, state); // Independent sender budget.
  assert.equal(ofType(host, 'state').length, 1);
  tick(1); send(host, state);
  assert.equal(ofType(guest, 'state').length, 2);
  for (let n = 0; n < 200; n++) send(host, state);
  assert.equal(ofType(guest, 'state').length, 2);
});

test('skin forwarded and roster refreshed; latest host world replay immediately follows roster', () => {
  const { room, host, join, send } = fixture();
  const guest = join(2);
  const changed = { ...skin, vehicle: 'jet' };
  send(guest, { t: 'skin', skin: changed });
  assert.equal(ofType(host, 'skin')[0].from, id(2));
  assert.deepEqual(ofType(host, 'roster').at(-1).players[1].skin, changed);
  send(guest, { t: 'world', mode: 'host', settings: { forged: true } });
  assert.equal(room.world, null);
  const world = { t: 'world', mode: 'host', settings: { tuning: { car: {}, bike: {}, jet: {} }, atmosphere: { hour: 8 } } };
  send(host, world);
  send(host, { ...world, mode: 'invalid' });
  assert.equal(room.world.mode, 'host');
  send(host, { ...world, mode: 'own' });
  const late = join(3);
  assert.deepEqual(late.messages.map(m => m.t), ['roster', 'world']);
  assert.equal(late.messages[1].mode, 'own');
  assert.equal(late.messages[1].from, id(1));
});

test('ping replies only to sender with relay clock', () => {
  const { host, join, send } = fixture();
  const guest = join(2);
  send(guest, { t: 'ping', c: 99 });
  assert.deepEqual(ofType(guest, 'pong'), [{ t: 'pong', c: 99, srvT: 1000 }]);
  assert.equal(ofType(host, 'pong').length, 0);
});

test('all race messages go to everyone including sender with fields preserved', () => {
  const { host, join, send } = fixture();
  const guest = join(2);
  for (const t of ['invite', 'invite-reply', 'race-start', 'race-progress', 'race-finish', 'race-cancel']) {
    const msg = { t, inviteId: 'race-1', raceId: 'campus', to: [id(1)], accept: true, players: [id(1), id(2)], startAt: 5000, checkpoint: 4, dist: 9, time: 12 };
    send(guest, msg);
    for (const peer of [host, guest]) assert.deepEqual(ofType(peer, t).at(-1), { ...msg, from: id(2), srvT: 1000 });
  }
});

test('only host can kick guests; kicked loses membership before close and cannot forward', () => {
  const { room, host, join, send } = fixture();
  const guest = join(2);
  send(guest, { t: 'kick', id: id(1) });
  assert.equal(room.players.length, 2);
  send(host, { t: 'kick', id: id(1) });
  send(host, { t: 'kick', id: id(99) });
  assert.equal(room.players.length, 2);
  send(host, { t: 'kick', id: id(2) });
  assert.deepEqual(ofType(guest, 'kicked'), [{ t: 'kicked' }]);
  assert.equal(guest.closes.length, 1);
  assert.equal(room.players.length, 1);
  assert.equal(ofType(host, 'left').at(-1).id, id(2));
  send(guest, { t: 'invite', inviteId: 'bad' });
  assert.equal(ofType(host, 'invite').length, 0);
  room.leave(guest); // Socket close callback is idempotent.
  assert.equal(ofType(host, 'left').length, 1);
});

test('host departure closes guests and pending sockets, clears world, permits fresh room', () => {
  const { room, host, join, send } = fixture();
  const guest = join(2);
  const pending = socket();
  room.connect(id(3), pending);
  send(host, { t: 'world', mode: 'own', settings: {} });
  room.leave(host);
  for (const peer of [guest, pending]) {
    assert.equal(ofType(peer, 'closed').at(-1).reason, 'host-left');
    assert.equal(peer.closes.length, 1);
  }
  assert.equal(room.clients.size, 0);
  assert.equal(room.world, null);
  room.leave(host);
  const newHost = join(4, true);
  assert.deepEqual(newHost.messages.map(m => m.t), ['roster']);
});

test('bad JSON, binary, oversized and unknown messages do not crash or forward', () => {
  const { room, host, join, send } = fixture();
  const guest = join(2);
  const before = guest.messages.length;
  for (const text of ['{', 'null', '[]', '42', JSON.stringify({ t: 'state', data: 'a'.repeat(17000) }), new ArrayBuffer(8)]) room.receive(host, text);
  send(host, { t: 'roster', players: [] });
  send(host, { t: 'unknown' });
  assert.equal(guest.messages.length, before);
});

test('Durable Object restores sessions, rate timestamps and stored world after hibernation', async () => {
  const { room, host, join, send } = fixture();
  room.host.heartbeat = Date.now();
  const guest = join(2);
  send(host, { t: 'state' });
  send(host, { t: 'world', mode: 'host', settings: { atmosphere: { hour: 7 } } });
  for (const ws of [host, guest]) ws.serializeAttachment({ code, session: room.session(ws) });
  const data = new Map([['world', room.world]]);
  let ready;
  const ctx = {
    getWebSockets: () => [host, guest],
    blockConcurrencyWhile(fn) { ready = fn(); },
    storage: { get: async k => data.get(k), put: async (k, v) => data.set(k, v), delete: async k => data.delete(k) },
  };
  const restored = new RelayRoom(ctx);
  await ready;
  assert.deepEqual(restored.room.players, room.players);
  assert.deepEqual(restored.room.world, room.world);
  assert.equal(restored.room.session(host).lastState, 1000);
  await restored.webSocketMessage(host, JSON.stringify({ t: 'world', mode: 'own', settings: {} }));
  assert.equal(data.get('world').mode, 'own');
  await restored.webSocketMessage(host, JSON.stringify({ t: 'kick', id: id(2) }));
  assert.equal(guest.deserializeAttachment().session, null);
  await restored.webSocketClose(host);
  assert.equal(data.has('world'), false);
  assert.equal(host.deserializeAttachment().session, null);
});

test('Worker rejects bad routes and routes each code to its named Durable Object', async () => {
  assert.equal((await worker.fetch(new Request('https://relay/nope'), {})).status, 400);
  const url = `https://relay/room/ABCDE?id=${id(1)}`;
  assert.equal((await worker.fetch(new Request(url), {})).status, 426);
  let named;
  const env = { ROOMS: { idFromName(c) { named = c; return 'object-id'; }, get(i) {
    assert.equal(i, 'object-id');
    return { fetch: req => new Response(req.url) };
  } } };
  const response = await worker.fetch(new Request(url, { headers: { Upgrade: 'websocket' } }), env);
  assert.equal(named, code);
  assert.equal(await response.text(), url);
});

test('attachments stay below 2 KiB with largest accepted name and skin', () => {
  const { room, send } = fixture();
  const peer = socket();
  const largeSkin = { vehicle: 'car', colors: { body: '' } };
  largeSkin.colors.body = 'x'.repeat(1024 - JSON.stringify(largeSkin).length);
  room.connect(id(2), peer);
  send(peer, { ...hello(), name: '\u0000'.repeat(128), skin: largeSkin });
  const bytes = new TextEncoder().encode(JSON.stringify({ code, session: room.session(peer) })).length;
  assert.ok(bytes < 2048, `${bytes} attachment bytes`);
  const oversized = socket();
  room.connect(id(3), oversized);
  send(oversized, { ...hello(), skin: { vehicle: 'car', colors: { body: '界'.repeat(500) } } });
  assert.equal(oversized.messages[0].reason, 'invalid-hello');
});

test('hibernation with no surviving host closes orphan guests and discards stale world', async () => {
  const { room, join } = fixture();
  const guest = join(2);
  guest.serializeAttachment({ code, session: room.session(guest) });
  const data = new Map([['world', { t: 'world', mode: 'host', settings: {} }]]);
  let ready;
  const restored = new RelayRoom({
    getWebSockets: () => [guest],
    blockConcurrencyWhile(fn) { ready = fn(); },
    storage: { delete: async k => data.delete(k) },
  });
  await ready;
  assert.equal(restored.room.clients.size, 0);
  assert.equal(data.has('world'), false);
  assert.equal(ofType(guest, 'closed').at(-1).reason, 'no-host');
});

test('builder layouts are host-only, atomic, bounded and replayed to late joiners', async () => {
  const { layoutChunks } = await import('../game/src/builder/wire.js');
  const { room, host, join, send } = fixture(), guest = join(2);
  const chunks = layoutChunks(JSON.stringify({version:1,pieces:[],padding:'x'.repeat(14000)}),'revision1');
  for(const m of chunks) send(guest,m);
  assert.equal(room.layout,null);assert.equal(ofType(host,'layout').length,0);
  for(const m of [{...chunks[0],index:-1},{...chunks[0],total:1000},{...chunks[0],data:'x'.repeat(6001)}])send(host,m);
  assert.equal(room.layoutPending,null);
  send(host,chunks[1]);send(host,chunks[1]);assert.equal(ofType(guest,'layout').length,0);
  send(host,chunks[0]);send(host,chunks[2]);
  assert.equal(ofType(guest,'layout').length,3);assert.equal(room.layout.length,3);
  for(const c of room.layout)assert.equal(c.from,id(1));
  const late=join(3);assert.deepEqual(ofType(late,'layout'),room.layout);
  room.leave(host);assert.equal(room.layout,null);assert.equal(room.layoutPending,null);
});

test('builder layout chunks survive relay hibernation, including an incomplete transfer', async () => {
  const { layoutChunks } = await import('../game/src/builder/wire.js');
  const { room, host, join }=fixture(),guest=join(2),data=new Map();
  room.host.heartbeat = Date.now();
  let ready;
  for(const ws of [host,guest])ws.serializeAttachment({code,session:room.session(ws)});
  const ctx={getWebSockets:()=>[host,guest],blockConcurrencyWhile(fn){ready=fn();},storage:{get:async k=>data.get(k),put:async(k,v)=>data.set(k,structuredClone(v)),delete:async k=>data.delete(k)}};
  const chunks=layoutChunks('x'.repeat(14000),'rev2');
  let adapter=new RelayRoom(ctx);await ready;
  await adapter.webSocketMessage(host,JSON.stringify(chunks[0]));
  adapter=new RelayRoom(ctx);await ready;
  await adapter.webSocketMessage(host,JSON.stringify(chunks[1]));
  await adapter.webSocketMessage(host,JSON.stringify(chunks[2]));
  adapter=new RelayRoom(ctx);await ready;
  assert.equal(adapter.room.layout.length,3);assert.equal(adapter.room.layout.map(c=>c.data).join(''),'x'.repeat(14000));
  await adapter.webSocketClose(host);assert.equal(data.has('layout'),false);
});


test('shot validation, identity, rate limiting and persisted bucket', () => {
  const { host, join, send, tick, room } = fixture(), guest = join(2);
  const shot = { t: 'shot', k: 'cannon', n: 1, p: [0, 20, 0], v: [0, 0, 1000], from: 'forged', extra: true };
  send(host, shot);
  assert.deepEqual(ofType(guest, 'shot')[0], { t: 'shot', k: 'cannon', n: 1, p: shot.p, v: shot.v, from: id(1), srvT: 1000 });
  assert.equal(ofType(host, 'shot').length, 0);
  for (const patch of [{ k: 'damage' }, { p: [0, 0] }, { v: [0, 0, 99999] }, { n: -1 }, { k: 'blast', v: [0, 0, 1] }]) send(host, { ...shot, ...patch });
  assert.equal(ofType(guest, 'shot').length, 1);
  for (let i = 0; i < 40; i++) send(host, shot);
  assert.equal(ofType(guest, 'shot').length, 24);
  room.restore(host, room.session(host)); send(host, shot);
  assert.equal(ofType(guest, 'shot').length, 24);
  tick(1000); send(host, { ...shot, k: 'blast', v: [0, 0, 0] });
  assert.equal(ofType(guest, 'shot').length, 25);
});
