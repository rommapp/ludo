# Ludo — Decky plugin

The Steam Deck shell: Ludo running inside Game Mode, through
[Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader).

It shares the UI, the backend and the sync engine with the desktop app and
differs only in the shell around them — see
[CONTRIBUTING.md](../CONTRIBUTING.md). Here the transport is Decky's `callable`
IPC rather than HTTP, and `main.py` is the plugin entry point that constructs
`LudoBackend` with the Deck's `HostProfile`.

What exists here and nowhere else:

- **`src/quick-access.tsx`** — the 240px Quick Access Menu panel, drawn with
  Steam's own widgets and reached through Decky. The desktop app has nothing to
  render it into.
- **`src/host/launcher.ts`** — Steam's library-tile and overlay-session
  machinery, behind the `HostLauncher` seam. A game launches as a real Steam
  session, so the overlay, screenshots and playtime all work.
- **`src/host/focus.ts`** — Steam's gamepad-focus internals, behind `HostFocus`.
- **`bin/`** — bundled binaries; see [`bin/README.md`](bin/README.md).

## Building

Needs Node 18+, `pnpm` 9 (pin the major — plugin-submission CI expects it), and
Docker if you touch `backend/`.

```bash
pnpm install --frozen-lockfile
pnpm run build        # frontend bundle → dist/
pnpm run typecheck
./decky-build.sh      # the installable zip
```

`decky-build.sh` dereferences the dev symlinks in `py_modules/` (`cp -rL`), so
the zip carries real copies of `ludo_app` and `romm_sync_engine` rather than
links into the checkout.

[DEPLOYMENT.md](DEPLOYMENT.md) covers getting a build onto a Deck, and
[DEPENDENCIES.md](DEPENDENCIES.md) what the plugin vendors.

## Releasing

Never publish this zip on its own. One tag builds it *and* the AppImage at the
same version, and the shared updater skips any release missing either asset —
see [RELEASING.md](../RELEASING.md).
