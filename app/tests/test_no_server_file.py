"""#72: RomM can keep a ROM with no file behind it. Say so instead of offering a
download that can only fail."""
from pathlib import Path
from unittest import mock

import pytest

from ludo_app.backend import LudoBackend
from ludo_app.host import HostProfile
from romm_sync_engine.sync_core import ROM_TRIM_FIELDS

DESKTOP = HostProfile("1.0.0", "-x86_64.AppImage", Path("/tmp/desk-rt"), "desktop")
ROW = {'id': 7, 'name': 'Game', 'fs_name': 'Game (Spain).nds', 'platform_slug': 'nds',
       'has_file_on_disk': False}


@pytest.fixture
def b(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    b = LudoBackend(host=DESKTOP)
    b._settings = mock.MagicMock()
    b._settings.get.side_effect = lambda s, k, d=None: str(tmp_path / 'roms') if k == 'rom_directory' else d
    c = mock.MagicMock(authenticated=True, base_url='http://romm.invalid')
    c.ensure_authenticated.return_value = True
    resp = mock.MagicMock(status_code=200)
    resp.json.return_value = dict(ROW, files=[])
    c.session.get.return_value = resp
    b._romm_client = c
    b._romm_collections = [{'id': 1, 'name': 'C'}]
    return b


def test_trim_keeps_the_field():
    assert 'has_file_on_disk' in ROM_TRIM_FIELDS


async def test_collection_row(b):
    b._romm_client.get_collection_roms.return_value = [ROW]
    r = await b.get_library_games('collection', 'C')
    assert r['games'][0]['no_server_file'] is True


async def test_older_server_row_is_not_flagged(b):
    row = {k: v for k, v in ROW.items() if k != 'has_file_on_disk'}
    b._romm_client.get_collection_roms.return_value = [row]
    r = await b.get_library_games('collection', 'C')
    assert 'no_server_file' not in r['games'][0]


async def test_detail(b):
    d = await b.get_game_detail(7)
    assert d['no_server_file'] is True


async def test_download_refused_without_requesting_file(b):
    r = await b.download_game(7)
    assert r['success'] is False and 'no file' in r['message'].lower()
    b._romm_client.download_rom.assert_not_called()


def test_downloaded_copy_is_not_flagged(b):
    s = b._serialize_game({'rom_id': 7, 'name': 'G', 'is_downloaded': True, 'no_server_file': True})
    assert 'no_server_file' not in s


def test_library_entry_flag_is_serialized(b):
    s = b._serialize_game({'rom_id': 7, 'name': 'G', 'is_downloaded': False, 'no_server_file': True})
    assert s['no_server_file'] is True


# A game with a good version must not read as "No file" because of a bad one.
GOOD = {'rom_id': 9, 'name': 'Game', 'platform': 'DS', 'platform_slug': 'nds',
        'is_downloaded': True, 'local_path': '/x', '_region_variant_ids': [7],
        '_sibling_files': [{'id': 7, 'has_file_on_disk': False}]}


async def test_collection_shows_the_playable_version_once(b):
    b._available_games = [GOOD]
    b._romm_client.get_collection_roms.return_value = [ROW, dict(ROW, id=8)]
    b._variant_parent_index = lambda games=None: {7: 9, 8: 9}
    b._games_index = lambda: {9: GOOD}
    games = (await b.get_library_games('collection', 'C'))['games']
    assert [g['rom_id'] for g in games] == [9]
    assert not games[0].get('no_server_file')


async def test_picker_lists_versions_without_a_file(b):
    g = dict(GOOD, sibling_roms=[{'id': 7}, {'id': 6}], is_downloaded=False)
    b._games_index = lambda: {9: g}
    r = await b.get_local_siblings(9)
    assert r['no_file_ids'] == [7]


def test_collection_count_matches_its_tiles(b):
    parent = dict(GOOD, _sibling_files=[{'id': 7, 'has_file_on_disk': False},
                                        {'id': 8, 'has_file_on_disk': False},
                                        {'id': 5, 'has_file_on_disk': True}])
    b._games_index = lambda: {9: parent, 3: {'rom_id': 3}}
    b._variant_parent_index = lambda games=None: {7: 9, 8: 9, 5: 9}
    assert b._collection_tile_count({'rom_ids': [7, 8, 3]}, 3) == 2
    assert b._collection_tile_count({'rom_ids': [5, 3]}, 2) == 2  # a version that works stays
    assert b._collection_tile_count({}, 4) == 4


def test_snapshot_keeps_the_field_on_versions(b):
    slim = b._slim_for_snapshot([{'rom_id': 1, '_sibling_files': [{'id': 2, 'has_file_on_disk': False}]}])
    assert slim[0]['_sibling_files'][0]['has_file_on_disk'] is False


def test_continue_playing_shows_the_playable_version(b):
    played = dict(ROW, rom_user={'last_played': '2026-01-01'})
    b._romm_client.session.get.return_value.json.return_value = {'items': [played]}
    b._variant_parent_index = lambda games=None: {7: 9}
    b._games_index = lambda: {9: GOOD}
    rows = b._fetch_continue_playing()
    assert [r['rom_id'] for r in rows] == [9]
    assert not rows[0].get('no_server_file')


def test_file_of_another_version_counts_as_downloaded(b, tmp_path):
    (tmp_path / 'roms' / 'nds').mkdir(parents=True)
    (tmp_path / 'roms' / 'nds' / 'Old.nds').write_bytes(b'x' * 2048)
    g = {'rom_id': 2, 'file_name': 'New.nds', 'platform_slug': 'nds',
         '_sibling_files': [{'id': 1, 'fs_name': 'Old.nds', 'name': 'Old'}]}
    b._reconcile_downloads([g])
    assert g['is_downloaded'] and g['local_path'].endswith('Old.nds')


def test_folder_boots_the_preferred_region_first(b, tmp_path):
    d = tmp_path / 'G'
    d.mkdir()
    for n in ('G (Italy).nds', 'G (Spain).nds'):
        (d / n).write_bytes(b'x')
    b._romm_client.region_ranks.return_value = {'spain': 0}
    assert b._list_local_discs(str(d))[0]['name'] == 'G (Spain).nds'


def test_collection_count_folds_folder_members(b):
    parent = dict(GOOD, _sibling_files=[], _no_file_variant_ids=[7, 8])
    b._games_index = lambda: {9: parent, 3: {'rom_id': 3}}
    b._variant_parent_index = lambda games=None: {7: 9, 8: 9}
    assert b._collection_tile_count({'rom_ids': [3, 7, 8]}, 3) == 2


async def test_region_order_override(b):
    from romm_sync_engine.sync_core import RomMClient
    saved = {}
    b._settings.set.side_effect = lambda s, k, v: saved.__setitem__(k, v)
    b._settings.get.side_effect = lambda s, k, d=None: saved.get(k, d)
    assert (await b.set_region_order(['Italy', 'Nowhere', 'USA']))['follow'] is False
    assert saved['region_order'] == 'Italy,USA'
    client = RomMClient('http://romm.invalid')
    assert client.region_ranks() == {'italy': 0, 'usa': 1}
    b._romm_client = mock.MagicMock()
    b._romm_client.server_regions.return_value = ['Japan']
    r = await b.get_region_order()
    assert r['order'][:2] == ['Italy', 'USA'] and 'Japan' in r['order'] and len(r['order']) == len(set(r['order']))
    assert (await b.set_region_order([]))['follow'] is True
    r = await b.get_region_order()
    assert r['follow'] and r['order'][0] == 'Japan'
