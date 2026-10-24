"""Wii U updates and DLC, put where Cemu looks for them.

Run with `python3 engine/tests/test_wiiu_addons.py`.

Cemu applies an update (title id 0005000e...) or DLC (0005000c...) it finds in
its mlc01/usr/title, matched to the base game by title id. A game's own
update/ and dlc/ folders are copied there before it launches.
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import (  # noqa: E402
    cemu_mlc_dirs, find_wiiu_addons, install_wiiu_addons, remove_wiiu_addons,
    RetroArchInterface, STANDALONE_EMULATORS)

FAILED = []


def check(name, cond):
    print(('PASS ' if cond else 'FAIL ') + name)
    if not cond:
        FAILED.append(name)


def title(root, tid, version='16'):
    (root / 'meta').mkdir(parents=True)
    (root / 'content').mkdir()
    (root / 'meta' / 'meta.xml').write_text(
        f'<menu><title_id type="hexBinary" length="8">{tid}</title_id>'
        f'<title_version type="unsignedInt">{version}</title_version></menu>')
    (root / 'content' / 'a.bin').write_text(version)


def main():
    tmp = Path(tempfile.mkdtemp())
    game = tmp / 'roms' / 'wiiu' / 'Game'
    title(game / 'base', '00050000101C9400')          # the base game
    title(game / 'update' / 'u', '0005000E101C9400')
    title(game / 'dlc' / 'd', '0005000C101C9400')
    (game / 'Game.wua').write_text('x')
    mlc = tmp / 'mlc01'

    found = {(k, hi, lo) for _, k, hi, lo in find_wiiu_addons(game)}
    check('finds the update and the DLC, not the base game',
          found == {('update', '0005000e', '101c9400'),
                    ('dlc', '0005000c', '101c9400')})

    done = install_wiiu_addons(game, mlc)
    check('installs both into mlc by title id', len(done) == 2
          and (mlc / 'usr/title/0005000e/101c9400/meta/meta.xml').is_file()
          and (mlc / 'usr/title/0005000c/101c9400/content/a.bin').is_file())
    check('installing again changes nothing', install_wiiu_addons(game, mlc) == [])

    (game / 'update' / 'u' / 'meta' / 'meta.xml').write_text(
        '<menu><title_id type="hexBinary" length="8">0005000E101C9400</title_id>'
        '<title_version type="unsignedInt">32</title_version></menu>')
    check('a newer update replaces the old one',
          len(install_wiiu_addons(game, mlc)) == 1 and '32' in
          (mlc / 'usr/title/0005000e/101c9400/meta/meta.xml').read_text())

    # One the user installed themselves must survive a delete.
    other = tmp / 'mlc2'
    title(other / 'usr/title/0005000c/101c9400', '0005000C101C9400', version='99')
    check('remove leaves a copy that is not ours',
          remove_wiiu_addons(game, other) == []
          and (other / 'usr/title/0005000c/101c9400').is_dir())
    check('remove takes back ours',
          len(remove_wiiu_addons(game, mlc)) == 2
          and not (mlc / 'usr/title/0005000e/101c9400').exists())

    check('no add-ons, nothing found', find_wiiu_addons(tmp / 'nowhere') == [])

    # The launch installs them, but not from the shared platform folder.
    home = tmp / 'home'
    os.environ['HOME'] = str(home)
    os.environ.pop('XDG_DATA_HOME', None)
    os.environ.pop('XDG_CONFIG_HOME', None)
    ra = RetroArchInterface.__new__(RetroArchInterface)
    spec = STANDALONE_EMULATORS['cemu']
    ra.build_standalone_launch_command(str(game / 'Game.wua'), 'cemu', spec,
                                    'flatpak:info.cemu.Cemu')
    check('launching installs into the flatpak mlc',
          (home / '.var/app/info.cemu.Cemu/data/Cemu/mlc01/usr/title/'
           '0005000e/101c9400').is_dir())
    top = tmp / 'roms' / 'wiiu'
    (top / 'Lone.wua').write_text('x')
    before = sorted(p for p in (home / '.var').rglob('*'))
    ra.build_standalone_launch_command(str(top / 'Lone.wua'), 'cemu', spec,
                                    'flatpak:info.cemu.Cemu')
    check('a lone image in the platform folder installs nothing',
          sorted(p for p in (home / '.var').rglob('*')) == before)
    check('mlc guess: flatpak first for a flatpak build',
          'info.cemu.Cemu' in str(cemu_mlc_dirs('flatpak:info.cemu.Cemu')[0]))

    print()
    print('FAILED: ' + ', '.join(FAILED) if FAILED else 'all passed')
    return 1 if FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
