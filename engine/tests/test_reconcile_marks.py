"""Which platforms a reconcile re-walks. `python3 engine/tests/test_reconcile_marks.py`.

The rule this covers decides whether a library that has drifted from the server
ever gets noticed, and its failure mode is doing nothing at all -- no other
assertion in a refresh would catch it. The case that motivated the mark is
exact: deleting a mis-matched ROM and re-adding it with corrected metadata
leaves rom_count identical, so the count comparison alone sees an unchanged
platform and the dead entry survives every refresh.

Only the decision is exercised. _platforms_needing_walk is pure by design, so
this needs no server, no walk and no plugin instance.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'decky_plugin'))

FAILURES = []

SWITCH = 6
C64 = 26
JULY = '2026-07-11T16:20:35+00:00'
AUGUST = '2026-08-20T10:48:21+00:00'


def check(name, got, want):
    ok = got == want
    if not ok:
        FAILURES.append(name)
    print(f"{'ok  ' if ok else 'FAIL'} {name}: got={got!r} want={want!r}")


def load_rule():
    """Import the decision without importing the whole Decky plugin.

    main.py pulls in the plugin runtime at import time, which is not present
    off a Deck. The rule is a self-contained staticmethod, so it is read out of
    the source and compiled on its own.
    """
    import ast
    import textwrap

    source = (Path(__file__).resolve().parents[2]
              / 'decky_plugin' / 'main.py').read_text()
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == '_platforms_needing_walk':
            node.decorator_list = []
            module = ast.Module(body=[node], type_ignores=[])
            ast.fix_missing_locations(module)
            namespace = {'logging': __import__('logging')}
            exec(compile(module, '<rule>', 'exec'), namespace)
            return namespace['_platforms_needing_walk']
    raise AssertionError("_platforms_needing_walk not found in main.py")


def main():
    rule = load_rule()

    def row(pid, slug):
        return {'id': pid, 'slug': slug}

    switch = row(SWITCH, 'switch')
    c64 = row(C64, 'c64')
    considered = [(SWITCH, switch, 12), (C64, c64, 17067)]
    baselines = {SWITCH: 12, C64: 17067}

    # ── the motivating case ──────────────────────────────────────────────
    # Two ROMs deleted, two re-added: rom_count is identical and the count
    # comparison sees nothing. The newest timestamp moved, and that is the only
    # evidence there is.
    changed, adopt = rule(considered, baselines,
                          {SWITCH: JULY, C64: JULY},
                          {SWITCH: AUGUST, C64: JULY})
    check('re-added ROM is caught by the mark', [c[0] for c in changed], [SWITCH])
    check('untouched platform is left alone', adopt, {})

    # ── the cheap signal still comes first ───────────────────────────────
    changed, _ = rule([(SWITCH, switch, 11)], {SWITCH: 12},
                      {SWITCH: JULY}, {SWITCH: JULY})
    check('a moved count still walks', [c[0] for c in changed], [SWITCH])

    # ── nothing moved ────────────────────────────────────────────────────
    changed, adopt = rule(considered, baselines,
                          {SWITCH: JULY, C64: JULY},
                          {SWITCH: JULY, C64: JULY})
    check('a genuinely unchanged library walks nothing', changed, [])
    check('and adopts nothing', adopt, {})

    # ── first sighting adopts rather than walking ────────────────────────
    # Otherwise the first run after an upgrade re-walks every platform to learn
    # nothing -- minutes, on the 17k-ROM one.
    changed, adopt = rule(considered, baselines, {},
                          {SWITCH: AUGUST, C64: JULY})
    check('unknown marks do not trigger a walk', changed, [])
    check('unknown marks are adopted', adopt, {SWITCH: AUGUST, C64: JULY})

    # ── an unreadable probe is not a match ───────────────────────────────
    # The platform is absent from fresh_marks entirely. Nothing may be stamped,
    # or the next reconcile would compare against a value never read.
    changed, adopt = rule(considered, baselines,
                          {SWITCH: JULY, C64: JULY}, {C64: JULY})
    check('a failed probe walks nothing', changed, [])
    check('a failed probe adopts nothing', adopt, {})

    # ── never-walked platform ────────────────────────────────────────────
    changed, _ = rule([(99, row(99, 'new'), 0)], {}, {}, {99: JULY})
    check('a platform with no baseline is walked even at zero ROMs',
          [c[0] for c in changed], [99])

    # ── explicit demands ─────────────────────────────────────────────────
    changed, _ = rule(considered, baselines, {SWITCH: JULY, C64: JULY},
                      {SWITCH: JULY, C64: JULY}, force_platforms={C64})
    check('force_platforms overrides a matching count',
          [c[0] for c in changed], [C64])
    changed, _ = rule([(SWITCH, switch, 12)], baselines,
                      {SWITCH: JULY}, {SWITCH: JULY}, only_platform='switch')
    check('only_platform always walks', [c[0] for c in changed], [SWITCH])

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failure(s): {', '.join(FAILURES)}")
        return 1
    print("all reconcile-mark checks passed")
    return 0


if __name__ == '__main__':
    sys.exit(main())
