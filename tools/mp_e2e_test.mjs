// Multiplayer end to end in Node: the real relay (server/relay.mjs Room) + three real net.js clients over fake
// sockets, with the real menu world controller (menu.js createWorldSettings) and race logic (racecore.js) on top.
// Host, 2 joins, roster, world mode both ways, kick (+ rejoin), invite → accept/decline → race-start → progress →
// finish → results, accept-then-withdraw, host leaves → closed.   Run: node tools/mp_e2e_test.mjs
import assert from 'node:assert/strict';
import { Room, roomAddress } from '../server/relay.mjs';
import { LobbyState } from '../server/lobby.mjs';
import { Net } from '../game/src/mp/net.js';
import { createWorldSettings } from '../game/src/mp/menu.js';
import { createRaceCore, START_DELAY } from '../game/src/mp/racecore.js';

// one fake clock + timers for everything; each client's wall clock is skewed so clock sync has work to do
const time = { t: 50000, next: 0, jobs: new Map() };
const timers = {
  setTimeout: (fn, ms = 0) => add(fn, ms, false), setInterval: (fn, ms) => add(fn, ms, true),
  clearTimeout: id => time.jobs.delete(id), clearInterval: id => time.jobs.delete(id),
};
function add(fn, ms, repeat) { const id = ++time.next; time.jobs.set(id, { fn, ms, at: time.t + ms, repeat }); return id; }
function advance(ms) {
  const end = time.t + ms;
  for (;;) {
    const due = [...time.jobs].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    const [id, j] = due; time.t = j.at;
    if (j.repeat) j.at += j.ms; else time.jobs.delete(id);
    j.fn();
  }
  time.t = end;
}

// transport: every frame goes through one FIFO queue (no re-entrancy), like two event loops joined by a socket
const queue = []; let pumping = false;
function post(fn) {
  queue.push(fn); if (pumping) return;
  pumping = true; try { while (queue.length) queue.shift()(); } finally { pumping = false; }
}
const lobby = new LobbyState({ now: () => time.t });
const rooms = new Map(), wire = [];          // wire: every client → relay frame, for contract checks
class FakeSocket {                          // the browser WebSocket as net.js uses it
  readyState = 0; bufferedAmount = 0;
  constructor(url) {
    const address = roomAddress(url); assert.ok(address, `relay URL follows the contract: ${url}`);
    let room = rooms.get(address.code);
    if (!room) rooms.set(address.code, room = new Room(address.code, { now: () => time.t, admission: lobby }));
    const socket = this;
    this.room = room; this.id = address.id;
    this.server = {                         // the relay's side of the same socket (what local.mjs hands to Room)
      send: text => post(() => { if (socket.readyState === 1) socket.onmessage?.({ data: text }); }),
      close: () => post(() => socket.closed()),
    };
    timers.setTimeout(() => post(() => {
      if (room.connect(address.id, this.server) === false) return;
      this.readyState = 1; this.onopen?.();
    }), 0);
  }
  send(text) {
    assert.equal(this.readyState, 1, 'net.js only sends on an open socket');
    wire.push({ from: this.id, ...JSON.parse(text) });
    post(() => { this.room.receive(this.server, text); lobby.update(this.room.info); });
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; post(() => { this.room.leave(this.server); lobby.update(this.room.info); }); }
  closed() {                                // relay closed it
    if (this.readyState === 3) return;
    this.readyState = 3; this.room.leave(this.server); this.onclose?.();
  }
}

