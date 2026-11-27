"""Backend replacement managers must acquire ownership after a bounded stop.

Network/emulator integrations are stubs; backend connect/restart/retry, manager
construction, owned save workers and native cross-process locks are real.
Retry waits are stepped explicitly, so no test relies on a scheduling sleep.
"""
import asyncio
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace

import pytest

from ludo_app import backend as backend_mod
from ludo_app.backend import LudoBackend
from ludo_app.host import HostProfile
from romm_sync_engine import sync_core

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'engine' / 'tests'))
from lock_process_helper import LockProcess, TIMEOUT


class SteppedEvent(threading.Event):
    """A cancellable retry wait with one explicit permit per loop iteration."""
    def __init__(self):
        super().__init__()
        self.steps = threading.Condition()
        self.waits = 0
        self.permits = 0
        self.timeouts = []

    def set(self):
        super().set()
        with self.steps:
            self.steps.notify_all()

    def wait(self, timeout=None):
        with self.steps:
            self.waits += 1
            self.timeouts.append(timeout)
            self.steps.notify_all()
            assert self.steps.wait_for(lambda: self.is_set() or self.permits, TIMEOUT)
            if self.permits:
                self.permits -= 1
            return self.is_set()

    def ready(self):
        with self.steps:
            assert self.steps.wait_for(lambda: self.waits > 0, TIMEOUT)

    def tick(self):
        with self.steps:
            previous = self.waits
            self.permits += 1
            self.steps.notify_all()
            assert self.steps.wait_for(lambda: self.waits > previous, TIMEOUT)


