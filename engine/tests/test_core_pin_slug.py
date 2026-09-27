"""A core pinned for a platform is used when its games launch.

Run with `python3 engine/tests/test_core_pin_slug.py`.

rommapp/ludo#20: pinning Retro8 for PICO-8 still failed with "No suitable core
found for platform: Pico-8". The settings page pins under the RomM slug
('pico'), but a launch resolves from the ROM's folder, which is the ES-DE name
('pico8'), so the pin was never found; and with no pin, nothing guessed Retro8.
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


class Settings:
    def __init__(self, pins):
        self.pins = pins

    def get(self, section, key, default=''):
        return self.pins.get(key, default) if section == 'CoreOverrides' else default


def interface(pins, cores):
    ra = RetroArchInterface.__new__(RetroArchInterface)
    ra.settings = Settings(pins)
    ra.get_available_cores = lambda: {c: f'/cores/{c}_libretro.so' for c in cores}
    ra._retrodeck_core_for_slug = lambda slug, available: None
    ra.platform_core_map = {}
    return ra


def main():
    both = ['retro8', 'fake08']

    ra = interface({'pico': 'fake08'}, both)
    check('pin under RomM slug, launch from ES-DE folder',
          ra.suggest_core_for_platform('PICO-8', system_slug='pico8',
                                       platform_slug='pico')[0], 'fake08')
    check('pin under RomM slug, asked by RomM slug',
          ra.suggest_core_for_platform('PICO-8', system_slug='pico')[0], 'fake08')

    ra = interface({'pico8': 'fake08'}, both)
    check('pin under ES-DE folder, asked by RomM slug',
          ra.get_core_override('pico'), 'fake08')

    ra = interface({}, both)
    check('no pin: PICO-8 guesses Retro8',
          ra.suggest_core_for_platform('PICO-8', system_slug='pico8')[0], 'retro8')
    check('Sega Pico does not guess Retro8',
          ra.suggest_core_for_platform('Sega Pico', system_slug='sega-pico')[0], None)

    # psx holds PocketStation too; a pin for one must not leak onto the other.
    ra = interface({'pocketstation': 'retro8'}, both)
    check('shared folder does not borrow another platform\'s pin',
          ra.suggest_core_for_platform('PlayStation', system_slug='psx',
                                       platform_slug='psx')[0], None)
    check('PocketStation game in the psx folder gets its own pin',
          ra.suggest_core_for_platform('PocketStation', system_slug='psx',
                                       platform_slug='pocketstation')[0], 'retro8')

    print('\nall passed' if not FAILURES else f'\n{len(FAILURES)} FAILED')
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
