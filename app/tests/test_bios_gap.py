"""#62: a core's firmware is matched on its path, never on its description."""
from pathlib import Path
from unittest import mock

import pytest

from ludo_app.backend import LudoBackend
from ludo_app.host import HostProfile

DESKTOP = HostProfile("1.0.0", "-x86_64.AppImage", Path("/tmp/desk-rt"), "desktop")
PATH = 'dolphin-emu/Sys/codehandler.bin'
DESC = f"Dolphin 'Sys' folder with {PATH}"
GAME = {'platform_slug': 'ngc'}


@pytest.fixture
def b(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    b = LudoBackend(host=DESKTOP)
    b._retroarch = mock.MagicMock()
    b._retroarch.describe_core_resolution.return_value = {'resolved_core': 'dolphin'}
    b._bios_dir = lambda: tmp_path / 'bios'
    b._server_firmware = lambda: {}
    b._required_firmware_for_core = lambda core: [(PATH, DESC)]
    return b


def test_present_file_is_not_missing(b):
    b._installed_bios_index = lambda: ({PATH.lower()}, {'codehandler.bin'})
    assert b._bios_gap(GAME, 'Nintendo GameCube') == {}


def test_missing_file_is_named_by_description(b):
    b._installed_bios_index = lambda: (set(), set())
    assert b._bios_gap(GAME, 'Nintendo GameCube')['missing_bios'] == [DESC]
