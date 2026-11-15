// Node state-machine test for game/src/mp/racecore.js: a stub relay connects three cores, fake clock + timers.
// Run: node tools/mp_races_test.mjs
import assert from 'node:assert/strict';
import { createRaceCore, routeProgress, INVITE_TTL, START_DELAY, DNF_AFTER } from '../game/src/mp/racecore.js';

const clock = { t: 100000, timers: [], id: 0 };
const timers = {
  setTimeout: (fn, ms) => { const id = ++clock.id; clock.timers.push({ id, fn, at: clock.t + ms }); return id; },
  clearTimeout: id => { clock.timers = clock.timers.filter(x => x.id !== id); },
  setInterval: (fn, ms) => { const id = ++clock.id; clock.timers.push({ id, fn, at: clock.t + ms, every: ms }); return id; },
  clearInterval: id => timers.clearTimeout(id),
};
function advance(ms) {
  const end = clock.t + ms;
  for (;;) {
    const due = clock.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    clock.t = due.at;
    if (due.every) due.at += due.every; else clock.timers = clock.timers.filter(x => x !== due);
    due.fn();
  }
  clock.t = end;
}

const bus = [];                       // all peers; the stub relay forwards to everyone but the sender
function makePeer(id, name) {
  const handlers = {}, players = new Map();
  const mp = { me: { id, name, code: 'AAAAA' }, players, inGame: true, now: () => clock.t,
    on: (t, f) => (handlers[t] ??= []).push(f), off: () => {} };
  const peer = { mp, sent: [], emit(m) { (handlers[m.t] || []).forEach(f => f(m)); } };
  mp.send = m => { peer.sent.push(m); for (const p of bus) if (p !== peer) queueMicrotask(() => p.emit({ ...m, from: id, srvT: clock.t })); };
  const list = [{ id: 'r1', name: 'Race One' }];
  const gates = [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 0, z: 200 }];
  const ch = { state: 'idle', next: 1, started: [], pos: { x: 0, z: 0 } };
  const challenges = { list, get state() { return ch.state; },
    start(i, o) { ch.started.push({ i, o }); ch.state = 'running'; ch.next = 1; },
    runInfo: () => ({ gates, next: ch.next, state: ch.state }) };
  const ui = { incomingLog: [], resultsCalls: 0, incoming(x) { this.incomingLog.push(x); }, lobby() {}, results() { this.resultsCalls++; } };
  peer.ch = ch; peer.ui = ui; peer.core = createRaceCore({ mp, challenges, ui, timers, pos: () => ch.pos });
  bus.push(peer); return peer;
}
const flush = () => new Promise(r => setTimeout(r, 0));
const A = makePeer('A', 'Alice'), B = makePeer('B', 'Bob'), C = makePeer('C', 'Cara');
for (const p of bus) for (const q of bus) if (p !== q) p.mp.players.set(q.mp.me.id, { id: q.mp.me.id, name: q.mp.me.name });
const reset = () => { for (const p of bus) { p.core.hook.onQuit(); p.ch.state = 'idle'; } };

assert.equal(routeProgress([{ x: 0, z: 0 }, { x: 0, z: 100 }], 1, 0, 40), 40);
assert.equal(routeProgress([{ x: 0, z: 0 }, { x: 0, z: 100 }], 2, 0, 0), 100);

