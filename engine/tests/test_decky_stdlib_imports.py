"""The engine doesn't need stdlib modules Decky Loader's frozen Python lacks.

Run with `python3 engine/tests/test_decky_stdlib_imports.py`.

Decky Loader 3.3 bundles Python 3.14 with only part of the stdlib; a missing
module is loaded from the system's stdlib instead. On Fedora 45 (Python 3.15)
`webbrowser` and `getpass` don't load there, so the plugin failed to start or
couldn't decrypt credentials.
"""
import getpass
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

FAILURES = []


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


def main():
    src = (Path(__file__).resolve().parents[1] / 'romm_sync_engine' / 'sync_core.py').read_text()
    check('no webbrowser import', 'import webbrowser' in src, False)
    check('no getpass import', 'import getpass' in src, False)
    from romm_sync_engine.sync_core import SettingsManager
    saved = {k: os.environ.pop(k, None) for k in ('LOGNAME', 'USER', 'LNAME', 'USERNAME')}
    try:
        check('pwd fallback matches getpass', SettingsManager._env_user(), getpass.getuser())
        os.environ['USER'] = 'root'
        check('$USER wins like getpass', SettingsManager._env_user(), getpass.getuser())
        os.environ['LOGNAME'] = 'deck'
        check('$LOGNAME first like getpass', SettingsManager._env_user(), getpass.getuser())
    finally:
        for k, v in saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