@pytest.fixture
def restart_backend(monkeypatch, tmp_path, request):
    for key in ('HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'):
        monkeypatch.setenv(key, str(tmp_path))
    monkeypatch.delenv('LUDO_DEV_READ_ONLY', raising=False)
    monkeypatch.setattr(sync_core, 'config_dir', lambda: tmp_path)
    monkeypatch.setattr(sync_core, 'cache_dir', lambda: tmp_path / 'cache')
    # Only backend loop events are stepped. Owned workers use ordinary Events.
    monkeypatch.setattr(backend_mod, 'threading', SimpleNamespace(
        **{name: (SteppedEvent if name == 'Event' else getattr(threading, name))
           for name in dir(threading)}))

    class Settings:
        config = {'AutoSync': {}}
        values = {('RomM', 'url'): 'https://romm.invalid',
                  ('RomM', 'client_token'): 'test-only',
                  ('RomM', 'auto_connect'): 'true',
                  ('AutoSync', 'startup_sync_enabled'): 'false'}

        def get(self, section, key, fallback=''):
            return self.values.get((section, key), fallback)

        def set(self, section, key, value):
            self.values[section, key] = value

        def save_settings(self):
            pass

    settings = Settings()
    monkeypatch.setattr(backend_mod, 'SettingsManager', lambda: settings)
    monkeypatch.setattr(backend_mod, 'RetroArchInterface', lambda: SimpleNamespace(
        settings=settings, refresh_installation=lambda: {}, align_retroarch_config=lambda: None))
    monkeypatch.setattr(backend_mod, 'SteamShortcutManager', lambda **kw: SimpleNamespace(
        is_available=lambda: False))
    for name in ('InstallSocket', 'ScanSocket'):
        monkeypatch.setattr(backend_mod, name, lambda *a, **kw: SimpleNamespace(close=lambda: None))
    monkeypatch.setattr(backend_mod, 'CoverArtManager', lambda *a: None)
    monkeypatch.setattr(backend_mod, 'load_decky_settings', lambda: {})
    monkeypatch.setattr(backend_mod, 'save_decky_settings', lambda value: None)
    monkeypatch.setattr(backend_mod, '_record_activity', lambda *a, **kw: None)
    clients, collection_reads = [], []

    def get_collections(**kwargs):
        collection_reads.append(kwargs)
        return []

    def client_factory(*args, **kwargs):
        client = SimpleNamespace(authenticated=True, session=SimpleNamespace(close=lambda: None),
                                 get_platforms=lambda: [], get_collections=get_collections,
                                 get_smart_collections=lambda: [], get_virtual_collections=lambda: [],
                                 count_roms=lambda **kw: 0 if kw else 1)
        clients.append(client)
        return client

    # Keep the class intact: the backend constructor installs a class callback.
    monkeypatch.setattr(backend_mod, 'RomMClient', type('Client', (), {'__new__': staticmethod(client_factory)}))
    b = LudoBackend(host=HostProfile('1.0.0', '-test', tmp_path, 'desktop'))
    b._available_games = [{'rom_id': 1}]
    b._snapshot_fetched_at = '2026-01-01T00:00:00Z'
    b._library_server_total = 1
    b._platform_slug_to_name = {}
    b._disabled_collection_counts = {}
    b._defer_library_fetch = False
    for name in ('_apply_platform_sync_to_client', '_fetch_disabled_counts',
                 '_ensure_device_registered', '_read_server_features', '_init_bios_tracking',
                 '_init_collection_sync', '_note_reachable', '_reachability_loop', '_install_loop',
                 '_steam_shortcut_loop'):
        monkeypatch.setattr(b, name, lambda *a, **kw: None)
    monkeypatch.setattr(b, '_library_auto_update', lambda: False)

    managers, probes = [], []
    entered, finish = threading.Event(), threading.Event()
    completed = []

    def manager_factory(**kwargs):
        manager = sync_core.AutoSyncManager(**kwargs)
        index = len(managers)
        managers.append(manager)
        manager._SYNC_DRAIN_TIMEOUT = .05
        for name in ('start_play_watch', 'start_upload_worker', 'start_file_monitoring',
                     'start_retroarch_monitoring', 'start_playlist_monitoring',
                     'refresh_save_dirs', 'flush_pending_states'):
            monkeypatch.setattr(manager, name, lambda: None)
        monkeypatch.setattr(manager.play_sessions, 'sync_async', lambda: None)

        def save_io(*args, **kwargs):
            if index == 0:
                entered.set()
                assert finish.wait(TIMEOUT), 'draining save worker was never released'
            (tmp_path / f'save-result-{index}').write_text('finished')
            completed.append(index)

        monkeypatch.setattr(manager, '_run_negotiated_save_sync', save_io)
        return manager

    monkeypatch.setattr(backend_mod, 'AutoSyncManager', manager_factory)

    def probe():
        child = LockProcess(tmp_path / 'autosync.lock', kind='auto')
        probes.append(child)
        return child

    def restart(method='paths'):
        started = time.monotonic()
        if method == 'paths':
            result = asyncio.run(b.set_library_paths(save_directory=str(tmp_path / f'saves-{len(managers)}')))
        else:
            result = asyncio.run(b.save_config('https://romm.invalid', 'test', '', '', '', 'test'))
        assert result['success'], result
        assert time.monotonic() - started < 3, 'restart waited for the live save worker'
        b._stop_event.ready()
        return b._auto_sync

    external = probe() if getattr(request, 'param', None) == 'external_owner' else None
    if external:
        assert external.acquired
    b._start_sync()
    try:
        b._stop_event.ready()
        if not external:
            assert entered.wait(TIMEOUT)
        yield SimpleNamespace(backend=b, managers=managers, entered=entered, finish=finish,
                              completed=completed, probe=probe, restart=restart, path=tmp_path,
                              collection_reads=collection_reads, external=external)
    finally:
        b._stop_sync()
        finish.set()
        for manager in managers:
            manager.stop_auto_sync()
            if manager._sync_ownership:
                assert manager._sync_ownership.done.wait(TIMEOUT)
        for child in probes:
            child.close()
        b._rpc_executor.shutdown(wait=True)


