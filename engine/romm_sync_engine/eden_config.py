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
import re
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


# ---------------------------------------------------------------------------
# Player 1's controller
#
# Eden binds each input to ONE device by GUID:
#
#   player_0_button_a="engine:sdl,port:0,guid:050000005e04...,button:1"
#
# which is exactly right until the pad that GUID names is not the pad in the
# user's hands. On a Deck that is the normal case: the bindings were made with
# whatever controller was paired at the time, and launching in Gaming Mode with
# the built-in controls matches nothing, so the game opens and cannot be played.
#
# The repair is deliberately the smallest one that works -- rewrite the `guid:`
# field and nothing else, so every button, axis, threshold and deadzone the user
# chose survives and only the device it points at changes.
# ---------------------------------------------------------------------------

# Valve's USB vendor ID: the Deck's own controls, as opposed to anything plugged
# in or paired. Used to PREFER an external pad over the built-in one, because a
# Deck with several controllers attached is a docked Deck, and on a docked Deck
# the built-in sticks are the one device nobody is holding.
_VALVE_VENDOR = 0x28de

_PLAYER_ONE_PREFIX = 'player_0_'
_GUID_RE = re.compile(r'guid:([0-9a-fA-F]{32})')


def _sdl_guid(bus, vendor, product, version):
    """The SDL joystick GUID for an evdev device, from its bus/vid/pid/version.

    SDL packs those four 16-bit values little-endian, each followed by a zero
    pair. Newer SDL builds can fill two of those pairs with a CRC of the device
    name and a driver tag; this reproduces the plain form, which is what the
    GUIDs already in Eden's config look like on this platform.
    """
    def le(v):
        return f"{v & 0xff:02x}{(v >> 8) & 0xff:02x}"
    return f"{le(bus)}0000{le(vendor)}0000{le(product)}0000{le(version)}0000"


def connected_gamepads():
    """Every gamepad currently attached, as {'guid', 'name', 'internal'}.

    Read from sysfs rather than through SDL: this runs inside the plugin host,
    where pulling in a joystick library to answer one question at launch time
    would be a large dependency for a small fact. A device counts as a gamepad
    when the kernel gave it a joystick node (js*), which is the same test the
    SDL enumeration effectively makes.

    Ordered by input number, so the first entry is what `port:0` would most
    likely resolve to.
    """
    found = []
    root = Path('/sys/class/input')
    try:
        nodes = sorted(root.glob('input*'),
                       key=lambda p: int(re.sub(r'\D', '', p.name) or 0))
    except OSError:
        return found
    for node in nodes:
        try:
            if not any(node.glob('js*')):
                continue
            ids = node / 'id'
            vals = {}
            for key in ('bustype', 'vendor', 'product', 'version'):
                vals[key] = int((ids / key).read_text().strip(), 16)
            try:
                name = (node / 'name').read_text().strip()
            except OSError:
                name = ''
        except (OSError, ValueError):
            continue
        found.append({
            'guid': _sdl_guid(vals['bustype'], vals['vendor'],
                              vals['product'], vals['version']),
            'name': name,
            'internal': vals['vendor'] == _VALVE_VENDOR,
        })
    return found


def player_one_guid(extra_config_dir=None):
    """The GUID player 1's inputs are currently bound to, or None."""
    path = config_path(extra_config_dir)
    if path is None:
        return None
    try:
        text = path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return None
    for line in text.splitlines():
        key, sep, value = line.partition('=')
        if not sep or not key.strip().startswith(_PLAYER_ONE_PREFIX):
            continue
        m = _GUID_RE.search(value)
        if m:
            return m.group(1).lower()
    return None


def pick_controller(pads):
    """Which attached pad player 1 should be bound to.

    External before internal. Several controllers attached means a docked Deck,
    and on a docked Deck the built-in sticks are the device nobody is holding --
    so the Deck's own controls are the fallback, not the first choice. Within
    each group the lowest-numbered device wins, which is the one `port:0` would
    have picked anyway.
    """
    if not pads:
        return None
    for pad in pads:
        if not pad['internal']:
            return pad
    return pads[0]


def ensure_player_one_controller(extra_config_dir=None):
    """Point player 1's bindings at a controller that is actually connected.

    Returns a status string:

      'ok'          rewritten to {guid}, which is attached now
      'connected'   the bound device is attached; nothing to do
      'no-pads'     no gamepad found, so there is nothing to bind to
      'unbound'     player 1 has no GUID bindings (Eden's own defaults)
      'no-config'   Eden has no qt-config.ini
      'running'     Eden is up and would serialise over this on exit
      'failed'      the write did not land

    The 'connected' case is the common one and is why this is safe to call
    before every launch: once the user's own pad is paired, this reads the file
    and returns without touching it.
    """
    path = config_path(extra_config_dir)
    if path is None:
        return 'no-config'
    current = player_one_guid(extra_config_dir)
    if current is None:
        return 'unbound'
    pads = connected_gamepads()
    if not pads:
        return 'no-pads'
    if any(pad['guid'] == current for pad in pads):
        return 'connected'
    if eden_is_running():
        return 'running'
    target = pick_controller(pads)

    try:
        text = path.read_text(encoding='utf-8', errors='replace')
    except OSError as e:
        log.warning("could not read Eden config %s: %s", path, e)
        return 'failed'

    # Only player 1's lines, and only the guid inside them. Players 2-8 are a
    # deliberate local-multiplayer setup and none of our business, and the rest
    # of each value is the mapping the user chose.
    out = []
    changed = 0
    for line in text.splitlines():
        key, sep, value = line.partition('=')
        if sep and key.strip().startswith(_PLAYER_ONE_PREFIX) and current in value.lower():
            value = _GUID_RE.sub(f"guid:{target['guid']}", value)
            line = f"{key}{sep}{value}"
            changed += 1
        out.append(line)
    if not changed:
        return 'connected'

    backup = path.with_suffix('.ini.ludo-bak')
    try:
        shutil.copy2(path, backup)
    except OSError as e:
        log.debug("could not back up %s: %s", path, e)

    body = '\n'.join(out)
    if text.endswith('\n'):
        body += '\n'
    try:
        staging = path.with_name(path.name + '.part')
        staging.write_text(body, encoding='utf-8')
        staging.replace(path)
    except OSError as e:
        log.warning("could not write Eden config %s: %s", path, e)
        return 'failed'
    log.info("rebound Eden player 1 from %s to %s (%s), %d line(s)",
             current, target['guid'], target['name'] or 'unnamed', changed)
    return 'ok'
