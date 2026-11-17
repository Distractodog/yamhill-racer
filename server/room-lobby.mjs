import { lobbyObject } from './lobby.mjs';
// Keep discovery/admission I/O separate from the relay's world/layout and analytics storage.
export class RoomLobby {
  constructor(owner) { this.owner = owner; this.publication = Promise.resolve(); }
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
  async sync(before) {
    const { room, ctx } = this.owner;
    // Arm liveness before discovery/admission I/O can delay or fail.
    if (Number.isFinite(room.deadline)) await ctx.storage.setAlarm?.(room.deadline);
    else await ctx.storage.deleteAlarm?.();
    // A decision mutates the guest attachment too, not only the host who sent it.
    for (const [ws, s] of before) {
      const current = room.session(ws);
      if (s.claimed && !current?.pending) {
        await this.call('release', { id: s.id, key: s.key }).catch(() => {});
        if (current) delete current.claimed;
      }
      this.owner.saveSession(ws);
    }
    // Serialize discovery writes; choose the current generation only when the write starts.
    // An older close/sync waiting on admission I/O must never publish an old host afterwards.
    this.publication = this.publication.catch(() => {}).then(async () => {
      await this.call('update', room.info);
    });
    // Failed discovery does not interrupt traffic; the next host heartbeat retries.
    await this.publication.catch(() => {});
  }
  snapshot() { return [...this.owner.room.clients].map(([ws, s]) => [ws, structuredClone(s)]); }
}
