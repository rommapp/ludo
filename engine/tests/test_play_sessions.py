"""Play sessions are tracked, reported to RomM and pulled back the way the
server takes them, and the Play time figures add up.

Run with `python3 engine/tests/test_play_sessions.py`.

The fake server below answers like RomM 5.4.1 did when probed live: a row
that doesn't end after it starts fails the whole batch with 422, results come
back out of order with 201 when anything was created, and a resent row is a
'duplicate' with no id. Sessions are listed per device, paged by offset.

Asserted:

  * the store refuses rows RomM would reject and sessions under 20s played,
    survives a reload, and reads the first (bare queue) format;
  * created and duplicate rows are marked sent and stay held, refused ones
    stay unsent and stop being sent after MAX_ATTEMPTS, in any result order;
  * a 404 (server before 4.9), an HTTP error or a dropped connection stops
    the run and keeps everything;
  * batches are capped at BATCH_SIZE, and only this device's rows are sent;
  * the pull adds every device's sessions once, pages, marks a held local
    row sent instead of doubling it, and respects a deleted game's cutoff;
  * the tracker counts from the emulator showing up, not from the launch;
    ignores an emulator Ludo didn't launch; splits on a game switch; and
    subtracts suspended time, from the suspend clock or from a long gap;
  * a session left on disk by a Ludo that died is carried on when the
    emulator is still up on the same boot, and ended when last seen otherwise;
  * PlaySessions heartbeats while playing, clears it on exit, uploads, pulls,
    and registers the device again once when RomM no longer knows it;
  * the play watcher records play while save sync is not running (offline)
    and stands aside while the sync monitor runs;
  * play_stats: totals, calendar days split at midnight, streaks, shares,
    the hour-of-week curve, facts, the RomM counts and one game's figures.
"""
import json
import sys
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import play_sessions as ps  # noqa: E402
from romm_sync_engine import play_stats  # noqa: E402

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


class Resp:
    def __init__(self, status, body=None, text=''):
        self.status_code = status
        self._body = body
        self.text = text

    def json(self):
        return self._body


class FakeServer:
    """Enough of RomM's play-session, device and activity routes."""

    def __init__(self):
        self.stored = {}            # (device, start) -> row
        self.posts = []             # batch sizes
        self.gets = []              # (device, offset)
        self.devices = [{'id': 'dev', 'name': 'HP800G1'}, {'id': 'deck', 'name': 'Steam Deck'}]
        self.refuse_rom = set()     # rom ids answered 'error'
        self.status = None          # force a status for the whole request
        self.raise_exc = None
        self.beats = []
        self.cleared = []
        self.known_devices = None   # heartbeat: None = every device known
        self.lock = threading.Lock()

    def post(self, url, json=None, timeout=None):
        if self.raise_exc:
            raise self.raise_exc
        if url.endswith('/api/activity/heartbeat'):
            with self.lock:
                self.beats.append(json)
            if self.known_devices is not None and json['device_id'] not in self.known_devices:
                return Resp(404, text=f'Device {json["device_id"]} not found for this user')
            return Resp(200)
        if self.status:
            return Resp(self.status, text='nope')
        sessions = json['sessions']
        for s in sessions:
            if s['end_time'] <= s['start_time']:
                return Resp(422, text='end_time must be after start_time')
        self.posts.append(len(sessions))
        results = []
        for i, s in enumerate(sessions):
            key = (json['device_id'], s['start_time'])
            if s['rom_id'] in self.refuse_rom:
                results.append({'index': i, 'status': 'error', 'detail': 'no'})
            elif key in self.stored:
                results.append({'index': i, 'status': 'duplicate', 'id': None})
            else:
                self.stored[key] = dict(s, device_id=json['device_id'])
                results.append({'index': i, 'status': 'created', 'id': len(self.stored)})
        created = any(r['status'] == 'created' for r in results)
        # Out of order, and 201 when anything was created, like RomM.
        return Resp(201 if created else 200, {'results': results[::-1]})

    def get(self, url, params=None, timeout=None):
        if self.raise_exc:
            raise self.raise_exc
        if url.endswith('/api/devices'):
            if getattr(self, 'devices_status', None):
                return Resp(self.devices_status, text='Forbidden')
            return Resp(200, self.devices)
        if self.status:
            return Resp(self.status, text='nope')
        dev, off, lim = params['device_id'], params['offset'], params['limit']
        if dev in getattr(self, 'unreadable', set()):
            return Resp(403, text='Forbidden')
        self.gets.append((dev, off))
        rows = sorted((r for (d, _), r in self.stored.items() if d == dev),
                      key=lambda r: r['start_time'])
        if params.get('start_after'):
            rows = [r for r in rows if r['start_time'] > params['start_after']]
        # RomM answers naive UTC.
        page = [dict(r, start_time=r['start_time'].rstrip('Z'), end_time=r['end_time'].rstrip('Z'))
                for r in rows[off:off + lim]]
        return Resp(200, page)

    def delete(self, url, params=None, timeout=None):
        with self.lock:
            self.cleared.append(params)
        return Resp(204)


