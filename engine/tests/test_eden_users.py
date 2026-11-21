"""Eden users per profile (#78): the user file, the mapping, scoped sync, -u."""
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from romm_sync_engine import eden_config, eden_users as U, emulator_saves as E, paths, profiles as P

COVIN = bytes(range(1, 17))          # first Eden user
SECOND = bytes(range(17, 33))        # another user already in Eden
TITLE = '0100152000022000'


def write_profiles_dat(data_dir, users):
    blob = bytearray(0x650)
    for slot, (raw, name) in enumerate(users):
        base = 0x10 + slot * 0xC8
        blob[base:base + 16] = raw
        blob[base + 16:base + 32] = raw
        blob[base + 0x28:base + 0x28 + len(name)] = name.encode()
    path = U.profiles_file(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(blob))


def make_save(data_dir, raw, title, content=b'save'):
    d = data_dir / 'nand/user/save' / ('0' * 16) / U.save_dir_name(raw.hex()) / title
    d.mkdir(parents=True, exist_ok=True)
    (d / 'data.bin').write_bytes(content)
    return d


class EdenUsersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {'HOME': self.tmp.name})
        self.env.start()
        os.environ.pop('EDEN_DATA_DIR', None)
        paths._locked, paths._profile_locked, paths._profile = False, False, P.DEFAULT
        paths.set_app_id('ludo')
        paths.set_library_dir_name('Ludo')
        self.data = self.home / '.local/share/eden'
        write_profiles_dat(self.data, [(COVIN, 'covin'), (SECOND, 'guest')])
        self.running = patch.object(E, 'eden_is_running', return_value=False)
        self.running.start()
        self.selected = patch.object(eden_config, '_setting', return_value='0')
        self.selected.start()
        P.launch = {'id': P.DEFAULT, 'steam': None, 'ask': False}

    def tearDown(self):
        P.launch = None
        self.selected.stop()
        self.running.stop()
        self.env.stop()
        self.tmp.cleanup()
        paths._locked, paths._profile_locked, paths._profile = False, False, P.DEFAULT

    def use(self, profile_id):
        paths._locked, paths._profile_locked, paths._profile = False, False, P.DEFAULT
        paths.set_profile(profile_id)

    def test_user_file_reads_and_save_folder_is_the_reversed_id(self):
        listed = U.users(self.data)
        self.assertEqual([(u['index'], u['name']) for u in listed], [(0, 'covin'), (1, 'guest')])
        self.assertEqual(listed[0]['save_dir'], COVIN[::-1].hex().upper())
        self.assertIsNone(U.users(self.home / 'nothing'))

    def test_adding_fills_the_first_free_slot_and_refuses_a_ninth(self):
        uuid = U.add(self.data, 'Mia')
        self.assertEqual(U.find(self.data, uuid)['index'], 2)
        self.assertEqual(U.find(self.data, uuid)['name'], 'Mia')
        self.assertEqual(U.add(self.data, 'Mia', uuid), uuid)   # idempotent
        self.assertEqual(len(U.users(self.data)), 3)
        for n in range(5):
            U.add(self.data, f'kid{n}')
        with self.assertRaises(U.EdenUsersError):
            U.add(self.data, 'one too many')

    def test_long_names_are_cut_on_a_character_boundary(self):
        uuid = U.add(self.data, 'é' * 40)
        self.assertEqual(U.find(self.data, uuid)['name'], 'é' * 16)

    def test_one_profile_changes_nothing(self):
        self.assertIsNone(P.eden_user())
        make_save(self.data, COVIN, TITLE)
        make_save(self.data, SECOND, '0100000000010000')
        self.assertEqual({s['title_id'] for s in E.find_eden_saves()}, {TITLE, '0100000000010000'})

    def test_each_profile_syncs_only_its_own_eden_user(self):
        mia = P.create('Mia')
        make_save(self.data, COVIN, TITLE, b'covin')
        make_save(self.data, SECOND, '0100000000010000', b'guest')
        # The first profile keeps the user Eden had selected.
        self.assertEqual(P.eden_user()['save_dir'], U.save_dir_name(COVIN.hex()))
        self.assertEqual([s['title_id'] for s in E.find_eden_saves()], [TITLE])
        # Mia gets her own Eden user, named after the profile, and sees none of covin's saves.
        self.use(mia)
        user = P.eden_user(create=True)
        self.assertEqual(U.find(self.data, user['uuid'])['name'], 'Mia')
        self.assertEqual(E.find_eden_saves(), [])
        # A save from her RomM account lands in her folder, not a guessed one.
        target = E.eden_restore_dir(TITLE)
        self.assertEqual(target.parent.name, user['save_dir'])
        make_save(self.data, bytes.fromhex(user['uuid']), TITLE, b'mia')
        [mine] = E.find_eden_saves()
        self.assertEqual((mine['path'] / 'data.bin').read_bytes(), b'mia')

    def test_launch_selects_the_profile_user(self):
        from romm_sync_engine.sync_core import RetroArchInterface
        mia = P.create('Mia')
        self.assertEqual(RetroArchInterface._eden_user_args('/usr/bin/eden'), ['-u', '0'])
        self.use(mia)
        self.assertEqual(RetroArchInterface._eden_user_args('/usr/bin/eden'), ['-u', '2'])

    def test_a_running_eden_or_a_missing_user_file_leaves_saves_alone(self):
        mia = P.create('Mia')
        self.use(mia)
        with patch.object(E, 'eden_is_running', return_value=True):
            self.assertIn('error', P.eden_user(create=True))
            self.assertEqual(E.find_eden_saves(), [])
        U.profiles_file(self.data).unlink()
        self.assertIn('error', P.eden_user(create=True))
        self.assertIsNone(E.eden_restore_dir(TITLE))

    def test_eden_never_started_gets_the_user_list_eden_would_make(self):
        from romm_sync_engine.sync_core import RetroArchInterface
        U.profiles_file(self.data).unlink()
        mia = P.create('Mia')
        flatpak = self.home / '.var/app/dev.eden_emu.eden/data/eden'
        # No Eden installed: nothing is written.
        with patch.object(E, 'eden_install_data_dir', return_value=None):
            self.use(mia)
            self.assertIn('error', P.eden_user(create=True))
        self.assertFalse(U.profiles_file(flatpak).exists())
        # Eden installed but closed and never run: Eden's own default user
        # ("Eden", kept by the first profile), then Mia's.
        self.assertEqual(RetroArchInterface._eden_user_args('flatpak:dev.eden_emu.eden'),
                         ['-u', '1'])
        self.assertEqual([u['name'] for u in U.users(flatpak)], ['Eden', 'Mia'])
        self.use(P.DEFAULT)
        self.assertEqual(RetroArchInterface._eden_user_args('flatpak:dev.eden_emu.eden'),
                         ['-u', '0'])
        # A save restored for Mia before Eden's first start lands in her folder.
        self.use(mia)
        user = P.eden_user(create=True)
        target = E.eden_restore_dir(TITLE)
        self.assertEqual(target.parent.name, user['save_dir'])
        # An existing list is never rewritten; a running Eden is never raced.
        before = U.profiles_file(flatpak).read_bytes()
        self.assertFalse(U.create_default(flatpak))
        self.assertEqual(U.profiles_file(flatpak).read_bytes(), before)
        other = self.home / 'other'
        with patch.object(E, 'eden_is_running', return_value=True):
            self.assertEqual(P._first_eden_user_list(other), [])
        self.assertFalse(other.exists())


def main():
    result = unittest.TextTestRunner(verbosity=1).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(EdenUsersTest))
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main())
