"""Profiles: several people sharing one machine, each with their own RomM
account, saves and history.

A profile is a state directory (paths.profile_dir). The default profile is the
app's own directory, so an install with one profile is exactly what it was
before profiles existed. The list of profiles, which Steam account opens
which profile, and the last profile used live in ``profiles.json`` in the
machine directory, shared by all of them.

Which profile a launch uses (resolve):

1. a one-shot choice made by switching inside the app (``next``),
2. an explicit ``--profile`` / ``LUDO_PROFILE``,
3. the profile linked to the Steam account that launched the app,
4. the last profile used.

A Steam account with no profile yet, on a machine with more than one, opens
the last profile used and asks who is playing; the answer links the account.
"""

import json
import logging
import os
import re
import secrets
import shutil
import tempfile
import time
from pathlib import Path

from . import paths
from .settings_file import read_settings

DEFAULT = paths.DEFAULT_PROFILE
# How the running app chose its profile ({'id', 'steam', 'ask'}), set by a
# shell that supports profiles before it loads the backend. None means the
# shell doesn't (the Deck plugin): one profile, the default.
launch = None
_ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,31}$')
# SteamID64 of account id 0; account id = SteamID64 - this.
_STEAMID64_BASE = 76561197960265728

# Settings sections that describe the machine rather than the person, copied
# into a new profile so it starts with the same game folder and emulators.
_MACHINE_SECTIONS = ('BIOS', 'Emulators', 'System')
_MACHINE_KEYS = {'Download': ('rom_directory',)}


def _file():
    return paths.machine_dir() / 'profiles.json'


def load():
    try:
        data = json.loads(_file().read_text(encoding='utf-8'))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    profiles = [p for p in data.get('profiles', []) if isinstance(p, dict) and valid_id(p.get('id'))]
    if not any(p['id'] == DEFAULT for p in profiles):
        profiles.insert(0, {'id': DEFAULT, 'name': ''})
    data['profiles'] = profiles
    data.setdefault('steam', {})
    return data


def save(data):
    target = _file()
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix='.profiles-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def valid_id(profile_id):
    return isinstance(profile_id, str) and bool(_ID_RE.match(profile_id))


def get(data, profile_id):
    return next((p for p in data['profiles'] if p['id'] == profile_id), None)


def save_dirs(profile_id):
    """Emulator save and state folders for a profile other than the default.

    The default profile keeps whatever the emulator is set up with. Every
    other profile gets its own pair, which Ludo hands to the emulator at
    launch so two people's saves never meet.
    """
    if profile_id == DEFAULT:
        return None
    root = paths.library_dir() / 'profiles' / profile_id
    return {'saves': root / 'saves', 'states': root / 'states'}


# ── Steam ──────────────────────────────────────────────────────────────────

def _steam_roots():
    home = Path.home()
    return [home / '.steam' / 'steam', home / '.local' / 'share' / 'Steam',
            home / '.var' / 'app' / 'com.valvesoftware.Steam' / 'data' / 'Steam',
            home / '.var' / 'app' / 'com.valvesoftware.Steam' / '.local' / 'share' / 'Steam']


def parse_vdf(text):
    """Parse Steam's text KeyValues format into nested dicts."""
    tokens = re.findall(r'"((?:[^"\\]|\\.)*)"|([{}])', text)
    stack, key = [{}], None
    for quoted, brace in tokens:
        if brace == '{':
            child = {}
            if key is not None:
                stack[-1][key] = child
            stack.append(child)
            key = None
        elif brace == '}':
            if len(stack) > 1:
                stack.pop()
            key = None
        elif key is None:
            key = quoted
        else:
            stack[-1][key] = quoted.replace('\\"', '"').replace('\\\\', '\\')
            key = None
    return stack[0]


def steam_accounts():
    """Steam accounts known on this machine: account id → names and recency."""
    out = {}
    for root in _steam_roots():
        try:
            users = parse_vdf((root / 'config' / 'loginusers.vdf').read_text(
                encoding='utf-8', errors='replace')).get('users', {})
        except OSError:
            continue
        for sid, info in users.items():
            if not (sid.isdigit() and isinstance(info, dict)):
                continue
            account = str(int(sid) - _STEAMID64_BASE)
            out.setdefault(account, {
                'account_name': info.get('AccountName', ''),
                'persona': info.get('PersonaName', ''),
                'most_recent': info.get('MostRecent') == '1',
                'timestamp': int(info.get('Timestamp', '0') or 0),
            })
    return out


