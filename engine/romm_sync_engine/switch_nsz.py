"""Decompress .nsz/.xcz into the .nsp/.xci that Eden can open.

An NSZ is an NSP whose NCAs were rewritten as NCZs, and an XCZ is the same
thing inside an XCI's secure partition. Eden reads neither, so a compressed
download is useless until it is put back the way it was.

That needs no keys. An NCZ keeps the NCA's first 0x4000 bytes (the encrypted
header) verbatim, then lists every section with the key and counter it was
encrypted under, then holds the decrypted body zstd-compressed -- one stream,
or independent blocks. Restoring the NCA is decompress, then re-encrypt each
section under the key the file itself carries. The result is byte-identical
to the original, which the NCA's own name lets us check: an NCA is named for
the first half of its SHA-256.

zstd and AES come from the system's libzstd and libcrypto through ctypes, the
way title_ids reaches libsigil. Both are part of every desktop Linux and of
SteamOS, and neither has a pure-Python form worth carrying.
"""

import ctypes
import ctypes.util
import hashlib
import logging
import os
import re
import struct
from pathlib import Path

log = logging.getLogger(__name__)

COMPRESSED_EXTS = {'.nsz': '.nsp', '.xcz': '.xci'}

_NCA_HEADER = 0x4000
_SECTION_MAGIC = b'NCZSECTN'
_BLOCK_MAGIC = b'NCZBLOCK'
_CRYPTO_NONE = 1
_CRYPTO_CTR = 3
_CRYPTO_BKTR = 4

_PFS0_MAGIC = b'PFS0'
_HFS0_MAGIC = b'HFS0'
_PFS0_ENTRY = 0x18
_HFS0_ENTRY = 0x40
_XCI_ROOT = 0x130  # root HFS0 offset, then its header size, then its hash
_CHUNK = 4 << 20
_NCA_NAME = re.compile(r'^([0-9a-f]{32})\.(?:cnmt\.)?nca$', re.IGNORECASE)


class DecompressError(Exception):
    pass


def converted_name(name):
    """The plain container name for a compressed one, else None."""
    p = Path(name)
    ext = COMPRESSED_EXTS.get(p.suffix.lower())
    return p.with_suffix(ext).name if ext else None


def describe_failure(error):
    """What to tell the user about a failed decompression, in one sentence."""
    text = str(error)
    if isinstance(error, DecompressError) and 'not installed' in text:
        return ('Ludo needs the zstd and OpenSSL system libraries to '
                'decompress it, and they are missing.')
    if isinstance(error, OSError) and error.errno == 28:
        return 'There is not enough free space to decompress it.'
    if isinstance(error, DecompressError):
        return ('The file looks damaged. Delete the game and download it '
                'again.')
    return f'Decompressing it failed: {text}'


def is_compressed(path):
    return Path(path).suffix.lower() in COMPRESSED_EXTS


# ── Native libraries ────────────────────────────────────────────────────────

class _InBuf(ctypes.Structure):
    _fields_ = [('src', ctypes.c_void_p), ('size', ctypes.c_size_t),
                ('pos', ctypes.c_size_t)]


class _OutBuf(ctypes.Structure):
    _fields_ = [('dst', ctypes.c_void_p), ('size', ctypes.c_size_t),
                ('pos', ctypes.c_size_t)]


def _load(names):
    for name in names:
        try:
            return ctypes.CDLL(name)
        except OSError:
            continue
    return None


_libs = {}


def _zstd():
    if 'zstd' not in _libs:
        lib = _load([ctypes.util.find_library('zstd') or '', 'libzstd.so.1', 'libzstd.so'])
        if lib is not None:
            lib.ZSTD_createDCtx.restype = ctypes.c_void_p
            lib.ZSTD_freeDCtx.argtypes = [ctypes.c_void_p]
            lib.ZSTD_decompressStream.restype = ctypes.c_size_t
            lib.ZSTD_decompressStream.argtypes = [
                ctypes.c_void_p, ctypes.POINTER(_OutBuf), ctypes.POINTER(_InBuf)]
            lib.ZSTD_isError.argtypes = [ctypes.c_size_t]
            lib.ZSTD_getErrorName.restype = ctypes.c_char_p
            lib.ZSTD_getErrorName.argtypes = [ctypes.c_size_t]
            lib.ZSTD_DStreamOutSize.restype = ctypes.c_size_t
        _libs['zstd'] = lib
    if _libs['zstd'] is None:
        raise DecompressError('libzstd is not installed')
    return _libs['zstd']


