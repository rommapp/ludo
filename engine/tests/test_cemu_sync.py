"""Cemu (Wii U) saves through the sync engine: inventory, restore, profiles, -a.

Run with `python3 engine/tests/test_cemu_sync.py`.
"""
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from romm_sync_engine import (cemu_saves as C, emulator_saves as E, paths,  # noqa: E402
                              profiles as P, sync_core)
from romm_sync_engine.sync_core import AutoSyncManager, RetroArchInterface  # noqa: E402

TID = '0005000010198F00'
EXE = 'flatpak:info.cemu.Cemu'


class CemuSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {'HOME': self.tmp.name})
        self.env.start()
        paths._locked, paths._profile_locked, paths._profile = False, False, P.DEFAULT
        paths.set_app_id('ludo')
        paths.set_library_dir_name('Ludo')
        self.patches = [
            patch.object(E, 'cemu_is_running', return_value=False),
            patch.object(sync_core, 'find_standalone_executable', return_value=EXE),
            patch.object(sync_core, 'cache_dir', return_value=self.home / 'cache'),
        ]
        for p in self.patches:
            p.start()
        self.inst = C.install_for(EXE)
        self.title = self.inst.mlc / 'usr/save/00050000/10198f00'

    def tearDown(self):
        P.launch = None
        for p in self.patches:
            p.stop()
        self.env.stop()
        self.tmp.cleanup()
        paths._locked, paths._profile_locked, paths._profile = False, False, P.DEFAULT

    def use(self, profile_id):
        paths._locked, paths._profile_locked, paths._profile = False, False, P.DEFAULT
        paths.set_profile(profile_id)

    def write(self, rel, data):
        path = self.title / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def manager(self):
        m = AutoSyncManager.__new__(AutoSyncManager)
        m.get_games = lambda: [{'rom_id': 7, 'platform_slug': 'wiiu',
                                'romm_data': {'save_target': '00050000/10198f00'}}]
        m.log = lambda *a, **k: None
        m._title_id_index = None
        m.settings = type('S', (), {'get': lambda self, *a, **k: ''})()
        m.downloaded = []

        def download(save_id, kind, target, **kw):
            Path(target).write_bytes(Path(self.server_zip).read_bytes())
            return True
        m.romm_client = type('R', (), {
            'download_save_by_id': staticmethod(download),
            'confirm_save_downloaded': staticmethod(lambda *a, **k: m.downloaded.append(a)),
        })()
        return m

    def zip(self, files):
        self.server_zip = self.home / 'server.zip'
        with zipfile.ZipFile(self.server_zip, 'w') as z:
            for name, data in files.items():
                z.writestr(name, data)
        return {'rom_id': 7, 'save_id': 3, 'file_name': 'autosave.zip', 'emulator': 'Cemu'}

    def test_without_profiles_the_active_account_syncs(self):
        C.ensure_default_account(self.inst.mlc)
        self.write('user/80000001/save.dat', b'progress')
        self.write('meta/saveinfo.xml', b'<info/>')
        m = self.manager()
        [row] = m._cemu_inventory_entries()
        self.assertEqual((row['rom_id'], row['slot'], row['emulator'], row['_upload_name']),
                         (7, 'autosave', 'Cemu', 'autosave.zip'))
        with zipfile.ZipFile(row['_path']) as z:
            self.assertIn('10198f00/user/80000001/save.dat', z.namelist())
        with patch.object(E, 'cemu_is_running', return_value=True):
            self.assertEqual(m._cemu_inventory_entries(), [])
        self.assertEqual(RetroArchInterface._cemu_account_args(EXE), [])

    def test_restore_writes_the_account_and_confirms(self):
        op = self.zip({'10198f00/user/80000001/save.dat': b'from server',
                       '10198f00/user/common/c.dat': b'common'})
        m = self.manager()
        self.assertTrue(m._is_cemu_op(op))
        self.assertTrue(m.is_packed_save_op(op))
        self.assertIsNone(m._resolve_download_target(op, self.home))
        self.assertTrue(m._restore_standalone_save(op, 'dev-1', None))
        self.assertEqual((self.title / 'user/80000001/save.dat').read_bytes(), b'from server')
        self.assertEqual(len(m.downloaded), 1)
        with patch.object(E, 'cemu_is_running', return_value=True):
            self.assertFalse(m._restore_standalone_save(op, 'dev-1', None))
        wrong = self.zip({'1010ed00/user/80000001/save.dat': b'other game'})
        self.assertFalse(m._restore_standalone_save(wrong, 'dev-1', None))
        self.assertEqual((self.title / 'user/80000001/save.dat').read_bytes(), b'from server')

    def test_each_profile_has_its_own_account(self):
        P.launch = {'id': P.DEFAULT, 'steam': None, 'ask': False}
        mia = P.create('Mia')
        # Cemu never ran: the first profile gets the account Cemu would make.
        self.assertEqual(RetroArchInterface._cemu_account_args(EXE), ['-a', '80000001'])
        self.write('user/80000001/save.dat', b'covin')
        self.use(mia)
        self.assertEqual(RetroArchInterface._cemu_account_args(EXE), ['-a', '80000002'])
        self.assertEqual(C.accounts(self.inst.mlc)[0x80000002], 'Mia')
        m = self.manager()
        self.assertEqual(m._cemu_inventory_entries(), [])   # covin's save is not hers
        op = self.zip({'10198f00/user/80000001/save.dat': b'mia from server'})
        self.assertTrue(m._restore_standalone_save(op, 'dev-1', None))
        self.assertEqual((self.title / 'user/80000002/save.dat').read_bytes(), b'mia from server')
        self.assertEqual((self.title / 'user/80000001/save.dat').read_bytes(), b'covin')
        [row] = m._cemu_inventory_entries()
        with zipfile.ZipFile(row['_path']) as z:
            self.assertEqual(z.read('10198f00/user/80000001/save.dat'), b'mia from server')
        # Cemu open when an account would have to be added: saves left alone.
        other = P.create('Leo')
        self.use(other)
        with patch.object(E, 'cemu_is_running', return_value=True):
            self.assertEqual(RetroArchInterface._cemu_account_args(EXE), [])
        self.assertIsNone(self.manager()._cemu_target())

    def test_first_profile_keeps_cemu_s_active_account(self):
        C.ensure_default_account(self.inst.mlc)
        C.add_account(self.inst.mlc, 'Old')
        self.inst.settings_file.parent.mkdir(parents=True, exist_ok=True)
        self.inst.settings_file.write_text(
            '<content><Account><PersistentId>2147483650</PersistentId></Account></content>')
        P.launch = {'id': P.DEFAULT, 'steam': None, 'ask': False}
        mia = P.create('Mia')
        self.assertEqual(RetroArchInterface._cemu_account_args(EXE), ['-a', '80000002'])
        self.use(mia)
        self.assertEqual(RetroArchInterface._cemu_account_args(EXE), ['-a', '80000003'])

    def tile_manager(self, last=''):
        wua = self.home / 'roms/wiiu/Terraria.wua'
        wua.parent.mkdir(parents=True, exist_ok=True)
        wua.write_bytes(b'x')
        m = self.manager()
        tile = {'rom_id': 7, 'platform_slug': 'wiiu', 'is_downloaded': True,
                'local_path': str(wua), 'romm_data': {'save_target': '00050000/10198f00'},
                '_sibling_files': [{'id': 8, 'fs_name': 'Terraria.wua'}],
                '_variant_downloads': {'8': {'local_path': str(wua)}}}
        other = {'rom_id': 9, 'platform_slug': 'snes', 'is_downloaded': True,
                 '_sibling_files': [{'id': 10}]}
        m.get_games = lambda: [tile, other]
        m.settings = type('S', (), {'get': lambda self, sec, key, d='': (
            last if (sec, key) == ('LastVersion', '7') else d)})()
        return m

    def test_a_grouped_game_saves_under_the_version_played(self):
        C.ensure_default_account(self.inst.mlc)
        self.write('user/80000001/save.dat', b'progress')
        m = self.tile_manager()
        # Only the .wua (ROM 8) is on disk: that is what Cemu plays, and what
        # Argosy would file the save under.
        [row] = m._cemu_inventory_entries()
        self.assertEqual(row['rom_id'], 8)
        self.assertIs(m._game_for_rom(8)['rom_id'], 7)
        self.assertEqual(m._tile_scope(8), {7, 8})
        self.assertEqual(m._tile_scope(10), {10})          # not Wii U / Switch
        self.assertEqual(m._save_rom_id(9), 9)
        m.get_games()[0]['platform_slug'] = 'switch'       # Eden saves alike
        self.assertEqual(m._save_rom_id(7), 8)

    def test_the_newest_save_on_any_rom_of_the_tile_wins(self):
        m = self.tile_manager()
        local = {'rom_id': 8, 'slot': 'autosave', 'content_hash': 'L',
                 'updated_at': '2026-11-16T12:00:00+00:00'}

        def op(rom, action, when=None, h=None):
            o = {'rom_id': rom, 'slot': 'autosave', 'action': action}
            if when:
                o.update(server_updated_at=when, server_content_hash=h)
            return o
        snes = op(10, 'download', '2026-11-16T13:00:00+00:00', 'S')
        # An older save on the other ROM (Ludo's own from before) stays put;
        # this device's newer one goes up under the version it plays.
        up, old = op(8, 'upload'), op(7, 'download', '2026-11-15T10:00:00+00:00', 'O')
        self.assertEqual(m._pick_tile_saves([up, old, snes], [local]), [up, snes])
        same = op(7, 'download', '2026-11-17T10:00:00+00:00', 'L')
        self.assertEqual(m._pick_tile_saves([up, same], [local]), [up])
        # A newer, different save there (another device) is restored instead.
        new = op(7, 'conflict', '2026-11-17T10:00:00+00:00', 'N')
        self.assertEqual(m._pick_tile_saves([up, new], [local]), [new])
        self.assertEqual(new['action'], 'download')
        # Nothing local: only the newest of the tile's server saves.
        a = op(7, 'download', '2026-11-10T10:00:00+00:00', 'A')
        b = op(8, 'download', '2026-11-12T10:00:00+00:00', 'B')
        self.assertEqual(m._pick_tile_saves([a, b], []), [b])

    def test_the_version_last_launched_wins_when_both_are_on_disk(self):
        folder = self.home / 'roms/wiiu/Terraria'
        folder.mkdir(parents=True)
        m = self.tile_manager(last='7')
        tile = m.get_games()[0]
        tile['local_path'] = str(folder)
        self.assertEqual(m._played_rom_id(tile), 7)
        m = self.tile_manager(last='8')
        tile = m.get_games()[0]
        tile['local_path'] = str(folder)
        self.assertEqual(m._played_rom_id(tile), 8)


def main():
    result = unittest.TextTestRunner(verbosity=1).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(CemuSyncTest))
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main())
