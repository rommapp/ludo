"""The backend's deployment facts come from its host, not from globals.

These exist because the old arrangement made them untestable: version and
update-asset were module globals in the Decky plugin, so exercising the desktop
behaviour meant importing the plugin and reassigning them, and the two shells
could never be observed in the same process. Constructing a HostProfile is now
the whole setup.

Run with:  pytest app/tests
"""
from pathlib import Path

import pytest

from ludo_app.backend import LudoBackend
from ludo_app.host import HostProfile, read_package_version

DECKY = HostProfile("1.0.0-beta.7", "-decky.zip", Path("/tmp/decky-rt"), "decky")
DESKTOP = HostProfile("1.0.0-beta.7", "-x86_64.AppImage", Path("/tmp/desk-rt"), "desktop")

# One GitHub release carrying both shells' assets, plus an older stable that
# only ever shipped the Decky zip.
RELEASES = [
    {"tag_name": "v1.0.0-beta.9", "prerelease": True, "body": "beta notes",
     "assets": [
         {"name": "ludo-1.0.0-beta.9-decky.zip", "browser_download_url": "u/zip"},
         {"name": "Ludo-1.0.0-beta.9-x86_64.AppImage", "browser_download_url": "u/img"},
     ]},
    {"tag_name": "v0.9.0", "prerelease": False, "body": "stable notes",
     "assets": [{"name": "ludo-0.9.0-decky.zip", "browser_download_url": "u/zip9"}]},
]


@pytest.fixture
def releases(monkeypatch):
    """Stand in for the GitHub releases API so these stay offline."""
    from ludo_app import backend
    monkeypatch.setattr(backend, "_iter_releases", lambda **kw: RELEASES)


def test_version_strips_leading_v():
    assert HostProfile("v2.1.0", "-decky.zip", Path("/tmp")).version == "2.1.0"


def test_read_package_version_falls_back_when_unreadable(tmp_path):
    assert read_package_version(tmp_path / "nope.json") == "0.0.0"
    pkg = tmp_path / "package.json"
    pkg.write_text('{"version": "3.2.1"}')
    assert read_package_version(pkg) == "3.2.1"


async def test_reports_its_host_version():
    assert await LudoBackend(host=DESKTOP).get_plugin_version() == "1.0.0-beta.7"


@pytest.mark.parametrize("host,expected", [
    (DECKY, "ludo-1.0.0-beta.9-decky.zip"),
    (DESKTOP, "Ludo-1.0.0-beta.9-x86_64.AppImage"),
])
async def test_each_host_is_offered_only_its_own_asset(releases, host, expected):
    result = await LudoBackend(host=host).check_for_update("beta")
    assert result["available"] is True
    assert result["asset_name"] == expected
    assert result["current"] == host.version


async def test_release_without_this_hosts_asset_is_invisible(releases):
    """The 0.9.0 stable shipped no AppImage, so the desktop must not see it."""
    assert (await LudoBackend(host=DESKTOP).check_for_update("stable"))["available"] is False
    decky = await LudoBackend(host=DECKY).check_for_update("stable")
    assert decky["asset_name"] == "ludo-0.9.0-decky.zip"


async def test_older_release_is_not_offered_as_an_update(releases):
    """0.9.0 < 1.0.0-beta.7 — found, but not an update."""
    assert (await LudoBackend(host=DECKY).check_for_update("stable"))["available"] is False


def test_both_hosts_coexist_in_one_process():
    """The thing module globals made impossible."""
    decky, desktop = LudoBackend(host=DECKY), LudoBackend(host=DESKTOP)
    assert decky._host.asset_suffix == "-decky.zip"
    assert desktop._host.asset_suffix == "-x86_64.AppImage"


def test_download_dir_comes_from_the_host_not_the_environment(monkeypatch):
    monkeypatch.setenv("DECKY_PLUGIN_RUNTIME_DIR", "/tmp/should-be-ignored")
    assert LudoBackend(host=DESKTOP)._host.download_dir == Path("/tmp/desk-rt")
