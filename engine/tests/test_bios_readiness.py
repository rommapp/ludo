"""BIOS readiness, and the PS2 launch setup that depends on it.

`python3 engine/tests/test_bios_readiness.py`. Uses a fake BiosManager whose
server-side firmware list is mutable, because the bug these cover is entirely
about ORDER: firmware uploaded to RomM after Ludo's first look at a platform.

The original failure, from a real log — a PS2 launch with no BIOS:

    23:27  Found platform 'PlayStation 2' with 0 firmware files
    23:27  All required BIOS already present    <- marked ready, wrongly
    (user uploads two BIOS files to RomM)
    23:46  Found platform 'PlayStation 2' with 2 firmware files
    23:46  BIOS scan complete: 1/3 platforms ready   <- sees it, does nothing
    23:46  core 'pcsx2' is missing required BIOS: [...]   <- launches anyway

Four defects, one group of checks each: an empty server list read as
"satisfied", a platforms_ready entry that could never be retracted, a scan that
diagnosed the gap without ever fetching anything, and — once those let the
download finally run — a platform matcher that resolved PS2 to the server's
PS1 entry, because 'playstation' is a substring of 'playstation 2'.

The later groups cover what getting a BIOS installed then exposed: lrps2 picks
its BIOS alphabetically (booting an NTSC disc on a PAL console), shares one
memory card between every PS2 game, and keeps those cards three directories
below the save root where the save scanner never looked.
"""

import sys
import tempfile
import threading
import time
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.bios_manager import BiosManager  # noqa: E402
from romm_sync_engine.sync_core import (  # noqa: E402
    AutoSyncManager, BiosTrackingManager, RetroArchInterface, _is_blank_save)

