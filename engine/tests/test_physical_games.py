"""A RomM 5.3.0 physical game must never reach the library or the downloader.

Run with `python3 engine/tests/test_physical_games.py`.

5.3.0 lets a user record a game they own on a cartridge or disc with no dump of
it on the server. The row looks like any other game — name, cover, platform,
collections — but there is no file behind it, so downloading, launching and
save pairing all have nothing to act on. is_physical_rom identifies one and
project_rom_rows drops it as each page lands.

These lock in that the filter fires on the flag alone, that a pre-5.3.0 row
(which carries no such field at all) is untouched, and that the projection
still trims to the requested fields — the memory behaviour ROM_TRIM_FIELDS
exists for, which the filter now shares a function with.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import (  # noqa: E402
    ROM_TRIM_FIELDS, is_physical_rom, project_rom_rows,
)

FAILURES = []


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


def main():
    # A pre-5.3.0 server has no such column, so the field is absent rather
    # than false. Every one of those rows is an ordinary game.
    check("pre-5.3.0 row is not physical", is_physical_rom({'id': 1}), False)
    check("explicit false is not physical",
          is_physical_rom({'id': 1, 'is_physical': False}), False)
    check("null is not physical",
          is_physical_rom({'id': 1, 'is_physical': None}), False)
    check("flagged row is physical",
          is_physical_rom({'id': 1, 'is_physical': True}), True)

    page = [
        {'id': 1, 'name': 'Has A File', 'fs_name': 'a.sfc', 'metadatum': {}},
        {'id': 2, 'name': 'On A Cartridge', 'is_physical': True, 'upc': '123'},
        {'id': 3, 'name': 'Also Has A File', 'fs_name': 'b.sfc'},
    ]
    kept = project_rom_rows(page, None)
    check("physical row dropped from the page",
          [r['id'] for r in kept], [1, 3])

    # The projection is the reason this function exists at all: the untrimmed
    # row carries blobs that must not survive the page they arrived on.
    trimmed = project_rom_rows(page, ROM_TRIM_FIELDS)
    check("trim still applies", [r['id'] for r in trimmed], [1, 3])
    check("untrimmed keys gone", 'metadatum' in trimmed[0], False)
    check("trimmed keys kept", trimmed[0]['name'], 'Has A File')

    # No trim list is a valid call (search and collections use it); the rows
    # must come back whole rather than empty.
    check("no trim keeps the whole row",
          sorted(project_rom_rows([page[0]], None)[0]),
          sorted(page[0]))

    check("empty page is empty", project_rom_rows([], ROM_TRIM_FIELDS), [])
    check("all-physical page is empty",
          project_rom_rows([page[1]], ROM_TRIM_FIELDS), [])

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all physical-game checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
