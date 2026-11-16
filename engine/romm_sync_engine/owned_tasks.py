"""Keep an acquired process lock until its admitted work has finished."""
from contextlib import contextmanager
import threading


class OwnedTasks:
    def __init__(self, lock):
        self._lock = lock
        self._guard = threading.Lock()
        self._active = 0
        self._closing = False
        self.done = threading.Event()

    def _enter(self):
        with self._guard:
            if self._closing:
                return False
            self._active += 1
            return True

    def _leave(self):
        with self._guard:
            self._active -= 1
            self._release_if_idle()

    def _release_if_idle(self):
        if self._closing and not self._active and not self.done.is_set():
            try:
                self._lock.release()
            finally:
                self.done.set()

    @contextmanager
    def hold(self):
        admitted = self._enter()
        try:
            yield admitted
        finally:
            if admitted:
                self._leave()

    def start(self, target, args=(), *, name=None):
        # Reserve before Thread.start: close cannot release during scheduling.
        if not self._enter():
            return None

        def run():
            try:
                target(*args)
            finally:
                self._leave()

        try:
            thread = threading.Thread(target=run, daemon=True, name=name)
            thread.start()
        except BaseException:
            self._leave()
            raise
        return thread

    def close(self):
        """Stop admission; the last task releases. Does not block shutdown."""
        with self._guard:
            self._closing = True
            self._release_if_idle()
