"""Installing Switch updates and DLC into Eden's add-on content cache.

An update or DLC add-on is not a ROM. Eden loads a base game from wherever the
file happens to sit, but it applies add-on content only from its own registered
cache under ``nand/user/Contents/registered`` -- a patch NSP left beside the
base ROM has no effect at all. So "support DLC" is not a download feature with
an install step bolted on; the install IS the feature, and the download is the
easy half.

What Eden actually requires is narrower than it looks, and the narrowness is
the whole reason this module can exist without a crypto stack. Read against
Eden's ``src/core/file_sys/registered_cache.cpp``:

  * ``AccumulateFiles`` scans the top level of the directory for names matching
    ``[0-9A-F]{32}\\.nca`` (or ``.cnmt.nca``), and ``GetFileAtID`` resolves an
    ID against five path layouts, flat among them. Eden's own installer writes
    a nested ``/000000XX/<id>.nca`` where XX is the first byte of the SHA-256 of
    the NCA ID -- but nothing requires a writer to reproduce that. Flat is
    discovered identically, and flat is what install_firmware_zip already does
    one directory over.
  * ``GetNCAFromNSPForID`` fetches ``"{nca_id}.nca"`` straight out of the NSP.
    The container's own member names ARE the installed filenames. Installing is
    therefore a copy under an unchanged basename, exactly the rule firmware
    installation follows: the archive names the file, we name the location.

Neither of those needs a key. A PFS0 or HFS0 header is plaintext, the member
names are plaintext, and the NCAs are copied as the opaque blobs they are.
What we cannot do without keys is know WHAT we are copying -- title, kind,
version -- because that lives in the CNMT inside an encrypted NCA. That is
title_ids.switch_content's job, via Sigil. The division is strict and it is the
point: identification needs keys and reads a few kilobytes, installation needs
no keys and moves gigabytes.

Two Eden behaviours are load-bearing and are reproduced here rather than
inherited:

  * A base game must never be installed. ``InstallEntry`` returns
    ErrorBaseInstall for a CNMT whose title is its own base at version 0.
    Base games launch from the file; NAND is for add-on content only.
  * ``InstallEntry`` calls ``RemoveExistingEntry`` before writing. Skipping that
    leaves the previous patch's meta NCA in the directory, and since
    ``ProcessFiles`` does ``insert_or_assign`` per title ID while scanning, two
    versions of one patch resolve to whichever the scan reached last. Which
    update applies would then depend on directory order. The manifest below is
    what lets us delete precisely the files we wrote for that title, and
    nothing Eden or the user installed by other means.
"""

import json
import logging
import shutil
import struct
import time
from pathlib import Path

from . import title_ids
from .emulator_saves import eden_data_dirs, eden_keys_dir
from .paths import cache_dir

log = logging.getLogger(__name__)

# Add-on content, as opposed to system firmware in nand/system. Eden creates
# this on first launch; a fresh install has it empty.
_EDEN_CONTENT_DIR = ('nand', 'user', 'Contents', 'registered')

# PFS0, the NSP container. Header is magic, entry count, string-table size, and
# four reserved bytes; each 0x18-byte entry is (data offset, data size, name
# offset into the string table, reserved). Data offsets are relative to the end
# of the string table, which is where the header stops.
_PFS0_MAGIC = b'PFS0'
_PFS0_HEADER = 0x10
_PFS0_ENTRY = 0x18

# HFS0, the XCI's partition format. Same idea, wider entries: 0x40 bytes
# carrying a hashed region and a SHA-256 alongside the offset and size.
_HFS0_MAGIC = b'HFS0'
_HFS0_HEADER = 0x10
_HFS0_ENTRY = 0x40

# An XCI opens with a 0x100-byte signature, then "HEAD". The root HFS0's
# absolute offset is a u64 at 0x130, and the partition we want inside it is
# "secure" -- the one holding the title's NCAs. ("update" holds bundled
# firmware, "normal" the logo and metadata.)
_XCI_MAGIC = b'HEAD'
_XCI_MAGIC_OFFSET = 0x100
_XCI_HFS0_OFFSET = 0x130
_XCI_CONTENT_PARTITION = 'secure'

# A container with more members than this is not an NSP we should be reading;
# bail rather than allocating from a corrupt or hostile header.
_MAX_ENTRIES = 4096
_MAX_STRING_TABLE = 1 << 20

