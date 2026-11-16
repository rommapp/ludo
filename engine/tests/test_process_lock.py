#!/usr/bin/env python3
"""Native process ownership contracts. Run directly (not through pytest)."""
import errno
import gc
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))
_sandbox = tempfile.TemporaryDirectory(prefix='ludo-lock-profile-')
os.environ.update(HOME=_sandbox.name, USERPROFILE=_sandbox.name,
                  LOCALAPPDATA=str(Path(_sandbox.name) / 'Local'),
                  APPDATA=str(Path(_sandbox.name) / 'Roaming'))
from romm_sync_engine import process_lock, sync_core
from romm_sync_engine.process_lock import ProcessLock
from romm_sync_engine.owned_tasks import OwnedTasks
from lock_process_helper import LockProcess, TIMEOUT


class ProcessLockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ludo lock öğ %50 ')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'autosync.lock'

    def child(self, kind='plain'):
        child = LockProcess(self.path, kind)
        self.addCleanup(child.close)
        return child

    def lock(self):
        lock = ProcessLock(self.path)
        self.addCleanup(lock.release)
        return lock

    def test_imports_this_checkout(self):
        self.assertEqual(Path(process_lock.__file__).resolve().parent.parent, ENGINE)
        self.assertEqual(Path(sync_core.__file__).resolve().parent.parent, ENGINE)

    def test_processes_contend_and_release_preserves_file_identity(self):
        owner = self.child()
        self.assertTrue(owner.acquired)
        identity = self.path.stat().st_ino
        contender = self.child()
        self.assertFalse(contender.acquired)
        owner.command('release')
        self.assertEqual(self.path.read_bytes(), b'process-test\n')
        self.assertTrue(contender.command('acquire')['acquired'])
        contender.command('release')
        self.assertEqual(self.path.stat().st_ino, identity)

    def test_three_processes_loser_cleanup_never_unlinks_owner(self):
        owner = self.child('auto')
        self.assertTrue(owner.acquired)
        identity = self.path.stat().st_ino
        loser = self.child('auto')
        self.assertFalse(loser.acquired)
        loser.command('release')
        loser.command('discard')
        self.assertEqual(self.path.stat().st_ino, identity)
        third = self.child('auto')
        self.assertFalse(third.acquired)
        owner.command('release')
        metadata = self.path.read_bytes()
        self.assertIn(f'{owner.process.pid}:process-test:'.encode(), metadata)
        self.assertTrue(third.command('acquire')['acquired'])

    def test_repeated_acquire_does_not_drop_lock_or_rewrite_metadata(self):
        lock = self.lock()
        self.assertTrue(lock.acquire(b'first\n'))
        self.assertTrue(lock.acquire(b'second\n'))
        self.assertFalse(self.child().acquired)
        lock.release()
        lock.release()
        self.assertEqual(self.path.read_bytes(), b'first\n')
        self.assertTrue(lock.acquire())
        self.assertFalse(self.child().acquired)

    def test_same_process_independent_instances_contend(self):
        first, second = self.lock(), self.lock()
        self.assertTrue(first.acquire())
        self.assertFalse(second.acquire())
        second.release()
        self.assertFalse(self.child().acquired)
        first.release()
        self.assertTrue(second.acquire())

    def test_unacquired_finalizer_does_not_remove_existing_file(self):
        owner = self.child()
        self.assertTrue(owner.acquired)
        unused = ProcessLock(self.path)
        del unused
        gc.collect()
        self.assertTrue(self.path.exists())
        self.assertFalse(self.child().acquired)

    def test_crash_and_forced_termination_release_ownership(self):
        for crash in ('exit', 'kill'):
            with self.subTest(crash=crash):
                owner = self.child()
                self.assertTrue(owner.acquired)
                identity = self.path.stat().st_ino
                if crash == 'exit':
                    owner.process.stdin.write('crash\n')
                    owner.process.stdin.flush()
                else:
                    owner.process.kill()
                owner.process.wait(timeout=TIMEOUT)
                lock = self.lock()
                deadline = time.monotonic() + TIMEOUT
                # Windows documents that kernel cleanup may lag process exit.
                while not lock.acquire():
                    self.assertLess(time.monotonic(), deadline)
                    threading.Event().wait(.02)
                self.assertEqual(self.path.stat().st_ino, identity)
                lock.release()

    def test_distinct_paths_do_not_serialize_sync_and_installs(self):
        owner = self.child()
        self.assertTrue(owner.acquired)
        other = ProcessLock(self.path.with_name('installs.lock'))
        self.addCleanup(other.release)
        self.assertTrue(other.acquire())

    def test_real_access_denied_is_not_contention(self):
        self.path.write_bytes(b'preserved')
        self.path.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        self.addCleanup(self.path.chmod, stat.S_IRUSR | stat.S_IWUSR)
        with self.assertRaises(PermissionError):
            self.lock().acquire()
        self.assertEqual(self.path.read_bytes(), b'preserved')

    def test_invalid_path_is_an_error(self):
        for path in (self.path.parent, self.path / 'missing-parent'):
            with self.subTest(path=path), self.assertRaises(OSError):
                ProcessLock(path).acquire()

    def test_native_io_failure_propagates_and_closes_descriptor(self):
        for code in (errno.EIO, errno.ENOLCK, errno.EACCES):
            with patch.object(process_lock, '_try_lock', side_effect=OSError(code, 'injected I/O')):
                with self.assertRaises(OSError) as caught:
                    self.lock().acquire()
                self.assertEqual(caught.exception.errno, code)
            child = self.child()
            self.assertTrue(child.acquired)
            child.command('release')

    def test_metadata_failure_releases_ownership(self):
        self.path.write_bytes(b'previous')
        with patch.object(process_lock.os, 'write', side_effect=OSError(errno.ENOSPC, 'disk full')):
            with self.assertRaises(OSError):
                self.lock().acquire(b'new')
        self.assertEqual(self.path.read_bytes(), b'previous')
        self.assertTrue(self.child().acquired)

    def test_auto_wrapper_reports_permission_error(self):
        self.path.mkdir()
        with patch.object(sync_core, 'config_dir', return_value=self.path.parent):
            with self.assertRaises(OSError):
                sync_core.AutoSyncLock().acquire('test')

    def test_admitted_work_retains_lock_after_close_and_refuses_late_work(self):
        lock = self.lock()
        self.assertTrue(lock.acquire())
        owner = OwnedTasks(lock)
        entered, finish = threading.Event(), threading.Event()
        self.addCleanup(finish.set)
        def work():
            entered.set()
            if not finish.wait(TIMEOUT):
                raise AssertionError('work not released')
        thread = owner.start(work)
        self.assertTrue(entered.wait(TIMEOUT))
        owner.close()
        owner.close()
        self.assertIsNone(owner.start(lambda: self.fail('late work ran')))
        self.assertFalse(self.child().acquired)
        finish.set()
        thread.join(TIMEOUT)
        self.assertTrue(owner.done.wait(TIMEOUT))
        self.assertTrue(self.child().acquired)

    def test_synchronous_work_exception_releases_a_closed_owner(self):
        lock = self.lock()
        self.assertTrue(lock.acquire())
        owner = OwnedTasks(lock)
        with self.assertRaisesRegex(ValueError, 'failed work'):
            with owner.hold() as admitted:
                self.assertTrue(admitted)
                owner.close()
                self.assertFalse(self.child().acquired)
                raise ValueError('failed work')
        self.assertTrue(owner.done.is_set())
        self.assertTrue(self.child().acquired)

    def test_thread_start_failure_does_not_leak_reservation(self):
        lock = self.lock()
        self.assertTrue(lock.acquire())
        owner = OwnedTasks(lock)
        with patch.object(threading.Thread, 'start', side_effect=RuntimeError('no threads')):
            with self.assertRaises(RuntimeError):
                owner.start(lambda: None)
        owner.close()
        self.assertTrue(owner.done.is_set())
        self.assertTrue(self.child().acquired)


