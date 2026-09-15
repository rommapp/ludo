#!/usr/bin/env python3
"""Coming back online must take as much evidence as going offline did.

The offline edge was debounced (three consecutive failed probes); the online
edge was not. One probe that happened to come back was enough to declare the
server reachable, announce "Back online", and kick a save-sync flush that then
died on DNS. On a handheld that is genuinely offline the probe loop runs every
25s forever, so a single misleading answer is reached sooner or later and the
user gets nagged in a loop -- Covin90/romm-retroarch-sync#23, where the reported
log shows a reconnect flush minutes after the device latched offline and with
the radio never touched.

Also covers what counts as an answer: a captive portal returns 200 text/html for
any URL you ask it for, and the old `status_code < 500` test read that as RomM.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import ReachabilityLatch, RomMClient

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


class _Response:
    def __init__(self, status_code, ctype='application/json'):
        self.status_code = status_code
        self.headers = {'Content-Type': ctype} if ctype else {}


class _Session:
    """Answers every GET with the queued response, or raises it."""
    def __init__(self, answer):
        self._answer = answer

    def get(self, *a, **kw):
        if isinstance(self._answer, Exception):
            raise self._answer
        return self._answer


def _client(answer):
    c = object.__new__(RomMClient)
    c.base_url = 'https://romm.example'
    c.session = _Session(answer)
    return c


def test_startup_is_not_a_reconnect():
    flushes = []
    latch = ReachabilityLatch(on_reconnect=lambda: flushes.append(1))
    # First probe ever: online at once (the UI must not sit in a fictitious
    # offline state), but no reconnect edge -- nothing was queued to flush.
    check('startup edge', latch.note_success(), False)
    check('startup online', latch.online, True)
    check('startup flushes', len(flushes), 0)


def test_offline_needs_three_misses():
    latch = ReachabilityLatch()
    latch.note_success()
    check('one miss latches', latch.note_failure(), False)
    check('still online after 1', latch.online, True)
    check('two misses latch', latch.note_failure(), False)
    check('three misses latch', latch.note_failure(), True)
    check('offline after 3', latch.online, False)


def test_isolated_success_while_offline_is_not_a_reconnect():
    """The bug. Offline, and the probe loop gets one answer out of the void."""
    flushes = []
    latch = ReachabilityLatch(on_reconnect=lambda: flushes.append(1))
    latch.note_success()
    for _ in range(ReachabilityLatch.FAILS_TO_OFFLINE):
        latch.note_failure()
    check('offline', latch.online, False)

    check('lone success reconnects', latch.note_success(), False)
    check('still offline', latch.online, False)
    check('no flush fired', len(flushes), 0)

    # ...and the next probe misses again, as it would on a device whose wifi is
    # still off. The streak resets, so a drip of lucky answers never adds up.
    latch.note_failure()
    check('lone success #2 reconnects', latch.note_success(), False)
    check('still offline after drip', latch.online, False)
    check('still no flush', len(flushes), 0)


def test_two_consecutive_successes_do_reconnect():
    flushes = []
    latch = ReachabilityLatch(on_reconnect=lambda: flushes.append(1))
    latch.note_success()
    for _ in range(ReachabilityLatch.FAILS_TO_OFFLINE):
        latch.note_failure()
    latch.note_success()
    check('second success reconnects', latch.note_success(), True)
    check('online again', latch.online, True)
    check('flushed once', len(flushes), 1)
    # The edge is one-shot: further successes are not reconnects.
    check('third success re-edges', latch.note_success(), False)
    check('flushed still once', len(flushes), 1)


def test_confirmed_success_reconnects_immediately():
    """navigator said the link is back AND a real API call succeeded on it."""
    flushes = []
    latch = ReachabilityLatch(on_reconnect=lambda: flushes.append(1))
    latch.note_success()
    latch.latch_offline('device reports no network')
    check('latched', latch.online, False)
    check('confirmed reconnects', latch.note_success(confirmed=True), True)
    check('flushed', len(flushes), 1)


def test_probe_success_does_not_overwrite_device_offline():
    """A flaky answer must not erase the OS's authoritative 'no network'.

    It used to: _note_reachable set device_online True unconditionally, and
    nothing put it back, because the event that would have -- navigator 'online'
    -- never fires if the user never touched the radio. The status payload then
    reported 'server_unreachable' to a user who was plainly in airplane mode.
    """
    latch = ReachabilityLatch()
    latch.note_success()
    latch.set_device_online(False)
    latch.latch_offline('device reports no network')
    latch.note_success()          # unconfirmed, ignored
    check('device still offline', latch.device_online, False)
    latch.note_success()          # confirmed by repetition
    check('device online after real reconnect', latch.device_online, True)


def test_flush_failure_does_not_swallow_the_edge():
    def boom():
        raise RuntimeError('sync engine is gone')
    latch = ReachabilityLatch(on_reconnect=boom)
    latch.note_success()
    latch.latch_offline()
    latch.note_success()
    check('edge survives a raising callback', latch.note_success(), True)
    check('online', latch.online, True)


def test_is_reachable_accepts_only_the_api():
    check('200 json',        _client(_Response(200)).is_reachable(), True)
    check('401 (token gone)', _client(_Response(401)).is_reachable(), True)
    check('403',             _client(_Response(403)).is_reachable(), True)
    # The captive portal: a 200 that is not the API.
    check('200 html portal', _client(_Response(200, 'text/html; charset=utf-8')).is_reachable(), False)
    check('200 no ctype',    _client(_Response(200, None)).is_reachable(), False)
    check('404',             _client(_Response(404)).is_reachable(), False)
    check('502',             _client(_Response(502)).is_reachable(), False)
    check('network error',   _client(OSError('name resolution failed')).is_reachable(), False)


def main():
    test_startup_is_not_a_reconnect()
    test_offline_needs_three_misses()
    test_isolated_success_while_offline_is_not_a_reconnect()
    test_two_consecutive_successes_do_reconnect()
    test_confirmed_success_reconnects_immediately()
    test_probe_success_does_not_overwrite_device_offline()
    test_flush_failure_does_not_swallow_the_edge()
    test_is_reachable_accepts_only_the_api()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) failed: {', '.join(FAILURES)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
