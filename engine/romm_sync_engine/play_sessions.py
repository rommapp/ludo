"""Play sessions: tracked here, reported to RomM, pulled back from the other devices.

RomM records how long each device played each ROM (POST /api/play-sessions)
and shows what is being played right now (POST /api/activity/heartbeat, held
by the server for 90 seconds). It shows neither back to the user; Ludo's Play
time page does. Argosy ships the reference client (data/emulator/
PlaySessionTracker.kt, data/social/uploader/); this follows it:

  * a session is written to disk while it runs, so a Ludo that dies under a
    running game still records it, ended at the last moment it was seen;
  * time the machine spent suspended is not play (Argosy: screen off);
  * sessions under MIN_ACTIVE_SECONDS are not kept;
  * every session stays on disk after RomM accepts it, and the account's
    other devices' sessions are pulled down, so totals cover all devices;
  * deleting a game's play records drops them here and sets a cutoff, so the
    pull does not bring the deleted sessions back.

Measured against RomM 5.4.1 (see the tests for the cases):

  * ONE row whose end is not after its start fails the whole batch with 422,
    so such rows never get queued;
  * an unknown rom_id is not refused: the row is stored with no ROM, so only
    ids from the library are ever sent;
  * a row is a duplicate when its device already has one starting at the same
    instant, which is what makes resending a batch safe. The same instant is
    also how a pulled session is matched to one already held;
  * results come back out of order, keyed by index, with 201 when anything
    was created;
  * GET /api/play-sessions with a device token needs device_id, or it is 403.

A server without the routes (before 4.9) answers 404; sessions then wait.

This module doesn't need the rest of the engine. AutoSyncManager owns one
PlaySessions and feeds it launches and emulator up/down observations.
"""

import json
import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

BATCH_SIZE = 100
PULL_PAGE = 200
# A row the server refuses on its own (status 'error') is retried this many
# times, then left unsent for good: whatever is wrong with it will not fix itself.
MAX_ATTEMPTS = 5
# Bound on the store, oldest dropped first.
MAX_SESSIONS = 50000
# Argosy's MIN_PLAY_SECONDS_FOR_COMPLETION: a boot that crashed or a launch
# quit at once is not a session.
MIN_ACTIVE_SECONDS = 20
# How long after a launch the emulator has to show up for the session to
# count. Covers the pre-launch save sync and a slow emulator start.
LAUNCH_WINDOW = 180.0
# Without a suspend clock, a gap this long between two once-a-second
# observations is taken as the machine having slept.
GAP_AS_SUSPEND = 15.0
# How often a running session's progress is written to disk.
PERSIST_EVERY = 30.0
HEARTBEAT_INTERVAL = 30.0
HEARTBEAT_RETRY = 10.0
HEARTBEAT_MAX_RETRIES = 6
# Other devices' sessions are pulled at most this often outside a manual
# refresh (Argosy's PLAY_SESSION_PULL_INTERVAL).
PULL_INTERVAL = 15 * 60
DEVICE_MISSING = 'not found for this user'


def iso_utc(ts):
    """Epoch seconds as the second-precision UTC timestamp RomM stores."""
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse_ts(value):
    """A RomM timestamp as epoch seconds. RomM writes naive UTC."""
    dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def suspended_seconds():
    """Seconds this boot has spent suspended, or None where it can't be told.

    CLOCK_BOOTTIME counts suspend and CLOCK_MONOTONIC doesn't, so their
    difference grows by exactly the time asleep."""
    try:
        return time.clock_gettime(time.CLOCK_BOOTTIME) - time.clock_gettime(time.CLOCK_MONOTONIC)
    except (AttributeError, OSError):
        return None


def boot_id():
    try:
        return Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    except OSError:
        return None


def _key(row):
    return (row.get('device_id'), int(row['start']))