// a player: real Net + world settings + race core, a fake vehicle, fake challenges and a recorder of every event
const RACE = { id: 'r1', name: 'Campus Sprint' };
function player(name, skew) {
  const store = new Map(), storage = { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) };
  const mp = new Net({ WebSocketImpl: FakeSocket, storage, timers, clock: () => time.t + skew, fetchImpl: async () => Response.json({ games: lobby.list() }) });
  mp.setName(name);
  const car = { pos: { x: 10, y: 2, z: 20 }, quat: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 1, y: 0, z: 0 }, glide: { active: false } };
  const colors = { body: '#123456' };
  mp.setVehicleSource(() => ({ vehicle: car, kind: 'car', colors, glider: {} }));
  const got = [];
  for (const t of ['roster', 'joined', 'left', 'state', 'skin', 'world', 'kicked', 'closed', 'connected', 'disconnected',
    'join-request', 'join-pending', 'join-declined', 'invite', 'invite-reply', 'race-start', 'race-progress', 'race-finish', 'race-cancel']) mp.on(t, m => got.push({ t, ...m }));
  const tuning = { car: { accel: 20 }, bike: { accel: 10 }, jet: { thrust: 5 } };
  const atmosphere = { preset: 'day', setPreset(p) { this.preset = p; } };
  let locked = false;
  const world = createWorldSettings({ mp, tuning, atmosphere, timers, lock: l => { locked = l; } });
  const ch = { state: 'idle', next: 1, pos: { x: 0, z: 0 }, started: [] };
  const gates = [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 0, z: 200 }];
  const challenges = { list: [RACE], get state() { return ch.state; },
    start(i, o) { ch.started.push(o); ch.state = 'countdown'; ch.next = 1; },
    quit() { core.hook.onQuit(); ch.state = 'idle'; }, dnf() { ch.state = 'finished'; },
    runInfo: () => ({ id: RACE.id, gates, track: [[0, 0, 5], [0, 100, 5], [0, 200, 5]], next: ch.next, state: ch.state }) };
  const ui = { notices: [], notice(t) { this.notices.push(t); } };
  const core = createRaceCore({ mp, challenges, ui, timers, pos: () => ch.pos });
  const tick = () => { if (ch.state === 'countdown' && mp.now() >= ch.started.at(-1).sync.at) ch.state = 'running'; };
  return { name, mp, car, colors, got, tuning, atmosphere, world, ch, challenges, core, tick, get locked() { return locked; },
    of: t => got.filter(m => m.t === t), last: t => got.filter(m => m.t === t).at(-1) };
}
const step = (ms, ...ps) => { for (let i = 0; i < ms; i += 100) { advance(100); for (const p of ps) p.tick(); } };
async function settle(promise) { advance(0); return promise; }

// ---------------------------------------------------------------- nobody hosting yet: a join is refused
const A = player('Alice', 0), B = player('Bob', 4321), C = player('<Cara>', -2500);
await assert.rejects(settle(B.mp.join(A.mp.me.code)), e => e.reason === 'no-host');
assert.equal(B.mp.inGame, false);
assert.equal(B.last('closed').reason, 'no-host');

// ---------------------------------------------------------------- host + 2 joins, roster
A.tuning.car.accel = 31; A.atmosphere.preset = 'sunset';
await settle(A.mp.host());
assert.ok(A.mp.inGame && A.mp.isHost); assert.equal(A.mp.roomCode, A.mp.me.code);
const listed = await B.mp.listGames();
assert.deepEqual(listed, [{ id: A.mp.me.code, name: 'Alice', players: 1, max: 16, created: time.t, anyone: false }]);
async function requestAndAccept(guest) {
  const joining = guest.mp.requestJoin(listed[0].id); advance(0);
  assert.equal(guest.mp.inGame, false, 'request does not grant room membership');
  assert.equal(A.last('join-request').id, guest.mp.me.id);
  A.mp.send({ t: 'join-accept', id: guest.mp.me.id }); await joining;
}
await requestAndAccept(B);
await requestAndAccept(C);
for (const p of [A, B, C]) {
  assert.deepEqual([...p.mp.players.keys()].sort(), [A, B, C].map(q => q.mp.me.id).sort(), `${p.name} roster`);
  assert.equal(p.mp.players.get(A.mp.me.id).host, true); assert.equal(p.mp.players.get(B.mp.me.id).host, false);
}
assert.equal(C.mp.players.get(C.mp.me.id).name, '<Cara>', 'names are not filtered');
assert.equal(A.of('joined').length, 2); assert.equal(B.of('joined').length, 1);
assert.deepEqual(A.of('connected').map(m => m.isHost), [true]);
for (const m of wire.filter(m => m.t === 'hello')) assert.deepEqual(Object.keys(m).sort(), ['code', 'from', 'host', 'name', 'skin', 't']);

// clock sync: three skewed wall clocks agree on the relay clock
step(200, A, B, C);
for (const p of [B, C]) assert.ok(Math.abs(p.mp.now() - A.mp.now()) < 1, `${p.name} clock synced`);

