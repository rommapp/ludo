"""Cemu's Wii U saves and accounts, read and written the way Cemu does.

Where things are (Cemu 2.x source, src/gui/wxgui/CemuApp.cpp and
src/config/ActiveSettings.cpp):

    config   $XDG_CONFIG_HOME/Cemu/settings.xml   (flatpak: ~/.var/app/info.cemu.Cemu/config/Cemu)
    data     $XDG_DATA_HOME/Cemu                  (flatpak: ~/.var/app/info.cemu.Cemu/data/Cemu)
    portable <AppImage dir>/portable/ holds both, when that folder exists
    mlc      settings.xml <mlc_path>, else <data>/mlc01

A game's save (src/Cafe/IOSU/legacy/iosu_acp.cpp):

    mlc01/usr/save/<high id>/<low id>/meta/            icon and save info
    mlc01/usr/save/<high id>/<low id>/user/common/     shared by every account
    mlc01/usr/save/<high id>/<low id>/user/<account>/  one per account, e.g. 80000001

Accounts (src/Cafe/Account/Account.cpp) are plain text files,
mlc01/usr/save/system/act/<account>/account.dat, at most 12. settings.xml
<Account><PersistentId> (decimal) picks the active one, and ``-a <hex id>`` on
the command line overrides it for one run.

A save travels as one zip per game, in the layout Argosy uses for Wii U:

    <low id>/meta/...   <low id>/user/common/...   <low id>/user/80000001/...

Only the playing account's folder goes in, always named 80000001: that is
the name Argosy's folder restore writes back into, and Argosy's newer
save-unit restore maps any account folder to the player's own. Restore
accepts that, the save-unit spelling ("account"), and archives rooted at
"user/" or at the account folders themselves.
"""

import logging
import os
import re
import secrets
import shutil
import struct
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

FLATPAK_ID = 'info.cemu.Cemu'
MIN_ACCOUNT = 0x80000001
MAX_ACCOUNTS = 12
PACK_ACCOUNT = '80000001'
_HEX8 = re.compile(r'^[0-9a-fA-F]{8}$')
_TITLE_RE = re.compile(r'(?<![0-9A-Fa-f])(0005[0-9A-Fa-f]{4})[/_-]?([0-9A-Fa-f]{8})(?![0-9A-Fa-f])')
# Games and demos keep saves; updates (000E) and DLC (000C) never do.
_SAVE_CATEGORIES = ('00050000', '00050002')


class CemuAccountsError(Exception):
    pass


# ── Installs ────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Install:
    config_dir: Path
    data_dir: Path

    @property
    def settings_file(self):
        return self.config_dir / 'settings.xml'

    @property
    def mlc(self):
        custom = _settings_value(self.settings_file, ('mlc_path',))
        return Path(custom).expanduser() if custom else self.data_dir / 'mlc01'


def install_for(executable):
    """The install a Cemu executable uses: 'flatpak:<id>', an AppImage, or a binary."""
    home = Path.home()
    executable = str(executable or '')
    if executable.startswith('flatpak:'):
        app = home / '.var/app' / (executable.split(':', 1)[1] or FLATPAK_ID)
        return Install(app / 'config/Cemu', app / 'data/Cemu')
    if executable:
        portable = Path(executable).expanduser().parent / 'portable'
        if portable.is_dir():
            return Install(portable, portable)
    config = Path(os.environ.get('XDG_CONFIG_HOME') or home / '.config') / 'Cemu'
    data = Path(os.environ.get('XDG_DATA_HOME') or home / '.local/share') / 'Cemu'
    return Install(config, data)


def installs(executable=None):
    """Installs with an mlc folder on disk, the one ``executable`` runs first."""
    found = []
    candidates = [install_for(executable)] if executable else []
    candidates += [install_for(f'flatpak:{FLATPAK_ID}'), install_for('')]
    for inst in candidates:
        if inst not in found and inst.mlc.is_dir():
            found.append(inst)
    return found


def _settings_value(settings_file, path):
    try:
        node = ET.parse(settings_file).getroot()
    except (OSError, ET.ParseError):
        return None
    for name in path:
        node = node.find(name) if node is not None else None
    text = (node.text or '').strip() if node is not None else ''
    return text or None


# ── Accounts ────────────────────────────────────────────────────────────────

def _act_dir(mlc):
    return Path(mlc) / 'usr' / 'save' / 'system' / 'act'


def _decode_name(value):
    chars = []
    for i in range(0, len(value) - 3, 4):
        code = int(value[i:i + 4], 16)
        if not code:
            break
        chars.append(chr(code))
    return ''.join(chars)


