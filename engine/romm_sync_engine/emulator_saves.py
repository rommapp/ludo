"""Save discovery for standalone emulators that keep their own save trees.

RetroArch is the assumption baked into sync_core's discovery: one save root, a
flat layer of per-core folders, files named after the content and recognised by
extension (RetroArchInterface.get_save_files). Everything in STANDALONE_EMULATORS
sits outside that. The comment there says as much — "no cores, no save dirs, no
config" — which was true while those emulators only had to launch a game.

Eden breaks all three of that assumption's parts at once, and it is worth being
precise about why, because it decides the shape of this module:

  * The save root is Eden's own data directory, not RetroArch's.
  * A save is a DIRECTORY, not a file. Nothing about "one save file per game"
    survives.
  * That directory is named after the game's title ID, not the ROM's filename,
    so discovery hands back an identity the name-matching tiers cannot use —
    see title_ids for the other half.

So this module answers one question, "what saves exist on disk and which game
does each belong to", and leaves every decision about syncing them to the
caller. It writes nothing inside an emulator's directories.
"""

import json
import logging
import os
import shutil
import time
import zipfile
from pathlib import Path

from . import title_ids
from .paths import cache_dir

log = logging.getLogger(__name__)

# Eden's save tree, relative to its data directory. Only the leaf is uncertain:
# savedata_factory resolves account saves under either
# "save/<device id>/<user id>/<title id>" or "save/account/<user id>", and a
# device save drops the user level entirely. Rather than encode a depth that is
# right for one of those and silently wrong for the others, the walk below
# searches for the title-ID-shaped component at any depth within _MAX_DEPTH.
_EDEN_SAVE_ROOT = ('nand', 'user', 'save')

# Installed system firmware. Flat: a live install holds 229 .nca files here and
# no subdirectories at all.
_EDEN_FIRMWARE_DIR = ('nand', 'system', 'Contents', 'registered')

# Key files that ride along in a firmware archive, written into Eden's keys/
# directory rather than the firmware directory. Every Switch firmware
# generation introduces a new master key, and prod.keys is what carries it --
# so firmware and keys are one versioned set, not two independent ones, and
# shipping them apart invites the one skew that cannot boot a game.
_EDEN_KEYS_DIR = ('keys',)
_KEY_FILES = ('prod.keys', 'title.keys')

# Depth to descend below the save root before giving up. The deepest known
# layout puts the title three levels down; the margin covers a future one
# without letting a symlink loop or a user's misplaced backup folder turn
# discovery into a full-disk crawl.
_MAX_DEPTH = 5

# Eden creates nand/user/save lazily, on the first game boot — a fresh install
# has nand/system/save but no user tree at all. That is an ordinary state, not
# a broken install, and it is why every lookup here returns empty rather than
# raising.
EDEN_DATA_DIRS = (
    # Flatpak (dev.eden_emu.eden) redirects XDG_DATA_HOME into its sandbox.
    '~/.var/app/dev.eden_emu.eden/data/eden',
    # Native, AppImage, and anything else honouring XDG_DATA_HOME.
    '~/.local/share/eden',
)


def eden_data_dirs(extra=None):
    """Existing Eden data directories, most specific first.

    Both install kinds are checked because Ludo launches both: a flatpak Eden
    and an AppImage in ~/AppImages are equally supported by
    find_standalone_executable, and a machine can have both.

    ``extra`` is EXCLUSIVE, not merely preferred: naming a directory means
    "this install, not whichever one I happen to have", and falling back to
    autodetection when it does not exist turns a pointer at an absent or
    not-yet-created install into a silent write against the real one. Discovery
    would only misreport; installing firmware would modify an emulator the
    caller never named.
    """
    if extra:
        path = Path(extra).expanduser()
        return [path] if path.is_dir() else []

    candidates = []
    env = os.environ.get('EDEN_DATA_DIR')
    if env:
        candidates.append(env)
    candidates.extend(EDEN_DATA_DIRS)

    found = []
    for candidate in candidates:
        path = Path(candidate).expanduser()
        if path.is_dir() and path not in found:
            found.append(path)
    return found


