// Exact opt-outs for this runner; all other failures remain evidence.
export function exclusion(raw, origin) {
  const url = new URL(raw);
  if (url.href === 'https://static.cloudflareinsights.com/beacon.min.js') return 'Cloudflare script';
  if (url.origin === 'https://cloudflareinsights.com' && url.pathname === '/cdn-cgi/rum' && !url.search) return 'Cloudflare endpoint';
  if (url.href === `${origin}/favicon.ico`) return 'origin favicon';
  return null;
}

export async function watchNetwork(page, name, origin, relay, errors, logs) {
  page.on('pageerror', e => errors.push(`${name}: pageerror ${page.url()} ${e.stack || e.message}`));
  page.on('console', msg => {
    if (!['error', 'warn'].includes(msg.type())) return;
    const at = msg.location();
    const line = `${name}: console ${msg.type()} ${at.url || page.url()}:${at.lineNumber ?? '?'}:${at.columnNumber ?? '?'} ${msg.text()}`;
    logs.push(line + '\n');
    if (msg.type() === 'error') errors.push(line);
  });
  page.on('requestfailed', req => errors.push(`${name}: ${req.failure()?.errorText} ${req.url()}`));
  page.on('response', res => { if (res.status() >= 400) errors.push(`${name}: HTTP ${res.status()} ${res.url()}`); });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = new URL(req.url()), reason = exclusion(req.url(), origin);
    let action;
    if (reason) {
      logs.push(`${name}: EXCLUDED ${reason} ${req.method()} ${req.url()}\n`);
      action = req.respond({ status: 200, contentType: reason === 'Cloudflare script' ? 'text/javascript' : 'text/plain', body: '' });
    } else if (url.origin === origin || url.origin === relay.replace(/^ws/, 'http') ||
        (req.method() === 'GET' && url.origin === 'https://cdn.jsdelivr.net' &&
          (url.pathname.startsWith('/npm/three@0.170.0/') || url.pathname === '/npm/lil-gui@0.19.2/dist/lil-gui.esm.min.js')) ||
        ['data:', 'blob:'].includes(url.protocol)) action = req.continue();
    else {
      errors.push(`${name}: Blocked nonlocal request: ${req.method()} ${req.url()}`);
      action = req.abort();
    }
    Promise.resolve(action).catch(e => errors.push(`${name}: interception ${req.url()} ${e.message}`));
  });
}
