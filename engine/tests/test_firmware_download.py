"""Firmware download: resume, verification, and the failure paths.

`python3 engine/tests/test_firmware_download.py`. Uses a fake session rather
than a live server, so the interesting cases — a truncated transfer, a bad
checksum, a server that ignores Range — are reachable at all.
"""

import hashlib
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.bios_manager import BiosManager  # noqa: E402

FAILURES = []
PAYLOAD = bytes(range(256)) * 400          # 102,400 bytes
MD5 = hashlib.md5(PAYLOAD).hexdigest()
ENTRY = {'id': 17, 'file_name': 'Firmware_17.0.1.zip',
         'file_size_bytes': len(PAYLOAD), 'md5_hash': MD5}


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILURES.append(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")


class FakeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def iter_content(self, chunk_size=1):
        for i in range(0, len(self._body), chunk_size):
            yield self._body[i:i + chunk_size]


class FakeSession:
    """Serves PAYLOAD, honouring Range unless told otherwise."""

    def __init__(self, body=PAYLOAD, honour_range=True, status=None):
        self.body = body
        self.honour_range = honour_range
        self.status = status
        self.requests = []

    def get(self, url, headers=None, stream=False, timeout=None):
        headers = headers or {}
        self.requests.append(headers.get('Range'))
        if self.status:
            return FakeResponse(self.status, b'')
        rng = headers.get('Range')
        if rng and self.honour_range:
            start = int(rng.split('=')[1].split('-')[0])
            return FakeResponse(206, self.body[start:])
        return FakeResponse(200, self.body)


class FakeClient:
    authenticated = True
    base_url = 'https://romm.example/'

    def __init__(self, session):
        self.session = session


def manager(session):
    bios = BiosManager.__new__(BiosManager)   # no RetroArch scan needed
    bios.romm_client = FakeClient(session)
    bios.log = lambda *a, **k: None
    return bios


def main():
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)

        # ── Clean download ────────────────────────────────────────────────
        session = FakeSession()
        got = manager(session).download_firmware_entry(ENTRY, d / 'fw.zip')
        check('downloads', got and got.read_bytes() == PAYLOAD, True)
        check('no range header on a fresh download', session.requests, [None])
        check('no .part left', list(d.glob('*.part')), [])

        # ── Already present and valid: no transfer at all ─────────────────
        session = FakeSession()
        manager(session).download_firmware_entry(ENTRY, d / 'fw.zip')
        check('verified file is not re-downloaded', session.requests, [])

        # ── Resume from a partial ─────────────────────────────────────────
        (d / 'fw2.zip.part').write_bytes(PAYLOAD[:40_000])
        session = FakeSession()
        got = manager(session).download_firmware_entry(ENTRY, d / 'fw2.zip')
        check('resumes from the partial', session.requests, ['bytes=40000-'])
        check('resumed file is correct', got.read_bytes() == PAYLOAD, True)

        # ── Server ignores Range and sends the whole body ─────────────────
        (d / 'fw3.zip.part').write_bytes(PAYLOAD[:40_000])
        session = FakeSession(honour_range=False)
        got = manager(session).download_firmware_entry(ENTRY, d / 'fw3.zip')
        check('restarts when Range is ignored, not appends',
              got and got.read_bytes() == PAYLOAD, True)

        # ── Corrupted body fails the checksum ─────────────────────────────
        bad = bytearray(PAYLOAD)
        bad[5000] ^= 0xFF
        got = manager(FakeSession(body=bytes(bad))).download_firmware_entry(
            ENTRY, d / 'fw4.zip')
        check('bad checksum rejected', got, None)
        check('no file written on checksum failure',
              (d / 'fw4.zip').exists(), False)
        check('no .part kept on checksum failure',
              (d / 'fw4.zip.part').exists(), False)

        # ── Truncated body fails on size ──────────────────────────────────
        got = manager(FakeSession(body=PAYLOAD[:1000])).download_firmware_entry(
            ENTRY, d / 'fw5.zip')
        check('truncated download rejected', got, None)
        check('no file written when truncated', (d / 'fw5.zip').exists(), False)

        # ── HTTP error ────────────────────────────────────────────────────
        got = manager(FakeSession(status=404)).download_firmware_entry(
            ENTRY, d / 'fw6.zip')
        check('http error rejected', got, None)

        # ── A stale .part bigger than the target is discarded ─────────────
        (d / 'fw7.zip.part').write_bytes(b'x' * (len(PAYLOAD) + 500))
        session = FakeSession()
        got = manager(session).download_firmware_entry(ENTRY, d / 'fw7.zip')
        check('oversized stale part is discarded', session.requests, [None])
        check('recovered after discarding', got.read_bytes() == PAYLOAD, True)

        # ── find_firmware_entry ───────────────────────────────────────────
        bios = manager(FakeSession())
        platforms = [
            {'slug': 'ps', 'firmware': [{'id': 1, 'file_name': 'scph1001.bin',
                                         'file_size_bytes': 524288}]},
            {'slug': 'switch', 'firmware': [
                {'id': 17, 'file_name': 'Firmware_17.0.1.zip',
                 'file_size_bytes': 339309958},
                {'id': 18, 'file_name': 'stray.nca', 'file_size_bytes': 3584}]},
        ]
        bios._fetch_platforms = lambda force=False: platforms
        check('finds by slug, largest wins',
              bios.find_firmware_entry('switch')['file_name'],
              'Firmware_17.0.1.zip')
        check('finds a named entry',
              bios.find_firmware_entry('switch', 'stray.nca')['id'], 18)
        check('unknown platform', bios.find_firmware_entry('n64'), None)
        check('unknown file name',
              bios.find_firmware_entry('switch', 'nope.zip'), None)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all firmware download checks passed")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