def find_prod_keys(extra_data_dir=None):
    """Path to Eden's prod.keys, or None.

    Sigil needs it to decrypt an NCA header and read a Switch title ID from the
    binary; without it a Switch extraction falls back to scanning the filename.
    Eden keeps it in its own keys/ directory, which is exactly the file the user
    already had to supply to run any game at all — so when Switch games are
    playable, this is present by construction.

    Read-only: the key file is the user's, and nothing here copies or moves it.
    """
    for data_dir in eden_data_dirs(extra_data_dir):
        candidate = data_dir / 'keys' / 'prod.keys'
        if candidate.is_file():
            return candidate
    return None


def _walk_for_titles(root, depth=0):
    """Yield (title_id, directory) for every title-ID-shaped dir under ``root``.

    Recursion stops at a title: a save directory's own contents are the game's
    files and may well include further subdirectories, none of which are titles.
    """
    if depth > _MAX_DEPTH:
        return
    try:
        entries = sorted(root.iterdir())
    except OSError as e:
        log.debug("could not read %s: %s", root, e)
        return

    for entry in entries:
        try:
            # Symlinks are not followed: Eden does not create any, and one
            # pointed back up the tree would otherwise loop until _MAX_DEPTH.
            if entry.is_symlink() or not entry.is_dir():
                continue
        except OSError:
            continue
        if title_ids.is_switch_title_id(entry.name):
            yield entry.name.upper(), entry
        else:
            yield from _walk_for_titles(entry, depth + 1)


def _newest_mtime(directory):
    """Latest mtime anywhere inside ``directory``, or None when it is empty.

    The directory's own mtime is not enough: writing a file that already exists
    leaves the parent's timestamp untouched, so a save edited in place would
    look unchanged to the sync engine.
    """
    newest = None
    for path in directory.rglob('*'):
        try:
            if not path.is_file():
                continue
            stamp = path.stat().st_mtime
        except OSError:
            continue
        if newest is None or stamp > newest:
            newest = stamp
    return newest


def find_eden_saves(extra_data_dir=None):
    """Every Eden save on disk, as dicts of {title_id, path, modified}.

    Empty save directories are skipped — Eden creates one for a game the moment
    it boots, whether or not the game ever writes anything, and an empty save
    is not worth a sync round trip.
    """
    best = {}
    for data_dir in eden_data_dirs(extra_data_dir):
        root = data_dir.joinpath(*_EDEN_SAVE_ROOT)
        if not root.is_dir():
            log.debug("no Eden save tree at %s (not booted a game yet)", root)
            continue
        for title_id, directory in _walk_for_titles(root):
            modified = _newest_mtime(directory)
            if modified is None:
                # Empty. Eden creates a save directory when a game boots,
                # whether or not it ever writes — nothing to sync.
                continue
            # One game legitimately appears more than once: Eden keeps a save
            # per Switch USER, so a title played under a real profile and
            # touched under the all-zero one has a directory under each, and a
            # machine with two install kinds can double them again. Picking the
            # first would let an untouched placeholder shadow the real save —
            # observed on a live install, where 0100152000022000 existed under
            # both "00000000…00" and a real user ID. The newest wins, which is
            # the same question the sync engine itself is asking.
            previous = best.get(title_id)
            if previous and previous['modified'] >= modified:
                continue
            best[title_id] = {
                'title_id': title_id,
                'path': directory,
                'modified': modified,
            }
    return list(best.values())


def eden_firmware_dir(extra_data_dir=None, create=False):
    """Where Eden expects installed firmware, or None when Eden is absent.

    Verified against a live install (Aug 2026): 229 files, no subdirectories,
    every one an .nca — so "installed firmware" means the NCAs sitting flat in
    this directory, and nothing else.
    """
    for data_dir in eden_data_dirs(extra_data_dir):
        target = data_dir.joinpath(*_EDEN_FIRMWARE_DIR)
        if target.is_dir():
            return target
        if create:
            try:
                target.mkdir(parents=True, exist_ok=True)
                return target
            except OSError as e:
                log.debug("could not create %s: %s", target, e)
    return None