// A invites B and C; B accepts, C stays silent
assert.equal(A.core.invite('r1', ['B', 'C', 'A', 'ZZ']), true);
await flush();
assert.equal(B.ui.incomingLog.at(-1).fromName, 'Alice'); assert.match(B.ui.incomingLog.at(-1).raceName, /Race One/);
assert.equal(A.core.lobbyData().rows.length, 2);
B.core.accept(); await flush();
assert.equal(A.core.lobbyData().rows.find(r => r.id === 'B').status, 'accept');
assert.equal(A.core.lobbyData().canStart, true);
assert.equal(A.core.active, null, 'still waiting for C');
advance(INVITE_TTL + 10); await flush();                  // C auto-declines after 30 s; all replied -> start
assert.equal(C.sent.at(-1).accept, false); assert.equal(C.core.incoming, null);
assert.ok(A.core.active, 'inviter started once all replied');
const st = A.sent.find(m => m.t === 'race-start');
assert.equal(st.startAt, A.core.active.startAt); assert.deepEqual(st.players, ['A', 'B']);
assert.ok(Math.abs(st.startAt - (clock.t + START_DELAY)) < 100);
assert.equal(A.ch.started[0].o.sync.at, st.startAt);
assert.ok(B.core.active, 'invitee started'); assert.equal(B.ch.started[0].o.sync.at, st.startAt);
assert.equal(C.core.active, null, 'decliner not in race');

// progress + live places
A.ch.next = 2; A.ch.pos = { x: 0, z: 150 }; B.ch.next = 2; B.ch.pos = { x: 0, z: 120 };
advance(600); await flush();
assert.deepEqual(A.core.rows().map(r => r.id), ['A', 'B']);
assert.match(A.core.hudHtml(), /1st Alice/); assert.match(B.core.hudHtml(), /2nd Bob/);
B.ch.pos = { x: 0, z: 190 }; advance(600); await flush();
assert.deepEqual(B.core.rows().map(r => r.id), ['B', 'A']);

// B finishes first, A later; results ordered by time
B.core.hook.onFinish(31.5); await flush();
advance(5000); A.core.hook.onFinish(33.2); await flush();
assert.deepEqual(A.core.rows().map(r => [r.id, r.place, r.status]), [['B', 1, 'finished'], ['A', 2, 'finished']]);
assert.match(A.core.resultsHtml(), /1st<\/span> Bob<em>0:31\.50/);
assert.equal(A.core.hudHtml(), '');
advance(2000); assert.ok(A.ui.resultsCalls > 0);

// DNF: B presses Esc (race-cancel), C silent for 60 s after A finishes
reset();
A.core.invite('r1', ['B', 'C']); await flush(); B.core.accept(); C.core.accept(); await flush();
assert.deepEqual(A.core.active.players, ['A', 'B', 'C']);
B.core.hook.onQuit(); await flush();
assert.equal(B.sent.at(-1).t, 'race-cancel');
assert.equal(A.core.rows().find(r => r.id === 'B').status, 'dnf');
A.core.hook.onFinish(40); await flush();
assert.equal(A.core.rows().find(r => r.id === 'C').status, 'racing');
advance(DNF_AFTER + 1000);
assert.equal(A.core.rows().find(r => r.id === 'C').status, 'dnf');
assert.deepEqual(A.core.rows().map(r => r.place), [1, null, null]);
const n = A.sent.length; A.core.hook.onQuit(); assert.equal(A.sent.length, n, 'finished player leaving sends no cancel');

// a busy invitee auto-declines, and an all-declined invite closes the lobby
reset();
B.ch.state = 'running'; A.core.invite('r1', ['B']); await flush();
assert.equal(B.sent.at(-1).accept, false); assert.equal(A.core.outgoing, null);
B.ch.state = 'idle';
// manual Start with one reply still pending; a player leaving the room is DNF
A.core.invite('r1', ['B', 'C']); await flush(); B.core.accept(); await flush();
A.core.start(); await flush();
assert.deepEqual(A.core.active.players, ['A', 'B']);
B.emit({ t: 'left', id: 'A' }); assert.equal(B.core.rows().find(r => r.id === 'A').status, 'dnf');
// inviter cancels before anyone started: invitee pop-up closes
reset();
A.core.invite('r1', ['C']); await flush(); assert.ok(C.core.incoming);
A.core.cancelInvite(); await flush(); assert.equal(C.core.incoming, null);
console.log('mp races state machine: OK');
