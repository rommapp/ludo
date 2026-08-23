# ui/

Ludo's interface, and the interface it needs from whatever is hosting it.

- **`app/`** — the app itself: every route, every page, every control. Both
  shells render this same code. `index.tsx` exports `startApp()`, which
  registers the routes and starts the backend watches and hands back a
  teardown; that one function is the whole entry point.
- **`host/contract.ts`** — what the app needs from the shell it runs inside.
  `decky_plugin/src/host/` and `desktop/src/host/` each implement it, and both
  builds resolve the `@ludo/host` specifier to their own adapter. Nothing in
  `app/` imports `@decky/*`, and nothing branches on which shell it is in — it
  asks what the shell can do.

Steam's library-tile machinery and its gamepad-focus internals are behind their
own seams in that contract (`HostLauncher`, `HostFocus`) rather than being
flattened into capability flags: both are cohesive subsystems, undocumented and
version-fragile, and they belong in one adapter each rather than threaded
through the shared UI.

## The two dev symlinks

`decky_plugin/src/app` → `ui/app`, and `decky_plugin/src/host/contract.ts` →
`ui/host/contract.ts`. Both exist because `@rollup/plugin-typescript` shifts its
emit paths when a file outside the plugin's `src/` enters the TypeScript
program, which leaves `index.tsx` untransformed and fails the build. Same
pattern as the Python side's `py_modules/ludo_app`.

They have a sharp edge worth knowing about, because it has bitten this project
and it fails **silently**: rollup resolves the `src/app` symlink to its real
path, so a bare import from inside `ui/app/` is looked up by walking up from
`ui/`, which never reaches `decky_plugin/node_modules`. `react-icons` then falls
through as an unresolved external and the plugin builds clean, reports success,
and ships with missing icons. `decky_plugin/rollup.config.js` pins those
packages for that reason; `desktop/vite.config.ts` pins the same ones for the
mirror-image reason. If you add a dependency the shared UI imports directly,
pin it in both.

A build is not evidence on its own here. The check that catches it is the
bundle's sourcemap: every `react-icons/*` family the UI imports must appear in
`dist/index.js.map`'s sources, and no `from 'react-icons` import may survive in
`dist/index.js`.

## What is NOT here

The Quick Access Menu panel (`decky_plugin/src/quick-access.tsx`). It is a
240px SteamOS sidebar drawn with Steam's own widgets and reached through Decky
Loader; the desktop app has nothing to render it into. It used to live in the
shared file anyway, where the PC build bundled it and threw it away.
