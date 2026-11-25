import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.jpg':'image/jpeg', '.png':'image/png', '.ogg':'audio/ogg' };
export function combatGameHandler(root, read = readFile) {
  return async (req, res) => {
    try {
      const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname).replace(/\/$/, '/index.html'));
      if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      const body = await read(path); // Finish fallible I/O before committing the response headers.
      res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
    } catch {
      if (!res.headersSent) res.writeHead(404);
      if (!res.writableEnded) res.end();
    }
  };
}
