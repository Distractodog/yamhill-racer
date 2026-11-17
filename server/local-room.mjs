// The local transport must publish the same admitted roster as the Durable Object adapter.
export function attachRoomClient(room, ws, lobby, onEmpty = () => {}, isCurrent = () => true) {
  const cleanup = () => {
    if (!room.session(ws)) return;
    room.expire();
    room.leave(ws);
    if (isCurrent()) lobby.update(room.info);
    if (isCurrent() && !room.clients.size) onEmpty();
  };
  ws.on('message', (data, binary) => {
    if (binary) return ws.close(1003, 'JSON text required');
    const text = data.toString(), before = room.players.length;
    let type; try { type = JSON.parse(text)?.t; } catch {}
    room.receive(ws, text);
    // Publish admission changes, and refresh a live host's TTL even without roster changes.
    if (before !== room.players.length ||
        (['hello', 'heartbeat', 'join-policy', 'leave'].includes(type) && room.session(ws)?.player?.host)) {
      if (isCurrent()) lobby.update(room.info);
    }
    if (isCurrent() && !room.clients.size) onEmpty();
  });
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