class SessionStore:
    """Every session this device knows of, plus the bookkeeping around them,
    as one JSON file.

    A row: rom_id (None when RomM had no ROM for it), start/end (epoch s),
    active_ms, device_id, origin ('local' | 'remote'), sent, attempts.
    """

    def __init__(self, path):
        self.path = Path(path)
        self._lock = threading.RLock()
        self.sessions = []
        self.cutoffs = {}       # str(rom_id) -> epoch: records before it were deleted
        self.devices = {}       # device_id -> {'name', 'platform'}
        self.meta = {}          # last_upload, last_refresh, live
        self._load()

    def _load(self):
        try:
            if not self.path.exists():
                return
            raw = json.loads(self.path.read_text())
        except Exception as e:
            logging.debug(f"Could not load play sessions: {e}")
            return
        if isinstance(raw, list):
            # The first format: a bare upload queue. Every row in it was a
            # local session RomM had not accepted yet.
            raw = {'sessions': [dict(r, origin='local', sent=False,
                                     active_ms=r.get('active_ms', (r['end'] - r['start']) * 1000))
                                for r in raw if isinstance(r, dict) and 'start' in r]}
        if not isinstance(raw, dict):
            return
        self.sessions = [r for r in raw.get('sessions') or [] if isinstance(r, dict) and 'start' in r]
        self.cutoffs = raw.get('cutoffs') or {}
        self.devices = raw.get('devices') or {}
        self.meta = raw.get('meta') or {}

    def save(self):
        with self._lock:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_suffix(self.path.suffix + '.tmp')
                tmp.write_text(json.dumps({
                    'version': 2, 'sessions': self.sessions, 'cutoffs': self.cutoffs,
                    'devices': self.devices, 'meta': self.meta}, separators=(',', ':')))
                tmp.replace(self.path)
            except Exception as e:
                logging.debug(f"Could not persist play sessions: {e}")

    def _blocked(self, rom_id, start):
        cut = self.cutoffs.get(str(rom_id))
        return cut is not None and start < cut

    def add_local(self, rom_id, start, end, active_ms, device_id):
        """Keep one session played here. False when it is not one to keep."""
        start, end = int(start), int(end)
        active_ms = int(min(active_ms, (end - start) * 1000))
        if not rom_id or int(rom_id) <= 0 or end <= start or not device_id:
            return False
        if active_ms < MIN_ACTIVE_SECONDS * 1000:
            return False
        row = {'rom_id': int(rom_id), 'start': start, 'end': end, 'active_ms': active_ms,
               'device_id': str(device_id), 'origin': 'local', 'sent': False, 'attempts': 0}
        with self._lock:
            if any(_key(r) == _key(row) for r in self.sessions):
                return False
            self.sessions.append(row)
            del self.sessions[:-MAX_SESSIONS]
            self.save()
        return True

    def pending(self, device_id):
        """Rows played on this device that RomM has not accepted, oldest first.
        A session belongs to the device it was played on: after a re-pair the
        old ones stay behind rather than being reported as another device's."""
        with self._lock:
            return [dict(r) for r in self.sessions
                    if r.get('origin') == 'local' and not r.get('sent')
                    and r.get('device_id') == device_id and r.get('attempts', 0) < MAX_ATTEMPTS
                    and not self._blocked(r['rom_id'], r['start'])]

    def settle(self, done, refused):
        """Mark acknowledged rows sent; count a refusal against the others."""
        done = {_key(r) for r in done}
        refused = {_key(r) for r in refused}
        with self._lock:
            for r in self.sessions:
                k = _key(r)
                if k in done:
                    r['sent'] = True
                elif k in refused:
                    r['attempts'] = r.get('attempts', 0) + 1
                    if r['attempts'] >= MAX_ATTEMPTS:
                        logging.info(f"Play session rom={r['rom_id']} start={iso_utc(r['start'])}: "
                                     f"refused {r['attempts']} times, no longer sent")
            self.save()

    def merge_remote(self, device_id, rows):
        """Add the server's sessions for one device that are not held yet.
        A local row the server turns out to hold is marked sent. Returns how
        many were added."""
        added = 0
        with self._lock:
            held = {_key(r): r for r in self.sessions}
            for s in rows:
                try:
                    start, end = parse_ts(s['start_time']), parse_ts(s['end_time'])
                except (KeyError, ValueError, TypeError):
                    continue
                rom_id = s.get('rom_id')
                if rom_id is not None and self._blocked(rom_id, start):
                    continue
                k = (device_id, start)
                mine = held.get(k)
                if mine is not None:
                    mine['sent'] = True
                    continue
                dur = s.get('duration_ms')
                row = {'rom_id': rom_id, 'start': start, 'end': end,
                       'active_ms': int(dur if dur is not None else (end - start) * 1000),
                       'device_id': device_id, 'origin': 'remote', 'sent': True}
                self.sessions.append(row)
                held[k] = row
                added += 1
            del self.sessions[:-MAX_SESSIONS]
            self.save()
        return added

    def latest_start(self, device_id):
        with self._lock:
            starts = [r['start'] for r in self.sessions if r.get('device_id') == device_id]
        return max(starts) if starts else None

    def delete_game(self, rom_id, now=None):
        """Forget every session of rom_id, here and on every pull after."""
        now = int(now or time.time())
        with self._lock:
            before = len(self.sessions)
            self.sessions = [r for r in self.sessions if r.get('rom_id') != int(rom_id)]
            self.cutoffs[str(int(rom_id))] = now
            self.save()
        return before - len(self.sessions)

    def snapshot(self):
        with self._lock:
            return ([dict(r) for r in self.sessions], dict(self.devices), dict(self.meta))

    def set_meta(self, **kw):
        with self._lock:
            self.meta.update(kw)
            self.save()

    def __len__(self):
        with self._lock:
            return len(self.sessions)


