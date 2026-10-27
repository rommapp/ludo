"""Save states go in the folder RetroArch sorts them into.

Run with `python3 engine/tests/test_state_folder_names.py`.

rommapp/ludo#46: with states sorted by core, RetroArch writes melonDS DS states
to `states/melonDS DS/` (the core's name, `corename` in its .info file). Ludo title-cased the RomM
name into `Melondsds`, filed states there, and its pre-launch reconcile deleted
the copies RetroArch had written.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import RetroArchInterface  # noqa: E402

FAILURES = []


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


def interface(info_dir):
    ra = RetroArchInterface.__new__(RetroArchInterface)
    ra.emulator_directory_map = {'melonds': 'melonDS', 'melondsds': 'melonDS DS',
                                 'melonds_ds': 'melonDS DS', 'beetle_psx_hw': 'Beetle PSX HW'}
    ra.get_retroarch_config_setting = lambda key, default='': str(info_dir) if info_dir else default
    ra.find_retroarch_config_dir = lambda: None
    return ra


def main():
    with tempfile.TemporaryDirectory() as tmp:
        info = Path(tmp)
        (info / 'mupen64plus_next_libretro.info').write_text(
            'display_name = "Nintendo - Nintendo 64 (Mupen64Plus-Next)"\n'
            'corename = "Mupen64Plus-Next"\n')
        (info / 'swanstation_libretro.info').write_text('corename = "SwanStation"\n')

        ra = interface(info)
        check('melondsds (Argosy)', ra.get_retroarch_directory_name('melondsds'), 'melonDS DS')
        check('melonds_ds (Ludo)', ra.get_retroarch_directory_name('melonds_ds'), 'melonDS DS')
        check('melonds stays melonDS', ra.get_retroarch_directory_name('melonds'), 'melonDS')
        check('unmapped core read from .info',
              ra.get_retroarch_directory_name('mupen64plus_next'), 'Mupen64Plus-Next')
        check('.info found without the underscore',
              ra.get_retroarch_directory_name('swan_station'), 'SwanStation')
        check('resolved folder comes back unchanged',
              ra.get_retroarch_directory_name('Beetle PSX HW'), 'Beetle PSX HW')
        check('no .info: old title-case fallback',
              ra.get_retroarch_directory_name('some_core'), 'Some Core')

    ra = interface(None)
    check('no info dir at all', ra.get_retroarch_directory_name('mupen64plus_next'), 'Mupen64plus Next')

    print(f"\n{len(FAILURES)} failure(s)" if FAILURES else "\nall passed")
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
