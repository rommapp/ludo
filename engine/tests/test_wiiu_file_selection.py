"""Which files of a Wii U folder game a download takes.

Run with `python3 engine/tests/test_wiiu_file_selection.py`.

Mirrors argosy's resolveSelection: `game` always, top-level uncategorised files
unless they are notes, everything else by its category's default.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import select_download_files  # noqa: E402

FAILED = []


def check(name, cond):
    print(('PASS ' if cond else 'FAIL ') + name)
    if not cond:
        FAILED.append(name)


def f(i, name, cat, path='/g'):
    return {'id': i, 'file_name': name, 'category': cat, 'file_path': path}


FILES = [
    f(1, 'game.wua', 'game'),
    f(2, 'upd.wua', 'update', '/g/update'),
    f(3, 'dlc.wua', 'dlc', '/g/dlc'),
    f(4, 'mod.zip', 'mod', '/g/mods'),
    f(5, 'manual.pdf', 'manual', '/g/manual'),
    f(6, 'readme.nfo', None),
    f(7, 'extra.bin', None, '/g/misc/deeper'),
]


def main():
    check('factory: game, update, dlc, manual taken; mod, notes, nested other left',
          select_download_files(FILES) == [1, 2, 3, 5])
    check('mods switched on',
          select_download_files(FILES, {'mod': True}) == [1, 2, 3, 4, 5])
    check('dlc switched off',
          select_download_files(FILES, {'dlc': False}) == [1, 2, 5])
    check('other switched on takes the note and the nested uncategorised file',
          select_download_files(FILES, {'other': True}) == [1, 2, 3, 5, 6, 7])
    check('everything wanted -> None (download the folder as it is)',
          select_download_files(FILES, {'mod': True, 'other': True}) is None)
    check('a single file is never filtered',
          select_download_files([f(1, 'game.wua', 'game')]) is None)
    check('no files', select_download_files([]) is None)
    check('only add-ons and nothing selectable -> None',
          select_download_files([f(1, 'a', 'mod'), f(2, 'b', 'hack')]) is None)
    print()
    print('FAILED: ' + ', '.join(FAILED) if FAILED else 'all passed')
    return 1 if FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
