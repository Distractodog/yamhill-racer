import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Room, roomAddress, MAX_MESSAGE_BYTES } from './relay.mjs';

const rooms = new Map();
const server = createServer((req, res) => {
  res.writeHead(404).end('Use WebSocket /room/<code>?id=<playerId>');
});
const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
server.on('upgrade', (req, socket, head) => {
  const address = roomAddress(new URL(req.url, 'http://relay.invalid'));
  if (!address) return socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  sockets.handleUpgrade(req, socket, head, ws => {
    let room = rooms.get(address.code);
    if (!room) rooms.set(address.code, room = new Room(address.code));
    const cleanup = () => {
      room.leave(ws);
      if (!room.clients.size && rooms.get(address.code) === room) rooms.delete(address.code);
    };
    ws.on('message', (data, binary) => {
      if (binary) return ws.close(1003, 'JSON text required');
      room.receive(ws, data.toString());
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);
    room.connect(address.id, ws);
  });
});
server.listen(8787, '127.0.0.1', () => console.log('MP relay: ws://127.0.0.1:8787'));
