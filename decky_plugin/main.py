"""Decky Loader entry point for Ludo.

Decky loads this file, looks for a class literally named ``Plugin``, and binds
its public coroutine methods to the frontend's `callable` IPC. That naming
requirement is the only reason this file exists: the actual backend is
``ludo_app.backend.LudoBackend``, shared byte-for-byte with the desktop shell.

What belongs here is Deck-and-Decky-only bootstrap — making the vendored
py_modules importable, coaxing the bundled Pillow wheel into loading, and
describing this deployment (version, release asset, download directory) as a
HostProfile. Everything else belongs in the backend.
"""
import ctypes
import logging
import os
import sys
from pathlib import Path

HERE = Path(__file__).parent

# Add py_modules to path so the vendored engine and backend are importable.
# decky-build.sh dereferences the dev symlinks in there when packaging the zip,
# so on-device these are real directories.
sys.path.insert(0, str(HERE / "py_modules"))

# Preload Pillow's bundled shared libraries. Decky Loader is a PyInstaller
# AppImage running its own Python 3.11, and the .so files in the vendored wheel
# can't find their dependencies unless we open them first. Must happen before
# anything imports PIL — which the backend does at module level.
_pillow_libs = HERE / "py_modules" / "pillow.libs"
if _pillow_libs.exists():
    try:
        for _lib in sorted(_pillow_libs.glob("*.so*")):
            try:
                ctypes.CDLL(str(_lib))
                logging.debug(f"[PIL] Preloaded library: {_lib.name}")
            except Exception as e:
                logging.debug(f"[PIL] Could not preload {_lib.name}: {e}")
    except Exception as e:
        logging.warning(f"[PIL] Error preloading pillow libraries: {e}")

from ludo_app.backend import LudoBackend  # noqa: E402  (bootstrap must precede)
from ludo_app.host import HostProfile, read_package_version  # noqa: E402


def _decky_host() -> HostProfile:
    """Describe this deployment to the backend.

    Version prefers Decky's DECKY_PLUGIN_VERSION env (injected from
    package.json at load time) and falls back to reading package.json here, so
    there is still exactly one source of truth. Updates come down as the zip
    Decky Loader knows how to unpack, and land in the runtime dir Decky gives
    us — falling back to a plugin-local directory if it's absent.
    """
    version = (os.environ.get("DECKY_PLUGIN_VERSION")
               or read_package_version(HERE / "package.json"))
    runtime_dir = os.environ.get("DECKY_PLUGIN_RUNTIME_DIR")
    return HostProfile(
        version=version,
        asset_suffix="-decky.zip",
        download_dir=Path(runtime_dir) if runtime_dir else HERE / "updates",
        name="decky",
    )


class Plugin(LudoBackend):
    """The name Decky Loader looks for. Behaviour lives in LudoBackend."""

    def __init__(self):
        super().__init__(host=_decky_host())