# Ticket layout for the common (RSA-2048 + SHA-256) signature type every retail
# ticket uses: the 0x100 signature and its padding put the title key block at
# 0x180 and the rights ID at 0x2A0. Both are read only when the rights ID's
# high half matches the title we believe we are installing, which is a cheap
# proof that these offsets landed where intended rather than in the middle of a
# structure we misread.
_TICKET_KEY_OFFSET = 0x180
_TICKET_RIGHTS_ID_OFFSET = 0x2A0
_TICKET_MIN_SIZE = 0x2C0

# Copy in chunks rather than reading a member whole: an update NCA is routinely
# larger than a Steam Deck's free RAM.
_COPY_CHUNK = 4 * 1024 * 1024

_NCA_SUFFIX = '.nca'
_TICKET_SUFFIX = '.tik'


class ContainerError(Exception):
    """The file is not a readable NSP or XCI."""


def eden_content_dir(extra_data_dir=None, create=False):
    """Where Eden expects installed updates and DLC, or None when Eden is absent."""
    for data_dir in eden_data_dirs(extra_data_dir):
        target = data_dir.joinpath(*_EDEN_CONTENT_DIR)
        if target.is_dir():
            return target
        if create:
            try:
                target.mkdir(parents=True, exist_ok=True)
                return target
            except OSError as e:
                log.debug("could not create %s: %s", target, e)
    return None


# ── External content ────────────────────────────────────────────────────────
#
# Eden 0.2.0-rc1 reads updates and DLC out of a plain folder, which is a better
# home for them than NAND is. NAND installation splits one file the user chose
# to keep into a dozen anonymous NCAs under a hashed name; the folder keeps it
# as the container it was downloaded as, so removing an add-on is deleting the
# file that obviously is it, and the library holds one copy rather than two.
#
# The folder is a subdirectory of the platform's ROM directory rather than a
# path of its own. That is what keeps RetroDECK's game list clean: a patch NSP
# left beside the base game is scanned as if it were a game, and a subfolder is
# not -- ROM scanners and Eden's own game dirs both stop at the top level. It
# is also why the folder has to be registered with Eden explicitly, in
# eden_config: the same non-recursion that hides it from RetroDECK hides it
# from Eden.
EXTCONTENT_DIRNAME = 'extcontent'

# What a manifest record's 'mode' says about how the add-on was installed.
MODE_NAND = 'nand'
MODE_EXTCONTENT = 'extcontent'


# Switch containers. A folder ROM on this platform routinely holds the base
# game AND its update and DLC, which is why the generic "several game files
# means several regional variants" rule below is wrong here: they are not
# alternatives to choose between, they are one game plus parts that are not
# bootable at all.
CONTAINER_EXTS = ('.nsp', '.xci', '.nsz', '.xcz')


def base_game(files, prod_keys=None):
    """The bootable base game among a Switch folder ROM's files, or None.

    The file is read before its name is believed, and that order is the whole
    point. A dump tagged with the base title ID can BE the update -- Eden then
    answers "Game updates cannot be loaded directly", an error about a file the
    user never chose and cannot act on. The CNMT inside the container says what
    the container is; the name says what someone typed. Reading costs a few
    kilobytes of header, so there is no reason to prefer the cheaper answer.

    The name is the fallback, not the authority: without prod.keys nothing can
    be decrypted and the tag is all there is.

    Returns a single Path, never a list. There is no choice to offer here --
    exactly one file in a Switch game folder can boot, and asking which
    "version" to launch is asking the user to guess at something the file
    already states.
    """
    scored = []
    for f in files:
        if f.suffix.lower() not in CONTAINER_EXTS:
            continue
        named = (title_ids.switch_content_from_name(f.name) or {}).get('kind')
        read = None
        try:
            read = (title_ids.switch_content(f, prod_keys=prod_keys) or {}).get('kind')
        except Exception:
            read = None
        kind = read or named
        if kind in ('update', 'dlc'):
            continue
        # A confirmed base outranks a file nothing could identify, and among
        # equals the larger file wins -- in a folder where identification
        # failed entirely, the base game is the big one.
        try:
            size = f.stat().st_size
        except OSError:
            size = 0
        scored.append((1 if kind == 'base' else 0, size, f))
    if not scored:
        return None
    scored.sort(key=lambda t: (t[0], t[1], str(t[2])), reverse=True)
    return scored[0][2]


