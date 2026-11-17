// Shared discovery and admission budget. Only the worker exposes GET /lobby publicly.
export const LOBBY_TTL = 30000;
export class LobbyState {
  constructor({ now = Date.now, entries = [], requests = [] } = {}) {
    this.now = now; this.entries = new Map(entries); this.requests = new Map(requests);
  }
  prune() {
    const now = this.now();
    for (const [id, entry] of this.entries) if (entry.seen + LOBBY_TTL <= now) this.entries.delete(id);
    for (const [id, r] of this.requests) if (r.times.every(t => t + 60000 <= now) && r.until <= now) this.requests.delete(id);
  }
  list() { this.prune(); return [...this.entries.values()].map(({ seen, ...entry }) => entry).sort((a, b) => a.created - b.created); }
  update(entry) { this.prune(); if (entry.players) this.entries.set(entry.id, { ...entry, seen: this.now() }); else this.entries.delete(entry.id); }
  claim(id, key) {
    this.prune(); const now = this.now(), r = this.requests.get(id) || { times: [], until: 0 };
    r.times = r.times.filter(t => t + 60000 > now);
    if (r.until > now) return 'request-pending';
    if (r.times.length >= 5) return 'rate-limit';
    r.times.push(now); r.until = now + LOBBY_TTL; r.key = key; this.requests.set(id, r); return null;
  }
  release(id, key) { const r = this.requests.get(id); if (r?.key === key) r.until = 0; }
}
export const lobbyObject = env => env.LOBBY.get(env.LOBBY.idFromName('public'));
export class Lobby {
  constructor(ctx) {
    this.ctx = ctx;
    ctx.blockConcurrencyWhile(async () => { this.state = new LobbyState(await ctx.storage.get('lobby')); });
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/lobby') return Response.json({ games: this.state.list() }, { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
    if (request.method !== 'POST') return new Response(null, { status: 404 });
    const body = await request.json(); let reason = null;
    if (path === '/update') this.state.update(body);
    else if (path === '/claim') reason = this.state.claim(body.id, body.key);
    else if (path === '/release') this.state.release(body.id, body.key);
    else return new Response(null, { status: 404 });
    await this.ctx.storage.put('lobby', { entries: [...this.state.entries], requests: [...this.state.requests] });
    return Response.json({ reason });
  }
}
