"""Every name Ludo uploads a game's autosave under is one Argosy reads as "latest".

Run with `python3 engine/tests/test_argosy_names.py`.

Argosy files a server save under a named channel -- a slot the user "made" --
unless its name says it is the game's latest. If Ludo's upload name falls on
the wrong side, the save is real but invisible to Argosy as the one to resume.

``is_latest_save_name`` is a port of SaveSyncApiClient.isLatestSaveFileName and
its timestamp tag, copied from rommapp/argosy-launcher at commit
98562a1e7c6679eaa1edf91ce440655479520eaa. If Argosy changes the rule this
test keeps passing on the old one, so re-check the port when updating Sigil.

Ludo sends slot="autosave" with a battery save, and Argosy reads the slot
before the file name (isLatestSlot), so RomM's " [<timestamp>]" tag on the file
name does not matter then. Each name is checked both ways: by its slot, and --
for a server save that carries no slot -- by its name with the tag added.
"""
import re
import sys
import tempfile
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import AutoSyncManager  # noqa: E402

FAILURES = []

ROMM_TIMESTAMP_TAG = re.compile(r'^\[\d{4}-\d{2}-\d{2}[ _]\d{2}-\d{2}-\d{2}(-\d+)?\]$')


def _strip_accents(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s)
                   if not unicodedata.combining(c))


def is_latest_save_name(file_name, rom_base):
    base = re.sub(r'\.[^.]*$', '', Path(file_name).name)
    if base.lower() in ('argosy-latest', 'autosave'):
        return True
    if rom_base is None:
        return False
    b, r = _strip_accents(base).lower(), _strip_accents(rom_base).lower()
    if b == r:
        return True
    if b.startswith(r):
        suffix = base[len(rom_base):].strip()
        return suffix == '' or bool(ROMM_TIMESTAMP_TAG.match(suffix))
    return False


def is_latest_slot(slot, file_name, rom_base):
    """SaveSyncApiClient.isLatestSlot: the slot decides when the server has one."""
    return is_latest_save_name(slot if slot is not None else file_name, rom_base)


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


def touch(path, data=b'x'):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def manager(games):
    m = AutoSyncManager.__new__(AutoSyncManager)
    m.get_games = lambda: games
    return m


def main():
    # The port itself, against the shapes seen on a live server.
    check('port: autosave', is_latest_save_name('autosave.srm', 'Any'), True)
    check('port: argosy-latest', is_latest_save_name('argosy-latest.sav', 'Any'), True)
    check('port: rom name', is_latest_save_name('Sonic (USA).srm', 'Sonic (USA)'), True)
    check('port: rom name + RomM tag',
          is_latest_save_name('Sonic (USA) [2026-07-24 11-56-01-516].srm', 'Sonic (USA)'), True)
    check('port: two tags is a named channel',
          is_latest_save_name(
              'Sonic (USA) [2026-07-24 11-56-01-516] [2026-07-24_09-56-00].srm',
              'Sonic (USA)'), False)
    check('port: another name is a named channel',
          is_latest_save_name('Sonic Hack.srm', 'Sonic (USA)'), False)
    check('port: accents are ignored',
          is_latest_save_name('Pokémon (Italy).sav', 'Pokemon (Italy)'), True)

    with tempfile.TemporaryDirectory() as td:
        roms = Path(td) / 'roms'
        single = touch(roms / 'snes' / 'Chrono Trigger (USA) (Rev 1).sfc')
        extracted = roms / 'snes' / 'Earthbound'
        touch(extracted / 'EarthBound (USA).sfc')
        discs = roms / 'psx' / 'Final Fantasy VII'
        for n in (1, 2):
            touch(discs / f'Final Fantasy VII (USA) (Disc {n}).chd')
        touch(discs / 'Final Fantasy VII (USA).m3u')
        regional = roms / 'nds' / 'HeartGold'
        touch(regional / 'HeartGold (Italy).nds')
        touch(regional / 'HeartGold (Spain).nds')
        dc = roms / 'dreamcast' / 'Crazy Taxi'
        touch(dc / 'Crazy Taxi (USA).gdi')
        touch(dc / 'track01.bin')

        games = [
            {'rom_id': 1, 'local_path': str(single), 'platform_slug': 'snes',
             'rom_name': 'Chrono Trigger (USA)'},
            {'rom_id': 2, 'local_path': str(extracted), 'platform_slug': 'snes',
             'rom_name': 'Earthbound'},
            {'rom_id': 3, 'local_path': str(discs), 'platform_slug': 'psx',
             'rom_name': 'Final Fantasy VII (USA)'},
            {'rom_id': 4, 'local_path': str(dc), 'platform_slug': 'dc',
             'rom_name': 'Crazy Taxi (USA)'},
            {'rom_id': 5, 'local_path': str(regional), 'platform_slug': 'nds',
             'rom_name': 'HeartGold (Italy)'},
        ]
        m = manager(games)

        for g in games[:4]:
            rid, rom = g['rom_id'], g['rom_name']
            for ext in ('.srm', '.sav', '.zip', '.dsv'):
                up = m._upload_name(rid, Path('/saves') / f'whatever{ext}', 'autosave')
                check(f'{rom}{ext}: upload name is latest', up is not None
                      and is_latest_save_name(up, rom), True)
                check(f'{rom}{ext}: latest by its slot, as the server returns it',
                      is_latest_slot('autosave', f"{Path(up).stem} [2026-09-30 10-00-00]{Path(up).suffix}",
                                     rom), True)
            check(f'{rom}: no slot (older battery saves) is also autosave',
                  m._upload_name(rid, Path('/saves/x.srm'), None), 'autosave.srm')

        # Not the autosave: a VMU port or a named channel keeps its own name.
        check('VMU port B1 keeps its own name',
              m._upload_name(4, Path('/saves/Crazy Taxi.B1.bin'), 'vmu-b1'), None)
        check('a named channel keeps its own name',
              m._upload_name(1, Path('/saves/x.srm'), 'before-boss'), None)

        # A ROM of several regional games keeps its name: the name is the only
        # thing that says which region's save it is. The server's copy of that
        # ROM carries one name, so Argosy can pair only the save named for it.
        check('regional ROM keeps its own name',
              m._upload_name(5, Path('/saves/HeartGold (Spain).sav'), 'autosave'),
              None)

    if FAILURES:
        print(f"\n{len(FAILURES)} FAILED")
        return 1
    print("\nall passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
