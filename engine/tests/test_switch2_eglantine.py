"""Switch 2 support: Eglantine as its standalone emulator, kept apart from Eden.

Run with `python3 engine/tests/test_switch2_eglantine.py`.

A Switch 2 game ("Nintendo Switch 2", slug "switch-2") used to match Eden's
"switch" token and was launched in an emulator that cannot boot it. These
checks pin the split in both directions, Eglantine's AppImage discovery, the
.nup / loose ExeFS launch targets, and that each emulator's save tree only
yields its own console's titles.
"""

import os
import shutil
import struct
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import emulator_saves, sync_core, title_ids  # noqa: E402
from romm_sync_engine.sync_core import (  # noqa: E402
    RetroArchInterface, STANDALONE_EMULATORS, find_standalone_builds,
    find_standalone_executable, is_switch2_folder_game, is_switch2_platform,
    resolve_switch2_rom, standalone_emulator_for_platform)

FAILED = []


def check(name, got, want):
    ok = got == want
    print('ok  ' if ok else 'FAIL', name, '' if ok else f'\n   got  {got!r}\n   want {want!r}')
    if not ok:
        FAILED.append(name)


def touch(path, exec_=False, data=b'x'):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    if exec_:
        path.chmod(0o755)
    return path


def nup_bytes(records):
    """A minimal NUP v1: superblock, TOC header, one 0x40 record per package."""
    toc = bytearray(b'TOC\x01' + struct.pack('<I', len(records)) + b'\0' * 0x28)
    for title, kind, version in records:
        rec = bytearray(0x40)
        struct.pack_into('<Q', rec, 0, title)
        struct.pack_into('<I', rec, 0x14, version)
        rec[0x18] = kind
        toc += rec
    sb = bytearray(0x80)
    sb[:4] = b'NUP\x01'
    struct.pack_into('<H', sb, 4, 0x80)
    struct.pack_into('<QQ', sb, 8, 0x80, len(toc))
    struct.pack_into('<Q', sb, 0x40, 0x80 + len(toc))
    struct.pack_into('<I', sb, 0x48, len(records))
    return bytes(sb + toc)


def npdm_bytes(program_id):
    meta = bytearray(0x80)
    meta[:4] = b'META'
    struct.pack_into('<I', meta, 0x70, 0x80)
    aci = bytearray(0x40)
    aci[:4] = b'ACI0'
    struct.pack_into('<Q', aci, 0x10, program_id)
    return bytes(meta + aci)


