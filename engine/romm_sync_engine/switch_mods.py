"""Install canonical Switch mod ZIPs without importing emulator settings.

Packages contain load/<TITLE_ID>/<mod>/{exefs,romfs,cheats}/... and optionally
sdmc/UltraCam/<game>/Config/*.{ini,json}. Paths are logical: callers supply
the emulator's actual load and SD roots. No archive path is an absolute path.
"""

import hashlib
import fcntl
import json
import os
import re
import shutil
import stat
import tempfile
import threading
import zipfile
from contextlib import contextmanager
from pathlib import Path

MAX_FILES = 10_000
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_TOTAL_BYTES = 1024 * 1024 * 1024
_LOCK = threading.Lock()
ULTRACAM_GAMES = {'0100F2C0115B6000': 'TOTK', '01007EF00011E000': 'BOTW'}
HANDHELD720 = {
    ('AspectRatio', 'Width'): '16', ('AspectRatio', 'Height'): '9',
    ('Resolution', 'Width'): '1280', ('Resolution', 'Height'): '720',
    ('Resolution', 'ShadowResolution'): '1024', ('Resolution', 'QualityImprovements'): 'False',
    ('Handheld', 'Width'): '1280', ('Handheld', 'Height'): '720',
    ('Handheld', 'OverrideHandheld_Resolution'): 'True',
    ('UltraCamFPS', 'DynamicFPS'): 'True', ('UltraCamFPS', 'MaxFPS'): '60',
}


class ModError(ValueError):
    pass


def handheld_config(data):
    """Patch known UltraCam keys; never reserialize or guess a new INI schema."""
    section, seen, output = '', set(), []
    for line in data.decode('utf-8-sig').splitlines(keepends=True):
        stripped = line.strip()
        if stripped.startswith('[') and stripped.endswith(']'):
            section = stripped[1:-1]
        key, sep, _ = line.partition('=')
        field = (section, key.strip())
        if sep and field in HANDHELD720:
            if field in seen:
                raise ModError('Ambiguous UltraCam configuration')
            seen.add(field)
            newline = '\r\n' if line.endswith('\r\n') else '\n' if line.endswith('\n') else ''
            line = key + '= ' + HANDHELD720[field] + newline
        output.append(line)
    if seen != HANDHELD720.keys():
        raise ModError('This UltraCam configuration does not support the handheld preset')
    return ''.join(output).encode('utf-8')


def _parts(name):
    if (not name or any(c in name for c in '\\:<>|?*"') or name.startswith('/')
            or len(name.encode('utf-8')) > 1024
            or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in name)):
        raise ModError('Unsafe archive path')
    parts = name.rstrip('/').split('/')
    if any(p in ('', '.', '..') or p.endswith((' ', '.')) or len(p.encode('utf-8')) > 255 for p in parts):
        raise ModError('Unsafe archive path')
    return parts


def _target(name, title_id, directory=False):
    parts = _parts(name)
    if any(p in ('__MACOSX', '.DS_Store') or p.startswith('._') for p in parts):
        return None
    if len(parts) == 1 and parts[0].lower() in ('readme', 'readme.txt', 'readme.md', 'license', 'license.txt', 'license.md'):
        return None
    if directory:
        if parts[0] == 'load':
            if len(parts) > 1 and parts[1].upper() != title_id:
                raise ModError('Package belongs to another game')
            if len(parts) <= 3 or parts[3] in ('exefs', 'romfs', 'cheats'):
                return None
        if parts in (['config'], ['config', 'custom']):
            return None
        prefix = ['sdmc', 'UltraCam', ULTRACAM_GAMES.get(title_id), 'Config']
        if len(parts) <= 4 and parts == prefix[:len(parts)]:
            return None
        raise ModError('Unsupported archive directory')
    if (len(parts) >= 5 and parts[0] == 'load'
            and parts[1].upper() == title_id
            and parts[3] in ('exefs', 'romfs', 'cheats')):
        parts[1] = title_id
        return '/'.join(parts)
    if (len(parts) == 5 and parts[:2] == ['sdmc', 'UltraCam']
            and parts[2] == ULTRACAM_GAMES.get(title_id)
            and parts[3] == 'Config' and Path(parts[4]).suffix.lower() in ('.ini', '.json')):
        return '/'.join(parts)
    if (len(parts) == 3 and parts[:2] == ['config', 'custom']
            and parts[2].upper() == title_id + '.INI'):
        return None
    raise ModError('Unsupported path or package belongs to another game: ' + name)


