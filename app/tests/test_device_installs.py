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
    b._handle_install({'id': 'req-1', 'rom_id': ROM}, 'dev-1', active,
                      b._stop_event, b._romm_client)
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
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'engine' / 'tests'))
    from lock_process_helper import LockProcess
    assert Path(backend_mod.__file__).resolve() == Path(__file__).resolve().parents[1] / 'ludo_app' / 'backend.py'
    monkeypatch.setattr(backend_mod, "CONFIG_DIR", tmp_path)
    held = LudoBackend._take_install_lock()
    assert held is not None
    try:
        other = LockProcess(tmp_path / "installs.lock", 'install')
        try:
            assert not other.acquired
        finally:
            other.close()
    finally:
        held.close()
    again = LudoBackend._take_install_lock()
    assert again is not None
    again.close()


@pytest.mark.parametrize('stage', ['download', 'extraction'])
def test_install_stop_retains_lock_until_actual_io_finishes(backend, tmp_path, monkeypatch, stage):
    import sys
    from types import SimpleNamespace
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'engine' / 'tests'))
    from lock_process_helper import LockProcess, TIMEOUT
    from romm_sync_engine.owned_tasks import OwnedTasks
    monkeypatch.setattr(backend_mod, 'CONFIG_DIR', tmp_path)
    owners = []
    def owned(lock):
        owner = OwnedTasks(lock)
        owners.append(owner)
        return owner
    monkeypatch.setattr(backend_mod, 'OwnedTasks', owned)
    entered, finish, request_done = threading.Event(), threading.Event(), threading.Event()
    outputs = []
    def block():
        entered.set()
        assert finish.wait(TIMEOUT), 'test I/O was not released'
    def download(rom_id, name, dest, *args, **kwargs):
        if stage == 'download':
            block()
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        Path(dest).write_bytes(b'fixture rom')
        outputs.append(Path(dest))
        return True, 'done'
    def extract(dest, rom_id):
        if stage == 'extraction':
            block()
        return dest
    client = SimpleNamespace(authenticated=True, base_url='https://fixture.invalid',
                             client_token='test-only', session=SimpleNamespace(verify=True),
                             server_features={'device_install': True}, download_rom=download,
                             claim_installs=lambda device: ([{'id': 'req-1', 'rom_id': ROM}], None),
                             report_install=lambda *args: None)
    backend._romm_client = client
    backend._install_platform_off = lambda rom_id, game: []
    backend._maybe_unzip_download = extract
    backend._maybe_decompress_switch = lambda dest, rom_id: dest
    backend._handle_switch_add_ons = lambda *args: None
    backend._persist_snapshot_throttled = lambda: None
    original = backend._handle_install
    def handle(*args):
        try:
            original(*args)
        finally:
            request_done.set()
    monkeypatch.setattr(backend, '_handle_install', handle)
    socket = SimpleNamespace(ensure=lambda *args: None, close=lambda: None)
    wake = threading.Event()
    wake.set()
    loop = threading.Thread(target=backend._install_loop,
                            args=(backend._stop_event, wake, socket, socket))
    loop.start()
    try:
        assert entered.wait(TIMEOUT)
        backend._stop_event.set()
        wake.set()
        loop.join(TIMEOUT)
        assert not loop.is_alive()
        assert request_done.wait(TIMEOUT)  # The request watcher has exited.
        assert not owners[0].done.is_set()  # Actual file I/O has not.
        contender = LockProcess(tmp_path / 'installs.lock', 'install')
        try:
            assert not contender.acquired
        finally:
            contender.close()
        finish.set()
        assert owners[0].done.wait(TIMEOUT)
        assert backend._download_progress[ROM]['state'] == 'done'
        assert outputs[0].read_bytes() == b'fixture rom'
        contender = LockProcess(tmp_path / 'installs.lock', 'install')
        try:
            assert contender.acquired
        finally:
            contender.close()
    finally:
        finish.set()
        backend._stop_event.set()
        wake.set()
        loop.join(TIMEOUT)
        for owner in owners:
            owner.close()
            assert owner.done.wait(TIMEOUT)


def test_install_lock_real_io_failure_propagates(tmp_path, monkeypatch):
    monkeypatch.setattr(backend_mod, 'CONFIG_DIR', tmp_path)
    (tmp_path / 'installs.lock').mkdir()
    with pytest.raises(OSError):
        LudoBackend._take_install_lock()


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
        b._handle_install({'id': f'req-{i}', 'rom_id': ROM}, 'dev-1', {f'req-{i}'},
                          b._stop_event, b._romm_client)
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
    assert started == [ROM]
    # Only the 'installed' toast: nothing declined, nothing critical.
    assert [t[0][1] for t in toasts] == ['Installed from RomM']
    assert not toasts[0][1].get('critical')
    assert [r[0][0] for r in rows] == ['install']  # not 'download': that kind is listed as completed


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


def _cancellable_download(b, started):
    """A transfer that runs until Ludo asks it to stop, like the real worker."""
    async def download(rom_id):
        started.set()
        b._download_progress[rom_id] = {'state': 'downloading'}

        def worker():
            while rom_id not in b._download_cancels:
                threading.Event().wait(0.02)
            b._download_progress[rom_id] = {'state': 'cancelled'}
        threading.Thread(target=worker, daemon=True).start()
        return {'success': True}
    return download


def test_a_cancel_from_romm_stops_the_download_and_reports_nothing(backend, monkeypatch):
    client = backend._romm_client = StubClient()
    started = threading.Event()
    monkeypatch.setattr(backend, "download_game", _cancellable_download(backend, started))
    t = threading.Thread(target=_handle, args=(backend,))
    t.start()
    assert started.wait(3)
    backend._on_install_cancelled('req-1')
    t.join(10)
    assert not t.is_alive()
    assert client.reports == [], "RomM already ended a cancelled request"
    assert backend._download_progress[ROM]['state'] == 'cancelled'
    assert not backend._install_jobs and not backend._install_cancelled


def test_a_cancel_before_the_download_starts_skips_it(backend, monkeypatch):
    client = backend._romm_client = StubClient()
    started = threading.Event()
    monkeypatch.setattr(backend, "download_game", _cancellable_download(backend, started))
    real_index = backend._games_index

    def index_then_cancel():
        backend._on_install_cancelled('req-1')   # lands mid-lookup
        return real_index()
    monkeypatch.setattr(backend, "_games_index", index_then_cancel)
    _handle(backend)
    assert not started.is_set() and client.reports == []


def test_a_cancel_for_another_request_is_ignored(backend):
    backend._on_install_cancelled('someone-else')
    assert not backend._install_cancelled
