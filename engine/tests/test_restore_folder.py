"""Restoring a version puts it where a sync would have.

Run with `python3 engine/tests/test_restore_folder.py`.

From rommapp/ludo#46: with RetroArch sorting saves by content, a save with no
copy on disk yet landed in the save root (saves/) instead of the game's
content folder (saves/nds/), where RetroArch never reads it. Restoring a
version from the game page still guessed that way; pre-launch sync already
knew the content folder. Both now ask AutoSyncManager._download_dir.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import AutoSyncManager, RetroArchInterface  # noqa: E402

FAILURES = []


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


def retro(base, mode):
    ra = RetroArchInterface.__new__(RetroArchInterface)
    ra.save_dirs = {'saves': str(base / 'saves'), 'states': str(base / 'states')}
    ra.get_save_subdir_mode = lambda kind: mode
    ra.get_save_files = lambda: {'saves': [], 'states': []}
    ra.emulator_directory_map = {'melondsds': 'melonDS DS', 'melonds_ds': 'melonDS DS'}
    ra.get_retroarch_config_setting = lambda key, default='': default
    ra.find_retroarch_config_dir = lambda: None
    return ra


def manager(ra, content_dir=None):
    m = AutoSyncManager.__new__(AutoSyncManager)
    m.retroarch = ra
    m.log = lambda *a, **k: None
    m._content_dir_for_game = lambda game: content_dir
    m._target_core_dir = lambda base, game, emu, core=None: (
        Path(base) / ra.get_retroarch_directory_name(core or emu))
    return m


def main():
    game = {'rom_id': 1, 'platform_slug': 'nds', 'file_name': 'Chrono Trigger (USA) (En,Fr).zip'}
    entry = {'file_name': 'Chrono Trigger (USA) (En,Fr) [2026-10-01_10-00-00].srm',
             'emulator': 'melondsds'}
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        saves, states = base / 'saves', base / 'states'

        ra = retro(base, 'content')
        m = manager(ra)
        d = m._download_dir('saves', game, 'melondsds')
        check('content mode, flat ROM: the platform folder', d, saves / 'nds')
        check('restore with no local copy follows it',
              ra.resolve_restore_dest(None, entry, 'saves', default_dir=d)[0], saves / 'nds')
        check('restore without the hint (old behaviour) uses the root',
              ra.resolve_restore_dest(None, entry, 'saves')[0], saves)

        m = manager(ra, content_dir='Pokémon HeartGold Version')
        check('content mode, foldered ROM: its own folder',
              m._download_dir('saves', game, 'melondsds'), saves / 'Pokémon HeartGold Version')

        ra = retro(base, 'core')
        m = manager(ra)
        check('core mode: the core folder',
              m._download_dir('states', game, 'melondsds'), states / 'melonDS DS')

        ra = retro(base, 'flat')
        check('flat mode: the root', manager(ra)._download_dir('saves', game, 'melondsds'), saves)

        ra = retro(base, 'content')
        ra.get_save_files = lambda: {'saves': [{'name': 'Chrono Trigger (USA) (En,Fr).srm',
                                                'path': str(base / 'elsewhere' / 'Chrono Trigger (USA) (En,Fr).srm')}],
                                     'states': []}
        check('a copy on disk still wins over the hint',
              ra.resolve_restore_dest(None, entry, 'saves', default_dir=saves / 'nds')[0],
              base / 'elsewhere')

    print(f"\n{len(FAILURES)} failure(s)" if FAILURES else "\nall passed")
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
