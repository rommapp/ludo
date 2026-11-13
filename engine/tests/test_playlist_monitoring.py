#!/usr/bin/env python3
"""Playlist polling must back off without delaying shutdown (issue #83)."""
import sys
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import sync_core

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


class BoundedStop:
    """Run exactly two polls, even if a regression bypasses every wait."""
    def __init__(self):
        self.polls = 0
        self.waits = []

    def is_set(self):
        self.polls += 1
        return self.polls > 2

    def wait(self, timeout):
        self.waits.append(timeout)
        return False


class ObservedStop(threading.Event):
    def __init__(self):
        super().__init__()
        self.waiting = threading.Event()
        self.waits = []

    def wait(self, timeout=None):
        self.waits.append(timeout)
        self.waiting.set()
        return super().wait(timeout)


def manager(find_config, stop):
    m = sync_core.AutoSyncManager.__new__(sync_core.AutoSyncManager)
    m.should_stop = stop
    m.retroarch = SimpleNamespace(find_retroarch_config_dir=find_config)
    m.log = Mock()
    m.get_recent_from_playlist = Mock(return_value='/roms/game.zip')
    m.sync_saves_for_rom_file = Mock()
    return m


def monitor_target(m):
    with patch.object(sync_core.threading, 'Thread') as thread:
        m.start_playlist_monitoring()
    check('monitor remains a daemon', thread.call_args.kwargs['daemon'], True)
    return thread.call_args.kwargs['target']


def run_bounded(m):
    target = monitor_target(m)
    # An old sleep must neither slow these checks nor hide a missing event wait.
    with patch.object(sync_core, 'time', SimpleNamespace(sleep=lambda _: None)):
        target()


def check_interruptible(label, config, interval):
    stop = ObservedStop()
    find = Mock()
    m = manager(find, stop)
    target = monitor_target(m)
    errors = []

    def run():
        try:
            target()
        except BaseException as error:
            errors.append(error)

    # Bound a broken implementation too: missing-config spins stop after two
    # lookups, and old sleeps are harmless no-ops instead of multi-second stalls.
    def bounded_find():
        if find.call_count > 2:
            stop.set()
        if interval == 10:
            raise RuntimeError('config unavailable')
        return config

    find.side_effect = bounded_find
    with patch.object(sync_core, 'time', SimpleNamespace(sleep=lambda _: None)):
        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        try:
            check(f'{label}: enters event wait', stop.waiting.wait(1), True)
            check(f'{label}: no polling while waiting', find.call_count, 1)
            stop.set()
            worker.join(timeout=1)
            check(f'{label}: stop interrupts wait', worker.is_alive(), False)
            check(f'{label}: wait interval', stop.waits, [interval])
            check(f'{label}: worker errors', errors, [])
        finally:
            stop.set()
            worker.join(timeout=1)


def main():
    stop = BoundedStop()
    find = Mock(return_value=None)
    m = manager(find, stop)
    run_bounded(m)
    check('missing config retries', find.call_count, 2)
    check('every missing-config poll waits three seconds', stop.waits, [3, 3])
    check('missing config does not process playlists', m.get_recent_from_playlist.call_count, 0)

    with tempfile.TemporaryDirectory() as td:
        config = Path(td)
        history = config / 'content_history.lpl'
        history.write_text('{}')
        playlist = config / 'games.lpl'
        playlist.write_text('{}')
        stop = BoundedStop()
        m = manager(Mock(return_value=config), stop)
        run_bounded(m)
        check('normal polling retains three-second interval', stop.waits, [3, 3])
        check('history skipped and unchanged playlist processed once',
              m.get_recent_from_playlist.call_args_list,
              [((playlist,), {})])
        check('library launch still syncs saves',
              m.sync_saves_for_rom_file.call_args_list,
              [(('/roms/game.zip',), {})])

        check_interruptible('normal polling', config, 3)

    stop = BoundedStop()
    find = Mock(side_effect=[RuntimeError('config unavailable'), None])
    m = manager(find, stop)
    run_bounded(m)
    check('errors back off ten seconds then retry normally', stop.waits, [10, 3])
    check('errors remain logged', m.log.call_args_list,
          [(('Playlist monitoring error: config unavailable',), {})])

    check_interruptible('missing config', None, 3)
    check_interruptible('error backoff', None, 10)
    print('FAILURES:', FAILURES if FAILURES else 'none')
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
