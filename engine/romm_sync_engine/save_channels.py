"""Save sync through RomM's channel and snapshot API.

RomM is replacing free-text save slots with channels: one playthrough of one
ROM *file*, whose history is a chain of immutable snapshots. A device holds
one snapshot per channel (the one it plays from), and every push names the
current it expects. A push that loses a race to another device is kept as a
branch and answered 409, so nothing is overwritten and the device asks the
user. Design: rommapp/romm#5175, implementation: rommapp/romm#5198. Argosy
ships the reference client (data/sync/snapshot/).

Servers that speak it say so in /api/heartbeat (SAVE_SYNC.SNAPSHOTS). Older
servers keep the negotiate/session path in sync_core.

This module is the part that doesn't need the rest of the engine: the decide
table, which ROM file a save belongs to, what each channel's device state is,
and the HTTP calls. Wiring into AutoSyncManager lives in sync_core.
"""

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin

DEFAULT_CHANNEL = 'default'


def snapshots_supported(heartbeat):
    """True when a /api/heartbeat body advertises the snapshot API."""
    return bool(((heartbeat or {}).get('SAVE_SYNC') or {}).get('SNAPSHOTS'))


# ── Decide ────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SaveHashes:
    """A save's hashes. ``identity`` leaves out clock members, so the same
    progress with a ticked RTC compares equal. For a native save Ludo can't
    split, both are the content hash."""
    content: str
    identity: str

    def same_save_as(self, other):
        return other is not None and self.identity == other.identity


@dataclass(frozen=True)
class SnapshotPoint:
    """A snapshot as the decide table sees it. ``by_choice`` marks a held
    snapshot the user restored on purpose: kept while clean, and pushed on
    top of the current once played on, instead of reading as a conflict."""
    id: int
    save: Optional[SaveHashes]
    by_choice: bool = False


@dataclass(frozen=True)
class Action:
    """What to do for one channel.

    kind: 'nothing' | 'push' | 'download' | 'adopt' | 'conflict'.
    For 'push', expected_current_id is what the manifest expects (None for an
    empty channel) and parent_id what it builds on. For the others,
    snapshot_id is the server's current.
    """
    kind: str
    snapshot_id: Optional[int] = None
    expected_current_id: Optional[int] = None
    parent_id: Optional[int] = None


def decide(held, current, local):
    """The decide table from the design, for one channel.

    held: the SnapshotPoint this device last pushed or applied, or None.
    current: the channel's current SnapshotPoint on the server, or None.
    local: SaveHashes of the save on disk now, or None.

    A missing local save never reads as a change, so a cleared save folder
    is refilled from the server rather than pushed as empty. Mirrors Argosy's
    SnapshotDecision so the two clients agree on every case.
    """
    if current is None:
        if local is not None:
            return Action('push', expected_current_id=None,
                          parent_id=held.id if held else None)
        return Action('nothing')
    if held is None:
        if local is None:
            return Action('download', snapshot_id=current.id)
        if local.same_save_as(current.save):
            return Action('adopt', snapshot_id=current.id)
        return Action('conflict', snapshot_id=current.id)
    dirty = local is not None and not local.same_save_as(held.save)
    if held.id == current.id or held.by_choice:
        if dirty:
            return Action('push', expected_current_id=current.id,
                          parent_id=held.id)
        return Action('nothing')
    if dirty:
        return Action('conflict', snapshot_id=current.id)
    return Action('download', snapshot_id=current.id)


# ── Which file ────────────────────────────────────────────────────────────

def rom_file_for_save(files, save_stem):
    """The RomM file entry a save belongs to, or None.

    A channel is keyed to one file, not the ROM entry, so a revision and a
    translation never share saves. RetroArch names a save after the content
    it booted, so match the save's stem against each file's stem. A ROM of
    one file owns every save filed under it. A disc set saves under its
    .m3u, which is one of its files too. Anything else is ambiguous and
    stays on the legacy path.
    """
    files = [f for f in (files or []) if f.get('id') is not None]
    if not files:
        return None
    stem = (save_stem or '').lower()
    for f in files:
        if Path(f.get('file_name') or '').stem.lower() == stem:
            return f
    if len(files) == 1:
        return files[0]
    m3u = [f for f in files if (f.get('file_name') or '').lower().endswith('.m3u')]
    if len(m3u) == 1:
        return m3u[0]
    return None


# ── Device state ──────────────────────────────────────────────────────────

