"""GameCube saves sync as Argosy's unit: all of a game's GCIs as one save.

Run with `python3 engine/tests/test_gamecube_sync.py`.

Dolphin (libretro core included) keeps each save a game writes as its own
.gci in "<user dir>/GC/<region>/Card A/". Argosy syncs a game's GCIs as one
save: one GCI raw, several as a flat zip of their names. Ludo reported each
GCI separately on (rom, "autosave"), so the dedupe kept one and dropped the
rest. Asserted here:

  * the card folder is discovered at the depth the core writes it;
  * a game's GCIs pack to a zip the SERVER hashes the same as Argosy's
    (names and bytes, not zip framing), and an unchanged unit packs to the
    same file; one GCI goes up raw; other games on the card stay out;
  * the inventory reports one entry per game, not one per GCI;
  * a restore replaces only that game's GCIs, keeps the old ones as backups,
    names a lone GCI as Dolphin does, refuses another game's save, and leaves
    the card hashing as the server's copy -- so the next sync is a no-op;
  * through the real background sync, a server zip lands in the card folder,
    one RetroArch would create when there is none yet.
"""
import datetime
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import gamecube_saves as G  # noqa: E402
from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import (AutoSyncManager, RetroArchInterface,  # noqa: E402
                                        RomMClient)

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


def gci(code, name, body=b'', maker=b'01'):
    head = bytearray(0x40)
    head[0:4] = code
    head[4:6] = maker
    head[8:8 + len(name)] = name
    return bytes(head) + (body or name * 64)


def write(folder, file_name, data):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / file_name).write_bytes(data)
    return folder / file_name


def argosy_zip(path, members):
    """A bundle the way Argosy's SaveArchiver.zipFiles writes it: stored
    entries, bare names, its own clock -- different bytes from ours."""
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_STORED) as z:
        for name, data in members.items():
            z.writestr(zipfile.ZipInfo(name, (2026, 1, 2, 3, 4, 6)), data)
    return path


MELEE_A = gci(b'GALE', b'SuperSmashBros0110290334')
MELEE_B = gci(b'GALE', b'SuperSmashBros0110290335', b'second' * 40)
ZELDA = gci(b'GZLE', b'gczelda')


class Retro:
    emulator_directory_map = {}

    def __init__(self, saves, mode='core'):
        self.save_dirs = {'saves': str(saves)}
        self.saves, self.mode = Path(saves), mode

    def get_save_files(self):
        out = []
        for d in RetroArchInterface._save_scan_dirs(self.saves):
            out += [{'path': str(p), 'name': p.name, 'modified': p.stat().st_mtime}
                    for p in sorted(d.glob('*')) if p.is_file()]
        return {'saves': out}

    def get_save_subdir_mode(self, kind):
        return self.mode

    def get_core_from_platform_slug(self, slug):
        return 'dolphin'

    def get_emulator_info_from_path(self, path):
        return {'romm_emulator': 'dolphin'}

    def convert_to_retroarch_filename(self, name, kind, target_dir, slot=None):
        return RetroArchInterface.convert_to_retroarch_filename(
            self, name, kind, target_dir, slot)


def manager(tmp, saves, games, mode='core'):
    m = AutoSyncManager.__new__(AutoSyncManager)
    m.get_games = lambda: games
    m.retroarch = Retro(saves, mode)
    m._launch_stems = {}
    m.last_uploaded = {}
    m.log = lambda *a, **k: None
    m.is_retroarch_running = lambda: False
    m.rom_id_for_save = lambda p: {'GALE': 1, 'GZLE': 2}.get(G.game_code(p))
    m.refresh_save_dirs = lambda: None
    m._eden_inventory_entries = lambda: []
    return m


