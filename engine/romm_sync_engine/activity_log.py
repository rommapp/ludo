"""Persistent recent-activity feed for the Settings UI.

A small, curated event list — one entry per user-visible outcome (download
finished, save-sync ran, collection synced, …), NOT a log-line firehose.
Kept module-level so both main.py (RPC threads) and sync_core's background
threads can record without plumbing a handle through every manager.

Entries persist to activity.json so the feed survives plugin reloads and
Deck restarts. Bounded to the newest MAX_ENTRIES; oldest drop first.
"""

import json
import logging
import threading
import time
from collections import deque
from .paths import config_dir

MAX_ENTRIES = 10


def _file():
    # Resolved lazily: the frontend sets its app id after this module is
    # imported, and a module-level constant would bake in the default.
    return config_dir() / 'activity.json'

_lock = threading.Lock()
_entries = deque(maxlen=MAX_ENTRIES)
_loaded = False


def _load_locked():
    global _loaded
    if _loaded:
        return
    _loaded = True
    try:
        f = _file()
        if f.exists():
            data = json.loads(f.read_text())
            for e in data if isinstance(data, list) else []:
                if isinstance(e, dict) and e.get('title'):
                    _entries.append(e)
    except Exception as e:
        logging.debug(f"activity_log load failed: {e}")


def _save_locked():
    try:
        f = _file()
        tmp = f.with_suffix('.json.tmp')
        tmp.write_text(json.dumps(list(_entries)))
        tmp.replace(f)
    except Exception as e:
        logging.debug(f"activity_log save failed: {e}")


def record(kind, title, detail='', rom_id=None, action=None):
    """Append one activity entry.

    kind: free-form tag the UI maps to an icon —
          'download' | 'sync' | 'save' | 'delete' | 'account' | 'error'
    rom_id: optional, for entries that name one rom. Lets the UI turn the row
          into a link to that game. Omitted from the entry entirely when not
          given, so older logs and callers that don't pass it read back
          unchanged.
    action: optional dict the UI renders as a button on the row, e.g.
          {'kind': 'enable_platform', 'label': 'Turn on', 'platform': 'c64'}.
          See resolve_action for how one is marked done.
    """
    with _lock:
        _load_locked()
        entry = {
            'kind': str(kind),
            'title': str(title),
            'detail': str(detail or ''),
            'timestamp': time.time(),
        }
        if rom_id is not None:
            try:
                entry['rom_id'] = int(rom_id)
            except (TypeError, ValueError):
                pass
        if action:
            entry['action'] = dict(action)
        _entries.append(entry)
        _save_locked()


def take_pending(kind, **match):
    """Remove and return the rows whose action of this kind is still pending.

    For a row that should be replaced rather than repeated: the caller folds
    what they said into one new row.
    """
    with _lock:
        _load_locked()
        taken = [e for e in _entries if _pending(e, kind, match)]
        if taken:
            kept = [e for e in _entries if not _pending(e, kind, match)]
            _entries.clear()
            _entries.extend(kept)
            _save_locked()
        return taken


def _pending(e, kind, match):
    a = e.get('action')
    return (isinstance(a, dict) and a.get('kind') == kind and not a.get('done')
            and all(a.get(k) == v for k, v in match.items()))


def resolve_action(kind, **match):
    """Mark every pending action of this kind (and matching fields) done.

    Done actions stay on the row so it can say what happened instead of
    offering the button again. Returns how many rows changed.
    """
    with _lock:
        _load_locked()
        n = 0
        for e in _entries:
            if _pending(e, kind, match):
                e['action']['done'] = True
                n += 1
        if n:
            _save_locked()
        return n


def get_recent(limit=MAX_ENTRIES):
    """Return entries newest-first."""
    with _lock:
        _load_locked()
        return list(_entries)[::-1][:max(1, int(limit))]


def clear():
    with _lock:
        _load_locked()
        _entries.clear()
        _save_locked()
