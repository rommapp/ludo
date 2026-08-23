"""Facts about the shell Ludo is running inside.

The backend is one piece of code with two hosts: the Decky plugin on a Steam
Deck and the desktop shell on a PC. They agree on everything except a handful
of deployment facts — what version this build is, which release asset its
updater should pull, and where it may write downloads.

Those used to live as module globals in the Decky plugin's ``main.py``, which
made the plugin the definition of the app: the desktop backend had to import
that module and reassign ``PLUGIN_VERSION`` and call ``set_asset_suffix()`` to
correct facts about itself. A host passes them in instead, so neither shell has
to reach into the other's globals, and a test can construct one outright.
"""
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class HostProfile:
    """Deployment facts the backend can't derive on its own.

    version:       semver of the running build, without a leading 'v'. Drives
                   the update check's "current" and the RomM client version.
    asset_suffix:  suffix of the GitHub release asset this shell updates from.
                   Both shells share one release and differ only in which asset
                   they want ('-decky.zip' vs '-x86_64.AppImage').
    download_dir:  writable directory for downloaded update artifacts.
    name:          human-readable host, for logs.
    """

    version: str
    asset_suffix: str
    download_dir: Path
    name: str = "unknown"

    def __post_init__(self):
        object.__setattr__(self, "version", str(self.version).lstrip("vV"))
        object.__setattr__(self, "download_dir", Path(self.download_dir))


def read_package_version(package_json: Path, fallback: str = "0.0.0") -> str:
    """Version from a package.json, or `fallback` if it can't be read.

    Both shells carry their own package.json and ship as separate artifacts, so
    each reads its own rather than sharing one constant.
    """
    import json

    try:
        return str(json.loads(Path(package_json).read_text()).get("version", fallback))
    except Exception:
        return fallback
