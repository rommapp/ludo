"""Cemu (Wii U) saves and accounts, as Cemu itself lays them out.

Run with `python3 engine/tests/test_cemu_saves.py`.

Asserted here:

  * accounts Ludo adds are ones Cemu accepts: the exact account.dat lines,
    a Mii whose FFL CRC is zero, a name Cemu reads back, the next free id;
    and Cemu's own "default" account is made first when Cemu never ran;
  * the active account comes from settings.xml (decimal), falling back the
    way Cemu does;
  * install discovery: flatpak, XDG, portable folder, settings <mlc_path>;
  * a unit holds meta, common and ONE account's folder; packs nest it as
    "<low>/user/80000001" whatever the local id, re-pack byte-identical;
  * restore takes our layout, Argosy's ("account"), user-rooted zips and a
    pack of several accounts, writes only into the playing account, and
    keeps a backup of what it replaced;
  * title ids from meta.xml, from a .wua's root folder or its meta.xml
    (zstd blocks and stored blocks), and from a filename tag.
"""
import io
import struct
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import cemu_saves as C  # noqa: E402

FAILURES = []
TID = '0005000010198F00'


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


def write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def make_wua(path, root_name, meta_xml, compress=True):
    """A minimal ZArchive: root/<root_name>/meta/meta.xml, one data block."""
    names = bytearray()

    def name(text):
        offset = len(names)
        raw = text.encode()
        names.append(len(raw))
        names.extend(raw)
        return offset

    n_title, n_meta, n_xml = name(root_name), name('meta'), name('meta.xml')
    block = meta_xml.ljust(C._ZAR_BLOCK, b'\0') if not compress else meta_xml
    if compress:
        from compression import zstd  # the test interpreter is 3.14
        stored = zstd.compress(block)
    else:
        stored = block
    tree = b''.join([
        struct.pack('>IIII', 0x7FFFFFFF, 1, 1, 0),          # 0 root
        struct.pack('>IIII', n_title, 2, 1, 0),             # 1 title folder
        struct.pack('>IIII', n_meta, 3, 1, 0),              # 2 meta
        struct.pack('>IIII', 0x80000000 | n_xml, 0, len(meta_xml), 0),  # 3 meta.xml
    ])
    sizes = [len(stored) - 1] + [0] * 15
    records = struct.pack('>Q', 0) + struct.pack('>16H', *sizes)
    body = io.BytesIO()
    sections = []
    for part in (stored, records, bytes(names), tree, b'', b''):
        sections.append((body.tell(), len(part)))
        body.write(part)
    footer = b''.join(struct.pack('>QQ', o, s) for o, s in sections) + bytes(32)
    total = body.tell() + 0x90
    footer += struct.pack('>QII', total, 0x61bf3a01, C._ZAR_MAGIC)
    write(path, body.getvalue() + footer)
    return path


def zip_of(path, files):
    with zipfile.ZipFile(path, 'w') as z:
        for name, data in files.items():
            z.writestr(name, data)
    return path


def test_accounts(tmp):
    mlc = tmp / 'mlc01'
    check('no accounts yet', C.accounts(mlc), {})
    pid = C.add_account(mlc, 'Mia')
    check('default made first, Mia next', C.accounts(mlc),
          {0x80000001: 'default', 0x80000002: 'Mia'})
    check('Mia id', pid, 0x80000002)
    text = (mlc / 'usr/save/system/act/80000002/account.dat').read_text()
    lines = text.splitlines()
    check('first line', lines[0], 'AccountInstance_20120705')
    check('field order', [l.split('=')[0] for l in lines[1:]],
          ['PersistentId', 'TransferableIdBase', 'Uuid', 'MiiData', 'MiiName',
           'AccountId', 'BirthYear', 'BirthMonth', 'BirthDay', 'Gender',
           'EmailAddress', 'Country', 'SimpleAddressId', 'PrincipalId',
           'IsPasswordCacheEnabled', 'AccountPasswordCache'])
    fields = dict(l.split('=', 1) for l in lines[1:])
    mii = bytes.fromhex(fields['MiiData'])
    check('mii crc is zero', C._ffl_crc16(mii), 0)
    check('transferable id tail = uuid tail',
          fields['TransferableIdBase'][-8:], fields['Uuid'][-8:])
    check('reuse an existing id', C.add_account(mlc, 'Other', pid=pid), pid)
    check('reuse a free id', C.add_account(mlc, 'Leo', pid=0x80000007), 0x80000007)
    check('next after the highest', C.add_account(mlc, 'Zoe'), 0x80000008)
    check('long and odd names', C.add_account(mlc, 'Alessandra Maria 🎮') and
          C.accounts(mlc)[0x80000009], 'Alessandra')
    for i in range(7):  # 5 so far, up to 12
        C.add_account(mlc, f'p{i}')
    try:
        C.add_account(mlc, 'thirteenth')
        check('13th account refused', False, True)
    except C.CemuAccountsError:
        check('13th account refused', True, True)
    # A Cemu-made folder that fails validation is not counted.
    write(mlc / 'usr/save/system/act/8000000f/account.dat', b'AccountInstance_20120705\n')
    check('invalid account ignored', 0x8000000F in C.accounts(mlc), False)


