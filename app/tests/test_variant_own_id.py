"""#70: a regional variant opened by its own ROM id (collection, Continue
playing) must find the file recorded on its parent."""
from pathlib import Path
from unittest import mock

import pytest

from ludo_app.backend import LudoBackend
from ludo_app.host import HostProfile

DESKTOP = HostProfile("1.0.0", "-x86_64.AppImage", Path("/tmp/desk-rt"), "desktop")

PARENT, VARIANT = 100, 101


@pytest.fixture
def b(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    rom = tmp_path / 'gbc' / 'Game (France).gbc'
    rom.parent.mkdir()
    rom.write_bytes(b'x' * 4096)
    b = LudoBackend(host=DESKTOP)
    b._retroarch = mock.MagicMock()
    b._retroarch._gamescope_running.return_value = True
    b._available_games = [{
        'rom_id': PARENT, 'name': 'Game (USA)', 'file_name': 'Game (USA).gbc',
        'platform': 'Game Boy Color', 'platform_slug': 'gbc',
        'is_downloaded': False, 'local_path': None,
        'sibling_roms': [{'id': VARIANT, 'name': 'Game (France)'}],
        '_variant_downloads': {VARIANT: {
            'name': 'Game (France)', 'file_name': rom.name, 'local_path': str(rom)}},
    }]
    b._retroarch.build_launch_command.return_value = (['retroarch', str(rom)], None)
    b._retroarch.launch_game.return_value = (True, 'ok')
    b._ready_to_boot = mock.AsyncMock(side_effect=lambda g, path: (path, None))
    b._core_gap = lambda *a: {}
    b._bios_gap = lambda *a: None
    b._pre_launch_sync = mock.AsyncMock(return_value='core')
    b._rom = rom
    return b


def client(rows=None, detail=None):
    c = mock.MagicMock()
    c.authenticated = True
    c.base_url = 'http://romm.invalid'
    c.ensure_authenticated.return_value = True
    resp = mock.MagicMock(status_code=200)
    resp.json.return_value = detail if detail is not None else {'items': rows or []}
    c.session.get.return_value = resp
    return c


def booted(b):
    return b._retroarch.build_launch_command.call_args.args[0]


async def test_prepare_steam_launch_by_variant_id(b):
    await b.prepare_steam_launch(VARIANT)
    assert booted(b) == b._rom


async def test_prepare_steam_launch_from_grid_still_works(b):
    await b.prepare_steam_launch(PARENT, sibling_rom_id=VARIANT)
    assert booted(b) == b._rom


async def test_launch_game_by_variant_id_offline(b):
    b._romm_client = None
    await b.launch_game(VARIANT)
    assert b._retroarch.launch_game.call_args.args[0] == b._rom


def test_continue_playing_shows_variant_downloaded(b):
    b._romm_client = client(rows=[{
        'id': VARIANT, 'name': 'Game (France)', 'platform_slug': 'gbc',
        'rom_user': {'last_played': '2026-11-01T00:00:00Z'}}])
    rows = b._fetch_continue_playing()
    assert [(r['rom_id'], r['is_downloaded']) for r in rows] == [(VARIANT, True)]


async def test_detail_shows_variant_downloaded(b):
    b._romm_client = client(detail={
        'id': VARIANT, 'name': 'Game (France)', 'platform_slug': 'gbc',
        'files': [{'id': 1, 'file_name': b._rom.name}]})
    d = await b.get_game_detail(VARIANT)
    assert d['success'] and d['is_downloaded'] is True


async def test_variant_not_on_disk_stays_not_downloaded(b):
    b._rom.unlink()
    r = await b.prepare_steam_launch(VARIANT)
    assert r.get('message') == 'Game not downloaded'
    b._retroarch.build_launch_command.assert_not_called()