// state (to others only, ~15 Hz) and skin
const fromB = () => A.of('state').filter(m => m.from === B.mp.me.id), stateBefore = fromB().length;
B.car.pos.x = 77; step(1000, A, B, C);
const bStates = fromB(), perSecond = bStates.length - stateBefore;
assert.ok(perSecond >= 14 && perSecond <= 16, `B's state reaches A at ~15 Hz (${perSecond})`);
assert.equal(bStates.at(-1).p[0], 77); assert.ok(Number.isFinite(bStates.at(-1).srvT));
assert.ok(!B.of('state').some(m => m.from === B.mp.me.id), 'state is not echoed to its sender');
assert.deepEqual(A.mp.players.get(B.mp.me.id).skin, { vehicle: 'car', type: 'race', colors: { body: '#123456' }, glider: {} });
B.colors.body = '#abcdef'; step(200, A, B, C);       // repaint: skin to the others + a fresh roster for everyone
assert.equal(A.last('skin').skin.colors.body, '#abcdef'); assert.equal(A.last('skin').from, B.mp.me.id);
assert.ok(!B.of('skin').length, 'skin is not echoed to its sender');
for (const p of [A, B, C]) assert.equal(p.mp.players.get(B.mp.me.id).skin.colors.body, '#abcdef');

// ---------------------------------------------------------------- world settings: host's ↔ own, both ways
// a joiner gets the stored world right after the roster: B and C now drive with A's tuning + atmosphere
for (const p of [B, C]) {
  assert.equal(p.world.mode, 'host'); assert.equal(p.tuning.car.accel, 31); assert.equal(p.atmosphere.preset, 'sunset');
  assert.equal(p.locked, true);
}
A.world.setMode('own');
assert.ok(A.of('world').length >= 1, 'world is echoed to the host too');
for (const p of [B, C]) {
  assert.equal(p.world.mode, 'own'); assert.equal(p.tuning.car.accel, 20); assert.equal(p.atmosphere.preset, 'day');
  assert.equal(p.locked, false);
}
A.world.setMode('host');
for (const p of [B, C]) { assert.equal(p.tuning.car.accel, 31); assert.equal(p.locked, true); }
A.tuning.bike.accel = 12; step(800, A, B, C);         // host edits are debounced, then published
assert.equal(B.tuning.bike.accel, 12);
B.mp.send({ t: 'world', mode: 'own', settings: {} }); // a guest can't change the world
assert.equal(C.world.mode, 'host'); assert.equal(C.tuning.bike.accel, 12);

// ---------------------------------------------------------------- kick (and the kicked player can rejoin)
A.mp.send({ t: 'kick', id: C.mp.me.id });
assert.equal(C.of('kicked').length, 1); assert.equal(C.mp.inGame, false);
assert.equal(C.tuning.car.accel, 20, 'leaving restores your own settings'); assert.equal(C.locked, false);
assert.ok(A.of('left').some(m => m.id === C.mp.me.id) && B.of('left').some(m => m.id === C.mp.me.id));
for (const p of [A, B]) assert.equal(p.mp.players.has(C.mp.me.id), false);
B.mp.send({ t: 'kick', id: A.mp.me.id });              // only the host can kick
assert.ok(A.mp.inGame);
await requestAndAccept(C);
assert.equal(A.mp.players.size, 3); assert.equal(C.tuning.car.accel, 31, 'rejoiner gets the world again');

// ---------------------------------------------------------------- race: invite → B accepts, C declines → start
assert.equal(A.core.invite(RACE.id, [B.mp.me.id, C.mp.me.id]), true);
const invite = wire.filter(m => m.t === 'invite').at(-1);
assert.deepEqual(Object.keys(invite).sort(), ['from', 'inviteId', 'raceId', 't', 'to']);
assert.ok(A.of('invite').length, 'race messages are echoed to the sender');
assert.ok(B.core.incoming && C.core.incoming);
B.core.accept(); assert.equal(A.core.active, null, 'still waiting for C');
C.core.decline();
const start = wire.filter(m => m.t === 'race-start').at(-1);
assert.deepEqual(start.players, [A.mp.me.id, B.mp.me.id]);
assert.ok(Math.abs(start.startAt - (A.mp.now() + START_DELAY)) < 50, 'GO is START_DELAY ahead on the relay clock');
assert.ok(A.core.active && B.core.active); assert.equal(C.core.active, null);
assert.equal(A.ch.started.at(-1).sync.at, B.ch.started.at(-1).sync.at, 'same countdown for everyone');
assert.equal(A.ch.started.at(-1).mp, true);

