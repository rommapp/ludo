/**
 * Every toast the UI raises, and the user's say in whether it appears.
 *
 * Ludo's toasts go up from a dozen modules, and until there was a preference to
 * honour it was fine for each to reach for the host toaster directly. Now there
 * is one, this module owns that call: it is the only place in the shared UI that
 * imports `toaster` from the host, so a mute cannot be defeated by a call site
 * that forgot about it.
 *
 * Two switches, matching the backend's `Notifications` settings section:
 *
 *   enabled     master mute — "sync my saves totally silently"
 *   connection  just the connect/disconnect pair, which on a handheld that
 *               sleeps, wakes and roams is the noisiest and the least
 *               actionable of them
 *
 * See Covin90/romm-retroarch-sync#24. The engine honours the master switch
 * separately (sync_core.set_notifications_enabled) because it raises toasts down
 * paths this file never sees — the drain queue while the app is closed, and
 * RetroArch's on-screen display.
 */
import { toaster as hostToaster } from "@ludo/host";
import { getNotificationPrefs, setNotificationPrefsRpc } from "./rpc";

export type ToastCategory = 'connection';

export type NotificationPrefs = { enabled: boolean; connection: boolean };

// Read on every toast, so it has to be synchronous — a toast is raised at the
// moment the thing happens and cannot wait for a round trip. Hydrated once at
// startup (see loadNotificationPrefs) and thereafter written by the Settings
// page. Defaults are ON so a backend that never answers is not a silent one.
let _prefs: NotificationPrefs = { enabled: true, connection: true };

export function notificationPrefs(): NotificationPrefs {
  return _prefs;
}

/** Pull the saved preferences from the backend. Called once at startup. */
export async function loadNotificationPrefs(): Promise<NotificationPrefs> {
  try {
    const r = await getNotificationPrefs();
    if (r?.success) {
      _prefs = { enabled: r.enabled !== false, connection: r.connection !== false };
    }
  } catch { /* backend not up yet — keep the permissive defaults */ }
  return _prefs;
}

/**
 * Persist a change and apply it locally at once, so the switch the user just
 * flipped takes effect on the next toast rather than on the next reload.
 */
export async function saveNotificationPrefs(
  patch: Partial<NotificationPrefs>,
): Promise<NotificationPrefs> {
  _prefs = { ..._prefs, ...patch };
  try {
    const r = await setNotificationPrefsRpc(
      patch.enabled ?? null, patch.connection ?? null);
    if (r?.success) {
      _prefs = { enabled: r.enabled !== false, connection: r.connection !== false };
    }
  } catch { /* the local value still stands; it re-reads on next start */ }
  return _prefs;
}

/** Whether a toast in this category would be shown right now. */
export function toastsAllowed(category?: ToastCategory): boolean {
  if (!_prefs.enabled) return false;
  if (category === 'connection' && !_prefs.connection) return false;
  return true;
}

type HostToastOptions = Parameters<typeof hostToaster.toast>[0];

/**
 * Drop-in for the host toaster, plus an optional `category`. The category is
 * ours, not the host's, so it is stripped before the options go through.
 */
export const toaster = {
  toast(options: HostToastOptions & { category?: ToastCategory }) {
    const { category, ...rest } = (options ?? {}) as any;
    if (!toastsAllowed(category)) return null;
    return hostToaster.toast(rest);
  },
};