class Client:
    def __init__(self, server):
        self.session = server
        self.base_url = 'http://romm'
        self.authenticated = True


def tmpfile():
    return Path(tempfile.mkdtemp()) / 'play_sessions.json'


def remote(server, device, start, secs, rom=1):
    server.stored[(device, ps.iso_utc(start))] = {
        'rom_id': rom, 'start_time': ps.iso_utc(start), 'end_time': ps.iso_utc(start + secs),
        'duration_ms': secs * 1000, 'device_id': device}


def test_store():
    q = ps.SessionStore(tmpfile())
    check('zero-length refused', q.add_local(5, 100, 100, 0, 'dev'), False)
    check('backwards refused', q.add_local(5, 100, 50, 0, 'dev'), False)
    check('no rom refused', q.add_local(None, 100, 200, 100000, 'dev'), False)
    check('no device refused', q.add_local(5, 100, 200, 100000, None), False)
    check('under 20s played refused', q.add_local(5, 100, 400, 19000, 'dev'), False)
    check('valid accepted', q.add_local(5, 100, 200, 100000, 'dev'), True)
    check('active capped at wall time', q.sessions[0]['active_ms'], 100000)
    check('same start twice refused', q.add_local(5, 100, 300, 60000, 'dev'), False)
    check('survives reload', len(ps.SessionStore(q.path)), 1)
    q.path.write_text('{corrupt')
    check('corrupt reads empty', len(ps.SessionStore(q.path)), 0)
    # The first version's bare queue.
    q.path.write_text(json.dumps([{'rom_id': 7, 'start': 1000, 'end': 1060,
                                   'device_id': 'dev', 'attempts': 0}]))
    old = ps.SessionStore(q.path)
    check('old queue read as unsent local', [(r['rom_id'], r['origin'], r['sent'], r['active_ms'])
                                             for r in old.sessions], [(7, 'local', False, 60000)])
    check('timestamp format', ps.iso_utc(0), '1970-01-01T00:00:00Z')
    check('naive server time read as UTC', ps.parse_ts('1970-01-01T00:01:00'), 60)
    e = ps.entry({'rom_id': 5, 'start': 100, 'end': 160, 'active_ms': 45000})
    check('entry sends played time', e['duration_ms'], 45000)


