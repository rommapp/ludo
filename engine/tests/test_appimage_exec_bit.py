"""An emulator AppImage without +x is still found, and gets +x.

Run with `python3 engine/tests/test_appimage_exec_bit.py`.

A freshly downloaded AppImage has no exec bit; checking X_OK alone made it
invisible. This walks EVERY entry in STANDALONE_EMULATORS that names
binaries, so an emulator added later is covered without touching this file.
"""

import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import (  # noqa: E402
    STANDALONE_EMULATORS, find_standalone_builds, find_standalone_executable)


def _check(key, spec):
    name = spec['binaries'][0]
    with tempfile.TemporaryDirectory() as d:
        app = Path(d) / f'{name}.AppImage'
        app.write_bytes(b'')
        os.chmod(app, 0o644)
        no_flatpak = dict(spec, flatpak_id=None)
        with mock.patch.object(sync_core, '_standalone_appimage_dirs',
                               return_value=[Path(d)]), \
             mock.patch('shutil.which', return_value=None):
            got = find_standalone_executable(key, no_flatpak)
            assert got == str(app), (key, got)
            assert os.access(app, os.X_OK), key
            os.chmod(app, 0o644)
            paths = [b['path'] for b in find_standalone_builds(key, no_flatpak)]
            assert str(app) in paths, (key, paths)

            # A build chosen by hand in Settings gets the bit too.
            os.chmod(app, 0o644)
            settings = mock.Mock()
            settings.get.return_value = str(app)
            assert find_standalone_executable(key, no_flatpak, settings) == str(app)
            assert os.access(app, os.X_OK), key


def test_every_standalone_emulator():
    keys = [k for k, s in STANDALONE_EMULATORS.items() if s.get('binaries')]
    assert keys
    for key in keys:
        _check(key, STANDALONE_EMULATORS[key])


if __name__ == '__main__':
    test_every_standalone_emulator()
    print('ok')
