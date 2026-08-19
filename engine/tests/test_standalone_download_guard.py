"""A standalone emulator's save must never be restored down RetroArch's path.

Run with `python3 engine/tests/test_standalone_download_guard.py`.

Eden's saves restore through _restore_standalone_save, which unpacks into
Eden's own tree after backing up what is there. What must never happen is one
reaching RetroArch's download path instead: the packed zip would land in the
RetroArch save root under a converted name, be counted as downloaded, and be
recorded as in-sync -- leaving Eden without the save and the failure invisible.

These lock in that _resolve_download_target refuses standalone emulators (so
the restore path is the only way one can be written) and still resolves
RetroArch's own saves exactly as before.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import AutoSyncManager  # noqa: E402

FAILURES = []


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


class _FakeRetroArch:
    emulator_directory_map = {'snes9x': 'Snes9x'}

    def convert_to_retroarch_filename(self, name, kind, target_dir, slot):
        return name


def main():
    mgr = AutoSyncManager.__new__(AutoSyncManager)
    mgr.retroarch = _FakeRetroArch()
    saves = tempfile.mkdtemp()

    def resolve(emulator, file_name='game.srm'):
        return mgr._resolve_download_target(
            {'emulator': emulator, 'file_name': file_name}, saves)

    # Every casing the server might report, since RomM stores what the client
    # sent and our own inventory sends 'Eden'.
    for emu in ('Eden', 'eden', 'EDEN', ' Eden '):
        check(f"standalone refused: {emu!r}",
              resolve(emu, '0100152000022000.zip'), None)

    check("standalone flagged", mgr._is_standalone_emulator('Eden'), True)
    check("retroarch not flagged", mgr._is_standalone_emulator('RetroArch'), False)
    check("no emulator not flagged", mgr._is_standalone_emulator(None), False)

    # RetroArch saves keep resolving exactly as before.
    check("retroarch save at the save root",
          resolve('RetroArch'), Path(saves) / 'game.srm')
    check("known core gets its subdirectory",
          resolve('Snes9x'), Path(saves) / 'Snes9x' / 'game.srm')
    check("no emulator falls back to the root",
          resolve(None), Path(saves) / 'game.srm')

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all standalone download-guard checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
