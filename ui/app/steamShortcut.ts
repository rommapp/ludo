/**
 * A game's own Steam shortcut (#105): whether it has one, and the toggle.
 *
 * Two mechanisms, chosen by what the shell can do rather than which shell it
 * is. Where tiles go through shortcuts.vdf (`capabilities.shortcutTile`, the
 * desktop app) the backend writes the entry with this shell's launch command,
 * and Steam only shows it after a restart. Where the shell drives Steam live
 * (`launcher.available`, the Deck plugin) the launcher adds it directly.
 */
import { useEffect, useState } from "react";
import { host } from "@ludo/host";
import { toaster } from "./toast";
import { getGameSteamShortcut, setGameSteamShortcut } from "./rpc";

export type GameSteamShortcut = {
  /** False where this shell has no way to add one; hide the action. */
  supported: boolean;
  installed: boolean;
  busy: boolean;
  toggle: () => void;
};

function viaVdf(): boolean {
  return !!host.capabilities.shortcutTile;
}

export function useGameSteamShortcut(romId: number | undefined, name: string, enabled: boolean): GameSteamShortcut {
  const supported = enabled && romId != null && (viaVdf() || host.launcher.available);
  const [installed, setInstalled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported || romId == null) { setInstalled(false); return; }
    let live = true;
    (async () => {
      try {
        const has = viaVdf()
          ? !!(await getGameSteamShortcut(romId))?.installed
          : await host.launcher.hasGameShortcut(romId);
        if (live) setInstalled(has);
      } catch { /* leave as is */ }
    })();
    return () => { live = false; };
  }, [supported, romId]);

  const toggle = () => {
    if (busy || romId == null) return;
    const want = !installed;
    setBusy(true);
    void (async () => {
      try {
        if (viaVdf()) {
          const spec = want ? host.app.launchSpec() : null;
          if (want && !spec?.exe) {
            toaster.toast({ title: 'Could not add to Steam', body: 'Could not determine how to relaunch Ludo.' });
            return;
          }
          const r = await setGameSteamShortcut(romId, want, spec?.exe || '', spec?.startDir || '', spec?.args || '');
          if (!r?.success) {
            toaster.toast({ title: want ? 'Could not add to Steam' : 'Could not remove from Steam', body: r?.message || 'Error' });
            return;
          }
          setInstalled(want);
          // Steam reads shortcuts.vdf at startup and rewrites it from memory on
          // exit, so a running Steam neither shows the change nor keeps it.
          toaster.toast({
            title: want ? `Added ${name} to Steam` : `Removed ${name} from Steam`,
            body: r.steam_running ? 'Restart Steam to see the change.'
              : want ? 'It is in your Steam library.' : 'It is gone from your Steam library.',
          });
        } else {
          const r = await host.launcher.setGameShortcut(romId, want);
          setInstalled(r.installed);
          if (!r.ok) {
            toaster.toast({ title: want ? 'Could not add to Steam' : 'Could not remove from Steam', body: r.message || 'Error' });
            return;
          }
          toaster.toast({
            title: want ? `Added ${name} to Steam` : `Removed ${name} from Steam`,
            body: want ? 'It is in your Steam library.' : 'It is gone from your Steam library.',
          });
        }
      } catch (e) {
        toaster.toast({ title: 'Steam shortcut failed', body: String(e) });
      } finally {
        setBusy(false);
      }
    })();
  };

  return { supported, installed, busy, toggle };
}
