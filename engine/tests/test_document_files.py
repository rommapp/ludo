"""A document attached to a game is not one of the game's files.

Run with `python3 engine/tests/test_document_files.py`.

RomM 5.3.0 files a walkthrough on a game the way manuals already were: as a
RomFile row with `category='walkthrough'`, sitting in the rom's `files` array
next to the game itself. That array is what Ludo counts to decide whether a rom
is a folder, so uploading a walkthrough silently took a plain single-file game
to two files — and it would have been downloaded as a FOLDER, handing the
emulator a directory where it expects a .nds and a .txt it cannot use.

Measured on a real 5.3.0 rom (The Legend of Zelda: Phantom Hourglass, one .nds
plus an uploaded walkthrough): the server itself reports has_multiple_files
False while `files` has two entries.

These lock in which categories count as game content. The distinction is not
"extras are excluded" — dlc, update, patch and friends are real files Ludo
downloads. It is that documents and media are ABOUT the game rather than part
of it.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import (  # noqa: E402
    game_files, rom_has_multiple_files,
)

FAILURES = []


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


def names(rom):
    return [f['file_name'] for f in game_files(rom)]


def main():
    # The real shape, as the server returns it.
    zelda = {
        'has_multiple_files': False,
        'files': [
            {'file_name': 'Zelda - Phantom Hourglass.nds', 'category': 'game',
             'is_top_level': True},
            {'file_name': 'zelda phantom hourglass.txt', 'category': 'walkthrough',
             'is_top_level': False},
        ],
    }
    check("walkthrough dropped", names(zelda), ['Zelda - Phantom Hourglass.nds'])
    # The bug this exists to prevent: two files in the array, one game.
    check("still not a folder",
          rom_has_multiple_files(zelda) or len(game_files(zelda)) > 1, False)

    docs = {'files': [
        {'file_name': 'game.nds', 'category': 'game'},
        {'file_name': 'manual.pdf', 'category': 'manual'},
        {'file_name': 'guide.txt', 'category': 'walkthrough'},
        {'file_name': 'ost-01.flac', 'category': 'soundtrack'},
        {'file_name': 'title.png', 'category': 'screenshot'},
    ]}
    check("every document category dropped", names(docs), ['game.nds'])

    # Real game content keeps its place, whatever it is called.
    extras = {'files': [
        {'file_name': 'base.nsp', 'category': 'game'},
        {'file_name': 'update.nsp', 'category': 'update'},
        {'file_name': 'dlc.nsp', 'category': 'dlc'},
        {'file_name': 'patch.ips', 'category': 'patch'},
        {'file_name': 'translation.ips', 'category': 'translation'},
    ]}
    check("game content kept", len(game_files(extras)), 5)

    # A pre-5.3.0 server labels nothing, and had no documents to tell apart.
    unlabelled = {'files': [{'file_name': 'disc1.chd'}, {'file_name': 'disc2.chd'}]}
    check("unlabelled files are game files", len(game_files(unlabelled)), 2)
    check("a real multi-disc rom is still a folder",
          len(game_files(unlabelled)) > 1, True)
    check("category None is a game file",
          len(game_files({'files': [{'file_name': 'x.iso', 'category': None}]})), 1)

    check("no files at all", game_files({}), [])
    check("null files", game_files({'files': None}), [])
    # Case is the server's to choose, not ours to depend on.
    check("category case ignored",
          names({'files': [{'file_name': 'g.nds', 'category': 'GAME'},
                           {'file_name': 'w.txt', 'category': 'Walkthrough'}]}),
          ['g.nds'])

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all document-file checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
