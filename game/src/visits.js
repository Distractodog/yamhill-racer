// Independent of game startup and multiplayer identity. Analytics failures are silent.
export function countVisit(scope = window) {
  try {
    const { location, navigator, localStorage, crypto } = scope;
    if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ||
        new URLSearchParams(location.search).has('nostats')) return;
    let v = localStorage.getItem('yr-visitor-1');
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(v || '')) {
      v = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('yr-visitor-1', v);
    }
    const url = 'https://yamhill-racer-relay.yamhill-racer.workers.dev/hit';
    const body = JSON.stringify({ v, p: location.pathname });
    // text/plain is CORS-safelisted: no preflight on the page-load beacon.
    try { if (navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))) return; } catch { /* Try fetch. */ }
    scope.fetch(url, { method: 'POST', body, keepalive: true, credentials: 'omit',
      headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
  } catch { /* Storage, network and privacy settings must never affect the game. */ }
}
if (typeof window !== 'undefined') countVisit();
