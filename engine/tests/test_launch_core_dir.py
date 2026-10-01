"""Cores outside RetroArch's libretro_directory don't crash it on launch.

Run with `python3 engine/tests/test_launch_core_dir.py`.

rommapp/ludo#28: Fedora's RetroArch reads cores from /usr/lib64/libretro,
which Ludo never searched, so it launched a core it had downloaded elsewhere.
RetroArch up to 1.22.2 then has no core_info for the running core and
segfaults answering Ludo's GET_STATUS. Checks that /usr/lib64/libretro is
found, and that ludo-launch.cfg points libretro_directory at the launched
core's folder exactly when it differs from the configured one.
"""

import pathlib
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import sync_core  # noqa: E402
from romm_sync_engine.sync_core import RetroArchInterface  # noqa: E402

FAILURES = []


def check(name, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(name)


def make_ra(cfg_dir, libretro_directory):
    ra = RetroArchInterface.__new__(RetroArchInterface)
    ra.retroarch_executable = '/usr/bin/retroarch'
    ra.find_retroarch_config_dir = lambda: Path(cfg_dir)
    ra._install_tree = lambda: None
    ra._menu_toggle_combo = lambda: ''
    ra.get_retroarch_config_setting = lambda key, default=None: (
        libretro_directory if key == 'libretro_directory' else default)
    return ra


def overlay_dir_line(ra, core):
    text = Path(ra._launch_overlay_config(core)).read_text()
    lines = [l for l in text.splitlines() if l.startswith('libretro_directory')]
    return lines[0] if lines else None


def test_overlay(d):
    d = Path(d)
    cfg = d / 'cfg'
    user_cores = cfg / 'cores'
    distro = d / 'lib64' / 'libretro'
    for p in (user_cores, distro):
        p.mkdir(parents=True)
    core = user_cores / 'genesis_plus_gx_libretro.so'
    core.write_bytes(b'')
    distro_core = distro / 'snes9x_libretro.so'
    distro_core.write_bytes(b'')

    # The report: core in ~/.config/retroarch/cores, RetroArch on the distro dir.
    ra = make_ra(cfg, str(distro))
    check('outside configured dir -> override',
          overlay_dir_line(ra, str(core)), f'libretro_directory = "{user_cores.resolve()}"')
    check('network commands still on',
          'network_cmd_enable = "true"' in Path(ra._launch_overlay_config(str(core))).read_text(),
          True)
    check('inside configured dir -> no override',
          overlay_dir_line(ra, str(distro_core)), None)
    # Relative path, resolved against the config dir as RetroArch does.
    check('relative configured dir matches',
          overlay_dir_line(make_ra(cfg, 'cores'), str(core)), None)
    check('":/" prefixed configured dir matches',
          overlay_dir_line(make_ra(cfg, ':/cores'), str(core)), None)
    check('trailing slash matches',
          overlay_dir_line(make_ra(cfg, str(user_cores) + '/'), str(core)), None)
    check('unset -> override',
          overlay_dir_line(make_ra(cfg, ''), str(core)), f'libretro_directory = "{user_cores.resolve()}"')
    check('"default" -> override',
          overlay_dir_line(make_ra(cfg, 'default'), str(core)),
          f'libretro_directory = "{user_cores.resolve()}"')
    check('no core (RetroDECK) -> no override',
          overlay_dir_line(make_ra(cfg, str(distro)), None), None)


def test_lib64_search(d):
    """With only /usr/lib64/libretro holding cores, it is the one found."""
    fake = Path(d) / 'lib64'
    fake.mkdir()
    (fake / 'snes9x_libretro.so').write_bytes(b'')
    real_exists, real_glob = pathlib.Path.exists, pathlib.Path.glob
    target = '/usr/lib64/libretro'

    def exists(self, *a, **k):
        if str(self) == target:
            return True
        if str(self).startswith('/usr/') or str(self).startswith('/snap/') \
                or str(self).startswith('/var/') or str(self).startswith('/run/'):
            return False
        return real_exists(self, *a, **k)

    def glob(self, pattern, *a, **k):
        if str(self) == target:
            return real_glob(fake, pattern, *a, **k)
        return real_glob(self, pattern, *a, **k)

    real_home = pathlib.Path.home
    pathlib.Path.exists, pathlib.Path.glob = exists, glob
    pathlib.Path.home = classmethod(lambda cls: Path(d) / 'home')
    try:
        ra = RetroArchInterface.__new__(RetroArchInterface)
        ra.retroarch_executable = '/usr/bin/retroarch'
        ra.is_dead_install_path = lambda p: False
        if sync_core.IS_WINDOWS:
            print('skip lib64 search on Windows')
            return
        check('finds /usr/lib64/libretro', str(ra.find_cores_directory()), target)
    finally:
        pathlib.Path.exists, pathlib.Path.glob = real_exists, real_glob
        pathlib.Path.home = real_home


def main():
    with tempfile.TemporaryDirectory() as d:
        test_overlay(d)
    with tempfile.TemporaryDirectory() as d:
        test_lib64_search(d)
    print(f"\n{len(FAILURES)} failure(s)" if FAILURES else "\nall passed")
    return 1 if FAILURES else 0


if __name__ == '__main__':
    sys.exit(main())
