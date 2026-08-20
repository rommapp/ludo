#!/usr/bin/env python3
"""display_game_name: the name a person reads in a save notification.

RomM stores a Switch ROM as "Mario Kart 8 Deluxe [0100152000022000][v0]
(6.77 GB)". Shown verbatim in a toast, that reads as a filename rather than a
game -- which is exactly what a save-upload notification looked like. Only
"[v0]" was being stripped, leaving the title ID and the size behind.

The risk in stripping more is stripping too much, so the keep cases below carry
as much weight as the drop cases: a parenthetical that is part of the actual
title, or that tells two saves apart, has to survive.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import display_game_name

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


def main():
    # --- the reported case, and its neighbours ---------------------------
    for raw, want in {
        'Mario Kart 8 Deluxe [0100152000022000][v0] (6.77 GB)':
            'Mario Kart 8 Deluxe',
        'Super Mario Party [010036B0034E4000][v0] (2.99 GB)':
            'Super Mario Party',
        # Size alone, and title ID alone -- each must go on its own.
        'Metroid Dread (297 MB)': 'Metroid Dread',
        'Metroid Dread [010093801237C000]': 'Metroid Dread',
        # Already clean: unchanged, not merely "not broken".
        'Metroid Dread': 'Metroid Dread',
    }.items():
        check(f'drop: {raw[:44]}', display_game_name(raw), want)

    # --- what must NOT be stripped ---------------------------------------
    for raw, want in {
        # Names the disc a save belongs to; a player reading a toast needs it.
        'Final Fantasy VII (Europe) (Disc 1)': 'Final Fantasy VII (Disc 1)',
        # Part of the title, not metadata.
        "Tom Clancy's Splinter Cell (Pandora Tomorrow)":
            "Tom Clancy's Splinter Cell (Pandora Tomorrow)",
        # A hex run that is NOT a Switch title ID: wrong prefix, wrong length.
        'Game [DEADBEEFDEADBEEF]': 'Game [DEADBEEFDEADBEEF]',
        'Game [0100152000022]': 'Game [0100152000022]',
        # A unit needs a number in front of it to be a size. (Note "(GB)"
        # alone is NOT a good test here -- GB is the region code for Great
        # Britain and is stripped as a region, which predates this rule.)
        'Game (12 Bananas)': 'Game (12 Bananas)',
        'Game (Gameboy Edition)': 'Game (Gameboy Edition)',
    }.items():
        check(f'keep: {raw[:44]}', display_game_name(raw), want)

    # --- degenerate input -------------------------------------------------
    check('empty stays empty', display_game_name(''), '')
    check('None passes through', display_game_name(None), None)
    # A name that is nothing but tags must not be cleaned away to nothing --
    # an empty toast is worse than an ugly one.
    check('all-tags name survives',
          display_game_name('[0100152000022000]'), '[0100152000022000]')

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all display-name checks passed")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