@dataclass
class ChannelState:
    """What this device knows about its channel on one ROM file."""
    channel_id: Optional[str] = None
    label: str = DEFAULT_CHANNEL
    held_snapshot_id: Optional[int] = None
    held_content_hash: Optional[str] = None
    held_identity_hash: Optional[str] = None
    by_choice: bool = False

    def held_point(self):
        if self.held_snapshot_id is None:
            return None
        save = None
        if self.held_identity_hash:
            save = SaveHashes(self.held_content_hash or self.held_identity_hash,
                              self.held_identity_hash)
        return SnapshotPoint(self.held_snapshot_id, save, self.by_choice)


class ChannelStore:
    """ChannelState per rom_file_id, persisted as one JSON file.

    The server also records what each device holds, but keeping it locally
    is what lets the decide table run offline and tell "I played on an old
    save" from "someone else pushed".
    """

    def __init__(self, path):
        self.path = Path(path)
        self._states = {}
        self._load()

    def _load(self):
        try:
            if self.path.exists():
                raw = json.loads(self.path.read_text()) or {}
                fields = ChannelState.__dataclass_fields__
                self._states = {
                    int(k): ChannelState(**{f: v for f, v in s.items() if f in fields})
                    for k, s in raw.items()
                }
        except Exception as e:
            logging.debug(f"Could not load save channel state: {e}")
            self._states = {}

    def _save(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(self.path.suffix + '.tmp')
            tmp.write_text(json.dumps(
                {str(k): s.__dict__ for k, s in self._states.items()}, indent=2))
            tmp.replace(self.path)
        except Exception as e:
            logging.debug(f"Could not persist save channel state: {e}")

    def get(self, rom_file_id):
        return self._states.get(int(rom_file_id))

    def hold(self, rom_file_id, channel_id, label, snapshot, by_choice=False):
        """Record that this device now plays from ``snapshot`` (a snapshot
        dict as the server returns it)."""
        save = (snapshot or {}).get('save') or {}
        self._states[int(rom_file_id)] = ChannelState(
            channel_id=channel_id,
            label=label,
            held_snapshot_id=(snapshot or {}).get('id'),
            held_content_hash=save.get('content_hash'),
            held_identity_hash=save.get('identity_hash') or save.get('content_hash'),
            by_choice=by_choice,
        )
        self._save()

    def forget(self, rom_file_id):
        if self._states.pop(int(rom_file_id), None) is not None:
            self._save()


def snapshot_point(snapshot):
    """A server snapshot dict as a SnapshotPoint, or None."""
    if not snapshot or snapshot.get('id') is None:
        return None
    save = snapshot.get('save')
    hashes = None
    if save and (save.get('identity_hash') or save.get('content_hash')):
        hashes = SaveHashes(save.get('content_hash') or save['identity_hash'],
                            save.get('identity_hash') or save['content_hash'])
    return SnapshotPoint(int(snapshot['id']), hashes)


def pick_channel(channels, state):
    """The channel this device syncs a file through, or None to create one.

    The one it already follows, else the one labelled 'default' (where
    legacy autosave uploads land), else the most recently pushed.
    """
    channels = list(channels or [])
    if state and state.channel_id:
        for c in channels:
            if c.get('id') == state.channel_id:
                return c
    for c in channels:
        if c.get('label') == DEFAULT_CHANNEL and c.get('is_own', True):
            return c
    own = [c for c in channels if c.get('is_own', True)]
    if not own:
        return None
    return max(own, key=lambda c: ((c.get('current') or {}).get('created_at') or ''))


# ── HTTP ──────────────────────────────────────────────────────────────────

@dataclass
class PushResult:
    """Outcome of POST /api/snapshots.

    kind: 'written' (201 new current), 'unchanged' (200), 'branched' (409,
    another device moved the channel; snapshot is the branch, current the
    server's), 'hardcore_downgrade', 'offline' or 'failed'.
    """
    kind: str
    snapshot: Optional[dict] = None
    current: Optional[dict] = None
    reason: str = ''
    status: Optional[int] = None


@dataclass
class SaveUnit:
    """A save as it travels in a push."""
    data: bytes
    name: str
    content_hash: str
    identity_hash: str
    shape: str = 'SINGLE'
    format: str = 'native'


class SnapshotApi:
    """The channel and snapshot routes, over a RomMClient's session.

    The server takes the device from a client token bound to one. A password
    session has none, so ``device_id`` names Ludo's registered device on the
    routes that hold or push.
    """

    PARENT_NOT_FOUND = 'Parent snapshot not found'

    def __init__(self, client, device_id=None):
        self.client = client
        self.device_id = device_id

    def _device_params(self):
        return [('device_id', self.device_id)] if self.device_id else []

    def _url(self, path):
        return urljoin(self.client.base_url, path)

    def list_channels(self, rom_file_ids):
        """Your channels on these files, each with its current snapshot.
        None on failure, so callers can tell "none" from "couldn't ask"."""
        try:
            r = self.client.session.get(
                self._url('/api/channels'),
                params=[('rom_file_id', int(i)) for i in rom_file_ids]
                + self._device_params(),
                timeout=20)
            if r.status_code == 200:
                return r.json() or []
            logging.warning(f"List channels failed: HTTP {r.status_code}: {r.text[:200]}")
        except Exception as e:
            logging.warning(f"Error listing channels: {e}")
        return None

    def get_snapshot(self, snapshot_id, hold=False):
        """One snapshot. ``hold`` tells the server this device now plays
        from it; a plain fetch for browsing history holds nothing."""
        try:
            r = self.client.session.get(
                self._url(f'/api/snapshots/{int(snapshot_id)}'),
                params=[('hold', 'true')] + self._device_params() if hold else None,
                timeout=20)
            if r.status_code == 200:
                return r.json()
            logging.warning(f"Get snapshot {snapshot_id} failed: HTTP {r.status_code}")
        except Exception as e:
            logging.warning(f"Error fetching snapshot {snapshot_id}: {e}")
        return None

    def push(self, manifest, save=None, screenshot=None, server_has_save=False):
        """POST /api/snapshots, retrying once the two ways the design allows:
        a 400 naming parts the server lacks is re-sent with them, and a 404
        for a pruned parent is re-sent without the parent."""
        result, retry = self._send(manifest, None if server_has_save else save, screenshot)
        if retry is None:
            return result
        missing, retry_manifest = retry
        send_save = save if (not server_has_save or 'save' in missing) else None
        result, _ = self._send(retry_manifest or manifest, send_save, screenshot)
        return result

    def _send(self, manifest, save, screenshot):
        files = [('manifest', (None, json.dumps(manifest), 'application/json'))]
        if save is not None:
            files.append(('save', (save.name, save.data, 'application/octet-stream')))
        if screenshot is not None and Path(screenshot).is_file():
            files.append(('save_screenshot', (Path(screenshot).name,
                                              Path(screenshot).read_bytes(), 'image/png')))
        try:
            r = self.client.session.post(self._url('/api/snapshots'), files=files,
                                         params=self._device_params(), timeout=120)
        except Exception as e:
            return PushResult('offline', reason=str(e)), None
        return self._read_push(r.status_code, _json_or_none(r), r.text, manifest)

    @classmethod
    def _read_push(cls, status, body, text, manifest):
        """(PushResult, retry) for one response; retry is (missing parts,
        replacement manifest or None) when the push should be re-sent."""
        if status == 201:
            return PushResult('written', snapshot=body, status=status), None
        if status == 200:
            return PushResult('unchanged', snapshot=body, status=status), None
        body = body if isinstance(body, dict) else {}
        detail = body.get('detail')
        if status == 409:
            if body.get('hardcore_downgrade') or (isinstance(detail, dict) and detail.get('hardcore_downgrade')):
                return PushResult('hardcore_downgrade', status=status), None
            return PushResult('branched', snapshot=body.get('branch'),
                              current=body.get('current'),
                              reason=body.get('reason') or '', status=status), None
        if status == 400 and body.get('missing'):
            return (PushResult('failed', reason=f"missing {body['missing']}", status=status),
                    (set(body['missing']), None))
        if status == 404 and detail == cls.PARENT_NOT_FOUND and 'parent_snapshot_id' in manifest:
            retry = {k: v for k, v in manifest.items() if k != 'parent_snapshot_id'}
            return PushResult('failed', reason=detail, status=status), (set(), retry)
        return PushResult('failed', reason=f"HTTP {status}: {(text or '')[:200]}",
                          status=status), None


def _json_or_none(response):
    try:
        return response.json()
    except Exception:
        return None


def build_manifest(rom_file_id, channel, action, save=None, emulator=None,
                   core=None, is_hardcore=False, label=None,
                   approve_hardcore_downgrade=False):
    """The ``manifest`` part for a push decided by :func:`decide`.

    channel: the server's channel dict, or None to create one named ``label``.
    States are left out, so each snapshot carries its parent's bank; Ludo's
    states keep their legacy path for now, as Argosy's do.
    """
    m = {'rom_file_id': int(rom_file_id), 'is_hardcore': bool(is_hardcore)}
    if channel and channel.get('id'):
        m['channel_id'] = channel['id']
    else:
        m['label'] = label or DEFAULT_CHANNEL
    m['expected_current_id'] = action.expected_current_id
    if action.parent_id is not None:
        m['parent_snapshot_id'] = action.parent_id
    if save is not None:
        m['save'] = {'hash': save.content_hash, 'shape': save.shape, 'format': save.format}
    if emulator:
        m['emulator'] = emulator
    if core:
        m['core'] = core
    if approve_hardcore_downgrade:
        m['approve_hardcore_downgrade'] = True
    return m
