"""An emulator path that is a Flatpak launcher maps to the app's own config.

`python3 engine/tests/test_flatpak_launcher_path.py`. Runs against a throwaway $HOME.

Picking ~/.local/share/flatpak/exports/bin/org.libretro.RetroArch (or the
/var/lib/flatpak one) as the emulator path made Ludo treat exports/bin as
RetroArch's config folder. The per-launch overlay landed there, outside the
sandbox, so RetroArch failed to append it and lost the BIOS folder and network
commands on every launch.
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import RetroArchInterface  # noqa: E402

FAILURES = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILURES.append(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")


class Settings(dict):
    def get(self, section, key, default=''):
        return dict.get(self, (section, key), default)


def make_ra(custom_path):
    ra = RetroArchInterface.__new__(RetroArchInterface)
    ra.settings = Settings({('RetroArch', 'custom_path'): str(custom_path)})
    ra._is_retrodeck_cache = None
    ra.is_retrodeck_installation = lambda: False
    ra.retroarch_executable = str(custom_path)
    ra.flatpak_app_installed = lambda app_id: True
    return ra


def launcher(root, app_id):
    p = root / 'exports/bin' / app_id
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text('#!/bin/sh\n')
    return p


def main():
    with tempfile.TemporaryDirectory() as home:
        old = os.environ.get('HOME')
        os.environ['HOME'] = home
        try:
            h = Path(home)
            for app_id in ('org.libretro.RetroArch', 'net.retrodeck.retrodeck'):
                cfg = h / '.var/app' / app_id / 'config/retroarch'
                cfg.mkdir(parents=True)
                (cfg / 'retroarch.cfg').write_text('')
                for label, root in (('user', h / '.local/share/flatpak'),
                                    ('system', h / 'var-lib-flatpak')):
                    ra = make_ra(launcher(root, app_id))
                    check(f'{app_id} {label} launcher: config dir',
                          ra.find_retroarch_config_dir(), cfg)
                    overlay = ra._launch_overlay_config(None)
                    check(f'{app_id} {label} launcher: overlay inside the app',
                          Path(overlay).parent if overlay else None, cfg)
            # A plain binary still uses its own folder.
            native = h / 'apps/RetroArch'
            native.mkdir(parents=True)
            (native / 'retroarch').write_text('')
            check('native binary keeps its folder',
                  make_ra(native / 'retroarch').find_retroarch_config_dir(), native)
        finally:
            if old is not None:
                os.environ['HOME'] = old
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
