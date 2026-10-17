#!/usr/bin/env python3
"""RomM 5.4 refusals: revoked credentials, and uploads it will never accept.

Asserted here:
  * a 401 on an API call mid-session marks the client unauthenticated and
    auth_rejected, so the UI can say "sign in again" instead of "server down";
  * a 401 from a sign-in endpoint (or before we were signed in) changes nothing;
  * a password session tries one refresh first and stays signed in if it works;
  * an upload RomM refused for its name or size is not sent again while the
    file is unchanged, and is not counted as an error.
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import AutoSyncManager, RomMClient  # noqa: E402

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


class _Resp:
    def __init__(self, code, url):
        self.status_code, self.url = code, url


def _client(**kw):
    c = RomMClient('https://romm.example')
    c.authenticated = True
    for k, v in kw.items():
        setattr(c, k, v)
    return c


def test_auth_watch():
    c = _client(client_token='rmm_x')
    c._watch_auth(_Resp(200, 'https://romm.example/api/roms'))
    check('a 200 changes nothing', (c.authenticated, c.auth_rejected), (True, False))
    c._watch_auth(_Resp(401, 'https://romm.example/api/token'))
    check('a sign-in endpoint 401 is ignored', (c.authenticated, c.auth_rejected), (True, False))
    c._watch_auth(_Resp(401, 'https://romm.example/api/sync/negotiate'))
    check('an API 401 revokes the session', (c.authenticated, c.auth_rejected), (False, True))

    c = _client()
    c.authenticated = False
    c._watch_auth(_Resp(401, 'https://romm.example/api/roms'))
    check('a 401 before sign-in is not a revocation', c.auth_rejected, False)

    c = _client(refresh_token='r')
    c.refresh_access_token = lambda: True
    c._watch_auth(_Resp(401, 'https://romm.example/api/roms'))
    check('a refreshable session refreshes instead', (c.authenticated, c.auth_rejected), (True, False))

    c = _client(refresh_token='r')
    c.refresh_access_token = lambda: False
    c._watch_auth(_Resp(401, 'https://romm.example/api/roms'))
    check('a failed refresh revokes', (c.authenticated, c.auth_rejected), (False, True))


class _SyncClient:
    authenticated = True

    def __init__(self):
        self.uploads = 0

    def negotiate_sync(self, device_id, inventory):
        return 1, [{'action': 'upload', 'rom_id': 1, 'slot': 'autosave'}]

    def upload_save(self, *a, **k):
        self.uploads += 1
        return 'rejected'

    def complete_sync_session(self, *a, **k):
        pass


def test_rejected_upload():
    import contextlib
    from romm_sync_engine import sync_core
    sync_core._record_activity = lambda *a, **k: None
    with tempfile.TemporaryDirectory() as td:
        srm = Path(td) / 'Game.srm'
        srm.write_bytes(b'x' * 64)
        m = AutoSyncManager.__new__(AutoSyncManager)
        m.romm_client = _SyncClient()
        m.settings = type('S', (), {'get': lambda self, *a: 'dev-1'})()
        m.build_sync_inventory = lambda: [{'rom_id': 1, 'slot': 'autosave', '_path': str(srm)}]
        m.retroarch = type('R', (), {'save_dirs': {}})()
        m.get_games = lambda: []
        m.save_download_blocked = set()
        m._record_synced = lambda p: False
        m.mark_all_synced = lambda exclude=None: False
        m._notify_sync_result = lambda *a, **k: None
        m._activity_upload = lambda *a: contextlib.nullcontext()
        m.log = lambda *a, **k: None

        first = m.run_negotiated_save_sync()
        second = m.run_negotiated_save_sync()
        check('the refused file is sent once', m.romm_client.uploads, 1)
        check('and counted as rejected, not an error, both times',
              [(s.get('rejected'), s['errors']) for s in (first, second)], [(1, 0), (1, 0)])

        srm.write_bytes(b'y' * 80)   # the user renamed/changed it: try again
        m.run_negotiated_save_sync()
        check('a changed file is tried again', m.romm_client.uploads, 2)


def main():
    test_auth_watch()
    test_rejected_upload()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) failed: {FAILURES}")
        return 1
    print("all checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
