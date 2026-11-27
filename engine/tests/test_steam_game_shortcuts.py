"""Per-game Steam shortcuts (#105): shortcuts.vdf entries, artwork, registry.

Run with `python3 engine/tests/test_steam_game_shortcuts.py`.

Against a scratch Steam config dir and library dir:

  * adding a game writes one tagged entry with --launch=<id>, art and an icon;
  * re-adding updates in place and keeps LastPlayTime;
  * a second game with the same title gets a distinct name and appid;
  * other shortcuts (the Ludo tile, the user's own) are left alone;
  * removing drops the entry and its art; removing a game without one is a no-op;
  * forget_games removes desktop shortcuts and queues the Deck's for removal,
    and acknowledging a removal clears it.
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import steam_game_shortcuts as sgs  # noqa: E402
from romm_sync_engine.sync_core import SteamVDFHandler  # noqa: E402

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        config = tmp / 'steam' / 'config'
        config.mkdir(parents=True)
        lib = tmp / 'lib'
        sgs.find_steam_config_dir = lambda: config
        sgs.library_dir = lambda: lib
        sgs.is_steam_running = lambda: False

        from PIL import Image
        cover = tmp / 'cover.png'
        Image.new('RGB', (300, 400), (200, 40, 40)).save(cover)

        vdf = config / 'shortcuts.vdf'
        SteamVDFHandler.write_shortcuts(vdf, [
            {'appid': SteamVDFHandler.calculate_appid('"ludo"', 'Ludo'),
             'AppName': 'Ludo', 'Exe': '"ludo"', 'tags': ['romm-sync-desktop']},
            {'appid': SteamVDFHandler.calculate_appid('"/usr/bin/foo"', 'Foo'),
             'AppName': 'Foo', 'Exe': '"/usr/bin/foo"', 'tags': []},
        ])

        exe = '"/opt/Ludo.AppImage"'
        r = sgs.add_game_shortcut(42, 'Zelda', exe, launch_options='--launch=42',
                                  cover_path=cover, platform_name='SNES')
        check('add ok', r['success'], True)
        check('add created', r['created'], True)
        scs = SteamVDFHandler.read_shortcuts(vdf)
        check('three shortcuts', len(scs), 3)
        _, sc = sgs.find_game_shortcut(scs, 42)
        check('found by rom id', sc is not None, True)
        check('name', sc['AppName'], 'Zelda')
        check('launch options', sc['LaunchOptions'], '--launch=42')
        check('appid', sc['appid'], SteamVDFHandler.calculate_appid(exe, 'Zelda'))
        u = sc['appid'] + 0x100000000
        for suffix in sgs.ART_SUFFIXES.values():
            check(f'art {suffix}', (config / 'grid' / f'{u}{suffix}').is_file(), True)
        check('icon field', sc['icon'], str(config / 'grid' / f'{u}_icon.png'))
        check('status installed', sgs.game_shortcut_status(42)['installed'], True)
        check('status other', sgs.game_shortcut_status(7)['installed'], False)

        # Steam stamps play time; a re-add must keep it.
        scs[2]['LastPlayTime'] = 1234
        SteamVDFHandler.write_shortcuts(vdf, scs)
        r = sgs.add_game_shortcut(42, 'Zelda', exe, launch_options='--launch=42',
                                  cover_path=cover)
        check('re-add updates', r['created'], False)
        scs = SteamVDFHandler.read_shortcuts(vdf)
        check('still three', len(scs), 3)
        check('play time kept', sgs.find_game_shortcut(scs, 42)[1]['LastPlayTime'], 1234)

        r = sgs.add_game_shortcut(43, 'Zelda', exe, launch_options='--launch=43',
                                  cover_path=None, platform_name='SNES')
        scs = SteamVDFHandler.read_shortcuts(vdf)
        sc43 = sgs.find_game_shortcut(scs, 43)[1]
        check('same title renamed', sc43['AppName'], 'Zelda (SNES)')
        check('distinct appid', sc43['appid'] != sgs.find_game_shortcut(scs, 42)[1]['appid'], True)
        check('no cover, no icon', sc43['icon'], '')
        check('desktop ids', sgs.desktop_shortcut_rom_ids(), {42, 43})

        r = sgs.remove_game_shortcuts([42])
        check('remove count', r['removed'], 1)
        scs = SteamVDFHandler.read_shortcuts(vdf)
        check('tile and user shortcut kept', {s['AppName'] for s in scs},
              {'Ludo', 'Foo', 'Zelda (SNES)'})
        check('art deleted', any((config / 'grid').glob(f'{u}*')), False)
        check('remove missing no-op', sgs.remove_game_shortcuts([999])['removed'], 0)

        # Deck registry.
        sgs.registry_set(43, -12345)
        sgs.registry_set(50, -555)
        check('registry get', sgs.registry_get(50), -555)
        check('registry all', sgs.registry_all(), {43: -12345, 50: -555})
        out = sgs.forget_games([43, 50])
        check('forget removed desktop', out['removed'], 1)
        check('forget queued deck', out['queued'], 2)
        check('pending', sgs.pending_removals(), {43: -12345, 50: -555})
        check('registry emptied', sgs.registry_rom_ids(), set())
        sgs.registry_set(50, None)
        check('ack clears pending', sgs.pending_removals(), {43: -12345})
        check('forget nothing', sgs.forget_games([]), {'removed': 0, 'queued': 0})

        art = sgs.render_art_bytes(cover)
        check('art bytes keys', sorted(art), sorted(sgs.ART_SUFFIXES))
        check('art is png', art['portrait'][:4], b'\x89PNG')

    if FAILURES:
        print(f"\n{len(FAILURES)} FAILED: {FAILURES}")
        return 1
    print("\nall ok")
    return 0


if __name__ == '__main__':
    sys.exit(main())