def test_active(tmp):
    config, data = tmp / 'cfg', tmp / 'data'
    inst = C.Install(config, data)
    C.add_account(inst.mlc, 'Mia')
    check('no settings: default', C.active_account(inst), 0x80000001)
    write(config / 'settings.xml',
          b'<content><Account><PersistentId>2147483650</PersistentId></Account></content>')
    check('settings pick', C.active_account(inst), 0x80000002)
    write(config / 'settings.xml',
          b'<content><Account><PersistentId>2147483660</PersistentId></Account></content>')
    check('unknown falls back to first', C.active_account(inst), 0x80000001)
    write(config / 'settings.xml',
          f'<content><mlc_path>{tmp / "elsewhere"}</mlc_path></content>'.encode())
    check('custom mlc', inst.mlc, tmp / 'elsewhere')


def test_installs(tmp):
    import os
    home = tmp / 'home'
    old = {k: os.environ.get(k) for k in ('HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME')}
    os.environ['HOME'] = str(home)
    os.environ.pop('XDG_CONFIG_HOME', None)
    os.environ.pop('XDG_DATA_HOME', None)
    try:
        flat = C.install_for('flatpak:info.cemu.Cemu')
        check('flatpak data', flat.data_dir, home / '.var/app/info.cemu.Cemu/data/Cemu')
        check('flatpak config', flat.config_dir, home / '.var/app/info.cemu.Cemu/config/Cemu')
        native = C.install_for('/opt/Cemu.AppImage')
        check('native data', native.data_dir, home / '.local/share/Cemu')
        (tmp / 'apps/portable').mkdir(parents=True)
        port = C.install_for(tmp / 'apps/Cemu.AppImage')
        check('portable', port.mlc, tmp / 'apps/portable/mlc01')
        check('nothing on disk', C.installs('/opt/Cemu.AppImage'), [])
        (home / '.local/share/Cemu/mlc01').mkdir(parents=True)
        (home / '.var/app/info.cemu.Cemu/data/Cemu/mlc01').mkdir(parents=True)
        check('launched one first', [i.data_dir for i in C.installs('/opt/Cemu.AppImage')],
              [home / '.local/share/Cemu', home / '.var/app/info.cemu.Cemu/data/Cemu'])
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_units_and_pack(tmp):
    mlc = tmp / 'mlc01'
    title = mlc / 'usr/save/00050000/10198f00'
    write(title / 'meta/saveinfo.xml', b'<info/>')
    write(title / 'user/common/shared.dat', b'shared')
    write(title / 'user/80000002/slot1.dat', b'mia' * 50)
    write(title / 'user/80000001/slot1.dat', b'default' * 50)
    write(mlc / 'usr/save/00050000/1010ed00/meta/meta.xml', b'booted only')
    write(mlc / 'usr/save/0005000e/10198f00/user/80000002/x', b'update, never a save')
    found = C.units(mlc, 0x80000002)
    check('units', sorted(found), [TID])
    u = found[TID]
    a, b = tmp / 'a.zip', tmp / 'b.zip'
    C.pack(u, TID, a)
    C.pack(u, TID, b)
    check('repack identical', a.read_bytes(), b.read_bytes())
    with zipfile.ZipFile(a) as z:
        names = sorted(n for n in z.namelist() if not n.endswith('/'))
    check('pack layout', names, ['10198f00/meta/saveinfo.xml',
                                 '10198f00/user/80000001/slot1.dat',
                                 '10198f00/user/common/shared.dat'])
    with zipfile.ZipFile(a) as z:
        check('carries Mia, not default', z.read('10198f00/user/80000001/slot1.dat'), b'mia' * 50)
    check('zip title low', C.zip_title_low(a), '10198f00')
    check('empty unit packs nothing',
          C.pack(C.unit(mlc, '0005000010101010', 0x80000002), '0005000010101010', tmp / 'c.zip'), None)
    return a


