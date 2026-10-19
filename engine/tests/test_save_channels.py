"""The pure half of channel/snapshot save sync agrees with RomM's design.

Run with `python3 engine/tests/test_save_channels.py`.

RomM's design (rommapp/romm#5175) gives clients one decide table per channel,
keyed on the snapshot this device holds, the channel's current, and the save
on disk. Argosy ships it as SnapshotDecision; Ludo must take the same action
in every row, or the two clients would fight over one channel.

Asserted:

  * every row of the decide table, plus the restored-by-choice case;
  * a heartbeat advertises the API only through SAVE_SYNC.SNAPSHOTS;
  * a save maps to the ROM *file* it was written from, and an ambiguous one
    maps to nothing rather than to the wrong file;
  * the channel a device follows wins over 'default', which wins over the
    rest, and another user's channel is never picked by default;
  * device state survives a reload, and a corrupt file reads as empty;
  * push responses read as the design specifies, with the two retries;
  * the manifest names a new channel by label and an existing one by id;
  * ChannelSync: a first push creates the channel, a lost race is settled
    by the chooser (on top of the current, or the server's with a backup),
    and nothing is held until a download is written;
  * the session sync sends eligible saves through channels, keeps the rest
    on negotiate, and ignores negotiate's ops for a channel's save.
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import AutoSyncManager  # noqa: E402
from romm_sync_engine.save_channels import (  # noqa: E402
    Action, ChannelStore, ChannelSync, PushResult, SaveHashes, SaveUnit, SnapshotApi, SnapshotPoint,
    build_manifest, decide, pick_channel, rom_file_for_save, snapshot_point,
    snapshots_supported,
)

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


A = SaveHashes('a', 'a')
B = SaveHashes('b', 'b')


def test_decide():
    cur = SnapshotPoint(5, A)
    old = SnapshotPoint(3, B)
    check('holds current, unchanged', decide(cur, cur, A), Action('nothing'))
    check('holds current, missing locally', decide(cur, cur, None), Action('nothing'))
    check('holds current, changed', decide(cur, cur, B),
          Action('push', expected_current_id=5, parent_id=5))
    check('holds older, unchanged', decide(old, cur, B), Action('download', snapshot_id=5))
    check('holds older, missing locally', decide(old, cur, None), Action('download', snapshot_id=5))
    check('holds older, changed', decide(old, cur, SaveHashes('c', 'c')),
          Action('conflict', snapshot_id=5))
    check('holds nothing, no local', decide(None, cur, None), Action('download', snapshot_id=5))
    check('holds nothing, same save', decide(None, cur, A), Action('adopt', snapshot_id=5))
    check('holds nothing, other save', decide(None, cur, B), Action('conflict', snapshot_id=5))
    check('empty channel, local save', decide(None, None, A),
          Action('push', expected_current_id=None, parent_id=None))
    check('empty channel, held pruned', decide(old, None, A),
          Action('push', expected_current_id=None, parent_id=3))
    check('empty channel, nothing', decide(None, None, None), Action('nothing'))

    # Same progress, ticked clock: content differs, identity doesn't.
    check('clock tick is not a change', decide(cur, cur, SaveHashes('a2', 'a')), Action('nothing'))

    restored = SnapshotPoint(3, B, by_choice=True)
    check('restored, clean', decide(restored, cur, B), Action('nothing'))
    check('restored, played on', decide(restored, cur, SaveHashes('c', 'c')),
          Action('push', expected_current_id=5, parent_id=3))


def test_heartbeat():
    check('advertised', snapshots_supported({'SAVE_SYNC': {'SNAPSHOTS': True}}), True)
    check('older server', snapshots_supported({'SYSTEM': {'VERSION': '5.4.0'}}), False)
    check('explicitly off', snapshots_supported({'SAVE_SYNC': {'SNAPSHOTS': False}}), False)
    check('no body', snapshots_supported(None), False)


def test_rom_file_for_save():
    usa = {'id': 1, 'file_name': 'Game (USA).sfc'}
    eur = {'id': 2, 'file_name': 'Game (Europe).sfc'}
    check('by stem', rom_file_for_save([usa, eur], 'Game (Europe)'), eur)
    check('stem match ignores case', rom_file_for_save([usa, eur], 'game (usa)'), usa)
    check('single file owns any save', rom_file_for_save([usa], 'Something Else'), usa)
    check('ambiguous', rom_file_for_save([usa, eur], 'Something Else'), None)
    discs = [{'id': 7, 'file_name': 'FF7 (Disc 1).chd'},
             {'id': 8, 'file_name': 'FF7 (Disc 2).chd'},
             {'id': 9, 'file_name': 'FF7.m3u'}]
    check('disc set saves under its m3u', rom_file_for_save(discs, 'Final Fantasy VII'), discs[2])
    check('file without id ignored', rom_file_for_save([{'file_name': 'x.sfc'}], 'x'), None)
    check('no files', rom_file_for_save(None, 'x'), None)


def test_pick_channel():
    from romm_sync_engine.save_channels import ChannelState
    default = {'id': 'd', 'label': 'default', 'is_own': True}
    speed = {'id': 's', 'label': 'Speedrun', 'is_own': True,
             'current': {'created_at': '2026-10-10T00:00:00'}}
    hard = {'id': 'h', 'label': 'Hard', 'is_own': True,
            'current': {'created_at': '2026-10-12T00:00:00'}}
    theirs = {'id': 't', 'label': 'default', 'is_own': False}
    check('followed channel wins', pick_channel([default, speed], ChannelState(channel_id='s')), speed)
    check('default next', pick_channel([speed, default], None), default)
    check('then most recent', pick_channel([speed, hard], None), hard)
    check("never another user's", pick_channel([theirs], None), None)
    check('none', pick_channel([], None), None)


def test_store():
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / 'channels.json'
        store = ChannelStore(path)
        check('empty', store.get(4), None)
        store.hold(4, 'chan', 'default',
                   {'id': 9, 'save': {'content_hash': 'c', 'identity_hash': 'i'}})
        again = ChannelStore(path)
        check('reloaded point', again.get(4).held_point(), SnapshotPoint(9, SaveHashes('c', 'i')))
        check('reloaded channel', again.get(4).channel_id, 'chan')
        again.hold(4, 'chan', 'default', {'id': 10, 'save': None}, by_choice=True)
        check('no save held', ChannelStore(path).get(4).held_point(), SnapshotPoint(10, None, True))
        again.forget(4)
        check('forgotten', ChannelStore(path).get(4), None)
        path.write_text('{not json')
        check('corrupt reads empty', ChannelStore(path).get(4), None)


def test_snapshot_point():
    check('none', snapshot_point(None), None)
    check('save', snapshot_point({'id': 3, 'save': {'content_hash': 'c', 'identity_hash': 'i'}}),
          SnapshotPoint(3, SaveHashes('c', 'i')))
    check('no identity falls back', snapshot_point({'id': 3, 'save': {'content_hash': 'c'}}),
          SnapshotPoint(3, SaveHashes('c', 'c')))
    check('states only', snapshot_point({'id': 3, 'save': None}), SnapshotPoint(3, None))


def test_read_push():
    m = {'rom_file_id': 1, 'parent_snapshot_id': 4}
    r, retry = SnapshotApi._read_push(201, {'id': 5}, '', m)
    check('201 written', (r.kind, r.snapshot, retry), ('written', {'id': 5}, None))
    r, retry = SnapshotApi._read_push(200, {'id': 4}, '', m)
    check('200 unchanged', (r.kind, retry), ('unchanged', None))
    r, retry = SnapshotApi._read_push(
        409, {'current': {'id': 44}, 'branch': {'id': 45, 'kind': 'branch'}, 'reason': 'moved'}, '', m)
    check('409 branched', (r.kind, r.current['id'], r.snapshot['id'], r.reason, retry),
          ('branched', 44, 45, 'moved', None))
    r, retry = SnapshotApi._read_push(409, {'detail': {'hardcore_downgrade': True}}, '', m)
    check('409 hardcore (detail)', r.kind, 'hardcore_downgrade')
    r, retry = SnapshotApi._read_push(409, {'hardcore_downgrade': True}, '', m)
    check('409 hardcore (top level)', r.kind, 'hardcore_downgrade')
    r, retry = SnapshotApi._read_push(400, {'missing': ['save']}, '', m)
    check('400 missing retries with parts', retry, ({'save'}, None))
    r, retry = SnapshotApi._read_push(404, {'detail': 'Parent snapshot not found'}, '', m)
    check('404 parent retries without it', retry, (set(), {'rom_file_id': 1}))
    r, retry = SnapshotApi._read_push(404, {'detail': 'Parent snapshot not found'}, '', {'rom_file_id': 1})
    check('404 without parent is final', (r.kind, retry), ('failed', None))
    r, retry = SnapshotApi._read_push(413, None, 'too big', m)
    check('413 fails', (r.kind, r.status, retry), ('failed', 413, None))


def test_push_retry():
    class Resp:
        def __init__(self, status, body):
            self.status_code, self._body, self.text = status, body, ''

        def json(self):
            return self._body

    class Session:
        def __init__(self, replies):
            self.replies, self.sent = list(replies), []

        def post(self, url, files, params, timeout):
            self.sent.append([name for name, _ in files])
            self.params = params
            return self.replies.pop(0)

    class Client:
        base_url = 'http://romm'

    client = Client()
    client.session = Session([Resp(400, {'missing': ['save']}), Resp(201, {'id': 6})])
    unit = SaveUnit(b'x', 'g.srm', 'h', 'h')
    r = SnapshotApi(client, device_id='dev').push({'rom_file_id': 1}, save=unit, server_has_save=True)
    check('device named on push', client.session.params, [('device_id', 'dev')])
    check('missing save is re-sent', client.session.sent, [['manifest'], ['manifest', 'save']])
    check('retry result', r.kind, 'written')


def test_manifest():
    push = Action('push', expected_current_id=41, parent_id=41)
    unit = SaveUnit(b'', 'g.srm', 'hash', 'hash')
    m = build_manifest(123, {'id': 'uuid'}, push, save=unit, emulator='retroarch', core='snes9x')
    check('existing channel', m, {
        'rom_file_id': 123, 'is_hardcore': False, 'channel_id': 'uuid',
        'expected_current_id': 41, 'parent_snapshot_id': 41,
        'save': {'hash': 'hash', 'shape': 'SINGLE', 'format': 'native'},
        'emulator': 'retroarch', 'core': 'snes9x',
    })
    m = build_manifest(123, None, Action('push', expected_current_id=None))
    check('new channel by label', m, {
        'rom_file_id': 123, 'is_hardcore': False, 'label': 'default',
        'expected_current_id': None,
    })
    m = build_manifest(1, {'id': 'u'}, push, approve_hardcore_downgrade=True)
    check('downgrade approval', m.get('approve_hardcore_downgrade'), True)


class FakeApi:
    """The channel routes, answering from canned replies."""

    def __init__(self, channels=None, pushes=()):
        self.channels = channels
        self.pushes = list(pushes)
        self.manifests = []
        self.held = []
        self.client = None

    def list_channels(self, ids):
        return self.channels

    def push(self, manifest, save=None, screenshot=None, server_has_save=False):
        self.manifests.append(manifest)
        return self.pushes.pop(0)

    def get_snapshot(self, sid, hold=False):
        if hold:
            self.held.append(sid)
        return {'id': sid, 'save': {'content_hash': f'h{sid}', 'identity_hash': f'h{sid}'}}

    def save_content(self, save_id):
        return b'server bytes'


def _snap(sid, h, chan='c1', device='Odin'):
    return {'id': sid, 'save': {'id': sid * 10, 'content_hash': h, 'identity_hash': h},
            'channel': {'id': chan, 'label': 'default'}, 'device': {'name': device},
            'created_at': '2026-10-19T10:00:00+00:00'}


def test_channel_sync():
    unit = lambda: SaveUnit(b'x', 'g.srm', 'mine', 'mine')  # noqa: E731
    mine = SaveHashes('mine', 'mine')
    with tempfile.TemporaryDirectory() as d:
        store = ChannelStore(Path(d) / 's.json')
        api = FakeApi([], [PushResult('written', snapshot=_snap(1, 'mine'))])
        out = ChannelSync(api, store).sync(7, mine, unit)
        check('first push', out.kind, 'pushed')
        check('creates default', (api.manifests[0].get('label'), api.manifests[0]['expected_current_id']),
              ('default', None))
        check('holds it', store.get(7).held_snapshot_id, 1)

        # Unchanged since: nothing, and no push.
        api = FakeApi([{'id': 'c1', 'label': 'default', 'current': _snap(1, 'mine')}])
        check('unchanged', ChannelSync(api, store).sync(7, mine, unit).kind, 'up_to_date')

        # Another device pushed (current 2) while this one played on 1.
        theirs = {'id': 'c1', 'label': 'default', 'current': _snap(2, 'theirs')}
        mine2 = SaveHashes('mine2', 'mine2')
        api = FakeApi([theirs], [PushResult('written', snapshot=_snap(3, 'mine2'))])
        out = ChannelSync(api, store).sync(7, mine2, unit, choose=lambda cur: 'local')
        check('keep mine pushes on top', (out.kind, api.manifests[0]['expected_current_id'],
                                         api.manifests[0]['parent_snapshot_id']), ('pushed', 2, 1))
        check('now holds the new current', store.get(7).held_snapshot_id, 3)

        api = FakeApi([{'id': 'c1', 'label': 'default', 'current': _snap(4, 'theirs')}])
        seen = []
        out = ChannelSync(api, store).sync(7, SaveHashes('m3', 'm3'), unit,
                                           choose=lambda cur: seen.append(cur['device']['name']) or 'server')
        check('chooser sees the other device', seen, ['Odin'])
        check('keep server downloads with backup', (out.kind, out.backup, out.snapshot['id']),
              ('download', True, 4))
        check('nothing held before the write', store.get(7).held_snapshot_id, 3)
        ChannelSync(api, store).finish_download(7, out.channel, out.snapshot)
        check('held after the write', (store.get(7).held_snapshot_id, api.held), (4, [4]))

        # A push that loses a race mid-session is settled the same way.
        store.forget(7)
        store.hold(7, 'c1', 'default', _snap(4, 'theirs'))
        api = FakeApi([{'id': 'c1', 'label': 'default', 'current': _snap(4, 'theirs')}],
                      [PushResult('branched', snapshot={'id': 6, 'kind': 'branch'}, current=_snap(5, 'x')),
                       PushResult('written', snapshot=_snap(7, 'mine'))])
        out = ChannelSync(api, store).sync(7, mine, unit, choose=lambda cur: 'local')
        check('lost race, keep mine', (out.kind, api.manifests[1]['expected_current_id']), ('pushed', 5))

        api = FakeApi([{'id': 'c1', 'label': 'default', 'current': _snap(7, 'mine')}],
                      [PushResult('branched', snapshot={'id': 9}, current=_snap(8, 'y'))])
        out = ChannelSync(api, store).sync(7, SaveHashes('z', 'z'), unit)
        check('lost race, no chooser', (out.kind, store.get(7).held_snapshot_id), ('conflict', 7))

        check('offline', ChannelSync(FakeApi(None), store).sync(7, mine, unit).kind, 'offline')


def test_session_routing():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        srm = tmp / 'Test Game (USA).srm'
        srm.write_bytes(b'local')
        other = tmp / 'Other.zip'
        other.write_bytes(b'zip')
        inventory = [
            {'rom_id': 1, 'slot': 'autosave', 'file_name': srm.name, 'emulator': 'snes9x',
             'content_hash': 'local', 'updated_at': '2026-10-19T09:00:00+00:00',
             '_path': str(srm), '_channel_ok': True},
            {'rom_id': 2, 'slot': 'autosave', 'file_name': other.name, 'emulator': 'eden',
             'content_hash': 'zip', 'updated_at': '2026-10-19T09:00:00+00:00',
             '_path': str(other)},
        ]
        sent = []

        class Client:
            authenticated = True
            server_features = {'save_snapshots': True}

            def negotiate_sync(self, device_id, inv):
                sent.append([e['rom_id'] for e in inv])
                return 's1', [{'action': 'download', 'rom_id': 1, 'slot': 'autosave',
                               'save_id': 99, 'file_name': 'x.srm'},
                              {'action': 'no_op', 'rom_id': 2, 'slot': 'autosave'}]

            def complete_sync_session(self, *a, **k):
                return True

            def download_save_by_id(self, *a, **k):
                sent.append('legacy download')
                return True

        m = AutoSyncManager.__new__(AutoSyncManager)
        m.romm_client = Client()
        m.settings = type('S', (), {'get': lambda self, *a: 'dev-1'})()
        m.build_sync_inventory = lambda: list(inventory)
        m.retroarch = type('R', (), {'save_dirs': {}})()
        m.get_games = lambda: [{'rom_id': 1, 'is_downloaded': True, 'romm_data': {
            'files': [{'id': 50, 'file_name': 'Test Game (USA).sfc'}]}}]
        m.save_download_blocked = set()
        recorded = []
        m._record_synced = lambda p: recorded.append(Path(p).name) or False
        m.mark_all_synced = lambda exclude=None: False
        m._save_upload_fingerprints = lambda: None
        m._notify_sync_result = lambda *a, **k: None
        m.log = lambda *a, **k: None
        m._resolve_save_conflict = lambda *a, **k: 'server'

        store = ChannelStore(tmp / 's.json')
        api = FakeApi([{'id': 'c1', 'label': 'default', 'current': _snap(4, 'theirs')}])
        m._channel_sync = lambda device_id: ChannelSync(api, store)
        summary = m.run_negotiated_save_sync()

        check('negotiate gets only the rest', sent[0], [2])
        check("negotiate's download for a channel save ignored", 'legacy download' in sent, False)
        check('conflict settled for the server, in place', srm.read_bytes(), b'server bytes')
        check('local work kept beside it', len(list(tmp.glob('*.srm.local-*'))), 1)
        check('counted as a download', summary['downloaded'], 1)
        check('held after writing', store.get(50).held_snapshot_id, 4)
        check('recorded synced', srm.name in recorded, True)

        # An older server: everything goes to negotiate.
        sent.clear()
        m.romm_client.server_features = {}
        m.run_negotiated_save_sync()
        check('older server negotiates all', sent[0], [1, 2])


def main():
    test_decide()
    test_heartbeat()
    test_rom_file_for_save()
    test_pick_channel()
    test_store()
    test_snapshot_point()
    test_read_push()
    test_push_retry()
    test_manifest()
    test_channel_sync()
    test_session_routing()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {FAILURES}")
        return 1
    print('all passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
