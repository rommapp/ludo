#!/usr/bin/env python3
"""RomM 5.4's `delete` sync action sets the local save aside.

When a slot is emptied on the server and the device still holds the version
that was deleted, negotiate answers `delete`. Before 5.4 that case was an
`upload`, so the save came straight back; ignoring the new action left it on
the device forever.

Asserted here:
  * a delete op renames the local save to <name>.deleted-<stamp>, so the
    emulator and the next inventory no longer see it, and counts it;
  * a packed entry (a zip built in our cache from Eden data or a shared PS2
    card) is left alone, since removing the zip removes nothing real;
  * a delete op with no matching local entry is a no-op, not an error.
"""
import sys
import tempfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import AutoSyncManager  # noqa: E402

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


class _Client:
    authenticated = True

    def __init__(self, ops):
        self.ops = ops
        self.completed = None

    def negotiate_sync(self, device_id, inventory):
        return 1, self.ops

    def complete_sync_session(self, session_id, **kw):
        self.completed = kw


def _manager(inventory, ops):
    m = AutoSyncManager.__new__(AutoSyncManager)
    m.romm_client = _Client(ops)
    m.settings = type('S', (), {'get': lambda self, *a: 'dev-1'})()
    m.build_sync_inventory = lambda: inventory
    m.retroarch = type('R', (), {'save_dirs': {}})()
    m.get_games = lambda: []
    m.save_download_blocked = set()
    m._record_synced = lambda p: False
    m.mark_all_synced = lambda exclude=None: False
    m._notify_sync_result = lambda *a, **k: None
    m.log = lambda *a, **k: None
    return m


def main():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        cache = tmp / 'cache'
        (cache / 'packed_saves').mkdir(parents=True)
        saves = tmp / 'saves'
        saves.mkdir()

        srm = saves / 'Game.srm'
        srm.write_bytes(b'x' * 64)
        packed = cache / 'packed_saves' / '0100000000010000.zip'
        packed.write_bytes(b'PK')

        inventory = [
            {'rom_id': 1, 'slot': 'autosave', '_path': str(srm)},
            {'rom_id': 2, 'slot': 'autosave', '_path': str(packed)},
        ]
        ops = [
            {'action': 'delete', 'rom_id': 1, 'slot': 'autosave'},
            {'action': 'delete', 'rom_id': 2, 'slot': 'autosave'},
            {'action': 'delete', 'rom_id': 3, 'slot': 'autosave'},
        ]
        m = _manager(inventory, ops)
        with mock.patch.object(sync_core, 'cache_dir', lambda: cache), \
                mock.patch.object(sync_core, '_record_activity', lambda *a, **k: None):
            summary = m.run_negotiated_save_sync()

        check('the local save is gone from its name', srm.exists(), False)
        check('a backup sits beside it',
              len(list(saves.glob('Game.srm.deleted-*'))), 1)
        check('one save counted as deleted', summary['deleted'], 1)
        check('the packed zip is left alone', packed.exists(), True)
        check('packed and unknown entries are skipped, not errors',
              (summary.get('skipped_delete'), summary['errors']), (2, 0))
        check('the deletion counts as a completed operation',
              m.romm_client.completed.get('operations_completed'), 1)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) failed: {FAILURES}")
        return 1
    print("all checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