def extcontent_dir(rom_dir, create=False):
    """The external-content folder for a platform's ROM directory, or None.

    ``rom_dir`` is where the base games live -- ``.../roms/switch``. Returns
    None only when the folder is wanted and cannot be made.
    """
    if not rom_dir:
        return None
    target = Path(rom_dir).expanduser() / EXTCONTENT_DIRNAME
    if target.is_dir():
        return target
    if create:
        try:
            target.mkdir(parents=True, exist_ok=True)
            return target
        except OSError as e:
            log.debug("could not create %s: %s", target, e)
            return None
    return None


def install_external(path, dest_dir, info=None, prod_keys=None):
    """Place one update or DLC in Eden's external-content folder.

    Statuses mirror ``install``: 'not-switch', 'base', 'current', 'ok'. There
    is no 'compressed' -- a .nsz is exactly as readable to Eden here as a .nsp,
    because nothing in this path opens the container at all. That is the whole
    difference between the two modes: NAND installation has to parse the file
    and copy its members out, and this only has to put the file somewhere.

    A NAND install of the same title is removed when one exists. That is not
    the mode migration the user did not ask for -- it is the same rule
    ``install`` follows for a superseded patch, applied across modes: two
    copies of one title ID, one in NAND and one in a folder, leave which
    version applies up to Eden, and a title we installed is ours to replace.
    """
    path = Path(path)
    if info is None:
        info = title_ids.switch_content(path, prod_keys=prod_keys)
    if not info or not info.get('base_id'):
        return {'status': 'not-switch'}
    kind = info.get('kind')
    if kind not in ('update', 'dlc'):
        return {'status': 'base'}

    target = extcontent_dir(dest_dir, create=True)
    if target is None:
        return {'status': 'no-folder'}

    title_id = info['title_id']
    version = info.get('version')
    record = read_manifest().get(title_id) or {}
    destination = target / path.name
    # Whether this changes anything is decided up front, but the file is placed
    # either way. "Already current" describes the add-on, not the copy in front
    # of us: a duplicate left beside the base game is still a duplicate the
    # game list would show, so it goes into the folder and the status still
    # says nothing changed.
    current = (record.get('mode') == MODE_EXTCONTENT and destination.is_file()
               and version is not None and record.get('version') == version)

    # Before the move, not after: a same-named reinstall would otherwise have
    # the forget delete the copy just written. Same order, and the same
    # reasoning, as install's own delete-then-write.
    _forget(title_id, keep_path=str(destination))

    if path.resolve() != destination.resolve():
        try:
            # Move, not copy: the download landed here on its way to the
            # folder, and leaving the original beside the base ROM would put
            # back exactly the game-list pollution the folder exists to avoid.
            # os.replace would fail across filesystems; shutil.move would not.
            shutil.move(str(path), str(destination))
        except OSError as e:
            log.warning("could not move %s into %s: %s", path.name, target, e)
            return {'status': 'failed', 'error': str(e)}

    manifest = read_manifest()
    manifest[title_id] = {
        'base_id': info['base_id'],
        'kind': kind,
        'version': version,
        'source': info.get('source'),
        'file_name': destination.name,
        'mode': MODE_EXTCONTENT,
        'path': str(destination),
        'ncas': [],
        'installed_at': int(time.time()),
    }
    _write_manifest(manifest)
    return {'status': 'current' if current else 'ok',
            'installed': 0 if current else 1, 'skipped': 1 if current else 0,
            'keys': 0,
            'target': target, 'title_id': title_id,
            'base_id': info['base_id'], 'kind': kind, 'version': version,
            'mode': MODE_EXTCONTENT, 'path': str(destination)}


def _read_at(fh, offset, size):
    fh.seek(offset)
    data = fh.read(size)
    if len(data) != size:
        raise ContainerError(f"short read at {offset:#x}: wanted {size}, got {len(data)}")
    return data


