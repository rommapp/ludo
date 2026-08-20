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
            # Nested under the title, like every pack we write now.
            check('backup holds the PREVIOUS save',
                  z.read(f'{MK8D}/sg00.dat'), b'OLD')
        check('no staging left behind',
              sorted(p.name for p in save.parent.iterdir()), [MK8D])

        # --- the Android client's nesting ------------------------------
        #
        # Argosy zips the save DIRECTORY; Ludo zips its contents. Both name the
        # same save, and a restore that honoured the nesting would put the
        # files one level below where Eden reads -- so the game would start
        # fresh with the real save sitting invisibly underneath it.
        nroot1 = d / 'n1'
        ndata1 = nroot1 / '.local/share/eden'
        nsave1 = make_eden(nroot1, {'sg00.dat': b'OLD'})
        nested = make_zip(d / 'nested.zip',
                          {f'{MK8D}/sg00.dat': b'PHONE',
                           f'{MK8D}/userdata.dat': b'PHONE'})
        result = E.unpack_save(nested, MK8D, extra_data_dir=ndata1)
        check('a save nested under its title ID is flattened',
              (nsave1 / 'sg00.dat').read_bytes(), b'PHONE')
        check('and the title directory is not recreated inside itself',
              (nsave1 / MK8D).exists(), False)
        check('every member landed', result['files'], 2)

        # Only THIS title's prefix is stripped, and only when it is the single
        # top-level entry. Anything else is a layout we have not seen, and
        # flattening it on a guess would merge directories that mean something.
        nroot2 = d / 'n2'
        ndata2 = nroot2 / '.local/share/eden'
        nsave2 = make_eden(nroot2, {'sg00.dat': b'OLD'})
        other = make_zip(d / 'other.zip', {'0100000000001000/sg00.dat': b'X'})
        E.unpack_save(other, MK8D, extra_data_dir=ndata2)
        check('a different title’s directory is preserved, not flattened',
              (nsave2 / '0100000000001000' / 'sg00.dat').read_bytes(), b'X')

        nroot3 = d / 'n3'
        ndata3 = nroot3 / '.local/share/eden'
        nsave3 = make_eden(nroot3, {'sg00.dat': b'OLD'})
        mixed = make_zip(d / 'mixed.zip',
                         {f'{MK8D}/sg00.dat': b'A', 'loose.dat': b'B'})
        E.unpack_save(mixed, MK8D, extra_data_dir=ndata3)
        check('a mixed archive keeps its own shape',
              (nsave3 / MK8D / 'sg00.dat').read_bytes(), b'A')

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

        # --- uploads defer to Eden's exit too -------------------------
        # The other direction of the same rule. A save packed while Eden is
        # open is a partial snapshot of one the emulator still holds in
        # memory, so the inventory must skip it and let the sync triggered by
        # Eden's close send the finished article.
        from romm_sync_engine import sync_core

        m = object.__new__(sync_core.AutoSyncManager)
        m.settings = type('S', (), {'get': lambda self, *a: ''})()
        m.log = lambda *a, **k: None
        called = []
        real_running, real_find = E.eden_is_running, E.find_eden_saves
        E.find_eden_saves = lambda **kw: called.append(1) or []
        try:
            E.eden_is_running = lambda: True
            check('a live Eden yields no inventory entries',
                  m._eden_inventory_entries(), [])
            # Not merely empty -- the tree must not be walked at all, or a
            # future change could reintroduce the race through the back door.
            check('and its save tree is not even read', called, [])
        finally:
            E.eden_is_running, E.find_eden_saves = real_running, real_find

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all Eden restore checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
