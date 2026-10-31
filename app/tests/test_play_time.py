"""The Play time RPCs: one game, one total, wherever it is shown.

A launch can be a regional or disc variant with its own rom_id; its sessions
must count for the game the library shows, and deleting that game's records
must take the variants' with them.

Run with:  pytest app/tests
"""
from pathlib import Path

import asyncio
import pytest

from ludo_app.backend import LudoBackend
from ludo_app.host import HostProfile
from romm_sync_engine.play_sessions import PlaySessions

DESKTOP = HostProfile("1.0.0", "-x86_64.AppImage", Path("/tmp/desk-rt"), "desktop")
PARENT, VARIANT, OTHER = 10, 11, 20


@pytest.fixture
def backend(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    b = LudoBackend(host=DESKTOP)
    b._settings = type("S", (), {"get": lambda self, *a: 'dev'})()
    ps = PlaySessions(tmp_path / 'ps.json', lambda: None, lambda: 'dev', clock=lambda: 10**9)
    for rom, start, secs in ((PARENT, 1000, 600), (VARIANT, 5000, 1200), (OTHER, 9000, 300)):
        ps.store.add_local(rom, start, start + secs, secs * 1000, 'dev')
    b._auto_sync = type("A", (), {"play_sessions": ps})()
    b._available_games = [
        {'rom_id': PARENT, 'display_name': 'Zelda', 'platform_slug': 'ngc', 'platform': 'GameCube'},
        {'rom_id': OTHER, 'display_name': 'Tetris', 'platform_slug': 'gb', 'platform': 'Game Boy'},
    ]
    monkeypatch.setattr(b, "_variant_parent_index", lambda games=None: {VARIANT: PARENT})
    return b


def run(coro):
    return asyncio.run(coro)


def test_variant_counts_for_its_game(backend):
    g = run(backend.get_game_play_time(PARENT))
    assert g['played'] and g['total_ms'] == 1_800_000 and g['sessions'] == 2
    page = run(backend.get_play_time())
    assert [(x['name'], x['ms']) for x in page['games']] == [('Zelda', 1_800_000), ('Tetris', 300_000)]
    assert page['platforms'][0]['name'] == 'GameCube'


def test_most_played(backend):
    r = run(backend.get_most_played(5))
    assert [(g['rom_id'], g['ms']) for g in r['games']] == [(PARENT, 1_800_000), (OTHER, 300_000)]
    # The game comes along, for a Home that hasn't loaded its platform.
    assert [g['game']['rom_id'] for g in r['games']] == [PARENT, OTHER]


def test_most_played_can_be_hidden(backend):
    assert run(backend.get_play_time())['most_played_home'] is True
    assert run(backend.set_most_played_home(False)) == {'success': True}
    assert run(backend.get_most_played(5))['games'] == []
    assert run(backend.get_play_time())['most_played_home'] is False
    run(backend.set_most_played_home(True))
    assert len(run(backend.get_most_played(5))['games']) == 2


def test_unplayed_game(backend):
    assert run(backend.get_game_play_time(999)) == {'success': True, 'played': False}


def test_delete_takes_the_variants(backend):
    r = run(backend.play_time_delete_game(PARENT))
    assert r == {'success': True, 'removed': 2}
    assert run(backend.get_game_play_time(PARENT))['played'] is False
    assert run(backend.get_game_play_time(OTHER))['played'] is True


def test_offline_actions_say_so(backend):
    assert run(backend.play_time_upload()) == {'success': False, 'message': 'Connect to RomM to upload'}
    assert run(backend.play_time_refresh()) == {'success': False, 'message': 'Connect to RomM to refresh'}
