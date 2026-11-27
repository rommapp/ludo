"""Per-game Steam shortcuts (issue #105).

A user can add a single game to Steam as its own non-Steam shortcut with the
game's name and RomM cover. The shortcut launches back through Ludo, not the
emulator, so save sync still runs around the session. How it gets back into Ludo
depends on the shell:

* Desktop: the shortcut's exe is the shell's own launch command (the same spec
  the Ludo tile uses) plus ``--launch=<rom_id>``. It's written to shortcuts.vdf
  here. Steam rewrites that file from memory when it exits, so a shortcut added
  while Steam is running only shows up after a Steam restart (``steam_running``
  in every result lets the UI say so).
* Deck plugin: the plugin creates the shortcut through SteamClient's live API.
  This module only supplies the artwork and keeps a registry of rom_id -> appid,
  because the backend can't remove a live shortcut itself. Removals the backend
  decides on (game deleted, gone from RomM) are queued for the plugin to apply.

Desktop shortcuts are identified by their tags, which survive renames and exe
changes: ``GAME_TAG`` marks them as ours, and ``ludo-rom:<id>`` says which game
each one is.
"""
import json
import logging
import tempfile
import threading
from pathlib import Path

from .paths import library_dir
from .sync_core import (SteamGridImageGenerator, SteamVDFHandler,
                        find_steam_config_dir, is_steam_running)

GAME_TAG = 'ludo-game'
ROM_TAG_PREFIX = 'ludo-rom:'

# What generate_grid_images writes, by Steam grid filename suffix. The keys are
# also the art names handed to the Deck plugin.
ART_SUFFIXES = {
    'portrait': 'p.png',
    'landscape': '.png',
    'hero': '_hero.png',
    'icon': '_icon.png',
}

_registry_lock = threading.Lock()


def _unsigned(appid):
    return appid if appid >= 0 else appid + 0x100000000


def _tags(shortcut):
    tags = shortcut.get('tags', {})
    if isinstance(tags, dict):
        return set(tags.values())
    if isinstance(tags, list):
        return set(tags)
    return set()


def shortcut_rom_id(shortcut):
    """The RomM id a shortcut of ours belongs to, or None if it isn't ours."""
    tags = _tags(shortcut)
    if GAME_TAG not in tags:
        return None
    for t in tags:
        if isinstance(t, str) and t.startswith(ROM_TAG_PREFIX):
            try:
                return int(t[len(ROM_TAG_PREFIX):])
            except ValueError:
                return None
    return None


def find_game_shortcut(shortcuts, rom_id):
    """(index, shortcut) for this game's shortcut, or (None, None)."""
    rom_id = int(rom_id)
    for i, sc in enumerate(shortcuts):
        if shortcut_rom_id(sc) == rom_id:
            return i, sc
    return None, None


def unique_app_name(shortcuts, exe, name, rom_id, platform_name=''):
    """A display name whose appid doesn't collide with another game's shortcut.

    Steam's appid is a hash of exe + name only, so two games with the same title
    (two regions, or the same game on two platforms) would get the same appid
    and share their artwork. Add the platform, then the RomM id, until the name
    is unique among the other shortcuts.
    """
    taken = {sc.get('appid') for sc in shortcuts if shortcut_rom_id(sc) != int(rom_id)}
    candidates = [name]
    if platform_name:
        candidates.append(f"{name} ({platform_name})")
    candidates.append(f"{name} (#{rom_id})")
    for cand in candidates:
        if SteamVDFHandler.calculate_appid(exe, cand) not in taken:
            return cand
    return candidates[-1]


def render_art(cover_path, out_dir, appid):
    """Write the grid images for `appid` into `out_dir` from a cover file.

    Returns {art name: Path} for each file written; empty when there's no cover
    or Pillow failed. Never raises: a shortcut with no art still works.
    """
    if not cover_path or not Path(cover_path).is_file():
        return {}
    try:
        ok, _count, msg = SteamGridImageGenerator.generate_grid_images(
            cover_path, out_dir, appid)
    except Exception as e:
        logging.warning(f"[Steam] art generation failed: {e}")
        return {}
    if not ok:
        logging.warning(f"[Steam] art generation failed: {msg}")
        return {}
    u = _unsigned(appid)
    out = {}
    for name, suffix in ART_SUFFIXES.items():
        p = Path(out_dir) / f"{u}{suffix}"
        if p.is_file():
            out[name] = p
    return out