def inspect(archive, title_id):
    """Validate every member before any target mutation; return logical entries."""
    title_id = str(title_id).upper()
    if not re.fullmatch(r'[0-9A-F]{16}', title_id):
        raise ModError('A verified Switch title ID is required')
    entries, skipped, seen, directories, total = [], [], set(), {}, 0
    with zipfile.ZipFile(archive) as z:
        if len(z.infolist()) > MAX_FILES:
            raise ModError('Too many archive entries')
        for member in z.infolist():
            _parts(member.orig_filename)
            mode = member.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or member.flag_bits & 1:
                raise ModError('Links, special files and encrypted files are unsupported')
            if member.is_dir():
                _target(member.filename, title_id, directory=True)
                continue
            if member.file_size > MAX_FILE_BYTES:
                raise ModError('Archive member exceeds the size limit')
            total += member.file_size
            if total > MAX_TOTAL_BYTES:
                raise ModError('Archive exceeds the size limit')
            target = _target(member.filename, title_id)
            if target is None:
                skipped.append(member.filename)
                continue
            folded = target.casefold()
            if folded in seen or folded in directories:
                raise ModError('Duplicate or overlapping archive destination')
            parts = target.split('/')
            for length in range(1, len(parts)):
                prefix = '/'.join(parts[:length])
                lower = prefix.casefold()
                if lower in seen or directories.get(lower, prefix) != prefix:
                    raise ModError('Overlapping or inconsistently cased archive paths')
                directories[lower] = prefix
            seen.add(folded)
            entries.append({'source': member.filename, 'target': target})
    if not any(e['target'].startswith('load/') for e in entries):
        raise ModError('Package contains no mod for this game')
    return {'files': entries, 'skipped': skipped}


def _hash(path):
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(mode):
        raise ModError('Destination is not a regular file')
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.ludo-mod-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


