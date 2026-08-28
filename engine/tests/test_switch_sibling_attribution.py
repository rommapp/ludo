#!/usr/bin/env python3
"""A Switch sibling is grouped add-on content, not a save-owning ROM.

A base XCI and its update NSP arrive as two RomM entries that the library
groups into one tile (`_sibling_files`). The matcher's variant tiers used to
return the sibling's own id when a save name matched the sibling file —
correct for per-region ROMs, wrong here: the server holds the game's saves
under the MAIN entry, so the sibling attribution looked like "save missing on
server" and re-uploaded a duplicate under the update's id every rebuild.
Saves matched through a Switch sibling must resolve to the parent tile.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import AutoSyncManager  # noqa: E402

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


def main():
    switch_game = {
        'rom_id': 32462, 'name': 'Metroid Dread', 'platform_slug': 'switch',
        'romm_data': {'fs_name_no_ext': 'Metroid Dread', 'platform_slug': 'switch'},
        '_sibling_files': [
            {'id': 32464, 'name': 'Metroid Dread',
             'fs_name': 'Metroid Dread v327680', 'fs_name_no_ext': 'Metroid Dread v327680',
             'fs_extension': 'nsp'},
        ],
    }
    psx_game = {
        'rom_id': 77, 'name': 'Same Game PSX', 'platform_slug': 'psx',
        'romm_data': {'fs_name_no_ext': 'Same Game', 'platform_slug': 'psx'},
        '_sibling_files': [
            {'id': 78, 'name': 'Same Game (Spain)', 'fs_name': 'Same Game (Spain)',
             'fs_name_no_ext': 'Same Game (Spain)', 'fs_extension': 'bin'},
        ],
    }
    games = [switch_game, psx_game]

    m = AutoSyncManager.__new__(AutoSyncManager)
    m.get_games = lambda: games
    m._rom_match_cache = {}
    m._rom_match_games = None
    m._rom_id_for_launch_alias = lambda a, b: None
    m._rom_id_for_title_id = lambda t: None

    # The exact-name tier: a save named after the update NSP (the local file
    # the sigil title-ID index hands to the matcher) must land on the parent.
    check('switch sibling save attributes to the main entry',
          m.find_rom_id_for_save_file(Path('/s/Metroid Dread v327680.srm')), 32462)

    # Region-aware tier: same rule when the sibling carries a region tag.
    region_game = {
        'rom_id': 90, 'name': 'Region Switch', 'platform_slug': 'switch',
        'romm_data': {'fs_name_no_ext': 'Region Switch', 'platform_slug': 'switch'},
        '_sibling_files': [
            {'id': 91, 'name': 'Region Switch (Europe)', 'fs_name': 'Region Switch (Europe)',
             'fs_name_no_ext': 'Region Switch (Europe)', 'fs_extension': 'xci'},
        ],
    }
    m.get_games = lambda: games + [region_game]
    m._rom_match_cache = {}
    m._rom_match_games = None
    check('switch region-tagged sibling still attributes to the main entry',
          m.find_rom_id_for_save_file(Path('/s/Region Switch (Europe).srm')), 90)

    # Non-Switch regional variants keep their own id — they are self-owned
    # ROMs on the server and their saves live under that id.
    check('non-switch region variant keeps its own rom id',
          m.find_rom_id_for_save_file(Path('/s/Same Game (Spain).srm')), 78)

    print('\n' + ('FAIL: ' + ', '.join(FAILURES) if FAILURES else 'all checks passed'))
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
