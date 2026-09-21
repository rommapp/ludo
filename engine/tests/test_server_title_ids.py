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
    # Case folds, and a 6-character disc id drops its maker code — see the
    # GameCube checks below.
    check("case folded", key('slus-20946'), 'SLUS-20946')
    check("whitespace stripped", key('  SLUS-20946 '), 'SLUS-20946')
    check("psx serial untouched", key('SLES-02896'), 'SLES-02896')
    check("empty is nothing", key(''), None)
    check("none is nothing", key(None), None)
    # An update or add-on names the same game; the save lives under the base.
    check("update folds to base",
          key('0100152000022800'), '0100152000022000')
    check("base is itself",
          key('0100152000022000'), '0100152000022000')

    # GameCube and Wii: RomM stores the four-byte game code as hex, a disc
    # header and a Dolphin .gci give it as ASCII plus the two-character maker
    # code. Both have to land on one key or a .gci never finds its game.
    check("server hex folds to the game code", key('47503750'), 'GP7P')
    check("disc/gci ascii folds to the same key", key('GP7P01'), 'GP7P')
    check("hex and ascii agree", key('47503750') == key('gp7p01'), True)
    # Distinct ids stay distinct: the hex decode is reversible, and only the
    # maker code is dropped.
    check("different games stay apart", key('47414C45') == key('47503750'), False)
    # A 16-hex Switch id is not a GameCube id and must not be decoded as one.
    check("switch id untouched by the gamecube fold",
          key('0100152000022000'), '0100152000022000')
    # Hex that decodes to something unprintable is left alone rather than
    # mangled into replacement characters.
    check("non-ascii hex left alone", key('00FF00FF'), '00FF00FF')

    # Dreamcast: RomM stores the IP.BIN product number space-padded, flycast
    # writes the same value with underscores in a VMU's name.
    check("dreamcast padding folded", key('T1401D  50'), 'T1401D 50')
    check("flycast underscores fold the same way",
          key('T1401D__50'), 'T1401D 50')
    check("disc and vmu agree", key('T1401D  50') == key('T1401D__50'), True)

    mgr = manager([
        # A GameCube disc as RomM 5.3.0 actually stores it: the game code
        # in hex. The save that has to find it is a .gci, whose header spells
        # the same code in ASCII with a maker code after it.
        {'rom_id': 11, 'romm_data': {'fs_name': 'Melee.iso',
                                     'title_id': '47414C45',
                                     'save_target': '47414C45'}},
        # RomM stores save_target in the case the emulator writes.
        {'rom_id': 22, 'romm_data': {'fs_name': 'Zelda.wbfs',
                                     'title_id': '0001000248414641',
                                     'save_target': '0001000248414641'.lower()}},
        # A plainly-named Switch dump the server read the ID out of.
        {'rom_id': 33, 'romm_data': {'fs_name': 'Some Game.nsp',
                                     'title_id': '0100152000022000'}},
        {'rom_id': 44, 'romm_data': {'fs_name': 'No Identity.sfc'}},
    ])

    check("gci header id matches the server's hex",
          mgr._rom_id_for_title_id('GALE01'), 11)
    check("gci header case ignored", mgr._rom_id_for_title_id('gale01'), 11)
    check("a locally-read hex id matches too",
          mgr._rom_id_for_title_id('47414C45'), 11)
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

    # A flycast VMU is named from the disc header and nothing else — not the
    # ROM's filename, and its folder is the platform. The server's id is what
    # lets it be attributed without having watched the launch that wrote it.
    dc = manager([
        {'rom_id': 55, 'romm_data': {'fs_name': 'Soulcalibur (Europe).chd',
                                     'title_id': 'T1401D  50',
                                     'save_target': 'T1401D  50'}},
    ])
    check("vmu name resolves to its game",
          dc._rom_id_for_title_id('T1401D__50'), 55)

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
