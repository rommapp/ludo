#!/usr/bin/env python3
"""A game deleted on RomM but kept locally must stop syncing its saves.

The matcher used to attribute a save to ANY library entry, including ones the
server stopped returning (`is_orphan`). The upload then 404s — every sync,
forever, because nothing retired the pairing. The fix has two sides, both
asserted here:

  * attribution skips orphans (rom_id_for_save returns None for them), so the
    inventory never offers the save to the server again;
  * cleanup still needs the pairing (deleting a removed game's local data
    must take its saves too), so find_rom_id_for_save_file(include_orphans=True)
    re-admits them.
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
    games = [
        {'rom_id': 12831, 'name': 'Removed Game',
         'is_orphan': True,
         'romm_data': {'fs_name_no_ext': 'Removed Game (Europe)',
                       'name': 'Removed Game', 'platform_slug': 'psx'}},
        {'rom_id': 42, 'name': 'Live Game',
         'romm_data': {'fs_name_no_ext': 'Live Game (Europe)',
                       'name': 'Live Game', 'platform_slug': 'psx'}},
    ]

    m = AutoSyncManager.__new__(AutoSyncManager)
    m.get_games = lambda: games
    m._rom_match_cache = {}
    m._rom_match_games = None
    m._rom_id_for_launch_alias = lambda a, b: None
    m._rom_id_for_title_id = lambda t: None

    orphan_save = Path('/saves/Removed Game (Europe).srm')
    live_save = Path('/saves/Live Game (Europe).srm')

    check('a live game still attributes its save',
          m.rom_id_for_save(live_save), 42)
    check('an orphaned game does not',
          m.rom_id_for_save(orphan_save), None)
    check('cleanup re-admits the orphan pairing',
          m.find_rom_id_for_save_file(orphan_save, include_orphans=True), 12831)

    # A launch alias recorded before the deletion could still hand the id back
    # (in-session only); the guard in rom_id_for_save is what retires it.
    m._rom_match_cache.clear()
    m._rom_id_for_launch_alias = lambda a, b: 12831
    check('a launch alias to an orphaned rom is retired',
          m.rom_id_for_save(orphan_save), None)

    # save_paths_for_rom is cleanup's finder: it must see the orphan's save and
    # nobody else's.
    m._rom_id_for_launch_alias = lambda a, b: None
    m.retroarch = type('R', (), {'get_save_files': lambda self: {
        'saves': [{'path': str(orphan_save)},
                  {'path': str(live_save)}]}})()
    got = {str(p) for p in m.save_paths_for_rom(12831)}
    check('save_paths_for_rom finds exactly the orphaned save',
          got, {str(orphan_save)})

    print('FAILURES:', FAILURES if FAILURES else 'none')
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
