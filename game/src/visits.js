// Coarse, anonymous telemetry. Storage/network failures must never affect play.
let tracker;
export function recordPlayEvent(kind, detail) { tracker?.event(kind, detail); }
export function countVisit(scope = window) {
  try {
    const { location, navigator, localStorage, crypto } = scope;
    if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname) ||
        new URLSearchParams(location.search).has('nostats')) return;
    const random = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    let v;
    try { v = localStorage.getItem('yr-visitor-1'); } catch {}
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(v || '')) {
      v = random();
      try { localStorage.setItem('yr-visitor-1', v); } catch {}
    }
    const s = random(), now = () => scope.Date?.now() ?? Date.now();
    let active = 0, since = scope.document?.hidden ? null : now(), seq = 0, ended = since === null;
    const vehicles = new Set(), races = { started: 0, finished: 0, medals: { gold: 0, silver: 0, bronze: 0 } };
    let builder = false, mp = null, bound = false;
    const cleanup = [];
    const ua = navigator.userAgent || '';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
    const sample = () => {
      const g = scope.game, vehicle = g?.vehicles?.current;
      if (g && !bound) {
        bound = true;
        g.vehicles?.onSwitch?.(() => sample());
        g.vehicles?.onTypeChange?.(() => sample());
        const net = g.multiplayer?.mp;
        for (const kind of ['roster', 'stats-game']) {
          const off = net?.on?.(kind, () => {
            const before = JSON.stringify(mp); sample();
            if (JSON.stringify(mp) !== before && !scope.document?.hidden) send('heartbeat');
          });
          if (off) cleanup.push(off);
        }
      }
      if (vehicle) vehicles.add(`${vehicle.kind === 'jet' ? 'aircraft' : vehicle.kind}:${vehicle.type || 'default'}`);
      builder ||= !!g?.builder?.open;
      const net = g?.multiplayer?.mp;
      if (net?.inGame) mp = { id: net.statsGameId || '', code: net.roomCode, nickname: net.me?.name || '', maxPlayers: Math.max(mp?.id === net.statsGameId ? mp.maxPlayers : 0, net.players?.size || 1) };
      return g?.graphics?.mode || 'unknown';
    };
    function send(event) {
      try {
        const graphics = sample();
        const body = JSON.stringify({ v, s, event, seq: ++seq, activeMs: active + (since === null ? 0 : Math.max(0, now() - since)),
          offset: new Date().getTimezoneOffset(), screen: (scope.screen?.width || 0) < 768 ? 'small' : (scope.screen?.width || 0) < 1440 ? 'medium' : 'large',
          browser, vehicles: [...vehicles], races, builder, graphics, mp });
        const url = 'https://yamhill-racer-relay.yamhill-racer.workers.dev/hit';
        try { if (navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))) return; } catch {}
        scope.fetch(url, { method: 'POST', body, keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
      } catch {}
    }
    function end() {
      if (ended) return;
      if (since !== null) active += Math.max(0, now() - since);
      since = null; ended = true; send('end');
    }
    function visibility() {
      if (scope.document?.hidden) end();
      else if (ended) { ended = false; since = now(); send('heartbeat'); }
    }
    send('start');
    if (ended) send('end');
    const timer = scope.setInterval?.(() => { if (!scope.document?.hidden) send('heartbeat'); }, 60000);
    // Cheap sampling catches vehicle/builder changes between heartbeats, without network traffic.
    const sampler = scope.setInterval?.(() => { if (!scope.document?.hidden) sample(); }, 1000);
    scope.document?.addEventListener('visibilitychange', visibility);
    scope.addEventListener?.('pagehide', end);
    scope.addEventListener?.('pageshow', visibility);
    return { event(kind, detail) {
      if (kind === 'builder') builder = true;
      if (kind === 'race-start') races.started++;
      if (kind === 'race-finish') { races.finished++; if (Object.hasOwn(races.medals, detail)) races.medals[detail]++; }
      if (!scope.document?.hidden) send('heartbeat');
    }, stop() {
      end(); cleanup.forEach(off => off()); scope.clearInterval?.(timer); scope.clearInterval?.(sampler);
      scope.document?.removeEventListener('visibilitychange', visibility);
      scope.removeEventListener?.('pagehide', end); scope.removeEventListener?.('pageshow', visibility);
    } };
  } catch { /* Privacy settings must never prevent startup. */ }
}
if (typeof window !== 'undefined') tracker = countVisit();
