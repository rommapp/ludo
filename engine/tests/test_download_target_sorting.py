"""A save downloaded by the background sync lands where RetroArch reads it.

Run with `python3 engine/tests/test_download_target_sorting.py`.

_resolve_download_target used to always file a save under the core's folder
(saves/Genesis Plus GX/). RetroDECK sorts saves by content (saves/genesis/),
which is also where the pre-launch reconcile puts them, so a download left a
second local copy of the slot. Each copy was tied to its own server record and
the two conflicted on every launch. The target must follow the sorting mode.
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import AutoSyncManager  # noqa: E402

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


class _Retro:
    emulator_directory_map = {'genesis_plus_gx': 'Genesis Plus GX'}

    def __init__(self, saves, mode):
        self.save_dirs = {'saves': str(saves)}
        self.mode = mode

    def get_save_subdir_mode(self, save_type='saves'):
        return self.mode

    def convert_to_retroarch_filename(self, name, kind, target_dir, slot=None):
        return sync_core.RetroArchInterface.convert_to_retroarch_filename(
            self, name, kind, target_dir, slot)


def main():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        saves = tmp / 'saves'
        rom = tmp / 'roms' / 'genesis' / 'Mickey Mania (USA).zip'
        rom.parent.mkdir(parents=True)
        rom.write_bytes(b'x')
        games = [{'rom_id': 1, 'platform_slug': 'genesis', 'local_path': str(rom),
                  'file_name': rom.name}]
        op = {'rom_id': 1, 'file_name': 'autosave [2026-10-31_15-10-41].srm',
              'slot': 'autosave', 'emulator': 'genesis_plus_gx'}

        def target(mode):
            m = AutoSyncManager.__new__(AutoSyncManager)
            m.get_games = lambda: games
            m.retroarch = _Retro(saves, mode)
            m._launch_stems = {}
            m._content_dir_for_game = lambda g: None
            m._target_core_dir = lambda base, g, emu, core=None: base / 'Genesis Plus GX'
            return m._resolve_download_target(op, str(saves))

        check('content-sorted: the platform folder, not the core one',
              target('content'), saves / 'genesis' / 'Mickey Mania (USA).srm')
        check('core-sorted: the core folder',
              target('core'), saves / 'Genesis Plus GX' / 'Mickey Mania (USA).srm')
        check('flat: the save root',
              target('flat'), saves / 'Mickey Mania (USA).srm')

    print(f"\n{len(FAILURES)} failure(s)" if FAILURES else "\nall passed")
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
