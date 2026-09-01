# ui/

Ludo's interface. `app/` is the app itself, rendered identically by both shells;
`host/contract.ts` is what it needs *from* whatever is hosting it — see
[CONTRIBUTING.md](../CONTRIBUTING.md) for how that seam works.

## app/

`index.tsx` exports `startApp()` — register the routes, start the pollers, hand
back a teardown. That one function is the whole entry point, and it is what both
shells call.

| file | what it holds |
| --- | --- |
| `index.tsx` | `startApp()`: the route table and the app-lifetime watches |
| `rpc.ts` | every `callable` — the backend surface, in one place |
| `types.ts` | `LibGroup`, `LibGame` |
| `theme.ts` | RomM's design tokens, and the four ways this app writes a number |
| `storage.ts` | `_lsAvail`, the guard every persisted cache goes through |
| `events.ts` | the announcement channels (see the rules below) |
| `shell.ts` | thin wrappers over the host: focus, keyboard, Deck UI sounds |
| `focus.tsx` | what focus looks like, and the frame every page is drawn in |
| `kit.tsx` | the controls every page is built out of |
| `media.tsx` | art: the fetch queue, the caches, and what draws them |
| `tiles.tsx` | what a grid is made of |
| `topbar.tsx` | the bar across the top of the library, and its menus |
| `scrub.tsx` | letter jumping through an alphabetised grid |
| `nav.ts` | routes, back, and the in-library view stack |
| `downloads.ts` | the download registry every surface subscribes to |
| `status.ts` | one poller: connection, collection syncs, offline, staleness |
| `libcache.ts` | what the library remembers between screens |
| `launch.tsx` | starting a game — the one place that differs by shell |
| `emulator.tsx` | is there an emulator, is it installing, are its paths stale |
| `firmware.tsx` | Switch firmware and keys |
| `pairing.tsx` | device-code sign-in, shared by setup and settings |
| `notifications.tsx` | the toasts that appear when no page is on screen |
| `pages/` | one file per route |

Three rules hold the arrangement together, and each is written into the module
it governs:

- **Shared mutable state lives in a module, not in a page.** The same download
  is on screen in three places at once; page state cannot do that, and it dies
  on unmount besides.
- **A module never imports a page.** Where the dependency ran that way — the
  downloader marking a cache, a grid announcing a refresh, a Switch download
  needing a modal — it goes through a listener channel in `events.ts` or a
  registered hook instead.
- **An imported `let` is read-only at the importing end.** State a page assigns
  (`_libGameHolder`, the library view stack, the scrub hooks) is handed over
  through a setter. The setters are not ceremony; they are what the language
  requires — and the Decky build enforces it, since rollup rejects an illegal
  reassignment of an import outright.

## The two dev symlinks

`decky_plugin/src/app` → `ui/app`, and `decky_plugin/src/host/contract.ts` →
`ui/host/contract.ts`. Both exist because `@rollup/plugin-typescript` shifts its
emit paths when a file outside the plugin's `src/` enters the TypeScript
program, which leaves `index.tsx` untransformed and fails the build. Same
pattern as the Python side's `py_modules/ludo_app`.

They have a sharp edge worth knowing about, because it has bitten this project
twice and it fails **silently**: rollup resolves the `src/app` symlink to its
real path, so a bare import from inside `ui/app/` is looked up by walking up
from `ui/`, which never reaches `decky_plugin/node_modules`. `react-icons` then
falls through as an unresolved external and the plugin builds clean, reports
success, and ships with missing icons. `decky_plugin/rollup.config.js` pins
those packages for that reason; `desktop/vite.config.ts` pins the same ones for
the mirror-image reason. If you add a dependency the shared UI imports directly,
pin it in both.

A green build is not evidence on its own here. The check that catches it is the
bundle's sourcemap: every `react-icons/*` family the UI imports must appear in
`dist/index.js.map`'s sources, and no `from 'react-icons` import may survive in
`dist/index.js`.

## What is NOT here

The Quick Access Menu panel (`decky_plugin/src/quick-access.tsx`). It is a 240px
SteamOS sidebar drawn with Steam's own widgets and reached through Decky Loader;
the desktop app has nothing to render it into. It used to live in the shared
file anyway, where the PC build bundled it and threw it away.