class AutoSyncOwnershipTests(unittest.TestCase):
    setUp = ProcessLockTests.setUp
    child = ProcessLockTests.child
    # These integration cases use the real manager admission/stop methods and
    # real OS lock; only external sync I/O is a controlled local test operation.
    def manager(self):
        from types import SimpleNamespace
        m = sync_core.AutoSyncManager.__new__(sync_core.AutoSyncManager)
        with patch.object(sync_core, 'config_dir', return_value=self.path.parent):
            m.lock = sync_core.AutoSyncLock()
        self.addCleanup(m.lock.release)
        m.enabled = False
        m._sync_lifecycle = threading.RLock()
        m._sync_ownership = None
        m._SYNC_DRAIN_TIMEOUT = .05
        m.instance_id = 'manager-test'
        m.should_stop = threading.Event()
        m.blocked_by_other_instance = False
        m._session_sync_lock = threading.Lock()
        m.session_epoch = 0
        m.observer = None
        m.log = lambda message: None
        m.settings = SimpleNamespace(config={'AutoSync': {}},
                                     get=lambda *args: 'false', save_settings=lambda: None)
        m.play_sessions = SimpleNamespace(sync_async=lambda: None)
        m.romm_client = SimpleNamespace(authenticated=True)
        for name in ('start_upload_worker', 'start_file_monitoring',
                     'start_retroarch_monitoring', 'start_playlist_monitoring',
                     'refresh_save_dirs', 'flush_pending_states', '_save_upload_fingerprints'):
            setattr(m, name, lambda: None)
        return m

    def test_stop_keeps_lock_through_io_and_rejects_late_session_triggers(self):
        manager = self.manager()
        entered, finish = threading.Event(), threading.Event()
        calls = []
        self.addCleanup(finish.set)
        def io(*args):
            calls.append(args)
            entered.set()
            if not finish.wait(TIMEOUT):
                raise AssertionError('sync I/O not released')
            self.path.with_name('sync-result').write_text('finished')
        manager._run_negotiated_save_sync = io
        manager.start_auto_sync()
        self.assertTrue(entered.wait(TIMEOUT))
        manager.stop_auto_sync()
        self.assertFalse(manager.enabled)
        self.assertFalse(self.child().acquired)
        manager.trigger_session_save_sync('too late')
        with self.assertRaisesRegex(RuntimeError, 'ownership is stopping'):
            manager.run_negotiated_save_sync(trigger='late RPC')
        manager.start_auto_sync()  # Cannot clear stop while old work drains.
        self.assertTrue(manager.should_stop.is_set())
        self.assertFalse(manager.enabled)
        finish.set()
        self.assertTrue(manager._sync_ownership.done.wait(TIMEOUT))
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.path.with_name('sync-result').read_text(), 'finished')
        contender = self.child()
        self.assertTrue(contender.acquired)
        contender.command('release')
        # The same manager must restart once draining completes, then release
        # again without retaining an old stop event or ownership reservation.
        entered.clear()
        manager.start_auto_sync()
        self.assertTrue(manager.enabled)
        self.assertFalse(manager.should_stop.is_set())
        self.assertTrue(entered.wait(TIMEOUT))
        manager.stop_auto_sync()
        self.assertTrue(manager._sync_ownership.done.wait(TIMEOUT))
        self.assertEqual(len(calls), 2)
        self.assertTrue(self.child().acquired)

    def test_queued_session_cannot_start_after_stop_releases_ownership(self):
        manager = self.manager()
        scheduled, run = threading.Event(), threading.Event()
        calls = []
        manager._run_negotiated_save_sync = lambda *args: calls.append(args)
        original = OwnedTasks.start
        def delayed(owner, target, args=(), **kwargs):
            def queued():
                scheduled.set()
                if not run.wait(TIMEOUT):
                    raise AssertionError('queued sync not released')
                target(*args)
            return original(owner, queued, **kwargs)
        self.addCleanup(run.set)
        with patch.object(OwnedTasks, 'start', delayed):
            manager.start_auto_sync()
        self.assertTrue(scheduled.wait(TIMEOUT))
        manager.stop_auto_sync()
        self.assertFalse(self.child().acquired)
        run.set()
        self.assertTrue(manager._sync_ownership.done.wait(TIMEOUT))
        # The queued task keeps ownership until it exits; its late I/O is refused.
        self.assertEqual(len(calls), 0)
        self.assertTrue(self.child().acquired)

    def test_manager_io_error_is_not_reported_as_another_owner(self):
        manager = self.manager()
        self.path.mkdir()
        with self.assertRaises(OSError):
            manager.start_auto_sync()
        self.assertFalse(manager.blocked_by_other_instance)
        self.assertFalse(manager.enabled)


if __name__ == '__main__':
    unittest.main(verbosity=2)