def _crypto():
    if 'crypto' not in _libs:
        lib = _load([ctypes.util.find_library('crypto') or '', 'libcrypto.so.3',
                     'libcrypto.so.1.1', 'libcrypto.so'])
        if lib is not None:
            lib.EVP_CIPHER_CTX_new.restype = ctypes.c_void_p
            lib.EVP_CIPHER_CTX_free.argtypes = [ctypes.c_void_p]
            lib.EVP_aes_128_ctr.restype = ctypes.c_void_p
            lib.EVP_EncryptInit_ex.argtypes = [
                ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                ctypes.c_char_p, ctypes.c_char_p]
            lib.EVP_EncryptUpdate.argtypes = [
                ctypes.c_void_p, ctypes.c_char_p, ctypes.POINTER(ctypes.c_int),
                ctypes.c_char_p, ctypes.c_int]
        _libs['crypto'] = lib
    if _libs['crypto'] is None:
        raise DecompressError('libcrypto is not installed')
    return _libs['crypto']


def available():
    """True when both native libraries load."""
    try:
        _zstd()
        _crypto()
        return True
    except DecompressError:
        return False


class _ZstdStream:
    """Incremental zstd decoder: feed compressed bytes, get decompressed bytes."""

    def __init__(self):
        self._lib = _zstd()
        self._ctx = self._lib.ZSTD_createDCtx()
        if not self._ctx:
            raise DecompressError('could not create a zstd context')
        self._out_size = self._lib.ZSTD_DStreamOutSize()
        self._out = ctypes.create_string_buffer(self._out_size)
        self.frame_done = False

    def feed(self, data):
        src = ctypes.create_string_buffer(data, len(data))
        inbuf = _InBuf(ctypes.cast(src, ctypes.c_void_p), len(data), 0)
        chunks = []
        while True:
            outbuf = _OutBuf(ctypes.cast(self._out, ctypes.c_void_p), self._out_size, 0)
            ret = self._lib.ZSTD_decompressStream(
                self._ctx, ctypes.byref(outbuf), ctypes.byref(inbuf))
            if self._lib.ZSTD_isError(ret):
                raise DecompressError(
                    'zstd: ' + self._lib.ZSTD_getErrorName(ret).decode())
            if outbuf.pos:
                chunks.append(self._out.raw[:outbuf.pos])
            self.frame_done = ret == 0
            # Done with this input once it is consumed and the output buffer
            # was not filled -- a full buffer can mean more is still pending.
            if inbuf.pos >= inbuf.size and outbuf.pos < outbuf.size:
                break
        return b''.join(chunks)

    def close(self):
        if self._ctx:
            self._lib.ZSTD_freeDCtx(self._ctx)
            self._ctx = None


def _aes_ctr(key, counter, offset, data):
    """Encrypt ``data`` found at NCA ``offset`` under a section's CTR state.

    The IV is the section counter's upper eight bytes with the block number
    of ``offset`` below them. An offset inside a block is handled by
    encrypting from the block start and dropping the lead-in.
    """
    lib = _crypto()
    lead = offset & 0xF
    iv = counter[:8] + struct.pack('>Q', offset >> 4)
    src = b'\0' * lead + data
    out = ctypes.create_string_buffer(len(src) + 16)
    outl = ctypes.c_int(0)
    ctx = lib.EVP_CIPHER_CTX_new()
    try:
        if not lib.EVP_EncryptInit_ex(ctx, lib.EVP_aes_128_ctr(), None, key, iv):
            raise DecompressError('AES-CTR init failed')
        if not lib.EVP_EncryptUpdate(ctx, out, ctypes.byref(outl), src, len(src)):
            raise DecompressError('AES-CTR failed')
    finally:
        lib.EVP_CIPHER_CTX_free(ctx)
    return out.raw[lead:outl.value]


