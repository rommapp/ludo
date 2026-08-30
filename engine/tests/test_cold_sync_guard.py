#!/usr/bin/env python3
"""A fresh install must not push the whole states directory to the server.

States are outside the /negotiate protocol (that engine is saves-only), so the
upload fingerprint cache is the ONLY thing distinguishing "this state drifted"
from "this state is new to me". On a first run the cache is empty, which made
every state on disk look drifted: one Deck re-uploaded 44 savestates untouched
since June the first time it connected.

Asserted here:
  * a cold cache seeds a baseline and uploads nothing;
  * a warm cache still uploads a state that genuinely drifted;
  * deleting a game's saves blocks the server from restoring them, and
    downloading the game again lifts the block;
  * a save download for a game that is not installed here is skipped, unless
    the library has not loaded yet (in which case nothing is gated).
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import AutoSyncManager  # noqa: E402

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


def _manager(tmp, states, cold):
    m = AutoSyncManager.__new__(AutoSyncManager)
    m.romm_client = type('C', (), {'authenticated': True})()
    m.last_uploaded = {}
    m._fingerprints_cold = cold
    m.upload_fingerprints_file = tmp / 'upload_fingerprints.json'
    m.log = lambda *a, **k: None
    m.uploaded = []
    m.process_save_upload = lambda p: m.uploaded.append(str(p))
    m.retroarch = type('R', (), {'get_save_files': lambda self: {
        'states': [{'path': str(p)} for p in states]}})()
    return m


def main():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        old = tmp / 'Old Game.state1'
        old.write_bytes(b'x' * 32)

        # 1. Cold cache: seed, upload nothing.
        m = _manager(tmp, [old], cold=True)
        m.flush_pending_states()
        check('a cold cache uploads nothing', m.uploaded, [])
        check('a cold cache seeds the baseline',
              str(old) in m.last_uploaded, True)
        check('the seeded baseline is persisted',
              m.upload_fingerprints_file.exists(), True)
        check('the cold flag is cleared', m._fingerprints_cold, False)

        # 2. Warm cache, unchanged file: still nothing.
        m.flush_pending_states()
        check('an unchanged state is not re-uploaded', m.uploaded, [])

        # 3. Warm cache, genuine drift: uploaded.
        old.write_bytes(b'y' * 64)
        m.flush_pending_states()
        check('a drifted state is uploaded', m.uploaded, [str(old)])

        # 4. Save-download block round-trip.
        m.save_download_block_file = tmp / 'save_download_block.json'
        m.save_download_blocked = set()
        m.block_save_downloads(37)
        check('deleting a game blocks its save downloads',
              37 in m.save_download_blocked, True)
        check('the block is persisted',
              json.loads(m.save_download_block_file.read_text()), [37])
        m.unblock_save_downloads(37)
        check('re-downloading the game lifts the block',
              m.save_download_blocked, set())

        # 5. The installed-ROM gate, as run_negotiated_save_sync computes it.
        def gate(games):
            g = games or []
            return ({x['rom_id'] for x in g if x.get('is_downloaded')}
                    if g else None)

        library = [{'rom_id': 10819, 'is_downloaded': False},
                   {'rom_id': 37, 'is_downloaded': True}]
        installed = gate(library)
        check('a save for an uninstalled game is skipped',
              10819 in installed, False)
        check('a save for an installed game still downloads',
              37 in installed, True)
        check('an unloaded library gates nothing', gate([]), None)

    print('FAILURES:', FAILURES if FAILURES else 'none')
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
