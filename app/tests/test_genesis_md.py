"""Mega Drive / Genesis ROMs named .md are games, not Markdown manuals.

rommapp/ludo#27: .md is in _NON_GAME_EXTS so a manual beside a ROM is
skipped, but it is also the standard Mega Drive dump extension. A folder or
archive holding only .md files then had no launchable file at all.

Run with:  pytest app/tests
"""
import zipfile
from pathlib import Path

from ludo_app.backend import LudoBackend, _list_standalone_games


def _touch(folder, *names):
    for n in names:
        (folder / n).write_bytes(b'x')


def _names(games):
    return [g.name for g in games]


def test_folder_of_md_roms_is_games(tmp_path):
    _touch(tmp_path, 'Sonic (USA).md', 'Sonic (Europe).md', 'Sonic.m3u')
    assert _names(_list_standalone_games(tmp_path)) == [
        'Sonic (Europe).md', 'Sonic (USA).md']


def test_md_beside_another_rom_is_a_manual(tmp_path):
    _touch(tmp_path, 'Game.sfc', 'README.md')
    assert _names(_list_standalone_games(tmp_path)) == ['Game.sfc']


def test_folder_with_only_aux_files_has_no_games(tmp_path):
    _touch(tmp_path, 'cover.png', 'notes.txt')
    assert _list_standalone_games(tmp_path) == []


def _needs_extract(tmp_path, members):
    archive = tmp_path / 'game.zip'
    with zipfile.ZipFile(archive, 'w') as z:
        for m in members:
            z.writestr(m, b'x')
    return LudoBackend._archive_needs_extract(LudoBackend, archive)


def test_zip_of_regional_md_roms_is_extracted(tmp_path):
    assert _needs_extract(tmp_path, ['Sonic (USA).md', 'Sonic (Europe).md'])


def test_zip_of_one_md_rom_stays_zipped(tmp_path):
    assert not _needs_extract(tmp_path, ['Sonic (USA).md'])


def test_zip_of_rom_plus_md_manual_stays_zipped(tmp_path):
    assert not _needs_extract(tmp_path, ['Game.sfc', 'README.md'])