def accounts(mlc):
    """{account id (int): name} for the valid accounts in ``mlc``."""
    out = {}
    try:
        entries = list(_act_dir(mlc).iterdir())
    except OSError:
        return out
    for entry in entries:
        if not (entry.is_dir() and _HEX8.match(entry.name)):
            continue
        pid = int(entry.name, 16)
        if pid < MIN_ACCOUNT:
            continue
        try:
            text = (entry / 'account.dat').read_text('utf-8', errors='replace')
        except OSError:
            continue
        fields = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
        name = fields.get('MiiName', '')
        # Cemu's own validity rules (Account::ParseFile and CheckValid).
        if len(name) != 44 or len(fields.get('MiiData', '')) != 192 or not int(name[:4] or '0', 16):
            continue
        out[pid] = _decode_name(name)
    return dict(sorted(out.items()))


def active_account(inst):
    """The account Cemu plays as when launched without -a."""
    listed = accounts(inst.mlc)
    value = _settings_value(inst.settings_file, ('Account', 'PersistentId'))
    try:
        pid = int(value) if value else MIN_ACCOUNT
    except ValueError:
        pid = MIN_ACCOUNT
    if pid in listed or not listed:
        return pid
    # Cemu falls back to the first account it lists.
    return next(iter(listed))


def _ffl_crc16(data):
    crc = 0
    for byte in data:
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else (crc << 1)
            crc &= 0xFFFF
        crc ^= byte
    return crc


