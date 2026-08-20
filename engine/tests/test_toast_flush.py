#!/usr/bin/env python3
"""Coalesced sync toasts must survive a shutdown.

Save/state toasts are merged in a short window so one game's activity is one
message. The merge timer is a daemon thread on purpose -- it must never hold
up a plugin shutdown -- but that means a shutdown inside the window drops the
announcement. That is the worst moment to lose one: the last thing a session
does is upload the save the player just made.

Observed live: upload accepted at 14:35:46.796, auto-sync stopped at
14:35:46.832, no toast and no activity row. The save was safely on the server
and the user had every reason to conclude it was not.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import sync_core

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


def main():
    emitted = []
    real_emit = sync_core._emit_game_sync_toast
    sync_core._emit_game_sync_toast = (
        lambda title, body, rom_id=None, has_cover=False:
        emitted.append((title, body, rom_id)))
    try:
        sync_core.queue_game_sync_toast(4242, 'Metroid Dread', saves_up=1)
        # Still inside the coalesce window: nothing has been said yet. This is
        # the state the process was killed in.
        check('a queued toast is held, not sent', emitted, [])

        sync_core.flush_pending_game_toasts()
        check('shutdown flushes it', len(emitted), 1)
        check('with the right game', emitted[0][1], 'Metroid Dread')
        check('and says what happened', emitted[0][0], 'Save uploaded')
        check('and carries the rom_id for the cover', emitted[0][2], 4242)

        # The entry is consumed, so a later timer firing cannot double-toast.
        emitted.clear()
        sync_core.flush_pending_game_toasts()
        check('flushing twice says nothing twice', emitted, [])

        # A flush with nothing pending is a no-op, not an error -- it runs on
        # every shutdown, including the quiet ones.
        sync_core.flush_pending_game_toasts()
        check('an empty flush is harmless', emitted, [])

        # Counts merged before the flush stay merged.
        sync_core.queue_game_sync_toast(7, 'Game', saves_up=1)
        sync_core.queue_game_sync_toast(7, 'Game', saves_down=1)
        sync_core.flush_pending_game_toasts()
        check('merged directions make one message', len(emitted), 1)
        check('described as a sync, not an upload', emitted[0][0], 'Saves synced')
    finally:
        sync_core._emit_game_sync_toast = real_emit

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all toast-flush checks passed")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
