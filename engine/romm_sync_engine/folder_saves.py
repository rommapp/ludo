"""Saves that are FOLDERS: PSP and 3DS, in the units Argosy syncs them as.

Neither console's emulator keeps a game's save as a file. PPSSPP writes
directories under "PSP/SAVEDATA/" named after the game's serial plus a suffix
-- "ULUS10064DATA00" beside "ULUS10064SETTINGS" -- and one game may own
several. Citra and Azahar keep a 3DS game's save in "title/<category>/<low
id>/data/" on their virtual SD card, and often more of it in "extdata/".

Argosy, the Android RomM client, syncs each as one zip, and so does this:

  * PSP: every SAVEDATA folder starting with the serial, each zipped as a
    root of its own ("ULUS10064DATA00/…"). Folders of installed game data
    (a PARAM.SFO carrying no savedata keys) are not saves and stay out.
  * 3DS: the title's "data" folder as root "data/", and its extdata folder
    as root "extdata/". A restore replaces a component only when the archive
    carries it.

The server hashes a zip by its entry names and their bytes, so matching those
roots is what lets the two clients restore each other's saves. Discovery and
packing here are read-only; restore backs up whatever it replaces.
"""

import os
import re
import shutil
import time
import zipfile
from pathlib import Path

# ── zipping folders under root names ────────────────────────────────────────


def pack_roots(roots, destination):
    """Zip ``[(root name, folder)]`` into ``destination``, deterministically.

    Each root gets a directory entry, then its files under "<root>/…" in sorted
    order, dated by their own times -- so an unchanged save packs to the same
    bytes. Returns the path, or None when the folders hold no file at all
    (Argosy refuses an empty archive the same way).
    """
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, folder in roots:
            folder = Path(folder)
            z.writestr(_dir_entry(name, folder), b'')
            for path in sorted(p for p in folder.rglob('*') if p.is_file()):
                rel = path.relative_to(folder).as_posix()
                info = zipfile.ZipInfo(f'{name}/{rel}', _zip_time(path))
                info.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(info, path.read_bytes())
                written += 1
    if not written:
        destination.unlink(missing_ok=True)
        return None
    return destination


def _zip_time(path):
    return time.localtime(max(Path(path).stat().st_mtime, 315532800))[:6]


def _dir_entry(name, folder):
    info = zipfile.ZipInfo(f'{name}/', _zip_time(folder))
    info.external_attr = 0o40755 << 16 | 0x10
    return info


def zip_roots(zip_path):
    """The top-level folder names in a zip."""
    with zipfile.ZipFile(zip_path) as z:
        return {i.filename.split('/', 1)[0] for i in z.infolist() if '/' in i.filename}


def _replace_with_root(z, root, destination, backup_dir):
    """Replace ``destination`` with the zip's ``root``/ subtree."""
    destination = Path(destination)
    if destination.exists():
        if backup_dir:
            dest = Path(backup_dir) / f'{destination.name}-{time.strftime("%Y%m%d-%H%M%S")}'
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(destination), str(dest))
        else:
            shutil.rmtree(destination)
    destination.mkdir(parents=True, exist_ok=True)
    base = destination.resolve()
    for info in z.infolist():
        if info.is_dir() or not info.filename.startswith(root + '/'):
            continue
        rel = info.filename[len(root) + 1:]
        out = (destination / rel).resolve()
        if base not in out.parents:
            raise ValueError(f'{info.filename}: escapes the save folder')
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(out.name + '.part')
        tmp.write_bytes(z.read(info))
        os.replace(tmp, out)


def _newest(folders):
    times = [p.stat().st_mtime for f in folders for p in Path(f).rglob('*') if p.is_file()]
    return max(times) if times else 0.0


def _find_dirs(roots, name, parent_name, max_depth=6):
    """Directories called ``name`` inside one called ``parent_name``, under ``roots``."""
    found, seen = [], set()
    frontier = [(Path(r), 0) for r in roots]
    while frontier:
        current, depth = frontier.pop()
        try:
            key = current.resolve()
            if key in seen or not current.is_dir():
                continue
            seen.add(key)
            if (current.name.lower() == name.lower()
                    and current.parent.name.lower() == parent_name.lower()):
                found.append(current)
                continue
            if depth < max_depth:
                frontier += [(c, depth + 1) for c in current.iterdir() if c.is_dir()]
        except OSError:
            continue
    return sorted(found)


# ── PSP ─────────────────────────────────────────────────────────────────────

PSP_SERIAL_RE = re.compile(r'^[A-Z]{4}\d{5}')
_PSP_SAVEDATA_KEYS = (b'SAVEDATA_PARAMS', b'SAVEDATA_FILE_LIST')
_MAX_SFO = 64 * 1024


def psp_savedata_dirs(roots):
    """PPSSPP's "PSP/SAVEDATA" folders under ``roots``."""
    return _find_dirs(roots, 'SAVEDATA', 'PSP')


def _is_game_data(folder):
    """A folder of installed disc data, not a save -- as Argosy tells them.

    Only a readable PARAM.SFO that carries neither savedata key condemns a
    folder; without one, it stays in the save rather than being dropped on a
    guess.
    """
    sfo = Path(folder) / 'PARAM.SFO'
    try:
        if not sfo.is_file() or sfo.stat().st_size > _MAX_SFO:
            return False
        data = sfo.read_bytes()
    except OSError:
        return False
    return not any(key in data for key in _PSP_SAVEDATA_KEYS)


