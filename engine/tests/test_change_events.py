#!/usr/bin/env python3
"""The engine nudges the UI when something it shows changes.

The UI's background checks (toasts, save conflicts, session sync, connection
state) run when the engine says a topic changed, with only a slow safety poll
behind them. So each of those changes must actually publish, and a burst must
still end with a nudge after its last change -- otherwise the UI shows the
second-to-last state until the safety poll, up to 30s later.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import events, sync_core

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


def settle():
    time.sleep(events.MIN_INTERVAL + 0.15)


def main():
    seen = []
    off = events.add_sink(seen.append)
    try:
        settle()
        seen.clear()

        # A queued toast nudges 'notifications'.
        sync_core.push_notification('sync', 'Title', 'Body')
        settle()
        check('a queued toast nudges notifications', seen.count('notifications'), 1)
        sync_core.drain_notifications()

        # Connection edges nudge; repeating the same state does not.
        seen.clear()
        latch = sync_core.ReachabilityLatch()
        latch.latch_offline('test')
        settle()
        check('going offline nudges connection', seen.count('connection'), 1)
        seen.clear()
        latch.latch_offline('again')
        settle()
        check('staying offline is quiet', seen.count('connection'), 0)
        latch.note_success(confirmed=True)
        settle()
        check('coming back nudges connection', seen.count('connection'), 1)

        # A burst folds into a leading nudge plus one trailing one.
        seen.clear()
        settle()
        for _ in range(20):
            events.publish('connection')
        check('burst: first nudge goes out at once', seen.count('connection'), 1)
        settle()
        check('burst: one trailing nudge after the last change', seen.count('connection'), 2)

        # A failing sink doesn't stop the others or raise into the engine.
        def boom(_):
            raise RuntimeError('sink broke')
        off_boom = events.add_sink(boom)
        seen.clear()
        settle()
        events.publish('session')
        check('a broken sink does not block the rest', seen.count('session'), 1)
        off_boom()
    finally:
        off()

    seen.clear()
    events.publish('session')
    settle()
    check('a removed sink hears nothing', seen, [])

    if FAILURES:
        print(f"\n{len(FAILURES)} failed")
        return 1
    print("\nall ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