def _mii_data(name):
    """The default Mii Cemu makes for a new account (Account::Account), named."""
    words = [1] * 48
    words[0x3A // 2] = 1 | (3 << 9)
    words[0x2 // 2] = 1 | (1 << 12)
    data = bytearray(96)
    for i, w in enumerate(words):
        struct.pack_into('<H', data, i * 2, w)
    # The mii id low word, written big-endian then byte-swapped per u16.
    low = struct.pack('>I', 0x33334)
    data[8:12] = bytes((low[1], low[0], low[3], low[2]))
    data[0x1A:0x2E] = bytes(20)
    for i, ch in enumerate(name[:10]):
        struct.pack_into('<H', data, 0x1A + i * 2, ord(ch))
    # Cemu searches a value at bytes 4..7 that zeroes the CRC. The CRC is
    # linear in its input, so solve for those bits instead of trying them.
    data[4:8] = bytes(4)
    target = _ffl_crc16(data)
    columns = []
    for bit in range(32):
        probe = bytearray(96)
        probe[4:8] = (1 << bit).to_bytes(4, 'big')
        columns.append((_ffl_crc16(probe), 1 << bit))
    value = _solve_gf2(columns, target)
    data[4:8] = value.to_bytes(4, 'big')
    assert _ffl_crc16(data) == 0
    return bytes(data)


def _solve_gf2(columns, target):
    """x with XOR of the chosen columns == target (Gaussian elimination)."""
    basis = {}
    for vec, combo in columns:
        for bit in range(15, -1, -1):
            if not vec >> bit & 1:
                continue
            if bit in basis:
                bvec, bcombo = basis[bit]
                vec ^= bvec
                combo ^= bcombo
            else:
                basis[bit] = (vec, combo)
                break
    result = 0
    for bit in range(15, -1, -1):
        if target >> bit & 1:
            if bit not in basis:
                raise CemuAccountsError('could not build Mii data')
            bvec, bcombo = basis[bit]
            target ^= bvec
            result ^= bcombo
    return result


def _clean_name(name):
    text = ''.join(ch if ord(ch) < 0x10000 and ch.isprintable() else '?'
                   for ch in (name or '').strip())
    return text[:10] or 'Player'


def _account_text(pid, name):
    uuid = secrets.token_bytes(16)
    transferable = (0x2000004 << 32) | int.from_bytes(uuid[12:16], 'big')
    name = _clean_name(name)
    mii_name = ''.join(f'{ord(c):04x}' for c in name).ljust(44, '0')
    lines = [
        'AccountInstance_20120705',
        f'PersistentId={pid:08x}',
        f'TransferableIdBase={transferable:x}',
        f'Uuid={uuid.hex()}',
        f'MiiData={_mii_data(name).hex()}',
        f'MiiName={mii_name}',
        'AccountId=',
        'BirthYear=0', 'BirthMonth=0', 'BirthDay=0', 'Gender=0',
        'EmailAddress=',
        'Country=0', 'SimpleAddressId=0', 'PrincipalId=0',
        'IsPasswordCacheEnabled=0',
        'AccountPasswordCache=' + '00' * 32,
    ]
    return '\n'.join(lines) + '\n'


def _write_account(mlc, pid, name):
    folder = _act_dir(mlc) / f'{pid:08x}'
    folder.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix='.account-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(_account_text(pid, name))
        os.replace(tmp, folder / 'account.dat')
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def ensure_default_account(mlc):
    """Create Cemu's own first account when Cemu has never run.

    Cemu makes "default" (80000001) on its first start; doing the same here
    lets a save restore, or another account be added, before that start,
    without the added account becoming the one Cemu falls back to.
    """
    if not accounts(mlc):
        _write_account(mlc, MIN_ACCOUNT, 'default')


def add_account(mlc, name, pid=None):
    """Add an account and return its id. ``pid`` reuses an id, so one Ludo
    profile is the same account in every Cemu install. Cemu must be closed."""
    ensure_default_account(mlc)
    listed = accounts(mlc)
    if pid is not None and pid in listed:
        return pid
    if len(listed) >= MAX_ACCOUNTS:
        raise CemuAccountsError(f'Cemu already has {MAX_ACCOUNTS} accounts')
    if pid is None or pid < MIN_ACCOUNT or (_act_dir(mlc) / f'{pid:08x}').exists():
        head = _persistent_id_head(mlc)
        pid = max([head, *listed]) + 1
        while (_act_dir(mlc) / f'{pid:08x}').exists():
            pid += 1
    _write_account(mlc, pid, name)
    return pid


def _persistent_id_head(mlc):
    try:
        for line in (_act_dir(mlc) / 'persisid.dat').read_text().splitlines():
            if line.startswith('PersistentIdHead='):
                return int(line.split('=', 1)[1], 16)
    except (OSError, ValueError):
        pass
    return MIN_ACCOUNT


# ── Saves ───────────────────────────────────────────────────────────────────

def _title_dir(mlc, title_id):
    tid = title_id.lower()
    return Path(mlc) / 'usr' / 'save' / tid[:8] / tid[8:]


def unit(mlc, title_id, pid):
    """{'meta', 'common', 'account'}: a title's save folders for one account."""
    title = _title_dir(mlc, title_id)
    return {'meta': title / 'meta', 'common': title / 'user' / 'common',
            'account': title / 'user' / f'{pid:08x}'}


def _has_files(folder):
    try:
        return any(p.is_file() for p in Path(folder).rglob('*'))
    except OSError:
        return False


def units(mlc, pid):
    """{title id (16 hex, upper): unit} for every title holding a save for
    ``pid``. meta/ alone is not a save: Cemu writes it on first boot."""
    out = {}
    root = Path(mlc) / 'usr' / 'save'
    for category in _SAVE_CATEGORIES:
        try:
            lows = sorted((root / category).iterdir())
        except OSError:
            continue
        for low in lows:
            if not (low.is_dir() and _HEX8.match(low.name)):
                continue
            tid = f'{category}{low.name}'.upper()
            u = unit(mlc, tid, pid)
            if _has_files(u['account']) or _has_files(u['common']):
                out[tid] = u
    return out


def newest(u):
    """Latest mtime in a unit (files and folders, so a deletion counts)."""
    stamps = []
    for folder in u.values():
        folder = Path(folder)
        if not folder.is_dir():
            continue
        stamps.append(folder.stat().st_mtime)
        for p in folder.rglob('*'):
            try:
                stamps.append(p.stat().st_mtime)
            except OSError:
                pass
    return max(stamps) if stamps else 0.0


def pack(u, title_id, destination):
    """Zip a unit into ``destination`` (see the module docstring), or None
    when it holds no file. Deterministic, so an unchanged save hashes the same."""
    from . import folder_saves
    low = title_id.lower()[8:]
    roots = [(f'{low}/meta', u['meta']), (f'{low}/user/common', u['common']),
             (f'{low}/user/{PACK_ACCOUNT}', u['account'])]
    roots = [(name, folder) for name, folder in roots if Path(folder).is_dir()]
    if not roots:
        return None
    return folder_saves.pack_roots(roots, destination)


def zip_title_low(zip_path):
    """The low title id a pack is nested under, or None."""
    try:
        with zipfile.ZipFile(zip_path) as z:
            tops = {i.filename.split('/', 1)[0].lower() for i in z.infolist() if '/' in i.filename}
    except (OSError, zipfile.BadZipFile):
        return None
    return tops.pop() if len(tops) == 1 and _HEX8.match(next(iter(tops))) else None


def _zip_components(names, pid):
    """{'meta' | 'common' | 'account': prefix in the zip} for the parts a pack carries."""
    tops = {n.split('/', 1)[0] for n in names if '/' in n}
    prefix = ''
    if len(tops) == 1 and _HEX8.match(next(iter(tops))):
        prefix = next(iter(tops)) + '/'
    rest = {n[len(prefix):] for n in names if n.startswith(prefix)}
    heads = {n.split('/', 1)[0] for n in rest if '/' in n}
    if 'user' in heads or 'meta' in heads:
        user = prefix + 'user/'
    else:
        # Rooted at the account folders themselves.
        user, prefix = prefix, None
    found = {}
    if prefix is not None and 'meta' in heads:
        found['meta'] = prefix + 'meta'
    below = {n[len(user):].split('/', 1)[0] for n in names
             if n.startswith(user) and '/' in n[len(user):]}
    if 'common' in below:
        found['common'] = user + 'common'
    accounts_in = sorted(b for b in below if b == 'account'
                         or (_HEX8.match(b) and int(b, 16) >= MIN_ACCOUNT))
    if len(accounts_in) == 1:
        found['account'] = user + accounts_in[0]
    elif accounts_in:
        mine = f'{pid:08x}'
        pick = mine if mine in accounts_in else (PACK_ACCOUNT if PACK_ACCOUNT in accounts_in else None)
        if pick is None:
            raise ValueError(f'the save holds several accounts ({", ".join(accounts_in)}) '
                             f'and none is {mine}')
        found['account'] = user + pick
    return found


def restore(zip_path, mlc, title_id, pid, backup_dir=None):
    """Replace this account's save for ``title_id`` with the pack's.

    Each part the pack carries replaces the local one; the others, and every
    other account's folder, are left alone. Whatever is replaced is moved to
    ``backup_dir`` first. Returns the parts restored.
    """
    from . import folder_saves
    u = unit(mlc, title_id, pid)
    with zipfile.ZipFile(zip_path) as z:
        names = [i.filename for i in z.infolist() if not i.is_dir()]
        parts = _zip_components(names, pid)
        if 'account' not in parts and 'common' not in parts:
            raise ValueError(f'not a Wii U save: {sorted({n.split("/")[0] for n in names})}')
        backup = Path(backup_dir) / title_id.upper() / time.strftime('%Y%m%d-%H%M%S') if backup_dir else None
        for part, prefix in sorted(parts.items()):
            folder_saves._replace_with_root(z, prefix, u[part], backup / part if backup else None)
    return sorted(parts)


# ── Which game a save belongs to ────────────────────────────────────────────

def title_id_from_rom(path):
    """The 16-hex title id of a Wii U game on disk (upper case), or None.

    An unpacked title says so in meta/meta.xml; a .wua names its title
    folder after it, and carries meta.xml too for the archives whose folder
    name is zeroed. Otherwise a [0005xxxxxxxxxxxx] tag in the name.
    """
    path = Path(path)
    try:
        if path.is_dir():
            meta = path / 'meta' / 'meta.xml'
            if meta.is_file():
                found = _title_from_meta(meta.read_bytes())
                if found:
                    return found
            for child in sorted(path.iterdir()):
                if child.suffix.lower() == '.wua' and child.is_file():
                    found = _title_from_wua(child)
                    if found:
                        return found
                if child.is_dir() and child.name.lower() == 'code':
                    return title_id_from_rom(path / 'meta' / 'meta.xml') if (path / 'meta').is_dir() else None
        elif path.suffix.lower() == '.rpx' and path.parent.name.lower() == 'code':
            meta = path.parent.parent / 'meta' / 'meta.xml'
            if meta.is_file():
                return _title_from_meta(meta.read_bytes())
        elif path.name.lower() == 'meta.xml':
            return _title_from_meta(path.read_bytes())
        elif path.suffix.lower() == '.wua':
            found = _title_from_wua(path)
            if found:
                return found
    except OSError as e:
        log.debug("could not read %s: %s", path, e)
    return title_id_from_name(path.name)


def title_id_from_name(name):
    match = _TITLE_RE.search(str(name))
    return (match.group(1) + match.group(2)).upper() if match else None


def _title_from_meta(data):
    match = re.search(rb'<title_id[^>]*>\s*([0-9A-Fa-f]{16})\s*<', data)
    if not match:
        return None
    tid = match.group(1).decode().upper()
    return tid if tid.startswith('0005') and int(tid[8:], 16) else None


# ZArchive, the .wua container (github.com/Exzap/ZArchive): a 0x90-byte
# big-endian footer at the end lists the sections; the file tree's names are
# plain, file data sits in 64 KiB blocks, zstd-compressed unless stored.
_ZAR_MAGIC = 0x169f52d6
_ZAR_BLOCK = 0x10000
_ZAR_PER_RECORD = 16


def _zstd_decompress(data):
    for name in ('compression.zstd', 'backports.zstd'):
        try:
            module = __import__(name, fromlist=['decompress'])
            return module.decompress(data)
        except ImportError:
            continue
    try:
        import pyzstd
        return pyzstd.decompress(data)
    except ImportError:
        pass
    import zstandard
    return zstandard.ZstdDecompressor().decompress(data, max_output_size=_ZAR_BLOCK)


class _Wua:
    def __init__(self, f):
        f.seek(0, 2)
        end = f.tell()
        if end < 0x90:
            raise ValueError('too small')
        f.seek(end - 0x90)
        footer = f.read(0x90)
        total, _version, magic = struct.unpack('>QII', footer[0x80:0x90])
        if magic != _ZAR_MAGIC or total != end:
            raise ValueError('not a ZArchive')
        self.sections = [struct.unpack('>QQ', footer[i * 16:i * 16 + 16]) for i in range(6)]
        self.f = f
        self.names = self._section(2)
        self.tree = self._section(3)

    def _section(self, index):
        offset, size = self.sections[index]
        self.f.seek(offset)
        return self.f.read(size)

    def name(self, offset):
        if offset >= len(self.names):
            return ''  # the root folder has no name
        length = self.names[offset]
        start = offset + 1
        if length & 0x80:
            length = (length & 0x7F) | (self.names[offset + 1] << 7)
            start += 1
        return self.names[start:start + length].decode('utf-8', errors='replace')

    def entry(self, index):
        a, b, c, d = struct.unpack('>IIII', self.tree[index * 16:index * 16 + 16])
        if a >> 31:
            size = c | ((d >> 16) << 32)
            offset = b | ((d & 0xFFFF) << 32)
            return self.name(a & 0x7FFFFFFF), True, offset, size
        return self.name(a & 0x7FFFFFFF), False, b, c

    def children(self, index):
        _name, is_file, start, count = self.entry(index)
        if is_file:
            return []
        return [(i, self.entry(i)) for i in range(start, start + count)]

    def find(self, index, name):
        for i, entry in self.children(index):
            if entry[0].lower() == name.lower():
                return i, entry
        return None, None

    def read(self, offset, size):
        out = bytearray()
        block = offset // _ZAR_BLOCK
        skip = offset % _ZAR_BLOCK
        records_at, _ = self.sections[1]
        data_at, _ = self.sections[0]
        while len(out) < skip + size:
            rec = block // _ZAR_PER_RECORD
            self.f.seek(records_at + rec * (8 + 2 * _ZAR_PER_RECORD))
            raw = self.f.read(8 + 2 * _ZAR_PER_RECORD)
            base = struct.unpack('>Q', raw[:8])[0]
            sizes = struct.unpack(f'>{_ZAR_PER_RECORD}H', raw[8:])
            within = block % _ZAR_PER_RECORD
            start = base + sum(s + 1 for s in sizes[:within])
            length = sizes[within] + 1
            self.f.seek(data_at + start)
            chunk = self.f.read(length)
            out += chunk if length == _ZAR_BLOCK else _zstd_decompress(chunk)
            block += 1
        return bytes(out[skip:skip + size])


def _title_from_wua(path):
    with open(path, 'rb') as f:
        try:
            wua = _Wua(f)
        except (ValueError, struct.error, IndexError) as e:
            log.debug("not a readable .wua %s: %s", path, e)
            return None
        folders = [(i, e) for i, e in wua.children(0) if not e[1]]
        best = None
        for index, (name, _is_file, _a, _b) in folders:
            from_name = title_id_from_name(name.split('_', 1)[0])
            if from_name and int(from_name[8:], 16) and from_name[:8] in _SAVE_CATEGORIES:
                return from_name
            meta_i, meta = wua.find(index, 'meta')
            if meta is None:
                continue
            _xml_i, xml = wua.find(meta_i, 'meta.xml')
            if xml is None or not xml[1] or xml[3] > 1 << 20:
                continue
            try:
                found = _title_from_meta(wua.read(xml[2], xml[3]))
            except Exception as e:
                log.debug("could not read meta.xml in %s: %s", path, e)
                continue
            if found and (best is None or found[:8] in _SAVE_CATEGORIES):
                best = found
        return best


# ── Running ─────────────────────────────────────────────────────────────────

def backup_dir_for(cache):
    return Path(cache) / 'save_backups' / 'cemu'


def remove_tree(path):
    shutil.rmtree(path, ignore_errors=True)
