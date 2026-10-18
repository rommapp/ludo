"""Installs pushed from RomM's web UI ("Install on device", RomM 5.4+).

_handle_install takes one claimed request and must always end it on the
server: 'already_installed' for a game already here, 'done' once the download
lands, 'failed' with a reason otherwise. A request left unreported stays
"taken" in the web UI forever.

Run with:  pytest app/tests
"""
import threading
from pathlib import Path

import pytest

from ludo_app import backend as backend_mod
from ludo_app.backend import LudoBackend
from ludo_app.host import HostProfile

DESKTOP = HostProfile("1.0.0", "-x86_64.AppImage", Path("/tmp/desk-rt"), "desktop")
ROM = 7


class StubClient:
    authenticated = True

    def __init__(self, ok=True):
        self.ok = ok
        self.reports = []

    def download_rom(self, rom_id, name, dest, progress_callback=None,
                     cancellation_checker=None, file_ids=None):
        if self.ok:
            Path(dest).parent.mkdir(parents=True, exist_ok=True)
            Path(dest).write_bytes(b'rom')
            return True, "Download successful"
        return False, "HTTP 500"

    def report_install(self, device_id, request_id, status, reason=None):
        self.reports.append((request_id, status, reason))
        return True


@pytest.fixture
def backend(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    # The download worker persists the library; keep it out of the real config.
    monkeypatch.setattr(backend_mod, "snapshot_file", tmp_path / "snapshot.json")
    monkeypatch.setattr(backend_mod, "_record_activity", lambda *a, **k: None)
    b = LudoBackend(host=DESKTOP)
    b._download_progress = {}
    b._download_cancels = set()
    b._stop_event = threading.Event()
    b._settings = type("S", (), {"get": lambda self, *a: str(tmp_path / "roms")})()
    monkeypatch.setattr(b, "_rom_exists_on_server", lambda rid: True)
    b._game = {'name': 'Tetris', 'platform_slug': 'gb', 'file_name': 'tetris.gb'}
    monkeypatch.setattr(b, "_games_index", lambda: {ROM: b._game})
    return b


def _handle(b):
    active = {'req-1'}
    b._handle_install({'id': 'req-1', 'rom_id': ROM}, 'dev-1', active)
    assert not active, "the request must leave the active set"
    return b._romm_client.reports


def test_a_downloaded_game_reports_already_installed(backend):
    backend._romm_client = StubClient()
    backend._game['is_downloaded'] = True
    assert _handle(backend) == [('req-1', 'already_installed', None)]


def test_a_finished_download_reports_done(backend):
    backend._romm_client = StubClient(ok=True)
    assert _handle(backend) == [('req-1', 'done', None)]


def test_a_failed_download_reports_failed_with_the_reason(backend):
    backend._romm_client = StubClient(ok=False)
    [(rid, status, reason)] = _handle(backend)
    assert (rid, status) == ('req-1', 'failed')
    assert reason


def test_shutdown_mid_download_leaves_the_request_for_the_next_claim(backend, monkeypatch):
    client = StubClient()
    backend._romm_client = client

    async def slow_download(rom_id):
        backend._download_progress[rom_id] = {'state': 'downloading'}
        return {'success': True}

    monkeypatch.setattr(backend, "download_game", slow_download)
    backend._stop_event.set()
    _handle(backend)
    assert client.reports == []


def test_install_lock_is_held_by_one_process(tmp_path, monkeypatch):
    """Desktop and Decky share a config: only one may claim installs."""
    import subprocess, sys
    monkeypatch.setattr(backend_mod, "CONFIG_DIR", tmp_path)
    held = LudoBackend._take_install_lock()
    assert held is not None
    other = subprocess.run(
        [sys.executable, "-c",
         "import fcntl,sys; f=open(sys.argv[1],'w')\n"
         "try: fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB); print('got')\n"
         "except OSError: print('busy')", str(tmp_path / "installs.lock")],
        capture_output=True, text=True)
    assert other.stdout.strip() == "busy"
    held.close()
    assert LudoBackend._take_install_lock() is not None


class Resp:
    def __init__(self, status, body=None):
        self.status_code, self._body = status, body

    def json(self):
        return self._body


class StubSession:
    def __init__(self, resp):
        self.resp, self.urls = resp, []

    def get(self, url, timeout=None):
        self.urls.append(url)
        if isinstance(self.resp, Exception):
            raise self.resp
        return self.resp


C64_ROM = {'id': ROM, 'name': 'Telepathy', 'platform_slug': 'c64',
           'platform_display_name': 'Commodore 64'}


@pytest.fixture
def c64_off(backend, monkeypatch):
    """A ROM on a switched-off platform: not in the library, so asked for by id."""
    monkeypatch.setattr(backend, "_games_index", lambda: {})
    monkeypatch.setattr(backend, "_disabled_platforms", lambda: {'c64'})
    monkeypatch.setattr(backend, "_DECLINE_SETTLE", 0.05)
    rows, toasts = [], []
    monkeypatch.setattr(backend_mod, "_record_activity",
                        lambda *a, **k: rows.append((a, k)))
    monkeypatch.setattr(backend_mod, "_push_notification",
                        lambda *a, **k: toasts.append((a, k)), raising=False)
    monkeypatch.setattr(backend_mod, "SYNC_CORE_AVAILABLE", True)
    monkeypatch.setattr(backend_mod, "activity_log", None)
    client = StubClient()
    client.base_url = 'https://romm.test'
    client.session = StubSession(Resp(200, C64_ROM))
    backend._romm_client = client
    return backend, rows, toasts


def _settled(cond):
    import time
    end = time.time() + 3
    while time.time() < end and not cond():
        time.sleep(0.02)
    return cond()


def test_a_switched_off_platform_is_declined_with_the_reason(c64_off):
    b, rows, toasts = c64_off
    assert _handle(b) == [('req-1', 'failed',
                           'Commodore 64 is switched off in Ludo on this device')]
    assert ROM not in b._download_progress, "nothing may be downloaded"
    assert _settled(lambda: rows and toasts)
    (kind, title, detail), kw = rows[0]
    assert (kind, title) == ('error', 'Install from RomM declined — Telepathy')
    assert kw['action'] == {'kind': 'enable_platform', 'label': 'Turn on',
                            'platform': 'c64', 'count': 1}
    assert toasts[0][1]['critical'] is True


def test_declines_arriving_together_are_one_row_and_one_toast(c64_off):
    b, rows, toasts = c64_off
    for i in range(3):
        b._handle_install({'id': f'req-{i}', 'rom_id': ROM}, 'dev-1', {f'req-{i}'})
    assert _settled(lambda: rows and toasts)
    import time; time.sleep(0.2)
    assert len(rows) == 1 and len(toasts) == 1
    assert rows[0][0][1] == '3 installs from RomM declined'
    assert [s for _, s, _ in b._romm_client.reports] == ['failed'] * 3


def test_an_unreadable_rom_is_installed_as_before(c64_off):
    b, rows, toasts = c64_off
    b._romm_client.session = StubSession(OSError("offline"))
    started = []

    async def fake_download(rom_id):
        started.append(rom_id)
        b._download_progress[rom_id] = {'state': 'done'}
        return {'success': True}
    b.download_game = fake_download
    assert _handle(b) == [('req-1', 'done', None)]
    assert started == [ROM] and not toasts
    assert [r[0][0] for r in rows] == ['download']


def test_turn_on_switches_the_platform_back_on(backend, monkeypatch):
    import asyncio
    monkeypatch.setattr(backend, "_disabled_platforms", lambda: {'c64', 'gb'})
    wrote = []

    async def fake_set(disabled=None):
        wrote.append(disabled)
        return {'success': True, 'changed': True, 'needs_refresh': True}
    monkeypatch.setattr(backend, "set_platform_sync", fake_set)
    resolved = []
    monkeypatch.setattr(backend_mod, "activity_log",
                        type("A", (), {"resolve_action": staticmethod(
                            lambda kind, **m: resolved.append((kind, m)))}))
    r = asyncio.run(backend.enable_platform('C64'))
    assert r['needs_refresh'] and wrote == [['gb']]
    assert resolved == [('enable_platform', {'platform': 'c64'})]
