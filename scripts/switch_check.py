#!/usr/bin/env python3
"""Exercise the Switch save/firmware paths before any UI exists.

    python3 scripts/switch_check.py                    # read-only report
    python3 scripts/switch_check.py --install-firmware # download + install
    python3 scripts/switch_check.py --pack-saves       # pack to a temp dir

Read-only by default: it inspects Eden, matches saves against the local ROM
library, and asks RomM what firmware it holds, without writing anything. The
two flags are the only paths that touch disk, and both say what they did.

--app-id selects which frontend's config to read (Ludo's by default); the
engine keeps the GTK app's settings in a separate directory.
"""

import argparse
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'engine'))


def human(n):
    for unit in ('B', 'KiB', 'MiB', 'GiB'):
        if n < 1024 or unit == 'GiB':
            return f"{n:.1f} {unit}" if unit != 'B' else f"{n} B"
        n /= 1024


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--app-id', default='ludo',
                        help="config directory under ~/.config (default: ludo)")
    parser.add_argument('--install-firmware', action='store_true',
                        help="download Switch firmware from RomM and install it into Eden")
    parser.add_argument('--pack-saves', action='store_true',
                        help="pack every discovered Eden save into a temp dir")
    args = parser.parse_args()

    from romm_sync_engine import paths
    paths.set_app_id(args.app_id)
    from romm_sync_engine import emulator_saves, title_ids
    from romm_sync_engine.sync_core import SettingsManager, RomMClient

    settings = SettingsManager()
    print(f"config       : {paths.config_dir()}")

    # ── Eden ──────────────────────────────────────────────────────────────
    print("\n=== Eden ===")
    data_dirs = emulator_saves.eden_data_dirs()
    if not data_dirs:
        print("  not installed (no data directory found)")
    for data_dir in data_dirs:
        print(f"  data dir   : {data_dir}")
    keys = emulator_saves.find_prod_keys()
    print(f"  prod.keys  : {keys or 'absent — Sigil cannot read Switch containers'}")
    status = emulator_saves.firmware_status()
    if status:
        print(f"  firmware   : {status['count']} NCAs, {human(status['bytes'])}")
        print(f"               {status['path']}")
    else:
        print("  firmware   : none installed")

    # ── Sigil ─────────────────────────────────────────────────────────────
    print("\n=== Sigil ===")
    if title_ids.sigil_available():
        print(f"  loaded     : {title_ids.sigil_version()}")
    else:
        print("  absent     : set LUDO_SIGIL_LIB=/path/to/libsigil.so to enable")
        print("               (filename tags still work; containers without one will not)")

    # ── Local ROMs ────────────────────────────────────────────────────────
    print("\n=== ROM title IDs ===")
    rom_dir = settings.get('Download', 'rom_directory', '')
    print(f"  rom dir    : {rom_dir or '(unset)'}")
    index = {}
    if rom_dir and Path(rom_dir).is_dir():
        index = title_ids.index_roms([rom_dir], prod_keys=keys)
        print(f"  identified : {len(index)} ROMs")
        for title_id, path in sorted(index.items()):
            print(f"    {title_id}  {path.name}")
    else:
        print("  (no ROM directory to scan)")

    # ── Eden saves ────────────────────────────────────────────────────────
    print("\n=== Eden saves ===")
    saves = emulator_saves.find_eden_saves()
    if not saves:
        print("  none found (no game has written a save yet)")
    for save in sorted(saves, key=lambda s: s['title_id']):
        owner = index.get(save['title_id'])
        mark = 'matched' if owner else 'UNMATCHED — no local ROM has this title ID'
        files = sum(1 for p in save['path'].rglob('*') if p.is_file())
        print(f"  {save['title_id']}  {files} files  {mark}")
        if owner:
            print(f"      rom: {owner.name}")
        print(f"      dir: {save['path']}")

    if args.pack_saves and saves:
        print("\n=== Packing (temp dir, nothing installed) ===")
        with tempfile.TemporaryDirectory() as tmp:
            for save in saves:
                packed = emulator_saves.pack_save(
                    save['path'], Path(tmp) / f"{save['title_id']}.zip")
                digest = RomMClient.compute_content_hash(packed)
                print(f"  {save['title_id']}.zip  {human(packed.stat().st_size)}  md5={digest}")

    # ── RomM ──────────────────────────────────────────────────────────────
    print("\n=== RomM ===")
    url = settings.get('RomM', 'url', '')
    token = settings.get('RomM', 'client_token', '')
    user = settings.get('RomM', 'username', '')
    password = settings.get('RomM', 'password', '')
    if not url:
        print("  no server configured")
        return 0
    print(f"  url        : {url}")
    client = RomMClient(url, username=user or None, password=password or None,
                        client_token=token or None)
    if not client.authenticated:
        print("  NOT AUTHENTICATED — log in through the app, then re-run")
        return 1
    print("  auth       : ok")

    from romm_sync_engine.bios_manager import BiosManager
    bios = BiosManager.__new__(BiosManager)
    bios.romm_client = client
    bios.log = print
    bios._platforms_cache = None
    bios._platforms_cache_at = 0.0
    import threading
    bios._platforms_lock = threading.Lock()

    entry = bios.find_firmware_entry('switch')
    if not entry:
        print("  firmware   : none on the server for 'switch'")
        return 0
    print(f"  firmware   : {entry['file_name']}  "
          f"{human(entry.get('file_size_bytes') or 0)}  md5={entry.get('md5_hash')}")

    if not args.install_firmware:
        print("\n(read-only; pass --install-firmware to download and install)")
        return 0

    # ── Install ───────────────────────────────────────────────────────────
    print("\n=== Installing firmware ===")
    if emulator_saves.eden_firmware_dir() is None:
        print("  Eden is not installed here — nothing to install into")
        return 1

    state = {'pct': -1}

    def progress(done, total):
        pct = int(done * 100 / total)
        if pct != state['pct'] and pct % 5 == 0:
            state['pct'] = pct
            print(f"    {pct:3d}%  {human(done)} / {human(total)}", flush=True)

    archive = bios.download_firmware_entry(
        entry, paths.cache_dir() / 'firmware' / entry['file_name'], progress=progress)
    if not archive:
        print("  download failed")
        return 1
    print(f"  downloaded : {archive}")

    result = emulator_saves.install_firmware_zip(archive)
    print(f"  installed  : {result['installed']} NCAs "
          f"({result['skipped']} already present)")
    print(f"  target     : {result['target']}")

    after = emulator_saves.firmware_status()
    print(f"  now holds  : {after['count']} NCAs, {human(after['bytes'])}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
