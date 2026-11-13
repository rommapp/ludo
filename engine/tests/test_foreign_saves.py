"""Saves made by other clients: whole PS2 cards (#74) and state naming (#60).

`python3 engine/tests/test_foreign_saves.py`, network stubbed. A whole card from
Argosy's built-in core must restore with a backup, and must not go back up as a
zip of the same progress on the next inventory, even after a restart.
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).parent))

from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import RetroArchInterface, RomMClient  # noqa: E402
import test_ps2_sync as T  # noqa: E402

FAILURES = T.FAILURES
check = T.check
GAMES = [{'rom_id': 7, 'name': 'Rogue', 'platform_slug': 'ps2', 'platform': 'PlayStation 2',
          'local_path': '/roms/ps2/Rogue.iso'}]


def cards(tmp):
    sync_core.cache_dir = lambda: tmp / 'cache'
    server = T.card_with(tmp / 'server.ps2', T.SAVE, 'BASCUS-97490LV5RG')
    return server


def card_restore(tmp):
    server = cards(tmp)
    local = tmp / 'saves' / 'Rogue.ps2'
    local.parent.mkdir(parents=True)
    other = {**T.SAVE, 'BASCUS-97490LV5RG_00/BASCUS-97490LV5RG_00': b'old' * 900}
    T.card_with(local, other, 'BASCUS-97490LV5RG')
    before = local.read_bytes()
    m = T.manager(tmp, GAMES, [local], server=server.read_bytes())
    op = {'rom_id': 7, 'save_id': 64, 'file_name': 'Rogue [2026-11-05_14-06-08].ps2',
          'emulator': 'armsx2'}
    check('a card op skips the plain file download',
          m._resolve_download_target(op, tmp / 'saves'), None)
    check('the card restores', m._restore_standalone_save(op, 'dev', 1), True)
    check('the card holds the server save', local.read_bytes(), server.read_bytes())
    check('the old card is backed up',
          Path(str(local) + '.backup').read_bytes() == before, True)

    packed = m._pack_ps2_card(local, 7)
    want = RomMClient.compute_content_hash(server)
    check('the untouched card reports the server hash', m._ps2_reported_hash(7, packed), want)
    m2 = T.manager(tmp, GAMES, [local], server=server.read_bytes())
    check('and still does after a restart', m2._ps2_reported_hash(7, packed), want)

    T.card_with(local, other, 'BASCUS-97490LV5RG')
    changed = m._pack_ps2_card(local, 7)
    check('new progress reports its own hash', m._ps2_reported_hash(7, changed),
          RomMClient.compute_content_hash(changed))


def card_refused(tmp):
    cards(tmp)
    (tmp / 'saves').mkdir()
    bad = T.manager(tmp, GAMES, [], server=b'not a card' * 100)
    op = {'rom_id': 7, 'save_id': 64, 'file_name': 'Rogue.ps2'}
    check('a damaged card is refused', bad._restore_ps2_card(op, 'dev', 1), False)
    busy = T.manager(tmp, GAMES, [], running=True, server=b'x')
    check('a restore waits for RetroArch', busy._restore_ps2_card(op, 'dev', 1), False)


def state_names():
    ra = RetroArchInterface.__new__(RetroArchInterface)
    for name in ('Game A [2026-10-31_22-59-44].autosave.state.auto',
                 'Game A [2026-10-31_22-59-44].state.auto'):
        check(f'{name} loads as the auto state',
              ra.convert_to_retroarch_filename(name, 'states', '/tmp'), 'Game A.state.auto')


def state_emulator():
    ra = RetroArchInterface.__new__(RetroArchInterface)
    ra.describe_core_resolution = lambda name, system_slug=None: {'resolved_core': 'fceumm'}
    m = T.AutoSyncManager.__new__(T.AutoSyncManager)
    m.retroarch = ra
    m.get_games = lambda: [{'rom_id': 3, 'platform': 'NES', 'platform_slug': 'nes'}]
    check('a flat state gets the core in use', m._state_emulator('/x/states/G.state', 3), 'fceumm')


def main():
    for fn in (card_restore, card_refused):
        with tempfile.TemporaryDirectory() as td:
            try:
                fn(Path(td))
            except Exception as e:
                check(f'{fn.__name__} raised', repr(e), None)
    for fn in (state_names, state_emulator):
        try:
            fn()
        except Exception as e:
            check(f'{fn.__name__} raised', repr(e), None)
    print(f"\n{len(FAILURES)} failure(s)")
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
