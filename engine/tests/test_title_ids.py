"""Title-ID extraction, run with plain `python3 engine/tests/test_title_ids.py`.

No test framework: the engine has no test dependency and this must stay
runnable on a Steam Deck with nothing installed. Fixtures are synthesised in a
temp dir, so the suite needs no ROMs.

Every disc read goes through the bundled libsigil (LUDO_SIGIL_LIB overrides
which build); the suite fails loudly rather than passing vacuously without it.
"""

import struct
import zipfile
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


def make_dreamcast(path, product=b'T1401D  50'):
    """A Dreamcast data track: IP.BIN at sector 0, product number at 0x40."""
    blob = bytearray(SECTOR * 16)
    blob[0:16] = b'SEGA SEGAKATANA '
    blob[0x40:0x40 + len(product)] = product.ljust(10)
    path.write_bytes(bytes(blob))
    return path


def zipped(image, inner=None):
    """``image`` zipped whole, the way RomM serves a game, beside it."""
    out = image.with_name(image.stem + '.zip')
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(image, inner or image.name)
    image.unlink()
    return out


def main():
    print(f"sigil: {'loaded ' + (T.sigil_version() or '') if T.sigil_available() else 'absent'}")
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)

        check('sigil is bundled and loads', T.sigil_available(), True)

        # ── Disc-based readers ────────────────────────────────────────────
        # GameCube and Wii report the hex of the game code as title_id; the
        # save name is the ASCII code (GameCube, which Dolphin writes into
        # every .gci name) or its lowercase hex (Wii, Dolphin's title folder).
        melee = T.identify(make_gamecube(d / 'melee.iso'), platform='ngc')
        check('gamecube iso', (melee or {}).get('title_id'), '47414C45')
        check('gamecube save name is the game code', (melee or {}).get('save_id'), 'GALE')
        check('gamecube saves share a prefix', (melee or {}).get('usage'), 'file-prefix')
        brawl = T.identify(make_gamecube(d / 'brawl.iso', b'RSBE01', wii=True),
                           platform='wii')
        check('wii iso', (brawl or {}).get('title_id'), '52534245')
        check('wii save folder is lowercase hex', (brawl or {}).get('save_id'), '52534245'.lower())

        # Six printable bytes at offset 0 are not enough when nothing names
        # the platform; the disc magic is what makes reading an arbitrary .iso
        # safe. (A NAMED platform is taken at its word, upstream's choice, and
        # Ludo only names one from the folder a ROM was downloaded into.)
        (d / 'random.wbfs').write_bytes(b'ABCDEF' + bytes(0x200))
        check('non-disc image is not identified',
              T.title_id_from_rom(d / 'random.wbfs'), None)

        gt4 = make_iso9660(d / 'gt4.iso',
                           {'SYSTEM.CNF;1': b'BOOT2 = cdrom0:\\SCUS_972.68;1\nVER = 1.00\n'})
        check('ps2 serial from SYSTEM.CNF', T.title_id_from_rom(gt4, platform='ps2'),
              'SCUS-97268')
        check('ps2 save folders carry the region prefix',
              (T.identify(gt4, platform='ps2') or {}).get('save_id'), 'BASCUS-97268')
        check('psp serial from UMD_DATA.BIN', T.title_id_from_rom(make_iso9660(
            d / 'gow.iso',
            {'UMD_DATA.BIN;1': b'ULUS10064|0123456789ABCDEF|0001|G'}), platform='psp'),
            'ULUS10064')
        crazy = T.identify(make_dreamcast(d / 'track03.bin'), platform='dc')
        check('dreamcast product number from IP.BIN',
              (crazy or {}).get('title_id'), 'T1401D  50')

        # A bare .iso could be any of five consoles, so with no platform named
        # nothing is guessed -- but a ROM in Ludo's roms/<platform>/ layout
        # names its platform by where it sits, folder of its own or not.
        check('an .iso with no platform is not guessed at',
              T.title_id_from_rom(make_gamecube(d / 'loose.iso')), None)
        nested = d / 'library' / 'gc' / 'Melee (USA)'
        nested.mkdir(parents=True)
        check('the platform folder names the platform',
              T.title_id_from_rom(make_gamecube(nested / 'Melee (USA).iso')), '47414C45')
        (nested / 'Melee (USA).iso').unlink()

        # RomM serves a game zipped; Sigil reads the member in place, so a
        # library left zipped is as identifiable as an extracted one. The
        # inner name is deliberately unlike the archive's.
        check('zipped gamecube',
              T.title_id_from_rom(zipped(make_gamecube(d / 'z_gc.iso'), 'Melee.iso'),
                                  platform='ngc'), '47414C45')
        check('zipped ps2', T.title_id_from_rom(zipped(make_iso9660(
            d / 'z_ps2.iso', {'SYSTEM.CNF;1': b'BOOT2 = cdrom0:\\SLUS_202.02;1\n'})),
            platform='ps2'), 'SLUS-20202')
        check('zipped dreamcast', T.title_id_from_rom(
            zipped(make_dreamcast(d / 'z_dc.bin'), 'Crazy Taxi (USA) (Track 3).bin'),
            platform='dreamcast'), 'T1401D  50')

        check('missing file', T.title_id_from_rom(d / 'nope.iso'), None)

        # ── Save-side identity ────────────────────────────────────────────
        # Dolphin names a GCI "<maker>-<game code>-<internal name>": two, then
        # four. The header is read first; the name is the fallback.
        gci = d / '01-GALE-SuperSmashBros0110290334.gci'
        gci.write_bytes(b'GALE01' + bytes(58))
        check('gci header', T.title_id_from_save(gci), 'GALE01')
        gci.write_bytes(b'\x00' * 64)
        check('gci name, real Dolphin spelling', T.title_id_from_save(gci), 'GALE')

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

        # Name-only extraction: the same IDs, without the file existing. This
        # is what matches a save whose ROM is not downloaded.
        for name, want in library.items():
            check(f'name-only: {name[:38]}', T.title_id_from_name(name), want)
        check('name-only ignores an untagged name',
              T.title_id_from_name('Super Mario Party.xci'), None)
        check('name-only reads a bare update tag',
              T.title_id_from_name('X [01006FE013472800].nsp'), '01006FE013472000')
        check('raw tag is reported un-normalised',
              T.raw_switch_tag_in_name('X [01006FE013472800].nsp'),
              '01006FE013472800')
        # Ludo's own Eden upload, as RomM stores it: the title ID starts the
        # name and a timestamp follows. It used to read as "no Switch title".
        check('Eden save named by RomM keeps its title',
              T.raw_switch_tag_in_name('0100965017338000 [2026-08-29_21-10-37].zip'),
              '0100965017338000')
        check('a hex run inside a word is still not a tag',
              T.raw_switch_tag_in_name('x0100965017338000 [2026-08-29_21-10-37].zip'),
              None)

        index = T.index_roms([roms])
        check('index collapses to distinct base titles', len(index), 3)
        # A game and its DLC claim the same base ID; the base game must win, or
        # the save syncs against the DLC's ROM entry.
        check('base game beats its own DLC',
              index['0100152000022000'].name.startswith('Mario Kart 8 Deluxe [01001520'),
              True)

        # The same contest, but with NEITHER name tagged -- the ordinary shape
        # of a plainly-named dump. The filename cannot break this tie, so the
        # rank has to come from the container, and without that the winner is
        # whichever file rglob happened to yield first. When the update won,
        # the save resolved to the patch's filename, matched no library tile,
        # and was dropped in silence. This is the Metroid Dread failure.
        untagged = Path(tmp) / 'untagged'
        untagged.mkdir()
        base_rom = untagged / 'Metroid Dread.xci'
        patch_rom = untagged / 'Metroid Dread v327680.nsp'
        for f in (base_rom, patch_rom):
            f.write_bytes(b'')
        kinds = {base_rom.name: 'base', patch_rom.name: 'update'}
        real_id, real_content = T.title_id_from_rom, T.switch_content
        T.title_id_from_rom = lambda path, **kw: '010093801237C000'
        T.switch_content = lambda path, **kw: {'kind': kinds[Path(path).name]}
        try:
            # Both orders, so a pass cannot be an accident of directory order.
            for order in ((base_rom, patch_rom), (patch_rom, base_rom)):
                ranks = [T._content_rank(f) for f in order]
                check(f'untagged rank: {order[0].name[:24]} first',
                      ranks, [0 if kinds[f.name] == 'base' else 1 for f in order])
            check('untagged base game still beats its update',
                  T.index_roms([untagged])['010093801237C000'].name,
                  'Metroid Dread.xci')
        finally:
            T.title_id_from_rom, T.switch_content = real_id, real_content

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all title-ID checks passed")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
