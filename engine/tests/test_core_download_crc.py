"""Core downloads refresh stale index CRCs, without retrying or trusting ZIP headers.

Run with `python3 engine/tests/test_core_download_crc.py`; all HTTP is stubbed.
"""
import io
import json
import sys
import tempfile
import time
import zipfile
import zlib
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import RetroArchInterface  # noqa: E402

FAILURES = []
BASE = 'https://bot/x'
CORE = 'pcsx2_libretro.so'
PAYLOAD = b'new core payload'
CRC = f'{zlib.crc32(PAYLOAD):08x}'
OLD_CRC = 'bbebb20f'


def check(label, got, want):
    if got != want:
        FAILURES.append(label)
    print(('ok  ' if got == want else 'FAIL'), label, '' if got == want else f'{got!r} != {want!r}')


def run_case(label, initial_crc, refreshed_crc, success, corrupt=False):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', compression=zipfile.ZIP_STORED) as archive:
        archive.writestr(CORE, PAYLOAD)
    data = buf.getvalue()
    if corrupt:
        # Leave both ZIP CRC headers intact, but change the stored payload.
        offset = data.index(PAYLOAD)
        data = data[:offset] + bytes([data[offset] ^ 1]) + data[offset + 1:]

    with tempfile.TemporaryDirectory() as t:
        root = Path(t)
        dest = root / 'cores'
        dest.mkdir()
        final = dest / CORE
        final.write_bytes(b'existing core')
        cache_file = root / 'libretro_core_index.json'
        cache_file.write_text(json.dumps({
            'base': BASE, 'fetched': time.time(),
            'cores': {'pcsx2': {'file': CORE + '.zip', 'crc': initial_crc}},
        }))
        ra = RetroArchInterface.__new__(RetroArchInterface)
        ra._buildbot_index_cache = None
        ra._buildbot_index_failed_at = None
        ra.cores_dir = dest
        ra._buildbot_base = lambda: (BASE, '.so')
        ra.core_download_support = lambda: {'available': True}
        ra.find_writable_cores_directory = lambda: dest
        ra._fetch_core_info = mock.Mock()

        def get(url, **kwargs):
            if url == BASE + '/.index-extended':
                if isinstance(refreshed_crc, Exception):
                    raise refreshed_crc
                text = (f'2026-01-01 {refreshed_crc} {CORE}.zip\n'
                        if refreshed_crc else '')
                return mock.Mock(text=text, raise_for_status=lambda: None)
            assert url == BASE + '/' + CORE + '.zip', url
            response = mock.MagicMock()
            response.__enter__.return_value = response
            response.headers = {'Content-Length': str(len(data))}
            response.iter_content.return_value = [data]
            return response

        with mock.patch.object(sync_core, 'cache_dir', return_value=root), \
                mock.patch.object(sync_core.requests, 'get', side_effect=get) as http, \
                mock.patch.object(ra, 'list_downloadable_cores',
                                  wraps=ra.list_downloadable_cores) as index:
            result = ra.download_core('pcsx2')

        refresh = initial_crc != CRC
        check(label + ': success', result['success'], success)
        check(label + ': index calls', index.call_args_list,
              [mock.call(), mock.call(force_refresh=True)] if refresh else [mock.call()])
        check(label + ': one archive GET',
              sum(call.args[0].endswith('.zip') for call in http.call_args_list), 1)
        check(label + ': refresh GETs',
              sum(call.args[0].endswith('/.index-extended') for call in http.call_args_list),
              int(refresh))
        check(label + ': installed bytes', final.read_bytes(),
              PAYLOAD if success else b'existing core')
        check(label + ': temporary files cleaned', list(dest.iterdir()), [final])
        check(label + ': info only on success', ra._fetch_core_info.call_count, int(success))
        if success and refresh:
            check(label + ': memory cache refreshed', ra._buildbot_index_cache['pcsx2']['crc'], CRC)
            check(label + ': disk cache refreshed',
                  json.loads(cache_file.read_text())['cores']['pcsx2']['crc'], CRC)
        if not success:
            check(label + ': rejection reason',
                  'Bad CRC-32' in result['message'] if corrupt else 'checksum mismatch' in result['message'],
                  True)


def main():
    run_case('stale index recovery', OLD_CRC, CRC, True)
    run_case('matching index', CRC, CRC, True)
    run_case('persistent mismatch', OLD_CRC, '12345678', False)
    run_case('refresh unavailable returns stale', OLD_CRC, OSError('unreachable'), False)
    run_case('refreshed entry absent', OLD_CRC, None, False)
    run_case('corrupt ZIP payload, matching header', CRC, CRC, False, corrupt=True)
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