def _read_partition(fh, base, magic, header_size, entry_size):
    """Members of a PFS0/HFS0 partition as [(name, absolute offset, size)].

    The two formats differ only in entry width and in what the extra bytes of
    an HFS0 entry carry, so one reader serves both. Offsets come back absolute
    so a caller never has to remember which base a member was relative to --
    which matters for the XCI, where the partition itself is nested.
    """
    header = _read_at(fh, base, header_size)
    if header[:4] != magic:
        raise ContainerError(f"expected {magic.decode()} at {base:#x}, "
                             f"found {header[:4]!r}")
    count, string_table_size = struct.unpack_from('<II', header, 4)
    if count > _MAX_ENTRIES or string_table_size > _MAX_STRING_TABLE:
        raise ContainerError(f"implausible {magic.decode()} header: "
                             f"{count} entries, {string_table_size} bytes of names")

    table = _read_at(fh, base + header_size, count * entry_size)
    strings = _read_at(fh, base + header_size + count * entry_size, string_table_size)
    data_base = base + header_size + count * entry_size + string_table_size

    members = []
    for index in range(count):
        offset, size, name_offset = struct.unpack_from('<QQI', table, index * entry_size)
        if name_offset >= len(strings):
            raise ContainerError(f"entry {index} names a string past the table")
        raw = strings[name_offset:strings.find(b'\0', name_offset)]
        members.append((raw.decode('utf-8', 'replace'), data_base + offset, size))
    return members


def _xci_secure_partition(fh):
    """Base offset of an XCI's secure partition, where its NCAs live."""
    if _read_at(fh, _XCI_MAGIC_OFFSET, 4) != _XCI_MAGIC:
        raise ContainerError("not an XCI: no HEAD magic at 0x100")
    root_offset = struct.unpack('<Q', _read_at(fh, _XCI_HFS0_OFFSET, 8))[0]
    for name, offset, _size in _read_partition(fh, root_offset, _HFS0_MAGIC,
                                               _HFS0_HEADER, _HFS0_ENTRY):
        if name.lower() == _XCI_CONTENT_PARTITION:
            return offset
    raise ContainerError("XCI has no secure partition")


def container_members(path):
    """[(name, offset, size)] for every member of an NSP or XCI.

    Raises ContainerError for anything else, including .nsz/.xcz -- those are
    the same containers with their NCAs recompressed, and decompressing them
    needs zstd plus the section layout, which means keys. Declining is honest;
    half-installing one would leave Eden with a title it cannot read.
    """
    path = Path(path)
    suffix = path.suffix.lower()
    with open(path, 'rb') as fh:
        if suffix == '.nsp':
            return _read_partition(fh, 0, _PFS0_MAGIC, _PFS0_HEADER, _PFS0_ENTRY)
        if suffix == '.xci':
            secure = _xci_secure_partition(fh)
            return _read_partition(fh, secure, _HFS0_MAGIC, _HFS0_HEADER, _HFS0_ENTRY)
    raise ContainerError(f"not an installable Switch container: {path.name}")


# ── Manifest ────────────────────────────────────────────────────────────────
#
# Kept in our cache, never in Eden's directory. That directory is Eden's, its
# contents are NCAs and nothing else by Eden's own scanning rule, and a stray
# JSON file there is our bookkeeping leaking into another application's tree --
# the same reasoning as _firmware_marker_path.

def _manifest_path():
    return cache_dir() / 'switch_content' / 'installed.json'


def read_manifest():
    """{title_id: record} for every add-on this code installed, or {}."""
    try:
        with open(_manifest_path()) as fh:
            return json.load(fh) or {}
    except (OSError, ValueError):
        return {}


def _write_manifest(manifest):
    path = _manifest_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix('.part')
        with open(tmp, 'w') as fh:
            json.dump(manifest, fh, indent=1, sort_keys=True)
        tmp.replace(path)
    except OSError as e:
        log.debug("could not write add-on manifest: %s", e)


def installed_version(title_id):
    """The packed version of the add-on installed for ``title_id``, or None.

    None covers both "nothing installed" and "installed from a file that never
    stated its version", and the caller must treat them alike: neither can be
    compared against a candidate, so neither can justify skipping an install.
    """
    record = read_manifest().get(str(title_id).upper()) or {}
    return record.get('version')


