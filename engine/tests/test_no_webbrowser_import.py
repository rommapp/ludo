#!/usr/bin/env python3
"""Importing the sync engine must not import webbrowser.

sync_core imported webbrowser at module scope and never referenced it. On
Bazzite that import crashes under Python 3.15, and because it runs while the
module is loading, Decky never finishes starting RomM sync. The name has no
callers, so the import is the whole bug.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


def main():
    # A fresh interpreter. If something above this already loaded webbrowser,
    # the assertion below would not prove sync_core left it alone.
    check('webbrowser is not already loaded', 'webbrowser' in sys.modules, False)

    import romm_sync_engine.sync_core as sync_core

    check('importing sync_core does not import webbrowser',
          'webbrowser' in sys.modules, False)
    check('webbrowser is not a sync_core global',
          hasattr(sync_core, 'webbrowser'), False)

    if FAILURES:
        print(f"\n{len(FAILURES)} failed")
        return 1
    print("\nall ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
