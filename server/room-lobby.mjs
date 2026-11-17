import { lobbyObject } from './lobby.mjs';
// Keep discovery/admission I/O separate from the relay's world/layout and analytics storage.
export class RoomLobby {
  constructor(owner) { this.owner = owner; }
  async call(path, body) {
    if (!this.owner.env?.LOBBY) return {};
    const response = await lobbyObject(this.owner.env).fetch(new Request(`https://lobby/${path}`, {
      method: 'POST', body: JSON.stringify(body),
    }));
    if (!response.ok) throw new Error('lobby-unavailable');
    return response.json();
  }
  async prepare(ws, text) {
    const { room } = this.owner, s = room.session(ws);
    let msg; try { msg = JSON.parse(text); } catch { return; }
    if (msg?.t !== 'join-request' || !s || s.player || s.pending || !room.host) return;
    if (s.claiming) return false;
    s.claiming = true;
    try {
      const { reason } = await this.call('claim', { id: s.id, key: s.key });
      if (reason) { room.removeRejected(ws, reason); return; }
      if (room.session(ws) !== s) { await this.call('release', { id: s.id, key: s.key }); return false; }
      s.claimed = true;
    } catch { room.removeRejected(ws, 'lobby-unavailable'); }
    finally { delete s.claiming; }
  }
  async sync(before, heartbeat = false) {
    const { room, ctx } = this.owner;
    // A decision mutates the guest attachment too, not only the host who sent it.
    for (const [ws, s] of before) {
      const current = room.session(ws);
      if (s.claimed && !current?.pending) {
        await this.call('release', { id: s.id, key: s.key }).catch(() => {});
        if (current) delete current.claimed;
      }
      this.owner.saveSession(ws);
    }
    const oldHost = before.find(([, s]) => s.player?.host)?.[1];
    const oldCount = before.filter(([, s]) => s.player).length;
    if (heartbeat || oldCount !== room.players.length || (!!oldHost !== !!room.host)) {
      // Failed discovery must not interrupt room traffic; the next heartbeat retries.
      await this.call('update', room.info).catch(() => {});
    }
    const deadlines = [...room.clients.values()].map(s => s.expires).filter(Boolean);
    if (deadlines.length) await ctx.storage.setAlarm?.(Math.min(...deadlines));
    else await ctx.storage.deleteAlarm?.();
  }
  snapshot() { return [...this.owner.room.clients].map(([ws, s]) => [ws, structuredClone(s)]); }
  async alarm() { const before = this.snapshot(); this.owner.room.expire(); await this.sync(before); }
}