# ── NCZ → NCA ───────────────────────────────────────────────────────────────

class _Sections:
    def __init__(self, sections):
        self._sections = sorted(sections, key=lambda s: s[0])

    def encrypt(self, offset, data):
        """Re-encrypt decompressed body bytes that start at NCA ``offset``."""
        out = bytearray(data)
        end = offset + len(data)
        for s_off, s_size, crypto, key, counter in self._sections:
            lo, hi = max(offset, s_off), min(end, s_off + s_size)
            if lo >= hi or crypto == _CRYPTO_NONE:
                continue
            if crypto not in (_CRYPTO_CTR, _CRYPTO_BKTR):
                raise DecompressError(f'unsupported section crypto type {crypto}')
            out[lo - offset:hi - offset] = _aes_ctr(
                key, counter, lo, bytes(out[lo - offset:hi - offset]))
        return bytes(out)


def _read_exact(fh, size):
    data = fh.read(size)
    if len(data) != size:
        raise DecompressError('NCZ ends early')
    return data


def _ncz_to_nca(src, start, size, dst, on_bytes):
    """Write the NCA held in the NCZ at ``src[start:start+size]`` to ``dst``.

    Returns (bytes written, sha256 of them).
    """
    sha = hashlib.sha256()
    src.seek(start)
    end = start + size
    header = _read_exact(src, _NCA_HEADER)
    dst.write(header)
    sha.update(header)
    written = len(header)

    if _read_exact(src, 8) != _SECTION_MAGIC:
        raise DecompressError('not an NCZ: no section table')
    count = struct.unpack('<Q', _read_exact(src, 8))[0]
    if count > 0x10000:
        raise DecompressError(f'implausible NCZ section count {count}')
    sections = []
    for _ in range(count):
        s_off, s_size, crypto, _pad = struct.unpack('<QQQQ', _read_exact(src, 32))
        key = _read_exact(src, 16)
        counter = _read_exact(src, 16)
        sections.append((s_off, s_size, crypto, key, counter))
    sections = _Sections(sections)

    def emit(plain):
        nonlocal written
        data = sections.encrypt(written, plain)
        dst.write(data)
        sha.update(data)
        written += len(data)
        on_bytes(len(data))

    body = src.tell()
    if src.read(8) == _BLOCK_MAGIC:
        _version, _type, _unused, exponent, blocks, decompressed = struct.unpack(
            '<BBBBIQ', _read_exact(src, 16))
        block_size = 1 << exponent
        sizes = struct.unpack(f'<{blocks}I', _read_exact(src, 4 * blocks))
        remaining = decompressed
        for comp in sizes:
            want = min(block_size, remaining)
            raw = _read_exact(src, comp)
            if comp < want:
                stream = _ZstdStream()
                try:
                    raw = stream.feed(raw)
                finally:
                    stream.close()
            if len(raw) != want:
                raise DecompressError('NCZ block decompressed to the wrong size')
            emit(raw)
            remaining -= want
    else:
        src.seek(body)
        stream = _ZstdStream()
        try:
            while src.tell() < end:
                chunk = src.read(min(_CHUNK, end - src.tell()))
                if not chunk:
                    raise DecompressError('NCZ ends early')
                plain = stream.feed(chunk)
                if plain:
                    emit(plain)
            if not stream.frame_done:
                raise DecompressError('NCZ zstd stream is truncated')
        finally:
            stream.close()
    return written, sha.hexdigest()


# ── Partitions ──────────────────────────────────────────────────────────────

