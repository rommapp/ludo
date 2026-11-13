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


class _Client:
    authenticated = True

    def __init__(self, devices):
        self.devices = devices

    def get_device(self, device_id):
        return self.devices.get(device_id)


def _start_and_capture(b, monkeypatch):
    seen = []

    def init(self, ident, *a, **k):
        seen.append(ident)
        return DEVICE_AUTH, None
    monkeypatch.setattr(backend_mod.RomMClient, "device_auth_init", init)
    assert asyncio.run(b.start_qr_pairing("https://romm.example.tv"))["success"]
    return seen[0]


def test_repairing_names_the_device_ludo_syncs_as(unstarted, monkeypatch):
    """RomM reuses the device whose client_device_identifier matches. A device
    carried over from an older client keeps THAT client's identifier, so
    sending our device id made RomM create a second device and bind the new
    sign-in to it — installs then refused as not_bound."""
    asyncio.run(unstarted.start_qr_pairing("https://romm.example.tv"))  # builds settings
    s = unstarted._settings
    s.set('Device', 'device_id', 'dev-a')
    unstarted._romm_client = _Client({'dev-a': {'id': 'dev-a', 'client_device_identifier': 'old-client-id'}})

    assert _start_and_capture(unstarted, monkeypatch) == 'old-client-id'
    assert s.get('Device', 'client_identifier', '') == 'old-client-id'

    # Signed out (or offline): the remembered identifier still names it.
    unstarted._romm_client = None
    assert _start_and_capture(unstarted, monkeypatch) == 'old-client-id'


def test_repairing_a_device_without_identifier_sends_its_id(unstarted, monkeypatch):
    asyncio.run(unstarted.start_qr_pairing("https://romm.example.tv"))
    unstarted._settings.set('Device', 'device_id', 'dev-b')
    unstarted._romm_client = _Client({'dev-b': {'id': 'dev-b', 'client_device_identifier': None}})
    assert _start_and_capture(unstarted, monkeypatch) == 'dev-b'