def test_upload():
    server = FakeServer()
    client = Client(server)
    q = ps.SessionStore(tmpfile())
    q.add_local(1, 1000, 1060, 60000, 'dev')
    q.add_local(2, 2000, 2060, 60000, 'dev')
    q.add_local(3, 3000, 3060, 60000, 'dev')
    q.add_local(4, 4000, 4060, 60000, 'other-device')
    server.refuse_rom = {3}
    check('first run', ps.upload(client, 'dev', q), (2, 0, 1, None))
    check('refused row still pending', [r['rom_id'] for r in q.pending('dev')], [3])
    check('sent rows kept', len(q), 4)
    check('other device untouched', len(q.pending('other-device')), 1)

    # A row the server already holds comes back a duplicate and is sent.
    q.sessions[0]['sent'] = False
    server.refuse_rom = set()
    check('resend', ps.upload(client, 'dev', q), (1, 1, 0, None))
    check('nothing pending', q.pending('dev'), [])

    server.refuse_rom = {9}
    q.add_local(9, 9000, 9060, 60000, 'dev')
    for _ in range(ps.MAX_ATTEMPTS):
        ps.upload(client, 'dev', q)
    check('not sent after max attempts', q.pending('dev'), [])
    check('but still held', any(r['rom_id'] == 9 for r in q.sessions), True)


def test_upload_stops():
    for label, status, exc, why in (
            ('404', 404, None, 'not supported by this server'),
            ('500', 500, None, 'HTTP 500'),
            ('network', None, OSError('down'), 'network: down')):
        server = FakeServer()
        server.status, server.raise_exc = status, exc
        q = ps.SessionStore(tmpfile())
        q.add_local(1, 1000, 1060, 60000, 'dev')
        check(f'{label} stops', ps.upload(Client(server), 'dev', q)[3], why)
        check(f'{label} keeps it pending', len(q.pending('dev')), 1)
        check(f'{label} not counted as attempt', q.pending('dev')[0]['attempts'], 0)


def test_batching():
    server = FakeServer()
    q = ps.SessionStore(tmpfile())
    for i in range(250):
        q.add_local(1, 10_000 + i * 100, 10_050 + i * 100, 50000, 'dev')
    check('all sent', ps.upload(Client(server), 'dev', q), (250, 0, 0, None))
    check('batch sizes', server.posts, [100, 100, 50])


def test_pull():
    server = FakeServer()
    client = Client(server)
    q = ps.SessionStore(tmpfile())
    for i in range(250):
        remote(server, 'deck', 100_000 + i * 1000, 600, rom=1 + i % 3)
    q.add_local(2, 50_000, 50_600, 600_000, 'dev')
    ps.upload(client, 'dev', q)
    remote(server, 'dev', 60_000, 300, rom=3)       # played here, store since lost
    check('pull', ps.pull(client, q), (251, 2, None))
    check('pages of the deck', [o for d, o in server.gets if d == 'deck'], [0, 200])
    check('own uploaded row not doubled', sum(1 for r in q.sessions if r['start'] == 50_000), 1)
    check('device names kept', q.devices['deck']['name'], 'Steam Deck')
    check('pulled rows are remote and sent', {(r['origin'], r['sent']) for r in q.sessions
                                              if r['device_id'] == 'deck'}, {('remote', True)})
    server.gets.clear()
    check('second pull adds nothing', ps.pull(client, q)[0], 0)
    # A local row the server turns out to hold is marked sent, not doubled.
    q.add_local(1, 70_000, 70_100, 100_000, 'dev')
    remote(server, 'dev', 70_000, 100, rom=1)
    ps.pull(client, q)
    check('held local row marked sent', [r['sent'] for r in q.sessions if r['start'] == 70_000], [True])

    # Deleting a game's records keeps them gone across pulls.
    gone = q.delete_game(1, now=10**9)
    check('delete drops the game', gone > 0 and all(r['rom_id'] != 1 for r in q.sessions), True)
    q2 = ps.SessionStore(q.path)
    q2.sessions = []                   # a fresh install: everything is pulled again
    ps.pull(client, q2)
    check('cutoff blocks the pull', any(r['rom_id'] == 1 for r in q2.sessions), False)
    check('other games come back', any(r['rom_id'] == 2 for r in q2.sessions), True)
    q2.add_local(1, 10**9 + 100, 10**9 + 200, 100000, 'dev')
    check('play after the delete counts', [r['rom_id'] for r in q2.pending('dev')], [1])

    # A token without devices.read pulls the devices it already knows.
    server.devices_status = 403
    q3 = ps.SessionStore(tmpfile())
    q3.devices['deck'] = {'name': 'Steam Deck'}
    check('pull without devices.read', ps.pull(client, q3, this_device='dev')[1:], (2, None))
    check('known devices pulled', {r['device_id'] for r in q3.sessions}, {'dev', 'deck'})
    q4 = ps.SessionStore(tmpfile())
    ps.pull(client, q4, this_device='dev')
    check('at least this device', {r['device_id'] for r in q4.sessions}, {'dev'})
    # And another device's sessions it may not read are skipped, not fatal.
    server.unreadable = {'deck'}
    q5 = ps.SessionStore(tmpfile())
    q5.devices['deck'] = {'name': 'Steam Deck'}
    check('unreadable device skipped', ps.pull(client, q5, this_device='dev')[1:], (1, None))
    check('own sessions still pulled', {r['device_id'] for r in q5.sessions}, {'dev'})
    server.unreadable = set()
    server.devices_status = None