def current_steam_account(env=None):
    """The Steam account id (userdata folder name) that launched this app, or None.

    Steam puts the login name of the signed-in account in ``SteamAppUser``
    for everything it starts, non-Steam shortcuts included. Outside Steam
    there is no such variable, and guessing from recency would hand one
    person's profile to another, so this returns None.
    """
    env = os.environ if env is None else env
    if env.get('SteamClientLaunch') != '1' and not env.get('SteamAppUser'):
        return None
    accounts = steam_accounts()
    name = (env.get('SteamAppUser') or env.get('SteamUser') or '').strip().lower()
    if name:
        for account, info in accounts.items():
            if info['account_name'].lower() == name:
                return account
        return None
    # Launched by Steam but without the name: the account Steam marks as the
    # one signed in last is the one running it.
    recent = [a for a, i in accounts.items() if i['most_recent']]
    if len(recent) == 1:
        return recent[0]
    # Current clients don't always write MostRecent; with one account on the
    # machine there is nobody else it could be.
    if len(accounts) == 1:
        return next(iter(accounts))
    return None


def steam_config_dir():
    """The Steam account this profile's tiles belong in: the one that launched
    the app, else one linked to this profile. Returns its userdata config dir,
    or None to fall back to the usual guess (no profiles, or no Steam link).
    """
    if launch is None:
        return None
    candidates = [launch.get('steam')]
    try:
        current = paths.profile_id()
        candidates += [a for a, owner in load()['steam'].items() if owner == current]
    except Exception:
        pass
    for account in candidates:
        if not account:
            continue
        for root in _steam_roots():
            config = root / 'userdata' / str(account) / 'config'
            if config.is_dir():
                return config
    return None


# ── Eden (Switch) users ────────────────────────────────────────────────────
#
# Eden keeps saves per Switch user, so each profile plays as its own Eden
# user: the first profile keeps the user Eden already had selected, every
# other profile gets one Ludo adds (named after the profile). Launches pass
# that user with -u, and sync only looks at that user's save folder.

def profiles_in_use():
    """True when this shell has profiles and the machine has more than one."""
    if launch is None:
        return False
    return len(load()['profiles']) > 1


def _eden_dirs():
    from . import eden_users, emulator_saves
    return [d for d in emulator_saves.eden_data_dirs()
            if eden_users.users(d) is not None]


def _first_eden_user_list(data_dir=None):
    """Create Eden's user list where Eden has never run, as Eden itself
    would on its first start (eden_users.create_default). [data dir] on
    success, else []. Needs an installed, closed Eden."""
    from . import eden_users, emulator_saves
    if emulator_saves.eden_is_running():
        return []
    target = Path(data_dir) if data_dir else emulator_saves.eden_install_data_dir()
    if target is None:
        return []
    try:
        eden_users.create_default(target)
    except OSError as e:
        logging.warning(f"Could not create Eden's user list in {target}: {e}")
        return []
    return [target] if eden_users.users(target) is not None else []


def eden_user(create=False, data_dir=None):
    """The Eden user the current profile plays as.

    None when profiles are not in use: callers behave exactly as before.
    Otherwise {'uuid', 'save_dir'} for the user, or {'error': reason} when
    none can be settled yet (Eden never started, all eight users taken, or
    Eden running when one would have to be added). With an error, Switch
    saves are left alone rather than guessed.
    """
    if not profiles_in_use():
        return None
    from . import eden_config, eden_users, emulator_saves
    dirs = _eden_dirs()
    if not dirs and create:
        dirs = _first_eden_user_list(data_dir)
    if not dirs:
        return {'error': 'Start Eden once so it creates its user list'}
    current = paths.profile_id()
    data = load()
    entry = get(data, current)
    if entry is None:
        return {'error': 'Unknown profile'}
    uuid = entry.get('eden_user')
    if not uuid and current == DEFAULT:
        # The first profile keeps whoever Eden had selected: their saves are
        # already under that user.
        listed = eden_users.users(dirs[0]) or []
        try:
            index = int(eden_config._setting('[System]', 'current_user') or 0)
        except ValueError:
            index = 0
        chosen = listed[index] if 0 <= index < len(listed) else (listed[0] if listed else None)
        if chosen is None:
            return {'error': 'Eden has no users'}
        uuid = chosen['uuid']
        entry['eden_user'] = uuid
        save(data)
    missing = [d for d in dirs if eden_users.find(d, uuid) is None] if uuid else dirs
    if missing:
        if not create:
            return {'error': 'This profile has no Eden user yet'}
        if emulator_saves.eden_is_running():
            return {'error': 'Close Eden so Ludo can add this profile as an Eden user'}
        name = entry.get('name') or entry.get('username') or 'Player'
        try:
            for d in missing:
                uuid = eden_users.add(d, name, uuid)
        except eden_users.EdenUsersError as e:
            return {'error': str(e)}
        entry['eden_user'] = uuid
        save(data)
    return {'uuid': uuid, 'save_dir': eden_users.save_dir_name(uuid)}


