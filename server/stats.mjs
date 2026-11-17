// Bounded anonymous session analytics. Never retain addresses, paths or raw visitor IDs.
export const ORIGIN = 'https://distractodog.github.io';
export const DAY = 86400000;
export const VISITOR_CAP = 10000;
export const RECORD_CAP = 2000;
export const RETENTION = 60;
const date = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const empty = () => ({ visits: 0, unique: 0, games: 0, countries: {} });
export const statsObject = env => env.STATS.get(env.STATS.idFromName('Stats'));
export const authorized = (request, key) => typeof key === 'string' && key.length > 0 && new URL(request.url).searchParams.get('key') === key;
const hashOf = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const str = (v, n = 80) => typeof v === 'string' ? v.slice(0, n).replace(/[\u0000-\u001f]/g, '') : '';
const num = (v, max = 100000) => Number.isFinite(v) ? Math.max(0, Math.min(max, Math.floor(v))) : 0;
const idOK = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{16,64}$/.test(v);
const endOf = s => s.end ?? s.last;
function dayStart(day) {
  let lo = Date.parse(`${day}T00:00:00Z`), hi = lo + DAY;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (date(mid) < day) lo = mid; else hi = mid; }
  return hi;
}
function creditPlay(s, delta, now) {
  s.playByDay ||= {};
  // Split reported visible time at Pacific calendar boundaries (also on DST days).
  let from = now - delta;
  while (from < now) {
    const day = date(from);
    const next = new Date(Date.parse(`${day}T12:00:00Z`) + DAY).toISOString().slice(0, 10);
    const until = Math.min(now, dayStart(next));
    s.playByDay[day] = (s.playByDay[day] || 0) + until - from;
    from = until;
  }
}
export class Stats {
  constructor(ctx) { this.ctx = ctx; }
  fetch(request) { return this.ctx.blockConcurrencyWhile(() => this.handle(request)); }
  async records(prefix) { return [...(await this.ctx.storage.list({ prefix, limit: RECORD_CAP + 1 })).values()]; }
  async migrateMpGames(today) {
    const storage = this.ctx.storage, flag = 'migration:mp-reset-1';
    if (await storage.get(flag)) return;
    const days = await storage.list({ prefix: 'day:' });
    const games = await this.records('game:');
    const todayGames = games.filter(game => date(game.start) === today && game.maxPlayers >= 2).length;
    for (const [key, row] of days) {
      row.games = key === `day:${today}` ? todayGames : 0;
      await storage.put(key, row);
    }
    await storage.put(flag, true);
  }
  async trim(prefix, time, cap = RECORD_CAP) {
    const entries = [...await this.ctx.storage.list({ prefix })].sort((a, b) => time(a[1]) - time(b[1]));
    const expired = entries.filter(([, v], i) => time(v) < Date.now() - RETENTION * DAY || i < entries.length - cap);
    for (let i = 0; i < expired.length; i += 128) await this.ctx.storage.delete(expired.slice(i, i + 128).map(([k]) => k));
  }
  async handle(request) {
    const now = Date.now(), today = date(now), storage = this.ctx.storage;
    await this.migrateMpGames(today);
    if (!await storage.getAlarm()) await storage.setAlarm(now + DAY);
    const path = new URL(request.url).pathname;
    if (path === '/stats') {
      const rows = [];
      // Calendar days in Pacific time, including DST transition days.
      let day = today;
      for (let i = 0; i < 60; i++) {
        rows.push({ day, ...((await storage.get(`day:${day}`)) || empty()) });
        day = new Date(Date.parse(`${day}T12:00:00Z`) - DAY).toISOString().slice(0, 10);
      }
      return new Response(renderStats(rows, await this.records('session:'), await this.records('game:'), now), { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      } });
    }
    const body = await request.json().catch(() => ({}));
    if (path === '/game') {
      const key = `day:${today}`, row = await storage.get(key) || empty();
      if (!body.id) { row.games++; await storage.put(key, row); }
      else {
        const gameKey = `game:${body.id}`;
        let game = await storage.get(gameKey);
        if (!game) { await this.trim('game:', s => s.start, RECORD_CAP - 1); game = { id: str(body.id), code: str(body.code, 5), start: now, last: now, maxPlayers: 0, names: [] }; }
        const count = num(body.count, 16);
        if (game.maxPlayers < 2 && count >= 2) { row.games++; await storage.put(key, row); }
        game.maxPlayers = Math.max(game.maxPlayers, count);
        game.names = [...new Set([...game.names, ...(body.names || []).map(n => str(n))])].slice(0, 64);
        game.host = str(body.host) || game.host || '';
        game.last = now;
        if (!count) game.end = now;
        await storage.put(gameKey, game);
      }
      return new Response(null, { status: 204 });
    }
    if (path !== '/hit') return new Response(null, { status: 404 });
    const { hash, country } = body;
    const key = `day:${today}`, row = await storage.get(key) || empty();
    if (!body.event || body.event === 'start') {
      // A repeated start beacon for an existing session is idempotent.
      if (!body.sid || !await storage.get(`session:${body.sid}`)) {
        const visitorKey = `visitor:${today}:${hash}`, hits = await storage.get(visitorKey) || 0;
        if (hits >= 30 || (!hits && row.unique >= VISITOR_CAP)) return new Response(null, { status: 204 });
        if (!hits) row.unique++;
        row.visits++; row.countries[country] = (row.countries[country] || 0) + 1;
        await storage.put({ [visitorKey]: hits + 1, [key]: row });
      }
    }
    if (body.sid) {
      const sessionKey = `session:${body.sid}`;
      let s = await storage.get(sessionKey);
      if (!s && body.event !== 'start') return new Response(null, { status: 204 });
      if (!s) {
        await this.trim('session:', s => s.start, RECORD_CAP - 1);
        s = { id: body.sid, visitor: hash, country, start: now, last: now, activeMs: 0, seq: -1, vehicles: [], races: {}, mpGames: [], spans: [{ start: now, last: now }] };
      }
      if (body.seq <= s.seq) return new Response(null, { status: 204 });
      s.seq = body.seq;
      const previousActive = s.activeMs;
      s.activeMs = Math.max(s.activeMs, Math.min(body.activeMs, now - s.start, s.activeMs + Math.max(0, now - s.last)));
      creditPlay(s, s.activeMs - previousActive, now);
      const span = s.spans.at(-1);
      if (s.end != null && body.event !== 'end') {
        if (s.spans.length >= 256) s.spans.shift();
        s.spans.push({ start: now, last: now });
      } else span.last = now;
      s.last = now; s.end = body.event === 'end' ? now : null;
      s.offset = body.offset; s.screen = body.screen; s.browser = body.browser;
      s.vehicles = [...new Set([...s.vehicles, ...body.vehicles])].slice(0, 40);
      s.races = body.races; s.builder ||= body.builder; s.graphics = body.graphics;
      if (body.mp) {
        s.multiplayer = true; s.nickname = body.mp.nickname || s.nickname;
        const prev = s.mpGames.find(g => (g.id === body.mp.id && g.code === body.mp.code) || (!g.id && g.code === body.mp.code));
        if (prev) { prev.maxPlayers = Math.max(prev.maxPlayers, body.mp.maxPlayers); if (body.mp.id) prev.id = body.mp.id; }
        else if (s.mpGames.length < 32) s.mpGames.push(body.mp);
      }
      await storage.put(sessionKey, s);
    }
    return new Response(null, { status: 204 });
  }
  async alarm() {
    await this.trim('session:', s => s.start);
    await this.trim('game:', s => s.start);
    const cutoff = date(Date.now() - (RETENTION - 1) * DAY);
    for (const prefix of ['day:', 'visitor:']) {
      for (;;) {
        const expired = await this.ctx.storage.list({ prefix, end: `${prefix}${cutoff}`, limit: 128 });
        if (!expired.size) break;
        await this.ctx.storage.delete([...expired.keys()]);
      }
    }
    await this.ctx.storage.setAlarm(Date.now() + DAY);
  }
}