def entry(row):
    """A stored row as a PlaySessionEntry."""
    return {'rom_id': row['rom_id'], 'save_slot': None,
            'start_time': iso_utc(row['start']), 'end_time': iso_utc(row['end']),
            'duration_ms': int(row.get('active_ms', (row['end'] - row['start']) * 1000))}


def upload(client, device_id, store):
    """Send this device's unsent sessions. Returns (sent, duplicates, failed,
    stopped_by): stopped_by names why the run ended early, else None."""
    rows = store.pending(device_id)
    sent = duplicates = failed = 0
    for i in range(0, len(rows), BATCH_SIZE):
        batch = rows[i:i + BATCH_SIZE]
        try:
            r = client.session.post(
                urljoin(client.base_url, '/api/play-sessions'),
                json={'device_id': device_id, 'sessions': [entry(x) for x in batch]},
                timeout=30)
        except Exception as e:
            return sent, duplicates, failed, f'network: {e}'
        if r.status_code == 404:
            return sent, duplicates, failed, 'not supported by this server'
        # 201 when anything was created.
        if not 200 <= r.status_code < 300:
            logging.warning(f"Play session upload: HTTP {r.status_code}: {r.text[:300]}")
            return sent, duplicates, failed, f'HTTP {r.status_code}'
        try:
            results = (r.json() or {}).get('results') or []
        except ValueError:
            return sent, duplicates, failed, 'unreadable reply'
        done, answered = [], set()
        for res in results:
            idx = res.get('index')
            if not isinstance(idx, int) or not 0 <= idx < len(batch):
                continue
            answered.add(idx)
            if res.get('status') == 'created':
                sent += 1
                done.append(batch[idx])
            elif res.get('status') == 'duplicate':
                duplicates += 1
                done.append(batch[idx])
            else:
                logging.debug(f"Play session refused: {res.get('status')} {res.get('detail')}")
        refused = [b for n, b in enumerate(batch) if n in answered and b not in done]
        failed += len(batch) - len(done)
        store.settle(done, refused)
    return sent, duplicates, failed, None


def pull(client, store, this_device=None):
    """Copy down the sessions RomM holds for every device of the account,
    this one included (a reinstall starts with an empty store). Returns
    (added, devices, stopped_by).

    Listing the devices needs devices.read. A token without it (paired
    before Ludo asked for it) still pulls the devices already known: this
    one, and any named by an earlier pull or by sessions held."""
    try:
        r = client.session.get(urljoin(client.base_url, '/api/devices'), timeout=20)
    except Exception as e:
        return 0, 0, f'network: {e}'
    if r.status_code == 200:
        try:
            devices = r.json()
        except ValueError:
            return 0, 0, 'unreadable reply'
        if isinstance(devices, dict):
            devices = devices.get('items') or []
        with store._lock:
            for d in devices:
                if d.get('id'):
                    store.devices[d['id']] = {'name': d.get('name') or d.get('hostname') or '',
                                              'platform': d.get('platform') or ''}
    elif r.status_code in (401, 403):
        with store._lock:
            known = set(store.devices) | {s.get('device_id') for s in store.sessions}
        known.add(this_device)
        devices = [{'id': d} for d in sorted(x for x in known if x)]
        logging.info(f"Play sessions pull: cannot list devices (HTTP {r.status_code}), "
                     f"pulling the {len(devices)} known")
    else:
        return 0, 0, f'devices: HTTP {r.status_code}'
    added = done = 0
    for d in devices:
        device_id = d.get('id')
        if not device_id:
            continue
        since = store.latest_start(device_id)
        offset = 0
        while True:
            params = {'device_id': device_id, 'limit': PULL_PAGE, 'offset': offset}
            if since is not None:
                params['start_after'] = iso_utc(since - 1)
            try:
                resp = client.session.get(urljoin(client.base_url, '/api/play-sessions'),
                                          params=params, timeout=30)
            except Exception as e:
                return added, done, f'network: {e}'
            if resp.status_code == 404:
                return added, done, 'not supported by this server'
            if resp.status_code in (401, 403):
                # Another device's sessions need devices.read; this token
                # only reads its own. Skip it rather than stop the pull.
                logging.info(f"Play sessions pull: device {device_id} not readable "
                             f"(HTTP {resp.status_code}), skipped")
                break
            if resp.status_code != 200:
                return added, done, f'sessions: HTTP {resp.status_code}'
            try:
                page = resp.json() or []
            except ValueError:
                return added, done, 'unreadable reply'
            added += store.merge_remote(device_id, page)
            if len(page) < PULL_PAGE:
                break
            offset += len(page)
        if resp.status_code == 200:
            done += 1
    store.save()
    return added, done, None


