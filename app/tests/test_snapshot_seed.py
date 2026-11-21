"""A new profile starts from another profile's library snapshot of the same
server instead of walking the whole library again; collections stay out (they
are per RomM user)."""
import json

from ludo_app import backend as be

URL = 'https://romm.example'


def _snap(path, url=URL, fetched='2026-11-01T00:00:00', schema=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        'schema': schema or be.SNAPSHOT_SCHEMA, 'server_url': url, 'fetched_at': fetched,
        'games': [{'id': 1}], 'collections': [{'id': 9}],
    }))


def _setup(monkeypatch, tmp_path, ids):
    dirs = {i: tmp_path / i for i in ids}
    monkeypatch.setattr(be._paths, 'profile_dir', lambda i: dirs[i])
    monkeypatch.setattr(be._profiles, 'load', lambda: {'profiles': [{'id': i} for i in ids]})
    monkeypatch.setattr(be, 'snapshot_file', dirs[ids[-1]] / 'library_snapshot.json')
    return dirs


def test_newest_matching_sibling_wins(monkeypatch, tmp_path):
    d = _setup(monkeypatch, tmp_path, ['default', 'p-a', 'p-new'])
    _snap(d['default'] / 'library_snapshot.json', fetched='2026-11-01')
    _snap(d['p-a'] / 'library_snapshot.json', fetched='2026-11-05')
    assert be._seed_snapshot(URL)['fetched_at'] == '2026-11-05'


def test_other_server_or_schema_is_ignored(monkeypatch, tmp_path):
    d = _setup(monkeypatch, tmp_path, ['default', 'p-a', 'p-new'])
    _snap(d['default'] / 'library_snapshot.json', url='https://other')
    _snap(d['p-a'] / 'library_snapshot.json', schema=-1)
    assert be._seed_snapshot(URL) is None
    assert be._seed_snapshot('') is None


def test_hydrate_seeds_games_but_not_collections(monkeypatch, tmp_path):
    d = _setup(monkeypatch, tmp_path, ['default', 'p-new'])
    _snap(d['default'] / 'library_snapshot.json')
    from pathlib import Path
    from ludo_app.host import HostProfile
    monkeypatch.setenv('HOME', str(tmp_path))
    b = be.LudoBackend(host=HostProfile('1.0.0', '-x86_64.AppImage', Path('/tmp/desk-rt'), 'desktop'))
    calls = {}
    monkeypatch.setattr(be, '_seed_snapshot', lambda url: calls.setdefault('url', url) and json.loads(
        (d['default'] / 'library_snapshot.json').read_text()))
    from unittest import mock
    b._settings = mock.MagicMock()
    b._settings.get.side_effect = lambda s, k, dflt=None: URL if k == 'url' else dflt
    for attr in ('_absorb_variant_entries', '_reconcile_downloads'):
        setattr(b, attr, lambda *a, **k: None)
    b._hydrate_from_snapshot()
    assert calls['url'] == URL
    assert b._available_games == [{'id': 1}]
    assert b._snapshot_fetched_at == '2026-11-01T00:00:00'
    assert b._romm_collections is None
