import assert from 'node:assert/strict';
import { Net, defaultRelay, LOCAL_RELAY, DEPLOYED_RELAY } from '../game/src/mp/net.js';

// Deterministic timers exercise the actual send and reconnect loops without sockets or sleeps.
class Time {
  t = 1000; next = 0; jobs = new Map();
  setTimeout = (fn, ms) => this.add(fn, ms, false);
  setInterval = (fn, ms) => this.add(fn, ms, true);
  clearTimeout = id => this.jobs.delete(id);
  clearInterval = this.clearTimeout;
  add(fn, ms, repeat) { const id = ++this.next; this.jobs.set(id, { fn, ms, at: this.t + ms, repeat }); return id; }
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      const entry = [...this.jobs].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, j] = entry; this.t = j.at;
      if (j.repeat) j.at += j.ms; else this.jobs.delete(id);
      j.fn();
    }
    this.t = end;
  }
}

// Minimal room relay: roster/hello, forwards with sender + server time, host closure, kick.
function fixture({ silent = false } = {}) {
  const time = new Time(), rooms = new Map(), sockets = [];
  class Socket {
    readyState = 0; bufferedAmount = 0; sent = [];
    constructor(url) { this.url = new URL(url); sockets.push(this); time.setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
    deliver(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
    send(data) {
      const m = JSON.parse(data); this.sent.push(m);
      if (silent) return;
      const code = this.url.pathname.split('/').pop(), id = this.url.searchParams.get('id');
      let room = rooms.get(code);
      if (m.t === 'hello' || m.t === 'join-request') {
        if (!room && !m.host) { this.deliver({ t: 'closed', reason: 'no-host' }); return; }
        if (!room) rooms.set(code, room = new Map());
        if (room.size >= 16) { this.deliver({ t: 'closed', reason: 'full' }); return; }
        this.player = { id, name: m.name, code: m.code, host: m.host, skin: m.skin };
        for (const s of room.values()) s.deliver({ t: 'joined', player: this.player });
        room.set(id, this); this.room = room;
        this.roster();
      } else if (m.t === 'ping') this.deliver({ t: 'pong', c: m.c, srvT: time.t + 750 });
      else if (m.t === 'kick' && this.player.host) {
        const s = room.get(m.id); s?.deliver({ t: 'kicked' }); s?.close();
      } else if (m.t === 'skin') { this.player.skin = m.skin; this.roster(); }
      else if (m.t !== 'world' || this.player.host) {
        for (const s of room.values()) if (s !== this) s.deliver({ ...m, from: id, srvT: time.t + 750 });
      }
    }
    roster() { for (const s of this.room.values()) s.deliver({ t: 'roster', players: [...this.room.values()].map(s => ({ ...s.player })) }); }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.room?.get(this.player?.id) === this) {
        this.room.delete(this.player.id);
        if (this.player.host) {
          rooms.delete(this.url.pathname.split('/').pop());
          for (const s of [...this.room.values()]) s.deliver({ t: 'closed', reason: 'host-left' });
        } else { for (const s of this.room.values()) s.deliver({ t: 'left', id: this.player.id }); this.roster(); }
      }
      this.onclose?.();
    }
    drop() { this.close(); }
  }
  const create = (storage = null) => new Net({ WebSocketImpl: Socket, storage, timers: time, clock: () => time.t });
  const connect = async promise => { time.advance(0); await promise; };
  return { time, sockets, create, connect };
}

