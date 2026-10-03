"""PSP and 3DS saves sync as Argosy's units: their save FOLDERS, zipped.

Run with `python3 engine/tests/test_folder_saves.py`.

PPSSPP keeps a game's save as folders under "PSP/SAVEDATA/" named after its
serial ("ULUS10064DATA00", "ULUS10064SETTINGS"). Citra and Azahar keep a 3DS
title's save in "sdmc/Nintendo 3DS/<id0>/<id1>/title/<cat>/<low>/data" plus
"extdata/00000000/<low >> 8>". Neither was ever found by Ludo's save walk,
which looks for save-file extensions. Asserted here:

  * discovery at the paths the libretro cores actually write, under per-core
    sorting ("PPSSPP/PSP/SAVEDATA", "Citra/Citra/sdmc/…");
  * a PSP zip holds every folder starting with the serial, as roots, and
    leaves out installed game data; a 3DS zip holds "data/" and "extdata/";
    the SERVER hashes both the same as Argosy-shaped zips; unchanged saves
    re-pack to the same file;
  * the inventory reports one "autosave.zip" per game, matched by serial or
    title ID -- RomM's "00040000/00033500" spelling included;
  * through the real background sync, a server zip restores into the
    folders the core reads -- existing ones, or the ones it would create --
    replacing a 3DS component only when the zip carries it.
"""
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import folder_saves as F  # noqa: E402
from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import AutoSyncManager, RomMClient  # noqa: E402

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def argosy_zip(path, files):
    """Argosy's zipNamedFolders shape: a "<root>/" entry, then its files --
    stored, its own clock; different bytes from ours, same server hash."""
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_STORED) as z:
        for root in sorted({n.split('/')[0] for n in files}):
            z.writestr(zipfile.ZipInfo(f'{root}/', (2026, 1, 2, 3, 4, 6)), b'')
        for name, data in files.items():
            z.writestr(zipfile.ZipInfo(name, (2026, 1, 2, 3, 4, 6)), data)
    return path


SFO_SAVE = b'\x00PSF' + b'SAVEDATA_PARAMS' + bytes(64)
SFO_GAME = b'\x00PSF' + b'DISC_ID' + bytes(64)
PSP_FILES = {
    'ULUS10064DATA00/PARAM.SFO': SFO_SAVE,
    'ULUS10064DATA00/DATA.BIN': b'progress' * 100,
    'ULUS10064SETTINGS/PARAM.SFO': SFO_SAVE,
    'ULUS10064SETTINGS/SETTINGS.BIN': b'options',
}
N3DS_FILES = {
    'data/00000001/main': b'zelda' * 200,
    'extdata/Quota.dat': b'quota',
}


class Retro:
    emulator_directory_map = {}

    def __init__(self, saves, mode):
        self.save_dirs = {'saves': str(saves)}
        self.mode = mode

    def get_save_subdir_mode(self, kind):
        return self.mode

    def get_save_files(self):
        return {'saves': []}


def manager(saves, mode='core'):
    m = AutoSyncManager.__new__(AutoSyncManager)
    m.get_games = lambda: [
        {'rom_id': 1, 'platform_slug': 'psp', 'is_downloaded': True,
         'romm_data': {'title_id': 'ULUS10064'}},
        {'rom_id': 2, 'platform_slug': '3ds', 'is_downloaded': True,
         'romm_data': {'save_target': '00040000/00033500'}},
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
            'file_name': 'Some Game (USA) [2026-09-30_10-00-00].zip'}]

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


