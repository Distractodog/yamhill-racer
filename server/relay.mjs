// Transport-independent protocol. Clients provide send(JSON text) and close(code, reason).
export const MAX_PLAYERS = 16;
export const MAX_MESSAGE_BYTES = 16384;
const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;
const ID = /^[A-Za-z0-9_-]{12}$/;
const RACES = new Set(['invite', 'invite-reply', 'race-start', 'race-progress', 'race-finish', 'race-cancel']);
export function roomAddress(url) {
  const u = new URL(url);
  const match = /^\/room\/([^/]+)$/.exec(u.pathname);
  const code = match?.[1];
  const id = u.searchParams.get('id');
  return CODE.test(code || '') && ID.test(id || '') ? { code, id } : null;
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const skinOK = skin => object(skin) && ['car', 'bike', 'jet'].includes(skin.vehicle) &&
  new TextEncoder().encode(JSON.stringify(skin)).length <= 1024;

export class Room {
  constructor(code, { now = Date.now } = {}) {
    this.code = code;
    this.now = now;
    this.clients = new Map();
    this.world = null;
  }
  get host() { return [...this.clients.values()].find(s => s.player?.host); }
  get players() { return [...this.clients.values()].filter(s => s.player).map(s => s.player); }
  connect(id, client) {
    if (!ID.test(id)) return this.reject(client, 'invalid-id');
    if ([...this.clients.values()].some(s => s.id === id)) return this.reject(client, 'duplicate-id');
    if (this.clients.size >= MAX_PLAYERS) return this.reject(client, 'full');
    this.clients.set(client, { id, player: null, lastState: null });
    return true;
  }
  // Attachments are trusted adapter data, never accepted from a wire message.
  restore(client, session) { this.clients.set(client, structuredClone(session)); }
  session(client) { return this.clients.get(client); }
  send(client, msg) {
    try { client.send(JSON.stringify(msg)); } catch { /* Transport close/error performs cleanup. */ }
  }
  close(client, reason) { try { client.close(1000, reason); } catch { /* Already closed. */ } }
  reject(client, reason) {
    this.send(client, { t: 'closed', reason });
    this.close(client, reason);
    return false;
  }
  broadcast(msg, except) {
    for (const [client, session] of this.clients) {
      if (session.player && client !== except) this.send(client, msg);
    }
  }
  roster() { this.broadcast({ t: 'roster', players: this.players }); }
  receive(client, text) {
    const session = this.clients.get(client);
    if (!session) return;
    let msg;
    try {
      if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES) return;
      msg = JSON.parse(text);
    } catch { return; }
    if (!object(msg) || typeof msg.t !== 'string') return;
    if (!session.player) {
      if (msg.t !== 'hello') return this.removeRejected(client, 'hello-required');
      if (typeof msg.name !== 'string' || msg.name.length > 128 || !CODE.test(msg.code || '') ||
          typeof msg.host !== 'boolean' || !skinOK(msg.skin)) return this.removeRejected(client, 'invalid-hello');
      if (msg.host && (this.host || msg.code !== this.code)) return this.removeRejected(client, 'host-conflict');
      if (!msg.host && !this.host) return this.removeRejected(client, 'no-host');
      session.player = { id: session.id, name: msg.name, code: msg.code, host: msg.host, skin: msg.skin };
      this.broadcast({ t: 'joined', player: session.player }, client);
      this.roster();
      if (this.world) this.send(client, this.world);
      return;
    }
    const srvT = this.now();
    const forwarded = { ...msg, from: session.id, srvT };
    if (msg.t === 'ping') {
      this.send(client, { t: 'pong', c: msg.c, srvT });
    } else if (msg.t === 'state') {
      if (session.lastState !== null && srvT - session.lastState < 25) return;
      session.lastState = srvT;
      this.broadcast(forwarded, client);
    } else if (msg.t === 'skin' && skinOK(msg.skin)) {
      session.player.skin = msg.skin;
      this.broadcast(forwarded, client);
      this.roster();
    } else if (msg.t === 'world' && session.player.host) {
      if (!['host', 'own'].includes(msg.mode) || !object(msg.settings)) return;
      this.world = forwarded;
      this.broadcast(forwarded);
    } else if (msg.t === 'kick' && session.player.host) {
      const target = [...this.clients].find(([, s]) => s.id === msg.id && s.player && !s.player.host);
      if (!target) return;
      this.send(target[0], { t: 'kicked' });
      this.leave(target[0]);
      this.close(target[0], 'kicked');
    } else if (RACES.has(msg.t)) {
      this.broadcast(forwarded);
    }
  }
  removeRejected(client, reason) {
    this.clients.delete(client);
    return this.reject(client, reason);
  }
  leave(client) {
    const session = this.clients.get(client);
    if (!session) return;
    this.clients.delete(client);
    if (session.player?.host) {
      this.world = null;
      const remaining = [...this.clients.keys()];
      this.clients.clear(); // Remove before close callbacks can reenter.
      for (const peer of remaining) this.reject(peer, 'host-left');
    } else if (session.player) {
      this.broadcast({ t: 'left', id: session.id });
      this.roster();
    }
  }
}