def test_restore(tmp, pack):
    mlc = tmp / 'mlc02'
    title = mlc / 'usr/save/00050000/10198f00'
    write(title / 'user/80000001/slot1.dat', b'default keeps this')
    write(title / 'user/80000003/slot1.dat', b'old leo')
    backups = tmp / 'backups'
    parts = C.restore(pack, mlc, TID, 0x80000003, backups)
    check('parts', parts, ['account', 'common', 'meta'])
    check('leo restored', (title / 'user/80000003/slot1.dat').read_bytes(), b'mia' * 50)
    check('default untouched', (title / 'user/80000001/slot1.dat').read_bytes(), b'default keeps this')
    olds = list(backups.rglob('slot1.dat'))
    check('backup kept', [p.read_bytes() for p in olds], [b'old leo'])

    argosy = zip_of(tmp / 'argosy.zip', {'10198f00/user/account/s.dat': b'argosy',
                                         '10198f00/user/common/c.dat': b'c'})
    C.restore(argosy, mlc, TID, 0x80000003)
    check('argosy account', (title / 'user/80000003/s.dat').read_bytes(), b'argosy')
    check('argosy replaced the folder', (title / 'user/80000003/slot1.dat').exists(), False)

    rooted = zip_of(tmp / 'rooted.zip', {'user/80000002/r.dat': b'rooted'})
    C.restore(rooted, mlc, TID, 0x80000003)
    check('user-rooted', (title / 'user/80000003/r.dat').read_bytes(), b'rooted')
    check('common kept when absent', (title / 'user/common/c.dat').read_bytes(), b'c')

    bare = zip_of(tmp / 'bare.zip', {'common/c.dat': b'bare common', '80000001/b.dat': b'bare'})
    C.restore(bare, mlc, TID, 0x80000003)
    check('account-rooted', (title / 'user/80000003/b.dat').read_bytes(), b'bare')

    several = zip_of(tmp / 'several.zip', {'10198f00/user/80000001/s.dat': b'one',
                                           '10198f00/user/80000003/s.dat': b'three'})
    C.restore(several, mlc, TID, 0x80000003)
    check('several: own id wins', (title / 'user/80000003/s.dat').read_bytes(), b'three')
    C.restore(several, mlc, TID, 0x80000005)
    check('several: 80000001 next', (title / 'user/80000005/s.dat').read_bytes(), b'one')
    odd = zip_of(tmp / 'odd.zip', {'10198f00/user/80000004/s.dat': b'4',
                                   '10198f00/user/80000006/s.dat': b'6'})
    try:
        C.restore(odd, mlc, TID, 0x80000003)
        check('ambiguous refused', False, True)
    except ValueError:
        check('ambiguous refused', True, True)
    junk = zip_of(tmp / 'junk.zip', {'save.sav': b'x'})
    try:
        C.restore(junk, mlc, TID, 0x80000003)
        check('non-wiiu refused', False, True)
    except ValueError:
        check('non-wiiu refused', True, True)
    evil = zip_of(tmp / 'evil.zip', {'10198f00/user/80000001/../../../../x': b'x'})
    try:
        C.restore(evil, mlc, TID, 0x80000003)
        check('escape refused', False, True)
    except ValueError:
        check('escape refused', True, True)


def test_title_ids(tmp):
    meta = b'<?xml version="1.0"?><menu><title_id type="hexBinary" length="8">0005000010198F00</title_id></menu>'
    game = tmp / 'Terraria'
    write(game / 'meta/meta.xml', meta)
    (game / 'code').mkdir()
    write(game / 'code/terraria.rpx', b'rpx')
    check('folder', C.title_id_from_rom(game), TID)
    check('rpx', C.title_id_from_rom(game / 'code/terraria.rpx'), TID)
    zeroed = make_wua(tmp / 'z.wua', '0000000000000000_v0', meta)
    check('wua meta.xml (zstd)', C.title_id_from_rom(zeroed), TID)
    stored = make_wua(tmp / 's.wua', '0000000000000000_v0', meta, compress=False)
    check('wua meta.xml (stored)', C.title_id_from_rom(stored), TID)
    named = make_wua(tmp / 'n.wua', '000500001010ed00_v32', b'<menu/>')
    check('wua root name', C.title_id_from_rom(named), '000500001010ED00')
    wrapped = tmp / 'wrapped'
    make_wua(wrapped / 'Game.wua', '0000000000000000_v0', meta)
    check('folder holding a wua', C.title_id_from_rom(wrapped), TID)
    check('name tag', C.title_id_from_rom(tmp / 'Game [0005000010101C00].wux'), '0005000010101C00')
    check('nothing', C.title_id_from_rom(tmp / 'Game.wux'), None)
    check('not a zarchive', C.title_id_from_rom(write(tmp / 'bad.wua', b'x' * 300)), None)


def main():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        test_accounts(tmp / 'acc')
        test_active(tmp / 'act')
        test_installs(tmp / 'inst')
        pack = test_units_and_pack(tmp / 'units')
        test_restore(tmp / 'restore', pack)
        test_title_ids(tmp / 'tid')
    print(f"\n{len(FAILURES)} failure(s)" if FAILURES else "\nall passed")
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
