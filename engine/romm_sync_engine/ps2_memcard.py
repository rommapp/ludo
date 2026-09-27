"""PS2 memory card images, read as the folders a game saved into them.

RetroArch's PS2 core (LRPS2) keeps a memory card as one 8 MB image file, and
has no folder-card mode at all. Argosy, and standalone PCSX2 with folder cards,
sync a PS2 save as a zip of the game's own card folders ("BASLUS-20152SYS",
"BASLUS-20152AC04", ...), cut out of a card that holds every game's saves. To
share saves with them, Ludo reads the same folders out of the image.

The image is the console's own filesystem, documented by mymc and PCSX2:

- A superblock on page 0 gives the geometry: 512-byte pages, two pages to a
  cluster, 8192 clusters.
- Each page may be followed by 16 bytes of ECC. PCSX2 and LRPS2 both write
  them (8,650,752 bytes, 528 per page); a card without them is 8,388,608.
- Clusters are chained by a FAT, reached through a two-level index: the
  superblock's ifc_list names indirect clusters, which name FAT clusters,
  which hold one 32-bit entry per cluster. Bit 31 marks a cluster in use, and
  0x7FFFFFFF in the low bits ends a chain.
- A directory is a file of 512-byte entries, "." and ".." first. File and
  directory clusters are numbered from alloc_offset; FAT and indirect
  clusters are not.

Writing (restore_zip) edits a copy of the card, reads the copy back to prove
it holds exactly what was asked, and only then replaces the file, keeping the
old card beside it. A card this module cannot read is never written.
"""

import datetime
import io
import os
import re
import struct
import zipfile

MAGIC = b'Sony PS2 Memory Card Format '
PAGE = 512
SPARE = 16
PAGES = 16384  # 8 MB cards, the only size PCSX2 and LRPS2 create

_MODE_EXISTS = 0x8000
_MODE_DIR = 0x0020
_MODE_FILE = 0x0010
_CHAIN_END = 0x7FFFFFFF
_ENTRY = 512


# ── ECC ───────────────────────────────────────────────────────────────
# Three bytes per 128-byte chunk, twelve per page, then four zero bytes of the
# 16-byte spare area. Hamming-style parity as the console computes it (mymc's
# ps2mc_ecc); verified against every page of real LRPS2 cards.
_PARITY = [bin(b).count('1') & 1 for b in range(256)]
_COLUMN = [sum(_PARITY[b & m] << i
               for i, m in enumerate((0x55, 0x33, 0x0F, 0x00, 0xAA, 0xCC, 0xF0)))
           for b in range(256)]


def _ecc_chunk(chunk):
    column, line0, line1 = 0x77, 0x7F, 0x7F
    for i, b in enumerate(chunk):
        column ^= _COLUMN[b]
        if _PARITY[b]:
            line0 ^= ~i
            line1 ^= i
    return bytes((column, line0 & 0x7F, line1))


def page_ecc(page):
    """The 16-byte spare area for one 512-byte page."""
    return b''.join(_ecc_chunk(page[i:i + 128]) for i in range(0, PAGE, 128)) + bytes(4)


class CardError(Exception):
    """The file is not a PS2 memory card this module can read."""


class Entry:
    """One directory entry: a save folder or a file inside one."""

    __slots__ = ('name', 'mode', 'length', 'cluster', 'created', 'modified')

    def __init__(self, raw):
        (self.mode, _, self.length) = struct.unpack_from('<HHI', raw, 0)
        self.created = _tod(raw[8:16])
        (self.cluster,) = struct.unpack_from('<I', raw, 16)
        self.modified = _tod(raw[24:32])
        self.name = raw[64:96].split(b'\0', 1)[0].decode('ascii', 'replace')

    @property
    def exists(self):
        return bool(self.mode & _MODE_EXISTS)

    @property
    def is_dir(self):
        return bool(self.mode & _MODE_DIR)


