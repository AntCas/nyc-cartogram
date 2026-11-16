#!/usr/bin/env python3
"""Serve site/ locally (e.g. over Tailscale), including pretty /@lat,lon share links.

Usage: python3 serve.py [port]   (default 8000, binds all interfaces)
"""

from __future__ import annotations

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SITE_DIR = Path(__file__).resolve().parent / "site"


class SiteHandler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        path, _, query = self.path.partition("?")
        if path.startswith("/@"):
            self.path = "/" + (f"?{query}" if query else "")
        super().do_GET()

    def end_headers(self) -> None:
        # Make browsers (Safari especially) revalidate on every load, so edits show up on reload;
        # unchanged files still come back as a cheap 304.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    if not (SITE_DIR / "data" / "cities.json").exists():
        sys.exit("site/data/cities.json is missing; run `python3 setup_data.py` (or build_commute_site_data.py) first.")
    server = ThreadingHTTPServer(("0.0.0.0", port), partial(SiteHandler, directory=str(SITE_DIR)))
    print(f"Serving {SITE_DIR} on http://0.0.0.0:{port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
