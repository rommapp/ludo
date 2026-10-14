"""NSZ/XCZ decompression. `python3 engine/tests/test_switch_nsz.py`.

No ROMs and no keys: an NCA here is random bytes with one AES-CTR section,
and the matching NCZ is built the way nsz builds one -- header kept, section
table written, decrypted body zstd-compressed. Decompressing has to give back
the NCA byte for byte, which the decompressor itself checks against the
NCA's hash-derived name, so a wrong counter or key fails loudly.
"""

import ctypes
import hashlib
import os
import struct
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import switch_content as S  # noqa: E402
from romm_sync_engine import switch_nsz as Z  # noqa: E402

FAILURES = []


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILURES.append(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")


def zstd_compress(data):
    lib = Z._zstd()
    lib.ZSTD_compressBound.restype = ctypes.c_size_t
    lib.ZSTD_compressBound.argtypes = [ctypes.c_size_t]
    lib.ZSTD_compress.restype = ctypes.c_size_t
    lib.ZSTD_compress.argtypes = [ctypes.c_void_p, ctypes.c_size_t,
                                  ctypes.c_char_p, ctypes.c_size_t, ctypes.c_int]
    cap = lib.ZSTD_compressBound(len(data))
    out = ctypes.create_string_buffer(cap)
    n = lib.ZSTD_compress(out, cap, data, len(data), 3)
    assert not lib.ZSTD_isError(n)
    return out.raw[:n]


KEY = bytes(range(16))
COUNTER = bytes.fromhex('0011223344556677') + b'\0' * 8
SECTION = (0x4000, 0x6000)  # offset, size -- an unencrypted tail follows


def make_nca(seed):
    """(nca bytes, the decrypted body an NCZ stores)."""
    rnd = hashlib.sha256(seed.encode()).digest()
    header = (rnd * (Z._NCA_HEADER // 32 + 1))[:Z._NCA_HEADER]
    plain = bytes((i * 7 + rnd[i % 32]) & 0xFF for i in range(0x6000)) + b'tail' * 0x100
    sec_off, sec_size = SECTION
    enc = Z._aes_ctr(KEY, COUNTER, sec_off, plain[:sec_size]) + plain[sec_size:]
    return header + enc, plain


def make_ncz(nca, plain, blocks=False):
    table = Z._SECTION_MAGIC + struct.pack('<Q', 1)
    table += struct.pack('<QQQQ', SECTION[0], SECTION[1], Z._CRYPTO_CTR, 0) + KEY + COUNTER
    if not blocks:
        return nca[:Z._NCA_HEADER] + table + zstd_compress(plain)
    exponent = 14
    size = 1 << exponent
    chunks = [plain[i:i + size] for i in range(0, len(plain), size)]
    # The last block is stored raw, the way nsz stores one compression
    # does not shrink.
    stored = [zstd_compress(c) for c in chunks[:-1]] + [chunks[-1]]
    head = Z._BLOCK_MAGIC + struct.pack('<BBBBIQ', 2, 1, 0, exponent,
                                        len(stored), len(plain))
    head += struct.pack(f'<{len(stored)}I', *(len(s) for s in stored))
    return nca[:Z._NCA_HEADER] + table + head + b''.join(stored)


def nca_name(nca):
    return hashlib.sha256(nca).hexdigest()[:32] + '.nca'


def partition(magic, entry_size, members):
    entries = [(n, len(p), 0x200 if entry_size == Z._HFS0_ENTRY else 0,
                b'\0' * 32) for n, p in members]
    return (Z._partition_header(magic, entries, entry_size, 0x20)
            + b''.join(p for _n, p in members))


def test_nsz(tmp):
    nca1, plain1 = make_nca('one')
    nca2, plain2 = make_nca('two')
    members = [(nca_name(nca1)[:-4] + '.ncz', make_ncz(nca1, plain1)),
               (nca_name(nca2)[:-4] + '.ncz', make_ncz(nca2, plain2, blocks=True)),
               ('0100000000001000000000000000000a.tik', b'ticket')]
    src = tmp / 'Game [0100152000022000][v0].nsz'
    src.write_bytes(partition(Z._PFS0_MAGIC, Z._PFS0_ENTRY, members))
    seen = []
    out = Z.decompress(src, seen.append)
    check('nsz becomes an nsp of the same name', out.name, 'Game [0100152000022000][v0].nsp')
    check('the nsz is gone', src.exists(), False)
    check('progress ends at 100', seen[-1], 100)
    got = {n: out.read_bytes()[o:o + s] for n, o, s in S.container_members(out)}
    check('stream NCZ restored byte for byte', got.get(nca_name(nca1)) == nca1, True)
    check('block NCZ restored byte for byte', got.get(nca_name(nca2)) == nca2, True)
    check('other members copied', got.get('0100000000001000000000000000000a.tik'), b'ticket')


def test_corrupt(tmp):
    nca, plain = make_nca('bad')
    ncz = bytearray(make_ncz(nca, plain))
    # A different key re-encrypts to different bytes; the name check catches it.
    key_at = Z._NCA_HEADER + 16 + 32
    ncz[key_at] ^= 0xFF
    src = tmp / 'Bad.nsz'
    src.write_bytes(partition(Z._PFS0_MAGIC, Z._PFS0_ENTRY,
                              [(nca_name(nca)[:-4] + '.ncz', bytes(ncz))]))
    try:
        Z.decompress(src)
        raised = False
    except Z.DecompressError:
        raised = True
    check('a wrong NCA is refused', raised, True)
    check('and the original stays', src.exists(), True)
    check('with no partial file left', sorted(p.name for p in tmp.glob('Bad*')), ['Bad.nsz'])


def test_xcz(tmp):
    nca, plain = make_nca('cart')
    secure = partition(Z._HFS0_MAGIC, Z._HFS0_ENTRY,
                       [(nca_name(nca)[:-4] + '.ncz', make_ncz(nca, plain))])
    update = partition(Z._HFS0_MAGIC, Z._HFS0_ENTRY, [('fw.nca', b'U' * 0x300)])
    root = partition(Z._HFS0_MAGIC, Z._HFS0_ENTRY, [('update', update), ('secure', secure)])
    root_header_size = len(root) - len(update) - len(secure)
    head = bytearray(0x200)
    head[0x100:0x104] = b'HEAD'
    struct.pack_into('<QQ', head, 0x130, 0x200, root_header_size)
    src = tmp / 'Cart.xcz'
    src.write_bytes(bytes(head) + root)

    out = Z.decompress(src)
    data = out.read_bytes()
    check('xcz becomes an xci', out.name, 'Cart.xci')
    got = {n: data[o:o + s] for n, o, s in S.container_members(out)}
    check('secure NCA restored', got.get(nca_name(nca)) == nca, True)

    root_off, root_size = struct.unpack_from('<QQ', data, 0x130)
    root_header = data[root_off:root_off + root_size]
    check('root header hash updated',
          data[0x140:0x160] == hashlib.sha256(root_header).digest(), True)
    with open(out, 'rb') as fh:
        _, parts = Z._read_partition(fh, root_off, Z._HFS0_MAGIC, Z._HFS0_ENTRY)
        for name, offset, size, hashed, digest in parts:
            check(f'{name} partition hash matches its header',
                  hashlib.sha256(data[offset:offset + hashed]).digest() == digest, True)
        upd = next(p for p in parts if p[0] == 'update')
        check('update partition copied unchanged', data[upd[1]:upd[1] + upd[2]], update)
        sec = next(p for p in parts if p[0] == 'secure')
        _, members = Z._read_partition(fh, sec[1], Z._HFS0_MAGIC, Z._HFS0_ENTRY)
        for name, offset, size, hashed, digest in members:
            check(f'{name} hash covers its header',
                  hashlib.sha256(data[offset:offset + hashed]).digest() == digest, True)


def main():
    if not Z.available():
        print('libzstd or libcrypto missing; cannot test')
        return 1
    check('converted_name', Z.converted_name('A [v0].XCZ'), 'A [v0].xci')
    check('converted_name of a plain file', Z.converted_name('A.nsp'), None)
    check('missing libraries are named',
          'zstd and OpenSSL' in Z.describe_failure(Z.DecompressError('libzstd is not installed')), True)
    check('a full disk says so',
          'free space' in Z.describe_failure(OSError(28, 'No space left on device')), True)
    check('a bad file says to download it again',
          'download it' in Z.describe_failure(Z.DecompressError('NCZ ends early')), True)
    for test in (test_nsz, test_corrupt, test_xcz):
        with tempfile.TemporaryDirectory() as d:
            test(Path(d))
    print()
    if FAILURES:
        print(f"{len(FAILURES)} failure(s): {', '.join(FAILURES)}")
        return 1
    print("all ok")
    return 0


if __name__ == '__main__':
    sys.exit(main())
