"""RomM's own platform names resolve to the right cores.

Run with `python3 engine/tests/test_core_romm_platform_names.py`.

rommapp/ludo#80: "MSX2", "TurboGrafx-16/PC Engine" and "Turbografx-16/PC Engine
CD" matched neither the exact map nor a keyword, so no core was guessed and the
core picker was empty. "PlayStation 3" matched the generic 'playstation'
keyword and was offered PS1 cores. Steam shortcuts also dropped the slug, so a
pinned core was ignored there.
"""

import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import RetroArchInterface  # noqa: E402

FAILURES = []


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


def candidates(name, slug):
    ra = RetroArchInterface.__new__(RetroArchInterface)
    ra.platform_core_map = {}
    return ra._candidate_cores_for_platform(name, slug)


def main():
    pce = ['beetle_pce_fast', 'mednafen_pce_fast', 'beetle_pce', 'mednafen_pce']
    check('MSX2', candidates('MSX2', 'msx2')[:2], ['bluemsx', 'fmsx'])
    check('PC Engine', candidates('TurboGrafx-16/PC Engine', 'tg16'), pce)
    check('PC Engine CD', candidates('Turbografx-16/PC Engine CD', 'turbografx-cd'), pce)
    check('PS3 gets no PS1 core', candidates('PlayStation 3', 'ps3'), [])
    check('PS1 still resolves', candidates('PlayStation', 'ps')[0], 'pcsx_rearmed')

    # Steam shortcuts pass the slug through, so pins keyed by slug apply.
    seen = []
    mgr = sync_core.SteamShortcutManager.__new__(sync_core.SteamShortcutManager)
    mgr.log = lambda *a: None
    mgr.retroarch = SimpleNamespace(
        retroarch_executable='/usr/bin/retroarch',
        is_retrodeck_installation=lambda: False,
        suggest_core_for_platform=lambda name, system_slug=None, platform_slug=None: (
            seen.append(platform_slug) or ('bluemsx', '/cores/bluemsx_libretro.so')))
    exe, opts = mgr._build_launch_command('/roms/g.rom', 'MSX2', 'msx2')
    check('shortcut passes slug', seen, ['msx2'])
    check('shortcut uses core', '-L "/cores/bluemsx_libretro.so"' in opts, True)
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
