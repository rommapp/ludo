"""PS2 card images read out as, and restored from, Argosy's save zips.

Run with `python3 engine/tests/test_ps2_memcard.py`.

RetroArch's PS2 core keeps each game's card as one image file; Argosy syncs a
PS2 save as a zip of the game's own card folders. The cards here are built by
hand to the console's layout (superblock, two-level FAT, 512-byte directory
entries), with and without per-page ECC, so the reader is checked against the
format rather than against itself. It was also run on real LRPS2 cards; those
are not committed because they are someone's saves.
"""

import io
import os
import struct
import sys
import zipfile
import tempfile
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import ps2_memcard as M  # noqa: E402

FAILURES = []


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


CLUSTER = 1024
ALLOC_OFFSET = 41
IFC, FAT = 8, 9


def tod(year, month, day, hour=12, minute=0, sec=0):
    return struct.pack('<BBBBBBH', 0, sec, minute, hour, day, month, year)


def entry(name, mode, length, cluster, when=tod(2026, 9, 15)):
    raw = struct.pack('<HHI', mode, 0, length) + when
    raw += struct.pack('<II', cluster, 0) + when
    raw = raw.ljust(64, b'\0') + name.encode().ljust(32, b'\0')
    return raw.ljust(512, b'\0')


class Builder:
    """Just enough of a card formatter to lay out folders and files."""

    def __init__(self):
        self.clusters = {}  # allocatable cluster -> bytes
        self.fat = {}
        self.next = 0

    def alloc(self, data):
        n = max(1, -(-len(data) // CLUSTER))
        chain = list(range(self.next, self.next + n))
        self.next += n
        for i, c in enumerate(chain):
            self.clusters[c] = data[i * CLUSTER:(i + 1) * CLUSTER].ljust(CLUSTER, b'\0')
            nxt = chain[i + 1] if i + 1 < n else 0x7FFFFFFF
            self.fat[c] = 0x80000000 | nxt
        return chain[0]

    def card(self, folders, ecc=True, deleted=()):
        """folders: {name: {file: bytes}}. Root at cluster 0, as on a real card."""
        self.alloc(b'\0' * 2 * 512)  # root placeholder, rewritten below
        root_entries = []
        for name, files in folders.items():
            file_entries = [(f, len(d), self.alloc(d)) for f, d in files.items()]
            body = b''.join(entry(f, 0x8097, ln, c) for f, ln, c in file_entries)
            count = 2 + len(file_entries)
            here = self.alloc(b'\0' * count * 512)
            dir_raw = (entry('.', 0x8427, count, here) + entry('..', 0xA426, 0, 0)
                       + body)
            for i in range(0, len(dir_raw), CLUSTER):
                self.clusters[here + i // CLUSTER] = dir_raw[i:i + CLUSTER].ljust(CLUSTER, b'\0')
            root_entries.append(entry(name, 0x8427, count, here))
        for name in deleted:
            root_entries.append(entry(name, 0x0427, 2, 0))  # exists bit clear
        count = 2 + len(root_entries)
        root_raw = (entry('.', 0x8427, count, 0) + entry('..', 0xA426, 0, 0)
                    + b''.join(root_entries))
        # The root grows past its placeholder here; chain the extra clusters.
        need = -(-len(root_raw) // CLUSTER)
        chain = [0] + [self.alloc(b'') for _ in range(need - 1)]
        for i, c in enumerate(chain):
            self.clusters[c] = root_raw[i * CLUSTER:(i + 1) * CLUSTER].ljust(CLUSTER, b'\0')
            self.fat[c] = 0x80000000 | (chain[i + 1] if i + 1 < len(chain) else 0x7FFFFFFF)
        return self._image(ecc)

    def _image(self, ecc):
        pages = [b'\xff' * 512] * M.PAGES
        sb = M.MAGIC + b'1.2.0.0'.ljust(12, b'\0')
        sb += struct.pack('<HHHHIIIIII', 512, 2, 16, 0xFF00, 8192,
                          ALLOC_OFFSET, 8135, 0, 1023, 1022)
        sb = sb.ljust(0x50, b'\0') + struct.pack('<32I', IFC, *([0] * 31))
        sb = sb.ljust(0x150, b'\0') + bytes([2, 0x2B])
        pages[0] = sb.ljust(512, b'\0')

        def put(cluster, data):
            pages[cluster * 2] = data[:512]
            pages[cluster * 2 + 1] = data[512:1024]

        put(IFC, struct.pack('<256I', FAT, *([0xFFFFFFFF] * 255)))
        fat = [self.fat.get(i, 0x7FFFFFFF) for i in range(256)]
        put(FAT, struct.pack('<256I', *fat))
        for c, data in self.clusters.items():
            put(c + ALLOC_OFFSET, data)
        spare = b'\0' * M.SPARE if ecc else b''
        return b''.join(p + spare for p in pages)


def main():
    big = bytes(range(256)) * 20  # 5120 bytes: five clusters
    folders = {
        'BASLUS-20152SYS': {'icon.sys': b'PS2D' + b'\0' * 960, 'icon.ico': b'ICO'},
        'BASLUS-20152AC04': {'BASLUS-20152AC04': big},
        'BESLES-50000DATA': {'data': b'other game'},
    }

    for ecc in (True, False):
        tag = 'ecc' if ecc else 'no ecc'
        card = M.Card(Builder().card(folders, ecc=ecc, deleted=['BASLUS-20152OLD']))
        check(f'[{tag}] folders listed, deleted one skipped',
              [f.name for f in card.folders()], list(folders))
        ac04 = card.folders()[1]
        got = card.files(ac04)[0][1]
        check(f'[{tag}] a file spanning several clusters reads back whole',
              (len(got), zlib.crc32(got)), (len(big), zlib.crc32(big)))

    card = M.Card(Builder().card(folders))
    for save_id, want in [
        ('SLUS-20152', ['BASLUS-20152SYS', 'BASLUS-20152AC04']),   # bare serial
        ('SLUS_201.52', []),  # SYSTEM.CNF spelling: Argosy does not match it
        ('BASLUS-20152', ['BASLUS-20152SYS', 'BASLUS-20152AC04']),
        ('BESLUS-20152', ['BASLUS-20152SYS', 'BASLUS-20152AC04']),  # wrong region
        ('SLES-50000', ['BESLES-50000DATA']),                      # E -> BE
        ('SLUS-99999', []),
    ]:
        check(f'save id {save_id}', [f.name for f in M.game_folders(card, save_id)], want)

    z = zipfile.ZipFile(io.BytesIO(M.export_zip(card, 'SLUS-20152')))
    check('zip is rooted at the game folders, other games left out',
          sorted(i.filename for i in z.infolist()),
          ['BASLUS-20152AC04/', 'BASLUS-20152AC04/BASLUS-20152AC04',
           'BASLUS-20152SYS/', 'BASLUS-20152SYS/icon.ico', 'BASLUS-20152SYS/icon.sys'])
    got = z.read('BASLUS-20152AC04/BASLUS-20152AC04')
    check('zip content intact', zlib.crc32(got), zlib.crc32(big))
    check('zip keeps the card timestamp',
          z.getinfo('BASLUS-20152SYS/icon.sys').date_time, (2026, 9, 15, 12, 0, 0))
    check('no save for the game gives no zip', M.export_zip(card, 'SLUS-99999'), None)

    for name, data, want in [
        ('unformatted card', b'\xff' * (M.PAGES * 528), 'card is not formatted'),
        ('wrong size', b'\0' * 1000, 'unexpected card size 1000'),
    ]:
        try:
            M.Card(data)
            check(name, 'opened', want)
        except M.CardError as e:
            check(name, str(e), want)

    write_side()

    print('\nall passed' if not FAILURES else f'\n{len(FAILURES)} FAILED')
    return 1 if FAILURES else 0


def zip_of(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        for name, data in entries.items():
            z.writestr(zipfile.ZipInfo(name, (2026, 9, 20, 18, 30, 0)), data)
    return buf.getvalue()


def contents(path):
    card = M.Card.open(path)
    return {f.name: {e.name: d for e, d in card.files(f)} for f in card.folders()}


def used(path):
    card = M.Card.open(path)
    return sum(1 for n in range(card._alloc_end) if card._fat(n) & 0x80000000)


def write_side():
    # The superblock page of a card the console formatted, and its spare
    # bytes as LRPS2 wrote them: a known answer for both format and ECC.
    blank = M.format_card()
    check('formatted superblock ECC matches the console',
          M.page_ecc(blank[:512]).hex(), '07344b777f7f25710e777f7f00000000')
    check('a zero chunk encodes as the console does',
          M.page_ecc(bytes(512)).hex(), '777f7f' * 4 + '00000000')
    check('formatted card opens empty', M.Card(blank).folders(), [])
    check('erased pages carry no ECC', blank[-16:], b'\xff' * 16)

    save = {'BASLUS-20152SYS/icon.sys': b'PS2D' + bytes(960),
            'BASLUS-20152SYS/empty': b'',
            'BASLUS-20152AC04/BASLUS-20152AC04': bytes(range(256)) * 40}
    want = {'BASLUS-20152SYS': {'icon.sys': b'PS2D' + bytes(960), 'empty': b''},
            'BASLUS-20152AC04': {'BASLUS-20152AC04': bytes(range(256)) * 40}}

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'Game.ps2')
        check('restore into a card that does not exist yet',
              M.restore_zip(path, zip_of(save), 'SLUS-20152'),
              ['BASLUS-20152AC04', 'BASLUS-20152SYS'])
        check('restored folders read back byte for byte', contents(path), want)
        check('no backup of a card that did not exist',
              os.path.exists(path + '.backup'), False)
        check('card timestamp comes from the zip',
              M.Card.open(path).folders()[0].modified, M.datetime.datetime(2026, 9, 20, 18, 30))

        # Another game's folder on the same card must survive a restore.
        other = os.path.join(tmp, 'Shared.ps2')
        with open(other, 'wb') as f:
            f.write(Builder().card({'BESLES-50000DATA': {'data': b'other game'}}))
        with open(other, 'rb') as f:
            before = f.read()
        M.restore_zip(other, zip_of(save), 'SLUS-20152')
        check('other games on the card are untouched',
              contents(other)['BESLES-50000DATA'], {'data': b'other game'})
        with open(other + '.backup', 'rb') as f:
            check('the previous card is kept as .backup', f.read() == before, True)

        # Replacing a save frees the old one's clusters.
        start = used(path)
        for _ in range(3):
            M.restore_zip(path, zip_of(save), 'SLUS-20152')
        check('replacing a save does not leak space', used(path), start)
        check('replaced save still reads back', contents(path), want)

        # Argosy's older shape: rooted at the card, folders one level down,
        # plus the bookkeeping files a PCSX2 folder card keeps.
        card_rooted = {f'Mcd001.ps2/{k}': v for k, v in save.items()}
        card_rooted['Mcd001.ps2/_pcsx2_superblock'] = b'x'
        card_rooted['Mcd001.ps2/BASLUS-20152SYS/_pcsx2_meta_directory'] = b'x'
        card_rooted['Mcd001.ps2/BESLES-50000DATA/data'] = b'not ours'
        fresh = os.path.join(tmp, 'Rooted.ps2')
        M.restore_zip(fresh, zip_of(card_rooted), 'SLUS-20152')
        check('card-rooted zip: only this game, no PCSX2 bookkeeping',
              contents(fresh), want)

        for name, entries, error in [
            ('a zip with only another game', {'BESLES-50000DATA/data': b'x'},
             'the zip holds no save for SLUS-20152'),
            ('a subfolder inside a save', {'BASLUS-20152SYS/sub/file': b'x'},
             'BASLUS-20152SYS/sub/file: PS2 saves have no subfolders'),
            ('a save bigger than the card', {'BASLUS-20152BIG/big': bytes(9 * 1024 * 1024)},
             'card is full'),
        ]:
            with open(path, 'rb') as f:
                before = f.read()
            try:
                M.restore_zip(path, zip_of(entries), 'SLUS-20152')
                check(name, 'restored', error)
            except M.CardError as e:
                check(name, str(e), error)
            with open(path, 'rb') as f:
                check(f'{name}: card left untouched', f.read() == before, True)

        # A card without ECC stays without ECC.
        plain = os.path.join(tmp, 'Plain.ps2')
        with open(plain, 'wb') as f:
            f.write(M.format_card(ecc=False))
        M.restore_zip(plain, zip_of(save), 'SLUS-20152')
        check('a card without ECC keeps its size',
              os.path.getsize(plain), M.PAGES * M.PAGE)
        check('and reads back', contents(plain), want)


if __name__ == '__main__':
    sys.exit(main())