def _forget(title_id, extra_data_dir=None, keep_path=None):
    """Delete what we installed for ``title_id``. Returns how many files went.

    Only files this manifest recorded are touched. Anything Eden installed
    through its own GUI, or a user dropped in by hand, is invisible here and
    stays untouched -- we did not write it and we do not know what else claims
    it.

    ``keep_path`` spares one file. It exists for the reinstall case in
    install_external, where the new copy can legitimately have the same path
    as the record being forgotten and deleting "the old one" would delete it.
    """
    manifest = read_manifest()
    key = str(title_id).upper()
    record = manifest.get(key)
    if not record:
        return 0

    if record.get('mode') == MODE_EXTCONTENT:
        removed = 0
        recorded = record.get('path')
        if recorded and str(recorded) != str(keep_path or ''):
            candidate = Path(recorded)
            # Only inside an extcontent folder. The manifest is ours, but a
            # path in it is still a path, and this one is about to be deleted.
            if candidate.parent.name == EXTCONTENT_DIRNAME:
                try:
                    if candidate.is_file():
                        candidate.unlink()
                        removed += 1
                except OSError as e:
                    log.debug("could not remove %s: %s", candidate, e)
        manifest.pop(key, None)
        _write_manifest(manifest)
        return removed

    target = eden_content_dir(extra_data_dir)
    removed = 0
    if target is not None:
        for name in record.get('ncas', []):
            # Basename only: the manifest is ours, but a path in it would still
            # be a path we did not re-validate before unlinking.
            candidate = target / Path(name).name
            try:
                if candidate.is_file():
                    candidate.unlink()
                    removed += 1
            except OSError as e:
                log.debug("could not remove %s: %s", candidate, e)
    manifest.pop(key, None)
    _write_manifest(manifest)
    return removed


def uninstall(title_id, extra_data_dir=None):
    """Remove an installed update or DLC. Returns the number of NCAs deleted."""
    return _forget(title_id, extra_data_dir=extra_data_dir)


def _install_ticket(fh, offset, size, title_id, extra_data_dir):
    """Append an NSP's title key to Eden's title.keys. Returns True if written.

    Only titlekey-encrypted content carries a ticket; a "standard crypto" dump
    has none and needs none. When one is present, though, the NCAs are
    unreadable without it, so an install that copies the content and drops the
    ticket produces a title Eden lists and cannot boot -- the same
    complete-looking-but-dead state install_firmware_zip avoids by shipping
    keys with firmware.

    The rights ID is checked against the title before anything is written. It
    opens with the title ID, so a mismatch means these offsets did not land
    where this function believes they did, and the right response is to write
    nothing rather than to append a plausible-looking wrong key.
    """
    if size < _TICKET_MIN_SIZE:
        log.debug("ticket too small to parse (%d bytes)", size)
        return False
    blob = _read_at(fh, offset, _TICKET_MIN_SIZE)
    rights_id = blob[_TICKET_RIGHTS_ID_OFFSET:_TICKET_RIGHTS_ID_OFFSET + 0x10]
    key = blob[_TICKET_KEY_OFFSET:_TICKET_KEY_OFFSET + 0x10]
    if rights_id[:8].hex().upper() != str(title_id).upper():
        log.debug("ticket rights ID %s does not match title %s; ignoring",
                  rights_id[:8].hex(), title_id)
        return False
    if not any(key):
        log.debug("ticket carries an empty title key; ignoring")
        return False

    keys_dir = eden_keys_dir(extra_data_dir, create=True)
    if keys_dir is None:
        return False
    line = f"{rights_id.hex().lower()} = {key.hex().lower()}\n"
    path = keys_dir / 'title.keys'
    try:
        existing = path.read_text() if path.is_file() else ''
    except OSError:
        existing = ''
    if line in existing:
        return False
    try:
        with open(path, 'a') as fh_out:
            if existing and not existing.endswith('\n'):
                fh_out.write('\n')
            fh_out.write(line)
    except OSError as e:
        log.debug("could not append to title.keys: %s", e)
        return False
    return True