class Installer:
    """Receipts own only files created by this installer, never borrowed files.

    A persistent journal restores the previous package after an interrupted
    transaction. Callers must refuse both install and removal while Eden runs.
    """

    def __init__(self, state_dir, load_root, sdmc_root, is_running):
        self.state_dir = Path(state_dir)
        if not Path(load_root).is_absolute() or not Path(sdmc_root).is_absolute():
            raise ModError('Emulator folders must be absolute paths')
        self.roots = {'load': Path(load_root).resolve(), 'sdmc': Path(sdmc_root).resolve()}
        self.is_running = is_running

    @contextmanager
    def _locked(self):
        with _LOCK:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            with (self.state_dir / 'lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(lock, fcntl.LOCK_UN)

    def _path(self, logical, title_id):
        if _target(logical, title_id) != logical:
            raise ModError('Invalid install receipt')
        root, *parts = _parts(logical)
        base = self.roots[root]
        path = base
        for part in parts:
            path = path / part
            if path.is_symlink():
                raise ModError('Destination contains a symbolic link')
        return path

    def _receipt_path(self, package_id):
        key = hashlib.sha256(str(package_id).encode()).hexdigest()
        return self.state_dir / 'packages' / (key + '.json')

    def _read(self, path):
        return json.loads(path.read_text()) if path.exists() else None

    def installed(self, title_id):
        out = []
        for path in (self.state_dir / 'packages').glob('*.json'):
            r = self._read(path)
            if r and r.get('title_id') == title_id:
                out.append({'package_id': r['package_id'], 'name': r['name'],
                            'sha256': r['sha256'], 'skipped': r['skipped'],
                            'profile': r.get('profile', 'original')})
        return out

    def _check_roots(self, receipt):
        if receipt and receipt['roots'] != {k: str(v) for k, v in self.roots.items()}:
            raise ModError('Emulator folders changed since this package was installed')

    def _recover(self):
        journal_path = self.state_dir / 'pending.json'
        journal = self._read(journal_path)
        if not journal:
            return
        self._check_roots(journal)
        # Check ALL paths before restoring any of them. A later external edit
        # must not be overwritten, even after a process crash.
        started = journal['started']
        if not isinstance(started, int) or not 0 <= started <= len(journal['actions']):
            raise ModError('Invalid recovery journal')
        actions = journal['actions'][:started]
        for action in actions:
            path = self._path(action['target'], journal['title_id'])
            if _hash(path) not in (action['before_hash'], action['after_hash']):
                raise ModError('Interrupted install has externally changed files; recovery required')
        for index, action in reversed(list(enumerate(actions))):
            path = self._path(action['target'], journal['title_id'])
            if action['before_hash'] is None:
                path.unlink(missing_ok=True)
            else:
                backup = self.state_dir / 'rollback' / str(index)
                if _hash(backup) != action['before_hash']:
                    raise ModError('Install recovery backup is missing or damaged')
                _write(path, backup.read_bytes())
        self._save_receipt(journal['package_id'], journal['old_receipt'])
        journal_path.unlink()
        shutil.rmtree(self.state_dir / 'rollback', ignore_errors=True)

    def _save_receipt(self, package_id, receipt):
        path = self._receipt_path(package_id)
        if receipt is None:
            path.unlink(missing_ok=True)
        else:
            _write(path, json.dumps(receipt).encode())

    def _apply(self, package_id, title_id, old, new, staged):
        old_files = {e['target']: e for e in (old or {}).get('files', [])}
        new_files = {e['target']: e for e in (new or {}).get('files', [])}
        for receipt_path in (self.state_dir / 'packages').glob('*.json'):
            other = self._read(receipt_path)
            if other['package_id'] != package_id:
                overlap = new_files.keys() & {e['target'] for e in other['files']}
                if overlap:
                    raise ModError('Files are already managed by another package')
        actions = []
        for logical in sorted(old_files.keys() | new_files.keys()):
            path = self._path(logical, title_id)
            before = _hash(path)
            prior = old_files.get(logical)
            after = new_files.get(logical)
            if prior and before != prior['sha256']:
                raise ModError('Installed file changed outside Ludo: ' + logical)
            if after:
                if prior and not prior['owned'] and before != after['sha256']:
                    raise ModError('Cannot update a file that predates this installation: ' + logical)
                if not prior and before is not None and before != after['sha256']:
                    raise ModError('Existing file belongs to another installation: ' + logical)
                after['owned'] = prior['owned'] if prior else before is None
                desired = after['sha256']
            else:
                desired = None if prior['owned'] else before
            if before != desired:
                actions.append({'target': logical, 'before_hash': before, 'after_hash': desired})
        backup_dir = self.state_dir / 'rollback'
        shutil.rmtree(backup_dir, ignore_errors=True)
        backup_dir.mkdir(parents=True)
        for index, action in enumerate(actions):
            if action['before_hash'] is not None:
                data = self._path(action['target'], title_id).read_bytes()
                if hashlib.sha256(data).hexdigest() != action['before_hash']:
                    raise ModError('Destination changed while preparing the install')
                _write(backup_dir / str(index), data)
        journal = {'package_id': package_id, 'title_id': title_id,
                   'roots': {k: str(v) for k, v in self.roots.items()},
                   'old_receipt': old, 'actions': actions, 'started': 0}
        _write(self.state_dir / 'pending.json', json.dumps(journal).encode())
        try:
            for index, action in enumerate(actions):
                if self.is_running():
                    raise ModError('Close Eden before installing or removing mods')
                path = self._path(action['target'], title_id)
                if _hash(path) != action['before_hash']:
                    raise ModError('Destination changed during the install')
                journal['started'] = index + 1
                _write(self.state_dir / 'pending.json', json.dumps(journal).encode())
                if action['after_hash'] is None:
                    path.unlink()
                else:
                    _write(path, staged[action['target']].read_bytes())
                if _hash(path) != action['after_hash']:
                    raise ModError('Installed file failed verification')
            self._save_receipt(package_id, new)
            (self.state_dir / 'pending.json').unlink()
            shutil.rmtree(backup_dir, ignore_errors=True)
        except Exception:
            self._recover()
            raise

    def install(self, archive, title_id, package_id, name, profile='original'):
        if profile not in ('original', 'handheld720'):
            raise ModError('Unknown mod preset')
        with self._locked():
            if self.is_running():
                raise ModError('Close Eden before installing or removing mods')
            self._recover()
            plan = inspect(archive, title_id)
            if profile == 'handheld720' and not any(
                    e['target'] == 'sdmc/UltraCam/TOTK/Config/maxlastbreath.ini'
                    for e in plan['files']):
                raise ModError('This package has no supported UltraCam preset; choose original settings')
            title_id = title_id.upper()
            old = self._read(self._receipt_path(package_id))
            self._check_roots(old)
            if old and old['title_id'] != title_id:
                raise ModError('Package identity belongs to another game')
            self.state_dir.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=self.state_dir) as stage:
                staged, files = {}, []
                with zipfile.ZipFile(archive) as z:
                    for index, entry in enumerate(plan['files']):
                        path = Path(stage) / str(index)
                        with z.open(entry['source']) as source, path.open('wb') as sink:
                            shutil.copyfileobj(source, sink, 1024 * 1024)
                        if (profile == 'handheld720'
                                and entry['target'] == 'sdmc/UltraCam/TOTK/Config/maxlastbreath.ini'):
                            path.write_bytes(handheld_config(path.read_bytes()))
                        staged[entry['target']] = path
                        files.append({'target': entry['target'], 'sha256': _hash(path)})
                receipt = {'package_id': package_id, 'title_id': title_id, 'name': name,
                           'sha256': _hash(Path(archive)), 'files': files,
                           'profile': profile,
                           'skipped': plan['skipped'],
                           'roots': {k: str(v) for k, v in self.roots.items()}}
                self._apply(package_id, title_id, old, receipt, staged)
            return {'status': 'ok', 'skipped': plan['skipped']}

    def remove(self, package_id, title_id):
        with self._locked():
            if self.is_running():
                raise ModError('Close Eden before installing or removing mods')
            self._recover()
            old = self._read(self._receipt_path(package_id))
            if not old or old['title_id'] != title_id.upper():
                raise ModError('Package is not installed for this game')
            self._check_roots(old)
            self._apply(package_id, title_id.upper(), old, None, {})
            # Only empty directories are removed; mods not owned by Ludo stay.
            for entry in old['files']:
                path = self._path(entry['target'], title_id.upper()).parent
                root = self.roots[entry['target'].split('/')[0]]
                while path != root:
                    try:
                        path.rmdir()
                    except OSError:
                        break
                    path = path.parent
            return {'status': 'ok'}

    def recover(self):
        with self._locked():
            if self.is_running():
                raise ModError('Close Eden before recovering an interrupted mod install')
            self._recover()
            return {'status': 'ok'}
