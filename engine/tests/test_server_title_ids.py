"""A save pairs with a game the server identified, downloaded here or not.

Run with `python3 engine/tests/test_server_title_ids.py`.

RomM 5.3.0 reads a game's native identity out of the binary during its scan and
stores `title_id` and `save_target` on the ROM. That is the only source for a
game whose ID appears nowhere in its filename — a PS2 serial, a GameCube ID, a
plainly-named Switch dump — and, unlike reading the file, it answers for ROMs
this device has never downloaded. _rom_id_for_title_id consults it first.

These lock in that tier, the case folding every source needs (RomM writes
`save_target` lowercase where the emulator creates the directory lowercase;
Eden's is whatever is on disk; a GameCube ID is uppercase), the update/DLC fold
onto the base title that owns the save, and the precedence rule: a filename tag
does not overwrite what the server read out of the binary.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import AutoSyncManager  # noqa: E402

FAILURES = []


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


class _NoSettings:
    """No ROM directory configured, so the local-file tier is a no-op."""

    def get(self, *a, **kw):
        return ''


def manager(games):
    mgr = AutoSyncManager.__new__(AutoSyncManager)
    mgr._title_id_index = None
    mgr.settings = _NoSettings()
    mgr.get_games = lambda: games
    # Reached only by the local-file tier, which has no directory to walk.
    mgr.find_rom_id_for_save_file = lambda path: None
    return mgr


def main():
    key = AutoSyncManager._title_id_key
    check("case folded", key('gale01'), 'GALE01')
    check("whitespace stripped", key('  SLUS-20946 '), 'SLUS-20946')
    check("empty is nothing", key(''), None)
    check("none is nothing", key(None), None)
    # An update or add-on names the same game; the save lives under the base.
    check("update folds to base",
          key('0100152000022800'), '0100152000022000')
    check("base is itself",
          key('0100152000022000'), '0100152000022000')

    mgr = manager([
        # A GameCube disc: the ID is in the header, never in the name.
        {'rom_id': 11, 'romm_data': {'fs_name': 'Melee.iso',
                                     'title_id': 'GALE01'}},
        # RomM stores save_target in the case the emulator writes.
        {'rom_id': 22, 'romm_data': {'fs_name': 'Zelda.wbfs',
                                     'title_id': '0001000248414641',
                                     'save_target': '0001000248414641'.lower()}},
        # A plainly-named Switch dump the server read the ID out of.
        {'rom_id': 33, 'romm_data': {'fs_name': 'Some Game.nsp',
                                     'title_id': '0100152000022000'}},
        {'rom_id': 44, 'romm_data': {'fs_name': 'No Identity.sfc'}},
    ])

    check("gamecube id matches", mgr._rom_id_for_title_id('GALE01'), 11)
    check("gci header case matches", mgr._rom_id_for_title_id('gale01'), 11)
    check("save_target matches its own case",
          mgr._rom_id_for_title_id('0001000248414641'), 22)
    check("plain switch dump matches",
          mgr._rom_id_for_title_id('0100152000022000'), 33)
    # Eden files a save under the base title even when the library holds the
    # update; and the directory's case on disk is not ours to assume.
    check("switch update id resolves to the base rom",
          mgr._rom_id_for_title_id('0100152000022800'), 33)
    check("lowercase switch dir matches",
          mgr._rom_id_for_title_id('0100152000022000'.lower()), 33)
    check("unknown id matches nothing",
          mgr._rom_id_for_title_id('ZZZZ99'), None)
    check("unidentified rom indexed under nothing",
          44 in (mgr._title_id_index or {}).values(), False)

    # A filename tag is a guess next to a value read from the binary: where
    # both speak, the server's wins.
    mgr2 = manager([
        {'rom_id': 1, 'romm_data': {'fs_name': 'Game [0100152000022000].nsp',
                                    'title_id': '0100152000022000'}},
        {'rom_id': 2, 'romm_data': {'fs_name': 'Mislabelled [0100152000022000].nsp'}},
    ])
    check("server identity beats a filename tag",
          mgr2._rom_id_for_title_id('0100152000022000'), 1)

    # Pre-5.3.0 servers send neither field, and the filename tier still works.
    mgr3 = manager([
        {'rom_id': 7, 'romm_data': {'fs_name': 'Game [0100152000022800].nsp'}},
    ])
    check("filename tier intact without server ids",
          mgr3._rom_id_for_title_id('0100152000022000'), 7)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all server title-ID checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
