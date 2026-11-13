"""Loopback HTTP fixtures and backend workloads for RPC regression tests."""
import base64
import importlib
import json
from pathlib import Path
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


ROM = {"id": 42, "name": "Loopback Game", "fs_name": "game.iso",
       "fs_extension": "iso", "platform_slug": "psx", "platform_name": "PlayStation",
       "regions": ["us"], "languages": ["en"], "files": []}
COLLECTIONS = [{"id": 7, "name": "Regular"}]
SMART = [{"id": 7, "name": "Smart", "is_smart": True}]
VIRTUAL = [{"id": "opaque+/=", "name": "Virtual"}]


class Loopback:
    def __init__(self, delay=0):
        self.delay = delay
        self.entered = threading.Event()
        self.release = threading.Event()
        self.gated = False
        self.gate_after = 0
        self.requests = []
        self.status = 200
        self.auth_status = 200
        self.basic_auth = False
        self.rotating_auth = False
        self.refreshes = []
        self.refresh_lock = threading.Lock()
        self.cookies = []
        self.cookie_auth = None
        self.cookie_responses = {}
        self.roms = [dict(ROM)]
        self.pages = None
        self.truncate = False
        self.body = b"release-content\n" * 10000
        self.on_enter = None
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.form = parse_qs(self.rfile.read(int(self.headers.get("Content-Length", 0))).decode())
                self.do_GET()

            def do_GET(self):
                parsed = urlsplit(self.path)
                owner.requests.append((parsed.path, parse_qs(parsed.query),
                                       self.headers.get("Authorization")))
                owner.cookies.append(self.headers.get("Cookie"))
                owner.entered.set()
                if owner.on_enter:
                    owner.on_enter()
                if owner.gated and len(owner.requests) > owner.gate_after:
                    owner.release.wait(3)
                if owner.delay:
                    time.sleep(owner.delay)
                status = owner.status
                if owner.rotating_auth and parsed.path == "/api/roms":
                    status = 200 if self.headers.get("Authorization") == "Bearer fresh-access" else 401
                if owner.cookie_auth is not None and self.headers.get("Cookie") != "sid=" + owner.cookie_auth:
                    status = 401
                basic = "Basic " + base64.b64encode(b"user:password").decode()
                if owner.basic_auth and (parsed.path == "/api/token" or (
                        self.headers.get("Authorization") != basic
                        and self.headers.get("Cookie") != "sid=authenticated")):
                    status = 401
                if parsed.path in ("/api/roms", "/api/token") and owner.auth_status != 200:
                    status = owner.auth_status
                if owner.rotating_auth and parsed.path == "/api/token":
                    with owner.refresh_lock:
                        owner.refreshes.append(self.form)
                        valid = len(owner.refreshes) == 1 and self.form.get("refresh_token") == ["old-refresh"]
                    status = 200 if valid else 401
                    payload = {"access_token": "fresh-access", "refresh_token": "rotated-refresh", "expires_in": 3600}
                elif parsed.path == "/api/collections":
                    payload = COLLECTIONS
                elif parsed.path == "/api/collections/smart":
                    payload = SMART
                elif parsed.path == "/api/collections/virtual":
                    payload = VIRTUAL
                elif parsed.path == "/api/roms":
                    offset = int(parse_qs(parsed.query).get("offset", [0])[0])
                    payload = {"items": owner.roms if owner.pages is None else owner.pages.get(offset, [])}
                elif parsed.path.startswith("/releases"):
                    rel = {"tag_name": "v1.0.0", "body": "Notes", "prerelease": False,
                           "assets": [{"name": "ludo-decky.zip",
                                       "browser_download_url": owner.url + "/asset"}]}
                    payload = rel if parsed.path.endswith("latest") else [rel]
                else:
                    payload = {}
                body = owner.body if parsed.path == "/asset" else json.dumps(payload).encode()
                term = parse_qs(parsed.query).get("search_term", [""])[0]
                cookie, cookie_gate = owner.cookie_responses.get(term, (None, None))
                if cookie_gate is not None:
                    cookie_gate.wait(3)
                self.send_response(status)
                if cookie is not None:
                    self.send_header("Set-Cookie", "sid=" + cookie + "; Path=/")
                if owner.basic_auth and status == 200:
                    self.send_header("Set-Cookie", "sid=authenticated; Path=/")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Content-Type", "application/octet-stream" if parsed.path == "/asset" else "application/json")
                self.end_headers()
                try:
                    self.wfile.write(body[:len(body) // 2] if owner.truncate else body)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                self.close_connection = True

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


class Settings:
    def __init__(self, root):
        self.root = root
        self.password = ""

    def get(self, section, key, default=None):
        if (section, key) == ("Download", "rom_directory"):
            return str(self.root)
        if (section, key) == ("RomM", "password"):
            return self.password
        return default


def configure_backend(backend, server, root):
    mod = importlib.import_module("ludo_app.backend")
    backend._settings = Settings(root)
    backend._romm_client = mod.RomMClient(server.url)
    backend._romm_client.authenticated = True
    backend._is_offline = lambda: False
    backend._available_games = []
    backend._romm_collections = [dict(c) for c in COLLECTIONS]
    backend._romm_smart_collections = [dict(c) for c in SMART]
    backend._romm_virtual_collections = [dict(c) for c in VIRTUAL]
    backend._cover_paths = {}
    backend._stop_sync = lambda: None
    backend._detach_sync = lambda: (lambda: None)
    return backend


def make_backend(server, root):
    from ludo_app.backend import LudoBackend
    from ludo_app.host import HostProfile
    return configure_backend(LudoBackend(host=HostProfile(
        "1.0.0", "-decky.zip", Path(root) / "updates", "desktop")), server, root)


def workload(backend, server, target):
    if target == "test_connection":
        return backend.test_connection(server.url, "user", "password")
    if target == "check_for_update":
        return backend.check_for_update("stable")
    if target == "download_update":
        return backend.download_update(server.url + "/asset", "ludo-decky.zip")
    if target == "search_games":
        return backend.search_games("Loopback")
    return backend.get_library_games("collection", {
        "regular": "Regular", "smart": "Smart", "virtual": "opaque+/="}[target])


TARGETS = ("test_connection", "check_for_update", "download_update",
           "regular", "smart", "virtual", "search_games")
