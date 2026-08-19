"""Game-native title IDs, read from the ROM instead of guessed from its name.

Save attribution in sync_core is filename-based: a save is matched to a ROM by
comparing basenames (see RomMClient.find_rom_id_for_save_file). That holds for
everything RetroArch names after its content — .srm, .state, and friends — and
it is why the retro half of the library needs nothing from this module.

It falls apart the moment the *emulator* picks the name. Dolphin writes
"01-GALE01-MeleeSaveData.gci", PPSSPP writes a "ULUS10064/" folder, Ryujinx
writes a directory named after a 16-hex-digit application ID. None of those
contain the ROM's filename in any form, so no amount of stem-cleaning will
recover the owner. What they contain is the game's own identity, stamped into
the disc header by the publisher, and the same identity is readable straight
out of the ROM. Matching happens on that instead.

Two backends, one interface:

  * argosy-sigil (https://github.com/rommforge/argosy-sigil), the RomM-org C
    library, when it is present. It covers eleven platforms including the ones
    whose containers are too involved to justify reimplementing here (Switch
    NSP/XCI, PS3, Vita, Xbox 360) and is the reason this module is shaped as a
    lookup rather than a parser.
  * A dependency-free Python reader for the formats whose IDs sit in plain
    sight: GameCube/Wii (six bytes at offset zero) and the ISO 9660 discs
    (PS1/PS2 via SYSTEM.CNF, PSP via UMD_DATA.BIN).

Sigil is preferred when both can answer, so that adopting it upgrades coverage
without changing any result the fallback already got right. Nothing here raises:
an unreadable or unrecognised file is simply not identifiable, and the caller
drops back to filename matching.
"""

import ctypes
import logging
import os
import re
import struct
from pathlib import Path

# Sector size and the layout constants of an ISO 9660 primary volume
# descriptor. The PVD always begins at sector 16; within it the root directory
# record starts at byte 156, and a directory record carries its extent LBA at
# +2 and its data length at +10, each as a little-endian u32 (the format stores
# both endiannesses back to back; we read the LE half).
_SECTOR = 2048
_PVD_SECTOR = 16
_ROOT_RECORD_OFFSET = 156
_RECORD_EXTENT = 2
_RECORD_LENGTH = 10

# A directory tree deeper than this means we are misreading the structure, not
# that the disc is unusual — bail rather than walking a corrupt image forever.
_MAX_DIR_BYTES = 1 << 20

# Magic words that identify a GameCube or Wii image. Both formats put the
# six-byte game ID at offset zero, which is far too generic to trust on its
# own: plenty of files begin with six printable bytes. The magic is what makes
# the read safe on a directory of mixed .iso dumps.
_WII_MAGIC = 0x5D1C9EA3
_WII_MAGIC_OFFSET = 0x18
_GC_MAGIC = 0xC2339F3D
_GC_MAGIC_OFFSET = 0x1C

# "SLUS_202.02" as it appears in SYSTEM.CNF, which is the on-disc spelling of
# the serial everything else writes as "SLUS-20202".
_BOOT_RE = re.compile(rb'BOOT2?\s*=\s*cdrom0?:\\?([A-Z]{4})_?(\d{3})\.(\d{2})', re.IGNORECASE)

# Dolphin's GCI filenames: "<index>-<gamecode+makercode>-<internal name>.gci".
_GCI_NAME_RE = re.compile(r'^\d+-([A-Z0-9]{6})-', re.IGNORECASE)

# A Switch application ID: 16 hex digits opening with "01" and closing with
# "000". Both halves of that shape are load-bearing. The emulator's save tree
# nests the title under one or two ID directories of its own — a device ID of
# "0000000000000000", a user ID — which are 16 hex digits too, so length alone
# cannot say which level names the game. Update and DLC IDs share a title's
# prefix but end "800" and "001+", and neither owns the save.
_SWITCH_TITLE_RE = re.compile(r'^01[0-9A-F]{11}000$', re.IGNORECASE)

