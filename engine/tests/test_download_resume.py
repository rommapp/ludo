"""Resuming an interrupted ROM download.
`python3 engine/tests/test_download_resume.py`.

A 6.8 GB Mario Kart download broke at 4.4 GB with "Connection broken:
IncompleteRead" and was thrown away whole. On a link that drops every few
minutes that game never arrives at all, so the interesting cases here are not
"does it retry" but what it does with the bytes it already has:

  * a server that honours Range must be resumed from the offset, and
  * a server that does not must be RESTARTED into a truncated sink.

The second is the one worth a test. Appending the retry's bytes to the ones
already written produces a file of plausible size that is silently corrupt --
which is worse than the failure it replaced, because the failure was loud.
"""

import hashlib
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import requests  # noqa: E402

from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import (  # noqa: E402
    DownloadCancelledException, RomMClient)

# The backoff is real seconds, and the budget tests spend four of them per
# case. Nothing here is testing that sleeping works.
sync_core.time.sleep = lambda seconds: None

FAILURES = []

BODY = bytes(range(256)) * 40      # 10240 bytes, position-revealing
URL = 'https://romm.example/api/roms/44/content'


def digest(data):
    """Bodies are compared by digest: a mismatch printed in full is 10 KB of
    hex the reader cannot diff by eye anyway."""
    return f'{len(data)}b/{hashlib.md5(data).hexdigest()[:12]}'


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILURES.append(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")


class FakeResponse:
    """Yields `body` in chunks, optionally dying partway through."""

    def __init__(self, body, die_after=None, status_code=200, ranges=True):
        self.body = body
        self.die_after = die_after
        self.status_code = status_code
        self.headers = {'accept-ranges': 'bytes'} if ranges else {}
        self.closed = False

    def iter_content(self, chunk_size=8192):
        sent = 0
        for i in range(0, len(self.body), chunk_size):
            chunk = self.body[i:i + chunk_size]
            if self.die_after is not None and sent + len(chunk) > self.die_after:
                head = self.body[i:self.die_after]
                if head:
                    yield head
                raise requests.exceptions.ChunkedEncodingError(
                    'Connection broken: IncompleteRead')
            sent += len(chunk)
            yield chunk

    def close(self):
        self.closed = True


class FakeSession:
    """Hands out queued responses and records the Range headers it was asked for."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.ranges = []

    def get(self, url, params=None, stream=None, timeout=None, headers=None):
        self.ranges.append((headers or {}).get('Range'))
        if not self.responses:
            raise AssertionError('more requests than the test queued')
        nxt = self.responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


def client(session):
    c = RomMClient.__new__(RomMClient)
    c.session = session
    return c


def run(responses, sink=None, chunk=1024, **kwargs):
    """Drive _stream_download over a queue, with a small chunk size."""
    sink = sink if sink is not None else io.BytesIO()
    session = FakeSession(responses[1:])
    c = client(session)
    c._DOWNLOAD_CHUNK = chunk
    written = c._stream_download(responses[0], sink, URL, None, len(BODY),
                                 rom_name='Mario Kart 8', **kwargs)
    return written, sink.getvalue(), session


def main():
    # ── the happy path is unchanged ──────────────────────────────────────
    written, data, _ = run([FakeResponse(BODY)])
    check('an uninterrupted download is byte-exact', digest(data), digest(BODY))
    check('and reports its length', written, len(BODY))

    # ── resume, when the server allows it ────────────────────────────────
    resumed = FakeResponse(BODY[4096:], status_code=206)
    written, data, session = run([FakeResponse(BODY, die_after=4096), resumed])
    check('a resumed download reassembles exactly', digest(data), digest(BODY))
    check('nothing is written twice', written, len(BODY))
    check('and it asked to resume from where it stopped',
          session.ranges, ['bytes=4096-'])

    # ── restart, when it does not ────────────────────────────────────────
    # The zip a folder ROM downloads is generated per request; a byte offset
    # into it means nothing, so the server offers no Range and the transfer
    # starts over.
    written, data, session = run([
        FakeResponse(BODY, die_after=4096, ranges=False),
        FakeResponse(BODY, ranges=False)])
    check('a non-resumable download restarts clean', digest(data), digest(BODY))
    check('the partial bytes were truncated, not appended', written, len(BODY))
    check('and no Range was asked for', session.ranges, [None])

    # ── a server that ignores the Range it advertised ────────────────────
    written, data, _ = run([FakeResponse(BODY, die_after=4096),
                            FakeResponse(BODY, status_code=200)])
    check('a 200 answer to a Range request is treated as a restart',
          digest(data), digest(BODY))
    check('and does not concatenate two copies', written, len(BODY))

    # ── the budget ends it ───────────────────────────────────────────────
    dying = [FakeResponse(BODY, die_after=1024, ranges=False) for _ in range(6)]
    try:
        run(dying)
        check('a permanently broken link eventually raises', False, True)
    except requests.exceptions.ChunkedEncodingError:
        check('a permanently broken link eventually raises', True, True)

    # A reconnect that itself fails is counted, not raised past the budget.
    try:
        run([FakeResponse(BODY, die_after=1024)]
            + [requests.exceptions.ConnectionError('refused')] * 6)
        check('failing reconnects are counted too', False, True)
    except requests.exceptions.ConnectionError:
        check('failing reconnects are counted too', True, True)

    # ── cancellation beats retrying ──────────────────────────────────────
    try:
        run([FakeResponse(BODY, die_after=4096), FakeResponse(BODY[4096:], status_code=206)],
            cancellation_checker=lambda: True)
        check('cancelling stops the download', False, True)
    except DownloadCancelledException:
        check('cancelling stops the download', True, True)

    # ── progress accounting ──────────────────────────────────────────────
    seen = []
    rewinds = []
    run([FakeResponse(BODY, die_after=4096, ranges=False),
         FakeResponse(BODY, ranges=False)],
        on_chunk=seen.append, on_rewind=lambda: rewinds.append(True))
    check('a restart tells the progress bar to rewind', len(rewinds), 1)
    check('and the bar is told about every byte that landed',
          sum(seen), 4096 + len(BODY))

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failure(s): {', '.join(FAILURES)}")
        return 1
    print("all ok")
    return 0


if __name__ == '__main__':
    sys.exit(main())
