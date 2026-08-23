# ui/

Parts of Ludo's interface that belong to Ludo rather than to either shell.

Today that is one file:

- **`host/contract.ts`** — what the UI needs from the shell it runs inside.
  `decky_plugin/src/host/` and `desktop/src/host/` each implement it, and both
  builds resolve the `@ludo/host` specifier to their own adapter. Nothing in the
  shared UI imports `@decky/*`, and nothing branches on which shell it is in.

`decky_plugin/src/host/contract.ts` is a dev symlink to this file. It exists
because `@rollup/plugin-typescript` shifts its emit paths when a file outside
the plugin's `src/` enters the TypeScript program, which leaves `index.tsx`
untransformed and fails the build. Same pattern as the Python side's
`py_modules/ludo_app`.

Steam's library-tile machinery and its gamepad-focus internals are behind their
own seams in that contract (`HostLauncher`, `HostFocus`) rather than being
flattened into capability flags: both are cohesive subsystems, undocumented and
version-fragile, and they belong in one adapter each rather than threaded
through the shared UI.

The shared UI itself (`decky_plugin/src/index.tsx`) still lives under
`decky_plugin/`, which is the last thing about this arrangement that still reads
as "the Deck build, plus a PC lookalike". Moving it here is the next step, not a
finished one.
