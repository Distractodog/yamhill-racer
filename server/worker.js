import { Room, roomAddress } from './relay.mjs';
import { hit, authorized, statsObject } from './stats.mjs';
export { Stats } from './stats.mjs';

export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/hit') return hit(request, env).catch(() => new Response(null, { status: 503 }));
    if (path === '/stats') {
      if (request.method !== 'GET' || !authorized(request, env.STATS_KEY)) return new Response(null, { status: 404 });
      return statsObject(env).fetch(new Request('https://stats/stats'));
    }
    const address = roomAddress(request.url);
    if (!address) return new Response('Invalid room address', { status: 400 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket required', { status: 426 });
    }
    return env.ROOMS.get(env.ROOMS.idFromName(address.code)).fetch(request);
  },
};

export class RelayRoom {
  constructor(ctx, env) {
    this.env = env;
    this.ctx = ctx;
    const sockets = ctx.getWebSockets();
    const first = sockets[0]?.deserializeAttachment();
    this.room = new Room(first?.code);
    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment();
      if (attachment?.session) this.room.restore(ws, attachment.session);
      else ws.close(1000, 'invalid-session');
    }
    ctx.blockConcurrencyWhile(async () => {
      if (this.room.host) this.room.world = (await ctx.storage.get('world')) ?? null;
      else {
        await ctx.storage.delete('world');
        for (const ws of this.room.clients.keys()) {
          if (this.room.session(ws).player) this.room.removeRejected(ws, 'no-host');
        }
      }
    });
  }
  fetch(request) {
    const address = roomAddress(request.url);
    if (!address) return new Response('Invalid room address', { status: 400 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket required', { status: 426 });
    }
    this.room.code = address.code;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    this.room.connect(address.id, server);
    this.saveSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  saveSession(ws) {
    // Null out removed members too: a closing socket may still appear in getWebSockets().
    ws.serializeAttachment({ code: this.room.code, session: this.room.session(ws) ?? null });
  }
  async webSocketMessage(ws, message) {
    const oldWorld = this.room.world;
    const oldClients = [...this.room.clients.keys()];
    const hadHost = !!this.room.host;
    this.room.receive(ws, message);
    if (!hadHost && this.room.host && this.env?.STATS) {
      // Analytics cannot delay or reject room messages; waitUntil survives hibernation.
      try {
        this.ctx.waitUntil(statsObject(this.env).fetch(new Request('https://stats/game', { method: 'POST' })).catch(() => {}));
      } catch { /* Stats unavailable; multiplayer keeps working. */ }
    }
    this.saveSession(ws);
    for (const peer of oldClients) {
      if (!this.room.clients.has(peer)) this.saveSession(peer);
    }
    await this.saveWorld(oldWorld);
  }
  async saveWorld(oldWorld) {
    if (this.room.world === oldWorld) return;
    if (this.room.world) await this.ctx.storage.put('world', this.room.world);
    else await this.ctx.storage.delete('world');
  }
  async webSocketClose(ws) {
    const oldWorld = this.room.world;
    const oldClients = [...this.room.clients.keys()];
    this.room.leave(ws);
    for (const peer of oldClients) this.saveSession(peer);
    await this.saveWorld(oldWorld);
    try { ws.close(1000, 'disconnected'); } catch { /* Already closed. */ }
  }
  webSocketError(ws) { return this.webSocketClose(ws); }
}