class SessionTracker:
    """Turns "Ludo launched rom X" plus once-a-second "is an emulator up" into
    sessions.

    A session starts on the first observation of the emulator after a launch,
    so the pre-launch sync is not counted as play, and ends on the first
    observation without it. Only a Ludo launch opens one: an emulator the
    player started by hand is not attributable to a ROM. Time the machine
    spent suspended is counted as paused, not played.
    """

    def __init__(self, clock=time.time, suspend_clock=suspended_seconds):
        self._clock = clock
        self._suspend_clock = suspend_clock
        self._lock = threading.Lock()
        self._launch = None   # (rom_id, launched_at), until the emulator shows
        self._live = None     # {'rom_id', 'start', 'last_seen', 'paused', 'susp'}

    def _advance(self, now):
        """Fold the time since the last observation into the live session."""
        live = self._live
        susp = self._suspend_clock()
        if susp is not None and live.get('susp') is not None:
            live['paused'] += max(0.0, susp - live['susp'])
        elif now - live['last_seen'] > GAP_AS_SUSPEND:
            live['paused'] += now - live['last_seen']
        live['susp'] = susp
        live['last_seen'] = now

    def _close(self, end):
        live, self._live = self._live, None
        active_ms = max(0, int((end - live['start'] - live['paused']) * 1000))
        return (live['rom_id'], live['start'], end, active_ms)

    def launched(self, rom_id):
        """A launch of rom_id. Returns a session it cut short (a game started
        while another was still running), else None."""
        with self._lock:
            now = self._clock()
            ended = None
            if self._live and self._live['rom_id'] != rom_id:
                self._advance(now)
                ended = self._close(now)
            if not self._live:
                self._launch = (rom_id, now)
            return ended

    def observe(self, running):
        """One look at the emulator. Returns ('start', rom_id),
        ('end', (rom_id, start, end, active_ms)) or None."""
        with self._lock:
            now = self._clock()
            if running:
                if self._live is not None:
                    self._advance(now)
                    return None
                if self._launch:
                    rom_id, at = self._launch
                    self._launch = None
                    if now - at <= LAUNCH_WINDOW:
                        self._live = {'rom_id': rom_id, 'start': now, 'last_seen': now,
                                      'paused': 0.0, 'susp': self._suspend_clock()}
                        return ('start', rom_id)
                return None
            if self._launch and now - self._launch[1] > LAUNCH_WINDOW:
                self._launch = None
            if self._live:
                self._advance(now)
                return ('end', self._close(now))
            return None

    def live_state(self):
        """The running session as it should be written to disk, or None."""
        with self._lock:
            if not self._live:
                return None
            return dict(self._live, boot=boot_id())

    def resume(self, saved, running):
        """Take back a session written by a Ludo that is no longer running.

        Same boot and the emulator still up: the session carries on, with any
        suspend in between counted as paused. Otherwise it ended when it was
        last seen. Returns the ended session, or None if it carries on."""
        with self._lock:
            live = {'rom_id': saved['rom_id'], 'start': saved['start'],
                    'last_seen': saved['last_seen'], 'paused': saved.get('paused', 0.0),
                    'susp': saved.get('susp')}
            same_boot = saved.get('boot') and saved.get('boot') == boot_id()
            if running and same_boot:
                self._live = live
                self._advance(self._clock())
                return None
            self._live = live
            return self._close(live['last_seen'])

    @property
    def playing(self):
        with self._lock:
            return self._live['rom_id'] if self._live else None


