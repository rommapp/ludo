"""Round-trip old settings, copy a profile, and keep the last good save on error."""
import configparser
import io
import locale
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class SettingsFileTests(unittest.TestCase):
    def setUp(self):
        home = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.dict(os.environ, HOME=home, USERPROFILE=home,
                                     APPDATA=home, LOCALAPPDATA=home, XDG_CONFIG_HOME=home))
        from romm_sync_engine.sync_core import SettingsManager
        self.settings = SettingsManager()

    def test_legacy_settings_survive_profile_copy_and_next_save(self):
        from romm_sync_engine import paths, profiles

        settings = self.settings
        codec = locale.getencoding()
        # Include text representable in the machine's old code page. No
        # credentials or real user files enter the fixture.
        label = 'Café 東京'.encode(codec, errors='replace').decode(codec)
        old_path = str(Path.home() / label)
        settings.config.set('Download', 'rom_directory', old_path)
        original = io.StringIO()
        settings.config.write(original)
        settings.config_file.write_bytes(original.getvalue().encode(codec))

        profile = profiles.create('New player')
        copied = configparser.ConfigParser()
        copied.read(paths.profile_dir(profile) / 'settings.ini', encoding='utf-8')
        self.assertEqual(copied['Download']['rom_directory'], old_path)

        settings.config.set('Download', 'rom_directory', 'discard this value')
        settings.load_settings()
        self.assertEqual(settings.config['Download']['rom_directory'], old_path)
        settings.save_settings()
        encoding = 'utf-8' if os.name == 'nt' else codec
        self.assertIn(old_path, settings.config_file.read_text(encoding=encoding))

    def test_failed_replace_preserves_previous_file(self):
        settings = self.settings
        before = settings.config_file.read_bytes()
        files = set(settings.config_dir.iterdir())
        settings.config.set('System', 'debug_mode', 'true')
        with patch('os.replace', side_effect=PermissionError('replace denied')):
            with self.assertRaises(PermissionError):
                settings.save_settings()
        self.assertEqual(settings.config_file.read_bytes(), before)
        self.assertEqual(set(settings.config_dir.iterdir()), files)
        if os.name == 'posix':
            self.assertEqual(stat.S_IMODE(settings.config_file.stat().st_mode), 0o600)


if __name__ == '__main__':
    result = unittest.main(verbosity=2, exit=False).result
    sys.exit(0 if result.wasSuccessful() and result.testsRun and not result.skipped else 1)