FAILURES = []
PS2 = 'Sony - PlayStation 2'


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILURES.append(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")


class FakeBios:
    """A BiosManager whose server list and local install are both settable.

    `server` is what RomM holds for the platform; `installed` is what is on
    disk. Downloads move files from the first to the second.
    """

    def __init__(self, server=(), installed=()):
        self.server = list(server)
        self.installed = set(installed)
        self.downloads = []
        self.deliver = None      # None = deliver everything; int = only N files

    def normalize_platform_name(self, name):
        return PS2

    def check_platform_bios(self, platform):
        present = [{'file': f} for f in self.server if f in self.installed]
        missing = [{'file': f, 'required': True, 'optional': False}
                   for f in self.server if f not in self.installed]
        return present, missing

    def auto_download_missing_bios(self, platform):
        wanted = [f for f in self.server if f not in self.installed]
        if not wanted:
            return True
        landing = wanted if self.deliver is None else wanted[:self.deliver]
        self.downloads.extend(landing)
        self.installed.update(landing)
        # Mirrors the real method: success when SOME file arrived, which is
        # why readiness must come from a re-check rather than this flag.
        return True


def make_tracker(fake):
    """A BiosTrackingManager wired to `fake`, without touching a real RomM."""
    tracker = BiosTrackingManager.__new__(BiosTrackingManager)
    tracker.retroarch = types.SimpleNamespace(bios_manager=fake)
    tracker.romm_client = object()
    tracker.available_games = [{'platform_slug': 'ps2', 'platform': PS2}]
    tracker.platform_slug_to_name = {'ps2': PS2}
    tracker.log = lambda msg: None
    tracker._lock = threading.Lock()
    tracker.downloads_in_progress = set()
    tracker.platforms_ready = set()
    tracker.download_failures = {}
    tracker.platform_status = {}
    tracker.running = False
    tracker.scan_thread = None
    return tracker


def scan(tracker, settle=0.5):
    """Run a library scan and wait for the downloads it spawns."""
    tracker.scan_library_bios()
    if tracker.scan_thread:
        tracker.scan_thread.join()
    time.sleep(settle)


def main():
    print("empty server list is ignorance, not readiness")
    fake = FakeBios(server=[])
    tracker = make_tracker(fake)
    tracker.trigger_downloads_for_games(
        [{'platform_slug': 'ps2', 'platform_name': PS2}])
    time.sleep(0.4)
    check('no firmware on server -> not ready', tracker.platforms_ready, set())

    print("\nthe original PS2 timeline: BIOS uploaded after the first check")
    fake.server = ['SCPH-70004_BIOS_V12_PAL_200.BIN', 'scph39001.bin']
    scan(tracker)
    check('late upload is fetched', sorted(fake.downloads),
          ['SCPH-70004_BIOS_V12_PAL_200.BIN', 'scph39001.bin'])
    check('platform becomes ready', tracker.platforms_ready, {'ps2'})

    print("\na satisfied platform is not re-downloaded")
    fake2 = FakeBios(server=['scph39001.bin'], installed=['scph39001.bin'])
    tracker2 = make_tracker(fake2)
    scan(tracker2)
    scan(tracker2)
    check('no redundant downloads', fake2.downloads, [])
    check('stays ready', tracker2.platforms_ready, {'ps2'})

    print("\na partial download does not count as ready")
    fake3 = FakeBios(server=['a.bin', 'b.bin'])
    fake3.deliver = 1
    tracker3 = make_tracker(fake3)
    scan(tracker3)
    check('only one file landed', sorted(fake3.installed), ['a.bin'])
    check('partial -> not ready', tracker3.platforms_ready, set())

    print("\nand the retry once the rest is available")
    fake3.deliver = None
    scan(tracker3)
    check('remainder fetched', sorted(fake3.installed), ['a.bin', 'b.bin'])
    check('now ready', tracker3.platforms_ready, {'ps2'})

    print("\nreadiness is retracted when files vanish from disk")
    fake4 = FakeBios(server=['scph39001.bin'], installed=['scph39001.bin'])
    tracker4 = make_tracker(fake4)
    scan(tracker4)
    check('ready while present', tracker4.platforms_ready, {'ps2'})
    fake4.installed.clear()          # user cleaned out the BIOS folder
    fake4.deliver = 0                # and the server can no longer supply it
    scan(tracker4)
    check('ready is retracted', tracker4.platforms_ready, set())

    print("\nplatform resolution does not collide PS1 with PS2")
    # The server list in the order RomM returned it in the real failure:
    # 'PlayStation' first, and 'playstation' is a substring of 'playstation 2'.
    # A bidirectional substring match resolved PS2 to the PS1 platform, looked
    # for the PS2 BIOS in PS1's firmware list, and gave up.
    server = [
        {'name': 'PlayStation', 'firmware': [{'id': 1, 'file_name': 'scph5500.bin'}]},
        {'name': 'PlayStation 2', 'firmware': [
            {'id': 9, 'file_name': 'scph39001.bin'},
            {'id': 10, 'file_name': 'SCPH-70004_BIOS_V12_PAL_200.BIN'}]},
    ]
    bios = BiosManager.__new__(BiosManager)
    bios.log = lambda msg: None
    bios.romm_client = None
    bios._fetch_platforms = lambda force=False: server

    def names(platform):
        return [f['file_name'] for f in (bios.get_server_firmware_for_platform(platform) or [])]

    check('PS2 resolves to PS2 firmware', names('Sony - PlayStation 2'),
          ['scph39001.bin', 'SCPH-70004_BIOS_V12_PAL_200.BIN'])
    check('PS1 resolves to PS1 firmware', names('Sony - PlayStation'),
          ['scph5500.bin'])
    # Same nesting hazard, different family — the comment in
    # get_server_firmware_for_platform names these explicitly.
    server.extend([
        {'name': 'Game Boy', 'firmware': [{'id': 2, 'file_name': 'gb_bios.bin'}]},
        {'name': 'Game Boy Color', 'firmware': [{'id': 3, 'file_name': 'gbc_bios.bin'}]},
    ])
    check('Game Boy Color is not Game Boy',
          names('Nintendo - Game Boy Color'), ['gbc_bios.bin'])
    check('Game Boy is not Game Boy Color',
          names('Nintendo - Game Boy'), ['gb_bios.bin'])

    print("\nthe download path fetches the right file for the right platform")
    written = {}

    class FakeResponse:
        status_code = 200

        def __init__(self, name):
            self.name = name

        def iter_content(self, chunk_size=8192):
            yield f"contents of {self.name}".encode()

    class FakeSession:
        def get(self, url, **kwargs):
            FakeSession.last_url = url
            return FakeResponse(url.rsplit('/', 1)[-1])

    bios.romm_client = types.SimpleNamespace(
        authenticated=True, session=FakeSession(),
        base_url='https://romm.example/')
    bios.system_dir = Path(tempfile.mkdtemp())
    bios.bios_target_path = lambda platform, name: (
        written.setdefault('path', bios.system_dir / name))

    ok = bios.download_bios_from_romm(PS2, 'scph39001.bin')
    check('PS2 BIOS downloads', ok, True)
    check('hit the PS2 firmware id, not PS1\'s',
          FakeSession.last_url, 'https://romm.example/api/firmware/9/content/scph39001.bin')
    check('file written', (bios.system_dir / 'scph39001.bin').exists(), True)

    check('a file the platform does not have is refused',
          bios.download_bios_from_romm(PS2, 'nope.bin'), False)
    check('an unknown platform is refused',
          bios.download_bios_from_romm('Atari - Jaguar', 'jag.bin'), False)

    print("\nlrps2 gets a BIOS matching the disc region")
    ra = RetroArchInterface.__new__(RetroArchInterface)
    bios_root = Path(tempfile.mkdtemp())
    ra.bios_manager = types.SimpleNamespace(system_dir=bios_root)
    cfg_root = Path(tempfile.mkdtemp())
    ra.find_retroarch_config_dir = lambda: str(cfg_root)

    # Two 4 MB dumps that differ only in their ROMVER region letter, plus the
    # noise a real BIOS folder carries: a PS1 BIOS and a stray .NVM.
    def romver(region, ver=b'0160', date=b'20020207'):
        blob = bytearray(b'\x00' * (4 * 1024 * 1024))
        blob[0x2d38:0x2d38 + 17] = b'PS2' + ver + region + b'C' + date
        return bytes(blob)

    (bios_root / 'SCPH-70004_BIOS_V12_PAL_200.BIN').write_bytes(romver(b'E'))
    (bios_root / 'scph39001.bin').write_bytes(romver(b'A'))
    (bios_root / 'scph5500.bin').write_bytes(b'\x00' * (512 * 1024))
    (bios_root / 'scph39001.NVM').write_bytes(b'\x00' * 1024)

    check('NTSC-U disc picks the America BIOS',
          ra._pick_ps2_bios('A'), 'scph39001.bin')
    check('PAL disc picks the Europe BIOS',
          ra._pick_ps2_bios('E'), 'SCPH-70004_BIOS_V12_PAL_200.BIN')
    check('a region with no BIOS installed picks nothing',
          ra._pick_ps2_bios('J'), '')

    check('SCUS serial is America',
          ra.PS2_SERIAL_REGIONS.get('SCUS'), 'A')
    check('SLES serial is Europe',
          ra.PS2_SERIAL_REGIONS.get('SLES'), 'E')

    # No serial readable (a .chd today): fall back to the filename tag.
    chd = Path(tempfile.mkdtemp()) / 'Some Game (Europe).chd'
    chd.write_bytes(b'not a disc')
    check('filename tag when the disc cannot be read',
          ra._ps2_disc_region(chd), 'E')
    unknown = chd.with_name('Some Game.chd')
    unknown.write_bytes(b'not a disc')
    check('no region rather than a guess', ra._ps2_disc_region(unknown), '')

    print("\nthe per-game option is written where RetroArch reads it")
    rom = Path(tempfile.mkdtemp()) / 'Rogue Galaxy (USA).iso'
    rom.write_bytes(b'')
    ra._ensure_ps2_bios(rom, '/x/pcsx2_libretro.so')
    opt = cfg_root / 'config' / 'LRPS2' / 'Rogue Galaxy (USA).opt'
    check('per-game .opt written under the core display name', opt.exists(), True)
    if opt.exists():
        check('names the America BIOS', opt.read_text().strip(),
              'pcsx2_bios = "scph39001.bin"')

    # A user's other options in that file must survive.
    opt.write_text('pcsx2_bios = "wrong.bin"\npcsx2_renderer = "Vulkan"\n')
    ra._ensure_ps2_bios(rom, '/x/pcsx2_libretro.so')
    check('rewrites our key, keeps theirs', opt.read_text().splitlines(),
          ['pcsx2_bios = "scph39001.bin"', 'pcsx2_renderer = "Vulkan"'])

    # Every other core is left completely alone.
    before = sorted(pth.name for pth in (cfg_root / 'config').rglob('*'))
    ra._ensure_ps2_bios(rom, '/x/flycast_libretro.so')
    check('non-pcsx2 cores untouched',
          sorted(pth.name for pth in (cfg_root / 'config').rglob('*')), before)

    print("\nPS2 memory cards are found and made per-game")
    saves_root = Path(tempfile.mkdtemp())
    # RetroDECK's real layout: the memcards dir is a symlink, three levels down.
    deep = saves_root / 'ps2' / 'retroarch-core' / 'LRPS2' / 'memcards'
    deep.mkdir(parents=True)
    (deep / 'Mcd001.ps2').write_bytes(b'\x00' * 64)
    (saves_root / 'n64').mkdir()
    (saves_root / 'n64' / 'Game (Europe).srm').write_bytes(b'\x00' * 16)
    linked = saves_root / 'linked'
    linked.symlink_to(deep)

    ra.save_dirs = {'saves': saves_root}
    seen = sorted(f['relative_path'] for f in ra.get_save_files()['saves'])
    check('the deep memory card is discovered',
          any(r.endswith('memcards/Mcd001.ps2') for r in seen), True)
    check('ordinary saves still found',
          any(r.endswith('Game (Europe).srm') for r in seen), True)
    # Followed through the symlink, but the same real file is not listed twice.
    check('a symlinked dir does not duplicate entries',
          len(seen), len(set(seen)))

    # A save folder pointed somewhere enormous must not be walked forever.
    depth_root = Path(tempfile.mkdtemp())
    node = depth_root
    for i in range(10):
        node = node / f'level{i}'
        node.mkdir()
    (node / 'Too Deep.srm').write_bytes(b'\x00')
    ra.save_dirs = {'saves': depth_root}
    deep_seen = [f['relative_path'] for f in ra.get_save_files()['saves']]
    check('the walk is depth-bounded', deep_seen, [])

    # A symlink loop must terminate rather than hang.
    loop_root = Path(tempfile.mkdtemp())
    (loop_root / 'sub').mkdir()
    (loop_root / 'sub' / 'back').symlink_to(loop_root)
    ra.save_dirs = {'saves': loop_root}
    check('a symlink loop terminates', ra.get_save_files()['saves'], [])

    ra._ensure_ps2_memcards(rom, '/x/pcsx2_libretro.so')
    check('per-content cards enabled for pcsx2',
          'pcsx2_shared_memory_cards = "disabled"' in opt.read_text(), True)
    check('the BIOS choice survives alongside it',
          'pcsx2_bios = "scph39001.bin"' in opt.read_text(), True)

    print("\na save with no data in it is not uploaded")
    blanks = Path(tempfile.mkdtemp())
    card = blanks / 'Blank Card.ps2'
    card.write_bytes(b'\x00' * (8 * 1024 * 1024))          # a fresh PS2 card
    check('an all-zero card is blank', _is_blank_save(card), True)
    ff = blanks / 'Erased.srm'
    ff.write_bytes(b'\xff' * 8192)                          # erased flash reads as FF
    check('an all-FF save is blank', _is_blank_save(ff), True)
    mixed = blanks / 'Mixed.ps2'
    mixed.write_bytes(b'\x00' * 4096 + b'\xff' * 4096)
    check('00 and FF together are still blank', _is_blank_save(mixed), True)

    # One byte of real data anywhere makes it a save, including deep in a
    # large file where an early-exit scan must not stop too soon.
    late = blanks / 'Late Data.ps2'
    late.write_bytes(b'\x00' * (4 * 1024 * 1024) + b'S' + b'\x00' * 1024)
    check('data late in a large file is found', _is_blank_save(late), False)
    real = blanks / 'Real.srm'
    real.write_bytes(b'SAVEDATA' * 64)
    check('an ordinary save is not blank', _is_blank_save(real), False)

    # Argosy's guard is a 100-byte floor; a full-size blank card passes it,
    # which is the whole reason this is a content test.
    check('the blank card is far above a size floor',
          card.stat().st_size > 100, True)

    empty = blanks / 'Zero.srm'
    empty.write_bytes(b'')
    check('a zero-length file is left to the size checks',
          _is_blank_save(empty), False)
    check('a directory is not a blank save', _is_blank_save(blanks), False)
    check('a missing file is not a blank save',
          _is_blank_save(blanks / 'nope.srm'), False)

    print("\nlarge saves are given longer to settle")
    auto = AutoSyncManager.__new__(AutoSyncManager)
    auto.upload_delay = 3
    check('a PS2-sized card waits longer', auto._settle_delay(card), 30)
    check('a small save keeps the short delay', auto._settle_delay(real), 3)
    check('an unreadable path falls back to the default',
          auto._settle_delay(blanks / 'gone.srm'), 3)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all BIOS readiness checks passed")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