def _read_partition(fh, base, magic, entry_size):
    """(header bytes, [(name, absolute offset, size, hashed size, hash)])."""
    fh.seek(base)
    head = fh.read(16)
    if len(head) != 16 or head[:4] != magic:
        raise DecompressError(f'expected {magic.decode()} at {base:#x}')
    count, strings_size = struct.unpack_from('<II', head, 4)
    if count > 0x10000 or strings_size > 0x100000:
        raise DecompressError(f'implausible {magic.decode()} header')
    table = fh.read(count * entry_size)
    strings = fh.read(strings_size)
    data_base = base + 16 + len(table) + len(strings)
    members = []
    for i in range(count):
        offset, size, name_off = struct.unpack_from('<QQI', table, i * entry_size)
        hashed, digest = 0, b''
        if entry_size == _HFS0_ENTRY:
            hashed = struct.unpack_from('<I', table, i * entry_size + 0x14)[0]
            digest = table[i * entry_size + 0x20:i * entry_size + 0x40]
        name = strings[name_off:strings.find(b'\0', name_off)].decode('utf-8', 'replace')
        members.append((name, data_base + offset, size, hashed, digest))
    return head + table + strings, members


def _partition_header(magic, entries, entry_size, align):
    """Build a PFS0/HFS0 header. ``entries`` is [(name, size, hashed, hash)].

    The string table is padded so the header ends on ``align``, the layout
    the original tools write.
    """
    names = b''
    offsets = []
    for name, *_ in entries:
        offsets.append(len(names))
        names += name.encode() + b'\0'
    fixed = 16 + len(entries) * entry_size
    pad = (-(fixed + len(names))) % align
    names += b'\0' * pad
    table = b''
    data_off = 0
    for (name, size, hashed, digest), name_off in zip(entries, offsets):
        if entry_size == _PFS0_ENTRY:
            table += struct.pack('<QQII', data_off, size, name_off, 0)
        else:
            table += struct.pack('<QQIIQ', data_off, size, name_off, hashed, 0) + digest
        data_off += size
    return magic + struct.pack('<III', len(entries), len(names), 0) + table + names


def _nca_name(name):
    return name[:-4] + '.nca' if name.lower().endswith('.ncz') else name


def _copy(src, start, size, dst, on_bytes):
    src.seek(start)
    left = size
    while left:
        chunk = src.read(min(_CHUNK, left))
        if not chunk:
            raise DecompressError('container ends early')
        dst.write(chunk)
        on_bytes(len(chunk))
        left -= len(chunk)


def _write_members(src, members, dst, on_bytes):
    """Write each member at dst's position, restoring NCZs. Returns sizes."""
    sizes = []
    for name, offset, size, *_ in members:
        if name.lower().endswith('.ncz'):
            written, digest = _ncz_to_nca(src, offset, size, dst, on_bytes)
            expected = _NCA_NAME.match(_nca_name(name))
            if expected and not digest.startswith(expected.group(1).lower()):
                raise DecompressError(f'{name} did not decompress to its original NCA')
            sizes.append(written)
        else:
            _copy(src, offset, size, dst, on_bytes)
            sizes.append(size)
    return sizes


def _hash_region(fh, start, size):
    fh.seek(start)
    return hashlib.sha256(fh.read(size)).digest()


def _rebuild_partition(src, dst, members, magic, entry_size, align, on_bytes):
    """Write a partition at dst's position with its NCZs restored.

    The header is sized by names alone, so a placeholder goes first and the
    real one, with the decompressed sizes and member hashes, replaces it.
    Returns the partition's total size.
    """
    base = dst.tell()
    names = [_nca_name(m[0]) for m in members]
    placeholder = _partition_header(
        magic, [(n, 0, 0, b'\0' * 32) for n in names], entry_size, align)
    dst.write(placeholder)
    sizes = _write_members(src, members, dst, on_bytes)
    end = dst.tell()
    entries = []
    data = base + len(placeholder)
    for name, size, member in zip(names, sizes, members):
        hashed, digest = min(member[3], size), b''
        if entry_size == _HFS0_ENTRY:
            digest = _hash_region(dst, data, hashed)
        entries.append((name, size, hashed, digest))
        data += size
    header = _partition_header(magic, entries, entry_size, align)
    dst.seek(base)
    dst.write(header)
    dst.seek(end)
    return end - base


