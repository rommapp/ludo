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

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all save-naming checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
