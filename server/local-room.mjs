// The local transport must publish the same admitted roster as the Durable Object adapter.
export function attachRoomClient(room, ws, lobby, onEmpty = () => {}) {
  const cleanup = () => {
    room.leave(ws);
    lobby.update(room.info);
    if (!room.clients.size) onEmpty();
  };
  ws.on('message', (data, binary) => {
    if (binary) return ws.close(1003, 'JSON text required');
    const text = data.toString(), before = room.players.length;
    let type; try { type = JSON.parse(text)?.t; } catch {}
    room.receive(ws, text);
    // Publish admission changes, and refresh a live host's TTL even without roster changes.
    if (before !== room.players.length ||
        (['hello', 'heartbeat', 'join-policy'].includes(type) && room.session(ws)?.player?.host)) {
      lobby.update(room.info);
    }
  });
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
