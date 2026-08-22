"""The page walk stops after its first failed page. `python3 engine/tests/test_fetch_abandon.py`.

The old behavior walked on: a page that timed out or exhausted its retries was
marked failed and the NEXT offset was requested immediately, each abandoned
request leaving its query running server-side — the pileup a RomM operator
reads as parallel load from a sequential client. The new behavior is argosy
parity: after one failed page no further page of that walk is requested, the
platform is abandoned for this pass, and the next sync resumes it from the
checkpoint. This covers the walk mechanics; the checkpoint/resume policy on
top of `last_fetch_incomplete` is the plugin's and covered by its own checks.

One request may still slip through past the failure: the single worker can
have picked up the next page before the collector observes the failure. That
page is collected normally (its rows land, its page sinks) — the guarantee is
"no page after the straggler", which is what keeps a failure from compounding
into N stacked queries. The fake server below sleeps briefly before each
request so the collector reliably wins that race, making the straddler
deterministic instead of a flake.
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import requests
from romm_sync_engine import sync_core

FAILURES = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILURES.append(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")


class FakeResponse:
    def __init__(self, status_code=200, items=None, total=None):
        self.status_code = status_code
        self._items = items or []
        self._total = total

    def json(self):
        body = {'items': self._items}
        if self._total is not None:
            body['total'] = self._total
        return body


class FakeSession:
    """Serves /api/roms out of a table of (platform_id -> rom_count).

    `fail` scripts failures per (platform_id, offset): 'timeout' raises
    ReadTimeout, 'http500' answers 500 on every attempt. A count probe
    (limit=1&fields=id) is answered from the same table.
    """

    def __init__(self, counts):
        self.counts = counts          # platform_id (or None for the whole
        self.fail = {}                # library) -> rom_count
        self.calls = []               # (platform_id, offset) per request
        self.page_calls = []          # same, minus the count probe
        self.page_params = []         # params of each non-probe request
        self.timeouts = []

    def _rows(self, pid, offset):
        base = self.counts.get(pid, 0)
        remaining = max(0, min(100, base - offset))
        return [{'id': (pid if pid is not None else 0) * 100000 + offset + i,
                 'name': f'rom-{pid}-{offset + i}',
                 'platform_id': pid}
                for i in range(remaining)]

    def get(self, url, params=None, timeout=None, **kw):
        # Let the collector thread observe a completed failure before the
        # worker's next page finishes, so "the straggler, and nothing after
        # it" is deterministic here rather than scheduler luck.
        time.sleep(0.01)
        pid = params.get('platform_id')
        offset = params.get('offset', 0)
        self.calls.append((pid, offset))
        self.timeouts.append(timeout)
        is_probe = params.get('limit') == 1 and params.get('fields') == 'id'
        if not is_probe:
            self.page_calls.append((pid, offset))
            self.page_params.append(params)
        mode = self.fail.get((pid, offset))
        if mode == 'timeout':
            raise requests.exceptions.ReadTimeout()
        if mode == 'http500':
            return FakeResponse(status_code=500)
        if is_probe:
            return FakeResponse(items=[], total=self.counts.get(pid, 0))
        return FakeResponse(items=self._rows(pid, offset))


def make_client(fake):
    # No credentials, so the constructor makes no requests; the session is
    # swapped for the fake before anything runs.
    client = sync_core.RomMClient('http://test.local')
    client.session = fake
    return client


def main():
    # ── a read timeout stops the platform walk, not the sync ────────────
    # Platform 1 is the largest, so it walks first: page 2 (offset 100)
    # times out, page 3 is the straggler already in flight, and offsets
    # 300/400 must never be asked for. Platform 2 walks afterwards as if
    # nothing happened.
    fake = FakeSession({1: 500, 2: 100})
    fake.fail[(1, 100)] = 'timeout'
    client = make_client(fake)
    client.get_platforms = lambda: [
        {'id': 1, 'slug': 'one', 'name': 'One', 'rom_count': 500},
        {'id': 2, 'slug': 'two', 'name': 'Two', 'rom_count': 100},
    ]
    sunk = []
    games, total = client._fetch_all_games_by_platform(
        None, page_sink=lambda off, rows, pid: sunk.append((pid, off)))

    check('platform 1 asked for the failure and the straggler only',
          [o for p, o in fake.calls if p == 1], [0, 100, 200])
    check('platform 2 still walked', [o for p, o in fake.calls if p == 2], [0])
    check('the failed walk is flagged incomplete',
          client.last_fetch_incomplete, True)
    check('landed pages are kept', len(games), 300)  # 1's pages 1+3, all of 2
    check('the server total is still reported whole', total, 600)
    check('only landed pages were checkpointed', sunk, [(1, 0), (1, 200), (2, 0)])
    check('pages use the flat 60s read budget',
          set(fake.timeouts), {(10, 60)})
    check('pages ride the index-slice path (no with_rom_id_index opt-out)',
          all(p.get('with_rom_id_index') != 'false' and p.get('with_total') != 'false'
              for p in fake.page_params), True)

    # ── an HTTP failure stops the walk the same way, after its retry ────
    fake = FakeSession({9: 300})
    fake.fail[(9, 100)] = 'http500'
    client = make_client(fake)
    client.get_platforms = lambda: [
        {'id': 9, 'slug': 'nine', 'name': 'Nine', 'rom_count': 300}]
    games, _ = client._fetch_all_games_by_platform(None)
    check('a 500 page is tried twice, then the walk stops',
          [o for p, o in fake.calls if p == 9], [0, 100, 100, 200])
    check('the http-failure walk is flagged incomplete',
          client.last_fetch_incomplete, True)
    check('landed pages are kept around the retried failure', len(games), 200)

    # ── the flat walk stops too ──────────────────────────────────────────
    fake = FakeSession({None: 400})
    fake.fail[(None, 100)] = 'timeout'
    client = make_client(fake)
    sunk = []
    games, total = client._fetch_all_games_chunked(
        None, page_sink=lambda off, rows: sunk.append((None, off)))
    check('flat walk stops after the straggler page',
          [o for p, o in fake.page_calls], [0, 100, 200])
    check('flat walk flagged incomplete', client.last_fetch_incomplete, True)
    check('flat walk keeps landed pages', len(games), 200)
    check('flat walk checkpoints only landed pages', sunk, [(None, 0), (None, 200)])

    # ── a clean walk is unchanged by all of this ────────────────────────
    fake = FakeSession({1: 200, 2: 100})
    client = make_client(fake)
    client.get_platforms = lambda: [
        {'id': 1, 'slug': 'one', 'name': 'One', 'rom_count': 200},
        {'id': 2, 'slug': 'two', 'name': 'Two', 'rom_count': 100}]
    games, total = client._fetch_all_games_by_platform(None)
    check('a clean walk stays complete', client.last_fetch_incomplete, False)
    check('a clean walk returns everything', len(games), 300)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failure(s): {', '.join(FAILURES)}")
        return 1
    print("all fetch-abandon checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