def _tod(raw):
    """A card timestamp, as a naive datetime in the console's clock (JST).

    Layout: unused, second, minute, hour, day, month, year (u16). Returns
    None when the fields are not a real date, which unformatted or
    hand-built entries often are.
    """
    sec, minute, hour, day, month, year = struct.unpack_from('<BBBBBH', raw, 1)
    try:
        return datetime.datetime(year, month, day, hour, minute, sec)
    except ValueError:
        return None


class Card:
    """A PS2 memory card image held in memory."""

    def __init__(self, data):
        if len(data) == PAGES * (PAGE + SPARE):
            self._stride = PAGE + SPARE
        elif len(data) == PAGES * PAGE:
            self._stride = PAGE
        else:
            raise CardError(f'unexpected card size {len(data)}')
        self._data = bytearray(data)
        if not data.startswith(MAGIC):
            # A card PCSX2 created but no game ever formatted is all 0xFF.
            raise CardError('card is not formatted')
        (page_len, self._ppc, _, _, self._clusters, self._alloc_offset,
         self._alloc_end, self._root) = struct.unpack_from('<HHHHIIII', data, 0x28)
        if page_len != PAGE or self._ppc != 2:
            raise CardError(f'unsupported geometry: page {page_len}, '
                            f'{self._ppc} pages per cluster')
        self._ifc = struct.unpack_from('<32I', data, 0x50)
        self._fat_cache = {}

    @classmethod
    def open(cls, path):
        with open(path, 'rb') as f:
            return cls(f.read())

    @property
    def ecc(self):
        return self._stride != PAGE

    def image(self):
        return bytes(self._data)

    # ── clusters and the FAT ────────────────────────────────────────────
    def _page(self, n):
        start = n * self._stride
        return self._data[start:start + PAGE]

    def _cluster(self, n):
        """Cluster n, counted from the start of the card."""
        first = n * self._ppc
        return b''.join(self._page(first + i) for i in range(self._ppc))

    def _words(self, n):
        key = n
        if key not in self._fat_cache:
            raw = self._cluster(n)
            self._fat_cache[key] = struct.unpack(f'<{len(raw) // 4}I', raw)
        return self._fat_cache[key]

    def _fat(self, n):
        """The FAT entry for allocatable cluster n."""
        per = self._ppc * PAGE // 4
        indirect_index, offset = divmod(n, per)
        dbl, indirect_offset = divmod(indirect_index, per)
        if dbl >= len(self._ifc):
            raise CardError(f'cluster {n} is beyond the FAT')
        fat_cluster = self._words(self._ifc[dbl])[indirect_offset]
        return self._words(fat_cluster)[offset]

    def _chain(self, start):
        """Allocatable cluster numbers of the chain starting at `start`."""
        out, seen, n = [], set(), start
        while True:
            if n in seen or n >= self._clusters:
                raise CardError(f'broken cluster chain at {n}')
            seen.add(n)
            out.append(n)
            entry = self._fat(n)
            if not entry & 0x80000000:
                raise CardError(f'chain runs into free cluster {n}')
            nxt = entry & 0x7FFFFFFF
            if nxt == _CHAIN_END:
                return out
            n = nxt

    def _read(self, start, length):
        """`length` bytes of the file or directory starting at `start`."""
        if not length:
            return b''
        size = self._ppc * PAGE
        need = -(-length // size)
        chain = self._chain(start)
        if len(chain) < need:
            raise CardError(f'chain at {start} is shorter than its length')
        data = b''.join(self._cluster(c + self._alloc_offset)
                        for c in chain[:need])
        return data[:length]

    # ── directories ─────────────────────────────────────────────────────
    def _entries(self, cluster, count):
        raw = self._read(cluster, count * _ENTRY)
        return [Entry(raw[i:i + _ENTRY]) for i in range(0, len(raw), _ENTRY)]

    def _root_self(self):
        # The root's own length (its entry count) is in its "." entry.
        return Entry(self._read(self._root, _ENTRY))

    def folders(self):
        """The save folders at the card's root, skipping deleted entries."""
        root = self._root_self()
        return [e for e in self._entries(self._root, root.length)[2:]
                if e.exists and e.is_dir]

    def files(self, folder):
        """(Entry, bytes) for every file in a save folder."""
        out = []
        for e in self._entries(folder.cluster, folder.length)[2:]:
            if e.exists and not e.is_dir and e.mode & _MODE_FILE:
                out.append((e, self._read(e.cluster, e.length)))
        return out

    # ── writing ─────────────────────────────────────────────────────────
    def _set_page(self, n, page):
        start = n * self._stride
        self._data[start:start + PAGE] = page
        if self.ecc:
            self._data[start + PAGE:start + self._stride] = page_ecc(page)

    def _set_cluster(self, n, data):
        data = data.ljust(self._ppc * PAGE, b'\0')
        for i in range(self._ppc):
            self._set_page(n * self._ppc + i, data[i * PAGE:(i + 1) * PAGE])

    def _set_fat(self, n, value):
        per = self._ppc * PAGE // 4
        indirect_index, offset = divmod(n, per)
        dbl, indirect_offset = divmod(indirect_index, per)
        fat_cluster = self._words(self._ifc[dbl])[indirect_offset]
        words = list(self._words(fat_cluster))
        words[offset] = value
        self._fat_cache[fat_cluster] = tuple(words)
        self._set_cluster(fat_cluster, struct.pack(f'<{per}I', *words))

    def _allocate(self, count):
        """`count` free clusters chained together; the first one's number."""
        free = []
        for n in range(self._alloc_end):
            if not self._fat(n) & 0x80000000:
                free.append(n)
                if len(free) == count:
                    break
        if len(free) < count:
            raise CardError('card is full')
        for i, n in enumerate(free):
            nxt = free[i + 1] if i + 1 < count else _CHAIN_END
            self._set_fat(n, 0x80000000 | nxt)
        return free

    def _free(self, start):
        for n in self._chain(start):
            self._set_fat(n, _CHAIN_END)

    def _write_new(self, data):
        """Store `data` in freshly allocated clusters; the first cluster."""
        size = self._ppc * PAGE
        chain = self._allocate(max(1, -(-len(data) // size)))
        for i, n in enumerate(chain):
            self._set_cluster(n + self._alloc_offset, data[i * size:(i + 1) * size])
        return chain[0]

    def _rewrite(self, start, data):
        """Overwrite the chain at `start` with `data`, growing it if needed."""
        size = self._ppc * PAGE
        chain = self._chain(start)
        need = max(1, -(-len(data) // size))
        if need > len(chain):
            extra = self._allocate(need - len(chain))
            self._set_fat(chain[-1], 0x80000000 | extra[0])
            chain += extra
        for i, n in enumerate(chain[:need]):
            self._set_cluster(n + self._alloc_offset, data[i * size:(i + 1) * size])

    def _root_raw(self):
        return bytearray(self._read(self._root, self._root_self().length * _ENTRY))

    def delete_folder(self, name):
        """Remove a root save folder and free its clusters, as the console
        does: the entry stays, with its exists bit cleared, for reuse."""
        raw = self._root_raw()
        for i in range(2, len(raw) // _ENTRY):
            e = Entry(bytes(raw[i * _ENTRY:(i + 1) * _ENTRY]))
            if e.exists and e.is_dir and e.name == name:
                for child in self._entries(e.cluster, e.length)[2:]:
                    if child.exists and child.length:
                        self._free(child.cluster)
                self._free(e.cluster)
                struct.pack_into('<H', raw, i * _ENTRY, e.mode & ~_MODE_EXISTS)
                self._rewrite(self._root, bytes(raw))
                return True
        return False

    def add_folder(self, name, files, when=None):
        """Create a root save folder. files: [(name, bytes, datetime|None)]."""
        _check_name(name)
        for fname, _, _ in files:
            _check_name(fname)
        when = when or datetime.datetime.now()
        raw = self._root_raw()
        slot = next((i for i in range(2, len(raw) // _ENTRY)
                     if not Entry(bytes(raw[i * _ENTRY:(i + 1) * _ENTRY])).exists),
                     len(raw) // _ENTRY)

        body = []
        for fname, data, fwhen in files:
            cluster = self._write_new(data) if data else _CHAIN_END | 0x80000000
            body.append(_entry(fname, 0x8497, len(data), cluster, fwhen or when))
        # "." points back at this folder's own entry in the root; ".." is
        # empty. Both carry the folder mode, which is what the console writes.
        count = 2 + len(body)
        here = self._write_new(b'\0' * count * _ENTRY)
        own = (_entry('.', 0x8427, 0, self._root, when, dir_entry=slot)
               + _entry('..', 0x8427, 0, 0, when) + b''.join(body))
        self._rewrite(here, own)

        new = _entry(name, 0x8427, count, here, when)
        if slot * _ENTRY < len(raw):
            raw[slot * _ENTRY:(slot + 1) * _ENTRY] = new
        else:
            raw += new
            struct.pack_into('<I', raw, 4, len(raw) // _ENTRY)  # root "." length
        self._rewrite(self._root, bytes(raw))


def _check_name(name):
    if not name or len(name.encode('ascii', 'replace')) > 31 or '/' in name \
            or name in ('.', '..') or not name.isascii():
        raise CardError(f'not a valid card entry name: {name!r}')


def _to_tod(when):
    return struct.pack('<BBBBBBH', 0, when.second, when.minute, when.hour,
                       when.day, when.month, when.year)


def _entry(name, mode, length, cluster, when, dir_entry=0):
    tod = _to_tod(when)
    raw = struct.pack('<HHI', mode, 0, length) + tod
    raw += struct.pack('<II', cluster, dir_entry) + tod
    return (raw.ljust(64, b'\0') + name.encode('ascii').ljust(32, b'\0')).ljust(_ENTRY, b'\0')


def format_card(ecc=True):
    """A blank, formatted 8 MB card, laid out as the console formats one.

    PCSX2 and LRPS2 create cards unformatted (all 0xFF) and leave formatting
    to the first game that saves; a restore before that first launch has to
    format the card itself. The superblock's trailing fields are copied from
    cards the console formatted.
    """
    stride = PAGE + (SPARE if ecc else 0)
    # Unused pages are erased flash: 0xFF data AND 0xFF spare, no ECC.
    erased = b'\xff' * stride
    blank = bytearray(erased * PAGES)
    sb = MAGIC + b'1.2.0.0'.ljust(12, b'\0')
    sb += struct.pack('<HHHHIIIIII', PAGE, 2, 16, 0xFF00, 8192, 41, 8135, 0, 1023, 1022)
    sb = sb.ljust(0x50, b'\0') + struct.pack('<32I', 8, *([0] * 31))
    sb = sb.ljust(0xD0, b'\0') + b'\xff' * 0x80
    sb += struct.pack('<BBxx12I', 2, 0x2B, 0x400, 0x100, 8, 0xFFFFFFFF, 0, 0, 0,
                      0x1F41, 0, 0, 0xFFFFFFFF, 0xFFFFFFFF)
    sb = sb.ljust(PAGE, b'\xff')
    blank[0:PAGE] = sb
    if ecc:
        blank[PAGE:stride] = page_ecc(sb)
    card = Card(bytes(blank))
    card._set_cluster(8, struct.pack('<32I', *range(9, 41)).ljust(1024, b'\xff'))
    fat = [0xFFFFFFFF] + [_CHAIN_END] * 8134 + [0xFFFFFFFF] * (32 * 256 - 8135)
    for i in range(32):
        card._set_cluster(9 + i, struct.pack('<256I', *fat[i * 256:(i + 1) * 256]))
    card._fat_cache.clear()
    now = datetime.datetime.now()
    root = _entry('.', 0x8427, 2, 0, now) + _entry('..', 0xA426, 0, 0, now)
    card._set_cluster(41, root)
    return card.image()


# ── which folders belong to a game ──────────────────────────────────────
# Ported from Argosy's Ps2FolderHandler so both apps pick the same folders.
_REGION_PREFIXED = re.compile(r'^B[AEI][A-Z]{4}')
_BARE_SERIAL = re.compile(r'^([A-Z]{4})(\d+.*)$')


def _normalize(value):
    return value.replace('-', '').replace('_', '').upper()


def _stem(save_id):
    """A save id as the prefix its folders start with ("BASLUS20152").

    A bare disc serial gets the region prefix the console would add: the
    serial's third letter says where it was released.
    """
    cleaned = _normalize(save_id)
    if _REGION_PREFIXED.match(cleaned):
        return cleaned
    bare = _BARE_SERIAL.match(cleaned)
    if not bare:
        return cleaned
    code, rest = bare.groups()
    prefix = {'E': 'BE', 'P': 'BI', 'J': 'BI', 'K': 'BI'}.get(code[2], 'BA')
    return prefix + code + rest


def _without_region(stem):
    return stem[2:] if _REGION_PREFIXED.match(stem) else stem


def folder_matches(folder_name, save_id):
    """True when a card folder belongs to the game with this save id."""
    folder, stem = _normalize(folder_name), _stem(save_id)
    if folder.startswith(stem):
        return True
    # An older save id can carry the wrong region prefix; without it, the
    # serial alone still identifies the disc.
    return _without_region(folder).startswith(_without_region(stem))


# The console's own folders ("BADATA-SYSTEM", "BEEXEC-SYSTEM"...): browser
# settings and system updates, which no game owns.
_SYSTEM_FOLDER = re.compile(r'^B[AEI](DATA|EXEC)-', re.IGNORECASE)
# A game's save folders start with a region letter pair and its serial:
# "BASCUS-97490LV5RG_00" -> "BASCUS-97490".
_SAVE_STEM = re.compile(r'^(B[AEI][A-Z]{4}-?\d{5})', re.IGNORECASE)


def card_save_id(card):
    """The save id of the one game whose saves are on this card, or None.

    Read off the card rather than the disc: it works for a .chd no serial
    reader can open, and for the games that save under another edition's
    serial. None when the card holds no game's save, or several games' --
    a shared card cannot be attributed to one ROM.
    """
    stems = set()
    for folder in card.folders():
        if _SYSTEM_FOLDER.match(folder.name):
            continue
        m = _SAVE_STEM.match(folder.name)
        if not m:
            return None
        stems.add(m.group(1).upper())
    return stems.pop() if len(stems) == 1 else None


def zip_save_ids(zip_bytes):
    """The save ids a zip's game folders carry, in either of Argosy's shapes."""
    z = zipfile.ZipFile(io.BytesIO(zip_bytes))
    stems = set()
    for name in z.namelist():
        for part in name.strip('/').split('/')[:2]:
            m = _SAVE_STEM.match(part)
            if m:
                stems.add(m.group(1).upper())
                break
    return stems


def game_folders(card, save_id):
    return [f for f in card.folders() if folder_matches(f.name, save_id)]


def export_zip(card, save_id):
    """The game's save as Argosy uploads it, or None when it has none.

    A zip rooted at the game's folders, one entry per file
    ("BASLUS-20152SYS/icon.sys"), dated with each file's own timestamp.
    """
    folders = game_folders(card, save_id)
    if not folders:
        return None
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for folder in folders:
            z.writestr(_dir_info(folder), b'')
            for entry, data in card.files(folder):
                info = zipfile.ZipInfo(f'{folder.name}/{entry.name}',
                                       _zip_time(entry.modified))
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, data)
    return buf.getvalue()


def _dir_info(folder):
    info = zipfile.ZipInfo(f'{folder.name}/', _zip_time(folder.modified))
    info.external_attr = 0o40755 << 16 | 0x10
    return info


def _zip_time(when):
    # Zip timestamps cannot go below 1980; a card entry with no valid date
    # gets the zip epoch rather than failing the export.
    if when is None or when.year < 1980:
        return (1980, 1, 1, 0, 0, 0)
    return when.timetuple()[:6]


# ── restoring a zip into a card ────────────────────────────────────────
# Written by PCSX2's folder cards, not part of any save. A folder card
# regenerates them; an image has nowhere to put them.
_FOLDER_CARD_FILES = ('_pcsx2_superblock', '_pcsx2_meta', '_pcsx2_meta_directory',
                      '_pcsx2_index')


def _zip_folders(zip_bytes, save_id):
    """{folder: [(file, bytes, datetime)]} for this game's folders in a zip.

    Takes both shapes Argosy has uploaded: rooted at the game's folders, and
    rooted at the card with the folders one level down.
    """
    z = zipfile.ZipFile(io.BytesIO(zip_bytes))
    names = [i for i in z.infolist()
             if not i.is_dir() and not i.filename.startswith('__MACOSX/')
             and i.filename.rsplit('/', 1)[-1] not in _FOLDER_CARD_FILES]
    parts = {i.filename: i.filename.strip('/').split('/') for i in names}
    roots = {p[0] for p in parts.values()}
    # Rooted at the game's folders when any top-level folder is the game's;
    # other games' folders beside it are skipped below, not a sign the zip is
    # rooted at a card.
    strip = 0 if any(folder_matches(r, save_id) for r in roots) else 1
    out = {}
    for info in names:
        p = parts[info.filename][strip:]
        if len(p) < 2 or not folder_matches(p[0], save_id):
            continue
        if len(p) > 2:
            raise CardError(f'{info.filename}: PS2 saves have no subfolders')
        when = datetime.datetime(*info.date_time)
        out.setdefault(p[0], []).append((p[1], z.read(info), when))
    return out


def restore_zip(card_path, zip_bytes, save_id):
    """Put a game's save from an Argosy-shaped zip into a card image.

    Replaces the game's folders and leaves every other folder alone. A card
    that does not exist yet, or that no game has formatted, is formatted
    first. The previous card is kept as "<card>.backup". Returns the folder
    names written; raises CardError, leaving the card untouched, when the zip
    holds nothing for the game or the card cannot be read.
    """
    folders = _zip_folders(zip_bytes, save_id)
    if not folders:
        raise CardError(f'the zip holds no save for {save_id}')

    try:
        with open(card_path, 'rb') as f:
            original = f.read()
    except FileNotFoundError:
        original = None
    if not original or original == b'\xff' * len(original):
        card = Card(format_card(ecc=not original or len(original) != PAGES * PAGE))
    else:
        card = Card(original)
    others_before = {f.name: card.files(f) for f in card.folders()
                     if f.name not in folders}

    for name, files in folders.items():
        card.delete_folder(name)
        card.add_folder(name, files, max(w for _, _, w in files))

    # Read the result back through a fresh parser before anything touches disk.
    check = Card(card.image())
    got = {f.name: {e.name: d for e, d in check.files(f)} for f in check.folders()}
    for name, files in folders.items():
        if got.get(name) != {n: d for n, d, _ in files}:
            raise CardError(f'{name} did not read back as written')
    for name, files in others_before.items():
        if {e.name: d for e, d in files} != got.get(name):
            raise CardError(f'{name} changed while restoring another game')

    tmp = f'{card_path}.tmp'
    with open(tmp, 'wb') as f:
        f.write(card.image())
        f.flush()
        os.fsync(f.fileno())
    if original:
        with open(f'{card_path}.backup', 'wb') as f:
            f.write(original)
    os.replace(tmp, card_path)
    return sorted(folders)
