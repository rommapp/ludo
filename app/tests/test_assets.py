"""The bundled artwork travels with the package that reads it.

This exists because it silently stopped doing so. The artwork RPCs were written
in decky_plugin/main.py, where `Path(__file__).parent / "assets"` meant
decky_plugin/assets/ and was correct. Extracting the backend into ludo_app moved
those six lookups to app/ludo_app/assets/ — a directory that did not exist — and
nothing failed loudly: every one of them is wrapped in try/except and returns
`success: False`, so the Steam shortcut simply drew no art.

Nothing here reaches the network or a shell. If these pass, the artwork is where
both frontends resolve it: backend.py via its own __file__, and the desktop's
server.py via the installed package.

Run with:  pytest app/tests
"""
from pathlib import Path

import ludo_app.backend
from ludo_app.backend import LudoBackend

ASSETS = Path(ludo_app.__file__).resolve().parent / "assets"

# Every file the backend names. Kept explicit rather than globbed: the point is
# to fail when one goes missing, which a glob of whatever is present cannot do.
REQUIRED = [
    "logo.png",
    "romm-grid.png", "romm-hero.png", "romm-logo.png",
    "romm-header.png", "romm-icon.png",
    "romm-isotipo.svg", "romm-logotipo.svg",
    "retrodeck.svg", "auth_background.svg",
]


def test_assets_ship_inside_the_package():
    missing = [n for n in REQUIRED if not (ASSETS / n).is_file()]
    assert not missing, f"missing from {ASSETS}: {missing}"


def test_every_asset_path_in_backend_resolves():
    """Catch a lookup whose filename drifts from what is bundled."""
    src = Path(ludo_app.backend.__file__).read_text()
    named = {
        line.split('"')[-2]
        for line in src.splitlines()
        if '"assets" / "' in line
    }
    assert named, "no `assets / <file>` lookups found — did the pattern change?"
    missing = sorted(n for n in named if not (ASSETS / n).is_file())
    assert not missing, f"backend.py names files that are not bundled: {missing}"


async def test_plugin_logo_rpc_returns_image_data():
    b = LudoBackend.__new__(LudoBackend)
    r = await LudoBackend.get_plugin_logo(b)
    assert r["success"] is True
    assert r["data_uri"].startswith("data:image/png;base64,")
    assert len(r["b64"]) > 100


async def test_romm_artwork_rpc_covers_every_steam_slot():
    b = LudoBackend.__new__(LudoBackend)
    r = await LudoBackend.get_romm_artwork(b)
    assert r["success"] is True
    # Steam's eAppArtworkAssetType: 0 grid, 1 hero, 2 logo, 3 header, 4 icon.
    assert sorted(r["art"]) == ["0", "1", "2", "3", "4"]
