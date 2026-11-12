#!/usr/bin/env python3
"""Tiny stand-in for the GitHub contents + git-data API, for testing the app on localhost.
Serves a local folder as "the repo". Writes (the app's Save) go into that folder, so point it at a COPY.

  python3 tools/mock-github.py <data-dir> [port=8791]
  open http://localhost:8790/v2/?api=http://localhost:8791   (app served by: python3 -m http.server 8790)
"""
import base64, hashlib, json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

ROOT = os.path.abspath(sys.argv[1])
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8791
PENDING = {}  # tree sha -> [(path, content)]
LOG = []


def blob_sha(b):
    return hashlib.sha1(b"blob %d\0" % len(b) + b).hexdigest()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, If-None-Match, Content-Type, Accept")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "ETag")

    def out(self, code, body=b"", ctype="application/json", etag=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.cors()
        if etag:
            self.send_header("ETag", etag)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if code != 304:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self.out(204)

    def parts(self):
        p = unquote(urlparse(self.path).path).strip("/").split("/")
        return p[3:] if len(p) >= 3 and p[0] == "repos" else None

    def do_GET(self):
        p = self.parts()
        if p is None:
            return self.out(404, {"message": "not found"})
        if not p:
            return self.out(200, {"full_name": "local/data"})
        if p[0] == "__log":
            return self.out(200, LOG)
        if p[0] == "git":
            if p[1] == "ref":
                return self.out(200, {"object": {"sha": "HEAD"}})
            if p[1] == "commits":
                return self.out(200, {"tree": {"sha": "TREE"}})
        if p[0] == "contents":
            rel = "/".join(p[1:])
            full = os.path.normpath(os.path.join(ROOT, rel))
            if not full.startswith(ROOT) or not os.path.exists(full):
                return self.out(404, {"message": "Not Found"})
            if os.path.isdir(full):
                items = []
                for n in sorted(os.listdir(full)):
                    f = os.path.join(full, n)
                    d = os.path.isdir(f)
                    items.append({"name": n, "path": (rel + "/" + n).strip("/"), "type": "dir" if d else "file",
                                  "sha": "dir" if d else blob_sha(open(f, "rb").read())})
                body = json.dumps(items).encode()
                etag = '"' + hashlib.sha1(body).hexdigest() + '"'
                if self.headers.get("If-None-Match") == etag:
                    return self.out(304, etag=etag)
                return self.out(200, body, etag=etag)
            data = open(full, "rb").read()
            etag = '"' + blob_sha(data) + '"'
            if self.headers.get("If-None-Match") == etag:
                return self.out(304, etag=etag)
            if "raw" in (self.headers.get("Accept") or ""):
                return self.out(200, data, "text/plain; charset=utf-8", etag)
            return self.out(200, {"content": base64.b64encode(data).decode(), "sha": blob_sha(data)}, etag=etag)
        self.out(404, {"message": "not found"})

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_POST(self):
        p = self.parts() or []
        b = self.body()
        if p[:2] == ["git", "trees"]:
            sha = hashlib.sha1(json.dumps(b).encode()).hexdigest()
            PENDING[sha] = [(t["path"], t["content"]) for t in b.get("tree", [])]
            return self.out(201, {"sha": sha})
        if p[:2] == ["git", "commits"]:
            for path, content in PENDING.pop(b.get("tree"), []):
                full = os.path.normpath(os.path.join(ROOT, path))
                if full.startswith(ROOT):
                    os.makedirs(os.path.dirname(full), exist_ok=True)
                    open(full, "w").write(content)
            LOG.append({"message": b.get("message")})
            return self.out(201, {"sha": "HEAD"})
        self.out(404, {"message": "not found"})

    def do_PATCH(self):
        self.body()
        self.out(200, {"ok": True})


print(f"mock GitHub on http://localhost:{PORT} serving {ROOT}")
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
