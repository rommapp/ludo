"""A folder zip with a malformed extra field still opens and extracts.

Run with `python3 engine/tests/test_zip_bad_extra.py`.

rommapp/ludo#19: downloading a multi-file game failed with
"Corrupt extra field 7075 (size=73)". The zip RomM streams for a game folder
had a Unicode-path extra field (0x7075) whose declared length ran past the end
of the record, and CPython rejects the whole archive over it. Importing the
engine installs a fallback that skips the broken field; this builds such an
archive by hand and checks every file comes out intact.
"""

import io
import struct
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import romm_sync_engine.sync_core  # noqa: E402,F401  (installs the fallback)

FAILURES = []


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


FILES = {'Game/Game.nsp': b'base' * 100, 'Game/Update/Game [v1].nsp': b'upd' * 50}


def bad_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        for name, data in FILES.items():
            info = zipfile.ZipInfo(name)
            # A well-formed field first, then 0x7075 claiming 73 bytes it
            # doesn't have -- the shape from the report's traceback.
            info.extra = (struct.pack('<HH', 0x5455, 5) + b'\x01\0\0\0\0'
                          + struct.pack('<HH', 0x7075, 73) + b'\x01' * 9)
            z.writestr(info, data)
    return buf.getvalue()


def main():
    data = bad_zip()
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / 'game.zip'
        path.write_bytes(data)
        try:
            with zipfile.ZipFile(path) as z:
                check('entries listed', sorted(z.namelist()), sorted(FILES))
                z.extractall(Path(d) / 'out')
            for name, want in FILES.items():
                check(f'extracted {name}', (Path(d) / 'out' / name).read_bytes(), want)
        except zipfile.BadZipFile as e:
            check('archive opens', str(e), 'no error')
    # A sound archive is untouched by the fallback.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr('ok.bin', b'fine')
    with zipfile.ZipFile(io.BytesIO(buf.getvalue())) as z:
        check('sound archive', z.read('ok.bin'), b'fine')
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
