#!/usr/bin/env python3
"""Regressions: bare RomM platform names (#63), firmware zip with keys (#66),
per-game PS2 options under both core names (#61)."""
import sys
import tempfile
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from romm_sync_engine import emulator_saves as E      # noqa: E402
from romm_sync_engine import sync_core as C           # noqa: E402

R = C.RetroArchInterface
KEYS = ''.join(f'master_key_{i:02x} = ' + '00' * 16 + '\n' for i in range(16))


def test_bare_romm_names_find_a_core():
    r = R.__new__(R)
    r.platform_core_map = {}
    for name, core in (('Dreamcast', 'flycast'), ('Wii', 'dolphin'),
                       ('GameCube', 'dolphin'), ('Game Gear', 'genesis_plus_gx'),
                       ('Master System', 'genesis_plus_gx'), ('Arcade', 'fbneo'),
                       ('Neo Geo', 'fbneo'), ('Neo Geo Pocket', 'beetle_ngp')):
        assert r._guess_core_for_platform(name, {core: '/x.so'})[0] == core, name


def test_firmware_zip_with_keys_is_firmware():
    with tempfile.TemporaryDirectory() as d:
        both = Path(d) / 'fw.zip'
        with zipfile.ZipFile(both, 'w') as z:
            z.writestr('prod.keys', KEYS)
            z.writestr('a.nca', b'N' * 32)
        assert E.identify_upload(both) == 'firmware'
        keys = Path(d) / 'k.zip'
        with zipfile.ZipFile(keys, 'w') as z:
            z.writestr('prod.keys', KEYS)
        assert E.identify_upload(keys) == 'keys'


def test_ps2_options_written_under_both_core_names():
    with tempfile.TemporaryDirectory() as d:
        r = R.__new__(R)
        with mock.patch.object(R, 'find_retroarch_config_dir', return_value=d):
            r._ensure_ps2_memcards('/roms/Game.cue', '/cores/pcsx2_libretro.so')
        for name in ('LRPS2', 'ParaLLEl PS2'):
            text = (Path(d) / 'config' / name / 'Game.opt').read_text()
            assert 'pcsx2_shared_memory_cards = "disabled"' in text


def main():
    for test in (test_bare_romm_names_find_a_core,
                 test_firmware_zip_with_keys_is_firmware,
                 test_ps2_options_written_under_both_core_names):
        test()
        print(f'ok   {test.__name__}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