def main():
    # --- platform ownership ---------------------------------------------------
    for name, slug in (('Nintendo Switch 2', 'switch-2'), (None, 'switch-2'),
                       ('Switch 2', None), ('x', 'switch2'),
                       ('Nintendo_Switch_2', None)):
        got = standalone_emulator_for_platform(name, slug)
        check(f'{name!r}/{slug!r} -> eglantine', got and got[0], 'eglantine')
        check(f'{name!r}/{slug!r} is switch 2', is_switch2_platform(name, slug), True)
    for name, slug in (('Nintendo Switch', 'switch'), (None, 'switch'),
                       ('Nintendo - Switch', None)):
        got = standalone_emulator_for_platform(name, slug)
        check(f'{name!r}/{slug!r} -> eden', got and got[0], 'eden')
        check(f'{name!r}/{slug!r} not switch 2', is_switch2_platform(name, slug), False)

    # --- title IDs --------------------------------------------------------------
    check('generation 1', title_ids.switch_generation('0100152000022000'), 1)
    check('generation 2', title_ids.switch_generation('0400C3F00006E000'), 2)
    check('generation other', title_ids.switch_generation('0004000000033500'), None)
    check('switch 2 base is a save title', title_ids.is_switch_title_id('0400A3A01EE4C000'), True)
    check('switch 2 dlc -> base', title_ids.base_switch_title_id('040074A01BF13001'),
          '040074A01BF12000')
    check('switch 2 tag in name', title_ids.title_id_from_name('Game [0400C3F00006E000].nup'),
          '0400C3F00006E000')

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        # Placeholder record + update carrying the base ID, as in real dumps.
        nup = touch(tmp / 'roms/switch-2/Pokopia/Pokopia [v2.0.1].nup',
                    data=nup_bytes([(0, 0, 0), (0x0400A3A01EE4C000, 1, 327680)]))
        check('nup title', title_ids.read_nup_title_id(nup), '0400A3A01EE4C000')
        dlc = touch(tmp / 'roms/switch-2/DK/DK.nup', data=nup_bytes(
            [(0x040074A01BF12000, 0, 0), (0x040074A01BF13001, 2, 0)]))
        check('nup with dlc -> base', title_ids.title_id_from_rom(dlc), '040074A01BF12000')
        check('not a nup', title_ids.read_nup_title_id(touch(tmp / 'junk.nup')), None)

        loose = tmp / 'roms/switch-2/Kart'
        touch(loose / 'exefs/main')
        touch(loose / 'exefs/main.npdm', data=npdm_bytes(0x0400C3F00006E000))
        touch(loose / 'romfs/data.bin')
        touch(loose / 'romfs/other.bin')
        touch(loose / 'updates/exefs/main')
        touch(loose / 'updates/exefs/main.npdm', data=npdm_bytes(0x0400C3F00006E000))
        check('npdm program id', title_ids.read_npdm_program_id(loose / 'exefs/main.npdm'),
              '0400C3F00006E000')
        index = title_ids.index_roms([tmp / 'roms'])
        check('index nup', index.get('0400A3A01EE4C000'), nup)
        check('index loose dump -> game folder', index.get('0400C3F00006E000'), loose)

        # --- launch targets ---------------------------------------------------
        check('loose folder -> base exefs/main', resolve_switch2_rom(loose),
              (loose / 'exefs/main', loose))
        check('folder -> nup', resolve_switch2_rom(nup.parent), (nup, nup.parent))
        check('file -> itself', resolve_switch2_rom(nup), (nup, nup.parent))
        check('loose folder is one game', is_switch2_folder_game(loose), True)
        check('plain folder is not', is_switch2_folder_game(touch(tmp / 'p/a.nds').parent), False)

        ra = RetroArchInterface.__new__(RetroArchInterface)
        cmd = ra.build_standalone_launch_command(
            loose, 'eglantine', STANDALONE_EMULATORS['eglantine'], '/x/eglantine.AppImage')
        check('argv', cmd, ['/x/eglantine.AppImage', '-f', '-g', str(loose / 'exefs/main')])

        # --- AppImage discovery -----------------------------------------------
        home = tmp / 'home'
        real_home, real_which = os.environ.get('HOME', ''), shutil.which
        os.environ['HOME'] = str(home)
        sync_core.shutil.which = lambda n: None
        try:
            spec = STANDALONE_EMULATORS['eglantine']
            check('nothing installed', find_standalone_executable('eglantine', spec), '')
            dl = touch(home / 'Downloads/eglantine-linux-x86_64-pgo(1).AppImage')
            touch(home / 'Downloads/eglantine-linux-x86_64.AppImage')
            touch(home / 'Downloads/eglantinefoo.AppImage', exec_=True)
            touch(home / 'Downloads/eden.AppImage', exec_=True)
            builds = find_standalone_builds('eglantine', spec)
            check('downloads found, look-alikes not', sorted(Path(b['path']).name for b in builds),
                  ['eglantine-linux-x86_64-pgo(1).AppImage', 'eglantine-linux-x86_64.AppImage'])
            check('same-named builds told apart', len({b['label'] for b in builds}), 2)
            mine = touch(home / 'Applications/eglantine.AppImage', exec_=True)
            check('renamed install wins', find_standalone_executable('eglantine', spec), str(mine))
            check('eden ignores eglantine',
                  find_standalone_executable('eden', STANDALONE_EMULATORS['eden']),
                  str(home / 'Downloads/eden.AppImage'))
            check('download made executable', sync_core.ensure_executable(dl)
                  and os.access(dl, os.X_OK), True)

            # --- save trees stay per console ------------------------------------
            def save(root, tid):
                touch(home / root / 'nand/user/save/0000000000000000/AB' / tid / 'file')
            save('.local/share/eglantine', '0400C3F00006E000')
            save('.local/share/eglantine', '0100152000022000')
            save('.local/share/eden', '0100152000022000')
            save('.local/share/eden', '0400A3A01EE4C000')
            os.environ.pop('EDEN_DATA_DIR', None)
            os.environ.pop('EGLANTINE_DATA_DIR', None)
            check('eglantine yields switch 2 only',
                  [s['title_id'] for s in emulator_saves.find_eden_saves(flavour='eglantine')],
                  ['0400C3F00006E000'])
            check('eden yields switch 1 only',
                  [s['title_id'] for s in emulator_saves.find_eden_saves()],
                  ['0100152000022000'])
            check('flavour for title', emulator_saves.flavour_for_title_id('0400C3F00006E000'),
                  'eglantine')

            # A title booted but never saved holds only .yuzu_save_size: not a save.
            stray = home / '.local/share/eglantine/nand/user/save/0000000000000000/D328A98DED407842CA00000000000000'
            touch(stray / '0400A3A01EE4C000/.yuzu_save_size', data=b'\0' * 16)
            check('marker-only dir is not a save',
                  [s['title_id'] for s in emulator_saves.find_eden_saves(flavour='eglantine')],
                  ['0400C3F00006E000'])
            # Two user folders, but the profile list names one: a fresh title
            # restores into it instead of waiting for a first boot.
            check('no profile list: two folders wait',
                  emulator_saves.eden_restore_dir('0400A3A01EE4C000', flavour='eglantine'), None)
            real = 'CE56092D587975D328A98DED407842CA'
            data = home / '.local/share/eglantine'
            (data / 'nand/user/save/0000000000000000' / real).mkdir(parents=True)
            entry = bytearray(0xC8)
            struct.pack_into('<QQ', entry, 0, int(real[16:], 16), int(real[:16], 16))
            touch(data / 'nand/system/save/8000000000000010/su/avators/profiles.dat',
                  data=b'\0' * 0x10 + bytes(entry) + b'\0' * 0xC8 * 7)
            check('profiles.dat parsed', emulator_saves.registered_users(data), [real])
            check('restore dir is the registered profile',
                  emulator_saves.eden_restore_dir('0400A3A01EE4C000', flavour='eglantine'),
                  data / 'nand/user/save/0000000000000000' / real / '0400A3A01EE4C000')
            # Two real profiles: current_user in qt-config.ini picks, as
            # Eglantine does; an index past the list falls back to the first.
            second = '00112233445566778899AABBCCDDEEFF'
            entry2 = bytearray(0xC8)
            struct.pack_into('<QQ', entry2, 0, int(second[16:], 16), int(second[:16], 16))
            touch(data / 'nand/system/save/8000000000000010/su/avators/profiles.dat',
                  data=b'\0' * 0x10 + bytes(entry) + bytes(entry2) + b'\0' * 0xC8 * 6)
            os.environ['XDG_CONFIG_HOME'] = str(home / '.config')
            touch(home / '.config/eglantine/qt-config.ini',
                  data=b'[System]\ncurrent_user\\default=false\ncurrent_user=1\n')
            check('current_user picks the second profile',
                  emulator_saves.eden_restore_dir('0400A3A01EE4C000', flavour='eglantine'),
                  data / 'nand/user/save/0000000000000000' / second / '0400A3A01EE4C000')
            touch(home / '.config/eglantine/qt-config.ini', data=b'current_user=7\n')
            check('missing index falls back to the first',
                  emulator_saves.eden_restore_dir('0400A3A01EE4C000', flavour='eglantine'),
                  data / 'nand/user/save/0000000000000000' / real / '0400A3A01EE4C000')
            os.environ.pop('XDG_CONFIG_HOME', None)

            # Pre-launch/post-download: no local save for the game -> the
            # server's latest is restored; a local save -> left to negotiate.
            # Judged by the SERVER save's title, never by matching local saves
            # back to ROMs (an unidentifiable ROM still has a real save).
            m = sync_core.AutoSyncManager.__new__(sync_core.AutoSyncManager)
            m.settings = type('S', (), {'get': lambda self, s, k, d='': d})()
            m.log = lambda *a: None
            m._game_for_rom = lambda rid: {'platform_slug': 'switch-2'}
            m._title_id_index = {'0400A3A01EE4C000': 470}
            m._rom_id_for_title_id = lambda t: None     # nothing maps back
            restored = []
            m._restore_standalone_save = lambda op, dev, sess: restored.append(
                (op['save_id'], op['_title_id']))
            game = {'platform_slug': 'switch-2', 'name': 'Pokopia'}
            latest = {'id': 159, 'file_name': 'autosave.zip', 'emulator': 'Eglantine'}
            check('missing local save is restored (title from the local index)',
                  (m._restore_latest_switch_save_if_missing(game, 470, latest), restored),
                  (True, [(159, '0400A3A01EE4C000')]))
            restored.clear()
            on_disk = dict(latest, file_name='0400C3F00006E000 [2026-11-21].zip')
            check('a save on disk blocks the restore, even unmatched to a ROM',
                  (m._restore_latest_switch_save_if_missing(game, 9, on_disk), restored),
                  (False, []))
            check('unknown title: left to negotiate',
                  m._restore_latest_switch_save_if_missing(game, 999, latest), False)
            check('not a switch game',
                  m._restore_latest_switch_save_if_missing(
                      {'platform_slug': 'wiiu'}, 470, latest), False)
        finally:
            os.environ['HOME'] = real_home
            sync_core.shutil.which = real_which

    if FAILED:
        print(f'\n{len(FAILED)} failed')
        return 1
    print('\nall passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
