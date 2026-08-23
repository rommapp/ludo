"""Ludo's backend, independent of the shell that hosts it."""
from .host import HostProfile, read_package_version

__all__ = ["HostProfile", "read_package_version"]