// countdown on the shared relay clock: GO is the same instant for both skewed clients
step(START_DELAY - 300, A, B, C);
assert.equal(A.ch.state, 'countdown'); assert.equal(B.ch.state, 'countdown');
step(400, A, B, C);
assert.equal(A.ch.state, 'running'); assert.equal(B.ch.state, 'running');

// progress → live places
A.ch.next = 2; A.ch.pos = { x: 0, z: 130 }; B.ch.next = 2; B.ch.pos = { x: 0, z: 160 };
step(1200, A, B, C);
const prog = A.of('race-progress').filter(m => m.from === B.mp.me.id).at(-1);
assert.equal(prog.checkpoint, 1); assert.ok(Math.abs(prog.dist - 160) < 1e-6);
assert.deepEqual(A.core.rows().map(r => r.id), [B.mp.me.id, A.mp.me.id]);
assert.match(A.core.hudHtml(), /1st Bob/); assert.match(B.core.hudHtml(), /2nd Alice/);
assert.equal(C.of('race-progress').length > 0, true, 'C sees the traffic but ignores it');
assert.deepEqual(C.core.rows(), []);

// finish → results (times on the relay clock)
step(10000, A, B, C); B.core.hook.onFinish(); B.ch.state = 'finished';
step(2500, A, B, C); A.core.hook.onFinish(); A.ch.state = 'finished';
for (const p of [A, B]) {
  const rows = p.core.rows();
  assert.deepEqual(rows.map(r => [r.id, r.place, r.status]), [[B.mp.me.id, 1, 'finished'], [A.mp.me.id, 2, 'finished']], `${p.name} results`);
  assert.ok(Math.abs(rows[0].time - 11.4) < 0.15 && Math.abs(rows[1].time - 13.9) < 0.15, `${p.name} times ${rows.map(r => r.time)}`);
  assert.match(p.core.resultsHtml(), /1st<\/span> Bob.*2nd<\/span> Alice/s);
}

// ---------------------------------------------------------------- accept, then withdraw before the start
A.challenges.quit(); B.challenges.quit();             // close the finish screens
A.core.invite(RACE.id, [B.mp.me.id, C.mp.me.id]);
C.core.accept(); C.core.hook.onLocalStart();          // C starts a solo run instead
assert.deepEqual(wire.filter(m => m.from === C.mp.me.id).at(-1), { from: C.mp.me.id, t: 'race-cancel', inviteId: A.core.outgoing.inviteId });
assert.equal(A.core.lobbyData().rows.find(r => r.id === C.mp.me.id).status, 'decline');
assert.ok(B.core.incoming, "another invitee's withdrawal doesn't end B's invitation");
B.core.accept();
assert.deepEqual(wire.filter(m => m.t === 'race-start').at(-1).players, [A.mp.me.id, B.mp.me.id], 'withdrawn player dropped');
assert.equal(C.core.active, null);

// ---------------------------------------------------------------- host leaves → room closed for everyone
A.mp.leave();
for (const p of [B, C]) {
  assert.equal(p.last('closed').reason, 'host-left'); assert.equal(p.mp.inGame, false); assert.equal(p.mp.players.size, 0);
  assert.equal(p.tuning.car.accel, 20); assert.equal(p.locked, false);
  assert.equal(p.core.active, null);
}
assert.equal(rooms.get(A.mp.me.code).clients.size, 0);
assert.deepEqual(await B.mp.listGames(), [], 'host departure removes public listing');
for (const p of [A, B, C]) p.world.dispose();
assert.equal(time.jobs.size, 0, 'no timers left running');
for (const m of wire.filter(m => m.t === 'state')) assert.ok(m.p.length === 3 && m.q.length === 4 && m.vel.length === 3 && typeof m.glide === 'boolean' && m.v === 'car');
console.log(`PASS mp e2e: relay Room + 3 net.js clients — roster, clock sync, state/skin, world host↔own, kick/rejoin, invite/accept/decline, synced start, progress, finish/results, withdraw, host left (${wire.length} frames)`);
