"""Dreamcast saves meet Argosy's: port A1 is the game's autosave.

Run with `python3 engine/tests/test_dreamcast_sync.py`.

Flycast keeps a game's saves as VMU images, "<product number>.<port>.bin".
Argosy syncs the port A1 card in the "autosave" slot, uploaded under its own
ROM's name ("Crazy Taxi (USA).bin") and restored as "<product id>.A1.bin".
Ludo used to give every port its own "vmu-<port>" slot. Asserted here:

  * A1 uploads as "autosave"; the other ports keep their own slots;
  * an autosave from the server is written as the game's A1 card whatever it
    is called -- named by the card already on disk, else by the product
    number Sigil reads off the disc (zipped or not), else by the content name
    flycast falls back to;
  * through the real background sync, an old "vmu-a1" row is never
    downloaded over the newer autosave, and an Argosy upload lands as the card.
"""
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import AutoSyncManager, RomMClient  # noqa: E402
from test_title_ids import make_dreamcast  # noqa: E402

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


class Retro:
    emulator_directory_map = {}

    def __init__(self, saves):
        self.save_dirs = {'saves': str(saves)}
        self.saves = Path(saves)

    def get_save_files(self):
        return {'saves': [{'path': str(p), 'name': p.name}
                          for p in sorted(self.saves.glob('*')) if p.is_file()]}

    def convert_to_retroarch_filename(self, name, kind, target_dir, slot=None):
        return sync_core.RetroArchInterface.convert_to_retroarch_filename(
            self, name, kind, target_dir, slot)


def manager(saves, games, owner=None):
    m = AutoSyncManager.__new__(AutoSyncManager)
    m.get_games = lambda: games
    m.retroarch = Retro(saves)
    m._launch_stems = {}
    m.rom_id_for_save = owner or (lambda p: None)
    return m


def main():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        saves = tmp / 'saves'
        saves.mkdir()

        # ── upload side ────────────────────────────────────────────────
        check('A1 is the autosave',
              RomMClient.get_slot_info('T1401D__50.A1.bin')[0], 'autosave')
        check('B1 keeps its own slot',
              RomMClient.get_slot_info('T1401D__50.B1.bin')[0], 'vmu-b1')

        # ── naming ────────────────────────────────────────────────────
        gdi = tmp / 'roms' / 'dc' / 'Crazy Taxi (USA)'
        gdi.mkdir(parents=True)
        (gdi / 'Crazy Taxi (USA).gdi').write_text('3\n')
        make_dreamcast(gdi / 'track03.bin')
        zipped_dir = tmp / 'roms' / 'dc'
        make_dreamcast(zipped_dir / 'inner.bin', b'MK-51035  ')
        with zipfile.ZipFile(zipped_dir / 'Shenmue.zip', 'w') as z:
            z.write(zipped_dir / 'inner.bin', 'Shenmue (Track 3).bin')
        (zipped_dir / 'inner.bin').unlink()
        blank = tmp / 'roms' / 'dc' / 'Unknown'
        blank.mkdir()
        (blank / 'Unknown (USA).cdi').write_bytes(bytes(4096))

        games = [
            {'rom_id': 1, 'platform_slug': 'dc', 'is_downloaded': True, 'local_path': str(gdi)},
            {'rom_id': 2, 'platform_slug': 'dc', 'is_downloaded': True, 'local_path': str(zipped_dir / 'Shenmue.zip')},
            {'rom_id': 3, 'platform_slug': 'dc', 'is_downloaded': True, 'local_path': str(blank)},
        ]
        m = manager(saves, games)
        name = lambda rid, fn: m._local_save_name(rid, fn, 'autosave')
        check('argosy autosave -> product number off the disc',
              name(1, 'Crazy Taxi (USA) [2026-09-30_10-00-00].bin'), 'T1401D__50.A1.bin')
        check('zipped disc is read in place',
              name(2, 'Shenmue [2026-09-30_10-00-00].bin'), 'MK-51035.A1.bin')
        check('unreadable disc -> the content name flycast falls back to',
              name(3, 'Unknown [2026-09-30_10-00-00].bin'), 'Unknown (USA).A1.bin')

        # A card already on disk names the game best, even one whose id is
        # spelled differently from what the disc says.
        (saves / 'T1401D 50.A1.bin').write_bytes(b'card')
        m = manager(saves, games, owner=lambda p: 1 if 'T1401D' in p.name else None)
        check('the card on disk wins',
              m._local_save_name(1, 'Crazy Taxi (USA).bin', 'autosave'), 'T1401D 50.A1.bin')
        (saves / 'T1401D 50.A1.bin').unlink()

        # ── the real background sync ──────────────────────────────────
        ops = [
            {'action': 'download', 'rom_id': 1, 'slot': 'vmu-a1', 'save_id': 10,
             'file_name': 'T1401D__50.A1 [2026-08-01_10-00-00].bin'},
            {'action': 'download', 'rom_id': 1, 'slot': 'autosave', 'save_id': 11,
             'file_name': 'Crazy Taxi (USA) [2026-09-30_10-00-00].bin'},
        ]
        written = {}

        def download(save_id, kind, target, **kw):
            Path(target).write_bytes(f'save {save_id}'.encode())
            written[save_id] = Path(target).name
            return True

        m = manager(saves, games)
        m.romm_client = type('C', (), {
            'authenticated': True,
            'negotiate_sync': staticmethod(lambda dev, inv: ('s1', ops)),
            'download_save_by_id': staticmethod(download),
            'complete_sync_session': staticmethod(lambda *a, **k: True),
        })()
        m.settings = type('S', (), {'get': lambda self, *a: 'dev-1'})()
        m.build_sync_inventory = lambda: []
        m.log = lambda *a, **k: None
        m.save_download_blocked = set()
        m._record_synced = lambda p: False
        m._save_upload_fingerprints = lambda *a, **k: None
        m.mark_all_synced = lambda *a, **k: None
        m._notify_sync_result = lambda *a, **k: None
        summary = m.run_negotiated_save_sync()
        check('the old vmu-a1 row is not restored', 10 in written, False)
        check('argosy\'s autosave lands as the A1 card', written.get(11), 'T1401D__50.A1.bin')
        check('the card holds the autosave',
              (saves / 'T1401D__50.A1.bin').read_bytes(), b'save 11')
        check('the skip is counted', summary.get('skipped_legacy'), 1)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all Dreamcast sync checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
