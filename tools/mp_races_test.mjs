// Node state-machine test for game/src/mp/racecore.js: a stub relay connects three cores, fake clock + timers.
// Run: node tools/mp_races_test.mjs
import assert from 'node:assert/strict';
import { createRaceCore, makeRoute, routeProgress, INVITE_TTL, START_DELAY, DNF_AFTER } from '../game/src/mp/racecore.js';

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
  mp.send = m => { peer.sent.push(m); for (const p of bus) queueMicrotask(() => p.emit({ ...m, from: id, srvT: clock.t })); };
  const list = [{ id: 'r1', name: 'Race One' }];
  const gates = [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 0, z: 200 }];
  const ch = { state: 'idle', next: 1, started: [], pos: { x: 0, z: 0 } };
  const challenges = { list, get state() { return ch.state; },
    start(i, o) { ch.started.push({ i, o }); ch.state = 'running'; ch.next = 1; },
    quit() { ch.state = 'idle'; ch.quit = (ch.quit || 0) + 1; },
    dnf() { ch.state = 'finished'; ch.dnf = (ch.dnf || 0) + 1; },
    runInfo: () => ({ id: 'r1', gates, track: [[0, 0, 5], [0, 100, 5], [0, 200, 5]], next: ch.next, state: ch.state }) };
  const ui = { incomingLog: [], resultsCalls: 0, incoming(x) { this.incomingLog.push(x); }, lobby() {}, notices: [], notice(t) { this.notices.push(t); }, results() { this.resultsCalls++; } };
  peer.ch = ch; peer.ui = ui; peer.core = createRaceCore({ mp, challenges, ui, timers, pos: () => ch.pos });
  bus.push(peer); return peer;
}
const flush = () => new Promise(r => setTimeout(r, 0));
const A = makePeer('A', 'Alice'), B = makePeer('B', 'Bob'), C = makePeer('C', 'Cara');
for (const p of bus) for (const q of bus) if (p !== q) p.mp.players.set(q.mp.me.id, { id: q.mp.me.id, name: q.mp.me.name });
const reset = () => { for (const p of bus) { p.core.hook.onQuit(); p.ch.state = 'idle'; } };

