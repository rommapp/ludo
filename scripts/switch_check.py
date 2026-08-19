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


def _restore(args, settings, client, emulator_saves, title_ids, paths):
    """Restore one Switch save from the server, previewing by default.

    Deliberately its own mode rather than part of the report: this is the only
    thing here that WRITES into Eden's save tree, and it should never happen
    because someone ran the status check.
    """
    from romm_sync_engine.sync_core import RomMClient

    title_id = args.restore.upper()
    print(f"\n=== Restore {title_id} ===")
    if not title_ids.is_switch_title_id(title_id):
        print("  not a base Switch title ID (saves live under the base title)")
        return 1

    local = next((s for s in emulator_saves.find_eden_saves()
                  if s['title_id'] == title_id), None)
    print(f"  local save : {local['path'] if local else 'none — game never booted here'}")
    if not local:
        return 1

    # Which RomM game? Matched on the SERVER's filename, the same way the sync
    # engine does it — a save exists because the game was played, so requiring
    # the ROM to still be on disk here would refuse exactly the case restore is
    # for. Read from the snapshot Ludo already maintains rather than re-fetching
    # the library, which is server-bound and takes minutes at this size.
    import json
    snapshot = paths.config_dir() / 'library_snapshot.json'
    try:
        games = json.loads(snapshot.read_text()).get('games') or []
    except (OSError, ValueError) as e:
        print(f"  snapshot   : unreadable ({e}) — open the app once to build it")
        return 1

    match = None
    for game in games:
        name = game.get('file_name') or ''
        if name and title_ids.title_id_from_name(name) == title_id:
            # A base entry beats its own DLC/update, which can carry a tag that
            # normalises to the same base title.
            raw = title_ids.raw_switch_tag_in_name(name)
            if match and title_ids.switch_kind(raw) != 'base':
                continue
            match = game
    if not match:
        print(f"  server ROM : no library entry is tagged {title_id}")
        return 1
    rom_id = match['rom_id']
    print(f"  server ROM : id={rom_id}  {match.get('display_name') or match.get('name')}")
    print(f"  matched on : {match.get('file_name')}"
          f"{'' if match.get('is_downloaded') else '  (not downloaded — fine)'}")

    # /api/saves/summary answers {'slots': [{'slot', 'count', 'latest': {...}}]},
    # so the save records are one level down under each slot's 'latest'.
    summary = client.get_saves_summary(rom_id) or {}
    eden = [slot['latest'] for slot in summary.get('slots') or []
            if slot.get('latest')
            and (slot['latest'].get('emulator') or '').lower() == 'eden']
    if not eden:
        print("  server save: none for Eden")
        return 1
    newest = max(eden, key=lambda s: s.get('updated_at') or '')
    print(f"  server save: id={newest.get('id')}  {newest.get('file_name')}  "
          f"updated={newest.get('updated_at')}")

    # Compare before touching anything: identical content means a restore is a
    # no-op in substance, which is exactly what makes it safe to rehearse.
    import tempfile
    packed = emulator_saves.pack_save(
        local['path'], Path(tempfile.mkdtemp()) / f'{title_id}.zip')
    local_hash = RomMClient.compute_content_hash(packed)
    server_hash = newest.get('content_hash')
    print(f"  local hash : {local_hash}")
    print(f"  server hash: {server_hash}")
    print(f"  identical  : {local_hash == server_hash}")

    if not args.write:
        print("\n(preview only; pass --write to restore, backing up the current save)")
        return 0

    if emulator_saves.eden_is_running():
        print("\n  Eden is running — close it first")
        return 1

    staged = paths.cache_dir() / 'incoming_saves' / f'{title_id}.zip'
    staged.parent.mkdir(parents=True, exist_ok=True)
    if not client.download_save_by_id(newest.get('id'), 'saves', staged):
        print("  download failed")
        return 1
    print(f"  downloaded : {staged} ({staged.stat().st_size} bytes)")

    result = emulator_saves.unpack_save(
        staged, title_id, backup_dir=paths.cache_dir() / 'save_backups')
    print(f"  restored   : {result['files']} file(s) into {result['path']}")
    print(f"  backup     : {result['backup']}")

    after = emulator_saves.pack_save(
        result['path'], Path(tempfile.mkdtemp()) / f'{title_id}.zip')
    print(f"  hash now   : {RomMClient.compute_content_hash(after)}")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--app-id', default='ludo',
                        help="config directory under ~/.config (default: ludo)")
    parser.add_argument('--install-firmware', action='store_true',
                        help="download Switch firmware from RomM and install it into Eden")
    parser.add_argument('--pack-saves', action='store_true',
                        help="pack every discovered Eden save into a temp dir")
    parser.add_argument('--restore', metavar='TITLE_ID',
                        help="restore this title's save FROM the server into Eden "
                             "(read-only preview unless --write is given)")
    parser.add_argument('--write', action='store_true',
                        help="with --restore, actually replace the local save "
                             "(the current one is backed up first)")
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
    if keys:
        generation = emulator_saves.highest_master_key(keys)
        detail = f" (reaches master key {generation})" if generation is not None else ""
        print(f"  prod.keys  : {keys}{detail}")
    else:
        print("  prod.keys  : ABSENT — Eden cannot decrypt firmware or boot any "
              "game, and Sigil cannot read Switch containers")
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
        print(f"  local files: {len(index)} identified")
        for title_id, path in sorted(index.items()):
            print(f"    {title_id}  {path.name}")
    else:
        print("  (no ROM directory to scan)")

    # The server's filenames identify titles without any download, which is how
    # a save for a game that is not stored here still finds its ROM.
    library = {}
    snapshot = paths.config_dir() / 'library_snapshot.json'
    if snapshot.is_file():
        import json
        try:
            games = json.loads(snapshot.read_text()).get('games') or []
        except Exception as e:
            games = []
            print(f"  (could not read the library snapshot: {e})")
        for game in games:
            rom_id = game.get('rom_id')
            name = game.get('file_name') or ''
            base = title_ids.title_id_from_name(name) if name else None
            if not base or not rom_id:
                continue
            raw = title_ids.raw_switch_tag_in_name(name)
            rank = 0 if title_ids.switch_kind(raw) == 'base' else 1
            if base not in library or rank < library[base][1]:
                library[base] = (rom_id, rank, name)
        print(f"  server name: {len(library)} identified")
        for title_id, (rom_id, _rank, name) in sorted(library.items()):
            print(f"    {title_id}  rom {rom_id}  {name[:52]}")

    # ── Eden saves ────────────────────────────────────────────────────────
    print("\n=== Eden saves ===")
    saves = emulator_saves.find_eden_saves()
    if not saves:
        print("  none found (no game has written a save yet)")
    for save in sorted(saves, key=lambda s: s['title_id']):
        local = index.get(save['title_id'])
        served = library.get(save['title_id'])
        files = sum(1 for p in save['path'].rglob('*') if p.is_file())
        if served:
            mark = f"matched -> rom {served[0]} (server filename)"
        elif local:
            mark = "matched (local ROM file)"
        else:
            mark = "UNMATCHED — no ROM anywhere carries this title ID"
        print(f"  {save['title_id']}  {files} files  {mark}")
        if served:
            print(f"      rom: {served[2][:60]}")
        elif local:
            print(f"      rom: {local.name}")
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

    if args.restore:
        return _restore(args, settings, client, emulator_saves, title_ids, paths)

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
