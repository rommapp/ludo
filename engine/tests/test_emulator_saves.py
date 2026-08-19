"""Eden save discovery and packing.

Run with `python3 engine/tests/test_emulator_saves.py`. No test framework and
no emulator required — the trees below are synthesised.

The layouts are not invented: layout A is the one confirmed on a live Eden
install (probe, Aug 2026), where the user ID level is 32 hex digits and the
same title appears under both a real user and the all-zero one. B and C are the
other two shapes savedata_factory can produce.
"""

import hashlib
import os
import sys
import tempfile
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import emulator_saves as E  # noqa: E402
from romm_sync_engine.sync_core import RomMClient  # noqa: E402

FAILURES = []

REAL_USER = '18989C3A027B7134C526FBC279CACC13'
ZERO_USER = '0' * 32
MK8D = '0100152000022000'
JAMBOREE = '0100965017338000'
OTHER = '010036B0034E4000'


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILURES.append(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")


def write(directory, files):
    directory.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    return directory


def main():
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        data = d / '.local/share/eden'
        root = data / 'nand/user/save'

        # Layout A — the live install's shape.
        real = write(root / '0000000000000000' / REAL_USER / MK8D,
                     {'userdata.dat': b'U' * 64, 'sg00.dat': b'S' * 32})
        write(root / '0000000000000000' / REAL_USER / JAMBOREE, {'save.bin': b'J'})
        write(root / '0000000000000000' / REAL_USER / OTHER, {'save.bin': b'O'})
        # Same title under the all-zero user — must not shadow the real save.
        stale = write(root / '0000000000000000' / ZERO_USER / MK8D,
                      {'userdata.dat': b'x'})
        old = time.time() - 86400
        for path in stale.rglob('*'):
            os.utime(path, (old, old))

        # Layout B — device save, no user level.
        write(root / '0000000000000000' / '0100AAAABBBB1000', {'d.sav': b'D'})
        # Layout C — the "account" variant.
        write(root / 'account' / REAL_USER / '0100CCCCDDDD2000', {'a.sav': b'A'})

        # Must never be picked up.
        write(root / '0000000000000000' / REAL_USER / '0100152000022800',
              {'update.dat': b'x'})             # an update, not a title
        write(root / '0000000000000000' / REAL_USER / '0200152000022000',
              {'x.dat': b'x'})                  # not a Switch application ID
        (root / '0000000000000000' / REAL_USER / '0100EEEEFFFF3000').mkdir(parents=True)

        saves = E.find_eden_saves(extra_data_dir=data)
        by_title = {s['title_id']: s for s in saves}
        check('discovers every layout', sorted(by_title),
              sorted([MK8D, JAMBOREE, OTHER, '0100AAAABBBB1000', '0100CCCCDDDD2000']))
        check('the real user save wins over the all-zero one',
              by_title[MK8D]['path'], real)

        # An in-place edit leaves the parent directory's mtime untouched, so
        # discovery has to look at the files themselves.
        before = by_title[JAMBOREE]['modified']
        target = root / '0000000000000000' / REAL_USER / JAMBOREE / 'save.bin'
        os.utime(target, (time.time() + 500, time.time() + 500))
        after = {s['title_id']: s for s in
                 E.find_eden_saves(extra_data_dir=data)}[JAMBOREE]['modified']
        check('mtime follows the files inside', after > before, True)

        # ── Packing ───────────────────────────────────────────────────────
        first = E.pack_save(real, d / 'out' / 'a.zip')
        time.sleep(0.01)
        second = E.pack_save(real, d / 'out' / 'b.zip')
        check('repacking is byte-identical',
              first.read_bytes() == second.read_bytes(), True)
        check('zip holds the save files',
              sorted(zipfile.ZipFile(first).namelist()),
              ['sg00.dat', 'userdata.dat'])

        # The packed save must hash the same on both sides, or /negotiate
        # reports a conflict for every save forever.
        archive = zipfile.ZipFile(first)
        lines = [f"{i.filename}:{hashlib.md5(archive.read(i.filename)).hexdigest()}"
                 for i in sorted(archive.infolist(), key=lambda i: i.filename)
                 if not i.is_dir()]
        check('content hash matches the server form',
              RomMClient.compute_content_hash(first),
              hashlib.md5("\n".join(lines).encode()).hexdigest())

        # ── Absent / fresh installs ───────────────────────────────────────
        fresh = d / 'fresh'
        (fresh / 'nand/system/save').mkdir(parents=True)
        check('a fresh install yields nothing',
              E.find_eden_saves(extra_data_dir=fresh), [])
        check('no Eden at all yields nothing',
              E.find_eden_saves(extra_data_dir=d / 'absent'), [])
        check('prod.keys absent', E.find_prod_keys(extra_data_dir=fresh), None)

        keys = data / 'keys'
        keys.mkdir(parents=True)
        (keys / 'prod.keys').write_bytes(b'stub')
        check('prod.keys found', E.find_prod_keys(extra_data_dir=data),
              keys / 'prod.keys')

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all Eden save checks passed")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
