"""Eden firmware install. `python3 engine/tests/test_firmware.py`.

Shapes match the real archive on the user's RomM instance (Firmware_17.0.1.zip,
229 stored .nca entries, no directory components) and the real install target
(229 flat .nca files, verified Aug 2026).
"""

import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import emulator_saves as E  # noqa: E402

FAILURES = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILURES.append(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")


def main():
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        data = d / '.local/share/eden'
        (data / 'nand/system/Contents/registered').mkdir(parents=True)

        archive = d / 'Firmware_17.0.1.zip'
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_STORED) as z:
            z.writestr('b7bdc53bba9328826aee26f2c00c15ae.nca', b'N' * 100)
            z.writestr('580cb2ad6afe2ec60d545c9a08cda114.cnmt.nca', b'C' * 50)
            z.writestr('a9ae812b2773995aab7c2630e80a7fd7.nca', b'A' * 70)
            # Not firmware — must be ignored rather than written into the
            # emulator's system directory.
            z.writestr('README.txt', b'notes')
            # Path traversal on a member we DO want. prod.keys is installed
            # now -- but by basename into the keys directory we choose, so the
            # "../../" must buy the archive nothing: same destination as a
            # member named plainly "prod.keys".
            z.writestr('../../keys/prod.keys', b'SECRET')
            z.writestr('nested/dir/ffffffffffffffffffffffffffffffff.nca', b'F' * 20)

        result = E.install_firmware_zip(archive, extra_data_dir=data)
        target = data / 'nand/system/Contents/registered'
        names = sorted(p.name for p in target.iterdir())

        check('installs only NCAs, flattened', names, [
            '580cb2ad6afe2ec60d545c9a08cda114.cnmt.nca',
            'a9ae812b2773995aab7c2630e80a7fd7.nca',
            'b7bdc53bba9328826aee26f2c00c15ae.nca',
            'ffffffffffffffffffffffffffffffff.nca',
        ])
        check('installed count', result['installed'], 4)
        check('README.txt not written', (target / 'README.txt').exists(), False)
        # Routed to the keys directory, and to exactly one place -- the
        # traversal prefix neither escaped the data directory nor put a copy
        # in registered/.
        check('prod.keys lands in keys/ only',
              [p.relative_to(data).as_posix() for p in data.rglob('prod.keys')],
              ['keys/prod.keys'])
        check('prod.keys content installed',
              (data / 'keys/prod.keys').read_bytes(), b'SECRET')
        check('key files not counted as firmware', result['keys'], 1)
        check('find_prod_keys sees it',
              E.find_prod_keys(extra_data_dir=data), data / 'keys/prod.keys')
        check('no .part files left behind', list(target.glob('*.part')), [])
        check('nested member flattened, no subdirs',
              [p.name for p in target.iterdir() if p.is_dir()], [])

        # Re-running must be idempotent: same-name/same-size is the same NCA.
        again = E.install_firmware_zip(archive, extra_data_dir=data)
        check('second run installs nothing', again['installed'], 0)
        check('second run skips everything', again['skipped'], 4)

        status = E.firmware_status(extra_data_dir=data)
        check('status counts NCAs', status['count'], 4)
        check('status sums bytes', status['bytes'], 100 + 50 + 70 + 20)

        # A changed NCA (same name, different size) is replaced.
        (target / 'a9ae812b2773995aab7c2630e80a7fd7.nca').write_bytes(b'X')
        third = E.install_firmware_zip(archive, extra_data_dir=data)
        check('a differing file is reinstalled', third['installed'], 1)
        check('content restored',
              (target / 'a9ae812b2773995aab7c2630e80a7fd7.nca').read_bytes(),
              b'A' * 70)

        # An archive carrying no keys must not create an empty keys/ as a
        # side effect of looking for them.
        bare_data = d / 'bare/eden'
        (bare_data / 'nand/system/Contents/registered').mkdir(parents=True)
        bare = d / 'nokeys.zip'
        with zipfile.ZipFile(bare, 'w', zipfile.ZIP_STORED) as z:
            z.writestr('deadbeefdeadbeefdeadbeefdeadbeef.nca', b'D' * 10)
        bare_result = E.install_firmware_zip(bare, extra_data_dir=bare_data)
        check('no keys in archive, none reported', bare_result['keys'], 0)
        check('no empty keys directory created',
              (bare_data / 'keys').exists(), False)

        # No Eden at all is an error the caller must see, not a silent no-op.
        try:
            E.install_firmware_zip(archive, extra_data_dir=d / 'absent')
            check('missing Eden raises', 'no exception', 'FileNotFoundError')
        except FileNotFoundError:
            check('missing Eden raises', 'FileNotFoundError', 'FileNotFoundError')

        check('status is None without Eden',
              E.firmware_status(extra_data_dir=d / 'absent'), None)

        # --- version, not presence -------------------------------------
        # The point of the marker is to answer "is the server's archive the
        # one already installed" WITHOUT downloading it. Presence alone can't:
        # a newer firmware sharing NCA names looks present file by file.
        # Markers live under config_dir(), which is derived from HOME --
        # NOT from XDG_CACHE_HOME. Overriding the wrong variable let earlier
        # runs write into the user's real ~/.config, where a marker left by
        # one run then made the next run's "nothing recorded yet" case pass
        # a stale True.
        import os
        os.environ['HOME'] = str(d / 'home')
        entry = {'file_name': 'Firmware_17.0.1.zip', 'md5_hash': 'AABBCCDD' * 4}
        installed = E.firmware_status(extra_data_dir=data)['count']

        check('not current before anything is recorded',
              E.firmware_is_current(entry, extra_data_dir=data), False)

        E.write_firmware_marker(entry['file_name'], entry['md5_hash'], installed)
        check('current once recorded',
              E.firmware_is_current(entry, extra_data_dir=data), True)
        check('md5 is compared case-insensitively',
              E.firmware_is_current({**entry, 'md5_hash': 'aabbccdd' * 4},
                                    extra_data_dir=data), True)

        # A new firmware release on the server must not read as current.
        check('a different server md5 is not current',
              E.firmware_is_current({**entry, 'md5_hash': '11223344' * 4},
                                    extra_data_dir=data), False)

        # And neither must a marker whose firmware has since been removed or
        # replaced underneath us -- the marker alone would lie here.
        E.write_firmware_marker(entry['file_name'], entry['md5_hash'], installed + 3)
        check('drifted NCA count is not current',
              E.firmware_is_current(entry, extra_data_dir=data), False)

        # Firmware currency is about the firmware, and nothing else. Keys
        # are fetched separately (see test_keys.py) because they are ~11 KB
        # against ~324 MB and are uploaded as their own file -- so keys
        # missing from disk must NOT invalidate firmware that is already
        # correct, or every missing key file would cost a full re-download.
        E.write_firmware_marker(entry['file_name'], entry['md5_hash'], installed)
        keys_file = data / 'keys/prod.keys'
        keys_file.rename(data / 'keys/prod.keys.bak')
        check('firmware stays current when keys are absent',
              E.firmware_is_current(entry, extra_data_dir=data), True)
        (data / 'keys/prod.keys.bak').rename(keys_file)

        E.write_firmware_marker(entry['file_name'], entry['md5_hash'], installed + 3)
        check('an entry with no md5 is never current',
              E.firmware_is_current({'file_name': 'x.zip'}, extra_data_dir=data),
              False)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all firmware checks passed")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
