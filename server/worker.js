import { lobbyObject } from './lobby.mjs';
import { RoomLobby } from './room-lobby.mjs';
export { Lobby } from './lobby.mjs';
import { RelayStats } from './relaystats.mjs';
import { Room, roomAddress } from './relay.mjs';
import { hit, authorized, statsObject } from './stats.mjs';
export { Stats } from './stats.mjs';

export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/lobby' && request.method === 'GET') return lobbyObject(env).fetch(request);
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
    this.layoutStored = new Map();
    this.layoutSaving = Promise.resolve();
    this.counted = false;
    this.lobby = new RoomLobby(this);
    const sockets = ctx.getWebSockets();
    const first = sockets[0]?.deserializeAttachment();
    this.room = new Room(first?.code);
    this.stats = new RelayStats(ctx, env, this.room);
    this.room.onChat = line => this.stats.chat(line);
    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment();
      if (attachment?.session) this.room.restore(ws, attachment.session);
      else ws.close(1000, 'invalid-session');
    }
    ctx.blockConcurrencyWhile(async () => {
      const before = this.lobby.snapshot();
      if (this.room.host) {
        this.counted = (await ctx.storage.get('counted')) === true;
        this.room.world = (await ctx.storage.get('world')) ?? null;
        const layout = await ctx.storage.get('layout');
        if (layout) {
          for (const key of layout.keys || []) this.layoutStored.set(key, await ctx.storage.get(key));
          this.room.layout = layout.complete?.map(key => this.layoutStored.get(key)) ?? null;
          this.room.layoutPending = layout.pending ? { ...layout.pending, chunks: Object.fromEntries(layout.pending.keys.map(key => { const c = this.layoutStored.get(key); return [c.index, c]; })) } : null;
        }
      }
      else {
        await ctx.storage.delete('world');
        const layout = await ctx.storage.get?.('layout');
        for (const key of layout?.keys || []) await ctx.storage.delete(key);
        await ctx.storage.delete('layout');
        for (const ws of this.room.clients.keys()) {
          const s = this.room.session(ws);
          if (s.player || s.pending) { this.room.removeRejected(ws, 'no-host'); this.saveSession(ws); }
        }
      }
      await this.stats.restore().catch(() => {});
      await this.expire();
      await this.lobby.sync(before);
    });
  }
  async fetch(request) {
    await this.expire();
    const address = roomAddress(request.url);
    if (!address) return new Response('Invalid room address', { status: 400 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket required', { status: 426 });
    }
    this.room.code = address.code;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const before = this.lobby.snapshot(), oldWorld = this.room.world;
    this.room.connect(address.id, server);
    this.saveSession(server);
    // connect() also checks the clock: it may cross the deadline after fetch's initial await.
    await this.finishExpiry(before, oldWorld);
    return new Response(null, { status: 101, webSocket: client });
  }
  saveSession(ws) {
    // Null out removed members too: a closing socket may still appear in getWebSockets().
    ws.serializeAttachment({ code: this.room.code, session: this.room.session(ws) ?? null });
  }
  async webSocketMessage(ws, message) {
    await this.expire();
    if (!this.room.session(ws)) return;
    let type; try { type = JSON.parse(message)?.t; } catch {}
    const lobbyChange = ['hello', 'join-request', 'join-accept', 'join-decline', 'join-policy', 'heartbeat', 'kick', 'leave'].includes(type);
    const lobbyBefore = this.lobby.snapshot();
    if (type === 'join-request' && await this.lobby.prepare(ws, message) === false) return;
    const original = lobbyBefore.find(([peer]) => peer === ws);
    if (original && this.room.session(ws)?.claimed) original[1].claimed = true;
    const oldWorld = this.room.world;
    const oldClients = [...this.room.clients.keys()];
    const hadHost = !!this.room.host;
    this.room.receive(ws, message);
    const lostHost = hadHost && !this.room.host;
    for (const peer of oldClients) this.saveSession(peer);
    if (!this.counted && this.room.players.length >= 2) {
      this.counted = true;
      await this.ctx.storage.put('counted', true);
    }
    if (!this.room.players.length && this.counted) {
      this.counted = false;
      await this.ctx.storage.delete('counted');
    }
    // Game records are the source for MP totals; do not send legacy ID-less /game hits.
    await this.stats.update().catch(() => {});
    this.saveSession(ws);
    for (const peer of oldClients) {
      if (!this.room.clients.has(peer)) this.saveSession(peer);
    }
    await this.saveWorld(oldWorld);
    if (lobbyChange || lobbyBefore.some(([peer]) => !this.room.session(peer))) await this.lobby.sync(lobbyBefore);
    if (type === 'layout' || lostHost) await this.saveLayout();
  }
  saveLayout() {
    // Close/expiry may overlap a new host while storage awaits. Always finish the latest layout last.
    this.layoutSaving = this.layoutSaving.catch(() => {}).then(() => this.persistLayout());
    return this.layoutSaving;
  }
  async persistLayout() {
    // Each storage value stays small too, not just the WebSocket frames.
    const next = new Map(), keyOf = c => `layout:${c.revision}:${c.index}`;
    const complete = this.room.layout?.map(c => { const key = keyOf(c); next.set(key, c); return key; }) ?? null;
    const p = this.room.layoutPending;
    const pending = p ? { revision: p.revision, total: p.total, keys: Object.values(p.chunks).map(c => { const key = keyOf(c); next.set(key, c); return key; }) } : null;
    for (const [key, chunk] of next) if (this.layoutStored.get(key) !== chunk) await this.ctx.storage.put(key, chunk);
    if (next.size) await this.ctx.storage.put('layout', { complete, pending, keys: [...next.keys()] });
    else await this.ctx.storage.delete('layout');
    for (const key of this.layoutStored.keys()) if (!next.has(key)) await this.ctx.storage.delete(key);
    this.layoutStored = next;
  }
  async saveWorld(oldWorld) {
    if (this.room.world === oldWorld) return;
    if (this.room.world) await this.ctx.storage.put('world', this.room.world);
    else await this.ctx.storage.delete('world');
  }
  async webSocketClose(ws) {
    await this.expire();
    if (!this.room.session(ws)) return;
    const lobbyBefore = this.lobby.snapshot();
    const oldWorld = this.room.world;
    const oldClients = [...this.room.clients.keys()];
    this.room.leave(ws);
    for (const peer of oldClients) this.saveSession(peer);
    if (!this.room.players.length && this.counted) {
      this.counted = false;
      await this.ctx.storage.delete('counted');
    }
    await this.stats.update().catch(() => {});
    for (const peer of oldClients) this.saveSession(peer);
    await this.saveWorld(oldWorld);
    await this.saveLayout();
    await this.lobby.sync(lobbyBefore);
    try { ws.close(1000, 'disconnected'); } catch { /* Already closed. */ }
  }
  async expire() {
    if (this.room.deadline > this.room.now()) return;
    const before = this.lobby.snapshot(), oldWorld = this.room.world;
    this.room.expire();
    await this.finishExpiry(before, oldWorld);
  }
  async finishExpiry(before, oldWorld) {
    const changed = before.some(([ws]) => !this.room.session(ws));
    if (!changed) return;
    // Invalidate attachments before the first await, including when close callbacks are delayed.
    for (const [ws] of before) this.saveSession(ws);
    if (!this.room.host) { this.counted = false; await this.ctx.storage.delete('counted'); }
    await this.saveWorld(oldWorld);
    await this.saveLayout();
    await this.stats.update().catch(() => {});
    await this.lobby.sync(before);
  }
  async alarm() { await this.expire(); await this.lobby.sync([]); }
  webSocketError(ws) { return this.webSocketClose(ws); }
}