// route progress follows the centre line (an L-shaped route, not the straight line between gates) and is checkpoint-bounded
const L = makeRoute({ gates: [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }], track: [[0, 0, 5], [100, 0, 5], [100, 100, 5]] });
assert.deepEqual(L.gateS.map(Math.round), [0, 100, 200]);
assert.equal(Math.round(routeProgress(L, 1, 40, 3)), 40);
assert.equal(Math.round(routeProgress(L, 2, 103, 30)), 130);
assert.equal(Math.round(routeProgress(L, 2, 0, 0)), 100, 'bounded below by the last checkpoint');
assert.equal(Math.round(routeProgress(L, 1, 100, 100)), 100, 'bounded above by the next checkpoint');
assert.equal(Math.round(routeProgress(L, 3, 0, 0)), 200);

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
const at0 = A.core.active.startAt;                      // finish times come from the relay clock: now - startAt
advance(at0 + 31500 - clock.t); B.core.hook.onFinish(); await flush();
advance(1700); A.core.hook.onFinish(); await flush();
assert.equal(A.sent.filter(m => m.t === 'race-start').length, 1, 'inviter started once despite the echo');
assert.equal(A.core.rows().find(r => r.id === 'A').time.toFixed(2), '33.20');
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
A.core.hook.onFinish(); await flush();
assert.equal(A.core.rows().find(r => r.id === 'C').status, 'racing');
advance(DNF_AFTER + 1000);
assert.equal(A.core.rows().find(r => r.id === 'C').status, 'dnf');
assert.deepEqual(A.core.rows().map(r => r.place), [1, null, null]);
const iid = A.core.active.inviteId;                     // DNF is terminal: late / post-cancel finishes are ignored
A.emit({ t: 'race-finish', inviteId: iid, from: 'C', time: 70, srvT: clock.t });
A.emit({ t: 'race-finish', inviteId: iid, from: 'B', time: 45, srvT: clock.t - 50000 });
assert.deepEqual(A.core.rows().map(r => r.status), ['finished', 'dnf', 'dnf']);
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
// one pending invite at a time: accepted-but-not-started blocks a second invite and my own invites; solo start clears it
reset();
A.core.invite('r1', ['B']); await flush(); B.core.accept(); await flush();   // (A auto-starts: B was the only invitee)
reset();
A.core.invite('r1', ['B', 'C']); await flush(); B.core.accept(); await flush();
assert.equal(B.core.accepted !== null, true);
C.core.accept(); await flush();                                              // C accepts -> A starts for B + C
assert.ok(A.core.active);
reset();
A.core.invite('r1', ['B', 'C']); await flush(); B.core.accept(); await flush();   // B accepted, A still waiting on C
const nb = B.sent.length;
C.core.invite('r1', ['B']); await flush();                                   // C (has an open invite) can't invite
assert.equal(C.core.outgoing, null);
assert.equal(B.core.invite('r1', ['A']), false, 'accepted-but-unstarted blocks inviting');
B.core.hook.onLocalStart(); assert.equal(B.core.accepted, null, 'solo start clears accepted');
// disconnect: everything cleaned up, no timers left firing
A.core.reset(true); B.core.reset(true); C.core.reset(true); reset();
assert.equal(A.core.outgoing, null);
A.core.invite('r1', ['B']); await flush(); assert.ok(B.core.incoming);
B.emit({ t: 'disconnected' }); A.emit({ t: 'closed' });
assert.equal(B.core.incoming, null); assert.equal(A.core.outgoing, null);
assert.equal(clock.timers.length, 0, 'no timers left after disconnect');
A.core.invite('r1', ['B']); await flush(); B.core.accept(); await flush();
assert.ok(A.core.active); A.ch.state = 'running'; A.emit({ t: 'disconnected' });
assert.equal(A.core.active, null); assert.equal(A.ch.quit, 1, 'running race quit on disconnect');
B.emit({ t: 'disconnected' });
assert.equal(clock.timers.length, 0);
// a late player (placed after startAt) just takes the shared clock: the sync handed to challenges reads the relay clock
A.core.hook.onQuit(); reset();
A.core.invite('r1', ['B']); await flush(); B.core.accept(); await flush();
const sy = B.ch.started.at(-1).o.sync; advance(7000);
assert.equal((sy.now() - sy.at) / 1000, 2, 'elapsed since startAt, not since placement');
// starting a solo run cancels my outgoing invite: a late acceptance can't replace it
reset();
A.core.invite('r1', ['B', 'C']); await flush(); B.core.accept(); await flush();
A.core.hook.onLocalStart(); await flush();
assert.equal(A.core.outgoing, null); assert.equal(A.sent.at(-1).t, 'race-cancel');
assert.equal(B.core.accepted, null, 'accepted invitee released'); assert.equal(C.core.incoming, null, 'pending pop-up closed');
C.emit({ t: 'invite-reply', inviteId: 'x', from: 'C', accept: true }); await flush();
assert.equal(A.core.active, null); assert.equal(A.sent.some(m => m.t === 'race-start'), A.sent.some(m => m.t === 'race-start'));
const startsBefore = A.sent.filter(m => m.t === 'race-start').length;
A.emit({ t: 'invite-reply', inviteId: 'late', from: 'C', accept: true });
assert.equal(A.sent.filter(m => m.t === 'race-start').length, startsBefore, 'late accept starts nothing');
// ...and leaving declines an incoming invite I hadn't answered
reset();
A.core.invite('r1', ['C']); await flush(); assert.ok(C.core.incoming);
C.core.hook.onLocalStart(); await flush();
assert.equal(C.core.incoming, null); assert.equal(C.sent.at(-1).accept, false);
assert.equal(A.core.outgoing, null, 'inviter saw the decline');
// race-start closes a matching pop-up for someone left out, and releases an accepted-but-excluded player
reset();
A.core.invite('r1', ['B', 'C']); await flush(); B.core.accept(); await flush();
assert.ok(C.core.incoming);
const nC = C.ui.notices.length;
A.core.start(); await flush();                          // C never answered -> excluded
assert.equal(C.core.incoming, null); assert.equal(C.ui.notices.length, nC + 1); assert.equal(C.ui.notices.at(-1), 'Race started without you'); assert.equal(C.core.active, null);
reset();
A.core.invite('r1', ['B']); await flush(); B.core.accept(); await flush();   // starts for B
reset();
A.core.invite('r1', ['B', 'C']); await flush(); B.core.accept(); await flush();
const nB = B.ui.notices.length;
B.emit({ t: 'race-start', inviteId: B.core.accepted, from: 'A', players: ['A'], startAt: clock.t + 5000 });
assert.equal(B.core.accepted, null); assert.equal(B.ui.notices.length, nB + 1); assert.equal(B.core.active, null);
// the winner's +60 s deadline: my run is stopped, progress stops, results shown
reset();
A.core.invite('r1', ['B']); await flush(); B.core.accept(); await flush();
A.ch.next = 2; advance(600); await flush();
B.core.hook.onFinish(); await flush();
const prog = () => A.sent.filter(m => m.t === 'race-progress').length, p0 = prog(), r0 = A.ui.resultsCalls;
advance(DNF_AFTER + 1500); await flush();
assert.equal(A.ch.dnf, 1, 'local challenge stopped'); assert.equal(A.core.active.myDone, true);
assert.equal(A.core.rows().find(r => r.id === 'A').status, 'dnf'); assert.ok(A.ui.resultsCalls > r0);
const p1 = prog(); advance(3000); assert.equal(prog(), p1, 'no more progress after the DNF'); assert.ok(p1 >= p0);
// withdrawing after accepting (solo run before the start): race-cancel, the inviter drops that player from the race
A.core.hook.onQuit(); A.ch.state = 'idle'; reset();
A.core.invite('r1', ['B', 'C']); await flush(); B.core.accept(); await flush();
B.core.hook.onLocalStart(); await flush();
assert.deepEqual(B.sent.at(-1), { t: 'race-cancel', inviteId: A.core.outgoing.inviteId });
assert.equal(A.core.lobbyData().rows.find(r => r.id === 'B').status, 'decline');
assert.equal(A.core.lobbyData().canStart, false);
C.core.accept(); await flush();
assert.deepEqual(A.core.active.players, ['A', 'C'], 'withdrawn player is not in race-start');
assert.equal(B.core.active, null);
// the only acceptor withdrawing (nobody left) closes the invitation
reset();
A.core.invite('r1', ['B', 'C']); await flush(); B.core.accept(); C.core.decline(); await flush();
assert.ok(A.core.active); reset();                      // (B + A started; clear it)
A.core.invite('r1', ['B', 'C']); await flush(); B.core.accept(); await flush();
B.core.hook.onLocalStart(); C.core.decline(); await flush();
assert.equal(A.core.outgoing, null); assert.equal(A.core.active, null); assert.equal(A.sent.at(-1).t, 'race-cancel');
// closing a finish screen is not a withdrawal: the accepted invite stays
reset();
A.core.invite('r1', ['B', 'C']); await flush(); B.core.accept(); await flush();
B.ch.state = 'finished'; const nb2 = B.sent.length; B.core.hook.onQuit(); await flush();
assert.equal(B.sent.length, nb2); assert.ok(B.core.accepted); B.ch.state = 'idle';
C.core.accept(); await flush();
assert.deepEqual(A.core.active.players, ['A', 'B', 'C']); assert.ok(B.core.active);
console.log('mp races state machine: OK');

// A low-barrier escape is a final local DNF, relayed without ending the other player's run.
reset(); A.core.invite('r1',['B']);await flush();B.core.accept();await flush();
B.ch.state='finished';B.core.hook.onDnf();await flush();
assert.equal(B.core.active.myDone,true);assert.equal(A.core.rows().find(r=>r.id==='B').status,'dnf');
assert.equal(A.core.rows().find(r=>r.id==='A').status,'racing');
const count=B.sent.length;B.core.hook.onDnf();B.core.hook.onFinish();assert.equal(B.sent.length,count,'DNF cannot finish or send twice');
assert.match(B.core.resultsHtml(),/DNF/);reset();
console.log('PASS multiplayer barrier DNF propagation, other racer continues, no late finish');
