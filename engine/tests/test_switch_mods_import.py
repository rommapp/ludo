#!/usr/bin/env python3
"""Importing mod helpers must not require their POSIX transaction lock."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class ModImportTests(unittest.TestCase):
    def test_missing_fcntl_allows_import_but_refuses_transactions(self):
        # A fresh interpreter with fcntl explicitly unavailable, not a fake
        # lock implementation. Native Windows backend tests use the real OS.
        program = '''
import importlib.abc
from pathlib import Path
import sys

class NoFcntl(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'fcntl':
            raise ModuleNotFoundError('fcntl is unavailable', name='fcntl')

sys.modules.pop('fcntl', None)
sys.meta_path.insert(0, NoFcntl())
sys.path.insert(0, sys.argv[1])
from romm_sync_engine import switch_mods

root = Path.cwd()
installer = switch_mods.Installer(root / 'state', root / 'load', root / 'sdmc', lambda: False)
for operation in (installer.recover,
                  lambda: installer.install(root / 'missing.zip', '0100F2C0115B6000', 'mod', 'Mod'),
                  lambda: installer.remove('mod', '0100F2C0115B6000')):
    try:
        operation()
    except ModuleNotFoundError as error:
        assert error.name == 'fcntl', error
    else:
        raise AssertionError('mod transaction ran without its lock')
assert not (root / 'state').exists(), 'state was touched before locking was available'
'''
        with tempfile.TemporaryDirectory(prefix='ludo-mod-import-') as home:
            env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
            for key in ('HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'):
                env[key] = home
            result = subprocess.run(
                [sys.executable, '-c', program, str(Path(__file__).resolve().parents[1])],
                cwd=home, env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
