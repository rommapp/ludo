#!/usr/bin/env python3
"""Regressions: bundled .xci (#58), arcade zips (#57), first-boot Eden saves
(#68), credentials at rest (#59)."""
import json
import os
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from unittest import mock

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))
from romm_sync_engine import emulator_saves as E      # noqa: E402
from romm_sync_engine import sync_core as C           # noqa: E402
from romm_sync_engine import title_ids as T           # noqa: E402

FAILURES = []
BASE = '0100152000022000'
UPDATE = '0100152000022800'
USER = 'A' * 32


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ('' if ok else f": {got!r} != {want!r}"))
    if not ok:
        FAILURES.append(name)


def hfs0(files):
    names = b''
    rows = b''
    body = b''
    for name, data in files:
        rows += struct.pack('<QQII8x32x', len(body), len(data), len(names), 0)
        names += name.encode() + b'\0'
        body += data
    return b'HFS0' + struct.pack('<III', len(files), len(names), 0) + rows + names + body


def xci(path, cnmts, prefix=0):
    secure = hfs0([(f'{i:032x}.cnmt.nca', b'x') for i in range(cnmts)]
                  + [('f' * 32 + '.nca', b'game')])
    root = hfs0([('update', b''), ('secure', secure)])
    head = bytearray(0xF000)
    head[0x100:0x104] = b'HEAD'
    head[0x130:0x138] = struct.pack('<Q', 0xF000)
    path.write_bytes(b'\0' * prefix + bytes(head) + root)
    return path


def bundles(d):
    check('two metas counted', T.xci_cnmt_count(xci(d / 'a.xci', 2)), 2)
    check('key-area prefix counted', T.xci_cnmt_count(xci(d / 'p.xci', 3, 0x1000)), 3)
    junk = d / 'junk.xci'
    junk.write_bytes(b'not a cartridge' * 100)
    check('junk counts zero', T.xci_cnmt_count(junk), 0)

    # Named the way these dumps read when the update's meta comes first.
    bundled = xci(d / f'Game [{UPDATE}].xci', 2)
    info = T.switch_content(bundled)
    check('bundle is a base game', info['kind'], 'base')
    check('bundle carries the base id', info['title_id'], BASE)
    lone = xci(d / f'Patch [{UPDATE}].xci', 1)
    check('a lone update stays an update', T.switch_content(lone)['kind'], 'update')
    nsp = d / f'Patch [{UPDATE}].nsp'
    nsp.write_bytes(b'x')
    check('an nsp is not inspected', T.switch_content(nsp)['kind'], 'update')

    from romm_sync_engine import switch_content as S
    check('a bundle boots', S.base_game([bundled]), bundled)
    check('a lone update still does not', S.base_game([lone]), None)


def arcade():
    f = C.arcade_romset_stays_zipped
    check('romset stays zipped', f('arcade', ['a.bin', 'b.rom', 'dir/c.bin']), True)
    check('fbneo too', f('FBNeo', ['a.bin', 'b.bin']), True)
    check('arcade wrapper of romsets opens', f('arcade', ['mslug.zip', 'neogeo.zip']), False)
    check('arcade CHD wrapper opens', f('mame', ['g.zip', 'g/disk.chd']), False)
    check('consoles are unaffected', f('psx', ['a.bin', 'a.cue']), False)
    check('Neo Geo CD is a disc system', f('neo-geo-cd', ['a.bin', 'a.cue']), False)

    ra = object.__new__(C.RetroArchInterface)
    ra._retrodeck_core_map = lambda: {
        'arcade': [('MAME', 'mame'), ('FBNeo', 'fbneo')], 'cps2': [('MAME', 'mame')]}
    ra._retrodeck_alt_emulator = lambda slug: None
    pick = ra._retrodeck_core_for_slug
    check('arcade prefers FBNeo over the ES-DE default', pick('arcade', ['mame', 'fbneo']), 'fbneo')
    check('arcade falls back to MAME', pick('arcade', ['mame']), 'mame')
    check('other systems keep ES-DE order', pick('cps2', ['mame', 'fbneo']), 'mame')
    ra._retrodeck_alt_emulator = lambda slug: 'MAME'
    check("a user's RetroDECK choice wins", pick('arcade', ['mame', 'fbneo']), 'mame')


class FakeClient:
    base_url = 'http://romm'

    def __init__(self, pack=None, user_saves=('x',)):
        self.pack, self.confirmed, self.downloads = pack, [], []
        self.user_saves = list(user_saves)
        self.session = self

    def download_save_by_id(self, save_id, kind, dest, device_id=None, session_id=None):
        self.downloads.append(device_id)
        dest.write_bytes(Path(self.pack).read_bytes())
        return True

    def confirm_save_downloaded(self, save_id, kind, device_id, content_hash=None):
        self.confirmed.append((save_id, device_id))
        return True

    def get(self, url, timeout=None):
        client = self

        class R:
            status_code = 200

            def json(self):
                return {'user_saves': client.user_saves}
        return R()


