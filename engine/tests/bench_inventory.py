#!/usr/bin/env python3
"""Time build_sync_inventory against THIS machine's real library and saves.

A benchmark, not a test — named bench_* so run.sh's test_* glob leaves it
alone. It asserts nothing and needs no server: it reads the library snapshot
Ludo already cached to disk and the save files already on it, so the numbers
are the real ones rather than a synthesised approximation, and the only I/O is
local reads.

Deliberately NOT a live sync. Negotiating a session would upload and download
against a real RomM account and mutate real save data, which is not a thing to
do for a measurement. Everything a sync does beyond this function is network
round trips that no change here can make faster anyway.

    engine/tests/bench_inventory.py

What it measures is the phase that dominated the wait after closing a game:
the inventory used to re-derive every save's rom_id on every sync, walking the
whole library per save. Baseline on the development machine, 35 saves against
16,541 games: cold 2.24s, warm 0.03s.
"""
import json
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine import paths  # noqa: E402

paths.set_app_id('ludo')

from romm_sync_engine.sync_core import (  # noqa: E402
    AutoSyncManager, RetroArchInterface, SettingsManager)


def build_manager(games, settings, retroarch):
    """The smallest AutoSyncManager that can build an inventory.

    Constructing a real one starts threads and talks to a server. These are the
    attributes build_sync_inventory actually reaches, and the two easy to miss:

      _launch_aliases   read by the first matching tier. Absent, every save
                        raises AttributeError, and find_rom_id_for_save_file
                        swallows it and returns None — so the run "succeeds"
                        with one entry instead of twenty-one and the benchmark
                        silently measures nothing.
      ensure_switch_keys  stubbed because it fetches keys over the network, and
                        a benchmark must never leave the machine.
    """
    m = AutoSyncManager.__new__(AutoSyncManager)
    m.retroarch = retroarch
    m.settings = settings
    m.get_games = lambda: games
    m.log = lambda *a, **k: None
    m.romm_client = None
    m.last_uploaded = {}
    m._rom_match_cache = {}
    m._rom_match_games = None
    m._title_id_index = None
    m._launch_aliases = {}
    m.ensure_switch_keys = lambda *a, **k: None
    return m


def main():
    snapshot = paths.config_dir() / 'library_snapshot.json'
    if not snapshot.exists():
        print(f"No library snapshot at {snapshot} — run Ludo once first.")
        return 0

    logging.disable(logging.CRITICAL)
    games = json.loads(snapshot.read_text()).get('games') or []
    settings = SettingsManager()
    retroarch = RetroArchInterface(settings)
    m = build_manager(games, settings, retroarch)

    saves = (retroarch.get_save_files() or {}).get('saves', [])
    print(f"library {len(games):,} games · {len(saves)} save files on disk")
    print()

    runs = []
    for _ in range(3):
        t = time.monotonic()
        inventory = m.build_sync_inventory()
        runs.append((time.monotonic() - t, inventory))

    for i, (elapsed, inventory) in enumerate(runs):
        label = 'cold' if i == 0 else 'warm'
        print(f"  build_sync_inventory  {label} {elapsed:6.2f}s  "
              f"({len(inventory)} entries)")

    saved = runs[0][0] - runs[1][0]
    print(f"  {'saved':>28} {saved:6.2f}s on every sync after the first")

    # A cache that changed the answer would be worse than a slow one.
    def shape(inventory):
        return sorted((e['rom_id'], e['file_name'], e['content_hash'])
                      for e in inventory)

    identical = shape(runs[0][1]) == shape(runs[1][1]) == shape(runs[2][1])
    print(f"  {'inventory identical':>28} {identical}")
    if not identical:
        print("\nWARNING: warm runs disagree with the cold one — the cache is "
              "not transparent, which is a correctness bug, not a speed one.")
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
