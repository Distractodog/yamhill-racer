// Multiplayer race logic (no DOM, no three.js): invites, replies, synced start, live places, results.
// races.js wires it to the real `mp` (net.js), the challenges manager and the pop-up DOM; tests pass fakes.
// Messages (relay forwards them to everyone, with `from`): invite, invite-reply, race-start, race-progress,
// race-finish, race-cancel — see the multiplayer contract.
export const INVITE_TTL = 30000, START_DELAY = 5000, DNF_AFTER = 60000, PROGRESS_MS = 500;

export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function ordinal(n) {
  const r = n % 100, s = r >= 11 && r <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return n + s;
}

// distance along the route (metres, straight lines between gates) given the next gate to reach
export function routeProgress(gates, next, x, z) {
  const at = [0];
  for (let i = 1; i < gates.length; i++) at.push(at[i - 1] + Math.hypot(gates[i].x - gates[i - 1].x, gates[i].z - gates[i - 1].z));
  if (next >= gates.length) return at[gates.length - 1];
  const prev = at[Math.max(0, next - 1)], seg = at[next] - prev;
  const left = Math.hypot(gates[next].x - x, gates[next].z - z);
  return prev + Math.min(seg, Math.max(0, seg - left));
}

export function createRaceCore({ mp, challenges, ui = {}, timers = globalThis, pos = () => ({ x: 0, z: 0 }) }) {
  const list = challenges.list;
  let outgoing = null;      // I'm inviting: { inviteId, raceId, replies: Map id -> 'wait'|'accept'|'decline', timer }
  let incoming = null;      // someone invited me: { inviteId, from, raceId, timer }
  let accepted = null;      // inviteId I accepted and am waiting to start
  let active = null;        // the race I'm in (or just finished)
  let tick = null;
  const raceName = id => list.find(c => c.id === id)?.name || 'a race';
  const nameOf = id => id === mp.me.id ? mp.me.name : mp.players.get(id)?.name || 'Racer';
  const busy = () => ['placing', 'countdown', 'running'].includes(challenges.state);
  let seq = 0;
  const newId = () => `${mp.me.id}-${Date.now().toString(36)}${(seq++).toString(36)}`;

  // ---------------------------------------------------------------- inviter
  function lobbyData() {
    if (!outgoing) return null;
    const rows = [...outgoing.replies].map(([id, status]) => ({ id, name: nameOf(id), status }));
    return { raceName: raceName(outgoing.raceId), rows, canStart: rows.some(r => r.status === 'accept') };
  }
  const showLobby = () => ui.lobby?.(lobbyData());
  function invite(raceId, ids) {
    ids = ids.filter(id => id !== mp.me.id && mp.players.has(id));
    if (!ids.length || outgoing || busy()) return false;
    const inviteId = newId();
    outgoing = { inviteId, raceId, replies: new Map(ids.map(id => [id, 'wait'])), timer: null };
    outgoing.timer = timers.setTimeout(() => {          // nobody waits forever: silent players count as declined
      if (!outgoing) return;
      for (const [id, s] of outgoing.replies) if (s === 'wait') outgoing.replies.set(id, 'decline');
      settle();
    }, INVITE_TTL + 1500);
    mp.send({ t: 'invite', inviteId, raceId, to: ids });
    showLobby();
    return true;
  }
  function cancelInvite() {
    if (!outgoing) return;
    timers.clearTimeout(outgoing.timer);
    mp.send({ t: 'race-cancel', inviteId: outgoing.inviteId });
    outgoing = null; showLobby();
  }
  function settle() {                                   // everyone replied: go (or give up if nobody came)
    if (!outgoing) return;
    const all = [...outgoing.replies.values()];
    if (all.includes('wait')) return showLobby();
    if (all.includes('accept')) startOutgoing(); else cancelInvite();
  }
  function startOutgoing() {
    if (!outgoing || !lobbyData().canStart) return;
    const { inviteId, raceId, replies } = outgoing;
    timers.clearTimeout(outgoing.timer); outgoing = null; showLobby();
    const players = [mp.me.id, ...[...replies].filter(([, s]) => s === 'accept').map(([id]) => id)];
    const startAt = mp.now() + START_DELAY;
    mp.send({ t: 'race-start', inviteId, raceId, players, startAt });
    begin({ inviteId, raceId, players, startAt });
  }

  // ---------------------------------------------------------------- invitee
  function showIncoming() { ui.incoming?.(incoming && { fromName: nameOf(incoming.from), raceName: raceName(incoming.raceId), ttl: INVITE_TTL }); }
  function clearIncoming() { if (incoming) timers.clearTimeout(incoming.timer); incoming = null; showIncoming(); }
  function reply(accept) {
    if (!incoming) return;
    const { inviteId } = incoming;
    mp.send({ t: 'invite-reply', inviteId, accept });
    accepted = accept ? inviteId : null;
    clearIncoming();
  }
  function onInvite(m) {
    if (m.from === mp.me.id || !m.to?.includes(mp.me.id)) return;
    if (incoming || busy() || outgoing || !list.some(c => c.id === m.raceId)) { mp.send({ t: 'invite-reply', inviteId: m.inviteId, accept: false }); return; }
    incoming = { inviteId: m.inviteId, from: m.from, raceId: m.raceId, timer: timers.setTimeout(() => reply(false), INVITE_TTL) };
    showIncoming();
  }
  function onReply(m) {
    if (!outgoing || m.inviteId !== outgoing.inviteId || !outgoing.replies.has(m.from)) return;
    outgoing.replies.set(m.from, m.accept ? 'accept' : 'decline');
    settle();
  }
  function onRaceStart(m) {
    if (m.from === mp.me.id || !m.players?.includes(mp.me.id) || accepted !== m.inviteId) return;
    accepted = null;
    begin(m);
  }

  // ---------------------------------------------------------------- the race itself
  function begin({ inviteId, raceId, players, startAt }) {
    const i = list.findIndex(c => c.id === raceId);
    if (i < 0) return;
    if (incoming) clearIncoming();
    active = { inviteId, raceId, players, startAt, progress: new Map(), finished: new Map(), out: new Set(), firstFinishAt: null, myDone: false };
    if (!tick) tick = timers.setInterval(onTick, PROGRESS_MS);
    challenges.start(i, { mp: true, sync: { at: startAt, now: () => mp.now() } });
  }
  function sendProgress() {
    const info = challenges.runInfo?.();
    if (!info || info.state !== 'running' || !active || active.myDone) return;
    const p = pos(), cur = { checkpoint: info.next - 1, dist: routeProgress(info.gates, info.next, p.x, p.z) };
    active.progress.set(mp.me.id, cur);
    mp.send({ t: 'race-progress', inviteId: active.inviteId, ...cur });
  }
  function onTick() {
    if (!active) { timers.clearInterval(tick); tick = null; return; }
    if (!active.myDone) return sendProgress();
    ui.results?.(rows());
    if (rows().every(r => r.status !== 'racing')) { timers.clearInterval(tick); tick = null; }
  }
  function onProgress(m) {
    if (!active || m.inviteId !== active.inviteId || !active.players.includes(m.from)) return;
    active.progress.set(m.from, { checkpoint: m.checkpoint, dist: m.dist });
  }
  function noteFinish(id, time) {
    active.finished.set(id, time);
    if (active.firstFinishAt == null) active.firstFinishAt = mp.now();
  }
  function onRaceFinish(m) {
    if (!active || m.inviteId !== active.inviteId || !active.players.includes(m.from) || m.from === mp.me.id) return;
    noteFinish(m.from, m.time); ui.results?.(rows());
  }
  function onRaceCancel(m) {
    if (m.from === mp.me.id) return;
    if (incoming && m.inviteId === incoming.inviteId) clearIncoming();     // the inviter gave up
    if (accepted === m.inviteId) accepted = null;
    if (active && m.inviteId === active.inviteId) { active.out.add(m.from); ui.results?.(rows()); }
  }
  function onLeft(m) {
    if (outgoing?.replies.has(m.id)) { outgoing.replies.set(m.id, 'decline'); settle(); }
    if (incoming?.from === m.id) clearIncoming();
    if (active) { active.out.add(m.id); ui.results?.(rows()); }
  }

  // challenges.js hook callbacks
  function leave() {                       // I left (Esc, new run, vehicle switch): tell the others unless I'd finished
    if (!active) return;
    if (!active.myDone) mp.send({ t: 'race-cancel', inviteId: active.inviteId });
    active = null;
    if (tick) { timers.clearInterval(tick); tick = null; }
  }
  function onFinish(time) {
    if (!active || active.myDone) return;
    active.myDone = true; noteFinish(mp.me.id, time);
    mp.send({ t: 'race-finish', inviteId: active.inviteId, time });
    ui.results?.(rows());
  }
  function onGate() { sendProgress(); }

  // ---------------------------------------------------------------- places / results
  function rows() {
    if (!active) return [];
    const late = active.firstFinishAt != null && mp.now() > active.firstFinishAt + DNF_AFTER;
    const r = active.players.map(id => {
      const time = active.finished.get(id), pr = active.progress.get(id) || { checkpoint: 0, dist: 0 };
      const status = time != null ? 'finished' : (active.out.has(id) || late) ? 'dnf' : 'racing';
      return { id, name: nameOf(id), me: id === mp.me.id, status, time: time ?? null, checkpoint: pr.checkpoint, dist: pr.dist };
    });
    const rank = x => x.status === 'finished' ? 0 : x.status === 'racing' ? 1 : 2;
    r.sort((a, b) => rank(a) - rank(b) || (a.status === 'finished' ? a.time - b.time : b.checkpoint - a.checkpoint || b.dist - a.dist));
    r.forEach((x, i) => { x.place = x.status === 'dnf' ? null : i + 1; });
    return r;
  }
  function hudHtml() {
    if (!active || active.myDone) return '';
    const r = rows().filter(x => x.status !== 'dnf');
    const show = r.slice(0, 5), me = r.find(x => x.me);
    if (me && !show.includes(me)) show.push(me);
    return `<div class="mp-places">${show.map(x => `<div class="${x.me ? 'me' : ''}">${ordinal(x.place)} ${esc(x.name)}${x.status === 'finished' ? ' ✓' : ''}</div>`).join('')}</div>`;
  }
  function resultsHtml() {
    const r = rows(); if (!r.length) return '';
    const fmt = t => `${Math.floor(t / 60)}:${(t % 60 < 10 ? '0' : '') + (t % 60).toFixed(2)}`;
    return `<div class="mp-results"><b>Race results</b>${r.map(x => `<div class="${x.me ? 'me' : ''}"><span>${x.place ? ordinal(x.place) : '–'}</span> ${esc(x.name)}<em>${
      x.status === 'finished' ? fmt(x.time) : x.status === 'dnf' ? 'DNF' : 'racing…'}</em></div>`).join('')}</div>`;
  }

  const handlers = { invite: onInvite, 'invite-reply': onReply, 'race-start': onRaceStart, 'race-progress': onProgress,
    'race-finish': onRaceFinish, 'race-cancel': onRaceCancel, left: onLeft };
  for (const [k, fn] of Object.entries(handlers)) mp.on(k, fn);
  const hook = { onLocalStart: leave, onQuit: leave, onFinish, onGate, hudHtml, menu: (el, race) => ui.menu?.(el, race) };
  return {
    hook, invite, cancelInvite, start: startOutgoing, accept: () => reply(true), decline: () => reply(false),
    rows, hudHtml, resultsHtml, lobbyData,
    get active() { return active; }, get outgoing() { return outgoing; }, get incoming() { return incoming; },
    dispose() { for (const [k, fn] of Object.entries(handlers)) mp.off?.(k, fn); if (tick) timers.clearInterval(tick); },
  };
}
