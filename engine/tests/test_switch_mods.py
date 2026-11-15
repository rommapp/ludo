"""Synthetic packages only; run directly or through tests/run.sh mods."""
import json
import stat
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from romm_sync_engine import switch_mods as M

TITLE = '0100F2C0115B6000'
MOD = f'load/{TITLE}/Example/exefs/subsdk3'
CONFIG = 'sdmc/UltraCam/TOTK/Config/maxlastbreath.ini'


class ModPackages(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.installer = M.Installer(self.root / 'state', self.root / 'load',
                                     self.root / 'sdmc', lambda: False)

    def archive(self, entries=None):
        path = self.root / 'package.zip'
        with zipfile.ZipFile(path, 'w') as z:
            for name, data in (entries or {MOD: b'mod-v1', CONFIG: b'[Resolution]\nHeight=720'}).items():
                z.writestr(name, data)
        return path

    def install(self, entries=None, package='one'):
        return self.installer.install(self.archive(entries), TITLE, package, 'Example')

    def test_installs_both_roots_without_importing_desktop_settings(self):
        skipped = f'config/custom/{TITLE}.ini'
        result = self.install({MOD: b'code', CONFIG: b'config', skipped: b'pc-settings', 'README.txt': b'notes'})
        self.assertEqual(result['status'], 'ok')
        self.assertIn(skipped, result['skipped'])
        self.assertEqual((self.root / MOD).read_bytes(), b'code')
        self.assertEqual((self.root / CONFIG).read_bytes(), b'config')
        self.assertFalse((self.root / skipped).exists())
        self.assertEqual(self.installer.installed(TITLE)[0]['package_id'], 'one')
        self.installer.remove('one', TITLE)
        self.assertFalse((self.root / MOD).exists())
        self.assertFalse((self.root / CONFIG).exists())

    def test_shared_path_conformance(self):
        fixture = Path(__file__).parent / 'fixtures/switch-mod-paths.tsv'
        for line in fixture.read_text().splitlines():
            expected, name = line.split('\t')
            with self.subTest(name=name):
                if expected == 'reject':
                    with self.assertRaises(M.ModError):
                        M._target(name, TITLE)
                else:
                    target = M._target(name, TITLE)
                    self.assertEqual(target is not None, expected == 'install')

    def test_invalid_paths_reject_entire_package_before_writing(self):
        for name in ('../escape', '/absolute', 'load//bad', 'load/../bad',
                     'load\\bad', 'load/C:/bad', 'load/bad./file',
                     'config/qt-config.ini', 'sdmc/UltraCam/BOTW/Config/a.ini',
                     'sdmc/Nintendo/save.dat', f'load/{"0" * 16}/Other/exefs/code'):
            with self.subTest(name=name), self.assertRaises(M.ModError):
                self.install({MOD: b'good', name: b'bad'})
            self.assertFalse((self.root / MOD).exists())

    def test_rejects_duplicate_casefold_destinations(self):
        with self.assertRaises(M.ModError):
            self.install({MOD: b'one', MOD.replace('Example', 'EXAMPLE'): b'two'})
        self.assertFalse((self.root / MOD).exists())

    def test_prefix_collisions_are_rejected_before_writes(self):
        for other in (MOD + '/child', MOD.replace('Example', 'EXAMPLE') + '-other'):
            with self.subTest(other=other), self.assertRaises(M.ModError):
                self.install({MOD: b'one', other: b'two'})
            self.assertFalse((self.root / MOD).exists())

    def install_named(self, entries, name):
        path = self.root / name
        with zipfile.ZipFile(path, 'w') as z:
            for member, data in entries.items():
                z.writestr(member, data)
        return self.installer.install(path, TITLE, name, name)

    def test_layouts_eden_imports_are_installed_like_eden(self):
        # Eden's "Import Mod from ZIP" takes the parent of any mod folder.
        cases = {
            'romfs/a.bin': f'load/{TITLE}/Bare Mod/romfs/a.bin',
            'Sixty FPS/RomFS/a.bin': f'load/{TITLE}/Sixty FPS/romfs/a.bin',
            f'{TITLE}/Named/exefs/main.npdm': f'load/{TITLE}/Named/exefs/main.npdm',
            f'atmosphere/contents/{TITLE.lower()}/romfs/a.bin': f'load/{TITLE}/Bare Mod/romfs/a.bin',
            'Ext/romfs_ext/a.bin': f'load/{TITLE}/Ext/romfs_ext/a.bin',
            'Lite/romfslite/a.bin': f'load/{TITLE}/Lite/romfslite/a.bin',
            'Cheat/cheats/0123456789ABCDEF.txt': f'load/{TITLE}/Cheat/cheats/0123456789ABCDEF.txt',
        }
        for member, target in cases.items():
            with self.subTest(member=member):
                self.install_named({member: b'x', 'README.md': b'notes'}, 'Bare Mod.zip')
                self.assertEqual((self.root / target).read_bytes(), b'x')
                self.installer.remove('Bare Mod.zip', TITLE)
                self.assertFalse((self.root / target).exists())

    def test_canonical_paths_accept_every_eden_folder_in_any_case(self):
        target = f'load/{TITLE}/Example/RomFS_Ext/a.bin'
        self.install({target: b'x'})
        self.assertTrue((self.root / f'load/{TITLE}/Example/romfs_ext/a.bin').exists())

    def test_several_mods_in_one_archive_are_all_installed(self):
        self.install_named({'A/romfs/a.bin': b'a', 'B/exefs/b.ips': b'b'}, 'pack.zip')
        self.assertTrue((self.root / f'load/{TITLE}/A/romfs/a.bin').exists())
        self.assertTrue((self.root / f'load/{TITLE}/B/exefs/b.ips').exists())

    def test_eden_layout_for_another_game_is_rejected(self):
        with self.assertRaises(M.ModError):
            self.install_named({'01007EF00011E000/Mod/romfs/a.bin': b'x'}, 'other.zip')
        with self.assertRaises(M.ModError):
            self.install_named({'docs/readme.txt': b'x'}, 'nomod.zip')
        self.assertFalse((self.root / 'load').exists())

    def test_forced_removal_deletes_edited_owned_files_only(self):
        borrowed = f'load/{TITLE}/Example/romfs/borrowed.bin'
        (self.root / borrowed).parent.mkdir(parents=True)
        (self.root / borrowed).write_bytes(b'same')
        self.install({MOD: b'code', CONFIG: b'config', borrowed: b'same'})
        (self.root / CONFIG).write_bytes(b'user tweaked')
        with self.assertRaises(M.ChangedError):
            self.installer.remove('one', TITLE)
        self.assertTrue((self.root / MOD).exists())
        self.installer.remove('one', TITLE, force=True)
        self.assertFalse((self.root / MOD).exists())
        self.assertFalse((self.root / CONFIG).exists())
        self.assertEqual((self.root / borrowed).read_bytes(), b'same')
        self.assertEqual(self.installer.installed(TITLE), [])

    def test_rejects_zip_symlink(self):
        path = self.archive({MOD: b'code'})
        link = zipfile.ZipInfo(f'load/{TITLE}/Example/romfs/link')
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(path, 'a') as z:
            z.writestr(link, '/elsewhere')
        with self.assertRaises(M.ModError):
            self.installer.install(path, TITLE, 'one', 'Example')

    def test_limits_checked_before_mutation(self):
        with patch.object(M, 'MAX_TOTAL_BYTES', 3), self.assertRaises(M.ModError):
            self.install()
        with patch.object(M, 'MAX_FILE_BYTES', 3), self.assertRaises(M.ModError):
            self.install()
        with patch.object(M, 'MAX_FILES', 1), self.assertRaises(M.ModError):
            self.install()
        self.assertFalse((self.root / MOD).exists())

    def test_existing_symlink_is_not_followed(self):
        outside = self.root / 'elsewhere'
        outside.mkdir()
        (self.root / 'load' / TITLE).mkdir(parents=True)
        (self.root / 'load' / TITLE / 'Example').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(M.ModError):
            self.install()
        self.assertEqual(list(outside.iterdir()), [])

    def test_unowned_different_file_blocks_install_without_any_changes(self):
        path = self.root / CONFIG
        path.parent.mkdir(parents=True)
        path.write_bytes(b'user-settings')
        with self.assertRaises(M.ModError):
            self.install()
        self.assertFalse((self.root / MOD).exists())
        self.assertEqual(path.read_bytes(), b'user-settings')

    def test_identical_borrowed_file_is_not_removed(self):
        path = self.root / MOD
        path.parent.mkdir(parents=True)
        path.write_bytes(b'mod-v1')
        self.install()
        self.installer.remove('one', TITLE)
        self.assertEqual(path.read_bytes(), b'mod-v1')
        self.assertFalse((self.root / CONFIG).exists())

    def test_second_package_cannot_claim_managed_files(self):
        self.install()
        with self.assertRaises(M.ModError):
            self.install(package='two')
        self.installer.remove('one', TITLE)
        self.assertFalse((self.root / MOD).exists())

    def test_borrowed_file_cannot_be_overwritten_by_update(self):
        path = self.root / MOD
        path.parent.mkdir(parents=True)
        path.write_bytes(b'mod-v1')
        self.install()
        with self.assertRaises(M.ModError):
            self.install({MOD: b'new-code'})
        self.assertEqual(path.read_bytes(), b'mod-v1')

    def test_updates_owned_files_and_removes_obsolete_files(self):
        self.install()
        self.install({MOD: b'mod-v2'})
        self.assertEqual((self.root / MOD).read_bytes(), b'mod-v2')
        self.assertFalse((self.root / CONFIG).exists())
        self.installer.remove('one', TITLE)
        self.assertFalse((self.root / MOD).exists())

    def test_external_edits_block_update_and_removal(self):
        self.install()
        (self.root / MOD).write_bytes(b'manual-edit')
        with self.assertRaises(M.ModError):
            self.install({MOD: b'mod-v2'})
        with self.assertRaises(M.ModError):
            self.installer.remove('one', TITLE)
        self.assertEqual((self.root / MOD).read_bytes(), b'manual-edit')
        self.assertTrue((self.root / CONFIG).exists())

    def test_running_guard_covers_install_update_and_remove(self):
        self.installer.is_running = lambda: True
        with self.assertRaises(M.ModError):
            self.install()
        self.installer.is_running = lambda: False
        self.install()
        self.installer.is_running = lambda: True
        with self.assertRaises(M.ModError):
            self.install({MOD: b'new'})
        with self.assertRaises(M.ModError):
            self.installer.remove('one', TITLE)
        self.assertEqual((self.root / MOD).read_bytes(), b'mod-v1')

    def test_failure_restores_previous_files_and_receipt(self):
        self.install()
        before = self.installer.installed(TITLE)
        original = M._write
        failed = False

        def fail_after_first_target(path, data):
            nonlocal failed
            if path == (self.root / CONFIG).resolve() and not failed:
                failed = True
                raise OSError('simulated write failure')
            return original(path, data)

        with patch.object(M, '_write', fail_after_first_target), self.assertRaises(OSError):
            self.install({MOD: b'new', CONFIG: b'new-config'})
        self.assertEqual((self.root / MOD).read_bytes(), b'mod-v1')
        self.assertEqual((self.root / CONFIG).read_bytes(), b'[Resolution]\nHeight=720')
        self.assertEqual(self.installer.installed(TITLE), before)
        self.assertFalse((self.root / 'state/pending.json').exists())

    def test_process_interruption_is_recovered_before_next_operation(self):
        self.install()
        original = M._write

        def crash(path, data):
            if path == (self.root / CONFIG).resolve():
                raise KeyboardInterrupt('simulated process death')
            return original(path, data)

        with patch.object(M, '_write', crash), self.assertRaises(KeyboardInterrupt):
            self.install({MOD: b'new', CONFIG: b'new-config'})
        self.assertEqual((self.root / MOD).read_bytes(), b'new')
        self.assertTrue((self.root / 'state/pending.json').exists())
        # A new installer instance represents a fresh application process.
        fresh = M.Installer(self.root / 'state', self.root / 'load', self.root / 'sdmc', lambda: False)
        fresh.remove('one', TITLE)
        self.assertFalse((self.root / MOD).exists())
        self.assertFalse((self.root / 'state/pending.json').exists())

    def test_changed_root_blocks_removal(self):
        self.install()
        self.installer.roots['load'] = self.root / 'different-load'
        with self.assertRaises(M.ModError):
            self.installer.remove('one', TITLE)
        self.assertTrue((self.root / MOD).exists())

    def test_recovery_never_touches_an_unstarted_destination(self):
        original = M._write
        def crash_before_second_action(path, data):
            if path.name == 'pending.json' and json.loads(data)['started'] == 2:
                destination = self.root / CONFIG
                destination.parent.mkdir(parents=True)
                destination.write_bytes(b'[Resolution]\nHeight=720')
                raise KeyboardInterrupt('crash before the second action starts')
            return original(path, data)
        with patch.object(M, '_write', crash_before_second_action), self.assertRaises(KeyboardInterrupt):
            self.install()
        self.installer.recover()
        self.assertFalse((self.root / MOD).exists())
        self.assertEqual((self.root / CONFIG).read_bytes(), b'[Resolution]\nHeight=720')


if __name__ == '__main__':
    unittest.main()
