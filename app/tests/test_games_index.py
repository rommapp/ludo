"""Cached index invariants through library refresh, download and account paths."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest

from ludo_app import backend as backend_mod
from ludo_app.backend import LudoBackend


class CountedGames(list):
    def __init__(self, games):
        super().__init__(games)
        self.walks = 0

    def __iter__(self):
        self.walks += 1
        return super().__iter__()


def stub_covers(b):
    """No mocks recording calls or cache entries retaining measured allocations."""
    counts = dict(memory=0, thumb=0, raw=0, http=0, output=0)

    def memory(key):
        counts['memory'] += 1

    def disk(key):
        counts['thumb'] += 1

    def raw(key):
        counts['raw'] += 1
        return None, None

    def get(url, timeout):
        rid = int(url.rsplit('/', 1)[1].split('.')[0])
        assert url == f"https://index.invalid/covers/{rid}.png" and timeout == 20
        counts['http'] += 1
        return SimpleNamespace(status_code=200, content=b'image',
                               headers={'content-type': 'image/png'})

    def store(ck, key, content, mime, large):
        assert key == f"covt2:{ck[0]}:{large}"
        assert content == b'image' and mime == 'image/png' and not large
        counts['output'] += 1
        return 'data:image/png;base64,aW1hZ2U='

    b._cover_cache_get = memory
    b._disk_cover_get = disk
    b._disk_cover_get_bytes = raw
    b._store_thumb = store
    b._trace_cover = lambda *args: None
    b._cover_paths = {}
    b._romm_client = SimpleNamespace(authenticated=True, base_url='https://index.invalid',
                                     session=SimpleNamespace(get=get))
    return counts


class Settings:
    def __init__(self, directory):
        self.values = {('Download', 'rom_directory'): str(directory),
                       ('RomM', 'url'): 'https://index.invalid'}

    def get(self, section, key, default=''):
        return self.values.get((section, key), default)

    def set(self, section, key, value):
        self.values[section, key] = value


@pytest.fixture
def backend(monkeypatch, tmp_path):
    b = LudoBackend()
    b._available_games = []
    b._settings = Settings(tmp_path)
    b._library_busy = False
    b._library_platform_totals = {}
    b._library_platform_marks = {}
    b._last_full_fetch_time = None
    b._download_progress = {}
    b._download_cancels = set()
    b._auto_sync = None
    b._bios_tracking = None
    monkeypatch.setattr(b, '_persist_snapshot', lambda: None)
    monkeypatch.setattr(b, '_persist_snapshot_throttled', lambda: None)
    monkeypatch.setattr(b, '_stamp_full_refresh', lambda: None)
    monkeypatch.setattr(backend_mod, '_record_activity', lambda *a, **k: None)
    monkeypatch.setattr(backend_mod, 'snapshot_file', tmp_path / 'snapshot.json')
    return b


def row(rid, name=None):
    return dict(id=rid, name=name or f'Game {rid}', fs_name=f'{rid}.rom',
                platform_id=7, platform_slug='nes', path_cover_small=f'/covers/{rid}.png')


def test_cached_map_preserves_legacy_keys_duplicates_and_live_references(backend):
    first, last = dict(rom_id=3, name='old'), dict(rom_id=3, name='new')
    games = CountedGames([{}, {'rom_id': None}, {'rom_id': 0},
                          {'rom_id': ''}, first, {'rom_id': '3'}, last])
    backend._available_games = games
    idx = backend._games_index()
    assert set(idx) == {3, '3'}
    assert idx[3] is last
    for _ in range(20):
        assert backend._games_index() is idx
    assert games.walks == 1
    last['local_path'] = '/new/download.rom'
    last['is_downloaded'] = True
    assert backend._games_index()[3]['local_path'] == '/new/download.rom'
    assert backend._games_index()[3]['is_downloaded'] is True
    assert games.walks == 1


def test_empty_replacement_append_and_instances_are_isolated(backend):
    other = LudoBackend()
    other._available_games = [{'rom_id': 99}]
    backend._available_games = CountedGames([{'rom_id': 1}])
    old = backend._games_index()
    backend._available_games = CountedGames([{'rom_id': 2}])
    assert set(backend._games_index()) == {2}
    assert backend._available_games.walks == 1
    backend._append_available_game({'rom_id': 3})
    assert set(backend._games_index()) == {2, 3}
    assert set(old) == {1}  # Already handed-out maps are never cleared in place.
    backend._available_games = CountedGames([])
    empty = backend._games_index()
    assert backend._games_index() is empty and empty == {}
    assert backend._available_games.walks == 0  # Empty list needs no walk.
    assert set(other._games_index()) == {99}
    assert backend._games_lock is not other._games_lock


async def test_full_and_incremental_refresh_publish_current_index(backend, monkeypatch, tmp_path):
    calls = []
    rows = [row(2), row(3)]

    def get_roms(**kwargs):
        calls.append(kwargs)
        return rows[:], len(rows)

    backend._romm_client = SimpleNamespace(
        authenticated=True, get_collections=lambda **k: [], get_roms=get_roms,
        count_roms=lambda: 2, last_fetch_incomplete=False)
    monkeypatch.setattr(backend, '_probe_platform_baselines', lambda: {7: 2})
    monkeypatch.setattr(backend, '_disabled_platforms', lambda: set())
    monkeypatch.setattr(backend, '_reconcile_platforms', lambda **k: {
        'checked': 1, 'walked': [], 'incomplete': False,
        'added': 0, 'removed': 0, 'updated': 0})

    async def status():
        return {'message': 'Ready'}

    monkeypatch.setattr(backend, 'get_service_status', status)
    # Only the filesystem boundary is stubbed; real _game_entry + merge run.
    monkeypatch.setattr(backend_mod, '_resolve_download_path',
                        lambda directory, slug, name: (tmp_path / name, False))
    backend._available_games = [{'rom_id': 1}]
    old = backend._games_index()
    assert (await backend.refresh_from_romm(force_full_refresh=True))['success']
    full = backend._games_index()
    assert set(full) == {2, 3} and set(old) == {1}
    assert full[2]['cover_path'] == '/covers/2.png'
    assert 'updated_after' not in calls[0]
    rows[:] = [row(2, 'Renamed'), row(4)]
    assert (await backend.refresh_from_romm())['success']
    incremental = backend._games_index()
    assert set(incremental) == {2, 3, 4}
    assert incremental[2]['display_name'] == 'Renamed'
    assert incremental[3] is full[3]
    assert calls[1]['updated_after']
    assert backend._forget_deleted_rom(3)
    assert set(backend._games_index()) == {2, 4}


def write_snapshot(path, games, url='https://index.invalid'):
    path.write_text(json.dumps(dict(schema=backend_mod.SNAPSHOT_SCHEMA,
                                   server_url=url, fetched_at='2026-01-01', games=games)))


def test_hydration_prepares_variants_and_download_state_before_publication(backend, monkeypatch):
    old = {'rom_id': 1}
    backend._available_games = [old]
    old_index = backend._games_index()
    write_snapshot(backend_mod.snapshot_file, [
        {'rom_id': 2, 'sibling_roms': [{'id': 3}]}, {'rom_id': 3}])
    reached, release = threading.Event(), threading.Event()

    def reconcile(games):
        assert [g['rom_id'] for g in games] == [2]  # Real absorption ran first.
        reached.set()
        assert release.wait(5)
        games[0]['is_downloaded'] = True
        games[0]['local_path'] = '/stub/2.rom'

    monkeypatch.setattr(backend, '_reconcile_downloads', reconcile)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(backend._hydrate_from_snapshot)
        try:
            assert reached.wait(5)
            assert backend._games_index() is old_index
            assert backend._available_games == [old]
        finally:
            release.set()
        assert future.result(timeout=5) == '2026-01-01'
    idx = backend._games_index()
    assert set(idx) == {2}
    assert idx[2]['is_downloaded'] and idx[2]['local_path'] == '/stub/2.rom'
    assert backend._variant_parent_index() == {3: 2}


async def test_logout_clears_index_and_hydration_rejects_wrong_server(backend, monkeypatch):
    monkeypatch.setattr(backend_mod, 'SYNC_CORE_AVAILABLE', True)
    monkeypatch.setattr(backend_mod, 'SettingsManager', lambda: backend._settings)
    monkeypatch.setattr(backend_mod, 'load_decky_settings', lambda: {})
    monkeypatch.setattr(backend_mod, 'save_decky_settings', lambda data: None)
    monkeypatch.setattr(backend, '_stop_sync', lambda: None)
    monkeypatch.setattr(backend, '_resume_finish', lambda: None)
    monkeypatch.setattr(backend, '_reconcile_downloads', lambda games: None)
    backend._available_games = [{'rom_id': 1}]
    prior = backend._games_index()
    assert (await backend.logout())['success']
    assert backend._games_index() == {} and set(prior) == {1}
    write_snapshot(backend_mod.snapshot_file, [{'rom_id': 1}])
    backend._settings.set('RomM', 'url', 'https://other.invalid')
    assert backend._hydrate_from_snapshot() is None
    assert backend_mod.snapshot_file.exists()  # Rejected, not deleted by hydration.
    assert backend._games_index() == {}
    write_snapshot(backend_mod.snapshot_file, [{'rom_id': 1, 'name': 'Other server'}],
                   url='https://other.invalid')
    assert backend._hydrate_from_snapshot() == '2026-01-01'
    assert backend._games_index()[1]['name'] == 'Other server'


@pytest.mark.parametrize('changed_server', [True, False])
async def test_save_config_server_boundary_with_warm_populated_library(
        backend, monkeypatch, changed_server):
    monkeypatch.setattr(backend_mod, 'SYNC_CORE_AVAILABLE', True)
    monkeypatch.setattr(backend_mod, 'SettingsManager', lambda: backend._settings)
    monkeypatch.setattr(backend_mod, 'load_decky_settings', lambda: {})
    monkeypatch.setattr(backend_mod, 'save_decky_settings', lambda data: None)
    monkeypatch.setattr(backend_mod.time, 'sleep', lambda seconds: None)
    monkeypatch.setattr(backend, '_resume_finish', lambda: None)
    monkeypatch.setattr(backend, '_reconcile_downloads', lambda games: None)
    games = CountedGames([{'rom_id': 1, 'name': 'Old server'}, {'rom_id': 2}])
    backend._available_games = games
    prior = backend._games_index()
    write_snapshot(backend_mod.snapshot_file, list(games))
    walks = games.walks
    events = []

    def stop():
        events.append('stop')
        assert backend._games_index() is prior
        assert backend_mod.snapshot_file.exists()

    def start():
        events.append('start')
        # The boundary must already be applied before sync can read the library.
        if changed_server:
            assert backend._games_index() == {}
            assert backend._available_games == []
            assert not backend_mod.snapshot_file.exists()
        else:
            assert backend._games_index() is prior
            assert backend._available_games is games
            assert backend_mod.snapshot_file.exists()

    monkeypatch.setattr(backend, '_stop_sync', stop)
    monkeypatch.setattr(backend, '_start_sync', start)
    url = 'https://other.invalid' if changed_server else 'https://index.invalid'
    assert (await backend.save_config(f'  {url}/  ', 'user', 'secret',
                                      '', '', ''))['success']
    assert events == ['stop', 'start']
    assert backend._settings.get('RomM', 'url') == url
    assert set(prior) == {1, 2} and prior[1]['name'] == 'Old server'
    assert games.walks == walks
    if changed_server:
        # A later response/snapshot may reuse an ID for an entirely other game.
        write_snapshot(backend_mod.snapshot_file,
                       [{'rom_id': 1, 'name': 'New server'}, {'rom_id': 3}], url=url)
        assert backend._hydrate_from_snapshot() == '2026-01-01'
        current = backend._games_index()
        assert set(current) == {1, 3}
        assert current[1]['name'] == 'New server'
        assert current[1] is not prior[1]
    else:
        assert backend._games_index() is prior


@pytest.mark.parametrize('update', ['replace', 'append'])
def test_concurrent_build_and_update_never_leave_stale_or_partial_map(backend, update):
    reached, release, updating = threading.Event(), threading.Event(), threading.Event()

    class PausedGames(CountedGames):
        def __iter__(self):
            for index, game in enumerate(super().__iter__()):
                yield game
                if index == 0:
                    reached.set()
                    assert release.wait(5)

    backend._available_games = PausedGames([{'rom_id': 1}, {'rom_id': 2}])

    def write():
        updating.set()
        if update == 'replace':
            backend._available_games = [{'rom_id': 3}, {'rom_id': 4}]
        else:
            backend._append_available_game({'rom_id': 3})
        return backend._games_index()

    with ThreadPoolExecutor(max_workers=3) as pool:
        first = pool.submit(backend._games_index)
        try:
            assert reached.wait(5)
            writer = pool.submit(write)
            assert updating.wait(5)
            reader = pool.submit(backend._games_index)
        finally:
            release.set()
        before = first.result(timeout=5)
        after = writer.result(timeout=5)
        concurrent = reader.result(timeout=5)
    expected = {3, 4} if update == 'replace' else {1, 2, 3}
    assert set(before) == {1, 2}
    assert set(after) == expected
    assert set(concurrent) in ({1, 2}, expected)
    assert backend._games_index() is after
    assert set(before) == {1, 2}


async def test_concurrent_uncached_cover_series_builds_once_per_generation(backend):
    games = CountedGames([dict(rom_id=i, cover_path=f'/covers/{i}.png')
                          for i in range(1, 31)])
    backend._available_games = games
    counts = stub_covers(backend)
    result = await asyncio.gather(*(backend.get_game_cover(i) for i in range(1, 31)))
    assert all(r == {'success': True, 'data_uri': 'data:image/png;base64,aW1hZ2U='}
               for r in result)
    assert games.walks == 1
    assert counts == dict(memory=60, thumb=30, raw=30, http=30, output=30)
    replacement = CountedGames([dict(rom_id=i, cover_path=f'/covers/{i}.png')
                                for i in range(1, 31)])
    backend._available_games = replacement
    for i in range(1, 31):
        assert backend._get_game_cover_blocking(i)['success']
    assert replacement.walks == 1
    assert counts == dict(memory=90, thumb=60, raw=60, http=60, output=60)


@pytest.mark.parametrize('kind', ['new', 'existing', 'variant'])
async def test_real_download_worker_updates_current_library(backend, monkeypatch, tmp_path, kind):
    target = 3 if kind != 'existing' else 1
    parent = dict(rom_id=1, name='Parent', platform_slug='nes', file_name='1.rom',
                  sibling_roms=[{'id': 3}] if kind == 'variant' else [])
    backend._available_games = [parent]
    before = backend._games_index()
    finished = threading.Event()
    real_thread = threading.Thread
    threads = []

    def thread(*args, **kwargs):
        worker = kwargs.pop('target')

        def run():
            try:
                worker()
            finally:
                finished.set()

        t = real_thread(*args, target=run, **kwargs)
        threads.append(t)
        return t

    monkeypatch.setattr(backend_mod.threading, 'Thread', thread)
    monkeypatch.setattr(backend_mod, '_resolve_download_path',
                        lambda directory, slug, name: (tmp_path / name, False))
    monkeypatch.setattr(backend, '_maybe_unzip_download', lambda dest, rid: dest)
    monkeypatch.setattr(backend, '_maybe_decompress_switch', lambda dest, rid: dest)
    monkeypatch.setattr(backend, '_handle_switch_add_ons', lambda *a: None)

    def detail(url, timeout):
        assert url == f'https://index.invalid/api/roms/{target}' and timeout == 15
        return SimpleNamespace(status_code=200, json=lambda: row(target))

    backend._romm_client = SimpleNamespace(
        authenticated=True, base_url='https://index.invalid',
        session=SimpleNamespace(get=detail), download_rom=lambda *a, **k: (True, 'ok'))
    assert (await backend.download_game(target))['success']
    assert finished.wait(5)
    for t in threads:
        t.join(timeout=5)
    assert backend._download_progress[target]['state'] == 'done'
    idx = backend._games_index()
    if kind == 'variant':
        assert set(idx) == {1}
        assert backend._variant_downloads(idx[1])[3]['local_path'] == str(tmp_path / '3.rom')
    else:
        assert idx[target]['is_downloaded']
        assert idx[target]['local_path'] == str(tmp_path / f'{target}.rom')
        assert set(idx) == ({1, 3} if kind == 'new' else {1})
    if kind == 'new':
        assert set(before) == {1}
    else:
        assert idx[1] is parent


async def test_delete_game_keeps_cached_parent_and_updates_live_download_state(
        backend, monkeypatch, tmp_path):
    main, variant = tmp_path / 'main.rom', tmp_path / 'variant.rom'
    main.write_bytes(b'main')
    variant.write_bytes(b'variant')
    parent = dict(rom_id=1, name='Parent', is_downloaded=True, local_path=str(main),
                  _variant_downloads={'3': {'local_path': str(variant)}})
    games = CountedGames([parent])
    backend._available_games = games
    idx = backend._games_index()
    saves = []
    monkeypatch.setattr(backend, '_delete_saves_for_rom',
                        lambda rid: saves.append(rid) or 0)

    assert await backend.delete_game(1) == {
        'success': True, 'message': 'Deleted', 'deleted_saves': 0}
    assert not main.exists() and not variant.exists()
    assert saves == [1]
    assert backend._games_index() is idx
    assert idx[1] is parent and set(idx) == {1}
    assert parent['is_downloaded'] is False and parent['local_path'] is None
    assert '_variant_downloads' not in parent
    assert backend._variant_downloads(idx[1]) == {}
    assert games.walks == 1


async def test_delete_orphan_moves_files_and_invalidates_membership(backend, monkeypatch, tmp_path):
    monkeypatch.setattr(backend_mod, 'CONFIG_DIR', tmp_path / 'config')
    main, variant = tmp_path / 'main.rom', tmp_path / 'variant.rom'
    main.write_bytes(b'main')
    variant.write_bytes(b'variant')
    backend._available_games = [
        dict(rom_id=1, name='Orphan', is_orphan=True, is_downloaded=True,
             local_path=str(main), _variant_downloads={'3': {'local_path': str(variant)}}),
        {'rom_id': 2, 'name': 'Still present'},
    ]
    before = backend._games_index()
    result = await backend.delete_orphan_game(1)
    assert result['success'] and result['moved'] == 2
    trash = Path(result['trash'])
    assert trash.parent == tmp_path / 'config' / 'trash'
    assert (trash / main.name).read_bytes() == b'main'
    assert (trash / variant.name).read_bytes() == b'variant'
    assert not main.exists() and not variant.exists()
    after = backend._games_index()
    assert after is not before and set(after) == {2}
    assert after[2] is before[2]
    assert set(before) == {1, 2}


async def test_launch_local_discovery_appends_and_invalidates_cached_index(
        backend, tmp_path):
    local = tmp_path / 'nes' / '3.rom'
    local.parent.mkdir()
    local.write_bytes(b'R' * 2048)
    games = CountedGames([{'rom_id': 1, 'name': 'Existing'}])
    backend._available_games = games
    before = backend._games_index()
    requests = []

    def detail(url, timeout):
        assert url == 'https://index.invalid/api/roms/3' and timeout == 15
        requests.append(url)
        return SimpleNamespace(status_code=200, json=lambda: row(3))

    backend._romm_client = SimpleNamespace(
        base_url='https://index.invalid', session=SimpleNamespace(get=detail))
    backend._retroarch = None
    assert await backend.launch_game(3) == {
        'success': False, 'message': 'RetroArch not available'}
    assert len(requests) == 1
    walks_after_launch = games.walks
    after = backend._games_index()
    assert set(after) == {1, 3} and set(before) == {1}
    assert after[1] is before[1]
    assert after[3]['is_downloaded'] is True
    assert after[3]['local_path'] == str(local)
    assert after[3]['file_name'] == '3.rom'
    assert backend._games_index() is after
    assert games.walks == walks_after_launch + 1
