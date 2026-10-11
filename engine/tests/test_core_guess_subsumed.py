"""A PS2 or PSP game is never guessed onto a PS1 core.

Run with `python3 engine/tests/test_core_guess_subsumed.py`.

rommapp/ludo#36: with no PS2/PSP core installed, the keyword fallback matched
the generic 'playstation' inside "PlayStation 2" / "PlayStation Portable" and
launched the game on SwanStation.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import RetroArchInterface  # noqa: E402

FAILURES = []


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


def guess(platform, cores):
    ra = RetroArchInterface.__new__(RetroArchInterface)
    ra.platform_core_map = {}
    available = {c: f'/cores/{c}_libretro.so' for c in cores}
    return ra._guess_core_for_platform(platform, available)[0]


def main():
    psx = ['swanstation', 'pcsx_rearmed']
    check('PS2 without a PS2 core', guess('PlayStation 2', psx), None)
    check('PSP without a PSP core', guess('PlayStation Portable', psx), None)
    check('PSP with ppsspp', guess('PlayStation Portable', psx + ['ppsspp']), 'ppsspp')
    check('PS2 with pcsx2', guess('Sony PlayStation 2', psx + ['pcsx2']), 'pcsx2')
    check('PS1 still guessed', guess('Sony PlayStation', psx), 'pcsx_rearmed')
    check('SNES not NES', guess('Super Nintendo (SNES)', ['nestopia', 'snes9x']), 'snes9x')
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