def manager(data, client, cache):
    m = C.AutoSyncManager.__new__(C.AutoSyncManager)
    m.romm_client = client
    m.settings = mock.Mock(get=lambda s, k, d='': str(data) if k == 'eden_data_dir' else d)
    m.log = lambda *_: None
    m._rom_id_for_title_id = lambda t: 7
    m.get_games = lambda: []
    return m


def eden(d):
    pack = d / 'pack.zip'
    with zipfile.ZipFile(pack, 'w') as z:
        z.writestr('Autosave.save', b'SERVER')
    op = {'save_id': 41, 'rom_id': 7, 'file_name': f'{BASE}.zip', 'emulator': 'eden'}
    E.eden_is_running = lambda: False

    data = d / 'fresh/.local/share/eden'
    (data / 'nand/user/save').mkdir(parents=True)
    with mock.patch.object(C, 'cache_dir', lambda: d / 'cache'), \
            mock.patch.object(C.emulator_saves, 'eden_data_dirs', lambda x=None: [data]), \
            mock.patch.object(E, 'eden_data_dirs', lambda x=None: [data]):
        client = FakeClient(pack)
        m = manager(data, client, d)

        # Nothing booted, no profile at all: refused, with nothing fetched.
        check('refused', m._restore_standalone_save(op, 'dev', None), False)
        check('no transfer and no baseline', (client.downloads, client.confirmed), ([], []))
        check('remembered', m._eden_awaiting_restore()[BASE]['save_id'], 41)

        # First boot writes a new save. It must not be offered for upload.
        save = data / 'nand/user/save/0000000000000000' / USER / BASE
        save.mkdir(parents=True)
        (save / 'Autosave.save').write_bytes(b'FIRST BOOT')
        with mock.patch.object(C.emulator_saves, 'pack_save',
                               side_effect=AssertionError('packed for upload')):
            check('first-boot save held back', m._eden_inventory_entries(), [])

        # Next sync restores, keeps the first-boot copy, then records the sync.
        with mock.patch.object(E, 'pack_save',
                               side_effect=lambda s, p: Path(p).write_bytes(b'b') or p):
            check('restored', m._restore_standalone_save(op, 'dev', None), True)
        check('server save in place', (save / 'Autosave.save').read_bytes(), b'SERVER')
        check('fetch itself records nothing', client.downloads, [None])
        check('baseline only after success', client.confirmed, [(41, 'dev')])
        check('no longer awaited', m._eden_awaiting_restore(), {})

        # Deleting the server's save must release the hold.
        m._set_eden_awaiting_restore(BASE, op)
        client.user_saves = []
        check('released once the server has none',
              m._eden_restore_still_owed(BASE, m._eden_awaiting_restore()[BASE]), False)
        check('released on disk', m._eden_awaiting_restore(), {})

        # One real profile and a game never booted: restores right away.
        other = '0100000000010000'
        client.user_saves = ['x']
        op2 = dict(op, file_name=f'{other}.zip')
        check('sole user restores before boot',
              m._restore_standalone_save(op2, 'dev', None), True)
        check('landed under that user',
              (data / 'nand/user/save/0000000000000000' / USER / other
               / 'Autosave.save').read_bytes(), b'SERVER')

        # Two profiles really is a guess.
        (data / 'nand/user/save/0000000000000000' / ('B' * 32)).mkdir()
        check('two users refuse', E.eden_restore_dir('0100000000020000', data), None)


PROG = r'''
import sys; sys.path.insert(0, sys.argv[1])
from romm_sync_engine.sync_core import SettingsManager
s = SettingsManager()
print(s.get("RomM", "password"))
print(s.config.get("RomM", "password")[:6])
'''


def credentials(d):
    cfg = d / 'home/.config' / C.config_dir().name
    cfg.mkdir(parents=True)
    ini = cfg / 'settings.ini'
    ini.write_text('[RomM]\nurl = http://x\npassword = hunter2\n')
    os.chmod(ini, 0o644)
    env = dict(os.environ, HOME=str(d / 'home'), XDG_CONFIG_HOME=str(d / 'home/.config'))
    out = subprocess.run([sys.executable, '-c', PROG, str(ENGINE)], env=env,
                         capture_output=True, text=True)
    check('password still reads back', out.stdout.splitlines()[-2:-1], ['hunter2'])
    check('encrypted on disk', 'hunter2' in ini.read_text(), False)
    check('owner-only', stat.S_IMODE(ini.stat().st_mode), 0o600)
    out = subprocess.run([sys.executable, '-c', PROG, str(ENGINE)], env=env,
                         capture_output=True, text=True)
    check('reads back after migration', out.stdout.splitlines()[-2:-1], ['hunter2'])
    check('owner-only after a rewrite', stat.S_IMODE(ini.stat().st_mode), 0o600)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        bundles(d)
        arcade()
        eden(d)
        credentials(d)
    print(f"{len(FAILURES)} failure(s)")
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
