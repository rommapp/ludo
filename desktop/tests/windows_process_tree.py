"""Native Windows checks for Electron-owned process trees and their owner pipe."""
import faulthandler
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import unittest

import psutil

BACKEND = Path(__file__).resolve().parents[1] / 'backend'


class WindowsProcesses(unittest.TestCase):
    def test_owned_tree(self):
        # The unrelated process even has the same executable as the backend.
        with subprocess.Popen([sys.executable, __file__, 'leaf']) as external:
            try:
                for mode in ('quit', 'owner-eof', 'stalled-owner-eof', 'forced'):
                    with self.subTest(mode=mode):
                        self.exercise_tree(mode)
                        self.assertIsNone(external.poll())
            finally:
                external.terminate()

    def exercise_tree(self, mode):
        # The leaf inherits membership through the intermediate child. None
        # of these identifiers is used to locate processes for termination.
        with subprocess.Popen([sys.executable, __file__, 'owner', mode], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, text=True) as proc:
            try:
                lines = queue.Queue()
                threading.Thread(target=lambda: lines.put(proc.stdout.readline()),
                                 daemon=True).start()
                ready = lines.get(timeout=8)
                self.assertTrue(ready, 'owner exited before its tree was ready')
                middle_pid, leaf_pid = map(int, ready.split())
                descendants = [psutil.Process(pid) for pid in (middle_pid, leaf_pid)]
                since = time.monotonic()
                if mode == 'forced':
                    proc.kill()  # original Popen handle
                elif mode in ('owner-eof', 'stalled-owner-eof'):
                    proc.stdin.close()
                else:
                    proc.stdin.write('Q')
                    proc.stdin.flush()
                self.assertEqual(proc.wait(14), 1 if mode in ('forced', 'stalled-owner-eof') else 0)
                _, remaining = psutil.wait_procs(descendants, timeout=2)
                self.assertFalse(remaining)
                self.assertLess(time.monotonic() - since, 15)
            finally:
                if proc.poll() is None:
                    proc.kill()


def fixture_process(role):
    if role == 'owner':
        sys.path.insert(0, str(BACKEND))
        from windows_lifetime import watch_owner
        stopping = watch_owner()
        middle = subprocess.Popen([sys.executable, __file__, 'middle'], stdout=subprocess.PIPE)
        print(middle.pid, middle.stdout.readline().decode().strip(), flush=True)
        stopping.wait()
        if sys.argv[2] == 'stalled-owner-eof':
            time.sleep(90)  # exercise the backend watchdog
    elif role == 'middle':
        # Old POSIX launch contract: helper stdin is empty. The Windows
        # backend has a control pipe, but it must keep that pipe private.
        assert sys.stdin.buffer.read(1) == b''
        leaf = subprocess.Popen([sys.executable, __file__, 'leaf'])
        print(leaf.pid, flush=True)
        time.sleep(90)
    else:
        time.sleep(90)


if __name__ == '__main__':
    if len(sys.argv) > 1:
        fixture_process(sys.argv[1])
    else:
        faulthandler.dump_traceback_later(60, exit=True)
        result = unittest.main(defaultTest='WindowsProcesses.test_owned_tree', verbosity=2, exit=False).result
        sys.exit(0 if result.wasSuccessful() and result.testsRun and not result.skipped else 1)
