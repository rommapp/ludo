"""Lifetime of an Electron-owned Windows backend (standalone CLI is independent)."""
import ctypes
from ctypes import wintypes
import os
import threading
import time


class _BasicLimits(ctypes.Structure):
    _fields_ = [
        ('PerProcessUserTimeLimit', ctypes.c_int64), ('PerJobUserTimeLimit', ctypes.c_int64),
        ('LimitFlags', wintypes.DWORD),
        ('MinimumWorkingSetSize', ctypes.c_size_t), ('MaximumWorkingSetSize', ctypes.c_size_t),
        ('ActiveProcessLimit', wintypes.DWORD), ('Affinity', ctypes.c_size_t),
        ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD),
    ]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ('BasicLimitInformation', _BasicLimits), ('IoInfo', ctypes.c_uint64 * 6),
        ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
        ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t),
    ]


def own_process_tree():
    """Enroll this interpreter before engine imports can create any descendants."""
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.POINTER(_ExtendedLimits), wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]

    # Unnamed, non-inheritable job handle. The kernel closes it on this
    # process's exit, even a forced one. Children inherit membership only.
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = _ExtendedLimits()
    limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    try:
        if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
            raise ctypes.WinError(ctypes.get_last_error())
    except BaseException:
        kernel.CloseHandle(job)
        raise
    # Deliberately retain the raw handle until process exit (including finalizers).


def watch_owner():
    own_process_tree()
    # Only this watcher may consume Electron's control byte. A subprocess
    # inheriting stdin could otherwise block in its own startup, or steal it.
    import msvcrt
    owner_fd = os.dup(0)  # non-inheritable
    with open(os.devnull, 'rb') as empty:
        os.dup2(empty.fileno(), 0)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.SetStdHandle.argtypes = [wintypes.DWORD, wintypes.HANDLE]
    if not kernel.SetStdHandle(-10, msvcrt.get_osfhandle(0)):  # STD_INPUT_HANDLE
        raise ctypes.WinError(ctypes.get_last_error())
    stopping = threading.Event()

    def watch():
        try:
            os.read(owner_fd, 1)  # Quit byte, or EOF if Electron crashed.
        finally:
            os.close(owner_fd)
            stopping.set()
            # Also covers shutdown before serve() returns and an executor
            # thread stuck during Python finalization after the RPC drain.
            time.sleep(10)
            os._exit(1)

    threading.Thread(target=watch, name='desktop-owner', daemon=True).start()
    return stopping