def eden_launch_index(data_dir):
    """Eden's -u value for the current profile in the install at ``data_dir``,
    or None to launch as before."""
    user = eden_user(create=True, data_dir=data_dir)
    if not user or 'uuid' not in user:
        return None
    from . import eden_users
    found = eden_users.find(data_dir, user['uuid'])
    return found['index'] if found else None


# ── Cemu (Wii U) accounts ──────────────────────────────────────────────────
#
# Cemu keeps saves per Wii U account, so profiles work as with Eden: the
# first profile keeps the account Cemu has active, every other profile gets
# one Ludo adds. The id is stored in profiles.json and the same id is used in
# every Cemu install; launches pass it with -a.

def cemu_account(inst, create=False):
    """The Cemu account id (int) the current profile plays as in ``inst``.

    None when profiles are not in use: Cemu's active account is used, as
    before. {'error': reason} when it can't be settled yet (twelve accounts
    taken, or Cemu running when one would have to be added); Wii U saves
    are then left alone.
    """
    if not profiles_in_use():
        return None
    from . import cemu_saves, emulator_saves
    current = paths.profile_id()
    data = load()
    entry = get(data, current)
    if entry is None:
        return {'error': 'Unknown profile'}
    try:
        pid = int(entry.get('cemu_account') or '', 16)
    except ValueError:
        pid = None
    listed = cemu_saves.accounts(inst.mlc)
    if pid is None and current == DEFAULT and listed:
        # The first profile keeps whoever Cemu plays as: their saves are
        # already under that account.
        pid = cemu_saves.active_account(inst)
        entry['cemu_account'] = f'{pid:08x}'
        save(data)
    if pid is not None and pid in listed:
        return pid
    if not create:
        return {'error': 'This profile has no Cemu account yet'}
    if emulator_saves.cemu_is_running():
        return {'error': 'Close Cemu so Ludo can add this profile as a Cemu account'}
    try:
        if current == DEFAULT and pid is None:
            # Cemu never ran: make the account it would make itself.
            cemu_saves.ensure_default_account(inst.mlc)
            pid = cemu_saves.MIN_ACCOUNT
        else:
            name = entry.get('name') or entry.get('username') or 'Player'
            pid = cemu_saves.add_account(inst.mlc, name, pid)
    except (OSError, cemu_saves.CemuAccountsError) as e:
        return {'error': str(e)}
    entry['cemu_account'] = f'{pid:08x}'
    save(data)
    return pid


def cemu_launch_args(executable):
    """['-a', '<hex id>'] so Cemu plays as the current profile's account, or
    [] to launch as before."""
    from . import cemu_saves
    pid = cemu_account(cemu_saves.install_for(executable), create=True)
    return ['-a', f'{pid:08x}'] if isinstance(pid, int) else []


# ── Choosing and changing profiles ─────────────────────────────────────────

def resolve(requested=None, env=None):
    """Pick the profile for this launch. Returns a dict:

    ``id`` the profile to open, ``steam`` the Steam account that launched the
    app (or None), ``ask`` True when that account has no profile yet and there
    is more than one to choose from.
    """
    data = load()
    steam = current_steam_account(env)
    ids = {p['id'] for p in data['profiles']}
    choice, ask = None, False
    _drop_discarded(data, ids)
    pending = data.pop('next', None)
    if pending in ids:
        choice = pending
        save(data)
    elif requested:
        wanted = next((p['id'] for p in data['profiles']
                       if requested in (p['id'], p.get('name'))), None)
        choice = wanted
    if choice is None and steam and data['steam'].get(steam) in ids:
        choice = data['steam'][steam]
    if choice is None:
        last = data.get('last')
        choice = last if last in ids else DEFAULT
        ask = bool(steam) and len(ids) > 1 and not requested
    if steam and len(ids) == 1 and steam not in data['steam']:
        # Nothing to choose between: link the only profile now, so adding a
        # second one later doesn't greet this account with the picker.
        data = load()
        data['steam'][steam] = choice
        save(data)
    return {'id': choice, 'steam': steam, 'ask': ask}


def mark_used(profile_id):
    data = load()
    data['last'] = profile_id
    save(data)


def choose(profile_id, steam=None):
    """Remember a choice: the next launch opens it, and so does this Steam account."""
    data = load()
    if not get(data, profile_id):
        raise ValueError('No such profile')
    data['next'] = profile_id
    data['last'] = profile_id
    if steam:
        data['steam'][str(steam)] = profile_id
    save(data)


def link_steam(profile_id, account):
    """Link a Steam account to a profile, moving it off any other profile."""
    data = load()
    if not get(data, profile_id):
        raise ValueError('No such profile')
    account = str(account or '').strip()
    if not account.isdigit():
        raise ValueError('No such Steam account')
    data['steam'][account] = profile_id
    save(data)


