"""Cancelling a download from the Downloads page or the game page.

The engine's download_rom already stops between chunks and deletes its partial
file when its cancellation_checker says so. What the backend owns is the rest:
cancel_download must reach that checker, and a cancelled download must end in
its own 'cancelled' state, not as an error, which would raise a "Download
failed" toast and ask the server whether the game had been deleted.

Run with:  pytest app/tests
"""
import asyncio
import threading
from pathlib import Path

import pytest

from ludo_app import backend as backend_mod
from ludo_app.backend import LudoBackend
from ludo_app.host import HostProfile

DESKTOP = HostProfile("1.0.0", "-x86_64.AppImage", Path("/tmp/desk-rt"), "desktop")
ROM = 42


class StubClient:
    """Transfers until told to stop, the way download_rom does."""
    authenticated = True

    def __init__(self):
        self.started = threading.Event()

    def download_rom(self, rom_id, name, dest, progress_callback=None,
                     cancellation_checker=None, file_ids=None):
        self.started.set()
        for _ in range(500):
            if cancellation_checker and cancellation_checker():
                return False, "cancelled"
            progress_callback({'progress': 0.4, 'downloaded': 4, 'total': 10})
            threading.Event().wait(0.01)
        return True, "Download successful"


@pytest.fixture
def backend(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    b = LudoBackend(host=DESKTOP)
    b._download_progress = {}
    b._download_cancels = set()
    b._romm_client = StubClient()
    monkeypatch.setattr(b, "_games_index", lambda: {ROM: {
        'name': 'Metroid Prime', 'platform_slug': 'gc', 'file_name': 'mp.iso'}})
    b._settings = type("S", (), {"get": lambda self, *a: str(tmp_path / "roms")})()
    asked = []
    monkeypatch.setattr(b, "_rom_exists_on_server", lambda rid: asked.append(rid) or True)
    b._asked_server = asked
    activity = []
    monkeypatch.setattr(backend_mod, "_record_activity",
                        lambda *a, **k: activity.append(a))
    b._activity = activity
    return b


async def _settle(b, timeout=5.0):
    for _ in range(int(timeout / 0.02)):
        state = (await b.get_download_progress(ROM))['state']
        if state not in ('downloading', 'extracting'):
            return state
        await asyncio.sleep(0.02)
    raise AssertionError("download never finished")


async def test_cancel_stops_the_transfer(backend):
    assert (await backend.download_game(ROM))['success']
    backend._romm_client.started.wait(2)

    assert (await backend.cancel_download(ROM)) == {'success': True}
    assert await _settle(backend) == 'cancelled'
    # Not a failure: nothing in the activity feed, no "is it still on RomM?".
    assert backend._activity == []
    assert backend._asked_server == []
    assert ROM not in backend._download_cancels


async def test_a_new_download_is_not_born_cancelled(backend):
    # A cancel left over from an earlier attempt must not kill the next one.
    backend._download_cancels.add(ROM)
    backend._romm_client.download_rom = lambda *a, **k: (True, "ok")
    backend._maybe_unzip_download = lambda dest, rid: dest
    backend._maybe_decompress_switch = lambda p, rid: p
    backend._handle_switch_add_ons = lambda *a: None
    backend._persist_snapshot_throttled = lambda: None
    assert (await backend.download_game(ROM))['success']
    assert await _settle(backend) == 'done'


async def test_cancel_when_nothing_is_downloading(backend):
    assert (await backend.cancel_download(ROM))['success'] is False
    assert ROM not in backend._download_cancels
