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

# Real prod.keys shape: "name = hex", one per line. Values here are invented,
# but the FORMAT is what identification keys on, so it has to be the real one.
KEY_TEXT = b"""aes_kek_generation_source = 4d870986c45d20722fba1053da92e8a9
aes_key_generation_source = 89615ee05c31b6805fe58f3da24f7aa8
bis_kek_source = 34c1a0c48258f8b4fa9e5e6adafc7e4f
header_key = 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
master_key_00 = c2caaff089b9aed55694876055271c7d
"""
OTHER_KEY_TEXT = KEY_TEXT.replace(b'master_key_00', b'master_key_0a')

FAILURES = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILURES.append(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")


def main():
    # --- telling a key upload from a firmware upload -------------------
    # Size decides, because names are a convention and not a contract. The
    # real uploads are ~7 KB zipped keys against ~340 MB of firmware.
    KEYS, FW = 7413, 340773992
    for name, size, want in [
        ('ProdKeys.NET-v22.5.0.zip', KEYS, True),   # the real keys upload
        ('Firmware.22.5.0.zip', FW, False),         # the real firmware upload
        # The two cases a name-based rule got wrong, and the reason for
        # deciding on size instead.
        ('switch-22.5.0.zip', KEYS, True),          # keys, name says nothing
        ('keys-firmware.zip', FW, False),           # firmware, name says keys
    ]:
        check(f'classify {name}',
              BiosManager._is_keys_entry(
                  {'file_name': name, 'file_size_bytes': size}), want)

    # With no size recorded, the name is all there is.
    for name, want in [('prod.keys', True), ('title.keys', True),
                       ('switch-keys.zip', True), ('Firmware.22.5.0.zip', False),
                       ('Monkeys.nca', False)]:
        check(f'classify {name} (no size)',
              BiosManager._is_keys_entry({'file_name': name}), want)

    # A platform holding both uploads must resolve each to the right one.
    entries = [
        {'file_name': 'Firmware.22.5.0.zip', 'file_size_bytes': FW},
        {'file_name': 'ProdKeys.NET-v22.5.0.zip', 'file_size_bytes': KEYS},
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
            z.writestr('title.keys', OTHER_KEY_TEXT)
            z.writestr('prod.keys', KEY_TEXT)
        check('installs both key files',
              E.install_keys_file(archive, extra_data_dir=data), 2)
        check('prod.keys content', (data / 'keys/prod.keys').read_bytes(),
              KEY_TEXT)
        check('title.keys content', (data / 'keys/title.keys').read_bytes(),
              OTHER_KEY_TEXT)
        check('find_prod_keys sees it',
              E.find_prod_keys(extra_data_dir=data), data / 'keys/prod.keys')

        # --- a bare upload --------------------------------------------
        bare = d / 'prod.keys'
        bare.write_bytes(KEY_TEXT)
        check('installs a bare key file',
              E.install_keys_file(bare, extra_data_dir=data), 1)
        check('bare content replaces', (data / 'keys/prod.keys').read_bytes(),
              KEY_TEXT)

        # A browser that appended an extension still delivered the keys.
        renamed = d / 'prod.keys.txt'
        renamed.write_bytes(OTHER_KEY_TEXT)
        check('installs a renamed key file',
              E.install_keys_file(renamed, extra_data_dir=data), 1)
        check('renamed lands under the canonical name',
              (data / 'keys/prod.keys').read_bytes(), OTHER_KEY_TEXT)

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
            z.writestr('../../../prod.keys', KEY_TEXT)
        E.install_keys_file(evil, extra_data_dir=data)
        check('traversal stays inside keys/',
              sorted(p.relative_to(data).as_posix()
                     for p in data.rglob('prod.keys')),
              ['keys/prod.keys'])

        # --- identification by content, not by name -------------------
        # The final authority. A keys archive named like firmware would
        # otherwise be handed to install_firmware_zip, which extracts zero
        # NCAs and reports a perfectly successful install of nothing.
        misnamed = d / 'Firmware.99.0.0.zip'
        with zipfile.ZipFile(misnamed, 'w') as z:
            z.writestr('prod.keys', KEY_TEXT)
        check('a keys archive named like firmware is keys',
              E.identify_upload(misnamed), 'keys')

        fw_named_keys = d / 'super-keys-pack.zip'
        with zipfile.ZipFile(fw_named_keys, 'w') as z:
            z.writestr('deadbeefdeadbeefdeadbeefdeadbeef.nca', b'N' * 32)
        check('an NCA archive named like keys is firmware',
              E.identify_upload(fw_named_keys), 'firmware')

        check('a bare key file identifies', E.identify_upload(bare), 'keys')
        check('an unrelated file identifies as neither',
              E.identify_upload(junk), None)

        empty = d / 'empty.zip'
        with zipfile.ZipFile(empty, 'w') as z:
            z.writestr('readme.txt', b'nothing here')
        check('an archive of neither is neither',
              E.identify_upload(empty), None)

        # A member with the right NAME but the wrong CONTENT must not be
        # installed: it would land in keys/ and fail at boot with the same
        # dialog as no keys at all, which is the least diagnosable outcome.
        impostor = d / 'impostor.zip'
        with zipfile.ZipFile(impostor, 'w') as z:
            z.writestr('prod.keys', b'<html>404 Not Found</html>')
        check('a fake prod.keys is not identified',
              E.identify_upload(impostor), None)
        before = (data / 'keys/prod.keys').read_bytes()
        check('a fake prod.keys installs nothing',
              E.install_keys_file(impostor, extra_data_dir=data), 0)
        check('a fake prod.keys leaves the real one alone',
              (data / 'keys/prod.keys').read_bytes(), before)

        check('nonsense is not keys', E.looks_like_keys(b'hello world'), False)
        check('empty is not keys', E.looks_like_keys(b''), False)
        # One matching line is a coincidence; several are a key file.
        check('a single matching line is not enough',
              E.looks_like_keys(b'foo = 0123456789abcdef0123456789abcdef'), False)

        # --- master key generation ------------------------------------
        # Parsed from the key file's own text, never from a filename: the
        # real upload is named "ProdKeys.NET-v22.5.0.zip", and 22.5.0 is a
        # firmware version someone typed, not the generation inside.
        gen = d / 'gen.keys'
        gen.write_bytes(KEY_TEXT + b'''master_key_09 = ''' + b'a' * 32 + b'''
master_key_15 = ''' + b'b' * 32 + b'''
master_key_source = ''' + b'c' * 32 + b'''
''')
        # Indices are HEX, so master_key_15 is generation 21, not 15 -- and
        # master_key_source is not an index at all.
        check('highest master key is parsed as hex',
              E.highest_master_key(gen), 21)
        # KEY_TEXT carries master_key_00 and nothing higher: generation 0 is
        # a real answer, and must not be confused with "no keys found".
        check('a key file reaching only generation 0 reports 0',
              E.highest_master_key(bare), 0)
        check('generation 0 is not falsy-confused with absent',
              E.highest_master_key(bare) is not None, True)
        check('missing file reports None',
              E.highest_master_key(d / 'nope.keys'), None)

        E.install_keys_file(gen, extra_data_dir=data)
        st = E.keys_status(extra_data_dir=data)
        check('keys_status reports the generation', st['master_key'], 21)
        check('keys_status points at the file',
              st['path'], data / 'keys/prod.keys')
        check('keys_status is None without keys',
              E.keys_status(extra_data_dir=d / 'absent'), None)

        # --- version labels -------------------------------------------
        # Parsed from filenames because that is the only place a version
        # exists cheaply -- the authoritative copy lives inside a system NCA
        # that cannot be read without the very keys in question. A label for
        # a human, never a comparison that gates an install.
        for name, want in [
            ('Firmware.22.5.0.zip', '22.5.0'),      # the real upload
            ('Firmware_17.0.1.zip', '17.0.1'),      # the other real upload
            ('Firmware 18.1.0 (Rebootless).zip', '18.1.0'),
            ('firmware.zip', None),                 # no version to find
            ('Switch-2024-set.zip', None),          # a year is not a version
        ]:
            check(f'version of {name}',
                  E.firmware_version_from_name(name), want)
        check('no name at all', E.firmware_version_from_name(None), None)

        # installed_firmware_version reads the marker -- what was actually
        # unpacked here -- not whatever happens to be lying in the NAND.
        E.write_firmware_marker('Firmware_17.0.1.zip', 'ff' * 16, 3)
        check('installed version comes from the marker',
              E.installed_firmware_version(), '17.0.1')

        # --- which firmware set is THE one -----------------------------
        # A platform accumulates firmware as it is uploaded; a device holds
        # exactly one. Newest wins, and size is only the tie-break -- these
        # are the user's real three entries plus a smaller newer set, which
        # is where ranking by size alone silently picked the older firmware.
        real = [
            {'file_name': 'Firmware.22.5.0.zip', 'file_size_bytes': 340773992},
            {'file_name': 'Firmware_17.0.1.zip', 'file_size_bytes': 339309958},
            {'file_name': 'ProdKeys.NET-v22.5.0.zip', 'file_size_bytes': 7413},
        ]
        pick = lambda entries: max(
            [f for f in entries if not BiosManager._is_keys_entry(f)],
            key=lambda f: (E.firmware_version_key(f['file_name']),
                           f.get('file_size_bytes') or 0))['file_name']
        check('newest of the real three', pick(real), 'Firmware.22.5.0.zip')
        newer_smaller = real + [{'file_name': 'Firmware 23.0.0 (Rebootless).zip',
                                 'file_size_bytes': 180000000}]
        check('a smaller newer set still wins',
              pick(newer_smaller), 'Firmware 23.0.0 (Rebootless).zip')
        check('size alone would have got that wrong',
              max([f for f in newer_smaller if not BiosManager._is_keys_entry(f)],
                  key=lambda f: f['file_size_bytes'])['file_name'],
              'Firmware.22.5.0.zip')
        # Unversioned names rank below versioned ones, and fall back to size.
        # Both must be firmware-sized: anything under KEYS_MAX_BYTES is
        # classified as keys and never reaches the ranking at all.
        unversioned = [{'file_name': 'firmware.zip', 'file_size_bytes': 999999999},
                       {'file_name': 'Firmware_17.0.1.zip', 'file_size_bytes': 300000000}]
        check('a versioned name outranks a bigger unversioned one',
              pick(unversioned), 'Firmware_17.0.1.zip')

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
