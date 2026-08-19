"""Restoring a packed save into Eden's tree.

Run with `python3 engine/tests/test_eden_restore.py`. No emulator required.

Restore is the direction that writes into another application's live data, so
these cover the guarantees the upload path never needed: the destination is
chosen by us and not by the archive, a crafted member cannot escape the save
directory, the previous save is backed up before it is replaced, and a failed
restore leaves the original save exactly where it was.
"""

import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import emulator_saves as E  # noqa: E402

FAILURES = []

REAL_USER = '18989C3A027B7134C526FBC279CACC13'
MK8D = '0100152000022000'


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


def make_eden(root, files):
    save = root / '.local/share/eden/nand/user/save/0000000000000000' / REAL_USER / MK8D
    save.mkdir(parents=True)
    for name, body in files.items():
        (save / name).write_bytes(body)
    return save


def make_zip(path, members):
    with zipfile.ZipFile(path, 'w') as z:
        for name, body in members.items():
            z.writestr(name, body)
    return path


def main():
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)

        # --- a normal restore ------------------------------------------
        root = d / 'a'
        data = root / '.local/share/eden'
        save = make_eden(root, {'sg00.dat': b'OLD', 'userdata.dat': b'OLD'})
        archive = make_zip(d / 'new.zip',
                           {'sg00.dat': b'NEW', 'userdata.dat': b'NEW'})
        backups = d / 'backups'

        # eden_is_running is a live /proc scan; this box may genuinely be
        # running Eden, which would make the result depend on the machine.
        E.eden_is_running = lambda: False

        result = E.unpack_save(archive, MK8D, extra_data_dir=data,
                               backup_dir=backups)
        check('restored into the discovered save dir', result['path'], save)
        check('file count', result['files'], 2)
        check('contents replaced', (save / 'sg00.dat').read_bytes(), b'NEW')
        check('backup written', result['backup'].is_file(), True)
        with zipfile.ZipFile(result['backup']) as z:
            check('backup holds the PREVIOUS save', z.read('sg00.dat'), b'OLD')
        check('no staging left behind',
              sorted(p.name for p in save.parent.iterdir()), [MK8D])

        # --- a member trying to escape ---------------------------------
        root2 = d / 'b'
        data2 = root2 / '.local/share/eden'
        save2 = make_eden(root2, {'sg00.dat': b'OLD'})
        keys = root2 / '.local/share/eden/keys'
        keys.mkdir(parents=True)
        (keys / 'prod.keys').write_bytes(b'SECRET')
        evil = make_zip(d / 'evil.zip',
                        {'sg00.dat': b'NEW',
                         '../../../../../keys/prod.keys': b'OVERWRITTEN'})
        E.unpack_save(evil, MK8D, extra_data_dir=data2)
        check('prod.keys untouched', (keys / 'prod.keys').read_bytes(), b'SECRET')
        check('the legitimate member still landed',
              (save2 / 'sg00.dat').read_bytes(), b'NEW')

        # --- an empty archive must not wipe the save -------------------
        root3 = d / 'c'
        data3 = root3 / '.local/share/eden'
        save3 = make_eden(root3, {'sg00.dat': b'KEEP'})
        empty = make_zip(d / 'empty.zip', {})
        try:
            E.unpack_save(empty, MK8D, extra_data_dir=data3)
            check('empty archive rejected', 'no exception', 'ValueError')
        except ValueError:
            check('empty archive rejected', 'ValueError', 'ValueError')
        check('save survived the failed restore',
              (save3 / 'sg00.dat').read_bytes(), b'KEEP')

        # --- a title that has never booted here ------------------------
        try:
            E.unpack_save(archive, '0100AAAABBBB1000', extra_data_dir=data3)
            check('unknown title refused', 'no exception', 'FileNotFoundError')
        except FileNotFoundError:
            check('unknown title refused', 'FileNotFoundError', 'FileNotFoundError')

        # --- Eden running blocks the restore ---------------------------
        E.eden_is_running = lambda: True
        try:
            E.unpack_save(archive, MK8D, extra_data_dir=data3)
            check('running Eden blocks restore', 'no exception', 'RuntimeError')
        except RuntimeError:
            check('running Eden blocks restore', 'RuntimeError', 'RuntimeError')

        # --- round trip ------------------------------------------------
        E.eden_is_running = lambda: False
        packed = E.pack_save(save, d / 'rt.zip')
        again = E.unpack_save(packed, MK8D, extra_data_dir=data)
        check('round trip preserves content',
              (again['path'] / 'sg00.dat').read_bytes(), b'NEW')
        check('repack after restore is byte-identical',
              E.pack_save(again['path'], d / 'rt2.zip').read_bytes(),
              packed.read_bytes())

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all Eden restore checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