def unlink_steam(profile_id):
    data = load()
    data['steam'] = {k: v for k, v in data['steam'].items() if v != profile_id}
    save(data)


def rename(profile_id, name):
    name = ' '.join((name or '').split())[:40]
    data = load()
    entry = get(data, profile_id)
    if not entry:
        raise ValueError('No such profile')
    entry['name'] = name
    save(data)


def set_identity(profile_id, username, role=''):
    """Cache who a profile is signed in as, for the picker to show offline."""
    data = load()
    entry = get(data, profile_id)
    if not entry:
        return
    if entry.get('username') == username and entry.get('role') == role:
        return
    entry['username'], entry['role'] = username or '', role or ''
    save(data)


def _new_id(data):
    taken = {p['id'] for p in data['profiles']}
    while True:
        candidate = 'p-' + secrets.token_hex(4)
        if candidate not in taken:
            return candidate


def create(name='', copy_from=None):
    """Add a profile that starts signed out, with this machine's game folder
    and emulator settings. Returns its id."""
    import configparser
    data = load()
    profile_id = _new_id(data)
    target = paths.profile_dir(profile_id)
    target.mkdir(parents=True, exist_ok=False)
    source = paths.profile_dir(copy_from or paths.profile_id()) / 'settings.ini'
    if source.exists():
        src = configparser.ConfigParser()
        read_settings(src, source)
        out = configparser.ConfigParser()
        for section in _MACHINE_SECTIONS:
            if src.has_section(section):
                out[section] = dict(src[section])
        for section, keys in _MACHINE_KEYS.items():
            for key in keys:
                if src.has_option(section, key):
                    if not out.has_section(section):
                        out.add_section(section)
                    out[section][key] = src[section][key]
        dirs = save_dirs(profile_id)
        if not out.has_section('Download'):
            out.add_section('Download')
        out['Download']['save_directory'] = str(dirs['saves'])
        with (target / 'settings.ini').open('w', encoding='utf-8') as f:
            out.write(f)
        os.chmod(target / 'settings.ini', 0o600)
    data['profiles'].append({'id': profile_id, 'name': ' '.join((name or '').split())[:40],
                             'created': int(time.time()),
                             # where Back on its welcome screen returns to
                             'from': copy_from or paths.profile_id()})
    save(data)
    return profile_id


def _drop_discarded(data, ids):
    """Finish a discard(): the profile it left can go now that it is closed."""
    gone = data.pop('discard', None)
    if not gone:
        return
    if gone in ids and gone != DEFAULT and gone != data.get('next'):
        _forget(data, gone)
        ids.discard(gone)
        shutil.rmtree(paths.profile_dir(gone), ignore_errors=True)
        dirs = save_dirs(gone)
        for d in (dirs['saves'], dirs['states'], dirs['saves'].parent):
            try:
                d.rmdir()   # only if empty: a never-used profile left nothing
            except OSError:
                pass
    save(data)


def discard(profile_id):
    """Back out of a just-added, never signed-in profile: open the profile it
    was added from and delete this one on the next start, once it is closed.
    Returns the profile to open."""
    data = load()
    entry = get(data, profile_id)
    if not entry or profile_id == DEFAULT:
        raise ValueError('This profile cannot be discarded')
    ids = {p['id'] for p in data['profiles']} - {profile_id}
    back = entry.get('from') if entry.get('from') in ids else DEFAULT
    data['next'] = back
    data['last'] = back
    data['discard'] = profile_id
    save(data)
    return back


def _forget(data, profile_id):
    data['profiles'] = [p for p in data['profiles'] if p['id'] != profile_id]
    data['steam'] = {k: v for k, v in data['steam'].items() if v != profile_id}
    if data.get('last') == profile_id:
        data['last'] = DEFAULT
    if data.get('next') == profile_id:
        data.pop('next')


def local_save_count(profile_id):
    """How many files are in a profile's own save and state folders."""
    dirs = save_dirs(profile_id)
    if not dirs:
        return 0
    n = 0
    for d in (dirs['saves'], dirs['states']):
        for _root, _dirs, files in os.walk(d):
            n += len(files)
    return n


def remove(profile_id, delete_saves=False):
    """Delete a profile's local state. Its saves on RomM are untouched. Its
    local save folders are kept unless asked: they may hold progress not yet
    synced, so that is the user's call (the confirm says so)."""
    if profile_id == DEFAULT:
        raise ValueError('The first profile cannot be removed')
    if profile_id == paths.profile_id():
        raise ValueError('Switch to another profile before removing this one')
    data = load()
    if not get(data, profile_id):
        raise ValueError('No such profile')
    _forget(data, profile_id)
    save(data)
    shutil.rmtree(paths.profile_dir(profile_id), ignore_errors=True)
    if delete_saves:
        shutil.rmtree(save_dirs(profile_id)['saves'].parent, ignore_errors=True)