def _nsz_to_nsp(src, dst, on_bytes):
    _, members = _read_partition(src, 0, _PFS0_MAGIC, _PFS0_ENTRY)
    _rebuild_partition(src, dst, members, _PFS0_MAGIC, _PFS0_ENTRY, 0x20, on_bytes)


def _xcz_to_xci(src, dst, on_bytes):
    src.seek(_XCI_ROOT)
    root_off, _root_size = struct.unpack('<QQ', _read_exact(src, 16))
    root_header, partitions = _read_partition(src, root_off, _HFS0_MAGIC, _HFS0_ENTRY)

    # Everything before the root partition -- card header and certificate --
    # is copied as it is; only the hash of the root header changes below.
    _copy(src, 0, root_off, dst, lambda n: None)
    dst.write(root_header)
    sizes = []
    for name, offset, size, _hashed, _digest in partitions:
        if name.lower() == 'secure':
            _, members = _read_partition(src, offset, _HFS0_MAGIC, _HFS0_ENTRY)
            sizes.append(_rebuild_partition(
                src, dst, members, _HFS0_MAGIC, _HFS0_ENTRY, 0x200, on_bytes))
        else:
            _copy(src, offset, size, dst, on_bytes)
            sizes.append(size)

    # Root entries: new sizes, and each partition's hash covers its header.
    entries = []
    pos = root_off + len(root_header)
    for (name, *_), size in zip(partitions, sizes):
        dst.seek(pos + 4)
        count, strings = struct.unpack('<II', dst.read(8))
        header_size = 16 + count * _HFS0_ENTRY + strings
        entries.append((name, size, header_size, _hash_region(dst, pos, header_size)))
        pos += size
    # Only the entry table changes: the names, and so the string table with
    # whatever padding the original carried, are kept byte for byte.
    table_end = 16 + len(entries) * _HFS0_ENTRY
    rebuilt = _partition_header(_HFS0_MAGIC, entries, _HFS0_ENTRY, 1)
    new_root = root_header[:16] + rebuilt[16:table_end] + root_header[table_end:]
    end = dst.seek(0, os.SEEK_END)
    dst.seek(root_off)
    dst.write(new_root)
    dst.seek(_XCI_ROOT + 8)
    dst.write(struct.pack('<Q', len(new_root)) + hashlib.sha256(new_root).digest())
    dst.seek(end)


def decompress(path, progress=None):
    """Turn ``path`` (.nsz/.xcz) into the .nsp/.xci beside it.

    The original is removed once the new file is complete; on any failure the
    partial output goes and the original stays. ``progress(percent)`` is
    called as the compressed file is read through. Returns the new path, or
    raises DecompressError.
    """
    path = Path(path)
    target_ext = COMPRESSED_EXTS.get(path.suffix.lower())
    if target_ext is None:
        raise DecompressError(f'not a compressed Switch container: {path.name}')
    target = path.with_suffix(target_ext)
    partial = target.with_name(target.name + '.part')
    total = max(path.stat().st_size, 1)
    last = -1

    try:
        with open(path, 'rb') as src, open(partial, 'w+b') as dst:
            def on_bytes(_n):
                # How far through the compressed file we are -- the output
                # size is not known until the end.
                nonlocal last
                pct = min(99, src.tell() * 100 // total)
                if progress and pct != last:
                    last = pct
                    progress(pct)

            if target_ext == '.nsp':
                _nsz_to_nsp(src, dst, on_bytes)
            else:
                _xcz_to_xci(src, dst, on_bytes)
        os.replace(partial, target)
    except Exception:
        partial.unlink(missing_ok=True)
        raise
    path.unlink()
    if progress:
        progress(100)
    log.info('decompressed %s to %s', path.name, target.name)
    return target