class Heartbeat:
    """Tells RomM which ROM this device is playing, for as long as it is."""

    def __init__(self, client, device_id, rom_id, on_device_missing=None,
                 interval=HEARTBEAT_INTERVAL, retry=HEARTBEAT_RETRY):
        self.client = client
        self.device_id = device_id
        self.rom_id = rom_id
        self.on_device_missing = on_device_missing
        self.interval = interval
        self.retry = retry
        self._stop = threading.Event()
        self._thread = None
        self._reregistered = False

    def _url(self):
        return urljoin(self.client.base_url, '/api/activity/heartbeat')

    def _beat(self):
        try:
            r = self.client.session.post(
                self._url(), json={'rom_id': self.rom_id, 'device_id': self.device_id},
                timeout=10)
            if r.status_code == 200:
                return True
            logging.debug(f"Heartbeat rejected: HTTP {r.status_code}: {r.text[:200]}")
            if r.status_code == 404:
                if DEVICE_MISSING in r.text:
                    # The device was deleted on the server. Register it again,
                    # once per session (Argosy does the same).
                    if self.on_device_missing and not self._reregistered:
                        self._reregistered = True
                        new_id = self.on_device_missing()
                        if new_id:
                            self.device_id = new_id
                else:
                    # Before 4.9 the route does not exist: nothing to retry.
                    self._stop.set()
        except Exception as e:
            logging.debug(f"Heartbeat failed: {e}")
        return False

    def _run(self):
        retries = HEARTBEAT_MAX_RETRIES
        while not self._stop.is_set():
            if self._beat():
                retries = HEARTBEAT_MAX_RETRIES
                wait = self.interval
            elif retries:
                retries -= 1
                wait = self.retry
            else:
                logging.info("Heartbeat stopped for this session after repeated failures")
                return
            self._stop.wait(wait)

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True,
                                        name='romm-heartbeat')
        self._thread.start()

    def stop(self):
        """Stop beating and clear the live state now rather than in 90s."""
        self._stop.set()
        try:
            self.client.session.delete(self._url(),
                                       params={'device_id': self.device_id}, timeout=10)
        except Exception as e:
            logging.debug(f"Heartbeat clear failed: {e}")


