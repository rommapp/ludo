"""Switch update/DLC install. `python3 engine/tests/test_switch_content.py`.

No test framework and no ROMs: the containers are synthesised here, which is
possible precisely because the install path needs no keys. A PFS0 header, an
entry table and a string table are all plaintext, so a fixture NSP is a few
lines of struct.pack and the NCAs inside it can be any bytes at all -- nothing
in switch_content parses them.

The XCI fixture nests the same partition format twice, matching the real
layout: a root HFS0 listing partitions, and a "secure" partition listing NCAs.
"""

import os
import struct
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import switch_content as S  # noqa: E402
from romm_sync_engine import title_ids as T  # noqa: E402

FAILURES = []

BASE_ID = '0100152000022000'
UPDATE_ID = '0100152000022800'
DLC_ID = '0100152000023001'


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILURES.append(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")


def build_partition(magic, entry_size, members):
    """A PFS0/HFS0 blob from [(name, payload)], plus its member offsets."""
    names = b''
    name_offsets = []
    for name, _payload in members:
        name_offsets.append(len(names))
        names += name.encode() + b'\0'
    # Real containers pad the string table for alignment; padding it here keeps
    # the reader honest about using the header's size rather than the names'.
    names += b'\0' * ((0x20 - len(names) % 0x20) % 0x20)

    table = b''
    offset = 0
    for (name, payload), name_offset in zip(members, name_offsets):
        entry = struct.pack('<QQI', offset, len(payload), name_offset)
        table += entry + b'\0' * (entry_size - len(entry))
        offset += len(payload)

    header = magic + struct.pack('<III', len(members), len(names), 0)
    data = b''.join(payload for _name, payload in members)
    return header + table + names + data


def make_nsp(path, members):
    path.write_bytes(build_partition(S._PFS0_MAGIC, S._PFS0_ENTRY, members))
    return path


def make_xci(path, members):
    secure = build_partition(S._HFS0_MAGIC, S._HFS0_ENTRY, members)
    # The root partition's single entry points at the secure partition, so the
    # reader has to resolve one base relative to another to find the NCAs.
    root = build_partition(S._HFS0_MAGIC, S._HFS0_ENTRY, [('secure', secure)])
    head = bytearray(0x200)
    magic_at = S._XCI_MAGIC_OFFSET
    head[magic_at:magic_at + 4] = S._XCI_MAGIC
    struct.pack_into('<Q', head, S._XCI_HFS0_OFFSET, 0x200)
    path.write_bytes(bytes(head) + root)
    return path


def make_ticket(title_id, key=b'\xAB' * 16):
    """A common-signature ticket whose rights ID opens with the title."""
    blob = bytearray(S._TICKET_MIN_SIZE)
    blob[S._TICKET_KEY_OFFSET:S._TICKET_KEY_OFFSET + 16] = key
    rights = bytes.fromhex(title_id) + b'\0' * 8
    blob[S._TICKET_RIGHTS_ID_OFFSET:S._TICKET_RIGHTS_ID_OFFSET + 16] = rights
    return bytes(blob)


NCA_A = 'b7bdc53bba9328826aee26f2c00c15ae.nca'
NCA_B = '580cb2ad6afe2ec60d545c9a08cda114.cnmt.nca'
NCA_C = 'a9ae812b2773995aab7c2630e80a7fd7.nca'


def main():
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        # Markers live under config_dir(), which derives from HOME. Point it at
        # the temp tree so a run never writes into the real ~/.config -- the
        # same trap test_firmware.py documents.
        os.environ['HOME'] = str(d / 'home')
        (d / 'home').mkdir()

        data = d / 'eden'
        (data / 'nand/user/Contents/registered').mkdir(parents=True)
        (data / 'keys').mkdir(parents=True)
        target = data / 'nand/user/Contents/registered'

        # ── container reading ────────────────────────────────────────────
        nsp = make_nsp(d / f'Game [{UPDATE_ID}][v131072].nsp', [
            (NCA_A, b'A' * 100),
            (NCA_B, b'C' * 50),
            ('meta.tik', make_ticket(UPDATE_ID)),
        ])
        members = S.container_members(nsp)
        check('nsp member names', [m[0] for m in members],
              [NCA_A, NCA_B, 'meta.tik'])
        check('nsp member sizes', [m[2] for m in members], [100, 50, 0x2C0])
        with open(nsp, 'rb') as fh:
            fh.seek(members[0][1])
            check('nsp member payload', fh.read(members[0][2]), b'A' * 100)

        xci = make_xci(d / f'Game [{UPDATE_ID}].xci', [(NCA_C, b'X' * 30)])
        xci_members = S.container_members(xci)
        check('xci finds secure partition', [m[0] for m in xci_members], [NCA_C])
        with open(xci, 'rb') as fh:
            fh.seek(xci_members[0][1])
            check('xci member payload', fh.read(30), b'X' * 30)

        # ── identification ───────────────────────────────────────────────
        info = T.switch_content_from_name(nsp.name)
        check('kind from name', info['kind'], 'update')
        check('base from name', info['base_id'], BASE_ID)
        check('version from name', info['version'], 131072)
        check('compressed declined', T.switch_content_from_name(
            f'Game [{UPDATE_ID}].nsz')['compressed'], True)

        # ── install ──────────────────────────────────────────────────────
        result = S.install(nsp, extra_data_dir=data)
        check('install ok', result['status'], 'ok')
        check('install wrote both NCAs', result['installed'], 2)
        check('NCAs land flat under their own names',
              sorted(p.name for p in target.iterdir()), sorted([NCA_A, NCA_B]))
        check('ticket is not installed as content',
              (target / 'meta.tik').exists(), False)
        check('title key appended',
              'ab' * 16 in (data / 'keys/title.keys').read_text(), True)
        check('manifest records the version', S.installed_version(UPDATE_ID), 131072)

        # Re-running the same file is a no-op, not a rewrite.
        again = S.install(nsp, extra_data_dir=data)
        check('same version is skipped', again['status'], 'current')

        # ── replacing an older patch ─────────────────────────────────────
        # A newer update brings a different meta NCA. The old one MUST go: two
        # metas for one title in a flat directory make the applied version
        # depend on Eden's scan order.
        newer = make_nsp(d / f'Game [{UPDATE_ID}][v196608].nsp', [
            (NCA_C, b'N' * 40),
        ])
        result = S.install(newer, extra_data_dir=data)
        check('newer version installs', result['status'], 'ok')
        check('old NCAs removed', sorted(p.name for p in target.iterdir()), [NCA_C])
        check('manifest follows the new version',
              S.installed_version(UPDATE_ID), 196608)

        # ── DLC coexists with the update ─────────────────────────────────
        dlc = make_nsp(d / f'Game DLC [{DLC_ID}].nsp', [(NCA_A, b'D' * 20)])
        result = S.install(dlc, extra_data_dir=data)
        check('dlc installs', result['status'], 'ok')
        check('dlc does not evict the update',
              sorted(p.name for p in target.iterdir()), sorted([NCA_A, NCA_C]))
        grouped = S.installed_for_base(BASE_ID)
        check('update tracked under its base', grouped['update']['title_id'], UPDATE_ID)
        check('dlc tracked under its base',
              [r['title_id'] for r in grouped['dlc']], [DLC_ID])

        # ── refusals ─────────────────────────────────────────────────────
        base = make_nsp(d / f'Game [{BASE_ID}].nsp', [(NCA_A, b'B' * 10)])
        check('base game refused', S.install(base, extra_data_dir=data)['status'],
              'base')
        untagged = make_nsp(d / 'Some Game.nsp', [(NCA_A, b'?' * 10)])
        check('untagged file refused',
              S.install(untagged, extra_data_dir=data)['status'], 'not-switch')
        (d / f'Game [{UPDATE_ID}].nsz').write_bytes(b'not a container')
        check('compressed refused', S.install(
            d / f'Game [{UPDATE_ID}].nsz', extra_data_dir=data)['status'],
            'compressed')

        # ── traversal ────────────────────────────────────────────────────
        # A member naming a path must buy the container nothing: same
        # destination as one named plainly, never an escape from registered/.
        evil_id = '0100152000099800'
        evil = make_nsp(d / f'Evil [{evil_id}].nsp', [
            (f'../../../../{NCA_C}', b'E' * 10),
        ])
        result = S.install(evil, extra_data_dir=data)
        check('traversal member stays in registered/', result['status'], 'ok')
        check('nothing escaped the target',
              (data / 'nand/user/Contents' / NCA_C).exists(), False)

        # ── uninstall ────────────────────────────────────────────────────
        S.uninstall(DLC_ID, extra_data_dir=data)
        check('uninstall forgets the title', S.installed_version(DLC_ID), None)
        check('uninstall leaves other titles alone',
              (target / NCA_C).exists(), True)

        # ── truncated container ──────────────────────────────────────────
        truncated_id = '0100152000088800'
        blob = build_partition(S._PFS0_MAGIC, S._PFS0_ENTRY,
                               [(NCA_A, b'T' * 100)])
        (d / f'Cut [{truncated_id}].nsp').write_bytes(blob[:-40])
        result = S.install(d / f'Cut [{truncated_id}].nsp', extra_data_dir=data)
        check('truncated container refused', result['status'], 'unreadable')
        check('failed install leaves nothing behind',
              S.installed_version(truncated_id), None)

        # ── grouping ─────────────────────────────────────────────────────
        library = [
            f'Game [{BASE_ID}].nsp',
            f'Game [{UPDATE_ID}][v131072].nsp',
            f'Game [{UPDATE_ID}][v196608].nsp',
            f'Game DLC [{DLC_ID}].nsp',
            'Super Mario Bros.nes',
        ]
        groups = T.group_switch_content(library)
        check('one group per base game', list(groups), [BASE_ID])
        check('newest update first', groups[BASE_ID]['update'][0],
              f'Game [{UPDATE_ID}][v196608].nsp')
        check('non-switch entries dropped', len(groups[BASE_ID]['base']), 1)

    # ── sibling grouping ─────────────────────────────────────────────────
    # RomM returns a base game and its patch as siblings, and both are plain
    # .nsp files with one entry each -- so every test the grouper had (folder
    # ROM, is_main_sibling, file count) is blind to the difference and the tile
    # fell to whichever the API listed first. Shaped after the real rows for
    # Mario Party Superstars, where the update won and the base game got no
    # tile at all.
    from romm_sync_engine.sync_core import RomMClient  # noqa: E402

    def sibling_row(rom_id, fs_name, siblings, extension='.nsp'):
        return {'id': rom_id, 'name': fs_name.rsplit('.', 1)[0],
                'fs_name': fs_name, 'fs_extension': extension,
                'files': [{'file_name': fs_name}],
                'sibling_roms': [{'id': s} for s in siblings], 'rom_user': {}}

    sw_base = f'Mario Party Superstars [01006FE013472000][v0].nsp'
    sw_update = f'Mario Party Superstars [01006FE013472800][v131072].nsp'
    for order in ([47, 48], [48, 47]):
        rows = {47: sibling_row(47, sw_update, [48]),
                48: sibling_row(48, sw_base, [47])}
        grouped = RomMClient._group_sibling_roms(None, [rows[i] for i in order])
        check(f'base game wins the tile (API order {order})',
              grouped[0]['id'], 48)

    # A group of add-ons with no base present still prefers the patch to DLC.
    rows = [sibling_row(2, f'Game DLC [{DLC_ID}].nsp', [1]),
            sibling_row(1, f'Game [{UPDATE_ID}][v131072].nsp', [2])]
    check('update outranks dlc when no base is present',
          RomMClient._group_sibling_roms(None, rows)[0]['id'], 1)

    # Non-Switch groups must be untouched: the folder ROM still wins on files.
    disc = [
        {'id': 1, 'name': 'G-Police (Disc 1)', 'fs_name': 'G-Police (Disc 1).chd',
         'fs_extension': '.chd', 'files': [{'file_name': 'a'}],
         'sibling_roms': [{'id': 2}], 'rom_user': {}},
        {'id': 2, 'name': 'G-Police', 'fs_name': 'G-Police', 'fs_extension': '',
         'files': [{'file_name': 'a'}, {'file_name': 'b'}],
         'sibling_roms': [{'id': 1}], 'rom_user': {}},
    ]
    check('non-switch folder ROM still wins',
          RomMClient._group_sibling_roms(None, disc)[0]['id'], 2)

    # ── add-on discovery through siblings ────────────────────────────────
    # The add-ons of a game are usually NOT library entries: sibling grouping
    # folds them into the base game's row, which is what puts one tile on
    # screen instead of three. A scan of the library alone therefore finds
    # nothing to install -- shaped after the real Mario Kart 8 entry, whose
    # update and DLC both arrive only as folded siblings.
    from romm_sync_engine.sync_core import AutoSyncManager  # noqa: E402

    class _Shim:
        available_games = []

    rom = {
        'id': 44,
        'fs_name': f'Mario Kart 8 Deluxe [{BASE_ID}][v0].nsp',
        '_sibling_files': [
            {'id': 45, 'fs_name': f'Mario Kart 8 Deluxe [{UPDATE_ID}][v1245184].nsp'},
            {'id': 46, 'fs_name': f'Mario Kart 8 Deluxe [DLC] [{DLC_ID}][v65536].nsp'},
        ],
    }
    found = AutoSyncManager.switch_add_ons_for_rom(_Shim(), rom, library=[])
    check('add-ons are found among folded siblings',
          [a['id'] for a in found], [45, 46])

    # The base game must never come back as an add-on to itself.
    check('the base game is not its own add-on',
          all(a['id'] != 44 for a in found), True)

    # A bare "<Game>.xci" beside fully tagged add-ons is an ordinary dump, and
    # the row the user presses is the untagged one. Reading only that name
    # throws away the only names in the group that identify it -- shaped after
    # the real Super Mario Party entry.
    untagged_tile = {
        'id': 49,
        'fs_name': 'Super Mario Party.xci',
        '_sibling_files': [
            {'id': 50, 'fs_name': f'Super Mario Party [{BASE_ID}][v0].nsp'},
            {'id': 51, 'fs_name': f'Super Mario Party [{UPDATE_ID}][v131072].nsp'},
        ],
    }
    found = AutoSyncManager.switch_add_ons_for_rom(_Shim(), untagged_tile, library=[])
    check('an untagged tile is identified by its tagged siblings',
          [a['id'] for a in found], [51])

    # A candidate pool spanning two different games must not be resolved by
    # picking one: the add-ons of the wrong title would install just as readily.
    ambiguous = {
        'id': 1, 'fs_name': 'Bundle.xci',
        '_sibling_files': [
            {'id': 2, 'fs_name': f'A [{UPDATE_ID}][v1].nsp'},
            {'id': 3, 'fs_name': 'B [01006FE013472800][v1].nsp'},
        ],
    }
    check('an ambiguous pool yields nothing',
          AutoSyncManager.switch_add_ons_for_rom(_Shim(), ambiguous, library=[]), [])

    # An untagged pair cannot be classified by name at all. Returning nothing is
    # the correct answer -- guessing which of two lookalike files is the patch
    # would install a base game into NAND, which Eden refuses anyway.
    untagged = {'id': 1, 'fs_name': 'Metroid Dread.xci',
                '_sibling_files': [{'id': 2, 'fs_name': 'Metroid Dread v327680.nsp'}]}
    check('untagged siblings yield nothing rather than a guess',
          AutoSyncManager.switch_add_ons_for_rom(_Shim(), untagged, library=[]), [])

    # ── the bundled library is actually bundled ──────────────────────────
    # Two blanket rules nearly dropped it silently, each leaving a tree that
    # looks complete and a build that ships nothing: .gitignore's "*.so", and
    # pyproject shipping no package-data (the desktop AppImage pip-installs the
    # engine rather than importing the tree). Neither failure is visible at
    # runtime -- identification just goes back to reading filenames -- so it is
    # asserted here rather than trusted.
    bundled = (Path(__file__).resolve().parents[1]
               / 'romm_sync_engine' / 'bin' / 'libsigil.so')
    check('the Sigil build is present in the package', bundled.is_file(), True)
    check('and it loads without LUDO_SIGIL_LIB set', T.sigil_available(), True)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failure(s): {', '.join(FAILURES)}")
        return 1
    print("all ok")
    return 0


if __name__ == '__main__':
    sys.exit(main())
