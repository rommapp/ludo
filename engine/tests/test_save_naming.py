"""A downloaded battery save lands under the name RetroArch reads HERE.

Run with `python3 engine/tests/test_save_naming.py`.

A server save is named after the ROM on whichever device uploaded it. Argosy
names a game's autosave after its own ROM file ("<rom base>.<ext>"), and the
same game is routinely called something else on this device -- above all when
RomM serves it zipped: Ludo extracts "Game.zip" into a folder, the file inside
carries a different name, and RetroArch saves under the file it booted. Written
under the uploader's name, the save sits beside the game and is never loaded.

Asserted for both download paths' shared rule (_local_save_stem) and for the
background sync's target (_resolve_download_target):

  * a foreign name becomes this device's content stem: the launched file, or
    the ROM when it is one file, or the one game inside an extracted folder;
  * a name that IS one of this ROM's files is kept -- a regional variant's
    save belongs to that variant, whichever region was launched;
  * a disc set saves under its .m3u, a disc dump under its descriptor;
  * a folder with several candidates and no launch defers, rather than
    putting one region's save on another;
  * named channels, VMUs and saves for games this library lacks are left alone.
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import AutoSyncManager, DEFER_DOWNLOAD  # noqa: E402

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


class _Retro:
    emulator_directory_map = {}
    save_dirs = {}

    def convert_to_retroarch_filename(self, name, kind, target_dir, slot=None):
        return sync_core.RetroArchInterface.convert_to_retroarch_filename(
            self, name, kind, target_dir, slot)


def manager(games, launched=None):
    m = AutoSyncManager.__new__(AutoSyncManager)
    m.get_games = lambda: games
    m.retroarch = _Retro()
    m._launch_stems = dict(launched or {})
    return m


def touch(path, data=b'x'):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def main():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        roms = tmp / 'roms'
        saves = tmp / 'saves'
        saves.mkdir()

        # A plain single-file ROM, named differently from Argosy's copy.
        sfc = touch(roms / 'snes' / 'Chrono Trigger (USA) (Rev 1).sfc')
        # A zipped game Ludo extracted into a folder of the archive's stem.
        extracted = roms / 'snes' / 'Earthbound'
        touch(extracted / 'EarthBound (USA).sfc')
        touch(extracted / 'manual.pdf')
        # A zip RetroArch opens itself: the archive is the content.
        zipped = touch(roms / 'gba' / 'Minish Cap.zip')
        # A multi-file ROM of regional cartridges, no playlist.
        regional = roms / 'nds' / 'Pokemon HeartGold'
        touch(regional / 'Pokemon HeartGold (Italy).nds')
        touch(regional / 'Pokemon HeartGold (Spain).nds')
        # A multi-disc set with its playlist.
        discs = roms / 'psx' / 'Final Fantasy VII'
        for n in (1, 2, 3):
            touch(discs / f'Final Fantasy VII (USA) (Disc {n}).chd')
        touch(discs / 'Final Fantasy VII (USA).m3u')
        # A single-disc cue/bin dump.
        cue = roms / 'psx' / 'Vagrant Story'
        touch(cue / 'Vagrant Story (USA).cue')
        touch(cue / 'Vagrant Story (USA) (Track 1).bin')
        touch(cue / 'Vagrant Story (USA) (Track 2).bin')

        games = [
            {'rom_id': 1, 'local_path': str(sfc)},
            {'rom_id': 2, 'local_path': str(extracted)},
            {'rom_id': 3, 'local_path': str(zipped)},
            {'rom_id': 4, 'local_path': str(regional)},
            {'rom_id': 5, 'local_path': str(discs)},
            {'rom_id': 6, 'local_path': str(cue)},
        ]
        m = manager(games)
        stem = m._local_save_stem

        # ── the rule ──────────────────────────────────────────────────
        check('argosy name -> the ROM file',
              stem(1, 'Chrono Trigger (USA) [2026-09-30_10-00-00].srm'),
              'Chrono Trigger (USA) (Rev 1)')
        check('our own name is kept',
              stem(1, 'Chrono Trigger (USA) (Rev 1) [2026-09-30_10-00-00].srm'),
              'Chrono Trigger (USA) (Rev 1)')
        check('extracted zip -> the game inside, not the archive or the manual',
              stem(2, 'Earthbound [2026-09-30_10-00-00].srm'), 'EarthBound (USA)')
        check('zip RetroArch opens itself -> the archive',
              stem(3, 'The Minish Cap (Europe).srm'), 'Minish Cap')
        check('regional save keeps its region, with no launch',
              stem(4, 'Pokemon HeartGold (Spain) [2026-09-30_10-00-00].sav'),
              'Pokemon HeartGold (Spain)')
        check('regional folder, foreign name, no launch: cannot tell',
              stem(4, 'HeartGold.sav'), None)
        check('disc set saves under its playlist',
              stem(5, 'Final Fantasy VII (USA) (Disc 1).srm'), 'Final Fantasy VII (USA)')
        check('cue dump saves under its descriptor, not a track',
              stem(6, 'Vagrant Story.srm'), 'Vagrant Story (USA)')
        check('a game this library lacks keeps the uploader name',
              stem(99, 'Whatever (USA) [2026-09-30_10-00-00].srm'), 'Whatever (USA)')

        # The launched file is what RetroArch is about to read, so it decides
        # a foreign name -- but never takes a variant's own save from it.
        m = manager(games, launched={4: 'Pokemon HeartGold (Italy)',
                                     2: 'EarthBound (USA)'})
        check('launched region takes a foreign-named save',
              m._local_save_stem(4, 'HeartGold.sav'), 'Pokemon HeartGold (Italy)')
        check('launched region does not take the other region\'s save',
              m._local_save_stem(4, 'Pokemon HeartGold (Spain).sav'),
              'Pokemon HeartGold (Spain)')

        # ── the background sync's target ──────────────────────────────
        def target(rom_id, name, slot='autosave'):
            return manager(games)._resolve_download_target(
                {'rom_id': rom_id, 'file_name': name, 'slot': slot}, str(saves))

        check('target: argosy srm renamed, extension kept',
              target(1, 'Chrono Trigger (USA) [2026-09-30_10-00-00].srm'),
              saves / 'Chrono Trigger (USA) (Rev 1).srm')
        check('target: .sav stays .sav',
              target(4, 'Pokemon HeartGold (Spain) [2026-09-30_10-00-00].sav'),
              saves / 'Pokemon HeartGold (Spain).sav')
        check('target: undecidable defers',
              target(4, 'HeartGold.sav') is DEFER_DOWNLOAD, True)
        check('target: a named save channel is not renamed',
              target(1, 'Before the boss [2026-09-30_10-00-00].srm', slot='Before the boss'),
              saves / 'Before the boss.srm')
        check('target: a VMU keeps flycast\'s name',
              target(1, 'T1401D__50.A1.bin', slot='vmu-a1'),
              saves / 'T1401D__50.A1.bin')

        # ── the name a save goes up under ─────────────────────────────
        # Argosy finds a game's autosave by name: its ROM's, "argosy-latest"
        # or "autosave". Ours rarely equals its ROM's, so ours is "autosave".
        games += [{'rom_id': 7, 'platform_slug': 'ps2', 'local_path': str(sfc)}]
        m = manager(games)
        check('autosave goes up as "autosave"',
              m._upload_name(1, saves / 'Chrono Trigger (USA) (Rev 1).srm', 'autosave'),
              'autosave.srm')
        check('the extension is the artifact\'s',
              m._upload_name(7, Path('/c/BASCUS-97490.zip'), 'autosave'), 'autosave.zip')
        check('a VMU port keeps its name',
              m._upload_name(1, saves / 'T1401D__50.B1.bin', 'vmu-b1'), None)
        check('a named channel keeps its name',
              m._upload_name(1, saves / 'Boss.srm', 'Before the boss'), None)
        check('a regional ROM keeps the region in the name',
              m._upload_name(4, saves / 'Pokemon HeartGold (Spain).sav', 'autosave'), None)
        check('our own "autosave" download lands under our name',
              m._local_save_stem(1, 'autosave [2026-09-30_10-00-00].srm'),
              'Chrono Trigger (USA) (Rev 1)')

        # Through the real background sync: the upload carries the name.
        sent = {}

        def upload(rom_id, kind, path, **kw):
            sent[rom_id] = kw.get('upload_name') or Path(path).name
            return True
        m = manager(games)
        local_save = saves / 'Chrono Trigger (USA) (Rev 1).srm'
        local_save.write_bytes(b'sram' * 64)
        m.romm_client = type('C', (), {
            'authenticated': True,
            'negotiate_sync': staticmethod(lambda dev, inv: ('s1', [
                {'action': 'upload', 'rom_id': 1, 'slot': 'autosave'}])),
            'upload_save': staticmethod(upload),
            'complete_sync_session': staticmethod(lambda *a, **k: True),
        })()
        m.settings = type('S', (), {'get': lambda self, *a: 'dev-1'})()
        m.build_sync_inventory = lambda: [{
            'rom_id': 1, 'slot': 'autosave', 'file_name': local_save.name,
            '_path': str(local_save),
            '_upload_name': m._upload_name(1, local_save, 'autosave')}]
        m.log = lambda *a, **k: None
        m.save_download_blocked = set()
        m.last_uploaded = {}
        m._activity_upload = lambda *a, **k: __import__('contextlib').nullcontext()
        m._save_upload_fingerprints = lambda *a, **k: None
        m.mark_all_synced = lambda *a, **k: None
        m._notify_sync_result = lambda *a, **k: None
        m.run_negotiated_save_sync()
        check('the background sync uploads as "autosave"', sent.get(1), 'autosave.srm')

        # Version restore names the file as RetroArch reads it here.
        retro = sync_core.RetroArchInterface.__new__(sync_core.RetroArchInterface)
        retro.save_dirs = {'saves': str(saves)}
        retro.get_save_files = lambda: {'saves': [{'name': local_save.name,
                                                   'path': str(local_save)}]}
        retro.get_save_subdir_mode = lambda kind: 'flat'
        entry = {'file_name': 'autosave [2026-09-30_10-00-00].srm', 'slot': 'autosave'}
        check('version restore keeps this device\'s name',
              retro.resolve_restore_dest(None, entry, 'saves', local_name=m._local_save_name(
                  1, entry['file_name'], 'autosave')),
              (saves, local_save.name))

        # An Eden save named by its ROM (Argosy) or "autosave" (Ludo) names no
        # title; the ROM's own ID from RomM's scan does.
        unpacked = {}
        sync_core.emulator_saves.eden_is_running = lambda: False
        sync_core.emulator_saves.unpack_save = lambda staged, tid, **kw: (
            unpacked.setdefault('tid', tid) and {'files': 1, 'backup': Path('b')})
        sync_core.cache_dir = lambda: tmp / 'cache'
        m = manager([{'rom_id': 9, 'platform_slug': 'switch',
                      'romm_data': {'title_id': '010093801237C800'}}])
        m.log = lambda *a, **k: None
        m.settings = type('S', (), {'get': lambda self, *a: ''})()

        def fetch(save_id, kind, target, **kw):
            import zipfile as _z
            with _z.ZipFile(target, 'w') as z:
                z.writestr('010093801237C000/save.bin', b'x')
            return True
        m.romm_client = type('C', (), {'download_save_by_id': staticmethod(fetch)})()
        m._restore_standalone_save({'rom_id': 9, 'save_id': 3,
                                    'file_name': 'Metroid Dread [2026-09-30_10-00-00].zip'},
                                   'dev-1', 's1')
        check('an untagged Switch save restores under the ROM\'s title',
              unpacked.get('tid'), '010093801237C000')

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all save-naming checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