const store = new Map();
const storage = { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) };
const f = fixture(), host = f.create(storage), same = f.create(storage);
assert.deepEqual(host.me, same.me, 'identity survives a new client');
assert.match(host.me.id, /^[A-Z2-9]{12}$/); assert.match(host.me.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
assert.match(host.me.name, /^Racer\d{3}$/);
host.setName(' Test Driver '); assert.equal(f.create(storage).me.name, 'Test Driver');
assert.equal(f.time.jobs.size, 0, 'single-player starts no timers');
assert.equal(host.send({ t: 'state' }), false);
await assert.rejects(host.join('bad'), /invalid-code/);
await f.connect(host.host()); assert.equal(host.inGame, true); assert.equal(host.isHost, true);
assert.equal(host.now(), f.time.t + 750);
const guest = f.create(); let joined = 0, state, worlds = 0, rosters = 0;
host.on('joined', () => joined++); guest.on('state', m => { state = m; });
guest.on('world', () => worlds++); guest.on('roster', () => rosters++);
await f.connect(guest.join(` ${host.me.code.toLowerCase()} `));
assert.equal(joined, 1); assert.equal(host.players.size, 2); assert.equal(guest.players.size, 2);
assert.equal(guest.roomCode, host.me.code); assert.equal(guest.isHost, false);
const vehicle = { kind: 'car', pos: { x: -542, y: 101, z: 440 }, quat: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 1, y: 2, z: 3 }, glide: { active: true } };
let kind = 'car', paint = '#ff0000', wing = '#ffffff';
host.setVehicleSource(() => ({ vehicle, kind, colors: { body: paint }, glider: { wing } }));
const socket = f.sockets[0];
f.time.advance(1001);
assert.equal(socket.sent.filter(m => m.t === 'state').length, 15, '15 Hz states');
assert.deepEqual(state.p, [-542, 101, 440]); assert.deepEqual(state.q, [0, 0, 0, 1]);
assert.deepEqual(state.vel, [1, 2, 3]); assert.equal(state.glide, true); assert.equal(state.from, host.me.id);
assert.equal(socket.sent.filter(m => m.t === 'skin').length, 1, 'unchanged skin is sent once');
paint = '#00ff00'; wing = '#dddddd'; kind = 'bike'; f.time.advance(70);
assert.equal(guest.players.get(host.me.id).skin.vehicle, 'bike');
assert.equal(guest.players.get(host.me.id).skin.glider.wing, wing);
assert.equal(guest.players.get(host.me.id).skin.colors.body, paint);
assert.equal(state.v, 'bike');
socket.bufferedAmount = 70000; const count = socket.sent.filter(m => m.t === 'state').length;
f.time.advance(200); assert.equal(socket.sent.filter(m => m.t === 'state').length, count);
socket.bufferedAmount = 0; vehicle.pos.x = NaN;
f.time.advance(70); assert.equal(socket.sent.filter(m => m.t === 'state').length, count); vehicle.pos.x = -542;
f.time.advance(4000); assert.equal(socket.sent.filter(m => m.t === 'ping').length, 2, 'clock sync every 5 s');
// A delayed pong uses the midpoint of send/receive, rather than the receive time.
const pingClient = fixture({ silent: true }), clockClient = pingClient.create();
const clockReady = clockClient.host(); pingClient.time.advance(0);
pingClient.sockets[0].deliver({ t: 'roster', players: [{ ...clockClient.me, host: true }] }); await clockReady;
const sentAt = pingClient.time.t; pingClient.time.advance(40);
pingClient.sockets[0].deliver({ t: 'pong', c: sentAt, srvT: sentAt + 20 + 1234 });
assert.equal(clockClient.now() - pingClient.time.t, 1234, 'clock offset accounts for round-trip latency');
clockClient.leave();
host.send({ t: 'world', mode: 'own', settings: {} }); assert.equal(worlds, 1);
let invites = 0; const onInvite = () => invites++;
guest.on('invite', onInvite); host.send({ t: 'invite', to: [guest.me.id] });
guest.off('invite', onInvite); host.send({ t: 'invite', to: [guest.me.id] }); assert.equal(invites, 1);
assert.ok(rosters >= 3);
const before = f.sockets.length, oldGuestSocket = f.sockets[1]; let reconnected = 0;
guest.on('connected', () => reconnected++); oldGuestSocket.drop();
assert.equal(guest.inGame, false); f.time.advance(500);
assert.equal(f.sockets.length, before + 1); assert.equal(guest.inGame, true); assert.equal(reconnected, 1);
assert.equal(guest.players.size, 2); assert.equal(host.players.size, 2);
f.sockets.at(-1).drop(); f.time.advance(2000);
assert.equal(f.sockets.length, before + 1, 'second drop does not reconnect'); assert.equal(guest.roomCode, null);
await f.connect(guest.join(host.me.code));
host.send({ t: 'kick', id: guest.me.id }); f.time.advance(1000);
assert.equal(guest.inGame, false); assert.equal(guest.roomCode, null);
await f.connect(guest.join(host.me.code)); host.leave();
assert.equal(guest.inGame, false); assert.equal(guest.players.size, 0); assert.equal(guest.roomCode, null);
assert.equal(f.time.jobs.size, 0, 'leave clears all timers');
await assert.rejects(f.connect(guest.join('ZZZZZ')), /no-host/);
assert.equal(f.time.jobs.size, 0);

