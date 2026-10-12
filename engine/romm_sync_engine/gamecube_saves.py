"""A GameCube game's save, as the unit Argosy syncs: its .gci files.

Dolphin's default memory card (GCI folder mode, libretro core included) keeps
each save file a game writes as its own "<maker>-<game code>-<name>.gci" in
"<user dir>/GC/<region>/Card A/". A game writes one or several. Argosy, the
Android RomM client, syncs all of a game's GCIs as one save
(GciSaveHandler): a single file travels raw, two or more as a flat zip of
their file names, and a restore replaces the game's GCIs in its card folder
with the ones it received. Matching that exactly is what lets the two restore
each other's saves -- the server hashes a zip by its entry names as well as
their bytes, so a zip laid out differently is a different save to it.

The game is identified by the four-character game code each GCI opens with,
the same code Sigil reports as a GameCube disc's save_id. Nothing here touches
a raw memory-card image (.raw): it holds every game at once and is synced as
a file, as before.
"""

import os
import re
import shutil
import time
import zipfile
from pathlib import Path

GCI_SUFFIX = '.gci'

# The GCI header: the directory entry Dolphin keeps per save. The game code at
# 0, the maker code after it, and the save's own name at 8. Those three are a
# save's identity on a card -- the same name from two games is two saves.
_HEADER = 0x40
_GAME_CODE = slice(0, 4)
_MAKER_CODE = slice(4, 6)
_FILE_NAME = slice(8, 40)

# Dolphin's per-region card folders, from the fourth character of the game code
# (the disc's country). Korean discs boot as NTSC-J.
_REGION_DIRS = {'E': 'USA', 'J': 'JAP', 'K': 'JAP'}
_CARD = 'Card A'

_DOLPHIN_NAME_RE = re.compile(r'^[A-Z0-9]{2}-[A-Z0-9]{4}-', re.IGNORECASE)


def _header(path):
    try:
        with open(path, 'rb') as fh:
            head = fh.read(_HEADER)
    except OSError:
        return None
    return head if len(head) == _HEADER else None


def game_code(path):
    """The four-character game code a GCI belongs to, or None."""
    head = _header(path)
    if not head:
        return None
    code = head[_GAME_CODE]
    return code.decode('ascii').upper() if code.isalnum() else None


def _identity(path):
    head = _header(path)
    return (head[_GAME_CODE], head[_MAKER_CODE], head[_FILE_NAME].split(b'\0')[0]) if head else None


def unit_members(path):
    """Every GCI in ``path``'s card folder that belongs to the same game.

    One per save identity and ordered by file name, as Argosy collects them.
    """
    path = Path(path)
    code = game_code(path)
    if not code:
        return [path]
    members, seen = [], set()
    for gci in sorted(path.parent.iterdir(), key=lambda p: p.name):
        if not gci.is_file() or gci.suffix.lower() != GCI_SUFFIX:
            continue
        if game_code(gci) != code:
            continue
        identity = _identity(gci)
        if identity in seen:
            continue
        seen.add(identity)
        members.append(gci)
    return members


def pack(members, destination):
    """The artifact a unit travels as: one GCI raw, several as a flat zip.

    Entries are the bare file names, the way Argosy's SaveArchiver.zipFiles
    writes them, each dated with its file's own time so an unchanged unit
    packs to the same bytes.
    """
    members = list(members)
    if len(members) == 1:
        return members[0]
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as z:
        for gci in members:
            when = time.localtime(max(gci.stat().st_mtime, 315532800))[:6]
            info = zipfile.ZipInfo(gci.name, when)
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, gci.read_bytes())
    return destination


def card_dir(user_dir, code):
    """Where Dolphin keeps this game's GCIs under a user directory."""
    region = _REGION_DIRS.get((code or ' ')[3:4].upper(), 'EUR')
    return Path(user_dir) / 'GC' / region / _CARD


def incoming_members(artifact):
    """[(file name, bytes)] for the GCIs in a server save: a zip, or one GCI.

    Nested paths inside a zip are flattened to their names, as Argosy's
    restore does; anything that is not a GCI is ignored.
    """
    artifact = Path(artifact)
    if zipfile.is_zipfile(artifact):
        out = []
        with zipfile.ZipFile(artifact) as z:
            for info in z.infolist():
                name = info.filename.rsplit('/', 1)[-1]
                if info.is_dir() or not name.lower().endswith(GCI_SUFFIX):
                    continue
                out.append((name, z.read(info)))
        return out
    return [(artifact.name, artifact.read_bytes())]


def is_dolphin_name(file_name):
    """True for a name Dolphin wrote ("01-GALE-…"), timestamp or not.

    Ludo uploaded each GCI on its own before it packed them, under that name;
    such a row is one save file of the game, not the game's whole save.
    """
    return bool(_DOLPHIN_NAME_RE.match(Path(str(file_name)).name))


def restore(artifact, target_dir, code, backup_dir=None, name=None, only_same=False):
    """Replace this game's GCIs in ``target_dir`` with the server's.

    ``only_same`` replaces just the GCIs that are the same save as an incoming
    one (same game, maker and name) and keeps the game's others: what one
    legacy per-GCI row can speak for.

    ``name`` is the single GCI's file name when ``artifact`` was downloaded
    under some other name. Only GCIs of game ``code`` are removed -- every
    other game on the card is left as it was -- and each is moved to
    ``backup_dir`` first when one is given. Members of another game are
    refused rather than written. Returns the written paths.
    """
    target_dir = Path(target_dir)
    incoming = incoming_members(artifact)
    if name and len(incoming) == 1 and not zipfile.is_zipfile(artifact):
        incoming = [(name, incoming[0][1])]
    for member, data in incoming:
        member_code = data[_GAME_CODE].decode('ascii', 'replace').upper()
        if member_code != code:
            raise ValueError(f'{member} belongs to {member_code}, not {code}')
    if not incoming:
        raise ValueError('no GCI files in the save')

    target_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    identities = {(d[_GAME_CODE], d[_MAKER_CODE], d[_FILE_NAME].split(b'\0')[0])
                  for _m, d in incoming}
    for existing in list(target_dir.iterdir()):
        if (existing.is_file() and existing.suffix.lower() == GCI_SUFFIX
                and game_code(existing) == code
                and (not only_same or _identity(existing) in identities)):
            if backup_dir:
                dest = Path(backup_dir) / f'{code}-{stamp}'
                dest.mkdir(parents=True, exist_ok=True)
                shutil.move(str(existing), dest / existing.name)
            else:
                existing.unlink()
    written = []
    for member, data in incoming:
        out = target_dir / member
        tmp = out.with_name(out.name + '.part')
        tmp.write_bytes(data)
        os.replace(tmp, out)
        written.append(out)
    return written


def dolphin_name(data):
    """Dolphin's file name for a GCI, from its header: "<maker>-<code>-<name>.gci".

    A lone GCI is uploaded under the uploader's ROM name, so it is renamed on
    the way back. Dolphin loads every .gci in the folder by its header, so the
    name only has to be unique and recognisable; characters a filesystem
    refuses are made underscores.
    """
    head = bytes(data[:_HEADER])
    text = lambda b: b.split(b'\0')[0].decode('ascii', 'replace')
    name = text(head[_FILE_NAME])
    name = ''.join('_' if c in '/\\:*?"<>|' or ord(c) < 32 else c for c in name)
    return f"{text(head[_MAKER_CODE])}-{text(head[_GAME_CODE])}-{name}{GCI_SUFFIX}"
