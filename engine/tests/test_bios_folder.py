"""Which folder BIOS files go to, and a first launch before RetroArch has run.

`python3 engine/tests/test_bios_folder.py`. Runs against a throwaway $HOME.

Two reports. RetroArch set to its own system_directory (EmuDeck's
~/Emulation/bios) got BIOS files in the default folder, where it never looked.
A RetroArch Ludo had just installed had no system/ folder and no retroarch.cfg,
so BIOS downloads failed and the first launch ignored the restored memory card.
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.bios_manager import BiosManager  # noqa: E402
from romm_sync_engine.sync_core import PS2_CORE_NAMES, RetroArchInterface  # noqa: E402

FAILURES = []
FLATPAK = 'org.libretro.RetroArch'


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILURES.append(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")


class Settings:
    def __init__(self):
        self.values = {}

    def get(self, section, key, default=''):
        return self.values.get((section, key), default)

    def set(self, section, key, value):
        self.values[(section, key)] = value


def make_ra(installed=(FLATPAK,)):
    ra = RetroArchInterface.__new__(RetroArchInterface)
    ra.settings = Settings()
    ra._is_retrodeck_cache = None
    ra.is_retrodeck_installation = lambda: False
    ra.retroarch_executable = f'flatpak run {FLATPAK}'
    ra.flatpak_app_installed = lambda app_id: app_id in installed
    return ra


def make_bios(ra):
    bios = BiosManager.__new__(BiosManager)
    bios.retroarch = ra
    bios.settings = ra.settings
    bios.log = lambda msg: None
    bios.romm_client = None
    ra.bios_manager = bios
    return bios


def tree():
    return Path.home() / '.var/app' / FLATPAK / 'config/retroarch'


def write_cfg(text):
    tree().mkdir(parents=True, exist_ok=True)
    (tree() / 'retroarch.cfg').write_text(text)


def in_fresh_home(fn):
    with tempfile.TemporaryDirectory() as home:
        old = os.environ.get('HOME')
        os.environ['HOME'] = home
        try:
            fn()
        finally:
            os.environ['HOME'] = old


def configured_folder_wins():
    custom = Path.home() / 'Emulation/bios'
    (tree() / 'system').mkdir(parents=True)
    custom.mkdir(parents=True)
    write_cfg(f'system_directory = "~/Emulation/bios"\n')
    bios = make_bios(make_ra())
    check('system_directory wins over the default folder',
          bios.find_system_directory(), custom)


def placeholder_keeps_default():
    (tree() / 'system').mkdir(parents=True)
    write_cfg('system_directory = "default"\n')
    bios = make_bios(make_ra())
    check('"default" means the default folder',
          bios.find_system_directory(), tree() / 'system')


def ludo_setting_still_first():
    mine = Path.home() / 'mine'
    write_cfg('system_directory = "~/Emulation/bios"\n')
    ra = make_ra()
    ra.settings.set('BIOS', 'custom_path', str(mine))
    check('a folder chosen in Ludo wins', make_bios(ra).find_system_directory(), mine)


def saved_default_yields():
    custom = Path.home() / 'Emulation/bios'
    write_cfg('system_directory = "~/Emulation/bios"\n')
    ra = make_ra()
    ra.settings.set('BIOS', 'custom_path', str(tree() / 'system'))
    check('the default saved by setup yields to RetroArch',
          make_bios(ra).find_system_directory(), custom)


def fresh_install_gets_system():
    (tree() / 'saves').mkdir(parents=True)
    bios = make_bios(make_ra())
    check('fresh install: system/ is used', bios.find_system_directory(), tree() / 'system')
    check('fresh install: system/ is created', (tree() / 'system').is_dir(), True)


def selected_install_first():
    (Path.home() / '.config/retroarch/system').mkdir(parents=True)
    (tree() / 'system').mkdir(parents=True)
    bios = make_bios(make_ra())
    check('the selected emulator beats a leftover native folder',
          bios.find_system_directory(), tree() / 'system')


def late_download_finds_folder():
    ra = make_ra()
    ra.retroarch_executable = ''
    bios = make_bios(ra)
    bios.system_dir = None
    bios.installed_bios = {}
    ra.retroarch_executable = f'flatpak run {FLATPAK}'
    (tree() / 'saves').mkdir(parents=True)
    check('a manager made before the install looks again',
          bios.ensure_system_directory(), tree() / 'system')


def first_launch_prepared():
    (tree() / 'saves').mkdir(parents=True)
    ra = make_ra()
    check('still no config dir', ra.find_retroarch_config_dir(), None)
    check('per-game options go in the install tree',
          ra._ps2_option_files('/roms/Game.chd'),
          [tree() / 'config' / n / 'Game.opt' for n in PS2_CORE_NAMES])
    check('saves are filed for content sorting', ra.get_save_subdir_mode('saves'), 'content')
    overlay = Path(ra._launch_overlay_config(None)).read_text()
    check('overlay turns core sorting off', 'sort_savefiles_enable = "false"' in overlay, True)
    check('overlay turns content sorting on',
          'sort_savefiles_by_content_enable = "true"' in overlay, True)
    check('no retroarch.cfg was created', (tree() / 'retroarch.cfg').exists(), False)


def later_launches_use_config():
    write_cfg('sort_savefiles_enable = "true"\n')
    ra = make_ra()
    overlay = Path(ra._launch_overlay_config(None)).read_text()
    check('a real config needs no sorting overlay', 'sort_savefiles' in overlay, False)
    check('a real config is still read', ra.get_save_subdir_mode('saves'), 'core')


def main():
    for fn in (configured_folder_wins, placeholder_keeps_default, ludo_setting_still_first,
               saved_default_yields,
               fresh_install_gets_system, selected_install_first, late_download_finds_folder,
               first_launch_prepared, later_launches_use_config):
        try:
            in_fresh_home(fn)
        except Exception as e:
            check(f'{fn.__name__} raised', repr(e), None)
    print(f"\n{len(FAILURES)} failure(s)")
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
