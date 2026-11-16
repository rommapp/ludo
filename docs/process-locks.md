# Sync and install ownership

`romm_sync_engine.process_lock.ProcessLock` is shared by `AutoSyncLock` and
`LudoBackend._take_install_lock`. It uses nonblocking exclusive `flock` on
POSIX and synchronous `LockFileEx(EXCLUSIVE_LOCK | FAIL_IMMEDIATELY)` on Windows
(byte range [0, 1)). No third-party lock dependency is required.

The existing per-user `autosync.lock` and `installs.lock` paths remain separate.
A lock is an open, non-inheritable descriptor, not the existence or PID text of
a file. Repeated acquire on the same object succeeds without reopening or
rewriting; release/close is idempotent. Independent objects still contend.
The file is never unlinked or replaced, including by unsuccessful contenders
or destructors. Diagnostic metadata is written only after ownership is held.
Metadata write failures close the descriptor and propagate; metadata is not
transactional application data and must never be used as a stale-lock test.

Only native contention returns False (POSIX EAGAIN/EWOULDBLOCK, Windows
ERROR_LOCK_VIOLATION). Open/permission, unsupported locking, disk and other I/O
errors propagate. The install loop reports failures at error level; autosync
must not turn them into `blocked_by_other_instance`. Finalizers are a best-effort
fallback; normal owners explicitly release. Windows kernel cleanup after a
crash may lag process exit, so crash tests retry acquisition within a deadline.

`OwnedTasks` closes admission on stop and retains the lock until already
admitted work exits, including exceptions. Reservations happen before thread
start. Autosync tracks its monitors, startup/upload/session/conflict workers,
and synchronous prelaunch/negotiated sync entry points. Late triggers cannot
start unowned I/O, and a draining manager cannot clear its stop event to restart.
The existing bounded stop returns even if I/O is still draining; the last task
releases ownership. A permanently stuck task retains it until process exit.

Install ownership covers both the request watcher and the actual background
ROM download/extraction worker. An internal ContextVar passes that ownership
through `asyncio.run(download_game(...))` without changing the RPC signature.
Stopping the request loop/watcher is not proof the download worker has stopped.
Frontend-initiated downloads, collection sync, play tracking and BIOS workers
retain their existing behavior; these two locks do not serialize those workers.

The backend also imports Switch mod helpers. Their separate, blocking POSIX
transaction lock imports `fcntl` only when a transaction starts, so it does not
prevent the backend from loading on Windows. That lock's behavior is unchanged:
mod install/remove/recovery still requires POSIX `flock`, and fails before
touching transaction state if it is unavailable. This is not a Windows mod
package port.

## Upgrade and rollback

Stop **all** old desktop/Decky/GTK instances sharing the relevant config root
before changing versions, including contenders that never acquired the lock.
Older AutoSyncLock releases/destructors unlink the path and can invalidate
stable file identity even when the new version owns it. Mixed-version
coexistence with such clients is unsupported and has not been validated.
The same all-instances-stopped rule applies to rollback. Never delete a lock
file to recover from contention; wait for the owner to finish or exit.

There is no settings/save migration or user-data rewrite. Existing lock files
are reused in place. Stale metadata after a crash is harmless. Tests use local
temporary directories and fixture data. Network filesystems, packaged
applications and Windows desktop acceptance require separate verification.

## Verification

- `python engine/tests/test_process_lock.py`: real subprocesses, normal release,
  abrupt exit/forced termination, duplicate acquire/release, three-process
  loser-finalizer race, persistent identity/metadata, actual access denial,
  injected disk/native failures, and autosync admission/drain behavior.
- `python -m pytest -q app/tests/test_device_installs.py`: shared install lock,
  actual download/extraction worker retained after the request watcher exits,
  and existing install-request behavior.
- `engine/tests/run.sh` is the standalone engine runner; engine scripts are not
  pytest tests. Some existing scripts depend on Linux-specific facilities.
- `python engine/tests/test_switch_mods_import.py` makes `fcntl` unavailable in
  a fresh interpreter and verifies import succeeds but transactions refuse to
  run or create state. It supplies no replacement lock implementation.
- `.github/workflows/process-locks.yml` runs only these lock/ownership checks on
  native Windows/Linux and Python 3.11/3.13. The test entry points isolate HOME,
  USERPROFILE, APPDATA and LOCALAPPDATA before imports.

Native API references: [LockFileEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex),
[Windows error codes](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-),
[fcntl](https://docs.python.org/3.11/library/fcntl.html).
