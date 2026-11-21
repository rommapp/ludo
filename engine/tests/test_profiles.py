"""Profiles: the store, Steam account detection, and which profile a launch opens."""
import configparser
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from romm_sync_engine import paths, profiles as P

LOGINUSERS = '''"users"
{
\t"76561197960265739"
\t{
\t\t"AccountName"\t\t"Covin90"
\t\t"PersonaName"\t\t"covin"
\t\t"MostRecent"\t\t"0"
\t\t"Timestamp"\t\t"1700000000"
\t}
\t"76561197960265740"
\t{
\t\t"AccountName"\t\t"mia.plays"
\t\t"PersonaName"\t\t"Mia \\"M\\""
\t\t"MostRecent"\t\t"1"
\t\t"Timestamp"\t\t"1700000100"
\t}
}
'''
COVIN, MIA = '11', '12'


class ProfilesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {'HOME': self.tmp.name}, clear=False)
        self.env.start()
        for k in ('SteamAppUser', 'SteamUser', 'SteamClientLaunch', 'LUDO_PROFILE'):
            os.environ.pop(k, None)
        paths._locked, paths._profile_locked, paths._profile = False, False, P.DEFAULT
        paths.set_app_id('ludo')
        paths.set_library_dir_name('Ludo')
        steam = self.home / '.local/share/Steam/config'
        steam.mkdir(parents=True)
        (steam / 'loginusers.vdf').write_text(LOGINUSERS)

    def tearDown(self):
        paths._locked, paths._profile_locked, paths._profile = False, False, P.DEFAULT
        self.env.stop()
        self.tmp.cleanup()

    def launch(self, **env):
        return P.resolve(env.pop('requested', None), env=env)

    def test_default_profile_is_the_existing_state_directory(self):
        self.assertEqual(paths.config_dir(), self.home / '.config/ludo')
        self.assertEqual(paths.cache_dir(), self.home / '.config/ludo/cache')
        self.assertIsNone(P.save_dirs(P.DEFAULT))
        self.assertEqual(self.launch(), {'id': P.DEFAULT, 'steam': None, 'ask': False})

    def test_other_profile_has_its_own_state_and_shares_the_machine(self):
        pid = P.create('Mia')
        paths._locked, paths._profile_locked, paths._profile = False, False, P.DEFAULT
        paths.set_profile(pid)
        self.assertEqual(paths.config_dir(), self.home / '.config/ludo/profiles' / pid)
        self.assertEqual(paths.cache_dir(), self.home / '.config/ludo/profiles' / pid / 'cache')
        self.assertEqual(paths.machine_cache_dir(), self.home / '.config/ludo/cache')
        self.assertEqual(P.save_dirs(pid)['saves'], self.home / 'Ludo/profiles' / pid / 'saves')

    def test_new_profile_copies_machine_settings_but_not_the_sign_in(self):
        src = configparser.ConfigParser()
        src['RomM'] = {'url': 'https://romm.example', 'client_token': 'secret'}
        src['Download'] = {'rom_directory': '/games', 'save_directory': '/old/saves'}
        src['BIOS'] = {'verify_on_launch': 'true'}
        src['Device'] = {'device_id': 'abc'}
        root = paths.config_dir()
        with (root / 'settings.ini').open('w') as f:
            src.write(f)
        pid = P.create('Mia')
        out = configparser.ConfigParser()
        out.read(paths.profile_dir(pid) / 'settings.ini')
        self.assertFalse(out.has_section('RomM'))
        self.assertFalse(out.has_section('Device'))
        self.assertEqual(out['Download']['rom_directory'], '/games')
        self.assertEqual(out['Download']['save_directory'], str(P.save_dirs(pid)['saves']))
        self.assertEqual(out['BIOS']['verify_on_launch'], 'true')

    def test_steam_account_comes_from_the_login_name_steam_passes(self):
        self.assertEqual(P.current_steam_account({'SteamAppUser': 'covin90', 'SteamClientLaunch': '1'}), COVIN)
        self.assertEqual(P.current_steam_account({'SteamAppUser': 'mia.plays'}), MIA)
        self.assertIsNone(P.current_steam_account({'SteamAppUser': 'stranger', 'SteamClientLaunch': '1'}))
        # No name but launched by Steam: the account Steam marks as signed in last.
        self.assertEqual(P.current_steam_account({'SteamClientLaunch': '1'}), MIA)
        # Not launched by Steam: no guess.
        self.assertIsNone(P.current_steam_account({}))
        self.assertEqual(P.steam_accounts()[MIA]['persona'], 'Mia "M"')

    def test_single_steam_account_without_recency_markers(self):
        # Seen on a real Bazzite client: no MostRecent/Timestamp written, and
        # Steam passed SteamAppUser but left SteamUser empty.
        (self.home / '.local/share/Steam/config/loginusers.vdf').write_text(
            '"users"\n{\n\t"76561197967547464"\n\t{\n\t\t"AccountName"\t\t"covin"\n\t}\n}\n')
        self.assertEqual(P.current_steam_account({'SteamAppUser': 'covin', 'SteamUser': '', 'SteamClientLaunch': '1'}), '7281736')
        self.assertEqual(P.current_steam_account({'SteamClientLaunch': '1'}), '7281736')

    def test_one_profile_never_asks(self):
        self.assertEqual(self.launch(SteamAppUser='mia.plays'), {'id': P.DEFAULT, 'steam': MIA, 'ask': False})

    def test_one_profile_links_the_steam_account_silently(self):
        self.launch(SteamAppUser='mia.plays')
        self.assertEqual(P.load()['steam'], {MIA: P.DEFAULT})
        # So a second profile later doesn't make this account pick again.
        P.create('Leo')
        self.assertEqual(self.launch(SteamAppUser='mia.plays'), {'id': P.DEFAULT, 'steam': MIA, 'ask': False})

    def test_link_steam_moves_the_account_between_profiles(self):
        leo = P.create('Leo')
        P.link_steam(P.DEFAULT, MIA)
        P.link_steam(leo, MIA)
        self.assertEqual(P.load()['steam'], {MIA: leo})
        with self.assertRaises(ValueError):
            P.link_steam('nope', MIA)
        with self.assertRaises(ValueError):
            P.link_steam(leo, '')

    def test_unlinked_steam_account_asks_once_then_remembers(self):
        mia = P.create('Mia')
        first = self.launch(SteamAppUser='mia.plays')
        self.assertEqual(first, {'id': P.DEFAULT, 'steam': MIA, 'ask': True})
        P.choose(mia, steam=MIA)
        # The switch itself is a one-shot, then the Steam link carries on.
        self.assertEqual(self.launch(SteamAppUser='mia.plays')['id'], mia)
        again = self.launch(SteamAppUser='mia.plays')
        self.assertEqual(again, {'id': mia, 'steam': MIA, 'ask': False})
        # Another Steam account is still asked, and offered the last profile.
        other = self.launch(SteamAppUser='covin90')
        self.assertEqual(other, {'id': mia, 'steam': COVIN, 'ask': True})

    def test_requested_profile_wins_over_the_steam_link(self):
        mia = P.create('Mia')
        P.choose(P.DEFAULT, steam=MIA)
        self.launch()  # use up the one-shot
        self.assertEqual(self.launch(SteamAppUser='mia.plays', requested='Mia')['id'], mia)
        self.assertEqual(self.launch(SteamAppUser='mia.plays', requested=mia)['id'], mia)
        # An unknown name falls through to the Steam link.
        self.assertEqual(self.launch(SteamAppUser='mia.plays', requested='nobody')['id'], P.DEFAULT)

    def test_switching_inside_the_app_beats_an_explicit_profile_once(self):
        mia = P.create('Mia')
        P.choose(mia)
        self.assertEqual(self.launch(requested=P.DEFAULT)['id'], mia)
        self.assertEqual(self.launch(requested=P.DEFAULT)['id'], P.DEFAULT)

    def test_desktop_launch_opens_the_last_profile_without_asking(self):
        mia = P.create('Mia')
        P.choose(mia)
        self.launch()
        self.assertEqual(self.launch(), {'id': mia, 'steam': None, 'ask': False})

    def test_remove_drops_links_and_state_but_not_the_default(self):
        mia = P.create('Mia')
        P.choose(mia, steam=MIA)
        self.launch()
        with self.assertRaises(ValueError):
            P.remove(P.DEFAULT)
        P.remove(mia)
        self.assertFalse(paths.profile_dir(mia).exists())
        data = P.load()
        self.assertEqual([p['id'] for p in data['profiles']], [P.DEFAULT])
        self.assertEqual(data['steam'], {})
        self.assertEqual(self.launch(SteamAppUser='mia.plays')['id'], P.DEFAULT)

    def test_cannot_remove_the_profile_in_use(self):
        mia = P.create('Mia')
        paths._locked, paths._profile_locked, paths._profile = False, False, P.DEFAULT
        paths.set_profile(mia)
        with self.assertRaises(ValueError):
            P.remove(mia)

    def test_damaged_store_falls_back_to_the_default_profile(self):
        (paths.machine_dir() / 'profiles.json').write_text('{not json')
        self.assertEqual(self.launch()['id'], P.DEFAULT)
        (paths.machine_dir() / 'profiles.json').write_text('{"profiles": [{"id": "../x"}], "last": "../x"}')
        self.assertEqual(self.launch()['id'], P.DEFAULT)

    def make_ra(self):
        from romm_sync_engine.sync_core import RetroArchInterface
        flatpak = 'org.libretro.RetroArch'
        cfg_dir = self.home / '.var/app' / flatpak / 'config/retroarch'
        cfg_dir.mkdir(parents=True)
        (cfg_dir / 'retroarch.cfg').write_text('savefile_directory = "~/Ludo/saves"\n'
                                               'savestate_directory = "~/Ludo/states"\n')
        ra = RetroArchInterface.__new__(RetroArchInterface)
        ra.settings = type('S', (), {'get': lambda self, s, k, d='': d})()
        ra._is_retrodeck_cache = None
        ra.is_retrodeck_installation = lambda: False
        ra.retroarch_executable = f'flatpak run {flatpak}'
        ra.flatpak_app_installed = lambda app_id: app_id == flatpak
        return ra, cfg_dir

    def test_second_profile_gives_retroarch_its_own_save_folders_per_launch(self):
        mia = P.create('Mia')
        paths._locked, paths._profile_locked, paths._profile = False, False, P.DEFAULT
        paths.set_profile(mia)
        ra, cfg_dir = self.make_ra()
        before = (cfg_dir / 'retroarch.cfg').read_text()
        own = P.save_dirs(mia)
        self.assertEqual(ra.expected_save_dir(), str(own['saves']))
        self.assertEqual(ra.find_retroarch_dirs(), own)
        self.assertTrue(own['saves'].is_dir())
        result = ra.align_retroarch_config()
        self.assertFalse(result['changed'])
        overlay = Path(ra._launch_overlay_config(None)).read_text()
        self.assertIn(f'savefile_directory = "{own["saves"]}"', overlay)
        self.assertIn(f'savestate_directory = "{own["states"]}"', overlay)
        self.assertEqual((cfg_dir / 'retroarch.cfg').read_text(), before)

    def test_retroarch_saving_the_overlay_on_exit_is_undone(self):
        # RetroArch writes appended values into retroarch.cfg on exit; a second
        # profile's folders must not become everyone's.
        mia = P.create('Mia')
        paths._locked, paths._profile_locked, paths._profile = False, False, P.DEFAULT
        paths.set_profile(mia)
        ra, cfg_dir = self.make_ra()
        cfg = cfg_dir / 'retroarch.cfg'
        before = cfg.read_text()
        ra._launch_overlay_config(None)
        own = P.save_dirs(mia)
        # What RetroArch saves on exit: the overlay's paths, '~'-abbreviated,
        # plus a menu change the user made during the session.
        rel = str(own['states']).replace(str(self.home), '~')
        lines = [l for l in before.splitlines()
                 if not l.startswith(('savefile_directory', 'savestate_directory'))]
        cfg.write_text('\n'.join(lines + [
            f'savefile_directory = "{own["saves"]}"',
            f'savestate_directory = "{rel}"',
            'video_smooth = "true"']) + '\n')
        ra.restore_overlaid_settings()
        after = cfg.read_text()
        self.assertNotIn('profiles', after)
        self.assertIn('video_smooth = "true"', after)
        for line in before.splitlines():
            if line.startswith(('savefile_directory', 'savestate_directory')):
                self.assertIn(line, after)
        self.assertFalse((cfg_dir / ra.OVERLAY_RESTORE_FILE).exists())

    def test_default_profile_keeps_retroarchs_own_folders(self):
        ra, cfg_dir = self.make_ra()
        self.assertEqual(ra.expected_save_dir(), str(self.home / 'Ludo/saves'))
        overlay = Path(ra._launch_overlay_config(None)).read_text()
        self.assertNotIn('savefile_directory', overlay)

    def test_steam_tiles_go_to_the_account_using_the_profile(self):
        from romm_sync_engine.sync_core import find_steam_config_dir
        userdata = self.home / '.local/share/Steam/userdata'
        for account in (COVIN, MIA):
            (userdata / account / 'config').mkdir(parents=True)
        # Without profiles: unchanged behaviour (some account is picked).
        self.assertIsNotNone(find_steam_config_dir())
        mia = P.create('Mia')
        P.launch = {'id': mia, 'steam': MIA, 'ask': False}
        try:
            self.assertEqual(find_steam_config_dir(), userdata / MIA / 'config')
            # Not launched by Steam: the account linked to the profile.
            P.choose(mia, steam=COVIN)
            P.launch = {'id': mia, 'steam': None, 'ask': False}
            paths._locked, paths._profile_locked, paths._profile = False, False, P.DEFAULT
            paths.set_profile(mia)
            self.assertEqual(find_steam_config_dir(), userdata / COVIN / 'config')
        finally:
            P.launch = None

    def test_ids_cannot_escape_the_profiles_folder(self):
        for bad in ('../x', '.hidden', 'a/b', ''):
            with self.assertRaises(ValueError):
                paths.set_profile(bad)


def main():
    result = unittest.TextTestRunner(verbosity=1).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(ProfilesTest))
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main())
