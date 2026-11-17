import { LobbyState } from './lobby.mjs';
import { validChunk, acceptChunk } from '../game/src/builder/wire.js';
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
  constructor(code, { now = Date.now, admission = new LobbyState({ now }) } = {}) {
    this.code = code;
    this.now = now; this.admission = admission;
    this.clients = new Map();
    this.world = null;
    this.layout = null; this.layoutPending = null;
  }
  get info() { return { id: this.code, players: this.players.length, max: MAX_PLAYERS,
    name: this.host?.player.name, created: this.host?.created, anyone: !!this.host?.anyone }; }
  get host() { return [...this.clients.values()].find(s => s.player?.host); }
  get players() { return [...this.clients.values()].filter(s => s.player).map(s => s.player); }
  connect(id, client) {
    if (!ID.test(id)) return this.reject(client, 'invalid-id');
    if ([...this.clients.values()].some(s => s.id === id)) return this.reject(client, 'duplicate-id');
    if (this.players.length >= MAX_PLAYERS || this.clients.size >= 64) return this.reject(client, 'full');
    this.clients.set(client, { id, player: null, lastState: null, key: crypto.randomUUID() });
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
  broadcast(msg, except, hostOnly = false) {
    for (const [client, session] of this.clients) {
      if (session.player && client !== except && (!hostOnly || session.player.host)) this.send(client, msg);
    }
  }
  roster() { this.broadcast({ t: 'roster', players: this.players }); }
  receive(client, text) {
    const session = this.clients.get(client);
    if (!session || session.claiming) return;
    let msg;
    try {
      if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES) return;
      msg = JSON.parse(text);
    } catch { return; }
    if (!object(msg) || typeof msg.t !== 'string') return;
    if (!session.player) {
      if (session.pending) return; // One outstanding request, no game traffic before admission.
      if (!['hello', 'join-request'].includes(msg.t)) return this.removeRejected(client, 'hello-required');
      if (typeof msg.name !== 'string' || msg.name.length > 128 || !CODE.test(msg.code || '') ||
          typeof msg.host !== 'boolean' || !skinOK(msg.skin)) return this.removeRejected(client, 'invalid-hello');
      if (msg.host && (msg.t !== 'hello' || this.host || msg.code !== this.code)) return this.removeRejected(client, 'host-conflict');
      if (!msg.host && !this.host) return this.removeRejected(client, 'no-host');
      if (!msg.host && msg.t !== 'join-request') return this.removeRejected(client, 'approval-required');
      if (!msg.host) {
        const reason = this.admission.claim(session.id, session.key);
        if (reason) return this.removeRejected(client, reason);
      }
      session.pending = { name: msg.name, skin: msg.skin };
      if (msg.host) { session.created = this.now(); session.anyone = false; this.admit(client, true); }
      else if (this.host.anyone) this.admit(client);
      else {
        session.expires = this.now() + 30000;
        this.send(client, { t: 'join-pending', name: this.host.player.name });
        this.broadcast({ t: 'join-request', id: session.id, name: msg.name, expires: session.expires }, client, true);
      }
      return;
    }
    const srvT = this.now();
    const forwarded = { ...msg, from: session.id, srvT };
    if (['join-accept', 'join-decline'].includes(msg.t) && session.player.host) {
      this.expire();
      const target = [...this.clients].find(([, s]) => s.id === msg.id && s.pending);
      if (target) { if (msg.t === 'join-accept') this.admit(target[0]); else this.decline(target[0]); }
    } else if (msg.t === 'join-policy' && session.player.host && typeof msg.anyone === 'boolean') {
      session.anyone = msg.anyone;
      this.send(client, { t: 'join-policy', anyone: session.anyone });
    } else if (msg.t === 'heartbeat' && session.player.host) {
      session.heartbeat = srvT;
    } else if (msg.t === 'ping') {
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
    } else if (msg.t === 'layout' && session.player.host && validChunk(msg)) {
      const { pending, complete } = acceptChunk(this.layoutPending, { t: 'layout', revision: msg.revision, index: msg.index, total: msg.total, data: msg.data, from: session.id, srvT });
      this.layoutPending = pending;
      if (complete) { this.layout = complete; for (const chunk of complete) this.broadcast(chunk, client); }
    } else if (msg.t === 'kick' && session.player.host) {
      const target = [...this.clients].find(([, s]) => s.id === msg.id && s.player && !s.player.host);
      if (!target) return;
      this.send(target[0], { t: 'kicked' });
      this.leave(target[0]);
      this.close(target[0], 'kicked');
    } else if (msg.t === 'tree-break') {
      if (typeof msg.id !== 'string' || !/^-?\d{1,3}_-?\d{1,3}:\d{1,6}$/.test(msg.id)) return;
      this.broadcast({ t: 'tree-break', id: msg.id, from: session.id, srvT });
    } else if (msg.t === 'tree-sync' && session.player.host) {
      if (!Array.isArray(msg.trees) || msg.trees.length > 128 || !msg.trees.every(tree => object(tree) &&
        typeof tree.id === 'string' && /^-?\d{1,3}_-?\d{1,3}:\d{1,6}$/.test(tree.id) &&
        Number.isFinite(tree.remainingMs) && tree.remainingMs > 0 && tree.remainingMs <= 300000)) return;
      const target = [...this.clients].find(([, s]) => s.id === msg.to && s.player && !s.player.host);
      if (target) this.send(target[0], { t: 'tree-sync', to: msg.to, from: session.id, srvT,
        trees: msg.trees.map(({ id, remainingMs }) => ({ id, remainingMs })) });
    } else if (RACES.has(msg.t)) {
      this.broadcast(forwarded);
    }
  }
  admit(client, host = false) {
    const s = this.session(client); if (!s?.pending) return;
    if (this.players.length >= MAX_PLAYERS) return this.removeRejected(client, 'full');
    s.player = { id: s.id, ...s.pending, host };
    this.finishRequest(s);
    this.broadcast({ t: 'joined', player: s.player }, client);
    this.roster();
    if (this.world) this.send(client, this.world);
    if (this.layout) for (const chunk of this.layout) this.send(client, chunk);
  }
  finishRequest(s) {
    if (!s?.pending) return;
    this.admission.release(s.id, s.key);
    if (s.expires) this.broadcast({ t: 'join-resolved', id: s.id }, null, true);
    delete s.pending; delete s.expires;
  }
  decline(client) {
    this.send(client, { t: 'join-declined', name: this.host?.player.name || 'The host' });
    this.removeRejected(client, 'declined');
  }
  expire() {
    for (const [client, s] of this.clients) if (s.expires && s.expires <= this.now()) this.decline(client);
  }
  removeRejected(client, reason) {
    this.finishRequest(this.session(client));
    this.clients.delete(client);
    return this.reject(client, reason);
  }
  leave(client) {
    const session = this.clients.get(client);
    if (!session) return;
    this.finishRequest(session);
    this.clients.delete(client);
    if (session.player?.host) {
      this.world = null;
      this.layout = null; this.layoutPending = null;
      const remaining = [...this.clients.keys()];
      for (const s of this.clients.values()) this.finishRequest(s);
      this.clients.clear(); // Remove before close callbacks can reenter.
      for (const peer of remaining) this.reject(peer, 'host-left');
    } else if (session.player) {
      this.broadcast({ t: 'left', id: session.id });
      this.roster();
    }
  }
}
