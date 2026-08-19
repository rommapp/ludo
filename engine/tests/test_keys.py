"""Switch prod.keys sync. `python3 engine/tests/test_keys.py`.

Names and archive shapes are the real ones from the user's uploads:
Firmware.22.5.0.zip (238 stored .nca, no keys) and ProdKeys.NET-v22.5.0.zip
(two members, title.keys and prod.keys, no directory components). Firmware and
keys are dumped and distributed separately, so both arrive as their own RomM
firmware entry and telling them apart is this code's job.
"""

import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import emulator_saves as E        # noqa: E402
from romm_sync_engine.bios_manager import BiosManager    # noqa: E402

FAILURES = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILURES.append(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")


def main():
    # --- telling a key upload from a firmware upload -------------------
    for name, want in [
        ('ProdKeys.NET-v22.5.0.zip', True),   # the real keys upload
        ('prod.keys', True),                  # a bare upload
        ('title.keys', True),
        ('switch-keys.zip', True),
        ('Firmware.22.5.0.zip', False),       # the real firmware upload
        ('Firmware_17.0.1.zip', False),
        ('firmware.zip', False),
        # "keys" inside a name that is not an archive of keys must not
        # match, or firmware would be installed as a key file.
        ('Monkeys.nca', False),
    ]:
        check(f'classify {name}',
              BiosManager._is_keys_entry({'file_name': name}), want)

    # A platform holding both uploads must resolve each to the right one.
    entries = [
        {'file_name': 'Firmware.22.5.0.zip', 'file_size_bytes': 340773992},
        {'file_name': 'ProdKeys.NET-v22.5.0.zip', 'file_size_bytes': 7413},
    ]
    firmware = [e for e in entries if not BiosManager._is_keys_entry(e)]
    keys = [e for e in entries if BiosManager._is_keys_entry(e)]
    check('firmware entry resolves', firmware[0]['file_name'],
          'Firmware.22.5.0.zip')
    check('keys entry resolves', keys[0]['file_name'],
          'ProdKeys.NET-v22.5.0.zip')

    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        data = d / 'eden'
        (data / 'nand/system/Contents/registered').mkdir(parents=True)

        # --- a zipped keys upload, shaped like the real one ------------
        archive = d / 'ProdKeys.NET-v22.5.0.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr('title.keys', b'TITLE')
            z.writestr('prod.keys', b'MASTER')
        check('installs both key files',
              E.install_keys_file(archive, extra_data_dir=data), 2)
        check('prod.keys content', (data / 'keys/prod.keys').read_bytes(),
              b'MASTER')
        check('title.keys content', (data / 'keys/title.keys').read_bytes(),
              b'TITLE')
        check('find_prod_keys sees it',
              E.find_prod_keys(extra_data_dir=data), data / 'keys/prod.keys')

        # --- a bare upload --------------------------------------------
        bare = d / 'prod.keys'
        bare.write_bytes(b'BARE')
        check('installs a bare key file',
              E.install_keys_file(bare, extra_data_dir=data), 1)
        check('bare content replaces', (data / 'keys/prod.keys').read_bytes(),
              b'BARE')

        # A browser that appended an extension still delivered the keys.
        renamed = d / 'prod.keys.txt'
        renamed.write_bytes(b'RENAMED')
        check('installs a renamed key file',
              E.install_keys_file(renamed, extra_data_dir=data), 1)
        check('renamed lands under the canonical name',
              (data / 'keys/prod.keys').read_bytes(), b'RENAMED')

        # Anything else is not silently renamed into place.
        junk = d / 'notes.txt'
        junk.write_bytes(b'x')
        check('unrecognised file installs nothing',
              E.install_keys_file(junk, extra_data_dir=data), 0)

        # A key file only ever exists at the one path we choose.
        check('single destination',
              sorted(p.relative_to(data).as_posix()
                     for p in data.rglob('*.keys')),
              ['keys/prod.keys', 'keys/title.keys'])
        check('no .part files left behind', list(data.rglob('*.part')), [])

        # Traversal in a keys archive buys nothing, same rule as firmware.
        evil = d / 'evil.zip'
        with zipfile.ZipFile(evil, 'w') as z:
            z.writestr('../../../prod.keys', b'ESCAPED')
        E.install_keys_file(evil, extra_data_dir=data)
        check('traversal stays inside keys/',
              sorted(p.relative_to(data).as_posix()
                     for p in data.rglob('prod.keys')),
              ['keys/prod.keys'])

        # --- currency -------------------------------------------------
        # Markers live under config_dir(), which is derived from HOME --
        # NOT from XDG_CACHE_HOME. Overriding the wrong variable let earlier
        # runs write into the user's real ~/.config, where a marker left by
        # one run then made the next run's "nothing recorded yet" case pass
        # a stale True.
        import os
        os.environ['HOME'] = str(d / 'home')
        entry = {'file_name': 'ProdKeys.NET-v22.5.0.zip',
                 'md5_hash': 'ABCD1234' * 4}

        check('not current before anything is recorded',
              E.keys_are_current(entry, extra_data_dir=data), False)
        E.write_keys_marker(entry['file_name'], entry['md5_hash'])
        check('current once recorded',
              E.keys_are_current(entry, extra_data_dir=data), True)
        # A re-dumped prod.keys on the server must be fetched.
        check('a different server md5 is not current',
              E.keys_are_current({**entry, 'md5_hash': '99999999' * 4},
                                 extra_data_dir=data), False)
        # Keys absent on disk is never current, whatever the marker says.
        (data / 'keys/prod.keys').unlink()
        check('absent keys are never current',
              E.keys_are_current(entry, extra_data_dir=data), False)

        # --- firmware currency does NOT depend on keys -----------------
        # Missing keys must not trigger a 324 MB firmware re-download when
        # the firmware on disk is already correct; keys are their own fetch.
        fw_entry = {'file_name': 'Firmware.22.5.0.zip', 'md5_hash': 'EE' * 16}
        (data / 'nand/system/Contents/registered/a.nca').write_bytes(b'N')
        E.write_firmware_marker(fw_entry['file_name'], fw_entry['md5_hash'], 1)
        check('firmware stays current while keys are absent',
              E.firmware_is_current(fw_entry, extra_data_dir=data), True)

        # No Eden at all: an error the caller sees, not a silent no-op.
        try:
            E.install_keys_file(bare, extra_data_dir=d / 'absent')
            check('missing Eden raises', 'no exception', 'FileNotFoundError')
        except FileNotFoundError:
            check('missing Eden raises', 'FileNotFoundError',
                  'FileNotFoundError')

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all Switch key checks passed")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