# "[0100152000022000]" as scene-named dumps and RomM's own filenames carry it.
# This is the fallback when Sigil is absent: NSP/XCI store the real ID in an
# NCA header encrypted under a key we do not have, so without Sigil the
# filename is the only place the ID is legible.
_SWITCH_TAG_RE = re.compile(r'[\[\(\s]([0-9A-F]{16})[\]\)\s]', re.IGNORECASE)

# Any Switch title: a base game, an update, or a DLC add-on. Narrower tests
# come from _switch_kind below.
_SWITCH_ANY_RE = re.compile(r'^01[0-9A-F]{14}$', re.IGNORECASE)

# How far a derived ID sits from its base. An update is the base with bit 11
# set; a DLC add-on is numbered upward from the base's next multiple of 0x1000.
_UPDATE_BIT = 0x800
_DLC_STRIDE = 0x1000

_ROM_EXTENSIONS = {'.iso', '.gcm', '.gcz', '.img', '.bin', '.nsp', '.xci', '.cso', '.chd'}

log = logging.getLogger(__name__)


# argosy-sigil's C ABI, mirrored from include/sigil.h. The struct layouts are
# part of the contract: struct_version is the first field of each so the
# library can reject a mismatched caller, and sigil_result is a caller-owned
# out-parameter — nothing here allocates, so there is nothing to free.
_SIGIL_RESULT_V2 = 2
_SIGIL_SUPPORT_V1 = 1
_SIGIL_OPTIONS_V1 = 1

_SIGIL_OK = 0
_SIGIL_PLATFORM_AUTO = 0
_SIGIL_PLATFORM_SWITCH = 5
_SIGIL_SOURCE_FILENAME = 1

# Scan the filename for community naming patterns when the binary parse fails.
# On by default in the library; set explicitly because we always pass options.
_SIGIL_FLAG_FILENAME_FALLBACK = 1 << 0


class _SigilResult(ctypes.Structure):
    _fields_ = [
        ('struct_version', ctypes.c_uint32),
        ('title_id', ctypes.c_char * 32),
        ('raw_serial', ctypes.c_char * 32),
        ('save_id', ctypes.c_char * 32),
        ('platform', ctypes.c_int),
        ('source', ctypes.c_int),
        ('usage', ctypes.c_int),
        ('experimental', ctypes.c_int),
        ('switch_content_type', ctypes.c_int),
        ('title_version', ctypes.c_uint32),
    ]


class _SigilSupport(ctypes.Structure):
    _fields_ = [
        ('struct_version', ctypes.c_uint32),
        ('switch_header_key', ctypes.POINTER(ctypes.c_uint8)),
        ('switch_prod_keys_path', ctypes.c_char_p),
        ('switch_prod_keys_text', ctypes.c_char_p),
        ('switch_prod_keys_text_len', ctypes.c_size_t),
    ]


class _SigilOptions(ctypes.Structure):
    _fields_ = [
        ('struct_version', ctypes.c_uint32),
        ('support', ctypes.POINTER(_SigilSupport)),
        ('flags', ctypes.c_uint32),
    ]


