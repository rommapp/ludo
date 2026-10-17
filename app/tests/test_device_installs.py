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