class Clock:
    def __init__(self):
        self.t = 1_000_000.0
        self.susp = 0.0

    def __call__(self):
        return self.t


def test_tracker():
    clock = Clock()
    t = ps.SessionTracker(clock, suspend_clock=lambda: clock.susp)
    check('unlaunched emulator ignored', t.observe(True), None)
    check('nothing to end', t.observe(False), None)

    t.launched(7)
    clock.t += 20                      # pre-launch sync, emulator starting
    check('not up yet', t.observe(False), None)
    check('starts when up', t.observe(True), ('start', 7))
    start = clock.t
    check('playing', t.playing, 7)
    clock.t += 600
    check('still up', t.observe(True), None)
    check('ends when gone', t.observe(False), ('end', (7, start, start + 600, 600_000)))
    check('idle', t.playing, None)

    t.launched(8)
    clock.t += ps.LAUNCH_WINDOW + 1
    check('stale launch not attributed', t.observe(True), None)

    # Switching games while the emulator stays up.
    t.observe(False)
    t.launched(1)
    t.observe(True)
    s1 = clock.t
    clock.t += 100
    check('switch ends the first', t.launched(2), (1, s1, s1 + 100, 100_000))
    check('second starts', t.observe(True), ('start', 2))
    check('relaunch same game keeps it', t.launched(2), None)
    check('still the second', t.playing, 2)
    t.observe(False)

    # Suspend: an hour asleep in the middle of 30 minutes played.
    t.launched(3)
    t.observe(True)
    s = clock.t
    for _ in range(10):
        clock.t += 60
        t.observe(True)
    clock.t += 3600
    clock.susp += 3600                 # the kernel says it slept
    t.observe(True)
    for _ in range(20):
        clock.t += 60
        t.observe(True)
    check('suspend not played', t.observe(False), ('end', (3, s, s + 1800 + 3600, 1800_000)))

    # Without a suspend clock, a long gap between observations is the tell.
    t2 = ps.SessionTracker(clock, suspend_clock=lambda: None)
    t2.launched(4)
    t2.observe(True)
    s = clock.t
    clock.t += 1
    t2.observe(True)
    clock.t += 1000
    t2.observe(True)
    clock.t += 1
    check('gap taken as suspend', t2.observe(False), ('end', (4, s, s + 1002, 2000)))


