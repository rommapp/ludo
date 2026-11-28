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


def arcade_zip(path):
    with zipfile.ZipFile(path, 'w') as z:
        for name in ('c-2j.bp', 'c-2k.bp', 'v-5e.bpr', 'l-4m.bp'):
            z.writestr(name, b'x')
    return path


async def test_arcade_romset_launches_zipped(backend, tmp_path):
    # #99: a multi-file arcade romset is kept zipped, so Play must not then
    # refuse it as an archive it "could not unpack".
    archive = arcade_zip(tmp_path / 'dkong.zip')
    g = {'rom_id': 1, 'local_path': str(archive), 'platform_slug': 'fbneo'}
    path, why = await backend._ready_to_boot(g, str(archive))
    assert why is None and path == str(archive) and archive.is_file()


def test_arcade_download_stays_zipped_with_a_slug(backend, tmp_path):
    archive = arcade_zip(tmp_path / 'dkong.zip')
    assert backend._maybe_unzip_download(archive, 5, 'fbneo') == archive
    assert archive.is_file() and not (tmp_path / 'dkong').exists()


def test_arcade_variant_download_finds_its_slug(backend, tmp_path):
    # #98: a regional sibling's rom_id is not a key in the grouped library,
    # so the slug has to come through its parent.
    backend._available_games = [{'rom_id': 1, 'platform_slug': 'fbneo',
                                 'sibling_roms': [{'id': 7}]}]
    backend._games_index_cache = None
    archive = arcade_zip(tmp_path / 'dkong.zip')
    assert backend._maybe_unzip_download(archive, 7) == archive
    assert archive.is_file()


# Apotris 4.0.2's GBA release zip: the game, a base ROM for the build scripts,
# Linux/Windows tools and audio samples. Ludo unpacks it (two .gba), and the
# folder used to boot whatever sorted first: tools/ape.aarch64.
APOTRIS = ['Apotris.gba', 'README.txt', 'LINUX_or_MAC_build.sh', 'WINDOWS_build.bat',
           'tools/Apotris-base.gba', 'tools/ape.aarch64', 'tools/ape.x86_64',
           'tools/gbfs.exe', 'tools/buildSoundbank.py', 'audio/clear.wav',
           'audio/MENU_a_menu.it', 'audio/GAME_b_oh_my_god.mod', 'license/LICENSE.zlib.txt']


def apotris(root):
    for name in APOTRIS:
        touch(root / name)
    return root


def test_homebrew_kit_boots_the_platforms_rom(backend, tmp_path):
    game = apotris(tmp_path / 'roms' / 'gba' / 'Apotris')
    want = str(game / 'Apotris.gba')
    assert backend._resolve_launch_path(str(game), platform_slug='gba') == want
    # The platform read off the download folder when the caller has none.
    assert backend._resolve_launch_path(str(game)) == want
    # One game, so no version picker on the tile.
    assert _detect_multi_disc(game, True) == (False, 1)


@pytest.mark.parametrize('platform_slug', ['switch', None], ids=['explicit', 'inferred'])
def test_switch_folder_boots_nested_base_beside_top_level_update(backend, tmp_path,
                                                              platform_slug, monkeypatch):
    monkeypatch.setattr(backend, '_prod_keys', lambda: None)
    folder = tmp_path / 'roms' / 'switch' / 'Game'
    touch(folder / 'Update [0100152000022800][v65536].nsp')
    base = touch(folder / 'Base' / 'Game [0100152000022000].nsp')
    if platform_slug:
        got = backend._resolve_launch_path(str(folder), platform_slug=platform_slug)
    else:
        got = backend._resolve_launch_path(str(folder))
    assert got == str(base)


def test_regional_variants_still_offer_a_pick(backend, tmp_path):
    folder = tmp_path / 'roms' / 'gba' / 'Pokemon'
    touch(folder / 'Pokemon (USA).gba')
    touch(folder / 'Pokemon (Europe).gba')
    touch(folder / 'notes.txt')
    assert _detect_multi_disc(folder, True) == (True, 2)
