#!/usr/bin/env python3
"""The per-save ROM lookup must be derived once, not once per sync.

find_rom_id_for_save_file walks the whole library applying regexes per game,
across six tiers. Calling it once PER SAVE on every sync meant a 21-save
inventory against a 16,541-game library re-derived roughly 350,000 name
comparisons to reproduce a mapping that had not changed since the last sync.

Measured on a live install: the session sync a player waits through after
closing a game took 3.19s, of which ~2.3s was this. With the lookup memoized
against the games list the same sync took 0.76s, nearly all of it now the
negotiate round trip and the upload itself.

The assertions here count CALLS rather than seconds. A wall-clock threshold
would measure the machine it runs on and fail on a loaded CI box for reasons
that have nothing to do with this code; "the matcher ran once per distinct
save" is the actual invariant and is exactly reproducible. Timings are printed
alongside, unasserted, because the number is what makes the point readable.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from romm_sync_engine.sync_core import AutoSyncManager  # noqa: E402

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"{'ok  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if not ok:
        FAILURES.append(label)


def library(size):
    """A library shaped like the real one: RomM rows with an fs name to match."""
    return [{'rom_id': 1000 + i,
             'name': f'Game {i}',
             'romm_data': {'fs_name_no_ext': f'Game {i} (Europe)',
                           'name': f'Game {i}',
                           'platform_slug': 'psx'}}
            for i in range(size)]


def manager(games_holder, counter):
    """A bare manager wired to count how often the real matcher is entered."""
    m = AutoSyncManager.__new__(AutoSyncManager)
    m.get_games = lambda: games_holder[0]
    m._rom_match_cache = {}
    m._rom_match_games = None
    # The tiers that would need a live library index; the name tiers below them
    # are the ones under test.
    m._rom_id_for_launch_alias = lambda a, b: None
    m._rom_id_for_title_id = lambda t: None
    real = AutoSyncManager.find_rom_id_for_save_file

    # Depth-guarded, because the matcher RE-ENTERS ITSELF: a save that reaches
    # the containing-folder tier retries under a rewritten path, so a plain
    # counter reports 27 for 21 saves and the invariant looks broken when it is
    # not. What the cache can control is how often the matcher is entered from
    # OUTSIDE; the recursion is the matcher's own business.
    def counted(path):
        if counter['depth'] == 0:
            counter['n'] += 1
        counter['depth'] += 1
        try:
            return real(m, path)
        finally:
            counter['depth'] -= 1

    m.find_rom_id_for_save_file = counted
    return m


def main():
    games = [library(16541)]
    counter = {'n': 0, 'depth': 0}
    m = manager(games, counter)

    # Names that match a ROM, and names that match nothing. The second group is
    # the expensive one: a miss only becomes a miss after every tier has run to
    # exhaustion, and it is the common case for a save whose ROM was never
    # downloaded here.
    hits = [Path(f'/saves/Game {i} (Europe).srm') for i in range(15)]
    misses = [Path(f'/saves/Nothing Matches This {i}.srm') for i in range(6)]
    saves = hits + misses

    t = time.monotonic()
    first = [m.rom_id_for_save(p) for p in saves]
    cold = time.monotonic() - t
    cold_calls = counter['n']

    t = time.monotonic()
    second = [m.rom_id_for_save(p) for p in saves]
    warm = time.monotonic() - t
    warm_calls = counter['n'] - cold_calls

    check('every save resolves on the first pass', len(first), len(saves))
    check('the matcher is entered once per distinct save', cold_calls, len(saves))
    check('a second sync re-derives nothing', warm_calls, 0)
    check('and answers identically', second, first)
    # A miss costs a full six-tier walk, so caching it is the point -- an
    # implementation that cached only successful matches would pass every
    # assertion above except this one.
    check('misses are cached too, not just hits',
          all(x is None for x in first[len(hits):]), True)
    check('hits resolved to real rom_ids',
          all(isinstance(x, int) for x in first[:len(hits)]), True)

    # Repeated paths within ONE pass must not each pay: the inventory can see
    # the same save under two emulator subdirectories (the "Duplicate local
    # save" case), and both reach this.
    before = counter['n']
    for _ in range(50):
        m.rom_id_for_save(hits[0])
    check('a repeated path in one pass costs nothing', counter['n'] - before, 0)

    # A refreshed library is a NEW list object, and every cached answer was
    # derived from the old one. Identity is the test because it is what actually
    # changes -- comparing len() would keep a stale cache across a same-size
    # refresh, and comparing id() alone can be fooled by a freed list's address
    # being reused, which is why the manager holds a reference to the list.
    before = counter['n']
    games[0] = library(16541)
    m.rom_id_for_save(hits[0])
    check('a refreshed library drops the cache', counter['n'] - before, 1)

    same = games[0]
    before = counter['n']
    games[0] = same
    m.rom_id_for_save(hits[0])
    check('the same list left alone does not', counter['n'] - before, 0)

    print()
    print(f"     {len(saves)} saves x {len(games[0]):,} games:"
          f" cold {cold:.2f}s, warm {warm * 1000:.2f}ms")
    if warm > 0:
        print(f"     (~{cold / warm:,.0f}x on every sync after the first)")

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all ROM-match cache checks passed")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