def test_recovery():
    clock = Clock()
    t = ps.SessionTracker(clock, suspend_clock=lambda: clock.susp)
    t.launched(5)
    t.observe(True)
    start = clock.t
    clock.t += 300
    t.observe(True)
    saved = t.live_state()
    # Same boot, the emulator still up: carries on.
    clock.t += 50
    t2 = ps.SessionTracker(clock, suspend_clock=lambda: clock.susp)
    check('carries on', t2.resume(saved, running=True), None)
    check('still playing it', t2.playing, 5)
    clock.t += 10
    check('ends later with all of it', t2.observe(False), ('end', (5, start, start + 360, 360_000)))
    # The emulator is gone: ended when last seen.
    t3 = ps.SessionTracker(clock, suspend_clock=lambda: clock.susp)
    check('ended at last seen', t3.resume(saved, running=False), (5, start, start + 300, 300_000))
    # Another boot: ended when last seen, even if an emulator is up now.
    t4 = ps.SessionTracker(clock, suspend_clock=lambda: clock.susp)
    check('reboot ends it', t4.resume(dict(saved, boot='other'), running=True),
          (5, start, start + 300, 300_000))


def join_threads():
    for th in list(threading.enumerate()):
        if th is not threading.current_thread() and th.daemon:
            th.join(2)


def test_play_sessions():
    server = FakeServer()
    client = Client(server)
    clock = Clock()
    path = tmpfile()
    p = ps.PlaySessions(path, lambda: client, lambda: 'dev', clock=clock,
                        suspend_clock=lambda: clock.susp)
    p.launched(42)
    p.observe(True)
    hb = p._heartbeat
    check('heartbeat running', hb is not None, True)
    hb._thread.join(0.5)
    check('heartbeat sent', server.beats[:1], [{'rom_id': 42, 'device_id': 'dev'}])
    check('live session on disk', ps.SessionStore(path).meta['live']['rom_id'], 42)
    clock.t += 300
    p.observe(False)
    hb._thread.join(2)
    check('heartbeat stopped', hb._thread.is_alive(), False)
    join_threads()
    check('heartbeat cleared', server.cleared, [{'device_id': 'dev'}])
    check('session uploaded', [s['duration_ms'] for s in server.stored.values()], [300000])
    check('live cleared on disk', ps.SessionStore(path).meta.get('live'), None)
    check('nothing pending', p.store.pending('dev'), [])
    check('upload time recorded', p.store.meta.get('last_upload'), int(clock.t))
    check('pull ran after upload', p.store.meta.get('last_refresh'), int(clock.t))

    # A too-short session is not kept.
    p.launched(43)
    p.observe(True)
    clock.t += 5
    p.observe(False)
    check('5s not kept', any(r['rom_id'] == 43 for r in p.store.sessions), False)

    # Offline: kept, then sent by the next sync.
    client.authenticated = False
    p.launched(44)
    p.observe(True)
    clock.t += 60
    p.observe(False)
    check('nothing sent offline', p.upload_now(), None)
    check('kept for later', len(p.store.pending('dev')), 1)
    client.authenticated = True
    join_threads()
    check('sent on reconnect', p.upload_now(), (1, 0, 0, None))

    # Ludo died mid-game: the next start finds it on disk.
    p.launched(45)
    p.observe(True)
    clock.t += 120
    p.observe(True)                    # progress reaches the disk every PERSIST_EVERY
    clock.t += 10
    p2 = ps.PlaySessions(path, lambda: client, lambda: 'dev', clock=clock,
                         suspend_clock=lambda: clock.susp)
    p2.observe(False)
    join_threads()
    check('recovered at last seen', [(r['rom_id'], r['active_ms']) for r in p2.store.sessions
                                     if r['rom_id'] == 45], [(45, 120_000)])

    # RomM no longer knows the device: registered again, once.
    server.known_devices = {'dev2'}
    ps.HEARTBEAT_RETRY = 0.01
    calls = []
    p3 = ps.PlaySessions(tmpfile(), lambda: client, lambda: 'dev', clock=clock,
                         suspend_clock=lambda: clock.susp,
                         on_device_missing=lambda: calls.append(1) or 'dev2')
    p3.launched(46)
    p3.observe(True)
    hb = p3._heartbeat
    hb._thread.join(0.3)
    check('registered again once', calls, [1])
    check('beats under the new id', server.beats[-1]['device_id'], 'dev2')
    p3.observe(False)
    join_threads()