def main():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        sync_core.cache_dir = lambda: tmp / 'cache'
        sync_core.emulator_saves.eden_data_dirs = lambda *a, **k: []
        saves = tmp / 'saves'
        card = saves / 'dolphin-emu' / 'User' / 'GC' / 'USA' / 'Card A'
        a = write(card, '01-GALE-SuperSmashBros0110290334.gci', MELEE_A)
        b = write(card, '01-GALE-SuperSmashBros0110290335.gci', MELEE_B)
        z = write(card, '01-GZLE-gczelda.gci', ZELDA)
        games = [{'rom_id': 1, 'platform_slug': 'ngc', 'is_downloaded': True},
                 {'rom_id': 2, 'platform_slug': 'ngc', 'is_downloaded': True}]

        # ── discovery and packing ─────────────────────────────────────
        found = {Path(e['path']).name for e in Retro(saves).get_save_files()['saves']}
        check('the card folder is discovered under core sorting',
              {a.name, b.name, z.name} <= found, True)
        check('a game\'s GCIs are its unit, by name', G.unit_members(b), [a, b])
        check('another game on the card is its own unit', G.unit_members(z), [z])

        m = manager(tmp, saves, games)
        packed = m._pack_gci_unit(G.unit_members(a), 1)
        check('several GCIs go up as a flat zip of their names',
              sorted(zipfile.ZipFile(packed).namelist()), [a.name, b.name])
        theirs = argosy_zip(tmp / 'argosy.zip', {a.name: MELEE_A, b.name: MELEE_B})
        check('the server hashes our zip as it hashes Argosy\'s',
              RomMClient.compute_content_hash(packed),
              RomMClient.compute_content_hash(theirs))
        before = (packed.stat().st_mtime_ns, packed.read_bytes())
        again = m._pack_gci_unit(G.unit_members(a), 1)
        check('an unchanged unit keeps its file',
              (again.stat().st_mtime_ns, again.read_bytes()), before)
        check('one GCI goes up as itself', m._pack_gci_unit([z], 2), z)

        # ── inventory ─────────────────────────────────────────────────
        inventory = m.build_sync_inventory()
        rows = sorted((e['rom_id'], e['slot'], e['file_name']) for e in inventory)
        check('one inventory entry per game, not per GCI', rows,
              [(1, 'autosave', 'GALE.zip'), (2, 'autosave', z.name)])
        newest = max(a.stat().st_mtime, b.stat().st_mtime)
        check('the unit is dated by its newest GCI',
              next(e['updated_at'] for e in inventory if e['rom_id'] == 1),
              datetime.datetime.fromtimestamp(newest, tz=datetime.timezone.utc).isoformat())

        # ── restore ───────────────────────────────────────────────────
        newer_a = gci(b'GALE', b'SuperSmashBros0110290334', b'newer' * 50)
        renamed = '01-GALE-SuperSmashBros0110290399.gci'
        incoming = argosy_zip(tmp / 'in.zip', {a.name: newer_a, renamed: MELEE_B})
        written = G.restore(incoming, card, 'GALE', backup_dir=tmp / 'bak')
        check('the restore writes the server\'s GCIs', written, [a, card / renamed])
        check('a GCI the server lacks is gone from the card', b.exists(), False)
        check('...and kept as a backup', any((tmp / 'bak').rglob(b.name)), True)
        check('another game on the card is untouched', z.read_bytes(), ZELDA)
        check('the card now hashes as the server copy',
              RomMClient.compute_content_hash(m._pack_gci_unit(G.unit_members(a), 1)),
              RomMClient.compute_content_hash(incoming))

        lone = write(tmp, 'Super Smash Bros. Melee (USA).gci', MELEE_B)
        G.restore(lone, card, 'GALE', name=G.dolphin_name(lone.read_bytes()))
        check('a lone GCI is named as Dolphin names it',
              sorted(p.name for p in card.glob('01-GALE-*')), [b.name])
        # A row from Ludo before it packed GCIs is ONE of the game's saves,
        # under Dolphin's own name: it replaces that save, not the others.
        write(card, a.name, MELEE_A)
        legacy = write(tmp, '01-GALE-SuperSmashBros0110290335 [2026-08-01_10-00-00].gci',
                       gci(b'GALE', b'SuperSmashBros0110290335', b'legacy' * 40))
        check('a legacy per-GCI row is recognised', G.is_dolphin_name(legacy.name), True)
        G.restore(legacy, card, 'GALE', name=G.dolphin_name(legacy.read_bytes()),
                  only_same=True)
        check('a legacy row keeps the game\'s other GCIs',
              sorted(p.name for p in card.glob('01-GALE-*')), [a.name, b.name])
        check('...and replaces its own', (card / b.name).read_bytes(), legacy.read_bytes())
        check('an Argosy lone upload is not a legacy row',
              G.is_dolphin_name('Super Smash Bros. Melee (USA).gci'), False)
        try:
            G.restore(argosy_zip(tmp / 'wrong.zip', {z.name: ZELDA}), card, 'GALE')
            refused = False
        except ValueError:
            refused = True
        check('another game\'s save is refused', refused, True)

        # ── the real background sync ──────────────────────────────────
        server = argosy_zip(tmp / 'server.zip', {a.name: MELEE_A, b.name: MELEE_B})
        for fresh_mode, expect in (('core', card),
                                   ('flat', saves / 'User' / 'GC' / 'USA' / 'Card A')):
            for f in card.glob('*.gci'):
                f.unlink()
            m = manager(tmp, saves, games, mode=fresh_mode)
            ops = [{'action': 'download', 'rom_id': 1, 'slot': 'autosave', 'save_id': 5,
                    'file_name': 'Super Smash Bros. Melee (USA) [2026-09-30_10-00-00].zip'}]

            def download(save_id, kind, target, **kw):
                Path(target).write_bytes(server.read_bytes())
                return True
            m.romm_client = type('C', (), {
                'authenticated': True,
                'negotiate_sync': staticmethod(lambda dev, inv: ('s1', ops)),
                'download_save_by_id': staticmethod(download),
                'complete_sync_session': staticmethod(lambda *a, **k: True),
            })()
            m.settings = type('S', (), {'get': lambda self, *a: 'dev-1'})()
            m.build_sync_inventory = lambda: []
            m.save_download_blocked = set()
            m._save_upload_fingerprints = lambda *a, **k: None
            m.mark_all_synced = lambda *a, **k: None
            m._notify_sync_result = lambda *a, **k: None
            summary = m.run_negotiated_save_sync()
            check(f'{fresh_mode}: the server zip is restored', summary.get('downloaded'), 1)
            check(f'{fresh_mode}: into the folder Dolphin reads',
                  sorted(p.name for p in expect.glob('*.gci')), [a.name, b.name])
            for f in expect.glob('*.gci'):
                if fresh_mode == 'flat':
                    f.unlink()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all GameCube sync checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