def eden_keys_dir(extra_data_dir=None, create=False):
    """Where Eden looks for prod.keys, or None when Eden is absent."""
    for data_dir in eden_data_dirs(extra_data_dir):
        target = data_dir.joinpath(*_EDEN_KEYS_DIR)
        if target.is_dir():
            return target
        if create:
            try:
                target.mkdir(parents=True, exist_ok=True)
                return target
            except OSError as e:
                log.debug("could not create %s: %s", target, e)
    return None


def firmware_status(extra_data_dir=None):
    """What firmware is installed: {'path', 'count', 'bytes'}, or None."""
    target = eden_firmware_dir(extra_data_dir)
    if target is None:
        return None
    ncas = [p for p in target.iterdir() if p.is_file() and p.suffix.lower() == '.nca']
    return {
        'path': target,
        'count': len(ncas),
        'bytes': sum(p.stat().st_size for p in ncas),
    }


def _firmware_marker_path():
    """Where the record of the last installed firmware set lives.

    In our own cache, never in Eden's registered/ directory: that directory is
    Eden's, install_firmware_zip treats it as NCAs-and-nothing-else, and a
    stray file there is our bookkeeping leaking into another application's
    system tree.
    """
    return cache_dir() / 'firmware' / 'installed.json'


def read_firmware_marker():
    """The last firmware set we installed: {'file_name','md5','nca_count'}, or {}."""
    try:
        with open(_firmware_marker_path()) as fh:
            return json.load(fh) or {}
    except (OSError, ValueError):
        return {}


def write_firmware_marker(file_name, md5, nca_count):
    """Record what was just installed, so the next run can skip the download."""
    path = _firmware_marker_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix('.part')
        with open(tmp, 'w') as fh:
            json.dump({'file_name': file_name, 'md5': (md5 or '').lower(),
                       'nca_count': nca_count}, fh)
        tmp.replace(path)
    except OSError as e:
        log.debug("could not write firmware marker: %s", e)


def firmware_is_current(entry, extra_data_dir=None):
    """True when the server's firmware `entry` is the one already installed.

    Presence is not version. install_firmware_zip is per-file idempotent, so a
    second run of the SAME firmware installs nothing -- but it only learns that
    after downloading ~324 MB and opening the archive. Worse, a genuinely newer
    firmware that happens to share NCA names would look equally "already
    present" file by file.

    So compare the server's md5 for the archive against the one we recorded on
    the last successful install, and confirm the installed NCA count still
    matches what that install produced. The count guard is what catches
    firmware deleted or replaced underneath us: the marker alone would claim
    current for an emulator whose registered/ has since been emptied.
    """
    marker = read_firmware_marker()
    expected = (entry.get('md5_hash') or '').lower()
    if not marker or not expected or marker.get('md5') != expected:
        return False
    # Firmware without keys cannot decrypt anything, so it is not "current" in
    # any sense the caller cares about -- re-installing is what delivers the
    # prod.keys that rides in the same archive. This is also the repair path
    # for anyone who installed firmware before keys were carried at all: the
    # marker still matches, and only this check sends them back for the keys.
    if find_prod_keys(extra_data_dir) is None:
        return False
    status = firmware_status(extra_data_dir)
    if not status or not status['count']:
        return False
    return status['count'] == marker.get('nca_count')


