/**
 * The Decky plugin: Ludo plus the one surface only a Deck has.
 *
 * Decky Loader loads this file and keeps the descriptor its default export
 * returns. Everything in that descriptor except `startApp()` is Deck-specific —
 * the Quick Access Menu panel, and the name and icon Decky lists us under.
 *
 * `startApp()` is the whole app: it registers the routes and starts the
 * watches, and returns a teardown that Decky's `onDismount` calls when the
 * plugin is unloaded. The desktop shell calls the same function and renders no
 * panel at all.
 *
 * The app is reached through `./app`, a dev symlink to `ui/app/`. That is a
 * symlink rather than a tsconfig path because pointing `paths` outside `src/`
 * desyncs @rollup/plugin-typescript's emit and fails the build — the same
 * reason `src/host/contract.ts` is one.
 */
import { definePlugin } from "@decky/api";
import { FaSync } from "react-icons/fa";

import { startApp } from "./app";
import { QuickAccessPanel, QuickAccessTitle } from "./quick-access";

export default definePlugin(() => {
  const app = startApp();
  return {
    name: "Ludo",
    titleView: <QuickAccessTitle />,
    content: <QuickAccessPanel />,
    icon: <FaSync />,
    onDismount: () => app.stop(),
  };
});