def render_art_bytes(cover_path):
    """The grid images as {art name: PNG bytes}, for the Deck plugin, which
    uploads them with SetCustomArtworkForApp instead of writing grid files."""
    with tempfile.TemporaryDirectory(prefix='ludo-steam-art-') as tmp:
        files = render_art(cover_path, tmp, 0x80000000)
        return {name: p.read_bytes() for name, p in files.items()}


def _delete_art(config_dir, appid):
    u = _unsigned(appid)
    for suffix in ART_SUFFIXES.values():
        p = Path(config_dir) / 'grid' / f"{u}{suffix}"
        try:
            if p.exists():
                p.unlink()
        except OSError as e:
            logging.debug(f"Could not delete {p.name}: {e}")


# ─── Desktop: shortcuts.vdf ─────────────────────────────────────────────────

def game_shortcut_status(rom_id):
    """{'available', 'installed', 'appid', 'steam_running', 'reason'} for a game."""
    config_dir = find_steam_config_dir()
    if not config_dir:
        return {'available': False, 'installed': False, 'appid': None,
                'steam_running': False, 'reason': 'Steam not found on this system'}
    shortcuts = SteamVDFHandler.read_shortcuts(config_dir / 'shortcuts.vdf')
    _, sc = find_game_shortcut(shortcuts, rom_id)
    return {'available': True, 'installed': sc is not None,
            'appid': sc.get('appid') if sc else None,
            'steam_running': is_steam_running(), 'reason': None}


def add_game_shortcut(rom_id, name, exe, start_dir='', launch_options='',
                      cover_path=None, platform_name=''):
    """Create or update a game's shortcut in shortcuts.vdf, with its artwork.

    `exe`/`start_dir`/`launch_options` are the shell's own launch spec with
    ``--launch=<rom_id>`` already appended by the caller.

    Returns {'success', 'appid', 'created', 'steam_running', 'message'}.
    """
    config_dir = find_steam_config_dir()
    if not config_dir:
        return {'success': False, 'appid': None, 'created': False,
                'steam_running': False, 'message': 'Steam not found on this system'}
    rom_id = int(rom_id)
    shortcuts_path = config_dir / 'shortcuts.vdf'
    shortcuts = SteamVDFHandler.read_shortcuts(shortcuts_path)
    idx, existing = find_game_shortcut(shortcuts, rom_id)

    app_name = unique_app_name(shortcuts, exe, name, rom_id, platform_name)
    appid = SteamVDFHandler.calculate_appid(exe, app_name)

    art = render_art(cover_path, config_dir / 'grid', appid)
    icon = str(art['icon']) if 'icon' in art else ''

    entry = {
        'appid': appid,
        'AppName': app_name,
        'Exe': exe,
        'StartDir': start_dir or '',
        'icon': icon,
        'ShortcutPath': '',
        'LaunchOptions': launch_options or '',
        'IsHidden': 0,
        'AllowDesktopConfig': 1,
        'AllowOverlay': 1,
        'OpenVR': 0,
        'Devkit': 0,
        'DevkitGameID': '',
        'DevkitOverrideAppID': 0,
        'LastPlayTime': (existing or {}).get('LastPlayTime', 0),
        'FlatpakAppID': '',
        'tags': [GAME_TAG, f"{ROM_TAG_PREFIX}{rom_id}"],
    }
    created = existing is None
    if created:
        shortcuts.append(entry)
    else:
        shortcuts[idx] = entry
    try:
        SteamVDFHandler.write_shortcuts(shortcuts_path, shortcuts)
    except Exception as e:
        logging.error(f"add_game_shortcut write failed: {e}", exc_info=True)
        return {'success': False, 'appid': None, 'created': False,
                'steam_running': is_steam_running(),
                'message': f'Could not write shortcuts.vdf: {e}'}

    old = (existing or {}).get('appid')
    if old is not None and old != appid:
        _delete_art(config_dir, old)

    running = is_steam_running()
    return {'success': True, 'appid': appid, 'created': created,
            'steam_running': running,
            'message': ('Restart Steam to see it in your library' if running
                        else 'Added to your Steam library')}


