import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Room, roomAddress, MAX_MESSAGE_BYTES } from './relay.mjs';

import { LobbyState } from './lobby.mjs';
const lobby = new LobbyState(), rooms = new Map();
const server = createServer((req, res) => {
  if (req.url === '/lobby' && req.method === 'GET') return res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }).end(JSON.stringify({ games: lobby.list() }));
  res.writeHead(404).end('Use WebSocket /room/<code>?id=<playerId>');
});
const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
server.on('upgrade', (req, socket, head) => {
  const address = roomAddress(new URL(req.url, 'http://relay.invalid'));
  if (!address) return socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  sockets.handleUpgrade(req, socket, head, ws => {
    let room = rooms.get(address.code);
    if (!room) rooms.set(address.code, room = new Room(address.code, { admission: lobby }));
    const cleanup = () => {
      room.leave(ws); lobby.update(room.info);
      if (!room.clients.size && rooms.get(address.code) === room) rooms.delete(address.code);
    };
    ws.on('message', (data, binary) => {
      if (binary) return ws.close(1003, 'JSON text required');
      const before = room.players.length;
      room.receive(ws, data.toString());
      let type; try { type = JSON.parse(data).t; } catch {}
      if (before !== room.players.length || (['hello', 'heartbeat', 'join-policy'].includes(type) && room.session(ws)?.player?.host)) lobby.update(room.info);
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);
    room.connect(address.id, ws);
  });
});
// Local equivalent of Durable Object alarms. No timers are created by protocol imports.
const expiry = setInterval(() => { for (const room of rooms.values()) room.expire(); }, 500);
server.on('close', () => clearInterval(expiry));
const port = Number(process.argv[2] || 8787);     // node server/local.mjs [port]
server.listen(port, '127.0.0.1', () => console.log(`MP relay: ws://127.0.0.1:${port}`));
