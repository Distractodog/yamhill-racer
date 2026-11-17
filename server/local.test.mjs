// Exercise the CLI adapter as well as the shared protocol: real HTTP and WebSocket traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { attachRoomClient } from './local-room.mjs';
import { Room } from './relay.mjs';
import { LobbyState, LOBBY_TTL } from './lobby.mjs';
import WebSocket from 'ws';
import { Net } from '../game/src/mp/net.js';

function event(net, type) {
  return new Promise(resolve => {
    const off = net.on(type, value => { off(); resolve(value); });
  });
}

test('local CLI lists a host, admits a requested guest, updates counts and removes a departed host', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, [new URL('./local.mjs', import.meta.url).pathname, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let output = '';
  child.stderr.on('data', data => { output += data; });
  const host = new Net({ WebSocketImpl: WebSocket, storage: null });
  const guest = new Net({ WebSocketImpl: WebSocket, storage: null });
  t.after(async () => {
    host.leave(); guest.leave();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  try {
    const url = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => {
        if (/listen EPERM/.test(output)) resolve(null);
        else reject(Error(`Local relay exited: ${output}`));
      });
      child.stdout.on('data', data => {
        output += data;
        const match = output.match(/MP relay: (ws:\/\/127\.0\.0\.1:\d+)/);
        if (match) resolve(match[1]);
      });
    });
    if (!url) { t.skip('Sandbox forbids loopback listening (EPERM); run this test outside the sandbox'); return; }
    host._relay = guest._relay = url;
    host.setName('Local Host'); guest.setName('Local Guest');
    const listing = async () => {
      const response = await fetch(url.replace(/^ws/, 'http') + '/lobby');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return (await response.json()).games;
    };
    await host.host();
    const games = await listing();
    assert.equal(games.length, 1);
    assert.equal(games[0].id, host.roomCode);
    assert.equal(games[0].name, 'Local Host');
    assert.equal(games[0].players, 1);
    assert.deepEqual(await guest.listGames(), games);

    const requested = event(host, 'join-request');
    const joining = guest.requestJoin(games[0].id);
    const request = await requested;
    assert.equal(request.name, 'Local Guest');
    assert.equal(guest.inGame, false);
    assert.equal((await listing())[0].players, 1, 'pending guests are excluded');
    host.send({ t: 'join-accept', id: request.id });
    await joining;
    assert.equal(guest.inGame, true);
    assert.equal(guest.players.size, 2);
    assert.equal((await listing())[0].players, 2);

    const closed = event(guest, 'closed');
    host.leave();
    await closed;
    assert.deepEqual(await listing(), []);
  } finally {
    host.leave(); guest.leave();
    child.kill();
    await exited;
  }
});

// The actual CLI message handlers can also run without a listening port.
test('local message adapter registers hosts, refreshes TTL, excludes pending guests and publishes acceptance/leave', () => {
  let now = 1000, empty = 0;
  const lobby = new LobbyState({ now: () => now });
  const room = new Room('ABCDE', { now: () => now, admission: lobby });
  const connect = id => {
    const ws = new EventEmitter(); ws.messages = [];
    ws.send = text => ws.messages.push(JSON.parse(text));
    ws.close = () => ws.emit('close');
    attachRoomClient(room, ws, lobby, () => empty++);
    room.connect(id, ws);
    return ws;
  };
  const send = (ws, msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)), false);
  const hello = (host, name) => ({ t: host ? 'hello' : 'join-request', host, name, code: 'ABCDE', skin: { vehicle: 'car' } });
  const host = connect('000000000001');
  send(host, hello(true, 'Local Host'));
  assert.equal(lobby.list()[0].name, 'Local Host');
  assert.equal(lobby.list()[0].players, 1);
  // Heartbeats keep a host discoverable across more than the listing's original TTL.
  now += LOBBY_TTL - 1; send(host, { t: 'heartbeat' });
  now += LOBBY_TTL - 1;
  assert.equal(lobby.list().length, 1);
  send(host, { t: 'heartbeat' }); assert.equal(lobby.list().length, 1);
  const guest = connect('000000000002');
  send(guest, hello(false, 'Local Guest'));
  assert.equal(lobby.list()[0].players, 1);
  assert.ok(host.messages.some(m => m.t === 'join-request' && m.name === 'Local Guest'));
  send(host, { t: 'join-accept', id: '000000000002' });
  assert.equal(lobby.list()[0].players, 2);
  assert.equal(guest.messages.filter(m => m.t === 'roster').at(-1).players.length, 2);
  guest.emit('close'); assert.equal(lobby.list()[0].players, 1);
  host.emit('close'); assert.deepEqual(lobby.list(), []); assert.equal(empty, 1);
});

test('local delayed closes, guest traffic and live duplicates cannot revive or replace expired hosting', () => {
  let now = 0, current;
  const lobby = new LobbyState({ now: () => now });
  const openRoom = () => new Room('ABCDE', { now: () => now, admission: lobby });
  const open = (room, id, host) => {
    const ws = new EventEmitter(); ws.send = () => {}; ws.close = () => {}; // Withhold every close callback.
    attachRoomClient(room, ws, lobby, () => {}, () => current === room);
    room.connect(id, ws);
    ws.emit('message', Buffer.from(JSON.stringify({ t: host ? 'hello' : 'join-request', host, name: 'Local', code: 'ABCDE', skin: { vehicle: 'car' } })), false);
    return ws;
  };
  const send = (ws, message) => ws.emit('message', Buffer.from(JSON.stringify(message)), false);
  const room = current = openRoom(), host = open(room, '000000000001', true);
  send(host, { t: 'join-policy', anyone: true });
  const guest = open(room, '000000000002', false);
  now = 29999; send(guest, { t: 'ping' }); assert.ok(room.host);
  assert.equal(room.connect('000000000001', { send() {}, close() {} }), false, 'live duplicate rejection');
  now = 30000; send(guest, { t: 'state' });
  assert.equal(room.host, undefined); assert.deepEqual(lobby.list(), []);
  send(host, { t: 'heartbeat' }); assert.deepEqual(lobby.list(), []);
  const next = current = openRoom(), fresh = open(next, '000000000001', true);
  host.emit('close'); guest.emit('error'); send(host, { t: 'leave' });
  assert.equal(lobby.list().length, 1); assert.ok(next.host, 'old room callbacks do not delete fresh listing');
  send(fresh, { t: 'leave' }); assert.deepEqual(lobby.list(), []); assert.equal(next.host, undefined);
});
