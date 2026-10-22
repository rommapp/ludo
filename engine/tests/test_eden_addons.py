"""Turning a Switch game's update or DLC off in Eden's config.

Run with `python3 engine/tests/test_eden_addons.py`.

rommapp/ludo#35. The section layout below is what Eden writes itself
(frontend_common/config.cpp), down to the \\default shadows.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import eden_config as E  # noqa: E402

E.eden_is_running = lambda: False

FAILURES = []

BASE = '0100152000022000'
OTHER = '0100000000010000'

CONFIG = f"""[DisabledAddOns]
size=1
1\\title_id\\default=false
1\\title_id={int(OTHER, 16)}
1\\disabled\\size=1
1\\disabled\\1\\d\\default=false
1\\disabled\\1\\d=SomeMod

[UI]
theme=default
"""


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


def fresh(tmp, text=CONFIG):
    (Path(tmp) / 'qt-config.ini').write_text(text, encoding='utf-8')
    return tmp


def main():
    with tempfile.TemporaryDirectory() as tmp:
        d = fresh(tmp)
        check('starts enabled', E.add_ons_enabled(BASE, d), {'update': True, 'dlc': True})
        check('other title read', E.disabled_add_ons(OTHER, d), ['SomeMod'])

        check('dlc off', E.set_add_on_enabled(BASE, 'dlc', False, d), 'ok')
        check('dlc off state', E.add_ons_enabled(BASE, d), {'update': True, 'dlc': False})
        check('dlc name', E.disabled_add_ons(BASE, d), ['DLC'])

        E.set_add_on_enabled(BASE, 'update', False, d)
        check('update off names', E.disabled_add_ons(BASE, d),
              ['DLC', 'Update', 'Update (NAND)', 'Update (SDMC)'])
        check('both off', E.add_ons_enabled(BASE, d), {'update': False, 'dlc': False})

        E.set_add_on_enabled(BASE, 'update', True, d)
        check('update back on', E.add_ons_enabled(BASE, d), {'update': True, 'dlc': False})
        check('other title kept', E.disabled_add_ons(OTHER, d), ['SomeMod'])

        text = (Path(d) / 'qt-config.ini').read_text()
        check('rest of file kept', text.endswith('\n[UI]\ntheme=default\n'), True)
        check('decimal title id', f"\\title_id={int(BASE, 16)}" in text, True)

    with tempfile.TemporaryDirectory() as tmp:
        # A per-version disable set in Eden's own dialog counts as "off", and
        # turning the update on clears it.
        d = fresh(tmp, CONFIG.replace('d=SomeMod', 'd=Update@131072').replace(
            str(int(OTHER, 16)), str(int(BASE, 16))))
        check('Update@ver is off', E.add_ons_enabled(BASE, d)['update'], False)
        E.set_add_on_enabled(BASE, 'update', True, d)
        check('Update@ver cleared', E.disabled_add_ons(BASE, d), [])

    with tempfile.TemporaryDirectory() as tmp:
        # Choosing one update among several in the folder: Eden applies the
        # newest one not disabled, so every other version gets disabled.
        d = fresh(tmp)
        versions = [65536, 393216, 262144]
        check('newest applies by default', E.selected_update(BASE, versions, False, d), 393216)
        check('pick older', E.set_update_choice(BASE, versions, 262144, d), 'ok')
        check('older disables the rest', E.disabled_add_ons(BASE, d),
              ['Update@393216', 'Update@65536'])
        check('older is selected', E.selected_update(BASE, versions, False, d), 262144)
        E.set_update_choice(BASE, versions, None, d)
        check('original game selected', E.selected_update(BASE, versions, True, d), None)
        check('original disables NAND too', 'Update (NAND)' in E.disabled_add_ons(BASE, d), True)
        E.set_update_choice(BASE, versions, E.UPDATE_NAND, d)
        check('NAND selected', E.selected_update(BASE, versions, True, d), E.UPDATE_NAND)
        E.set_update_choice(BASE, versions, 393216, d)
        check('back to newest', E.selected_update(BASE, versions, False, d), 393216)
        check('other titles untouched', E.disabled_add_ons(OTHER, d), ['SomeMod'])
        try:
            E.set_update_choice(BASE, versions, 1, d)
            check('unknown version refused', False, True)
        except ValueError:
            check('unknown version refused', True, True)

    with tempfile.TemporaryDirectory() as tmp:
        # An entry for a version no longer on disk is the user's, and stays.
        d = fresh(tmp, CONFIG.replace('d=SomeMod', 'd=Update@65536').replace(
            str(int(OTHER, 16)), str(int(BASE, 16))))
        E.set_update_choice(BASE, [393216], 393216, d)
        check('stale version entry kept', E.disabled_add_ons(BASE, d), ['Update@65536'])
        check('NAND only, nothing in the folder', E.selected_update(BASE, [], True, d), E.UPDATE_NAND)

    with tempfile.TemporaryDirectory() as tmp:
        d = fresh(tmp, "[UI]\ntheme=default\n")
        check('no section: write', E.set_add_on_enabled(BASE, 'dlc', False, d), 'ok')
        check('no section: read back', E.disabled_add_ons(BASE, d), ['DLC'])
        check('no section: UI kept',
              (Path(d) / 'qt-config.ini').read_text().endswith('[UI]\ntheme=default\n'), True)

    with tempfile.TemporaryDirectory() as tmp:
        d = fresh(tmp)
        E.eden_is_running = lambda: True
        check('refused while running', E.set_add_on_enabled(BASE, 'dlc', False, d), 'running')
        E.eden_is_running = lambda: False
        check('nothing written', (Path(d) / 'qt-config.ini').read_text(), CONFIG)

    with tempfile.TemporaryDirectory() as tmp:
        check('no config', E.set_add_on_enabled(BASE, 'dlc', False, tmp), 'no-config')

    with tempfile.TemporaryDirectory() as tmp:
        # Mods: one folder each under load_directory/<TITLE ID>, toggled by
        # folder name, one at a time.
        load = Path(tmp) / 'load'
        for mod in ('CTGP', '60fps', '.hidden'):
            (load / BASE / mod).mkdir(parents=True)
        d = fresh(tmp, CONFIG + f"\n[Data%20Storage]\nload_directory={load}\n")
        check('mod root from config', E.mod_load_root(d), load)
        check('mods listed', E.mods_for(BASE, d),
              [{'name': '60fps', 'enabled': True}, {'name': 'CTGP', 'enabled': True}])
        E.set_add_on_enabled(BASE, 'mod', False, d, name='CTGP')
        check('one mod off', E.mods_for(BASE, d),
              [{'name': '60fps', 'enabled': True}, {'name': 'CTGP', 'enabled': False}])
        check('mod off leaves update/dlc', E.add_ons_enabled(BASE, d), {'update': True, 'dlc': True})
        E.set_add_on_enabled(BASE, 'mod', True, d, name='CTGP')
        check('mod back on', E.disabled_add_ons(BASE, d), [])
        check('no mods for other title', E.mods_for(OTHER, d), [])

    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