def install_firmware_zip(zip_path, extra_data_dir=None, dry_run=False):
    """Extract a firmware archive into Eden's registered/ directory.

    Returns {'installed', 'skipped', 'target'} — skipped counts NCAs already
    present with the same size, so re-running is cheap and idempotent.

    Two kinds of member are extracted, each written under its BASENAME into a
    destination THIS code picks -- .nca into registered/, prod.keys and
    title.keys into keys/. Everything else is ignored. The rules are
    deliberate:

      * Nothing in the archive chooses where it lands. Taking the basename
        neutralises path traversal ("../../keys/prod.keys") and also flattens
        an archive carrying a directory prefix, which is the difference
        between the zip we tell users to build and one downloaded from
        elsewhere. Routing by basename to a fixed directory is not traversal:
        the archive names the file, we name the location.
      * Keys belong in the same archive as the firmware because they are the
        same versioned set. Each firmware generation adds a master key, and an
        older prod.keys cannot decrypt newer NCAs -- so installing them
        together is what makes "firmware installed" mean "firmware usable".
        Split across two entries, updating one and forgetting the other
        yields a complete-looking install that fails at boot.

    Firmware is replaceable content, not user data — an NCA is identified by
    the hash in its own name, so a same-named file is the same file. Saves are
    the opposite, which is why nothing here is reused for them.
    """
    zip_path = Path(zip_path)
    target = eden_firmware_dir(extra_data_dir, create=True)
    if target is None:
        raise FileNotFoundError("no Eden installation to install firmware into")

    keys_target = None
    installed = skipped = keys_installed = 0
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.infolist():
            if member.is_dir():
                continue
            name = Path(member.filename).name
            lowered = name.lower()
            is_key = lowered in _KEY_FILES
            if not is_key and not lowered.endswith('.nca'):
                log.debug("skipping non-firmware member %s", member.filename)
                continue

            if is_key:
                # Resolved lazily: an archive with no keys must not create an
                # empty keys/ directory as a side effect.
                if keys_target is None:
                    keys_target = eden_keys_dir(extra_data_dir,
                                                create=not dry_run)
                    if keys_target is None:
                        if dry_run:
                            keys_installed += 1
                            continue
                        log.debug("no keys directory available; skipping %s", name)
                        continue
                # Size is not identity for a key file the way an NCA's hashed
                # name is: a newer prod.keys can carry an added master key at
                # the same length. Always rewrite -- it is 11 KB.
                destination = keys_target / lowered
            else:
                destination = target / name
                if (destination.is_file()
                        and destination.stat().st_size == member.file_size):
                    skipped += 1
                    continue
            if dry_run:
                if is_key:
                    keys_installed += 1
                else:
                    installed += 1
                continue

            # Stage then rename: Eden reading registered/ while a half-written
            # NCA sits there would see a corrupt firmware set.
            staging = destination.with_name(destination.name + '.part')
            try:
                with archive.open(member) as source, open(staging, 'wb') as sink:
                    shutil.copyfileobj(source, sink, 1024 * 1024)
                staging.replace(destination)
            except BaseException:
                staging.unlink(missing_ok=True)
                raise
            if is_key:
                keys_installed += 1
            else:
                installed += 1

    return {'installed': installed, 'skipped': skipped, 'target': target,
            'keys': keys_installed, 'keys_target': keys_target}


def eden_is_running():
    """True when an Eden process appears to be running.

    Restoring into a live emulator's save directory races whatever Eden holds
    in memory: it can flush its own copy over the restored one at exit, or read
    a half-swapped directory. Cheap /proc scan rather than a dependency -- a
    false negative only costs us the guard, and a false positive only defers a
    restore the user can retry.
    """
    try:
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit():
                continue
            try:
                comm = (entry / 'comm').read_text().strip().lower()
            except OSError:
                continue
            if comm.startswith('eden'):
                return True
    except OSError as e:
        log.debug("could not scan /proc for Eden: %s", e)
    return False


