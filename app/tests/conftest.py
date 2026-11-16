"""Keep the test run out of the real per-user configuration folders.

The backend resolves its config folder when it is imported and opens debug.log
there. Isolate all home/app-data roots before any test module imports it,
including on Windows. Tests that need their own HOME still set one per test.
"""
import os
import tempfile

_test_home = tempfile.mkdtemp(prefix="ludo-tests-home-")
for _name in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"):
    os.environ[_name] = _test_home
