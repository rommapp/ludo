"""PS2 saves sync as Argosy-shaped zips, and restore into the game's own card.

Run with `python3 engine/tests/test_ps2_sync.py`.

LRPS2 keeps one card image per game; Argosy uploads a PS2 save as a zip of
the game's card folders. Ludo packs the card into that zip on the way up and
merges a zip back into the card on the way down, so the two can restore each
other's saves. Asserted here, with the network and the game list stubbed:

  * a game's card packs to a zip named after the save id read off the card,
    and packs to the same bytes when nothing changed;
  * a card holding no game's save, or several games', is not uploaded;
  * a PS2 zip from the server is routed away from the plain-file download;
  * a restore merges into an existing card, and when there is none, creates
    the card where the core will look for it;
  * a restore waits while RetroArch runs, and refuses a zip for several games;
  * a card the core rewrote without changing the save is not "pending".
"""
import io
import os
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import ps2_memcard as M  # noqa: E402
from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import AutoSyncManager  # noqa: E402

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


def zip_of(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        for name, data in entries.items():
            z.writestr(zipfile.ZipInfo(name, (2026, 9, 20, 18, 30, 0)), data)
    return buf.getvalue()


SAVE = {'BASCUS-97490LV5RG_00/icon.sys': b'PS2D' + bytes(960),
        'BASCUS-97490LV5RG_00/BASCUS-97490LV5RG_00': bytes(range(256)) * 40}


def card_with(path, entries, save_id):
    M.restore_zip(str(path), zip_of(entries), save_id)
    Path(str(path) + '.backup').unlink(missing_ok=True)
    return path


def contents(path):
    card = M.Card.open(path)
    return {f.name: {e.name: d for e, d in card.files(f)} for f in card.folders()}


class Retro:
    def __init__(self, saves, cards, mode='flat'):
        self.save_dirs = {'saves': str(saves)}
        self.cards, self.mode = cards, mode

    def get_save_files(self):
        return {'saves': [{'path': str(p), 'name': p.name} for p in self.cards]}

    def get_save_subdir_mode(self, save_type):
        return self.mode


def manager(tmp, games, cards=(), mode='flat', running=False, server=None):
    m = AutoSyncManager.__new__(AutoSyncManager)
    m.log = lambda *a, **k: m.logged.append(a[0])
    m.logged = []
    m.synced = []
    m._record_synced = lambda p: m.synced.append(p)
    m._launch_stems = {}
    m.get_games = lambda: games
    m.retroarch = Retro(tmp / 'saves', list(cards), mode)
    m.rom_id_for_save = lambda p: 7 if Path(p).stem.startswith('Rogue') else None
    m.is_retroarch_running = lambda: running

    def download(save_id, kind, target, **kw):
        Path(target).write_bytes(server)
        return True
    m.romm_client = type('C', (), {'download_save_by_id': staticmethod(download)})()
    return m


def main():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        sync_core.cache_dir = lambda: tmp / 'cache'
        roms = tmp / 'roms' / 'ps2'
        roms.mkdir(parents=True)
        (roms / 'Rogue Galaxy (USA).chd').write_bytes(b'disc')
        games = [{'rom_id': 7, 'platform_slug': 'ps2',
                  'local_path': str(roms / 'Rogue Galaxy (USA).chd')},
                 {'rom_id': 8, 'platform_slug': 'snes'}]

        # ── upload side ────────────────────────────────────────────────
        saves = tmp / 'saves' / 'ps2'
        saves.mkdir(parents=True)
        card = card_with(saves / 'Rogue Galaxy (USA).ps2', SAVE, 'BASCUS-97490')
        m = manager(tmp, games, [card])
        packed = m._pack_ps2_card(card, 7)
        check('a card packs to a zip named after its save id',
              packed.name, 'BASCUS-97490.zip')
        check('the zip holds the game folders',
              sorted(zipfile.ZipFile(packed).namelist()),
              ['BASCUS-97490LV5RG_00/', 'BASCUS-97490LV5RG_00/BASCUS-97490LV5RG_00',
               'BASCUS-97490LV5RG_00/icon.sys'])
        first = packed.read_bytes()
        check('an untouched card packs to the same bytes',
              m._pack_ps2_card(card, 7).read_bytes() == first, True)

        # The upload indicator asks whether a queued card differs from what
        # was synced. The core rewrites the card with a new mtime whether or
        # not the save changed, so that has to be a question of contents.
        m = manager(tmp, games, [card])
        m.last_uploaded = {}
        m._record_synced = AutoSyncManager._record_synced.__get__(m)
        m._record_synced(str(m._pack_ps2_card(card, 7)))
        os.utime(card, (1, 1))
        check('a card rewritten unchanged is not pending', m._activity_pending(str(card)), False)
        M.restore_zip(str(card), zip_of({'BASCUS-97490LV5RG_09/data': b'new slot'}), 'SCUS-97490')
        check('a card whose save changed is pending', m._activity_pending(str(card)), True)
        card.unlink()
        card = card_with(saves / 'Rogue Galaxy (USA).ps2', SAVE, 'BASCUS-97490')

        two = card_with(tmp / 'Two.ps2', {**SAVE, 'BASLUS-20152SYS/icon.sys': b'x'},
                        'BASCUS-97490')
        M.restore_zip(str(two), zip_of({'BASLUS-20152SYS/icon.sys': b'x'}), 'SLUS-20152')
        check('a card with two games is not uploaded', m._pack_ps2_card(two, 7), None)
        blank = tmp / 'Blank.ps2'
        blank.write_bytes(M.format_card())
        check('a card with no game save is not uploaded', m._pack_ps2_card(blank, 7), None)

        # ── routing ────────────────────────────────────────────────────
        zip_op = {'rom_id': 7, 'file_name': 'BASCUS-97490 [2026-09-27_18-00-00].zip',
                  'emulator': 'nethersx2', 'save_id': 1}
        check('a PS2 zip is recognised', m._is_ps2_zip_op(zip_op), True)
        check('a raw PS2 card is not', m._is_ps2_zip_op(
            dict(zip_op, file_name='Rogue Galaxy (USA).ps2')), False)
        check('another platform\'s zip is not',
              m._is_ps2_zip_op(dict(zip_op, rom_id=8)), False)
        check('the plain-file download stands aside for it',
              m._resolve_download_target(zip_op, str(tmp / 'saves')), None)

        # ── restore side ───────────────────────────────────────────────
        newer = {'BASCUS-97490LV5RG_00/icon.sys': b'PS2D' + bytes(960),
                 'BASCUS-97490LV5RG_00/BASCUS-97490LV5RG_00': b'newer' * 100,
                 'BASCUS-97490LV5RG_01/icon.sys': b'PS2D' + bytes(960)}
        m = manager(tmp, games, [card], server=zip_of(newer))
        check('restoring into the existing card succeeds',
              m._restore_ps2_save(zip_op, 'dev', 1), True)
        got = contents(card)
        check('the newer save replaced the old one',
              got['BASCUS-97490LV5RG_00']['BASCUS-97490LV5RG_00'], b'newer' * 100)
        check('a slot the server added is there too', 'BASCUS-97490LV5RG_01' in got, True)
        check('the card and its packed save are recorded as synced', m.synced,
              [str(card), str(tmp / 'cache' / 'ps2_saves' / '7' / 'BASCUS-97490.zip')])
        check('the old card is kept as .backup',
              Path(str(card) + '.backup').is_file(), True)

        for mode, want in [('flat', tmp / 'saves' / 'Rogue Galaxy (USA).ps2'),
                           ('core', tmp / 'saves' / 'LRPS2' / 'Rogue Galaxy (USA).ps2'),
                           ('content', tmp / 'saves' / 'ps2' / 'Rogue Galaxy (USA).ps2')]:
            m = manager(tmp, games, [], mode=mode)
            check(f'no card yet, {mode} sorting: where the core will look',
                  m._ps2_card_path(zip_op, str(tmp / 'saves')), want)
        m = manager(tmp, games, [], mode='core')
        m._launch_stems[7] = 'Rogue Galaxy (USA) (Disc 1)'
        check('the last launched file names the card',
              m._ps2_card_path(zip_op, str(tmp / 'saves')).name,
              'Rogue Galaxy (USA) (Disc 1).ps2')

        fresh = tmp / 'saves' / 'LRPS2' / 'Rogue Galaxy (USA).ps2'
        m = manager(tmp, games, [], mode='core', server=zip_of(SAVE))
        check('restoring with no card creates one',
              m._restore_ps2_save(zip_op, 'dev', 1), True)
        check('and it holds the save', sorted(contents(fresh)), ['BASCUS-97490LV5RG_00'])

        before = card.read_bytes()
        m = manager(tmp, games, [card], running=True, server=zip_of(newer))
        check('a restore waits while RetroArch runs',
              m._restore_ps2_save(zip_op, 'dev', 1), False)
        check('the card is untouched meanwhile', card.read_bytes() == before, True)

        m = manager(tmp, games, [card], server=zip_of(
            {**SAVE, 'BASLUS-20152SYS/icon.sys': b'x'}))
        check('a zip holding several games is refused',
              m._restore_ps2_save(zip_op, 'dev', 1), False)
        check('and the card is untouched', card.read_bytes() == before, True)

    print('\nall passed' if not FAILURES else f'\n{len(FAILURES)} FAILED')
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
