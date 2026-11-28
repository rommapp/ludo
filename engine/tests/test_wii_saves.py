"""Wii saves sync as Argosy's unit: the title's data/ folder, zipped by Sigil.

Run with `python3 engine/tests/test_wii_saves.py`.

The Dolphin core keeps a Wii game's save in its own NAND, as
"<saves>/dolphin-emu/User/Wii/title/<category>/<title hex>/data/", which
Ludo's save walk (save-file extensions) never finds -- so Wii saves never
uploaded. Asserted here:

  * a downloaded Wii game is identified from its disc, and its save is found
    where the core writes it under per-core sorting;
  * the unit holds "<title>/data/…" only: the title's installed content/,
    another game's save and the GameCube card beside it stay out;
  * the inventory reports one "autosave.zip" for it, re-packed to the same
    file while the save is unchanged;
  * through the real background sync, a server zip restores into the folder
    the core reads, on a device that already has a save and on one that has
    never run the game.
"""
import io
import struct
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import sigil_saves  # noqa: E402
from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import AutoSyncManager  # noqa: E402

FAILURES = []
TITLE = '52534245'  # "RSBE", as Dolphin names the folder


def check(label, got, want):
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}: {label}" + ('' if ok else f"\n   got:  {got!r}\n   want: {want!r}"))
    if not ok:
        FAILURES.append(label)


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def wii_disc(path):
    """A disc header Sigil reads as a Wii game: its id and the Wii magic."""
    h = bytearray(0x50000)
    h[0:6] = b'RSBE01'
    h[0x18:0x1c] = struct.pack('>I', 0x5D1C9EA3)
    h[0x20:0x40] = b'Wii Test Game'.ljust(32, b'\0')
    write(path, bytes(h))
    return path


class Retro:
    emulator_directory_map = {}

    def __init__(self, saves, mode):
        self.save_dirs = {'saves': str(saves)}
        self.mode = mode

    def get_save_subdir_mode(self, kind):
        return self.mode

    def get_save_files(self):
        return {'saves': []}


def manager(saves, disc, mode='core'):
    m = AutoSyncManager.__new__(AutoSyncManager)
    m.get_games = lambda: [
        {'rom_id': 7, 'platform_slug': 'wii', 'is_downloaded': True,
         'local_path': str(disc)},
        {'rom_id': 8, 'platform_slug': 'wii', 'is_downloaded': False,
         'local_path': ''},
    ]
    m.retroarch = Retro(saves, mode)
    m._launch_stems = {}
    m.log = lambda *a, **k: None
    m.is_retroarch_running = lambda: False
    m._title_id_index = None
    m.settings = type('S', (), {'get': lambda self, *a: 'dev-1'})()
    return m


def run_download(m, rom_id, server_zip):
    ops = [{'action': 'download', 'rom_id': rom_id, 'slot': 'autosave', 'save_id': 5,
            'file_name': 'autosave.zip'}]

    def download(save_id, kind, target, **kw):
        Path(target).write_bytes(Path(server_zip).read_bytes())
        return True
    m.romm_client = type('C', (), {
        'authenticated': True,
        'negotiate_sync': staticmethod(lambda dev, inv: ('s1', ops)),
        'download_save_by_id': staticmethod(download),
        'complete_sync_session': staticmethod(lambda *a, **k: True),
    })()
    m.build_sync_inventory = lambda: []
    m.save_download_blocked = set()
    m._record_synced = lambda p: False
    m._save_upload_fingerprints = lambda *a, **k: None
    m.mark_all_synced = lambda *a, **k: None
    m._notify_sync_result = lambda *a, **k: None
    return m.run_negotiated_save_sync()


def unit_zip(path, files):
    """A unit as Argosy uploads it: "<title>/data/<file>" members."""
    with zipfile.ZipFile(path, 'w') as z:
        for name, data in files.items():
            z.writestr(f'{TITLE}/data/{name}', data)
    return path


def main():
    if not sigil_saves.available():
        print("SKIP: sigil library not loaded")
        return 0
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        sync_core.cache_dir = lambda: tmp / 'cache'
        disc = wii_disc(tmp / 'roms' / 'wii' / 'Wii Test Game (USA).iso')
        saves = tmp / 'saves'
        user = saves / 'dolphin-emu' / 'User'
        title = user / 'Wii' / 'title' / '00010000' / TITLE
        write(title / 'data' / 'banner.bin', b'banner')
        write(title / 'data' / 'rs_save.dat', b'progress')
        write(title / 'content' / 'title.tmd', b'installed')
        write(user / 'Wii' / 'title' / '00010000' / '53545645' / 'data' / 'x.dat', b'other game')
        write(user / 'GC' / 'USA' / 'Card A' / '01-GALE-gzle.gci', b'a gamecube save')

        # ── discovery and packing ─────────────────────────────────────
        m = manager(saves, disc)
        rows = m._folder_inventory_entries()
        check('one autosave.zip for the downloaded game',
              [(r['rom_id'], r['slot'], r['_upload_name'], r['emulator']) for r in rows],
              [(7, 'autosave', 'autosave.zip', 'dolphin')])
        names = sorted(zipfile.ZipFile(rows[0]['_path']).namelist()) if rows else []
        check('the unit is the title\'s data folder only', names,
              [f'{TITLE}/data/banner.bin', f'{TITLE}/data/rs_save.dat'])
        again = manager(saves, disc)._folder_inventory_entries()
        check('an unchanged save re-packs to the same file',
              [(Path(r['_path']).stat().st_mtime_ns, r['content_hash']) for r in again],
              [(Path(r['_path']).stat().st_mtime_ns, r['content_hash']) for r in rows])
        check('a Wii zip is a packed save',
              m.is_packed_save_op({'rom_id': 7, 'file_name': 'autosave.zip'}), True)

        # ── restore through the real background sync ──────────────────
        summary = run_download(manager(saves, disc), 7,
                               unit_zip(tmp / 's.zip', {'banner.bin': b'banner',
                                                        'rs_save.dat': b'newer' * 50}))
        check('restored', summary.get('downloaded'), 1)
        check('the folder holds the server\'s save',
              (title / 'data' / 'rs_save.dat').read_bytes(), b'newer' * 50)
        check('installed content is untouched', (title / 'content' / 'title.tmd').is_file(), True)
        check('another game is untouched',
              (user / 'Wii' / 'title' / '00010000' / '53545645' / 'data' / 'x.dat').read_bytes(),
              b'other game')
        check('the replaced save is kept as a backup',
              len(list((tmp / 'cache' / 'save_backups' / 'wii').glob(f'{TITLE}-*.zip'))), 1)

        # A device that has never run the game: the folder the core creates.
        fresh = tmp / 'fresh'
        fresh.mkdir()
        run_download(manager(fresh, disc), 7, unit_zip(tmp / 'f.zip', {'rs_save.dat': b'p'}))
        check('a fresh save lands where the Dolphin core reads it',
              (fresh / 'dolphin-emu' / 'User' / 'Wii' / 'title' / '00010000' / TITLE
               / 'data' / 'rs_save.dat').read_bytes(), b'p')

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all Wii save checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
