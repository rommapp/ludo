"""Reading and registering Eden's external-content directories.

Eden 0.2.0-rc1 can apply updates and DLC straight from a folder, without
installing anything into NAND. That is a better fit for a library Ludo already
manages than the NAND install is: the container stays one file the user can see
and delete, RetroDECK still sees the ROMs it expects, and nothing is stored
twice. But the folder only counts if Eden knows about it, and Eden learns that
from its own config file:

  * ``[Data%20Storage] ext_content_from_game_dirs`` (default true) makes every
    registered GAME directory an external-content source as well. That already
    covers an add-on sitting beside its base ROM -- but game dirs carry
    ``deep_scan=false``, so it does NOT cover a subfolder, which is exactly
    where we want add-ons so they stay out of RetroDECK's game list.
  * ``[UI] Paths\\external_content_dirs`` is the explicit list, written in Qt's
    array form: a ``\\size`` count and ``\\<n>\\path`` entries numbered from 1.

So registering the folder is what makes the folder work, and this module does
only that. It edits the file by line rather than through configparser, because
qt-config.ini is a QSettings file: percent-escaped section names, backslashes
inside keys, quoted values, and a ``key\\default=`` shadow for almost every
entry. Round-tripping that through a generic INI parser rewrites far more of
Eden's file than we have any business touching, and this way an unrecognised
layout leaves the file exactly as it was.
"""

import logging
import shutil
from pathlib import Path

from .emulator_saves import eden_is_running

log = logging.getLogger(__name__)

# Same two install kinds emulator_saves.EDEN_DATA_DIRS covers, on the config
# side of XDG rather than the data side.
EDEN_CONFIG_DIRS = (
    '~/.var/app/dev.eden_emu.eden/config/eden',
    '~/.config/eden',
)

_SECTION = '[UI]'
_ARRAY = 'Paths\\external_content_dirs'


def config_path(extra_config_dir=None):
    """Eden's qt-config.ini, or None when no Eden config exists.

    ``extra_config_dir`` is exclusive for the same reason eden_data_dirs' is:
    naming an install means that install, and silently falling back would write
    into an emulator the caller never named.
    """
    if extra_config_dir:
        candidate = Path(extra_config_dir).expanduser() / 'qt-config.ini'
        return candidate if candidate.is_file() else None
    for directory in EDEN_CONFIG_DIRS:
        candidate = Path(directory).expanduser() / 'qt-config.ini'
        if candidate.is_file():
            return candidate
    return None


def _section_bounds(lines):
    """(start, end) line indices of the [UI] section body, or None."""
    start = None
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped == _SECTION:
            start = index + 1
            continue
        if start is not None and stripped.startswith('[') and stripped.endswith(']'):
            return start, index
    if start is not None:
        return start, len(lines)
    return None


def external_content_dirs(extra_config_dir=None):
    """The paths Eden currently reads external content from, in its order."""
    path = config_path(extra_config_dir)
    if path is None:
        return []
    try:
        lines = path.read_text(encoding='utf-8', errors='replace').splitlines()
    except OSError as e:
        log.debug("could not read %s: %s", path, e)
        return []
    bounds = _section_bounds(lines)
    if bounds is None:
        return []
    prefix = _ARRAY + '\\'
    found = {}
    for line in lines[bounds[0]:bounds[1]]:
        key, _, value = line.partition('=')
        key = key.strip()
        if not key.startswith(prefix) or not key.endswith('\\path'):
            continue
        index = key[len(prefix):-len('\\path')]
        if index.isdigit():
            # Qt quotes a value containing a comma; nothing else here needs it.
            found[int(index)] = value.strip().strip('"')
    return [found[k] for k in sorted(found) if found[k]]


def is_registered(directory, extra_config_dir=None):
    """True when ``directory`` is already an external-content dir."""
    try:
        target = Path(directory).expanduser().resolve()
    except OSError:
        return False
    for existing in external_content_dirs(extra_config_dir):
        try:
            if Path(existing).expanduser().resolve() == target:
                return True
        except OSError:
            continue
    return False


def register_external_content_dir(directory, extra_config_dir=None):
    """Add ``directory`` to Eden's external-content list.

    Returns a status string:

      'ok'          appended, and Eden will read the folder next launch
      'already'     it was registered before we got here
      'no-config'   Eden has no qt-config.ini, so it has never been run
      'running'     Eden is up, and would overwrite this on exit
      'unreadable'  the file has no [UI] section to extend
      'failed'      the write itself did not land

    The 'running' guard is the load-bearing one. Eden holds its settings in
    memory and serialises the whole file when it quits, so a config edited
    underneath a live Eden is not merely racy -- it is reliably lost, and lost
    silently, leaving a folder the UI says is registered and Eden has never
    heard of.
    """
    path = config_path(extra_config_dir)
    if path is None:
        return 'no-config'
    if is_registered(directory, extra_config_dir):
        return 'already'
    if eden_is_running():
        return 'running'

    try:
        text = path.read_text(encoding='utf-8', errors='replace')
    except OSError as e:
        log.warning("could not read Eden config %s: %s", path, e)
        return 'failed'
    lines = text.splitlines()
    bounds = _section_bounds(lines)
    if bounds is None:
        return 'unreadable'
    start, end = bounds

    existing = external_content_dirs(extra_config_dir)
    index = len(existing) + 1
    value = str(Path(directory).expanduser())

    size_key = _ARRAY + '\\size'
    size_line = f"{size_key}={index}"
    entry_line = f"{_ARRAY}\\{index}\\path={value}"

    # Replace the count in place when Eden has written one, so the entries stay
    # contiguous with it; otherwise open the array at the top of the section.
    replaced = False
    for i in range(start, end):
        if lines[i].partition('=')[0].strip() == size_key:
            lines[i] = size_line
            lines.insert(i + 1, entry_line)
            replaced = True
            break
    if not replaced:
        lines.insert(start, entry_line)
        lines.insert(start, size_line)

    # Eden's file, so it gets a backup before we touch it -- a config that
    # loses a controller mapping to a bug in here is a worse outcome than an
    # unregistered folder.
    backup = path.with_suffix('.ini.ludo-bak')
    try:
        shutil.copy2(path, backup)
    except OSError as e:
        log.debug("could not back up %s: %s", path, e)

    body = '\n'.join(lines)
    if text.endswith('\n'):
        body += '\n'
    try:
        staging = path.with_name(path.name + '.part')
        staging.write_text(body, encoding='utf-8')
        staging.replace(path)
    except OSError as e:
        log.warning("could not write Eden config %s: %s", path, e)
        return 'failed'
    log.info("registered external content dir with Eden: %s", value)
    return 'ok'