def remove_game_shortcuts(rom_ids):
    """Remove the shortcuts (and art) for these games in one write.

    Returns {'success', 'removed', 'steam_running', 'message'}. Games without a
    shortcut are skipped, so calling this for every deleted game is cheap.
    """
    wanted = {int(r) for r in rom_ids}
    config_dir = find_steam_config_dir()
    if not config_dir or not wanted:
        return {'success': True, 'removed': 0, 'steam_running': False,
                'message': 'Nothing to remove'}
    shortcuts_path = config_dir / 'shortcuts.vdf'
    shortcuts = SteamVDFHandler.read_shortcuts(shortcuts_path)
    keep, gone = [], []
    for sc in shortcuts:
        (gone if shortcut_rom_id(sc) in wanted else keep).append(sc)
    if not gone:
        return {'success': True, 'removed': 0, 'steam_running': is_steam_running(),
                'message': 'Nothing to remove'}
    try:
        SteamVDFHandler.write_shortcuts(shortcuts_path, keep)
    except Exception as e:
        logging.error(f"remove_game_shortcuts write failed: {e}", exc_info=True)
        return {'success': False, 'removed': 0, 'steam_running': is_steam_running(),
                'message': f'Could not write shortcuts.vdf: {e}'}
    for sc in gone:
        if sc.get('appid') is not None:
            _delete_art(config_dir, sc['appid'])
    running = is_steam_running()
    return {'success': True, 'removed': len(gone), 'steam_running': running,
            'message': ('Restart Steam to drop it from your library' if running
                        else 'Removed from your Steam library')}


def desktop_shortcut_rom_ids():
    """RomM ids that have a desktop shortcut."""
    config_dir = find_steam_config_dir()
    if not config_dir:
        return set()
    ids = (shortcut_rom_id(sc) for sc in
           SteamVDFHandler.read_shortcuts(config_dir / 'shortcuts.vdf'))
    return {i for i in ids if i is not None}


# ─── Deck: registry + queued removals ──────────────────────────────────────

def _registry_path():
    return library_dir() / 'steam_game_shortcuts.json'


def _load_registry():
    try:
        data = json.loads(_registry_path().read_text())
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    shortcuts = data.get('shortcuts') if isinstance(data.get('shortcuts'), dict) else {}
    pending = data.get('pending_removal') if isinstance(data.get('pending_removal'), dict) else {}
    return {'shortcuts': shortcuts, 'pending_removal': pending}


def _save_registry(reg):
    path = _registry_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(reg, indent=1, sort_keys=True))
    tmp.replace(path)


def registry_get(rom_id):
    """The live shortcut's appid the plugin recorded for this game, or None."""
    with _registry_lock:
        return _load_registry()['shortcuts'].get(str(int(rom_id)))


def registry_set(rom_id, appid):
    """Record (appid) or forget (None) the plugin's shortcut for a game."""
    key = str(int(rom_id))
    with _registry_lock:
        reg = _load_registry()
        if appid is None:
            reg['shortcuts'].pop(key, None)
        else:
            reg['shortcuts'][key] = int(appid)
        reg['pending_removal'].pop(key, None)
        _save_registry(reg)


def registry_rom_ids():
    with _registry_lock:
        return {int(k) for k in _load_registry()['shortcuts']}


def registry_all():
    """{rom_id: appid} for every shortcut the Deck plugin has reported."""
    with _registry_lock:
        return {int(k): v for k, v in _load_registry()['shortcuts'].items()}


def queue_removals(rom_ids):
    """Move these games' registry entries to the removal queue for the plugin.
    Returns how many were queued."""
    keys = {str(int(r)) for r in rom_ids}
    with _registry_lock:
        reg = _load_registry()
        moved = 0
        for k in keys & set(reg['shortcuts']):
            reg['pending_removal'][k] = reg['shortcuts'].pop(k)
            moved += 1
        if moved:
            _save_registry(reg)
        return moved


def pending_removals():
    """{rom_id: appid} the plugin should RemoveShortcut and then acknowledge
    with registry_set(rom_id, None)."""
    with _registry_lock:
        return {int(k): v for k, v in _load_registry()['pending_removal'].items()}


def forget_games(rom_ids):
    """The single hook for "these games are gone" (deleted from the device, or
    from RomM): remove desktop shortcuts and queue the plugin's for removal."""
    rom_ids = list(rom_ids)
    if not rom_ids:
        return {'removed': 0, 'queued': 0}
    try:
        removed = remove_game_shortcuts(rom_ids).get('removed', 0)
    except Exception as e:
        logging.warning(f"[Steam] removing game shortcuts failed: {e}")
        removed = 0
    try:
        queued = queue_removals(rom_ids)
    except Exception as e:
        logging.warning(f"[Steam] queueing shortcut removals failed: {e}")
        queued = 0
    if removed or queued:
        logging.info(f"[Steam] forgot {removed} desktop / {queued} Deck shortcut(s) "
                     f"for {len(rom_ids)} game(s)")
    return {'removed': removed, 'queued': queued}
