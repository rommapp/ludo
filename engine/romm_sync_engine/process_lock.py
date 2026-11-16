"""Nonblocking, per-user process locks on a persistent local file.

The file is never unlinked or replaced. Its contents are diagnostic only;
ownership comes from the OS, including after a crash. Old clients which unlink
these files must be stopped before upgrading/downgrading (see docs/process-locks.md).
"""
import errno
import os
from pathlib import Path
import threading


if os.name == 'nt':
    import ctypes
    from ctypes import wintypes
    import msvcrt

    class _Overlapped(ctypes.Structure):
        _fields_ = [('Internal', ctypes.c_size_t),
                    ('InternalHigh', ctypes.c_size_t),
                    ('Offset', wintypes.DWORD), ('OffsetHigh', wintypes.DWORD),
                    ('hEvent', wintypes.HANDLE)]

    _kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    _lock_file = _kernel.LockFileEx
    _lock_file.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                          wintypes.DWORD, wintypes.DWORD,
                          ctypes.POINTER(_Overlapped)]
    _lock_file.restype = wintypes.BOOL
    _unlock_file = _kernel.UnlockFileEx
    _unlock_file.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                            wintypes.DWORD, ctypes.POINTER(_Overlapped)]
    _unlock_file.restype = wintypes.BOOL

    def _try_lock(fd):
        # Synchronous handle, exclusive + fail immediately, byte [0, 1).
        # LockFileEx permits locking beyond EOF, so no pre-lock write is needed.
        if _lock_file(msvcrt.get_osfhandle(fd), 3, 0, 1, 0,
                      ctypes.byref(_Overlapped())):
            return True
        error = ctypes.get_last_error()
        if error == 33:  # ERROR_LOCK_VIOLATION, not ERROR_ACCESS_DENIED (5)
            return False
        raise ctypes.WinError(error)

    def _unlock(fd):
        if not _unlock_file(msvcrt.get_osfhandle(fd), 0, 1, 0,
                            ctypes.byref(_Overlapped())):
            raise ctypes.WinError(ctypes.get_last_error())
else:
    import fcntl

    def _try_lock(fd):
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError as error:
            if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                return False
            raise

    def _unlock(fd):
        fcntl.flock(fd, fcntl.LOCK_UN)


class ProcessLock:
    """One descriptor, no recursive acquisition count; release is idempotent.

    False means actual native lock contention. Opening, writing, unlocking and
    other OS errors propagate. Use independent instances in independent
    processes; do not pass an acquired instance through fork.
    """
    def __init__(self, path):
        self.path = Path(path)
        self._fd = None
        self._guard = threading.Lock()

    def acquire(self, metadata=None):
        with self._guard:
            if self._fd is not None:
                return True
            # No O_TRUNC, no atomic replacement, and no writes by contenders.
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT |
                         getattr(os, 'O_BINARY', 0), 0o600)
            try:
                if not _try_lock(fd):
                    return False
                if metadata is not None:
                    data = memoryview(metadata)
                    while data:
                        written = os.write(fd, data)
                        if written == 0:
                            raise OSError(errno.EIO, 'short lock metadata write', str(self.path))
                        data = data[written:]
                    os.ftruncate(fd, os.lseek(fd, 0, os.SEEK_CUR))
                self._fd = fd
                fd = None
                return True
            except OSError as error:
                error.add_note(f'acquiring process lock: {self.path}')
                raise
            finally:
                if fd is not None:
                    os.close(fd)

    def release(self):
        with self._guard:
            if self._fd is None:
                return
            fd, self._fd = self._fd, None
            try:
                _unlock(fd)
            finally:
                os.close(fd)

    close = release

    def __del__(self):
        # Explicit release reports errors; finalization is only a fallback.
        try:
            self.release()
        except Exception:
            pass
