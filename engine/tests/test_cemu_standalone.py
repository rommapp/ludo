"""Cemu (Wii U) as a standalone emulator, as a flatpak AND as an AppImage.

Run with `python3 engine/tests/test_cemu_standalone.py`.

rommapp/ludo#38. Upstream ships both Flathub's info.cemu.Cemu and
Cemu-<ver>-x86_64.AppImage, so every behaviour is asserted for each.
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import (  # noqa: E402
    RetroArchInterface, STANDALONE_EMULATORS, find_standalone_builds,
    find_standalone_executable, resolve_wiiu_rom,
    standalone_emulator_for_platform)

FAILED = []


def check(name, got, want):
    ok = got == want
    print('ok  ' if ok else 'FAIL', name, '' if ok else f'\n   got  {got!r}\n   want {want!r}')
    if not ok:
        FAILED.append(name)


def touch(path, exec_=False, size=1):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'x' * size)
    if exec_:
        path.chmod(0o755)
    return path


def main():
    spec = STANDALONE_EMULATORS['cemu']
    ra = RetroArchInterface.__new__(RetroArchInterface)

    # --- platform ownership: Wii U is Cemu's, the plain Wii is not ----------
    for name, slug in (('Nintendo Wii U', 'wiiu'), ('Wii U', None),
                       ('Nintendo - Wii U', 'wii-u'), ('x', 'wiiu')):
        got = standalone_emulator_for_platform(name, slug)
        check(f'platform {name!r}/{slug!r} -> cemu', got and got[0], 'cemu')
    for name, slug in (('Nintendo Wii', 'wii'), ('Nintendo GameCube', 'gc'),
                       ('Nintendo Switch', 'switch')):
        got = standalone_emulator_for_platform(name, slug)
        check(f'platform {name!r} is not cemu', bool(got and got[0] == 'cemu'), False)

    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp) / 'home'
        home.mkdir()
        os.environ['HOME'] = str(home)
        installed = set()
        sync_core.flatpak_app_installed = lambda app: app in installed
        sync_core.shutil.which = lambda n: None

        # --- nothing installed ----------------------------------------------
        check('nothing installed', find_standalone_executable('cemu', spec), '')

        # --- AppImage only, upstream's real file name -----------------------
        app = touch(home / 'AppImages' / 'Cemu-2.6-x86_64.AppImage', exec_=True)
        check('appimage found', find_standalone_executable('cemu', spec), str(app))
        builds = find_standalone_builds('cemu', spec)
        check('appimage listed', [(b['kind'], b['label']) for b in builds],
              [('appimage', 'Cemu')])
        touch(home / 'AppImages' / 'ludo.appimage', exec_=True)
        touch(home / 'AppImages' / 'Eden-1.0.AppImage', exec_=True)
        check('other appimages ignored',
              find_standalone_executable('cemu', spec), str(app))
        # Not executable -> not adopted.
        app.chmod(0o644)
        check('non-executable appimage ignored',
              find_standalone_executable('cemu', spec), '')
        app.chmod(0o755)

        # --- flatpak wins over AppImage; both are listed ---------------------
        installed.add('info.cemu.Cemu')
        check('flatpak preferred', find_standalone_executable('cemu', spec),
              'flatpak:info.cemu.Cemu')
        builds = find_standalone_builds('cemu', spec)
        check('both listed', [b['kind'] for b in builds], ['flatpak', 'appimage'])
        check('flatpak is current', [b['current'] for b in builds], [True, False])

        # --- user override picks the AppImage over the flatpak --------------
        class S:
            def get(self, sec, key, default=''):
                return str(app) if (sec, key) == ('Emulators', 'cemu_path') else default
        check('override to appimage',
              find_standalone_executable('cemu', spec, S()), str(app))

        # --- launch argv, for both -------------------------------------------
        game_dir = home / 'Ludo' / 'roms' / 'wiiu'
        wua = touch(game_dir / 'Game Vol. 2 (USA).wua')
        check('appimage argv (dotted name)',
              ra.build_standalone_launch_command(str(wua), 'cemu', spec, str(app)),
              [str(app), '-f', '-g', str(wua)])
        check('flatpak argv (dotted name)',
              ra.build_standalone_launch_command(
                  str(wua), 'cemu', spec, 'flatpak:info.cemu.Cemu'),
              ['flatpak', 'run', f'--filesystem={game_dir}:ro',
               'info.cemu.Cemu', '-f', '-g', str(wua)])

        # --- unpacked title: launch the .rpx, grant the TITLE ROOT -----------
        title = game_dir / 'Mario Kart 8'
        rpx = touch(title / 'code' / 'Turbo.rpx', size=50)
        touch(title / 'code' / 'small.rpx', size=5)
        touch(title / 'code' / 'cos.xml')
        touch(title / 'content' / 'a.bin')
        touch(title / 'meta' / 'meta.xml')
        check('folder -> largest rpx', resolve_wiiu_rom(title), (rpx, title))
        check('rpx path -> title root', resolve_wiiu_rom(rpx), (rpx, title))
        check('appimage argv (folder)',
              ra.build_standalone_launch_command(str(title), 'cemu', spec, str(app)),
              [str(app), '-f', '-g', str(rpx)])
        check('flatpak argv (folder) grants title root, not code/',
              ra.build_standalone_launch_command(
                  str(title), 'cemu', spec, 'flatpak:info.cemu.Cemu'),
              ['flatpak', 'run', f'--filesystem={title}:ro',
               'info.cemu.Cemu', '-f', '-g', str(rpx)])
        check('flatpak argv (rpx path) grants title root',
              ra.build_standalone_launch_command(
                  str(rpx), 'cemu', spec, 'flatpak:info.cemu.Cemu')[2],
              f'--filesystem={title}:ro')

        # --- case-insensitive Code/ and a rootless folder --------------------
        t2 = game_dir / 'Odd'
        rpx2 = touch(t2 / 'Code' / 'GAME.RPX')
        check('Code/ GAME.RPX matched', resolve_wiiu_rom(t2)[0], rpx2)
        empty = game_dir / 'Empty'
        empty.mkdir()
        check('no rpx -> folder itself', resolve_wiiu_rom(empty), (empty, empty))

        # --- Eden is untouched by the new resolver ---------------------------
        nsp = touch(home / 'Ludo' / 'roms' / 'switch' / 'g.nsp')
        check('eden argv unchanged',
              ra.build_standalone_launch_command(
                  str(nsp), 'eden', STANDALONE_EMULATORS['eden'], '/x/eden'),
              ['/x/eden', '-f', '-g', str(nsp)])

    print()
    print('FAILED: ' + ', '.join(FAILED) if FAILED else 'all passed')
    return 1 if FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
