"""A game turned into a folder by its own documents still downloads as a file.

Run with `python3 engine/tests/test_foldered_single_file.py`.

Uploading a manual or a walkthrough converts a single-file game into a FOLDER
on the server, because the document needs somewhere to live (RomM's
walkthroughs docs say so outright, and the rom then reports fs_extension '' and
has_nested_single_file True). The content endpoint serves whatever is in that
folder, so asking for the rom by name now answers with a ZIP of the folder —
document included — while this path writes the body to a filename ending .nds.
A zip named .nds is what the emulator would then be handed.

Measured on the real rom:
    no file_ids  -> application/zip, 134,371,188 bytes
    file_ids=[…] -> application/octet-stream, 134,217,728 bytes (the .nds)

So the download names the one game file by id. This drives download_rom with a
stubbed session and asserts on the request it builds, rather than moving 128MB.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import RomMClient  # noqa: E402

FAILURES = []


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


class _Response:
    status_code = 200
    headers = {'content-length': '4'}

    def __init__(self, detail=None):
        self._detail = detail

    def json(self):
        return self._detail

    def iter_content(self, chunk_size=1):
        yield b'\x00\x00\x00\x00'

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _Session:
    """Answers the rom lookup, then records the download request."""

    def __init__(self, detail):
        self.detail = detail
        self.requests = []

    def get(self, url, **kw):
        self.requests.append((url, kw.get('params')))
        if '/content/' in url:
            return _Response()
        return _Response(self.detail)


def run(detail):
    c = RomMClient.__new__(RomMClient)
    c.base_url = 'https://romm.example/'
    c.authenticated = True
    c.session = _Session(detail)
    c.ensure_authenticated = lambda: True
    with tempfile.TemporaryDirectory() as d:
        c.download_rom(detail['id'], detail['fs_name'], Path(d) / 'out')
    url, params = c.session.requests[-1]
    return url, (params or {}).get('file_ids')


def main():
    # The real shape: a folder on disk holding one game file and a walkthrough.
    foldered = {
        'id': 12324,
        'fs_name': 'Zelda - Phantom Hourglass',
        'fs_extension': '',
        'has_multiple_files': False,
        'files': [
            {'id': 12607, 'file_name': 'Zelda - Phantom Hourglass.nds',
             'category': 'game', 'is_top_level': True},
            {'id': 32769, 'file_name': 'guide.txt', 'category': 'walkthrough',
             'is_top_level': False},
        ],
    }
    url, ids = run(foldered)
    check("asks for the game file by id", ids, [12607])
    check("still the rom's own content endpoint", '/api/roms/12324/content/' in url, True)

    # A plain single file has no folder and needs no narrowing.
    plain = {
        'id': 7, 'fs_name': 'Game.nds', 'fs_extension': '.nds',
        'has_multiple_files': False,
        'files': [{'id': 1, 'file_name': 'Game.nds', 'category': 'game',
                   'is_top_level': True}],
    }
    check("plain file asks for no ids", run(plain)[1], None)

    # A real multi-disc folder is still fetched whole, as a zip.
    multi = {
        'id': 9, 'fs_name': 'FF7', 'fs_extension': '',
        'has_multiple_files': True,
        'files': [
            {'id': 1, 'file_name': 'FF7 (Disc 1).chd', 'category': 'game'},
            {'id': 2, 'file_name': 'FF7 (Disc 2).chd', 'category': 'game'},
        ],
    }
    check("multi-disc folder fetched whole", run(multi)[1], None)

    # One disc plus a manual is still one game file: the document must not
    # promote it to a folder download.
    with_manual = {
        'id': 11, 'fs_name': 'Game', 'fs_extension': '',
        'has_multiple_files': False,
        'files': [
            {'id': 21, 'file_name': 'Game.iso', 'category': 'game'},
            {'id': 22, 'file_name': 'manual.pdf', 'category': 'manual'},
        ],
    }
    check("manual does not make it a folder download", run(with_manual)[1], [21])

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all foldered-single-file checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
