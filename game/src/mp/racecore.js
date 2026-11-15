// Multiplayer race logic (no DOM, no three.js): invites, replies, synced start, live places, results.
// races.js wires it to the real `mp` (net.js), the challenges manager and the pop-up DOM; tests pass fakes.
// Messages (the relay broadcasts them to everyone INCLUDING the sender, with `from`): invite, invite-reply,
// race-start, race-progress, race-finish, race-cancel — own echoes are ignored.
export const INVITE_TTL = 30000, START_DELAY = 5000, DNF_AFTER = 60000, PROGRESS_MS = 500;

export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function ordinal(n) {
  const r = n % 100, s = r >= 11 && r <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return n + s;
}

// Route geometry for progress: the race's centre line (challenges.json `track` [x,z,halfWidth] or, for jets, `route`
// [x,z]) with cumulative arc length, and each gate's arc position (projected forward from the previous gate).
export function makeRoute(ch) {
  let pts = (ch.track || ch.route || []).map(p => [p[0], p[1]]);
  if (pts.length < 2) pts = ch.gates.map(g => [g.x, g.z]);
  const S = [0];
  for (let i = 1; i < pts.length; i++) S.push(S[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const route = { pts, S, total: S[S.length - 1], gateS: [0] };
  for (let i = 1; i < ch.gates.length; i++) route.gateS.push(project(route, ch.gates[i].x, ch.gates[i].z, route.gateS[i - 1] - 20, Infinity).s);
  return route;
}
// nearest point on the centre line with arc position inside [lo, hi]: { s, d }
function project(route, x, z, lo, hi) {
  const { pts, S } = route;
  let best = { s: Math.min(Math.max(lo, 0), route.total), d: Infinity };
  for (let i = 0; i < pts.length - 1; i++) {
    if (S[i + 1] < lo || S[i] > hi) continue;
    const ex = pts[i + 1][0] - pts[i][0], ez = pts[i + 1][1] - pts[i][1], L2 = ex * ex + ez * ez || 1e-9;
    const t = Math.min(1, Math.max(0, ((x - pts[i][0]) * ex + (z - pts[i][1]) * ez) / L2));
    const d = Math.hypot(x - pts[i][0] - ex * t, z - pts[i][1] - ez * t);
    if (d < best.d) best = { s: S[i] + (S[i + 1] - S[i]) * t, d };
  }
  return best;
}
// distance along the route (metres), bounded to the stretch between the last checkpoint passed and the next one
export function routeProgress(route, next, x, z) {
  const n = route.gateS.length;
  if (next >= n) return route.gateS[n - 1];
  const lo = route.gateS[Math.max(0, next - 1)], hi = route.gateS[next];
  return Math.min(hi, Math.max(lo, project(route, x, z, lo - 5, hi + 5).s));
}

export function createRaceCore({ mp, challenges, ui = {}, timers = globalThis, pos = () => ({ x: 0, z: 0 }) }) {
  const list = challenges.list;
  let outgoing = null;      // I'm inviting: { inviteId, raceId, replies: Map id -> 'wait'|'accept'|'decline', timer }
  let incoming = null;      // someone invited me: { inviteId, from, raceId, timer }
  let accepted = null;      // inviteId I accepted and am waiting to start
  let active = null;        // the race I'm in (or just finished)
  let tick = null, acceptedTimer = null;
  const routes = new Map();
  const routeOf = info => routes.get(info.id) || (routes.set(info.id, makeRoute(info)), routes.get(info.id));
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
    // one pending invite at a time: not while one is open for me, accepted-but-unstarted, or I'm already racing
    if (!ids.length || outgoing || incoming || accepted || busy()) return false;
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
    begin({ inviteId, raceId, players, startAt });      // the relay's echo of race-start is ignored (from === me)
  }

  // ---------------------------------------------------------------- invitee
  function showIncoming() { ui.incoming?.(incoming && { fromName: nameOf(incoming.from), raceName: raceName(incoming.raceId), ttl: INVITE_TTL }); }
  function clearIncoming() { if (incoming) timers.clearTimeout(incoming.timer); incoming = null; showIncoming(); }
  function setAccepted(id) {                            // accepted but not started: forget it if the start never comes
    timers.clearTimeout(acceptedTimer); acceptedTimer = null; accepted = id;
    if (id) acceptedTimer = timers.setTimeout(() => { accepted = null; acceptedTimer = null; }, INVITE_TTL + START_DELAY + 15000);
  }
  function reply(accept) {
    if (!incoming) return;
    const { inviteId } = incoming;
    mp.send({ t: 'invite-reply', inviteId, accept });
    setAccepted(accept ? inviteId : null);
    clearIncoming();
  }
  function onInvite(m) {
    if (m.from === mp.me.id || !m.to?.includes(mp.me.id)) return;
    if (incoming || accepted || busy() || outgoing || !list.some(c => c.id === m.raceId)) { mp.send({ t: 'invite-reply', inviteId: m.inviteId, accept: false }); return; }
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
    setAccepted(null);
    begin(m);
  }

  // ---------------------------------------------------------------- the race itself
  function begin({ inviteId, raceId, players, startAt }) {
    const i = list.findIndex(c => c.id === raceId);
    if (i < 0 || active?.inviteId === inviteId) return;
    if (incoming) clearIncoming();
    active = { inviteId, raceId, players, startAt, progress: new Map(), finished: new Map(), out: new Set(), firstFinishAt: null, myDone: false };
    if (!tick) tick = timers.setInterval(onTick, PROGRESS_MS);
    challenges.start(i, { mp: true, sync: { at: startAt, now: () => mp.now() } });
  }
  function sendProgress() {
    const info = challenges.runInfo?.();
    if (!info || info.state !== 'running' || !active || active.myDone) return;
    const p = pos(), cur = { checkpoint: info.next - 1, dist: routeProgress(routeOf(info), info.next, p.x, p.z) };
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
    if (!active || m.inviteId !== active.inviteId || !active.players.includes(m.from) || m.from === mp.me.id || active.out.has(m.from)) return;
    active.progress.set(m.from, { checkpoint: m.checkpoint, dist: m.dist });
  }
  const isLate = at => active.firstFinishAt != null && at > active.firstFinishAt + DNF_AFTER;
  function noteFinish(id, time, at) {       // false when it doesn't count: DNF (cancelled / left / past the deadline) is final
    if (active.out.has(id) || active.finished.has(id) || isLate(at)) return false;
    active.finished.set(id, time);
    if (active.firstFinishAt == null) active.firstFinishAt = at;
    return true;
  }
  function onRaceFinish(m) {
    if (!active || m.inviteId !== active.inviteId || !active.players.includes(m.from) || m.from === mp.me.id) return;
    noteFinish(m.from, m.time, m.srvT ?? mp.now()); ui.results?.(rows());
  }
  function onRaceCancel(m) {
    if (m.from === mp.me.id) return;
    if (incoming && m.inviteId === incoming.inviteId) clearIncoming();     // the inviter gave up
    if (accepted === m.inviteId) setAccepted(null);
    if (active && m.inviteId === active.inviteId && !active.finished.has(m.from)) { active.out.add(m.from); ui.results?.(rows()); }
  }
  function onLeft(m) {
    if (outgoing?.replies.has(m.id)) { outgoing.replies.set(m.id, 'decline'); settle(); }
    if (incoming?.from === m.id) clearIncoming();
    if (active && !active.finished.has(m.id)) { active.out.add(m.id); ui.results?.(rows()); }
  }
  function reset(quitRun) {                 // connection gone: drop every invite/race and stop all timers
    if (outgoing) { timers.clearTimeout(outgoing.timer); outgoing = null; showLobby(); }
    clearIncoming(); setAccepted(null);
    const racing = active && !active.myDone;
    active = null;
    if (tick) { timers.clearInterval(tick); tick = null; }
    if (racing && quitRun) challenges.quit?.();
  }

  // challenges.js hook callbacks
  function leave() {                        // I left (Esc, new run, vehicle switch): tell the others unless I'd finished
    setAccepted(null);                      // a solo run (or leaving) forgets an accepted-but-unstarted invite
    if (!active) return;
    if (!active.myDone) mp.send({ t: 'race-cancel', inviteId: active.inviteId });
    active = null;
    if (tick) { timers.clearInterval(tick); tick = null; }
  }
  function onFinish() {
    if (!active || active.myDone) return;
    active.myDone = true;
    const at = mp.now(), time = Math.max(0, (at - active.startAt) / 1000);   // everyone's time is on the relay clock
    if (noteFinish(mp.me.id, time, at)) mp.send({ t: 'race-finish', inviteId: active.inviteId, time });
    ui.results?.(rows());
  }
  function onGate() { sendProgress(); }
  // a click/Enter on a race row in the J menu: in a game with other players it opens the invite step instead
  function pick(i) {
    if (!ui.pick || !mp.inGame || ![...mp.players.keys()].some(id => id !== mp.me.id)) return false;
    ui.pick(list[i], i); return true;
  }

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
    'race-finish': onRaceFinish, 'race-cancel': onRaceCancel, left: onLeft,
    disconnected: () => reset(true), closed: () => reset(true) };
  for (const [k, fn] of Object.entries(handlers)) mp.on(k, fn);
  const hook = { onLocalStart: leave, onQuit: leave, onFinish, onGate, hudHtml, pick };
  return {
    hook, invite, cancelInvite, start: startOutgoing, accept: () => reply(true), decline: () => reply(false),
    rows, hudHtml, resultsHtml, lobbyData, reset,
    get active() { return active; }, get outgoing() { return outgoing; }, get incoming() { return incoming; }, get accepted() { return accepted; },
    dispose() { reset(false); for (const [k, fn] of Object.entries(handlers)) mp.off?.(k, fn); },
  };
}
