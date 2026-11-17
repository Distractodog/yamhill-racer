// Daily aggregates and capped, hashed visitor records; never store addresses or raw IDs.
export const ORIGIN = 'https://distractodog.github.io';
export const DAY = 86400000;
export const VISITOR_CAP = 10000;
const date = ms => new Date(ms).toISOString().slice(0, 10);
const empty = () => ({ visits: 0, unique: 0, games: 0, countries: {} });
export const statsObject = env => env.STATS.get(env.STATS.idFromName('Stats'));
export const authorized = (request, key) => typeof key === 'string' && key.length > 0 &&
  new URL(request.url).searchParams.get('key') === key;

export class Stats {
  constructor(ctx) { this.ctx = ctx; }
  fetch(request) {
    // Serialize the read/modify/write across storage awaits and concurrent requests.
    return this.ctx.blockConcurrencyWhile(() => this.handle(request));
  }
  async handle(request) {
    const now = Date.now();
    const today = date(now);
    const storage = this.ctx.storage;
    if (!await storage.getAlarm()) await storage.setAlarm((Math.floor(now / DAY) + 1) * DAY);
    const path = new URL(request.url).pathname;
    if (path === '/stats') {
      const rows = [];
      for (let i = 0; i < 30; i++) {
        const day = date(now - i * DAY);
        rows.push({ day, ...((await storage.get(`day:${day}`)) || empty()) });
      }
      return new Response(renderStats(rows), { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      } });
    }
    const key = `day:${today}`;
    const row = await storage.get(key) || empty();
    if (path === '/game') row.games++;
    else if (path === '/hit') {
      const { hash, country } = await request.json();
      const visitorKey = `visitor:${today}:${hash}`;
      const hits = await storage.get(visitorKey) || 0;
      if (hits >= 30 || (!hits && row.unique >= VISITOR_CAP)) return new Response(null, { status: 204 });
      if (!hits) row.unique++;
      row.visits++;
      row.countries[country] = (row.countries[country] || 0) + 1;
      await storage.put({ [visitorKey]: hits + 1, [key]: row });
      return new Response(null, { status: 204 });
    } else return new Response(null, { status: 404 });
    await storage.put(key, row);
    return new Response(null, { status: 204 });
  }
  async alarm() {
    const cutoff = date(Date.now() - 34 * DAY); // Today plus the preceding 34 UTC days.
    for (const prefix of ['day:', 'visitor:']) {
      for (;;) {
        const expired = await this.ctx.storage.list({ prefix, end: `${prefix}${cutoff}`, limit: 128 });
        if (!expired.size) break;
        await this.ctx.storage.delete([...expired.keys()]);
      }
    }
    await this.ctx.storage.setAlarm((Math.floor(Date.now() / DAY) + 1) * DAY);
  }
}

export async function hit(request, env) {
  const headers = { 'Access-Control-Allow-Origin': ORIGIN, Vary: 'Origin' };
  if (request.headers.get('Origin') !== ORIGIN) return new Response(null, { status: 403 });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    ...headers, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type',
  } });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers });
  // Stream with a hard size bound, including requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400, headers });
  let text = '', bytes = 0;
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 1024) { await reader.cancel(); return new Response(null, { status: 413, headers }); }
    text += decoder.decode(value, { stream: true });
  }
  let body;
  try { body = JSON.parse(text + decoder.decode()); } catch { return new Response(null, { status: 400, headers }); }
  if (!body || typeof body.v !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(body.v) ||
      typeof body.p !== 'string' || !body.p.startsWith('/') || body.p.length > 512) {
    return new Response(null, { status: 400, headers });
  }
  // Daily salt prevents linking visitor hashes across dates; path is not retained.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${date(Date.now())}:${body.v}`));
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  const country = /^[A-Z]{2}$/.test(request.cf?.country || '') ? request.cf.country : 'XX';
  await statsObject(env).fetch(new Request('https://stats/hit', {
    method: 'POST', body: JSON.stringify({ hash, country }),
  }));
  return new Response(null, { status: 204, headers });
}

export function renderStats(rows) {
  const totals = empty();
  for (const row of rows) {
    for (const k of ['visits', 'unique', 'games']) totals[k] += row[k];
    for (const [country, count] of Object.entries(row.countries)) totals.countries[country] = (totals.countries[country] || 0) + count;
  }
  const cells = row => `<td>${row.visits}</td><td>${row.unique}</td><td>${row.games}</td>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Yamhill Racer visits</title><style>body{font:16px system-ui;max-width:850px;margin:2rem auto;padding:0 1rem;color:#172331;background:#f6f8fa}table{border-collapse:collapse;width:100%;background:white}th,td{padding:.5rem;text-align:right;border-bottom:1px solid #ddd}th:first-child,td:first-child{text-align:left}tfoot{font-weight:bold}</style>
<h1>Yamhill Racer visits</h1><p>Last 30 UTC days. Unique visitors are counted per day; the total is visitor-days.</p>
<table><thead><tr><th>Date (UTC)</th><th>Visits</th><th>Unique visitors</th><th>MP games</th></tr></thead><tbody>
${rows.map(row => `<tr><td>${row.day}</td>${cells(row)}</tr>`).join('')}
</tbody><tfoot><tr><td>30-day totals</td>${cells(totals)}</tr></tfoot></table><p>counted when at least two players are in the same game</p>
<h2>Top countries (visits)</h2><table><tr><th>Country</th><th>Visits</th></tr>
${Object.entries(totals.countries).sort((a, b) => b[1] - a[1]).map(([country, count]) => `<tr><td>${country}</td><td>${count}</td></tr>`).join('')}</table></html>`;
}
