"""A Flatpak emulator is granted the ROM's folder for the run.

Run with `python3 engine/tests/test_flatpak_rom_grant.py`.

rommapp/ludo#34: Eden's Flatpak couldn't read ROMs under ~/Ludo and reported
"ROM format not supported".
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import RetroArchInterface, STANDALONE_EMULATORS  # noqa: E402


def main():
    ra = RetroArchInterface.__new__(RetroArchInterface)
    rom = '/home/deck/Ludo/roms/switch/Pokémon Legends Arceus/game.nsp'
    got = ra.build_standalone_launch_command(
        rom, 'eden', STANDALONE_EMULATORS['eden'], 'flatpak:dev.eden_emu.eden')
    want = ['flatpak', 'run',
            '--filesystem=/home/deck/Ludo/roms/switch/Pokémon Legends Arceus:ro',
            'dev.eden_emu.eden', '-f', '-g', rom]
    print('ok  ' if got == want else 'FAIL', got)
    return 0 if got == want else 1


if __name__ == '__main__':
    sys.exit(main())
