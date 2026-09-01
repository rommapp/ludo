# Contributing to Ludo

## The shape of the thing

Ludo is one application that runs in two places. The interface, the backend and
the sync engine are each written **once**; what differs between a Steam Deck and
a PC is only the *shell* hosting them — how the UI reaches the screen, and how it
talks to the backend.

| Directory | What lives there |
| --- | --- |
| `ui/` | The interface, plus `host/contract.ts` — the interface it needs *from* its shell. |
| `app/` | `LudoBackend`: every RPC the UI can call. |
| `engine/` | `romm_sync_engine` — the sync machinery. Not Ludo-specific; shared with RomM RetroArch Sync. |
| `desktop/` | The PC shell: an Electron window over the backend on localhost. |
| `decky_plugin/` | The Deck shell: a Decky Loader plugin, with Steam library-tile and overlay integration. |
| `scripts/` | Release automation, the `libsigil` build, an Eden diagnostic. |

### The seam

`ui/host/contract.ts` is what the app requires of its shell. `desktop/src/host/`
and `decky_plugin/src/host/` each implement it, and both builds resolve the
`@ludo/host` specifier to their own adapter. Nothing in `ui/app/` imports
`@decky/*`, and nothing branches on which shell it is in — it asks what the shell
*can do* (`host.capabilities.selfUpdate`, `.exit`, `.shortcutTile`,
`.toastPlacement`).

Steam's library-tile machinery and its gamepad-focus internals sit behind their
own seams in that contract (`HostLauncher`, `HostFocus`) rather than being
flattened into capability flags: both are cohesive, undocumented and
version-fragile, and each belongs in one adapter.

The same rule holds on the Python side. Both shells construct the same
`LudoBackend`; **neither imports the other**. The handful of facts that genuinely
differ — the running version, which release asset the updater pulls, where
downloads may land — are passed in as a `HostProfile` (`app/ludo_app/host.py`)
rather than read from the environment or patched onto module globals. Decky's
`callable` IPC and the desktop's `POST /api/<method>` are two transports over
that one class.

## Setting up

Python 3.11+, Node.js 18+, and `pnpm` 9 for the Deck plugin.

```bash
python3 -m venv .venv
.venv/bin/pip install -e engine -e app --no-deps   # romm-sync-engine isn't on PyPI
.venv/bin/pip install -e 'app[test]' --no-deps
```

Then whichever shell you're working in — `desktop/` and `decky_plugin/` each have
a README covering dev servers, hot reload and packaging.

Neither shell has a pip install step at runtime, so each reaches the Python
packages through a dev symlink that its build script dereferences:
`decky_plugin/py_modules/ludo_app` → `app/ludo_app`, resolved by `cp -rL` in
`decky-build.sh`. The AppImage pip-installs instead, in
`desktop/tools/prepare-runtime.sh`. `ui/README.md` documents the equivalent
TypeScript symlinks, which have a sharp edge worth reading before you add a
dependency.

## Tests

```bash
cd app     && pytest          # backend surface and the host-profile seam
cd engine  && tests/run.sh    # the sync engine
cd desktop && npm test        # the host contract, and every route rendered
```

Three things to know:

- **The engine tests are not pytest.** Each file is a standalone script with its
  own `check()` harness, so `pytest engine/tests/` collects nothing and exits 0 —
  a green run that tested absolutely nothing. `tests/run.sh` is the supported way
  in; it also builds `engine/.venv-tests` on demand if no interpreter on the
  machine has the dependencies.
- **`routes.render.test.mjs` needs `npm run build` first.** It deliberately drives
  `dist/`, because `dist/` is what ships, and it skips itself loudly if Playwright
  or the build is missing.
- **A typecheck is not a test.** `npm run typecheck` in either shell catches
  plenty, but the render walk exists because a reply whose shape drifted, or an
  asset that stopped being packaged, shows up as a page that draws a header and
  nothing else — which a build and a typecheck both pass through happily.

## Conventions

- **Commits** follow Conventional Commits with a scope naming the area:
  `fix(desktop): …`, `feat(sync): …`, `docs: …`.
- **Both shells stay in step.** A change to `ui/app/` or `app/` reaches the Deck
  and the PC alike; if a change only makes sense in one, it probably belongs in
  that shell's adapter rather than behind a branch in shared code.
- **Generated files are committed, and documented where they're generated** —
  `desktop/src/host/glyphs.tsx` from `tools/gen-glyphs.mjs`,
  `engine/romm_sync_engine/bin/libsigil.so` from `scripts/build_sigil.sh`. Refresh
  them with their tool, never by hand.

## Releasing

One tag builds both artifacts, always at the same version. That is enforced
rather than agreed, and [RELEASING.md](RELEASING.md) explains why.
