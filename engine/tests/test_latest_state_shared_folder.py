"""A game's newest save state is its own, not the newest in a shared folder.

Run with `python3 engine/tests/test_latest_state_shared_folder.py`.

With RetroArch sorting states by content directory, the folder is named after
the ROM's parent. A game in a folder of its own gets states/<that folder>, which
holds its states and nothing else, so latest_state_slot also claims a state
under a name it can't predict (made on another device from a differently named
dump). A flat ROM's parent is the platform folder, though, so its states share
states/snes with every other SNES game — and the same rule claimed the newest
state of ANY of them. Every flat game without a state of its own then showed
that one game's screenshot in Continue playing.

Drives the real latest_state_slot with its collaborators stubbed, over real
files in a temp dir.
"""

import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import AutoSyncManager  # noqa: E402

FAILURES = []


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


class _RetroArch:
    def get_save_subdir_mode(self, kind):
        return 'content'


def manager(folder, stem, own_dir):
    m = AutoSyncManager.__new__(AutoSyncManager)
    m.retroarch = _RetroArch()
    m.state_location_for_game = lambda game, core=None: (folder.parent, folder, stem)
    m._state_stems_for_game = lambda game: [stem]
    m._content_dir_for_game = lambda game: own_dir
    return m


def touch(path, age):
    path.write_bytes(b'state')
    t = time.time() - age
    os.utime(path, (t, t))
    return path


def main():
    with tempfile.TemporaryDirectory() as tmp:
        snes = Path(tmp) / 'states' / 'snes'
        snes.mkdir(parents=True)
        home_alone = touch(snes / 'Home Alone (USA).state', 10)

        # Flat ROM in the shared platform folder, with no state of its own.
        m = manager(snes, 'Biker Mice From Mars (USA)', None)
        check('flat game with no state of its own gets none',
              m.latest_state_slot({}), (None, None))

        # The same game once it has a state: its own, not the newer one.
        own = touch(snes / 'Biker Mice From Mars (USA).state1', 60)
        check('flat game gets its own state, not a newer one beside it',
              m.latest_state_slot({}), (1, own))

        # A game in its own folder still claims a state under another name.
        folder = Path(tmp) / 'states' / 'Grind Session (Europe)'
        folder.mkdir()
        other_name = touch(folder / 'Grind Session (E).state2', 5)
        m = manager(folder, 'Grind Session (Europe)', 'Grind Session (Europe)')
        check('own-folder game claims a differently named state',
              m.latest_state_slot({}), (None, other_name))

        check('home alone state untouched', home_alone.exists(), True)

    print()
    print('all passed' if not FAILURES else f'{len(FAILURES)} failed: {FAILURES}')
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
