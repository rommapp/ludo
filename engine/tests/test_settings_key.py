#!/usr/bin/env python3
"""Saved credentials decrypt in every Ludo on the machine.

The desktop app and the Decky plugin share ~/.config/ludo, and both run as the
user, but Decky leaves $USER/$LOGNAME as 'root'. The key comes from the real
account, so a token either one saves, the other reads.

Asserted here:
  * a token saved with USER=root reads back with the real USER, and vice versa;
  * a token saved under the old environment-derived key ('root') still reads.
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ENGINE = str(Path(__file__).resolve().parents[1])
FAILURES = []

PROG = r'''
import sys; sys.path.insert(0, sys.argv[1])
from romm_sync_engine import sync_core
from romm_sync_engine.sync_core import SettingsManager
if sys.argv[3] == "legacy-write":       # what pre-fix builds did under Decky
    sync_core.SettingsManager._user = staticmethod(lambda: "root")
s = SettingsManager()
if sys.argv[2] == "write":
    s.set("RomM", "client_token", "rmm_secret")
    print(s.config.get("RomM", "client_token")[:6])
else:
    print(s.get("RomM", "client_token", ""))
'''


def run(home, action, user, mode="normal"):
    # A temp HOME hides ~/.local site-packages, so hand down our import path.
    env = {**os.environ, "HOME": home, "USER": user, "LOGNAME": user,
           "PYTHONPATH": os.pathsep.join(p for p in sys.path if p)}
    return subprocess.run([sys.executable, "-c", PROG, ENGINE, action, mode],
                          env=env, capture_output=True, text=True).stdout.strip().splitlines()[-1]


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


def main():
    me = os.environ.get("USER") or "user"
    for writer, reader in (("root", me), (me, "root")):
        home = tempfile.mkdtemp()
        check(f"saved encrypted (USER={writer})", run(home, "write", writer), "gAAAAA")
        check(f"USER={writer} -> USER={reader}", run(home, "read", reader), "rmm_secret")
    home = tempfile.mkdtemp()
    run(home, "write", "root", "legacy-write")
    check("old 'root'-keyed token still reads", run(home, "read", "root"), "rmm_secret")
    if FAILURES:
        print(f"{len(FAILURES)} check(s) failed: {FAILURES}")
        return 1
    print("all checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