def test_stats():
    def at(y, mo, d, h, mi=0):
        return int(datetime(y, mo, d, h, mi).timestamp())

    rows = [
        # Oct 10 23:30 -> Oct 11 00:30, an hour played: half on each day.
        {'rom_id': 1, 'start': at(2026, 10, 10, 23, 30), 'end': at(2026, 10, 11, 0, 30),
         'active_ms': 3600_000, 'device_id': 'dev', 'origin': 'local', 'sent': True},
        {'rom_id': 1, 'start': at(2026, 10, 12, 20), 'end': at(2026, 10, 12, 22),
         'active_ms': 3600_000, 'device_id': 'deck', 'origin': 'remote', 'sent': True},
        {'rom_id': 2, 'start': at(2026, 10, 13, 21), 'end': at(2026, 10, 13, 23),
         'active_ms': 7200_000, 'device_id': 'deck', 'origin': 'remote', 'sent': True},
        {'rom_id': 2, 'start': at(2026, 9, 20, 10), 'end': at(2026, 9, 20, 11),
         'active_ms': 1800_000, 'device_id': 'dev', 'origin': 'local', 'sent': False},
        {'rom_id': None, 'start': at(2026, 10, 1, 10), 'end': at(2026, 10, 1, 11),
         'active_ms': 3600_000, 'device_id': 'deck', 'origin': 'remote', 'sent': True},
    ]
    games = {1: {'name': 'Zelda', 'platform_name': 'GameCube', 'platform_slug': 'ngc'},
             2: {'name': 'Terraria', 'platform_name': 'Wii U', 'platform_slug': 'wiiu'}}
    devices = {'deck': {'name': 'Steam Deck'}}
    now = at(2026, 10, 13, 23, 30)
    s = play_stats.compute(rows, games, 'dev', devices, {'last_upload': 5}, now=now)
    check('total excludes unlinked', s['summary']['total_ms'], 4 * 3600_000 + 1800_000)
    check('midnight split', (s['calendar']['2026-10-10'][0], s['calendar']['2026-10-11'][0]),
          (1800_000, 1800_000))
    check('counted on both days', (s['calendar']['2026-10-10'][1], s['calendar']['2026-10-11'][1]), (1, 1))
    check('streaks', (s['summary']['current_streak'], s['summary']['longest_streak']), (4, 4))
    check('longest streak range', s['summary']['longest_streak_range'], ['2026-10-10', '2026-10-13'])
    check('busiest hour', s['summary']['busiest_hour'], {'weekday': 1, 'hour': 21})
    check('most played on', s['summary']['most_played_on'], 'Steam Deck')
    check('platform order', [(p['name'], p['games']) for p in s['platforms']],
          [('Wii U', 1), ('GameCube', 1)])
    check('device shares sum to 1', round(sum(d['share'] for d in s['devices']), 6), 1.0)
    check('this device named', [d['name'] for d in s['devices']], ['Steam Deck', 'This device'])
    check('games by time', [g['name'] for g in s['games']], ['Terraria', 'Zelda'])
    check('wave total', sum(s['wave']), s['summary']['total_ms'])
    check('facts', (s['facts']['sessions'], s['facts']['longest_ms'], s['facts']['days_played']),
          (4, 7200_000, 5))
    check('last month', (s['last_month']['month'], s['last_month']['total_ms'], s['last_month']['top']),
          ('2026-09-01', 1800_000, [2]))
    check('romm counts', s['romm'], {'on_server': 4, 'pending': 1, 'unlinked': 1,
                                     'from_other_devices': 3, 'last_upload': 5, 'last_refresh': None})
    g = play_stats.for_game(rows, 1, 'dev', devices)
    check('game total', (g['total_ms'], g['sessions'], g['longest_ms']), (7200_000, 2, 3600_000))
    check('game devices', [(d['name'], d['share']) for d in g['devices']],
          [('This device', 0.5), ('Steam Deck', 0.5)])
    check('device colour rank is global', {d['name']: d['rank'] for d in g['devices']},
          {d['name']: d['rank'] for d in s['devices']})
    check('unplayed game', play_stats.for_game(rows, 99, 'dev', devices), None)
    check('top games', play_stats.top_games(rows), [(2, 9000_000), (1, 7200_000)])
    check('empty', play_stats.compute([], {}, 'dev', {})['has_data'], False)