class _Sigil:
    """ctypes binding to libsigil, loaded lazily and at most once.

    The library is optional: this resolves to a no-op backend whenever it is
    absent, which is the normal case on a fresh install. Point LUDO_SIGIL_LIB
    at a build to enable it.

    It is not a superset of the Python reader. Sigil sniffs the platform from
    the file extension and declines ".iso" outright as ambiguous — verified
    against 0.1.0-dev, which returns UNKNOWN_PLATFORM for GameCube, Wii, PS2
    and PSP images. The two backends cover different halves: Sigil the
    containers (NSP/XCI, and the platforms needing decryption), Python the
    plain ISOs.
    """

    _instance = None

    def __init__(self):
        self._lib = None
        self._load()

    @classmethod
    def get(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def _load(self):
        candidates = []
        override = os.environ.get('LUDO_SIGIL_LIB')
        if override:
            candidates.append(override)
        candidates += ['libsigil.so', 'libsigil.dylib', 'sigil.dll']
        for name in candidates:
            try:
                lib = ctypes.CDLL(name)
            except OSError:
                continue
            try:
                lib.sigil_extract_from_path.argtypes = [
                    ctypes.c_char_p, ctypes.c_int,
                    ctypes.POINTER(_SigilOptions), ctypes.POINTER(_SigilResult)]
                lib.sigil_extract_from_path.restype = ctypes.c_int
                lib.sigil_version.restype = ctypes.c_char_p
                lib.sigil_strerror.argtypes = [ctypes.c_int]
                lib.sigil_strerror.restype = ctypes.c_char_p
            except AttributeError:
                # A library by that name that is not Sigil. Not worth
                # surfacing — the Python reader still covers its platforms.
                log.debug("%s is not a sigil build; ignoring", name)
                continue
            self._lib = lib
            log.debug("sigil %s loaded from %s",
                      lib.sigil_version().decode('utf-8', 'replace'), name)
            return

    @property
    def available(self):
        return self._lib is not None

    @property
    def version(self):
        if not self._lib:
            return None
        return self._lib.sigil_version().decode('utf-8', 'replace')

    def extract(self, path, prod_keys=None):
        """Return the sigil_result for ``path``, or None.

        ``prod_keys`` unlocks Switch NCA decryption; without it a Switch
        extraction degrades to the filename scanner rather than failing, which
        is why it stays optional.
        """
        if not self._lib:
            return None
        result = _SigilResult(struct_version=_SIGIL_RESULT_V2)
        options = _SigilOptions(struct_version=_SIGIL_OPTIONS_V1,
                                flags=_SIGIL_FLAG_FILENAME_FALLBACK)
        support = None
        if prod_keys:
            support = _SigilSupport(
                struct_version=_SIGIL_SUPPORT_V1,
                switch_prod_keys_path=str(prod_keys).encode('utf-8'))
            options.support = ctypes.pointer(support)
        try:
            code = self._lib.sigil_extract_from_path(
                str(path).encode('utf-8'), _SIGIL_PLATFORM_AUTO,
                ctypes.byref(options), ctypes.byref(result))
        except Exception as e:
            log.debug("sigil raised on %s: %s", path, e)
            return None
        if code != _SIGIL_OK:
            log.debug("sigil declined %s: %s", path,
                      self._lib.sigil_strerror(code).decode('utf-8', 'replace'))
            return None
        return result


def sigil_available():
    """True when the optional sigil library is loadable."""
    return _Sigil.get().available


def sigil_version():
    """The loaded sigil library's version string, or None."""
    return _Sigil.get().version


def _read(path, offset, size):
    with open(path, 'rb') as fh:
        fh.seek(offset)
        return fh.read(size)


def _gamecube_id(path):
    """Six-byte game ID from a GameCube or Wii image, e.g. "GALE01".

    Returns None unless one of the two disc magics is present, so this stays
    safe to call on any .iso.
    """
    try:
        head = _read(path, 0, 0x20)
    except OSError:
        return None
    if len(head) < 0x20:
        return None

    wii = struct.unpack_from('>I', head, _WII_MAGIC_OFFSET)[0]
    gc = struct.unpack_from('>I', head, _GC_MAGIC_OFFSET)[0]
    if wii != _WII_MAGIC and gc != _GC_MAGIC:
        return None

    code = head[:6]
    if not code.isalnum():
        return None
    return code.decode('ascii', 'replace').upper()


def _iso9660_files(path):
    """Map of uppercased root-directory filenames to (offset, length).

    Only the root directory is read. Every identifier this module looks for
    (SYSTEM.CNF, UMD_DATA.BIN) lives there by specification, and stopping at
    the root keeps this bounded on a malformed image.
    """
    try:
        pvd = _read(path, _PVD_SECTOR * _SECTOR, _SECTOR)
    except OSError:
        return {}
    if len(pvd) < _SECTOR or pvd[1:6] != b'CD001':
        return {}

    record = pvd[_ROOT_RECORD_OFFSET:_ROOT_RECORD_OFFSET + 34]
    if len(record) < 34:
        return {}
    extent = struct.unpack_from('<I', record, _RECORD_EXTENT)[0]
    length = struct.unpack_from('<I', record, _RECORD_LENGTH)[0]
    if not length or length > _MAX_DIR_BYTES:
        return {}

    try:
        data = _read(path, extent * _SECTOR, length)
    except OSError:
        return {}

    entries = {}
    pos = 0
    while pos < len(data):
        record_len = data[pos]
        if record_len == 0:
            # Zero padding runs to the end of the sector; the next record, if
            # any, begins at the following sector boundary.
            pos = ((pos // _SECTOR) + 1) * _SECTOR
            continue
        if pos + record_len > len(data):
            break
        record = data[pos:pos + record_len]
        name_len = record[32] if len(record) > 32 else 0
        name = bytes(record[33:33 + name_len])
        if name not in (b'\x00', b'\x01'):  # the "." and ".." entries
            # Strip the ";1" version suffix ISO 9660 appends to every file.
            clean = name.split(b';')[0].decode('ascii', 'replace').upper()
            entries[clean] = (
                struct.unpack_from('<I', record, _RECORD_EXTENT)[0] * _SECTOR,
                struct.unpack_from('<I', record, _RECORD_LENGTH)[0],
            )
        pos += record_len
    return entries


def _playstation_serial(path, entries):
    """PS1/PS2 serial from SYSTEM.CNF, normalised to "SLUS-20202" form."""
    located = entries.get('SYSTEM.CNF')
    if not located:
        return None
    offset, length = located
    try:
        blob = _read(path, offset, min(length, _SECTOR))
    except OSError:
        return None
    match = _BOOT_RE.search(blob)
    if not match:
        return None
    prefix, high, low = match.groups()
    return f"{prefix.decode('ascii').upper()}-{high.decode('ascii')}{low.decode('ascii')}"


def _psp_serial(path, entries):
    """PSP disc ID from UMD_DATA.BIN, whose first field is the serial."""
    located = entries.get('UMD_DATA.BIN')
    if not located:
        return None
    offset, _length = located
    try:
        blob = _read(path, offset, 16)
    except OSError:
        return None
    serial = blob.split(b'|')[0].strip()
    if not re.fullmatch(rb'[A-Z]{4}\d{5}', serial):
        return None
    return serial.decode('ascii')


def is_switch_title_id(value):
    """True when ``value`` names a base Switch application.

    This is the save-directory test: Eden files a game's save under its BASE
    title, never under an update or an add-on, so only "…000" identifies a
    save. Use switch_kind/base_switch_title_id to interpret a ROM's ID, which
    may legitimately be either of the other two.
    """
    return bool(value) and bool(_SWITCH_TITLE_RE.match(str(value)))


def switch_kind(value):
    """'base', 'update', 'dlc', or None for a Switch title ID.

    The three share a numbering scheme: an update is its base with bit 11 set
    ("…800"), and DLC is numbered up from the base's next multiple of 0x1000
    ("…3001" for a base of "…2000"). The distinction matters because a library
    holding only a game's update NSP — a completely normal thing — still has to
    resolve to the base title the save belongs to.
    """
    if not value or not _SWITCH_ANY_RE.match(str(value)):
        return None
    low = int(str(value)[-3:], 16)
    if low == 0:
        return 'base'
    if low == _UPDATE_BIT:
        return 'update'
    return 'dlc'


def base_switch_title_id(value):
    """The base application ID owning ``value``, or None.

    A base ID maps to itself; an update drops bit 11; a DLC ID rounds down to
    its own multiple of 0x1000 and then steps back one, which is the base the
    add-on extends. Returned uppercase and zero-padded to 16.
    """
    kind = switch_kind(value)
    if not kind:
        return None
    number = int(str(value), 16)
    if kind == 'update':
        number &= ~_UPDATE_BIT
    elif kind == 'dlc':
        number = (number & ~(_DLC_STRIDE - 1)) - _DLC_STRIDE
    return f'{number:016X}'


def _switch_title_id(path):
    """Base Switch application ID for a ROM, from its filename, or None.

    Only reached when Sigil is unavailable — see _SWITCH_TAG_RE. Every 16-hex
    candidate in the name is considered because dumps routinely carry a version
    tag beside the title ("[0100…000][v131072]"), and because the ID present may
    be an update's or an add-on's; normalising it to the base is what lets a
    library that holds only the update NSP still own its game's save.
    """
    if path.suffix.lower() not in {'.nsp', '.xci', '.nsz', '.xcz'}:
        return None
    for candidate in _SWITCH_TAG_RE.findall(path.name):
        base = base_switch_title_id(candidate)
        if base:
            return base
    return None


def title_id_from_rom(path, prod_keys=None):
    """The game-native title ID stamped into a ROM, or None.

    Sigil answers first when it is installed, but it is not a superset: it
    declines ".iso" as an ambiguous extension, so the Python reader below still
    runs for GameCube/Wii and the ISO 9660 discs. The two are complementary,
    not layered.

    ``prod_keys`` is passed through for Switch decryption; see _Sigil.extract.
    """
    path = Path(path)
    if not path.is_file():
        return None

    result = _Sigil.get().extract(path, prod_keys=prod_keys)
    if result:
        found = result.title_id.decode('ascii', 'replace').strip()
        if result.platform == _SIGIL_PLATFORM_SWITCH:
            # Sigil reports the ID it found, not the base title: an update NSP
            # yields "…800" and a DLC "…3001", as both title_id and save_id.
            # Verified against 0.1.0-dev. The save belongs to the base title in
            # every case, so normalise here rather than trusting save_id.
            return base_switch_title_id(found)
        if found:
            return found

    gc = _gamecube_id(path)
    if gc:
        return gc

    if path.suffix.lower() in {'.iso', '.img', '.bin'}:
        entries = _iso9660_files(path)
        if entries:
            return _playstation_serial(path, entries) or _psp_serial(path, entries)

    return _switch_title_id(path)


def title_id_from_save(path):
    """The title ID a save file carries, or None if its name says nothing.

    Dolphin's .gci is the case that pays off today: the six-byte game ID sits
    both in the 64-byte directory-entry header the file opens with and in the
    filename Dolphin exports, so it identifies its own owner outright. Raw
    memory-card images (.raw, .ps2, .mcd) hold several games at once and
    therefore identify none — they stay on the existing filename tiers.
    """
    path = Path(path)
    if path.suffix.lower() != '.gci':
        return None

    try:
        header = _read(path, 0, 6)
    except OSError:
        header = b''
    if len(header) == 6 and header.isalnum():
        return header.decode('ascii', 'replace').upper()

    # Truncated or unusual header — Dolphin's export filename carries the same
    # ID, so fall back to it before giving up.
    match = _GCI_NAME_RE.match(path.name)
    if match:
        return match.group(1).upper()
    return None


def index_roms(directories, extensions=None, prod_keys=None):
    """Build {title_id: rom_path} for the ROMs under ``directories``.

    The Python reader reads at most a few kilobytes per file — a GameCube ID is
    six bytes at offset zero, an ISO 9660 lookup touches two sectors — so this
    stays cheap enough to run over a full library. Files that identify nothing
    are skipped.

    ``prod_keys`` is forwarded to Sigil for Switch decryption.
    """
    extensions = extensions or _ROM_EXTENSIONS
    index = {}
    ranks = {}
    for directory in directories:
        directory = Path(directory)
        if not directory.is_dir():
            continue
        for path in directory.rglob('*'):
            if not path.is_file() or path.suffix.lower() not in extensions:
                continue
            try:
                title_id = title_id_from_rom(path, prod_keys=prod_keys)
            except Exception as e:
                log.debug("could not identify %s: %s", path, e)
                continue
            if not title_id:
                continue
            # A game, its update, and its DLC all normalise to one base ID, so
            # several ROMs can claim the same entry. The base game wins: it is
            # the title the save belongs to, and attributing a save to a DLC
            # entry would sync it against the wrong ROM. Ties keep the first.
            rank = 0 if switch_kind(_raw_switch_tag(path)) in (None, 'base') else 1
            if title_id not in index or rank < ranks[title_id]:
                index[title_id] = path
                ranks[title_id] = rank
    return index


def _raw_switch_tag(path):
    """The un-normalised Switch ID in a ROM's filename, for ranking."""
    for candidate in _SWITCH_TAG_RE.findall(Path(path).name):
        if switch_kind(candidate):
            return candidate
    return None
