"""Title-ID extraction, run with plain `python3 engine/tests/test_title_ids.py`.

No test framework: the engine has no test dependency and this must stay
runnable on a Steam Deck with nothing installed. Fixtures are synthesised in a
temp dir, so the suite needs no ROMs.

Set LUDO_SIGIL_LIB to a libsigil build to exercise the Sigil path too; without
it the pure-Python readers are what run, and both are expected to pass.
"""

import struct
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import title_ids as T  # noqa: E402

SECTOR = 2048
FAILURES = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILURES.append(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")


def make_gamecube(path, code=b'GALE01', wii=False):
    blob = bytearray(0x40)
    blob[0:6] = code
    if wii:
        struct.pack_into('>I', blob, 0x18, 0x5D1C9EA3)
    else:
        struct.pack_into('>I', blob, 0x1C, 0xC2339F3D)
    path.write_bytes(bytes(blob))
    return path


def make_iso9660(path, files):
    """A minimal ISO 9660 image: PVD at sector 16, root dir at 17, data after."""
    image = bytearray(SECTOR * (18 + len(files)))
    pvd = bytearray(SECTOR)
    pvd[0] = 1
    pvd[1:6] = b'CD001'

    def record(name, lba, length, flags=0):
        raw = name.encode()
        size = 33 + len(raw) + ((len(raw) + 1) % 2)
        rec = bytearray(size)
        rec[0] = size
        struct.pack_into('<I', rec, 2, lba)
        struct.pack_into('<I', rec, 10, length)
        rec[25] = flags
        rec[32] = len(raw)
        rec[33:33 + len(raw)] = raw
        return bytes(rec)

    root = record('\x00', 17, SECTOR, 2)
    pvd[156:156 + len(root)] = root
    image[16 * SECTOR:17 * SECTOR] = pvd

    directory = bytearray()
    directory += record('\x00', 17, SECTOR, 2)
    directory += record('\x01', 17, SECTOR, 2)
    for index, (name, content) in enumerate(files.items()):
        lba = 18 + index
        directory += record(name, lba, len(content))
        image[lba * SECTOR:lba * SECTOR + len(content)] = content
    image[17 * SECTOR:17 * SECTOR + len(directory)] = directory
    path.write_bytes(bytes(image))
    return path


def main():
    print(f"sigil: {'loaded ' + (T.sigil_version() or '') if T.sigil_available() else 'absent'}")
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)

        # ── Disc-based readers ────────────────────────────────────────────
        check('gamecube iso', T.title_id_from_rom(make_gamecube(d / 'melee.iso')),
              'GALE01')
        check('wii iso',
              T.title_id_from_rom(make_gamecube(d / 'brawl.iso', b'RSBE01', wii=True)),
              'RSBE01')

        # Six printable bytes at offset 0 are not enough; the disc magic is
        # what makes reading an arbitrary .iso safe.
        (d / 'random.iso').write_bytes(b'ABCDEF' + bytes(0x200))
        check('non-disc iso is not identified',
              T.title_id_from_rom(d / 'random.iso'), None)

        check('ps2 serial from SYSTEM.CNF', T.title_id_from_rom(make_iso9660(
            d / 'gt4.iso',
            {'SYSTEM.CNF;1': b'BOOT2 = cdrom0:\\SCUS_972.68;1\nVER = 1.00\n'})),
            'SCUS-97268')
        check('psp serial from UMD_DATA.BIN', T.title_id_from_rom(make_iso9660(
            d / 'gow.iso',
            {'UMD_DATA.BIN;1': b'ULUS10064|0123456789ABCDEF|0001|G'})),
            'ULUS10064')

        check('missing file', T.title_id_from_rom(d / 'nope.iso'), None)

        # ── Switch IDs ────────────────────────────────────────────────────
        # An update and a DLC add-on both resolve to the base title, because
        # that is the only ID the emulator files a save under.
        check('base title kind', T.switch_kind('0100152000022000'), 'base')
        check('update kind', T.switch_kind('01006FE013472800'), 'update')
        check('dlc kind', T.switch_kind('0100152000023001'), 'dlc')
        check('user id is not a title', T.switch_kind('0000000000000000'), None)
        check('system save id is not a title', T.switch_kind('8000000000000010'), None)

        check('base normalises to itself',
              T.base_switch_title_id('0100152000022000'), '0100152000022000')
        check('update normalises to base',
              T.base_switch_title_id('01006FE013472800'), '01006FE013472000')
        check('dlc normalises to base',
              T.base_switch_title_id('0100152000023001'), '0100152000022000')

        # Only a base title can name a save directory.
        check('save dir test rejects update',
              T.is_switch_title_id('01006FE013472800'), False)
        check('save dir test accepts base',
              T.is_switch_title_id('0100152000022000'), True)

        # ── The real library's filenames ──────────────────────────────────
        roms = d / 'roms'
        roms.mkdir()
        library = {
            'Mario Kart 8 Deluxe [0100152000022000][v0] (6.77 GB).nsp': '0100152000022000',
            'Mario Party Superstars [01006FE013472800][v131072].nsp': '01006FE013472000',
            'Super Mario Party Jamboree [0100965017338000][v0].nsp': '0100965017338000',
            'Mario Kart 8 Deluxe [DLC Booster Course Pass] [0100152000023001][v65536].nsp':
                '0100152000022000',
            # No tag and no keys: unidentifiable without Sigil reading the
            # container, which is the single case Sigil exists to cover.
            'Super Mario Party.xci': None,
        }
        for name, want in library.items():
            (roms / name).write_bytes(b'')
            check(f'rom: {name[:42]}', T.title_id_from_rom(roms / name), want)

        index = T.index_roms([roms])
        check('index collapses to distinct base titles', len(index), 3)
        # A game and its DLC claim the same base ID; the base game must win, or
        # the save syncs against the DLC's ROM entry.
        check('base game beats its own DLC',
              index['0100152000022000'].name.startswith('Mario Kart 8 Deluxe [01001520'),
              True)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all title-ID checks passed")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