def test_play_watch():
    """The watcher observes while the sync monitor is silent, and stands aside
    while it runs."""
    import time
    from romm_sync_engine import sync_core, emulator_saves
    seen = []
    m = sync_core.AutoSyncManager.__new__(sync_core.AutoSyncManager)
    m.play_sessions = type('P', (), {'observe': lambda self, r: seen.append(r)})()
    m._monitor_beat = 0.0
    m._play_watch = None
    m.is_retroarch_running = lambda: False
    saved = emulator_saves.eden_is_running, emulator_saves.cemu_is_running
    emulator_saves.eden_is_running = lambda: False
    emulator_saves.cemu_is_running = lambda: True
    try:
        m.start_play_watch()
        time.sleep(2.5)
        check('observes while the monitor is silent', len(seen) >= 2 and all(seen), True)
        m._monitor_beat = time.time() + 60
        time.sleep(0.2)
        n = len(seen)
        time.sleep(2.2)
        check('stands aside while the monitor runs', len(seen), n)
        check('one watcher only', (m.start_play_watch(), m._play_watch.is_alive())[1], True)
    finally:
        emulator_saves.eden_is_running, emulator_saves.cemu_is_running = saved


def test_month_recap():
    print('month recap')

    def at(y, m, d, h=20):
        return datetime(y, m, d, h).timestamp()

    def sess(rom, start, mins):
        return {'rom_id': rom, 'start': start, 'end': start + mins * 60, 'active_ms': mins * 60000,
                'device_id': 'me', 'origin': 'local'}
    rows = [
        sess(1, at(2026, 8, 3), 60), sess(1, at(2026, 8, 3, 22), 30), sess(2, at(2026, 8, 9), 45),
        sess(3, at(2026, 8, 20), 10), sess(4, at(2026, 8, 21), 5),
        sess(5, at(2026, 8, 22), 4), sess(6, at(2026, 8, 23), 3),
        sess(1, at(2026, 7, 1), 20), sess(2, at(2026, 7, 2), 200),   # July's top: 2, 1
        sess(9, at(2026, 9, 1), 99), {'rom_id': None, 'start': at(2026, 8, 4), 'end': at(2026, 8, 4) + 600,
                                      'active_ms': 600000},
    ]
    utc = lambda ts: datetime.fromtimestamp(ts, timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
    prog = [
        {'rom_ra_id': 77, 'max_possible': 2, 'num_awarded': 2, 'num_awarded_hardcore': 2,
         'most_recent_awarded_date': utc(at(2026, 8, 9)) + '+00:00',
         'earned_achievements': [{'id': '10', 'date': utc(at(2026, 8, 3))},
                                 {'id': '11', 'date': utc(at(2026, 8, 9))},
                                 {'id': '12', 'date': utc(at(2026, 6, 9))}]},
        {'rom_ra_id': 88, 'max_possible': 5, 'num_awarded': 5, 'num_awarded_hardcore': 1,
         'most_recent_awarded_date': utc(at(2026, 6, 1)),
         'earned_achievements': [{'id': '20', 'date': utc(at(2026, 8, 25))}, {'id': '21', 'date': 'garbage'}]},
    ]
    ra = {77: {'rom_id': 1, 'name': 'One', 'achievements': {'10': {'title': 'First', 'points': 5}}}}
    r = play_stats.month_recap(rows, {1: {'name': 'One'}}, '2026-08', prog, ra)
    check('total', r['total_ms'], (60 + 30 + 45 + 10 + 5 + 4 + 3) * 60000)
    check('sessions (unlinked left out)', r['sessions'], 7)
    check('longest', r['longest_ms'], 3600000)
    check('days', (len(r['days']), r['days_played'], r['busiest_day']['day']), (31, 6, 3))
    check('top five, by time', [g['rom_id'] for g in r['top_games']], [1, 2, 3, 4, 5])
    check('new = top three not top three last month', [g['new'] for g in r['top_games']],
          [False, False, True, False, False])
    check('first play', [g['first_play'] for g in r['top_games']][:3], [False, False, True])
    check('others', (r['other_games'], r['other_ms']), (1, 3 * 60000))
    check('unlocks in month only, oldest first', [u['badge_id'] for u in r['unlocks']], ['10', '11', '20'])
    check('named from ra_games', (r['unlocks'][0]['title'], r['unlocks'][0]['game'], r['unlocks'][0]['rom_id']),
          ('First', 'One', 1))
    check('badge url falls back to RA', r['unlocks'][1]['badge_url'].endswith('/Badge/11.png'), True)
    check('points', r['points'], 5)
    check('award mastered, in month', [(a['kind'], a['ra_game_id']) for a in r['awards']], [('mastered', 77)])
    check('nav', (r['prev'], r['next']), ('2026-07', '2026-09'))
    check('january back to december', play_stats._shift_month('2026-01', -1), '2025-12')
    check('months', play_stats.recap_months(rows, prog), ['2026-09', '2026-08', '2026-07', '2026-06'])
    empty = play_stats.month_recap(rows, {}, '2026-05')
    check('empty month', (empty['total_ms'], empty['busiest_day'], empty['top_games']), (0, None, []))


def test_due():
    print('pull due / recap due')
    server = FakeServer()
    client = Client(server)
    clock = Clock()
    clock.t = datetime(2026, 9, 20, 12).timestamp()
    p = ps.PlaySessions(tmpfile(), lambda: client, lambda: 'dev', clock=clock,
                        suspend_clock=lambda: clock.susp)
    check('never pulled: due', p.pull_due(), True)
    p.sync_if_due()
    check('just pulled: not due', (p.pull_due(), p.sync_if_due()), (False, None))
    clock.t += ps.PULL_INTERVAL
    check('15 minutes on: due', p.pull_due(), True)

    played = {'2026-08'}
    check('first check sets the baseline only', p.recap_due(lambda m: m in played), None)
    check('baseline is last month', p.store.meta['recap_shown'], '2026-08')
    check('same month again: none', p.recap_due(lambda m: m in played), None)
    clock.t = datetime(2026, 10, 2, 9).timestamp()
    check('no play in September: none', p.recap_due(lambda m: m in played), None)
    played.add('2026-09')
    check('new month with play: due', p.recap_due(lambda m: m in played), '2026-09')
    check('stays until seen', p.recap_due(lambda m: m in played), '2026-09')
    p.recap_seen('2026-09')
    check('seen: gone', p.recap_due(lambda m: m in played), None)
    p.recap_seen('2026-08')
    check('seeing an older month keeps the newer', p.store.meta['recap_shown'], '2026-09')
    clock.t = datetime(2027, 1, 3).timestamp()
    played.add('2026-12')
    p.store.set_meta(recap_auto=False)
    check('turned off', p.recap_due(lambda m: m in played), None)
    p.store.set_meta(recap_auto=True)
    check('january shows december', p.recap_due(lambda m: m in played), '2026-12')


def main():
    test_play_watch()
    test_store()
    test_upload()
    test_upload_stops()
    test_batching()
    test_pull()
    test_tracker()
    test_recovery()
    test_play_sessions()
    test_stats()
    test_month_recap()
    test_due()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {FAILURES}")
        return 1
    print("all passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
