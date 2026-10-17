#!/usr/bin/env python3
"""Serve the browser build locally: python3 web/serve.py [DIR] [--port N].

The runtime uses wasm threads (SharedArrayBuffer), which browsers only allow on
cross-origin isolated pages, so every response carries
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
Any static host works the same way if it sends those two headers. Binds to
127.0.0.1 (localhost is a secure context, which OPFS also requires).
"""
import argparse
import functools
import http.server
import os
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
    }

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_dir = os.path.join(os.path.dirname(here), "build", "web", "site")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dir", nargs="?", default=default_dir)
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--bind", default="127.0.0.1")
    a = ap.parse_args()
    if not os.path.isfile(os.path.join(a.dir, "index.html")):
        sys.exit(f"{a.dir} has no index.html; build first with web/build.sh")
    handler = functools.partial(Handler, directory=a.dir)
    with http.server.ThreadingHTTPServer((a.bind, a.port), handler) as srv:
        print(f"Serving {a.dir} at http://{a.bind}:{a.port}/ (COOP/COEP on); Ctrl+C stops")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
