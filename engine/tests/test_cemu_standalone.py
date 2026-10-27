"""Cemu (Wii U) as a standalone emulator, as a flatpak AND as an AppImage.

Run with `python3 engine/tests/test_cemu_standalone.py`.

rommapp/ludo#38. Upstream ships both Flathub's info.cemu.Cemu and
Cemu-<ver>-x86_64.AppImage, so every behaviour is asserted for each.
"""

import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import (  # noqa: E402
    RetroArchInterface, STANDALONE_EMULATORS, find_standalone_builds,
    _extract_wiiu_archive, _find_7z, find_standalone_executable,
    resolve_wiiu_rom,
    standalone_emulator_for_platform)

FAILED = []
# main() stubs shutil.which and HOME for the whole run; the .7z case needs the real ones.
_REAL_WHICH = shutil.which
_REAL_HOME = os.environ.get('HOME', '')


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
        os.environ['XDG_CONFIG_HOME'] = str(home / '.config')
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

        # --- folder game with disc images at the top: largest wins (Argosy) --
        t3 = game_dir / 'Terraria'
        small = touch(t3 / 'Terraria.wua', size=10)
        big = touch(t3 / 'Terraria.wux', size=100)
        touch(t3 / 'readme.txt', size=1000)
        check('folder with wua+wux -> largest image', resolve_wiiu_rom(t3), (big, t3))
        big.unlink()
        check('folder with only wua -> the wua', resolve_wiiu_rom(t3), (small, t3))

        # --- a downloaded .zip/.7z is always unpacked (Argosy: always-extract) --
        import subprocess
        import zipfile
        src = Path(tmp) / 'src'
        touch(src / 'Terraria.wua', size=10)
        touch(src / 'Terraria.wux', size=100)
        touch(src / 'Terraria.nfo')
        touch(src / 'cover.jpg')
        touch(src / 'notes.txt')
        archives = []
        zpath = game_dir / 'Zipped.zip'
        with zipfile.ZipFile(zpath, 'w') as zf:
            for f in sorted(src.iterdir()):
                zf.write(f, f.name)
        archives.append(zpath)
        stub_which, stub_home = sync_core.shutil.which, os.environ['HOME']
        sync_core.shutil.which, os.environ['HOME'] = _REAL_WHICH, _REAL_HOME
        exe7 = _find_7z()
        if exe7:
            spath = game_dir / 'Sevenzipped.7z'
            subprocess.run([exe7, 'a', str(spath), *map(str, sorted(src.iterdir()))],
                           check=True, capture_output=True)
            archives.append(spath)
        else:
            print('skip  .7z case: no 7z binary on this machine')
        for arc in archives:
            ok, why = _extract_wiiu_archive(arc)
            folder = arc.parent / arc.stem
            check(f'{arc.suffix} unpacked ok', (ok, why), (True, ''))
            check(f'{arc.suffix} archive removed', arc.exists(), False)
            check(f'{arc.suffix} companions pruned, rest kept',
                  sorted(p.name for p in folder.iterdir()),
                  ['Terraria.wua', 'Terraria.wux', 'notes.txt'])
            check(f'{arc.suffix} launches the largest image',
                  resolve_wiiu_rom(folder), (folder / 'Terraria.wux', folder))
        sync_core.shutil.which, os.environ['HOME'] = stub_which, stub_home
        bad = game_dir / 'Broken.zip'
        bad.write_bytes(b'not an archive')
        ok, _ = _extract_wiiu_archive(bad)
        check('corrupt archive reports failure', ok, False)
        check('corrupt archive left in place', bad.exists(), True)

        # --- launch preparation must not rewrite Cemu's audio settings -------
        def audio(cfg_dir, exe, device, label):
            cfg_dir.mkdir(parents=True, exist_ok=True)
            f = cfg_dir / 'settings.xml'
            original = (f'<Audio>\r\n<TVDevice>{device}</TVDevice>\r\n</Audio>\r\n'
                        ).encode('utf-8')
            f.write_bytes(original)
            ra.build_standalone_launch_command(str(home / 'g.wua'), 'cemu', spec, exe)
            check(f'{label}: {device} settings unchanged', f.read_bytes(), original)
            backup = cfg_dir / 'settings.xml.bak-ludo-audio'
            check(f'{label}: {device} no audio backup', backup.exists(), False)
            # Keep cases independent even when running against the old rewrite.
            if backup.exists():
                backup.unlink()
        for label, exe, cfg_dir, xdg in (
                ('flatpak', 'flatpak:info.cemu.Cemu',
                 home / '.var/app/info.cemu.Cemu/config/Cemu', home / '.config'),
                ('appimage', str(app), home / '.config/Cemu', None),
                ('native XDG', '/usr/bin/cemu', home / 'xdg/Cemu', home / 'xdg')):
            if xdg is None:
                os.environ.pop('XDG_CONFIG_HOME', None)
            else:
                os.environ['XDG_CONFIG_HOME'] = str(xdg)
            for device in ('default', 'alsa_x'):
                audio(cfg_dir, exe, device, label)

        # --- beta.23 blanked the device; its backup puts 'default' back once --
        def repair(cfg_dir, exe, device, label):
            cfg_dir.mkdir(parents=True, exist_ok=True)
            f = cfg_dir / 'settings.xml'
            backup = cfg_dir / 'settings.xml.bak-ludo-audio'
            f.write_bytes(f'<Audio>\r\n<TVDevice>{device}</TVDevice>\r\n</Audio>\r\n'.encode())
            backup.write_bytes(b'<Audio>\r\n<TVDevice>default</TVDevice>\r\n</Audio>\r\n')
            ra.build_standalone_launch_command(str(home / 'g.wua'), 'cemu', spec, exe)
            check(f'{label}: backup removed after repair', backup.exists(), False)
            return f.read_bytes()
        os.environ['XDG_CONFIG_HOME'] = str(home / '.config')
        fp = home / '.var/app/info.cemu.Cemu/config/Cemu'
        check('flatpak: blanked device restored, CRLF kept',
              repair(fp, 'flatpak:info.cemu.Cemu', '', 'flatpak'),
              b'<Audio>\r\n<TVDevice>default</TVDevice>\r\n</Audio>\r\n')
        check('flatpak: device chosen since is left alone',
              repair(fp, 'flatpak:info.cemu.Cemu', 'alsa_x', 'flatpak'),
              b'<Audio>\r\n<TVDevice>alsa_x</TVDevice>\r\n</Audio>\r\n')
        os.environ.pop('XDG_CONFIG_HOME', None)
        check('appimage: blanked device restored',
              repair(home / '.config/Cemu', str(app), '', 'appimage'),
              b'<Audio>\r\n<TVDevice>default</TVDevice>\r\n</Audio>\r\n')
        # Once the backup is gone, a deliberately empty device stays empty.
        f = home / '.config/Cemu/settings.xml'
        f.write_bytes(b'<Audio>\r\n<TVDevice></TVDevice>\r\n</Audio>\r\n')
        ra.build_standalone_launch_command(str(home / 'g.wua'), 'cemu', spec, str(app))
        check('no backup: an empty device is left empty', f.read_bytes(),
              b'<Audio>\r\n<TVDevice></TVDevice>\r\n</Audio>\r\n')

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