def psp_folders(savedata, serial):
    """A game's save folders in ``savedata``: every one starting with its serial."""
    serial = serial.upper()
    try:
        return sorted(f for f in Path(savedata).iterdir()
                      if f.is_dir() and f.name.upper().startswith(serial)
                      and not _is_game_data(f))
    except OSError:
        return []


def psp_units(savedata):
    """{serial: [folders]} for every game with a save in ``savedata``."""
    serials = set()
    try:
        for f in Path(savedata).iterdir():
            m = PSP_SERIAL_RE.match(f.name.upper()) if f.is_dir() else None
            if m:
                serials.add(m.group(0))
    except OSError:
        return {}
    units = {s: psp_folders(savedata, s) for s in sorted(serials)}
    return {s: f for s, f in units.items() if f}


def psp_pack(folders, destination):
    return pack_roots([(f.name, f) for f in folders], destination)


def psp_serial_of_zip(zip_path):
    """The one serial every root of a PSP save zip starts with, or None."""
    serials = {m.group(0) for m in (PSP_SERIAL_RE.match(r.upper()) for r in zip_roots(zip_path)) if m}
    return serials.pop() if len(serials) == 1 else None


def psp_restore(zip_path, savedata, serial, backup_dir=None):
    """Replace this game's folders in ``savedata`` with the zip's. Returns them."""
    serial = serial.upper()
    roots = zip_roots(zip_path)
    if not roots or any(not r.upper().startswith(serial) for r in roots):
        raise ValueError(f'not a save of {serial}: {sorted(roots)}')
    savedata = Path(savedata)
    savedata.mkdir(parents=True, exist_ok=True)
    for old in psp_folders(savedata, serial):
        if old.name not in roots:
            _replace_with_root_none(old, backup_dir)
    with zipfile.ZipFile(zip_path) as z:
        for root in sorted(roots):
            _replace_with_root(z, root, savedata / root, backup_dir)
    return psp_folders(savedata, serial)


def _replace_with_root_none(folder, backup_dir):
    """Remove a folder the incoming save no longer has, keeping a backup."""
    if backup_dir:
        dest = Path(backup_dir) / f'{folder.name}-{time.strftime("%Y%m%d-%H%M%S")}'
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(folder), str(dest))
    else:
        shutil.rmtree(folder)


# ── 3DS ─────────────────────────────────────────────────────────────────────

# Citra and Azahar both hardcode the SD card's two id folders to zeros
# (SYSTEM_ID and SDCARD_ID in core/hle/service/fs/archive.h).
N3DS_ID = '0' * 32
_N3DS_BASE_CATEGORY = '00040000'
_N3DS_EXTDATA_HIGH = '00000000'
_HEX8 = re.compile(r'^[0-9a-f]{8}$', re.IGNORECASE)


def n3ds_sd_roots(roots):
    """The emulators' "sdmc/Nintendo 3DS" folders under ``roots``."""
    return _find_dirs(roots, 'Nintendo 3DS', 'sdmc')


def n3ds_extdata_id(low_id):
    """The extdata folder a retail title writes: its low id shifted right by 8."""
    return f'{int(low_id, 16) >> 8:08x}'


def _id1_roots(sd_root):
    try:
        return sorted(id1 for id0 in Path(sd_root).iterdir() if id0.is_dir()
                      for id1 in id0.iterdir() if id1.is_dir())
    except OSError:
        return []


def n3ds_unit(id1, title_id):
    """{'data': folder, 'extdata': folder} for a title under an id1 root.

    Paths whether or not they exist yet. A save in the base category wins
    over an update's or a DLC's tree carrying the same low id.
    """
    flat = str(title_id).replace('/', '').lower()
    category, low = (flat[:8], flat[-8:]) if len(flat) >= 16 else (_N3DS_BASE_CATEGORY, flat[-8:])
    title = Path(id1) / 'title'
    data = title / category / low / 'data'
    if not data.is_dir():
        try:
            found = sorted((c for c in title.iterdir() if (c / low / 'data').is_dir()),
                           key=lambda c: c.name != _N3DS_BASE_CATEGORY)
        except OSError:
            found = []
        if found:
            data = found[0] / low / 'data'
    return {'data': data,
            'extdata': Path(id1) / 'extdata' / _N3DS_EXTDATA_HIGH / n3ds_extdata_id(low)}


def n3ds_units(sd_root):
    """{title id (16 hex, upper): unit} for every title with a save on the card."""
    units = {}
    for id1 in _id1_roots(sd_root):
        title = id1 / 'title'
        try:
            categories = [c for c in title.iterdir() if c.is_dir() and _HEX8.match(c.name)]
        except OSError:
            continue
        for category in categories:
            for low in category.iterdir():
                if low.is_dir() and _HEX8.match(low.name) and (low / 'data').is_dir():
                    tid = f'{_N3DS_BASE_CATEGORY}{low.name}'.upper()
                    units.setdefault(tid, n3ds_unit(id1, tid))
    return units


def n3ds_pack(unit, destination):
    roots = [(name, unit[name]) for name in ('data', 'extdata') if Path(unit[name]).is_dir()]
    return pack_roots(roots, destination) if roots else None


def n3ds_restore(zip_path, unit, backup_dir=None):
    """Replace each component the zip carries; leave the others alone."""
    roots = zip_roots(zip_path) & {'data', 'extdata'}
    if not roots:
        raise ValueError(f'not a 3DS save: {sorted(zip_roots(zip_path))}')
    with zipfile.ZipFile(zip_path) as z:
        for root in sorted(roots):
            _replace_with_root(z, root, unit[root], backup_dir)
    return sorted(roots)


def unit_newest(folders):
    return _newest([f for f in folders if Path(f).is_dir()])