const timeout = fixture({ silent: true }), hanging = timeout.create();
const pending = hanging.host(); const rejected = assert.rejects(pending, /timeout/);
timeout.time.advance(10000); await rejected;
assert.equal(timeout.time.jobs.size, 0, 'stalled handshake closes and clears timers');
const cancel = fixture(), cancelled = cancel.create();
const cancelledResult = assert.rejects(cancelled.host(), /left/); cancelled.leave();
cancel.time.advance(0); await cancelledResult; assert.equal(cancelled.inGame, false);
assert.equal(cancelled._socket, null);
const full = fixture(), owner = full.create(); await full.connect(owner.host());
const guests = [];
for (let i = 0; i < 15; i++) { const net = full.create(); await full.connect(net.join(owner.me.code)); guests.push(net); }
await assert.rejects(full.connect(full.create().join(owner.me.code)), /full/);
owner.leave(); assert.ok(guests.every(net => !net.inGame)); assert.equal(full.time.jobs.size, 0);
const retry = fixture(), retryHost = retry.create(), retryGuest = retry.create();
await retry.connect(retryHost.host()); await retry.connect(retryGuest.join(retryHost.me.code));
retry.sockets[1].drop(); retryHost.leave(); retry.time.advance(500);
assert.equal(retryGuest.roomCode, null, 'failed retry ends the session'); assert.equal(retry.time.jobs.size, 0);
const badStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
const privateClient = fixture().create(badStorage); privateClient.setName('Private'); assert.equal(privateClient.me.name, 'Private');
const failing = new Net({ storage: null, WebSocketImpl: class { constructor() { throw new Error('offline'); } } });
await assert.rejects(failing.host(), /connection-failed/);
const hello = fixture(), jet = hello.create();
jet.setVehicleSource(() => ({ kind: 'jet', vehicle, colors: { body: '#ababab' }, glider: {} }));
await hello.connect(jet.host());
assert.deepEqual(hello.sockets[0].sent[0].skin, { vehicle: 'jet', colors: { body: '#ababab' }, glider: {} });
hello.time.advance(70); assert.equal(hello.sockets[0].sent.find(m => m.t === 'state').v, 'jet'); jet.leave();

// relay choice: YR_MP_RELAY, then ?relay=, then local for a 127.0.0.1 / localhost page (or no page), deployed elsewhere
const page = (href, extra = {}) => ({ location: new URL(href), ...extra });
assert.equal(DEPLOYED_RELAY, 'wss://yamhill-racer-relay.yamhill-racer.workers.dev');
assert.equal(defaultRelay(undefined), LOCAL_RELAY);
assert.equal(defaultRelay(page('http://127.0.0.1:8173/')), LOCAL_RELAY);
assert.equal(defaultRelay(page('http://localhost:8195/index.html')), LOCAL_RELAY);
assert.equal(defaultRelay(page('https://example.github.io/yamhill-racer/')), DEPLOYED_RELAY);
assert.equal(defaultRelay(page('https://example.github.io/?relay=ws://127.0.0.1:8797')), 'ws://127.0.0.1:8797');
assert.equal(defaultRelay(page('http://127.0.0.1:8173/?relay=' + encodeURIComponent(DEPLOYED_RELAY))), DEPLOYED_RELAY);
assert.equal(defaultRelay(page('https://example.github.io/?relay=javascript:alert(1)')), DEPLOYED_RELAY, 'only ws(s) URLs');
assert.equal(defaultRelay(page('http://127.0.0.1:8173/?relay=ws://a.test', { YR_MP_RELAY: 'ws://b.test' })), 'ws://b.test');
const urls = [], picky = new Net({ storage: null, relay: undefined, WebSocketImpl: class { constructor(u) { urls.push(u); throw new Error('offline'); } } });
await picky.host().catch(() => {});
assert.ok(urls[0].startsWith(`${LOCAL_RELAY}/room/${picky.me.code}?id=`), 'Node (no page) uses the local relay');
console.log('PASS mp net: identity, lifecycle, roster/events, 15 Hz state, skins, clock, back pressure, retry, cleanup, relay choice');