def install(path, info=None, extra_data_dir=None, prod_keys=None,
            dry_run=False, progress=None):
    """Install one update or DLC container into Eden's add-on cache.

    Returns a dict of 'status' plus, on success, 'installed'/'skipped'/'target'.
    Statuses that are not 'ok':

      'not-switch'    the file names no Switch title
      'base'          a base game, which belongs on disk and not in NAND
      'compressed'    .nsz/.xcz, which cannot be read without decompression
      'no-emulator'   no Eden install to write into
      'current'       this exact version is already installed
      'unreadable'    the container did not parse

    ``info`` is a title_ids.switch_content result; it is looked up here when
    not supplied. Passing one in matters for a batch, where the caller has
    already paid for the identification and Sigil would otherwise decrypt the
    same header twice.

    Replacing an older patch deletes it first, for the reason in the module
    docstring: two versions of one title in the same flat directory make the
    applied one depend on scan order. The delete happens before the copy, so an
    interrupted install leaves the title absent rather than half-replaced --
    absent is a state the next run fixes, and half-replaced is one it cannot
    detect.
    """
    path = Path(path)
    if info is None:
        info = title_ids.switch_content(path, prod_keys=prod_keys)
    if not info or not info.get('base_id'):
        return {'status': 'not-switch'}
    if info.get('compressed'):
        return {'status': 'compressed'}
    kind = info.get('kind')
    if kind not in ('update', 'dlc'):
        return {'status': 'base'}

    title_id = info['title_id']
    target = eden_content_dir(extra_data_dir, create=not dry_run)
    if target is None:
        return {'status': 'no-emulator'}

    version = info.get('version')
    current = installed_version(title_id)
    # Only a version we can compare justifies skipping. Two Nones are not a
    # match, they are two absences of evidence, and treating them as one would
    # pin a title to whichever unversioned file reached it first.
    if version is not None and current == version:
        return {'status': 'current', 'target': target}

    try:
        members = container_members(path)
    except (ContainerError, OSError) as e:
        log.debug("could not read %s: %s", path, e)
        return {'status': 'unreadable', 'error': str(e)}

    ncas = [m for m in members if m[0].lower().endswith(_NCA_SUFFIX)]
    tickets = [m for m in members if m[0].lower().endswith(_TICKET_SUFFIX)]
    if not ncas:
        return {'status': 'unreadable', 'error': 'container holds no NCAs'}

    if dry_run:
        return {'status': 'ok', 'installed': len(ncas), 'skipped': 0,
                'target': target, 'title_id': title_id, 'kind': kind,
                'version': version, 'dry_run': True}

    _forget(title_id, extra_data_dir=extra_data_dir)

    written = []
    keys_written = 0
    installed = skipped = 0
    try:
        with open(path, 'rb') as fh:
            for index, (name, offset, size) in enumerate(ncas):
                # Basename only, for the same reason install_firmware_zip takes
                # one: the container names the file, we name the location, and
                # a member called "../../keys/prod.keys" then cannot escape.
                destination = target / Path(name).name
                if destination.is_file() and destination.stat().st_size == size:
                    skipped += 1
                    written.append(destination.name)
                    continue
                staging = destination.with_name(destination.name + '.part')
                try:
                    fh.seek(offset)
                    remaining = size
                    with open(staging, 'wb') as sink:
                        while remaining > 0:
                            chunk = fh.read(min(_COPY_CHUNK, remaining))
                            if not chunk:
                                raise ContainerError(
                                    f"{name} ends {remaining} bytes early")
                            sink.write(chunk)
                            remaining -= len(chunk)
                    staging.replace(destination)
                except BaseException:
                    staging.unlink(missing_ok=True)
                    raise
                written.append(destination.name)
                installed += 1
                if progress:
                    progress(index + 1, len(ncas), name)

            for name, offset, size in tickets:
                if _install_ticket(fh, offset, size, title_id, extra_data_dir):
                    keys_written += 1
    except (ContainerError, OSError) as e:
        # Roll back to absent rather than leaving a partial title behind: an
        # incomplete set in a flat directory is indistinguishable from a
        # complete one, and Eden would list a title that cannot boot.
        for name in written:
            try:
                (target / name).unlink(missing_ok=True)
            except OSError:
                pass
        log.warning("add-on install failed for %s: %s", path.name, e)
        return {'status': 'unreadable', 'error': str(e)}

    manifest = read_manifest()
    manifest[title_id] = {
        'base_id': info['base_id'],
        'kind': kind,
        'version': version,
        'source': info.get('source'),
        'file_name': path.name,
        'mode': MODE_NAND,
        'ncas': written,
        'installed_at': int(time.time()),
    }
    _write_manifest(manifest)

    return {'status': 'ok', 'installed': installed, 'skipped': skipped,
            'keys': keys_written, 'target': target, 'title_id': title_id,
            'base_id': info['base_id'], 'kind': kind, 'version': version,
            'mode': MODE_NAND}


def installed_for_base(base_id):
    """{'update': record or None, 'dlc': [records]} installed for a game."""
    base_id = str(base_id).upper()
    out = {'update': None, 'dlc': []}
    for title_id, record in read_manifest().items():
        if record.get('base_id') != base_id:
            continue
        entry = dict(record, title_id=title_id)
        if record.get('kind') == 'update':
            out['update'] = entry
        else:
            out['dlc'].append(entry)
    out['dlc'].sort(key=lambda r: r['title_id'])
    return out
