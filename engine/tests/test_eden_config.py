r"""Registering Eden's external-content folder.
`python3 engine/tests/test_eden_config.py`.

qt-config.ini is a QSettings file, not an INI a parser should round-trip: the
section names are percent-escaped, the keys carry backslashes, and nearly every
entry has a `\default=` shadow beside it. The fixture below is a trimmed copy of
a real one, and the point of most of these checks is the same: the file after a
registration is the file before it, plus the lines we meant to add and nothing
else.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import eden_config as E  # noqa: E402

# The registration guard refuses to write while Eden is up, because Eden
# serialises its whole config on exit and would silently drop the change. A
# developer with Eden open must not get a red suite for it.
E.eden_is_running = lambda: False

FAILURES = []

FIXTURE = """[Data%20Storage]
nand_directory\\default=false
nand_directory=/home/u/.local/share/eden/nand
ext_content_from_game_dirs\\default=true
ext_content_from_game_dirs=true

[UI]
Paths\\gamedirs\\size=1
Paths\\external_content_dirs\\size=0
Paths\\gamedirs\\1\\path=SDMC
Paths\\gamedirs\\1\\deep_scan=false
Paths\\romsPath=
Paths\\recentFiles="/games/a.nsp, /games/b.xci"

[Debugging]
record_frame_times=false
"""


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILURES.append(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")


def make_config(tmp, text=FIXTURE):
    path = Path(tmp) / 'qt-config.ini'
    path.write_text(text)
    return str(tmp)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp)
        check('an empty array reads as no directories',
              E.external_content_dirs(cfg), [])
        check('registering one reports ok',
              E.register_external_content_dir('/roms/switch/extcontent', cfg), 'ok')
        check('and it reads back',
              E.external_content_dirs(cfg), ['/roms/switch/extcontent'])
        check('a second registration of the same path is a no-op',
              E.register_external_content_dir('/roms/switch/extcontent', cfg), 'already')
        check('is_registered agrees',
              E.is_registered('/roms/switch/extcontent', cfg), True)
        check('a trailing slash is the same directory',
              E.is_registered('/roms/switch/extcontent/', cfg), True)
        check('an unrelated path is not registered',
              E.is_registered('/roms/switch', cfg), False)

        # The whole reason this edits by line: everything else must survive.
        after = (Path(tmp) / 'qt-config.ini').read_text()
        for line in FIXTURE.splitlines():
            if line.startswith('Paths\\external_content_dirs\\size'):
                continue
            if line and line not in after:
                FAILURES.append('preserved: ' + line)
                print(f"FAIL preserved: {line!r} was dropped")
        check('the quoted recentFiles value is untouched',
              'Paths\\recentFiles="/games/a.nsp, /games/b.xci"' in after, True)
        check('the size count was updated in place, not duplicated',
              after.count('Paths\\external_content_dirs\\size='), 1)

        check('a second directory appends rather than replacing',
              E.register_external_content_dir('/other/extcontent', cfg), 'ok')
        check('both are listed in order',
              E.external_content_dirs(cfg),
              ['/roms/switch/extcontent', '/other/extcontent'])

        check('a backup of Eden’s file was kept',
              (Path(tmp) / 'qt-config.ini.ludo-bak').is_file(), True)

    with tempfile.TemporaryDirectory() as tmp:
        check('no config at all is reported, not invented',
              E.register_external_content_dir('/roms/switch/extcontent', tmp),
              'no-config')
        check('and reading one yields nothing',
              E.external_content_dirs(tmp), [])

    with tempfile.TemporaryDirectory() as tmp:
        # A config with no [UI] section is a layout we do not recognise, and
        # the right response to that is to leave the file alone.
        cfg = make_config(tmp, "[Debugging]\nrecord_frame_times=false\n")
        before = (Path(tmp) / 'qt-config.ini').read_text()
        check('an unrecognised layout is refused',
              E.register_external_content_dir('/roms/switch/extcontent', cfg),
              'unreadable')
        check('and left byte-for-byte alone',
              (Path(tmp) / 'qt-config.ini').read_text(), before)

    with tempfile.TemporaryDirectory() as tmp:
        # [UI] as the last section: the bounds search has to run to EOF.
        cfg = make_config(tmp, "[UI]\nPaths\\gamedirs\\size=1\n")
        check('a trailing [UI] section still takes an entry',
              E.register_external_content_dir('/roms/switch/extcontent', cfg), 'ok')
        check('and reads back',
              E.external_content_dirs(cfg), ['/roms/switch/extcontent'])

    # --- player 1's controller binding ---------------------------------
    check('SDL GUID packs bus/vid/pid/version little-endian',
          E._sdl_guid(0x0005, 0x045e, 0x0b13, 0x0520),
          '050000005e040000130b000020050000')

    deck = {'guid': '03000000de280000ff11000001000000', 'name': 'Deck',
            'internal': True}
    pad = {'guid': '030000005e040000e002000003090000', 'name': 'Xbox',
           'internal': False}
    check('one pad attached is the pad to use', E.pick_controller([deck]), deck)
    # Several attached means a docked Deck, where the built-in sticks are the
    # device nobody is holding.
    check('an external pad beats the built-in controls',
          E.pick_controller([deck, pad]), pad)
    check('nothing attached picks nothing', E.pick_controller([]), None)

    bound = 'player_0_button_a="engine:sdl,port:0,guid:%s,button:1"\n'
    other = 'player_1_button_a="engine:sdl,port:1,guid:%s,button:1"\n'
    old_guid = '050000005e040000130b000020050000'
    cfg_text = ('[Controls]\n' + bound % old_guid + other % old_guid
                + 'player_0_lstick="engine:sdl,port:0,guid:%s,axis_x:0,'
                  'deadzone:0.150000"\n' % old_guid)

    with tempfile.TemporaryDirectory() as tmp:
        cfg = make_config(tmp, cfg_text)
        check('reads the GUID player 1 is bound to',
              E.player_one_guid(cfg), old_guid)

        # The pad in the config IS the pad attached: the common case, and the
        # reason this is safe to call before every launch.
        E.connected_gamepads = lambda: [{'guid': old_guid, 'name': 'Xbox BT',
                                         'internal': False}]
        check('a bound pad that is attached is left alone',
              E.ensure_player_one_controller(cfg), 'connected')
        check('and the file is untouched',
              (Path(tmp) / 'qt-config.ini').read_text(), cfg_text)

        E.connected_gamepads = lambda: []
        check('with no pad attached there is nothing to bind to',
              E.ensure_player_one_controller(cfg), 'no-pads')

        E.connected_gamepads = lambda: [deck]
        check('an absent bound pad is repointed',
              E.ensure_player_one_controller(cfg), 'ok')
        after = (Path(tmp) / 'qt-config.ini').read_text()
        check('player 1 now names the attached pad',
              after.count(deck['guid']), 2)
        check('the mapping itself is untouched',
              'axis_x:0,deadzone:0.150000' in after, True)
        check('player 2 keeps its own device',
              other % old_guid in after, True)
        check('and the original is backed up',
              (Path(tmp) / 'qt-config.ini.ludo-bak').is_file(), True)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failure(s): {', '.join(FAILURES)}")
        return 1
    print("all ok")
    return 0


if __name__ == '__main__':
    sys.exit(main())