class PlaySessions:
    """The pieces wired together, for AutoSyncManager.

    client_fn and device_fn are asked on every use: the client is replaced
    on reconnect and the device id only exists once registered.
    on_device_missing registers the device again and returns its new id.
    """

    def __init__(self, path, client_fn, device_fn, clock=time.time,
                 suspend_clock=suspended_seconds, on_device_missing=None):
        self.store = SessionStore(path)
        self.tracker = SessionTracker(clock, suspend_clock)
        self._clock = clock
        self._client_fn = client_fn
        self._device_fn = device_fn
        self.on_device_missing = on_device_missing
        self._heartbeat = None
        self._sync_lock = threading.Lock()
        self._last_persist = 0.0
        self._recovered = False

    # Kept for callers of the first version.
    @property
    def queue(self):
        return self.store

    def _connected(self):
        client = self._client_fn()
        if client is None or not getattr(client, 'authenticated', False):
            return None
        return client

    def launched(self, rom_id):
        ended = self.tracker.launched(rom_id)
        if ended:
            self._ended(*ended)

    def observe(self, running):
        if not self._recovered:
            self._recovered = True
            self._recover(running)
        event = self.tracker.observe(running)
        if event:
            kind, what = event
            if kind == 'start':
                self._persist_live(force=True)
                self._start_heartbeat(what)
            else:
                self._ended(*what)
        elif self.tracker.playing is not None:
            self._persist_live()

    def _recover(self, running):
        saved = self.store.meta.get('live')
        if not saved:
            return
        ended = self.tracker.resume(saved, running)
        if ended:
            logging.info(f"Play session recovered from an earlier run: rom {ended[0]}")
            self._ended(*ended)
        else:
            logging.info(f"Play session carried over from an earlier run: rom {saved['rom_id']}")
            self._start_heartbeat(saved['rom_id'])

    def _persist_live(self, force=False):
        now = self._clock()
        if not force and now - self._last_persist < PERSIST_EVERY:
            return
        self._last_persist = now
        self.store.set_meta(live=self.tracker.live_state())

    def _start_heartbeat(self, rom_id):
        self._stop_heartbeat()
        client, device_id = self._connected(), self._device_fn()
        if client and device_id:
            self._heartbeat = Heartbeat(client, device_id, rom_id,
                                        on_device_missing=self.on_device_missing,
                                        interval=HEARTBEAT_INTERVAL, retry=HEARTBEAT_RETRY)
            self._heartbeat.start()

    def _stop_heartbeat(self):
        hb, self._heartbeat = self._heartbeat, None
        if hb:
            threading.Thread(target=hb.stop, daemon=True).start()

    def _ended(self, rom_id, start, end, active_ms):
        self._stop_heartbeat()
        self.store.set_meta(live=None)
        if self.store.add_local(rom_id, start, end, active_ms, self._device_fn()):
            logging.info(f"Play session: rom {rom_id}, {active_ms // 1000}s played "
                         f"of {int(end - start)}s")
            self.sync_async()
        else:
            logging.info(f"Play session not kept: rom {rom_id}, {active_ms // 1000}s played")

    def sync_async(self):
        threading.Thread(target=self.sync_now, daemon=True,
                         name='romm-play-sessions').start()

    # Kept for callers of the first version.
    upload_async = sync_async

    def upload_now(self):
        """Send what is unsent. None when offline or already running."""
        client, device_id = self._connected(), self._device_fn()
        if not client or not device_id:
            return None
        if not self._sync_lock.acquire(blocking=False):
            return None
        try:
            return self._upload(client, device_id)
        finally:
            self._sync_lock.release()

    def _upload(self, client, device_id):
        if not self.store.pending(device_id):
            return 0, 0, 0, None
        sent, dup, failed, stopped = upload(client, device_id, self.store)
        if stopped is None:
            self.store.set_meta(last_upload=int(self._clock()))
        logging.info(f"Play sessions: sent={sent} duplicates={dup} failed={failed}"
                     + (f" stopped: {stopped}" if stopped else ''))
        return sent, dup, failed, stopped

    def refresh_now(self):
        """Pull every device's sessions. None when offline or already running."""
        client = self._connected()
        if not client:
            return None
        if not self._sync_lock.acquire(blocking=False):
            return None
        try:
            return self._pull(client)
        finally:
            self._sync_lock.release()

    def _pull(self, client):
        added, devices, stopped = pull(client, self.store, self._device_fn())
        if stopped is None:
            self.store.set_meta(last_refresh=int(self._clock()))
        logging.info(f"Play sessions pulled: added={added} devices={devices}"
                     + (f" stopped: {stopped}" if stopped else ''))
        return added, devices, stopped

    def sync_now(self):
        """Upload, then pull (Argosy's uploadThenPull). None when offline or
        already running."""
        client, device_id = self._connected(), self._device_fn()
        if not client:
            return None
        if not self._sync_lock.acquire(blocking=False):
            return None
        try:
            up = self._upload(client, device_id) if device_id else None
            if up and up[3]:
                return up, None
            return up, self._pull(client)
        finally:
            self._sync_lock.release()

    def pull_due(self):
        """Whether the last pull is older than PULL_INTERVAL."""
        last = self.store.meta.get('last_refresh') or 0
        return self._clock() - last >= PULL_INTERVAL

    def sync_if_due(self):
        """Upload, then pull, when the last pull is old enough: Argosy pulls
        on connect, when Home shows and before a recap, each at most every
        PULL_INTERVAL. Runs in the caller's thread; None when not due, offline
        or already running."""
        if not self.pull_due():
            return None
        return self.sync_now()

    def delete_game(self, rom_id):
        return self.store.delete_game(rom_id, self._clock())

    def recap_due(self, has_sessions, now=None):
        """The month ('YYYY-MM') Home's recap banner offers, or None: last
        month, only when it had play. The first check only sets the baseline, so
        a new install doesn't offer a recap of history it just pulled.
        has_sessions(month) tells whether a month had play. The banner stays
        until recap_seen() — opened or dismissed."""
        if self.store.meta.get('recap_auto') is False:
            return None
        now = now or self._clock()
        this = time.strftime('%Y-%m', time.localtime(now))
        y, m = (int(x) for x in this.split('-'))
        last = f'{y - (m == 1):04d}-{(m - 2) % 12 + 1:02d}'
        shown = self.store.meta.get('recap_shown')
        if not shown:
            self.store.set_meta(recap_shown=last)
            return None
        if shown >= last or not has_sessions(last):
            return None
        return last

    def recap_seen(self, month):
        """The banner for this month was opened or dismissed: don't offer it again."""
        if month > (self.store.meta.get('recap_shown') or ''):
            self.store.set_meta(recap_shown=month)
