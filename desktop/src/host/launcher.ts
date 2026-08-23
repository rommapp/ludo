/**
 * This shell's HostLauncher: there isn't one to drive.
 *
 * A PC window sits inside no launcher. There is no library tile to keep, no
 * overlay session to inherit, and nothing returns focus to us after a game — so
 * `available` is false and the tile methods are honest no-ops rather than failed
 * attempts at Steam's API.
 *
 * That is not the same as "no Steam integration". This shell can still put a
 * "RomM" tile in Steam's library; the backend writes shortcuts.vdf and Steam
 * picks it up on restart (see `capabilities.shortcutTile`). It is a different
 * mechanism with different limits — offline, needs a restart, no live app ids —
 * not a degraded version of the Deck's, which is why it is reached through the
 * backend rather than pretending to be a launcher here.
 *
 * launchRetroDeck is the one method with real work to do: RetroDECK is
 * launchable on any Linux box, it just isn't Steam-tracked out here.
 */
import { callable } from "./rpc";
import type { HostLauncher, LauncherHooks } from "../../../ui/host/contract";

const launchRetrodeckNative = callable<[], { ok: boolean; reason?: string }>("launch_retrodeck");

export const launcher: HostLauncher = {
  available: false,

  start(_hooks: LauncherHooks) {},
  stop() {},

  async hasTile() {
    return false;
  },
  async reconcileTile() {
    return null;
  },
  async ensureTile(_force = false) {
    return null;
  },
  async launchTile() {
    // False, so the caller falls back to launching the emulator directly —
    // which out here is the only path anyway.
    return false;
  },

  async launchRetroDeck() {
    try {
      return await launchRetrodeckNative();
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  },

  markRecentlyUsed() {},

  consumeReturnFocus() {
    // Nothing takes the screen away from us, so there is never focus to reclaim.
    return false;
  },

  onReturnFocus() {
    // ...and so nothing to subscribe to. The teardown is real, not null, so
    // callers can return it straight out of an effect.
    return () => {};
  },
};
