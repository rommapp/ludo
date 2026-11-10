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

    def test_handheld_profile_patches_only_known_keys(self):
        lines = ['; keep comment\r\n']
        section = ''
        for group, key in M.HANDHELD720:
            if group != section:
                lines.append(f'[{group}]\r\n')
                section = group
            lines.append(f'{key} = 999\r\n')
        lines.extend(['[Gameplay]\r\n', 'Fov = 50\r\n'])
        original = ''.join(lines).encode()
        self.installer.install(self.archive({MOD: b'code', CONFIG: original}), TITLE,
                               'one', 'Example', 'handheld720')
        after = (self.root / CONFIG).read_bytes()
        self.assertIn(b'Width = 1280\r\n', after)
        self.assertIn(b'MaxFPS = 60\r\n', after)
        self.assertIn(b'; keep comment\r\n', after)
        self.assertIn(b'Fov = 50\r\n', after)
        self.assertEqual(self.installer.installed(TITLE)[0]['profile'], 'handheld720')
        # Switching back uses the source bytes, not a previously patched file.
        self.installer.install(self.archive({MOD: b'code', CONFIG: original}), TITLE,
                               'one', 'Example', 'original')
        self.assertEqual((self.root / CONFIG).read_bytes(), original)

    def test_unrecognized_handheld_ini_is_rejected_before_target_write(self):
        with self.assertRaises(M.ModError):
            self.installer.install(self.archive(), TITLE, 'one', 'Example', 'handheld720')
        self.assertFalse((self.root / MOD).exists())


if __name__ == '__main__':
    unittest.main()