export async function hit(request, env) {
  const headers = { 'Access-Control-Allow-Origin': ORIGIN, Vary: 'Origin' };
  if (request.headers.get('Origin') !== ORIGIN) return new Response(null, { status: 403 });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers });
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400, headers });
  let text = '', bytes = 0;
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 8192) { await reader.cancel(); return new Response(null, { status: 413, headers }); }
    text += decoder.decode(value, { stream: true });
  }
  let b;
  try { b = JSON.parse(text + decoder.decode()); } catch { return new Response(null, { status: 400, headers }); }
  if (!b || !idOK(b.v) || (b.event ? !['start', 'heartbeat', 'end'].includes(b.event) || !idOK(b.s) : typeof b.p !== 'string' || !b.p.startsWith('/') || b.p.length > 512)) return new Response(null, { status: 400, headers });
  // Stable keyed hash supports distinct visitors over the retention window; raw IDs are discarded.
  const hash = await hashOf(`${env.STATS_KEY || 'anonymous'}:${b.v}`);
  const country = /^[A-Z]{2}$/.test(request.cf?.country || '') ? request.cf.country : 'XX';
  const medals = b.races?.medals;
  const body = { hash, country, ...(b.event ? {
    sid: await hashOf(`${hash}:${b.s}`), event: b.event, seq: num(b.seq, 1e9), activeMs: num(b.activeMs, RETENTION * DAY),
    offset: Number.isFinite(b.offset) ? Math.max(-840, Math.min(840, b.offset)) : 0,
    screen: ['small', 'medium', 'large'].includes(b.screen) ? b.screen : 'unknown',
    browser: ['Chrome', 'Edge', 'Firefox', 'Safari'].includes(b.browser) ? b.browser : 'Other',
    vehicles: Array.isArray(b.vehicles) ? b.vehicles.filter(v => typeof v === 'string' && /^(car|bike|aircraft):[a-z0-9_-]{1,32}$/.test(v)).slice(0, 40) : [],
    races: { started: num(b.races?.started), finished: num(b.races?.finished), medals: { gold: num(medals?.gold), silver: num(medals?.silver), bronze: num(medals?.bronze) } },
    builder: b.builder === true, graphics: ['auto', 'low', 'medium', 'high'].includes(b.graphics) ? b.graphics : 'unknown',
    mp: b.mp && typeof b.mp === 'object' ? { id: str(b.mp.id), code: str(b.mp.code, 5), nickname: str(b.mp.nickname), maxPlayers: num(b.mp.maxPlayers, 16) } : null,
  } : {}) };
  await statsObject(env).fetch(new Request('https://stats/hit', { method: 'POST', body: JSON.stringify(body) }));
  return new Response(null, { status: 204, headers });
}

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const time = ms => ms == null ? '—' : new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
const duration = ms => `${(Math.max(0, ms || 0) / 60000).toFixed(1)} min`;
export function peakConcurrent(sessions, from, to) {
  const events = sessions.flatMap(s => (s.spans || [{ start: s.start, last: endOf(s) }]).flatMap(span => {
    const start = Math.max(from, span.start), end = Math.min(to, span.last);
    return end > start ? [[start, 1, s.visitor], [end, -1, s.visitor]] : [];
  })).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const visitors = new Map(); let peak = 0;
  for (const [, d, id] of events) {
    const n = (visitors.get(id) || 0) + d;
    if (n) visitors.set(id, n); else visitors.delete(id);
    peak = Math.max(peak, visitors.size);
  }
  return peak;
}
export function renderStats(rows, sessions = [], games = [], now = Date.now()) {
  sessions = [...sessions].sort((a, b) => b.start - a.start);
  games = [...games].sort((a, b) => b.start - a.start);
  const table = (headers, content) => `<div class="scroll"><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${content || `<tr><td colspan="${headers.length}">No records yet</td></tr>`}</tbody></table></div>`;
  const tr = values => `<tr>${values.map(v => `<td>${v}</td>`).join('')}</tr>`;
  const periods = [[1, 'Today'], [7, '7 days'], [30, '30 days']];
  const cards = periods.map(([days, label]) => {
    const first = rows[Math.min(days - 1, rows.length - 1)]?.day || date(now);
    const selected = sessions.filter(s => date(s.start) >= first), selectedGames = games.filter(g => date(g.start) >= first && g.maxPlayers >= 2);
    const play = sessions.reduce((sum, s) => sum + Object.entries(s.playByDay || { [date(s.start)]: s.activeMs }).filter(([day]) => day >= first).reduce((n, [, ms]) => n + ms, 0), 0);
    const from = dayStart(first);
    return `<section class="card"><h2>${label}</h2><dl>${[
      ['Visitors', new Set(selected.map(s => s.visitor)).size], ['Sessions', selected.length], ['Total play time', duration(play)],
      ['Average session length', duration(selected.length ? selected.reduce((sum, s) => sum + endOf(s) - s.start, 0) / selected.length : 0)],
      ['MP games with 2+ players', selectedGames.length], ['Peak concurrent players', peakConcurrent(sessions, from, now)],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></section>`;
  }).join('');
  const daily = rows.slice(0, 30).map(r => ({ ...r, play: sessions.reduce((sum, s) => sum + (s.playByDay?.[r.day] ?? (date(s.start) === r.day ? s.activeMs : 0)), 0) }));
  const chartRows = [...daily].reverse(), maxVisits = Math.max(1, ...daily.map(r => r.visits)), maxPlay = Math.max(60000, ...daily.map(r => r.play));
  const chart = `<svg viewBox="0 0 960 220" role="img" aria-label="Daily visits (blue) and play minutes (green), each scaled to its own maximum"><title>Daily visits and play time</title>${chartRows.map((r, i) => {
    const x = 12 + i * 31, vh = r.visits / maxVisits * 155, ph = r.play / maxPlay * 155;
    return `<g><title>${r.day}: ${r.visits} visits, ${duration(r.play)}</title><rect x="${x}" y="${175 - vh}" width="12" height="${vh}" fill="#3c70c8"/><rect x="${x + 13}" y="${175 - ph}" width="12" height="${ph}" fill="#168578"/>${i % 5 === 0 ? `<text x="${x}" y="200" font-size="12">${r.day.slice(5)}</text>` : ''}</g>`;
  }).join('')}</svg>`;
  const totals = daily.reduce((a, r) => ({ visits: a.visits + r.visits, unique: a.unique + r.unique, games: a.games + r.games, play: a.play + r.play }), { visits: 0, unique: 0, games: 0, play: 0 });
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Yamhill Racer private statistics</title>
<style>body{font:15px system-ui;margin:32px auto;padding:0 24px;max-width:1500px;color:#172331;background:#f4f7fa}h1{margin-bottom:8px}h2{font-size:21px;margin-top:32px}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.card{background:white;border:1px solid #dae2ec;border-radius:12px;padding:20px}.card h2{margin:0 0 16px}dl{display:grid;grid-template-columns:1fr auto;gap:10px;margin:0}dd{margin:0;font-weight:650}.scroll{overflow:auto;background:white;border:1px solid #dae2ec;border-radius:8px}table{border-collapse:collapse;width:100%;white-space:nowrap}td,th{text-align:left;padding:12px;border-bottom:1px solid #e0e6ee;vertical-align:top}th{background:#eaf0f6}small{color:#526479}svg{width:100%;max-height:260px;background:white;border-radius:8px}p{color:#526479;line-height:1.5}.blue{color:#3c70c8}.green{color:#168578}@media(max-width:850px){.cards{grid-template-columns:1fr}body{padding:0 12px}}</style>
<h1>Yamhill Racer private statistics</h1><p>All times Pacific (America/Los_Angeles). Anonymous estimates · last 60 days, up to ${RECORD_CAP.toLocaleString()} sessions and games.</p>
<div class="cards">${cards}</div>
<h2>Daily visits &amp; play time</h2><p><span class="blue">■ Visits (max ${maxVisits})</span> · <span class="green">■ Play time (max ${duration(maxPlay)})</span>. Bars use separate scales.</p>${chart}
<h2>Sessions</h2><p>Newest first. End is the last report when no explicit end arrived. Duration includes hidden intervals; active minutes count visible time. Visitor and session counts use the Pacific start date; play time is credited on the day played. At most 500 records shown in each detail table.</p>
${table(['Start', 'End', 'Duration / active', 'Country', 'Player', 'Vehicles', 'Races started / finished', 'Multiplayer game / peak', 'Settings'], sessions.slice(0, 500).map(s => tr([
  time(s.start), `${time(endOf(s))}${s.end == null ? ' <small>(last report)</small>' : ''}`, `${duration(endOf(s) - s.start)} / ${duration(s.activeMs)}`,
  esc(s.country), esc(s.nickname || `anonymous #${s.visitor.slice(-4)}`), s.vehicles.map(esc).join('<br>') || '—',
  `${s.races.started || 0} / ${s.races.finished || 0}<br><small>${Object.entries(s.races.medals || {}).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ')}</small>`,
  s.mpGames.map(g => `${esc(g.code || g.id)} / ${g.maxPlayers}<br><small>${esc(g.id)}</small>`).join('<br>') || '—',
  `${esc(s.graphics)} graphics${s.builder ? '<br>Builder used' : ''}<br><small>${esc(s.browser)} · ${esc(s.screen)} · TZ offset ${esc(s.offset)} min west of UTC</small>`,
])).join(''))}
<h2>Multiplayer games</h2>${table(['Start', 'End', 'Game', 'Host nickname', 'Max players', 'Player nicknames', 'Duration'], games.slice(0, 500).map(g => tr([
  time(g.start), `${time(g.end ?? g.last)}${g.end == null ? ' <small>(last report)</small>' : ''}`, `${esc(g.code)}<br><small>${esc(g.id)}</small>`, esc(g.host || 'anonymous'), g.maxPlayers, g.names.map(esc).join(', '), duration((g.end ?? g.last) - g.start),
])).join(''))}
<h2>Per day</h2><p>Visits are page loads; daily unique totals count visitor-days. MP games are counted when at least two players are in the same game. Daily counters survive detail-record caps.</p>
${table(['Date (Pacific)', 'Visits', 'Unique visitors', 'MP games', 'Play time'], daily.map(r => tr([r.day, r.visits, r.unique, r.games, duration(r.play)])).join('') + tr(['30-day totals', totals.visits, totals.unique, totals.games, duration(totals.play)]))}
<h2>Top countries (visits)</h2>${table(['Country', 'Visits'], Object.entries(daily.reduce((a, r) => { for (const [k, v] of Object.entries(r.countries)) a[k] = (a[k] || 0) + v; return a; }, {})).sort((a, b) => b[1] - a[1]).map(([k, v]) => tr([esc(k), v])).join(''))}
<p>No IP addresses, exact screen sizes, full user agents, locations, or driving coordinates are stored. Clearing browser storage creates a new visitor.</p></html>`;
}
