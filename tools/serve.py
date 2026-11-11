"""Dev server for the game: like `python -m http.server`, but tells the browser never to cache,
so edited game files are always picked up on reload."""
import functools, http.server, sys
class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8173
root = sys.argv[2] if len(sys.argv) > 2 else '.'
http.server.ThreadingHTTPServer(('', port), functools.partial(NoCache, directory=root)).serve_forever()
