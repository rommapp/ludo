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

let _offLaunch: (() => void) | null = null;

export const launcher: HostLauncher = {
  available: false,

  // A game's own Steam shortcut runs this shell with --launch=<rom_id>; the
  // main process holds it until we ask. Later ones arrive while we're running.
  start(hooks: LauncherHooks) {
    const b = (window as any).__rommDesktop;
    if (!b?.takeLaunch) return;
    const go = (id: unknown, closeAfter = false) => {
      const romId = Number(id);
      if (romId > 0) hooks.launchGame(romId, '', { closeAfter });
    };
    _offLaunch?.();
    // Forwarded to an already-open window: that window stays open.
    _offLaunch = b.onLaunch?.((id: unknown) => go(id)) ?? null;
    const first = b.takeLaunch();
    if (first) go(first.romId, !!first.closeAfter);
  },
  stop() {
    _offLaunch?.();
    _offLaunch = null;
  },

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

  // A game here is its own desktop window, reachable like any other.
  sessionRunning() {
    return false;
  },
  resumeSession() {
    return false;
  },

  // Per-game shortcuts go into shortcuts.vdf through the backend here, like
  // the tile (capabilities.shortcutTile); there is no live library to touch.
  async hasGameShortcut(_romId: number) {
    return false;
  },
  async setGameShortcut(_romId: number, _enabled: boolean) {
    return { ok: false, installed: false, message: 'Not available in this shell' };
  },
};
