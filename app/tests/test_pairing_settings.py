"""Pairing must work before the sync managers exist.

The setup wizard reaches the backend on a plugin that has never connected, and
_start_sync() — the only thing that used to assign _settings — returns early
whenever sync_core failed to import or a retry thread is already running. Every
other caller in the backend guards with `if self._settings`; the pairing routes
read it outright, so QR pairing failed on the wizard's first step with a bare
"'NoneType' object has no attribute 'get'" and no hint of where it came from.

Run with:  pytest app/tests
"""
import asyncio
from pathlib import Path

import pytest

from ludo_app import backend as backend_mod
from ludo_app.backend import LudoBackend
from ludo_app.host import HostProfile

DESKTOP = HostProfile("1.0.0", "-x86_64.AppImage", Path("/tmp/desk-rt"), "desktop")

DEVICE_AUTH = {
    "device_code": "dc",
    "user_code": "AB12CD34",
    "verification_path_complete": "/pair/device?user_code=AB12CD34",
    "expires_in": 600,
    "interval": 5,
}


@pytest.fixture
def unstarted(monkeypatch, tmp_path):
    """A backend whose _start_sync() never ran, talking to a stub RomM."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(backend_mod.RomMClient, "device_auth_init",
                        lambda self, *a, **k: (DEVICE_AUTH, None))
    b = LudoBackend(host=DESKTOP)
    b._settings = None
    return b


def test_qr_pairing_builds_settings_on_demand(unstarted):
    result = asyncio.run(unstarted.start_qr_pairing("https://romm.example.tv"))

    assert result["success"], result.get("message")
    assert result["user_code"] == "AB12CD34"
    assert result["verification_url"] == \
        "https://romm.example.tv/pair/device?user_code=AB12CD34"
    # The settings manager is now real, so the approval that follows — which
    # writes the token through the same attribute — has something to write to.
    assert unstarted._settings is not None


def test_sync_engine_missing_says_so(unstarted, monkeypatch):
    """Without sync_core there is nothing to pair with; say that, not 'NoneType'."""
    monkeypatch.setattr(backend_mod, "SYNC_CORE_AVAILABLE", False)

    result = asyncio.run(unstarted.start_qr_pairing("https://romm.example.tv"))

    assert result["success"] is False
    assert "sync engine" in result["message"].lower()
    assert "NoneType" not in result["message"]
