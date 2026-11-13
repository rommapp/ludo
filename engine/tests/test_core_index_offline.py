"""#64: a blocked buildbot must not stall the core page.

`python3 engine/tests/test_core_index_offline.py`, network stubbed. The page asks
for the core list once per platform; a failure used to retry the fetch each time.
"""
import json
import sys
import tempfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import RetroArchInterface  # noqa: E402

FAILURES = []


def check(label, got, want):
    if got != want:
        FAILURES.append(label)
    print(('ok  ' if got == want else 'FAIL'), label, '' if got == want else f'{got!r} != {want!r}')


def interface():
    ra = RetroArchInterface.__new__(RetroArchInterface)
    ra._buildbot_index_cache = None
    ra._buildbot_index_failed_at = None
    ra._buildbot_base = lambda: ('https://bot/x', '.so')
    return ra


def main():
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        sync_core.cache_dir = lambda: tmp
        boom = mock.Mock(side_effect=OSError('unreachable'))
        ra = interface()
        with mock.patch.object(sync_core.requests, 'get', boom):
            for _ in range(8):
                got = ra.list_downloadable_cores()
            check('eight asks make one request', boom.call_count, 1)
            check('nothing to offer', got, {})
            check('the failure is reported', ra.core_index_unavailable(), True)
            ra.list_downloadable_cores(force_refresh=True)
            check('a forced refresh tries again', boom.call_count, 2)

            (tmp / 'libretro_core_index.json').write_text(json.dumps(
                {'base': 'https://bot/x', 'fetched': 0, 'cores': {'old': {'file': 'f'}}}))
            ra = interface()
            check('an expired list stands in', list(ra.list_downloadable_cores()), ['old'])

            ra._buildbot_index_failed_at -= sync_core.BUILDBOT_RETRY_SECONDS + 1
            calls = boom.call_count
            ra.list_downloadable_cores()
            check('it retries after the wait', boom.call_count, calls + 1)

        good = mock.Mock(return_value=mock.Mock(
            text='2026-01-01 abcd1234 a_libretro.so.zip\n', raise_for_status=lambda: None))
        with mock.patch.object(sync_core.requests, 'get', good):
            check('recovery lists cores', list(ra.list_downloadable_cores(force_refresh=True)), ['a'])
        check('recovery clears the notice', ra.core_index_unavailable(), False)
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
