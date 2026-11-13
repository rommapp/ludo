"""Wii .7z downloads (#65) and single-disc playlists (#61).

Run with:  pytest app/tests
"""
import zipfile
from pathlib import Path

import pytest

from ludo_app.backend import LudoBackend, _detect_multi_disc
from ludo_app.host import HostProfile

DESKTOP = HostProfile("1.0.0", "-x86_64.AppImage", Path("/tmp/desk-rt"), "desktop")


@pytest.fixture
def backend(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    return LudoBackend(host=DESKTOP)


def touch(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'x')
    return path


def wii_zip(path):
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('Game.wbfs', b'x')
    return path


def test_single_disc_skips_the_playlist(backend, tmp_path):
    cue = touch(tmp_path / 'G' / 'G.cue')
    touch(tmp_path / 'G' / 'G.bin')
    touch(tmp_path / 'G' / 'G.m3u')
    assert backend._resolve_launch_path(str(tmp_path / 'G')) == str(cue)
    assert _detect_multi_disc(tmp_path / 'G', True) == (False, 0)


def test_two_discs_keep_the_playlist(backend, tmp_path):
    touch(tmp_path / 'G' / 'a.cue')
    touch(tmp_path / 'G' / 'b.cue')
    m3u = touch(tmp_path / 'G' / 'G.m3u')
    assert backend._resolve_launch_path(str(tmp_path / 'G')) == str(m3u)


def test_wii_archive_is_unpacked_on_download(backend, tmp_path):
    out = backend._maybe_unzip_download(wii_zip(tmp_path / 'Game.zip'))
    assert out == tmp_path / 'Game'
    assert (out / 'Game.wbfs').is_file() and not (tmp_path / 'Game.zip').exists()


async def test_existing_archive_is_unpacked_at_play(backend, tmp_path):
    archive = wii_zip(tmp_path / 'Game.zip')
    g = {'rom_id': 1, 'local_path': str(archive), 'platform_slug': 'wii'}
    path, why = await backend._ready_to_boot(g, str(archive))
    assert why is None and path == str(tmp_path / 'Game' / 'Game.wbfs')
    assert g['local_path'] == str(tmp_path / 'Game')


async def test_hand_unpacked_sibling_is_used(backend, tmp_path):
    archive = wii_zip(tmp_path / 'Game.zip')
    wbfs = touch(tmp_path / 'Game.wbfs')
    path, why = await backend._ready_to_boot({'rom_id': 1}, str(archive))
    assert why is None and path == str(wbfs) and archive.exists()


def test_archive_beside_its_unpacked_game_is_not_a_second_game(backend, tmp_path):
    wbfs = touch(tmp_path / 'G' / 'G.wbfs')
    touch(tmp_path / 'G' / 'G.7z')
    assert backend._resolve_launch_path(str(tmp_path / 'G')) == str(wbfs)


async def test_cartridge_archive_stays_zipped(backend, tmp_path):
    archive = tmp_path / 'Game.zip'
    with zipfile.ZipFile(archive, 'w') as z:
        z.writestr('Game.sfc', b'x')
    path, why = await backend._ready_to_boot({'rom_id': 1}, str(archive))
    assert why is None and path == str(archive) and archive.exists()
