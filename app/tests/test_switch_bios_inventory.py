"""Switch BIOS rows reflect each key file, not just the presence of prod.keys."""
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest

from ludo_app.backend import LudoBackend
from ludo_app.host import HostProfile
from romm_sync_engine import emulator_saves


DESKTOP = HostProfile("1.0.0", "-x86_64.AppImage", Path("/tmp/desk-rt"), "desktop")
PROD_KEYS = b"""aes_kek_generation_source = 00000000000000000000000000000000
aes_key_generation_source = 11111111111111111111111111111111
header_key = 2222222222222222222222222222222222222222222222222222222222222222
master_key_00 = 33333333333333333333333333333333
"""
TITLE_KEYS = b"".join(
    f"{i:032x} = {'4' * 32}\n".encode() for i in range(1, 5)
)


@pytest.fixture
def backend(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("EDEN_DATA_DIR", raising=False)
    eden = tmp_path / ".local/share/eden"
    (eden / "nand/system/Contents/registered").mkdir(parents=True)
    (eden / "keys").mkdir()

    b = LudoBackend(host=DESKTOP)
    b._retroarch = mock.MagicMock()
    b._retroarch.describe_core_resolution.return_value = {"resolved_core": ""}
    b._romm_client = SimpleNamespace(authenticated=True)
    b._bios_dir = lambda: tmp_path / "bios"
    b._installed_bios_index = lambda: (set(), set())
    b._server_firmware = lambda force=False: {
        "switch": {
            "name": "Nintendo Switch",
            "files": [
                {"file_name": name, "size": len(content), "md5": digest,
                 "verified": True}
                for name, content, digest in (
                    ("prod.keys", PROD_KEYS, "a" * 32),
                    ("title.keys", TITLE_KEYS, "b" * 32),
                )
            ],
        }
    }
    return b


def test_key_rows_route_server_metadata_to_engine(backend, monkeypatch):
    current = mock.Mock(side_effect=[True, False])
    monkeypatch.setattr(emulator_saves, "keys_are_current", current)

    classify = backend._switch_bios_presence()
    assert classify is not None
    for row, expected in zip(
        backend._server_firmware()["switch"]["files"], (True, False)
    ):
        assert classify(row, "Firmware.22.5.0.zip") == (expected, False)
        assert current.call_args == mock.call({
            "file_name": row["file_name"], "md5_hash": row["md5"],
            "file_size_bytes": row["size"],
        })
    assert current.call_count == 2


def test_manual_key_files_have_independent_inventory_presence(backend, tmp_path):
    keys = tmp_path / ".local/share/eden/keys"
    (keys / "prod.keys").write_bytes(PROD_KEYS)
    assert emulator_saves.read_keys_marker() == {}

    inventory = backend._get_bios_inventory_blocking()
    assert inventory["success"] is True
    platform, = inventory["platforms"]
    assert platform["slug"] == "switch"
    assert {row["name"]: row["present"] for row in platform["files"]} == {
        "prod.keys": True, "title.keys": False,
    }
    assert all(not row["superseded"] for row in platform["files"])
    assert platform["missing_count"] == 1
    assert platform["missing_label"] == "keys"

    (keys / "title.keys").write_bytes(TITLE_KEYS)
    inventory = backend._get_bios_inventory_blocking()
    assert inventory["success"] is True
    platform, = inventory["platforms"]
    assert {row["name"]: row["present"] for row in platform["files"]} == {
        "prod.keys": True, "title.keys": True,
    }
    assert platform["missing_count"] == 0
    assert platform["missing_label"] == ""
    assert emulator_saves.read_keys_marker() == {}