def unpack_save(zip_path, title_id, extra_data_dir=None, backup_dir=None):
    """Restore a packed save into Eden's tree for `title_id`.

    The mirror of pack_save, but the write direction cannot be a mirror of the
    read direction's assumptions -- this puts a file from elsewhere into
    another application's live data, so:

      * The destination is the save directory find_eden_saves would CHOOSE for
        this title (newest of the per-user copies), not a path derived from the
        archive. Nothing in the zip picks where it lands.
      * Members are written by basename under the save root, so a crafted
        "../../keys/prod.keys" cannot escape -- the same rule
        install_firmware_zip applies, for the same reason. Subdirectories in
        the archive are preserved only when they stay inside the destination.
      * The existing save is copied to `backup_dir` FIRST. A save is user data,
        the one thing here that cannot be re-downloaded, and prefer-newer
        resolution is a heuristic that can be wrong.
      * The new save is staged in a sibling directory and swapped in, so an
        interrupted restore never leaves Eden reading a half-written save.

    Returns {'path', 'files', 'backup'}. Raises FileNotFoundError when Eden or
    the title's save directory is absent, and RuntimeError when Eden is
    running.
    """
    zip_path = Path(zip_path)
    if eden_is_running():
        raise RuntimeError("Eden is running; close it before restoring a save")

    existing = None
    for save in find_eden_saves(extra_data_dir):
        if save['title_id'].lower() == title_id.lower():
            existing = save['path']
            break
    if existing is None:
        # No directory for this title means the game has never booted here.
        # Creating one would mean guessing a user ID, and a save under the
        # wrong profile is invisible to the player -- refuse instead.
        raise FileNotFoundError(
            f"no Eden save directory for {title_id}; boot the game once first")

    backup = None
    if backup_dir is not None:
        backup_dir = Path(backup_dir)
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup = backup_dir / f"{title_id}-{int(time.time())}.zip"
        pack_save(existing, backup)

    staging = existing.with_name(existing.name + '.incoming')
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    written = 0
    try:
        with zipfile.ZipFile(zip_path) as archive:
            for member in archive.infolist():
                if member.is_dir():
                    continue
                # Resolve inside staging and confirm it stayed there.
                destination = (staging / member.filename).resolve()
                if staging.resolve() not in destination.parents:
                    log.warning("refusing archive member outside the save: %s",
                                member.filename)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, open(destination, 'wb') as sink:
                    shutil.copyfileobj(source, sink, 1024 * 1024)
                written += 1

        if not written:
            raise ValueError("archive contained no save files")

        # Swap: move the old aside, put the new in place, then drop the old.
        # Never a window where the save directory does not exist.
        retired = existing.with_name(existing.name + '.previous')
        shutil.rmtree(retired, ignore_errors=True)
        existing.rename(retired)
        try:
            staging.rename(existing)
        except BaseException:
            retired.rename(existing)
            raise
        shutil.rmtree(retired, ignore_errors=True)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    return {'path': existing, 'files': written, 'backup': backup}


def pack_save(directory, destination):
    """Zip a save directory into a single artifact, and return its path.

    A directory cannot be a save state: RomM keys one file per (rom_id, slot).
    Zipping is what makes a Switch save expressible at all, and it is already
    the server's own multi-entry format — RomMClient.compute_content_hash
    hashes a zip as sorted "name:md5(content)" lines, so a packed save hashes
    identically on both sides without any new agreement between them.

    Written deterministically — entries sorted, timestamps and permissions
    fixed, no compression metadata that varies per run — so that repacking an
    unchanged save produces an identical file. Without that, every sync would
    see a new hash and re-upload a save nobody touched.
    """
    directory = Path(directory)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)

    members = sorted(
        (p for p in directory.rglob('*') if p.is_file() and not p.is_symlink()),
        key=lambda p: p.relative_to(directory).as_posix(),
    )

    # Build beside the target and move into place, so an interrupted pack never
    # leaves a truncated zip where a valid one is expected.
    staging = destination.with_name(destination.name + '.part')
    try:
        with zipfile.ZipFile(staging, 'w', zipfile.ZIP_DEFLATED) as archive:
            for member in members:
                name = member.relative_to(directory).as_posix()
                # A fixed DOS epoch timestamp; the mtime that matters is the
                # save file's own, tracked separately in the inventory.
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                archive.writestr(info, member.read_bytes())
        staging.replace(destination)
    except BaseException:
        staging.unlink(missing_ok=True)
        raise
    return destination
