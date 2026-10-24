"""Play on a downloaded Wii U game that is a folder.

A Wii U download is unpacked into a folder, which is not a disc set, so the disc
lister finds nothing in it. Pressing Play then said "No launchable file found"
although the .wua/.wux (or an unpacked title's code/*.rpx) was sitting right
there. Found by pressing Play in the real app; a direct launch_game call never
goes through this step.

Run with:  pytest app/tests
"""
from pathlib import Path

import pytest

from ludo_app.backend import LudoBackend
from ludo_app.host import HostProfile

DESKTOP = HostProfile("1.0.0", "-x86_64.AppImage", Path("/tmp/desk-rt"), "desktop")


@pytest.fixture
def backend(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    return LudoBackend(host=DESKTOP)


def make(path: Path, size=1):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'x' * size)
    return path


def test_unpacked_download_boots_its_largest_image(backend, tmp_path):
    folder = tmp_path / 'Terraria'
    make(folder / 'Terraria.wua', 10)
    big = make(folder / 'Terraria.wux', 100)
    make(folder / "Vimm's Lair.txt", 500)
    assert backend._resolve_launch_path(str(folder), None, 'wiiu') == str(big)


def test_unpacked_title_boots_its_rpx(backend, tmp_path):
    title = tmp_path / 'Mario Kart 8'
    rpx = make(title / 'code' / 'Turbo.rpx', 50)
    make(title / 'content' / 'a.bin')
    assert backend._resolve_launch_path(str(title), None, 'wiiu') == str(rpx)


def test_a_single_file_is_still_returned_unchanged(backend, tmp_path):
    wua = make(tmp_path / 'Game.wua')
    assert backend._resolve_launch_path(str(wua), None, 'wiiu') == str(wua)


def test_a_wiiu_folder_with_nothing_launchable_is_still_none(backend, tmp_path):
    empty = tmp_path / 'Empty'
    make(empty / 'notes.txt')
    assert backend._resolve_launch_path(str(empty), None, 'wiiu') is None


async def test_the_disc_picker_offers_nothing_for_a_wiiu_title(backend, tmp_path, monkeypatch):
    title = tmp_path / 'Mario Kart 8'
    make(title / 'code' / 'Turbo.rpx', 50)
    make(title / 'content' / 'a.bin')
    monkeypatch.setattr(backend, '_games_index', lambda: {7: {
        'platform_slug': 'wiiu', 'is_downloaded': True, 'local_path': str(title)}})
    out = await backend.get_local_discs(7)
    assert out == {'success': True, 'discs': [], 'last': ''}


def test_a_download_the_engine_already_unpacked_points_at_its_folder(backend, tmp_path):
    # The engine unpacks a Wii U .7z and removes it before the backend looks, so
    # the path the download was asked for no longer exists. Recording that path
    # made Play fail with "No launchable file found" until a restart.
    folder = tmp_path / 'Terraria (Europe)_wua'
    make(folder / 'Terraria.wua', 10)
    gone = tmp_path / 'Terraria (Europe)_wua.7z'
    assert backend._maybe_unzip_download(gone) == folder


def test_a_missing_archive_with_no_folder_is_left_alone(backend, tmp_path):
    gone = tmp_path / 'Nothing.7z'
    assert backend._maybe_unzip_download(gone) == gone