@pytest.mark.parametrize('method', ['paths', 'config'])
def test_replacement_starts_after_predecessor_drains(restart_backend, method):
    h = restart_backend
    old = h.managers[0]
    replacement = h.restart(method)
    reads = len(h.collection_reads)
    assert replacement is not old
    assert not old.enabled and old.should_stop.is_set()
    assert not old._sync_ownership.done.is_set()
    assert replacement.blocked_by_other_instance and not replacement.enabled
    contender = h.probe()
    assert not contender.acquired
    h.backend._stop_event.tick()
    assert not replacement.enabled
    assert not contender.command('acquire')['acquired']

    h.finish.set()
    assert old._sync_ownership.done.wait(TIMEOUT)
    assert (h.path / 'save-result-0').read_text() == 'finished'
    # A third process can win the handoff; retry must respect its real lock too.
    third = h.probe()
    assert third.acquired
    h.backend._stop_event.tick()
    assert not replacement.enabled
    assert not contender.command('acquire')['acquired']
    third.command('release')
    h.backend._stop_event.tick()
    assert replacement.enabled, 'authenticated replacement never retried auto-sync after the owner drained'
    assert len(h.collection_reads) == reads, 'lock retries must not poll the server faster'
    assert not contender.command('acquire')['acquired']
    h.backend._stop_sync()
    assert replacement._sync_ownership.done.wait(TIMEOUT)
    assert h.completed == [0, 1]
    assert contender.command('acquire')['acquired']


@pytest.mark.parametrize('shutdown', ['stop', 'unload'])
def test_shutdown_cancels_pending_replacement(restart_backend, shutdown):
    h = restart_backend
    replacement = h.restart()
    event, retry = h.backend._stop_event, h.backend._retry_thread
    started = time.monotonic()
    if shutdown == 'unload':
        asyncio.run(h.backend._unload())
        h.backend._start_sync()  # A closed backend must not reopen itself.
    else:
        h.backend._stop_sync()
    assert time.monotonic() - started < 3
    assert event.is_set() and not retry.is_alive()
    assert h.backend._auto_sync is None
    assert not h.probe().acquired  # The original worker still owns its lock.
    h.finish.set()
    assert h.managers[0]._sync_ownership.done.wait(TIMEOUT)
    assert h.probe().acquired
    assert not replacement.enabled and h.completed == [0]


def test_second_restart_preserves_handoff_for_newest_manager(restart_backend):
    h = restart_backend
    middle = h.restart()
    cancelled, retry = h.backend._stop_event, h.backend._retry_thread
    newest = h.restart()
    assert newest is not middle and cancelled.is_set() and not retry.is_alive()
    assert not h.managers[0]._sync_ownership.done.is_set()
    assert not h.probe().acquired
    h.finish.set()
    assert h.managers[0]._sync_ownership.done.wait(TIMEOUT)
    h.backend._stop_event.tick()
    assert newest.enabled and not middle.enabled
    assert not h.probe().acquired
    h.backend._stop_sync()
    assert newest._sync_ownership.done.wait(TIMEOUT)
    assert h.completed == [0, 2]


@pytest.mark.parametrize('revoked', ['setup', 'read_only', 'disconnected', 'client_replaced'])
def test_pending_restart_rechecks_authorization(restart_backend, monkeypatch, revoked):
    h = restart_backend
    replacement = h.restart()
    client = h.backend._romm_client
    if revoked == 'setup':
        h.backend._defer_library_fetch = True
    elif revoked == 'read_only':
        monkeypatch.setenv('LUDO_DEV_READ_ONLY', '1')
    elif revoked == 'disconnected':
        client.authenticated = False
    else:
        h.backend._romm_client = SimpleNamespace(authenticated=True)
    h.finish.set()
    assert h.managers[0]._sync_ownership.done.wait(TIMEOUT)
    h.backend._stop_event.tick()
    assert not replacement.enabled
    contender = h.probe()
    assert contender.acquired
    contender.command('release')
    # Restoring authorization makes the same pending replacement eligible.
    h.backend._defer_library_fetch = False
    monkeypatch.delenv('LUDO_DEV_READ_ONLY', raising=False)
    client.authenticated = True
    h.backend._romm_client = client
    h.backend._stop_event.tick()
    assert replacement.enabled
    assert not contender.command('acquire')['acquired']


