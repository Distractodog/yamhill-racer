// Relay telemetry is separate from routing/lobby policy. Chat retains its sender's session ID.
import { statsObject } from './stats.mjs';
export class RelayStats {
  constructor(ctx, env, room) { this.ctx = ctx; this.env = env; this.room = room; this.game = null; this.signature = ''; this.last = 0; }
  async restore() { this.game = this.room.host ? await this.ctx.storage.get('stats-game') || null : null; }
  chat(line) {
    if (!this.env?.STATS || !this.game) return;
    const record = { time: line.srvT, game: this.game.id, code: this.room.code,
      host: this.game.host, name: line.name, session: line.from, text: line.text };
    // Schedule storage independently of routing. Socket attachments retain the token bucket.
    this.ctx.waitUntil(Promise.resolve().then(() => statsObject(this.env).fetch(new Request('https://stats/chat', {
      method: 'POST', body: JSON.stringify({ lines: [record] }),
    }))).then(response => { if (!response.ok) throw Error('Chat storage failed'); }));
  }
  async update() {
    if (!this.env?.STATS) return;
    const players = this.room.players, host = players.find(p => p.host);
    if (!this.game && host) {
      this.game = { id: crypto.randomUUID(), code: this.room.code, host: host.name };
      await this.ctx.storage.put('stats-game', this.game);
    }
    if (!this.game) return;
    const signature = JSON.stringify(players.map(p => [p.name, p.host]));
    if (signature !== this.signature) this.room.broadcast({ t: 'stats-game', id: this.game.id });
    if (signature === this.signature && Date.now() - this.last < 60000) return;
    this.signature = signature; this.last = Date.now();
    const body = { ...this.game, count: players.length, names: players.map(p => p.name) };
    try { this.ctx.waitUntil(statsObject(this.env).fetch(new Request('https://stats/game', { method: 'POST', body: JSON.stringify(body) })).catch(() => {})); } catch {}
    if (!host) { this.game = null; await this.ctx.storage.delete('stats-game'); }
  }
}