def main():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        sync_core.cache_dir = lambda: tmp / 'cache'
        saves = tmp / 'saves'
        savedata = saves / 'PPSSPP' / 'PSP' / 'SAVEDATA'
        for name, data in PSP_FILES.items():
            write(savedata / name, data)
        write(savedata / 'ULUS10064GAMEDATA' / 'PARAM.SFO', SFO_GAME)   # installed data
        write(savedata / 'ULJM05500DATA' / 'DATA.BIN', b'other game')
        id1 = saves / 'Citra' / 'Citra' / 'sdmc' / 'Nintendo 3DS' / F.N3DS_ID / F.N3DS_ID
        write(id1 / 'title' / '00040000' / '00033500' / 'data' / '00000001' / 'main',
              N3DS_FILES['data/00000001/main'])
        write(id1 / 'extdata' / '00000000' / '00000335' / 'Quota.dat',
              N3DS_FILES['extdata/Quota.dat'])

        # ── discovery and packing ─────────────────────────────────────
        check('PPSSPP\'s SAVEDATA is found under core sorting',
              F.psp_savedata_dirs([saves]), [savedata])
        units = F.psp_units(savedata)
        check('one unit per serial, game data left out',
              {k: [f.name for f in v] for k, v in units.items()},
              {'ULJM05500': ['ULJM05500DATA'],
               'ULUS10064': ['ULUS10064DATA00', 'ULUS10064SETTINGS']})
        packed = F.psp_pack(units['ULUS10064'], tmp / 'psp.zip')
        check('PSP zip: the server hashes it as Argosy\'s',
              RomMClient.compute_content_hash(packed),
              RomMClient.compute_content_hash(argosy_zip(tmp / 'a_psp.zip', PSP_FILES)))

        sd_roots = F.n3ds_sd_roots([saves])
        check('Citra\'s SD card is found under core sorting', len(sd_roots), 1)
        n3 = F.n3ds_units(sd_roots[0])
        check('the title is found with its extdata', sorted(n3), ['0004000000033500'])
        check('extdata id is the low id shifted by 8', F.n3ds_extdata_id('00113200'), '00001132')
        packed3 = F.n3ds_pack(n3['0004000000033500'], tmp / '3ds.zip')
        check('3DS zip: the server hashes it as Argosy\'s',
              RomMClient.compute_content_hash(packed3),
              RomMClient.compute_content_hash(argosy_zip(tmp / 'a_3ds.zip', N3DS_FILES)))

        m = manager(saves)
        check('RomM\'s split 3DS id is the same title',
              m._title_id_key('00040000/00033500'), m._title_id_key('0004000000033500'))
        rows = m._folder_inventory_entries()
        check('one autosave.zip per matched game',
              sorted((r['rom_id'], r['slot'], r['_upload_name']) for r in rows),
              [(1, 'autosave', 'autosave.zip'), (2, 'autosave', 'autosave.zip')])
        first = {r['rom_id']: (Path(r['_path']).stat().st_mtime_ns, r['content_hash'])
                 for r in rows}
        again = {r['rom_id']: (Path(r['_path']).stat().st_mtime_ns, r['content_hash'])
                 for r in manager(saves)._folder_inventory_entries()}
        check('unchanged saves re-pack to the same files', again, first)

        # ── restore through the real background sync ──────────────────
        newer = dict(PSP_FILES, **{'ULUS10064DATA00/DATA.BIN': b'newer' * 100})
        del newer['ULUS10064SETTINGS/SETTINGS.BIN'], newer['ULUS10064SETTINGS/PARAM.SFO']
        summary = run_download(manager(saves), 1, argosy_zip(tmp / 's_psp.zip', newer))
        check('PSP: restored', summary.get('downloaded'), 1)
        check('PSP: the folder holds the server\'s save',
              (savedata / 'ULUS10064DATA00' / 'DATA.BIN').read_bytes(), b'newer' * 100)
        check('PSP: a folder the server lacks is gone (kept as backup)',
              (savedata / 'ULUS10064SETTINGS').exists(), False)
        check('PSP: another game is untouched',
              (savedata / 'ULJM05500DATA' / 'DATA.BIN').read_bytes(), b'other game')
        check('PSP: installed game data is untouched',
              (savedata / 'ULUS10064GAMEDATA' / 'PARAM.SFO').exists(), True)

        only_data = {'data/00000001/main': b'newer zelda' * 50}
        summary = run_download(manager(saves), 2, argosy_zip(tmp / 's_3ds.zip', only_data))
        check('3DS: restored', summary.get('downloaded'), 1)
        check('3DS: data replaced',
              (id1 / 'title' / '00040000' / '00033500' / 'data' / '00000001' / 'main').read_bytes(),
              b'newer zelda' * 50)
        check('3DS: extdata kept when the zip does not carry it',
              (id1 / 'extdata' / '00000000' / '00000335' / 'Quota.dat').exists(), True)

        # A device that has never run the game: the folders the core creates.
        fresh = tmp / 'fresh'
        fresh.mkdir()
        run_download(manager(fresh, mode='flat'), 1, argosy_zip(tmp / 'f1.zip', PSP_FILES))
        check('fresh PSP lands in <saves>/PSP/SAVEDATA',
              sorted(p.name for p in (fresh / 'PSP' / 'SAVEDATA').iterdir()),
              ['ULUS10064DATA00', 'ULUS10064SETTINGS'])
        run_download(manager(fresh, mode='core'), 2, argosy_zip(tmp / 'f2.zip', N3DS_FILES))
        fid1 = fresh / 'Citra' / 'Citra' / 'sdmc' / 'Nintendo 3DS' / F.N3DS_ID / F.N3DS_ID
        check('fresh 3DS lands where Citra reads it',
              ((fid1 / 'title' / '00040000' / '00033500' / 'data' / '00000001' / 'main').is_file(),
               (fid1 / 'extdata' / '00000000' / '00000335' / 'Quota.dat').is_file()),
              (True, True))

        try:
            F.psp_restore(argosy_zip(tmp / 'w.zip', {'ULJM05500DATA/x': b'x'}),
                          savedata, 'ULUS10064')
            refused = False
        except ValueError:
            refused = True
        check('a zip of another game is refused', refused, True)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all PSP/3DS folder-save checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