@pytest.mark.parametrize('supersede', [False, True])
def test_queued_retry_cannot_revive_detached_manager(restart_backend, monkeypatch, supersede):
    h = restart_backend
    stale = h.restart()
    event, retry = h.backend._stop_event, h.backend._retry_thread
    queued, release = threading.Event(), threading.Event()
    original = h.backend._start_auto_sync_if_current

    def delayed(manager, stop_event):
        if manager is stale:
            queued.set()
            assert release.wait(TIMEOUT)
        return original(manager, stop_event)

    monkeypatch.setattr(h.backend, '_start_auto_sync_if_current', delayed)
    h.finish.set()
    assert h.managers[0]._sync_ownership.done.wait(TIMEOUT)
    contender = h.probe()
    assert contender.acquired
    # Wake the real retry loop, pause immediately before its admission check,
    # then detach it before it can acquire the now-free lock.
    with event.steps:
        event.permits += 1
        event.steps.notify_all()
    assert queued.wait(TIMEOUT)
    stop = h.backend._detach_sync()
    try:
        if supersede:
            h.backend._start_sync()
            h.backend._stop_event.ready()
            current = h.backend._auto_sync
            assert current is not stale and not current.enabled
        contender.command('release')
        release.set()
        stop()
        assert not retry.is_alive()
        h.finish.set()
        assert h.managers[0]._sync_ownership.done.wait(TIMEOUT)
        assert not stale.enabled and stale._sync_ownership is None
        if supersede:
            h.backend._stop_event.tick()
            assert current.enabled
            assert not h.probe().acquired
        else:
            assert h.backend._auto_sync is None
            assert h.probe().acquired
    finally:
        release.set()


@pytest.mark.parametrize('restart_backend', ['external_owner'], indirect=True)
def test_initial_external_owner_does_not_schedule_handoff_retries(restart_backend, caplog):
    h = restart_backend
    manager = h.backend._auto_sync
    event = h.backend._stop_event
    assert manager.blocked_by_other_instance and not manager.enabled
    caplog.clear()
    for _ in range(3):
        event.tick()
    assert all(delay > 290 for delay in event.timeouts)
    assert not any('Auto-sync blocked' in record.message for record in caplog.records)
    # No local manager was replaced, so an external owner's exit is not a
    # standing request to start save-sync in this backend.
    h.external.command('release')
    event.tick()
    assert not manager.enabled and not h.entered.is_set()


def test_local_retry_error_does_not_mark_server_offline_or_skip_refresh(restart_backend, monkeypatch, caplog):
    h = restart_backend
    replacement = h.restart()
    h.finish.set()
    assert h.managers[0]._sync_ownership.done.wait(TIMEOUT)
    # Opening a directory as a writable lock file is a real OS error on both
    # supported platforms; do not mock contention or ProcessLock.acquire.
    invalid = h.path / 'not-a-lock-file'
    invalid.mkdir()
    replacement.lock.path = invalid
    offline = []
    monkeypatch.setattr(LudoBackend, '_reach', SimpleNamespace(latch_offline=offline.append))
    now = time.monotonic() + 301
    monkeypatch.setattr(backend_mod, 'time', SimpleNamespace(
        **{name: (lambda: now) if name == 'monotonic' else getattr(time, name)
           for name in dir(time)}))
    reads = len(h.collection_reads)
    h.backend._stop_event.tick()
    assert not replacement.enabled and not replacement.blocked_by_other_instance
    assert not offline and h.backend._romm_client.authenticated
    assert len(h.collection_reads) == reads + 1
    assert any('Auto-sync handoff retry failed' in record.message for record in caplog.records)
    assert h.probe().acquired
