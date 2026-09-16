// The app entry point: register the routes, start the pollers, hand back a stop.
//
// Everything else in this directory is a page, a control or a piece of shared
// state; this file is only the wiring between them. It is what both shells call
// — the desktop's main.tsx and the Decky plugin's index.tsx — and the only
// thing either of them needs to know about the UI.

import { Navigation, routerHook, host } from "@ludo/host";
import { toaster, loadNotificationPrefs } from "./toast";
import {
  checkForUpdate,
  getCheckOnStartup,
  getConfig,
  getServiceStatus,
  getUpdateChannel,
  notifyNetworkState,
} from "./rpc";
import { _LS_REOPEN_HOME } from "./storage";
import { RouteGuard } from "./nav";
import { StatsPage } from "./pages/stats";
import { DownloadsPage } from "./pages/downloads";
import { CoresPage } from "./pages/cores";
import { ConfigPage } from "./pages/config";
import { SetupWizard } from "./pages/setup";
import { primePlatformSummary, SettingsPage } from "./pages/settings";
import { BiosPage } from "./pages/bios";
import { PlatformsPage } from "./pages/platforms";
import { GameDetailPage } from "./pages/game";
import { LibraryRootPage, LibraryGamesPage } from "./pages/library";
import { refreshStatusNow } from "./status";
import { stopBackgroundMonitoring, startBackgroundMonitoring } from "./notifications";
import { setPreDownloadHook } from "./downloads";
import { maybePromptSwitchFirmware } from "./firmware";

/**
 * Re-exported so the app's public surface stays two names.
 *
 * The Deck's Quick Access panel can refresh the library from outside the app's
 * own screens, and what a refresh *means* — retire the staleness banner, tell
 * every mounted grid to refetch — lives with the cache in libcache.ts. The
 * plugin should not have to know that.
 */
export { notifyLibraryRefreshed } from "./libcache";

// The Switch firmware prompt is a modal, so it belongs to the page tree, not to
// the download registry — which is why downloads.ts asks for it to be installed
// rather than calling it. Registered once, at module load.
setPreDownloadHook(maybePromptSwitchFirmware);

// Start monitoring immediately when module loads
console.log('[PLUGIN INIT] Module loaded, starting background monitoring');
startBackgroundMonitoring();

// Settings page component
// ---------------------------------------------------------------------------
// Shared save/state version types + formatters, used by the game detail
// Save Data tab (server save/state versions; restore in-place or as a copy).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Game Browser — controller-first library with cover art, per-game download,
// and metadata. Styled with RomM v2 tokens (V2), not the Steam/Decky chrome.
// Routes: /romm-sync-library  ->  /romm-sync-library/:key  ->  /romm-sync-game/:romId
// ---------------------------------------------------------------------------

// Stats page — 1:1 port of RomM's ServerStats.vue: a section stack of
// SummaryStatsSection (card grid in SettingsSection chrome) + PlatformsStatsSection
// (toolbar + per-platform rows with size/percentage and a progress bar that
// doubles as the row divider). Scope is plugin-local (this device).

// ─── Setup wizard ────────────────────────────────────────────────────────────
// Full-screen guided first-run flow (RomM v2 visual language): Welcome →
// Connect (login or pair code, with Test) → Folders → Finish. Auto-opened on
// startup when no connection is configured; also reachable from the QAM.

// Guards the startup setup-wizard auto-open so it fires at most once per session.
let _setupAutoOpened = false;

/**
 * Start Ludo: register every route, bind the app-lifetime watches, and hand
 * back a teardown.
 *
 * This is the whole entry point, and nothing shell-specific is left in it. The
 * Decky plugin calls it from its `definePlugin` factory and wraps its QAM panel
 * around the result; the desktop shell calls it once before first render. Which
 * of those is happening is not observable from here.
 */
export function startApp(): { stop: () => void } {
  // Every route is wrapped in RouteGuard: a page surfaced by a history POP the
  // plugin didn't initiate (Steam's own back walking into one of our entries,
  // fresh or stale) immediately pops again — see RouteGuard.
  routerHook.addRoute("/romm-sync-setup", () => <RouteGuard><SetupWizard /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-settings", () => <RouteGuard><SettingsPage /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-stats", () => <RouteGuard><StatsPage /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-cores", () => <RouteGuard><CoresPage /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-bios", () => <RouteGuard><BiosPage /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-platforms", () => <RouteGuard><PlatformsPage /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-downloads", () => <RouteGuard><DownloadsPage /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-config", () => <RouteGuard><ConfigPage /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-library", () => <RouteGuard><LibraryRootPage /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-library/:key", () => <RouteGuard><LibraryGamesPage /></RouteGuard>, { exact: true });
  routerHook.addRoute("/romm-sync-game/:romId", () => <RouteGuard><GameDetailPage /></RouteGuard>, { exact: true });

  // Register the launch intercept IMMEDIATELY — independent of tile
  // reconciliation.  The intercept checks the appid/name at fire time, so it
  // is safe to bind before the shortcut store is ready.  This fixes the bug
  // where clicking the Ludo tile in Big Picture did nothing until the user
  // opened the Decky panel (which triggered reconcileRommTile → register…).
  host.launcher.start({
    openLibrary: () => { Navigation.Navigate("/romm-sync-library"); Navigation.CloseSideMenus(); },
    isOwnRoute: (path) => path.startsWith("/romm-sync"),
  });

  // The user's notification switches, pulled once so every toast raised from
  // here on can consult them synchronously. Not awaited: the defaults are
  // permissive, so the worst case is that a toast in the first moments of
  // startup slips through a mute that had not landed yet.
  loadNotificationPrefs().catch(() => { });
  // Warm the only Settings value that cannot be known from a local preference.
  // The first visit reuses this promise, so its first visible frame already has
  // the platform count instead of repainting the row after navigation.
  primePlatformSummary().catch(() => { });

  // OS-level connectivity bridge: the Decky frontend runs in a Chromium context,
  // so navigator's online/offline events fire the instant the Deck's network
  // drops or returns — far faster than the backend's 5-min retry probe. Forward
  // each edge to the backend (which treats 'offline' as authoritative and
  // re-probes the server on 'online'), then force an immediate status poll so
  // the banner/tiles flip without waiting for the next 1.5s tick.
  const onNetOffline = () => { notifyNetworkState(false).catch(() => { }).finally(() => refreshStatusNow()); };
  const onNetOnline = () => { notifyNetworkState(true).catch(() => { }).finally(() => refreshStatusNow()); };
  try {
    window.addEventListener('offline', onNetOffline);
    window.addEventListener('online', onNetOnline);
    // Push the CURRENT connectivity state on mount. The online/offline events
    // only fire on a TRANSITION, so a plugin that loads while the Deck is
    // already offline (e.g. wifi not connected to any network) would never
    // inform the backend — leaving _device_online at None and mislabeling the
    // outage as 'server_unreachable' instead of 'no_network'. Seed it here.
    notifyNetworkState(navigator.onLine).catch(() => { }).finally(() => refreshStatusNow());
  } catch (e) { console.error('[RomM] net listeners', e); }

  // Just self-updated? Reopen the home page — the reload dropped the user out of
  // our full-screen UI. NOTE: the install triggers TWO plugin reloads in quick
  // succession (Decky uninstall + reinstall), so we must NOT consume the flag on
  // read — the first reload would clear it and the second (final) reload would
  // never navigate. Instead we leave it set and re-attempt on every reload; the
  // library page clears it once it actually mounts (see LibraryGroupsPage). The
  // 90s freshness window keeps a stale flag from hijacking a later normal launch.
  try {
    const ts = Number(localStorage.getItem(_LS_REOPEN_HOME) || 0);
    if (ts) {
      if (Date.now() - ts < 90000) {
        // Don't reopen Home on a fixed timer — the backend was just re-imported
        // by the update and spends several seconds reconnecting + loading the
        // library. Mounting the grid during that window fetches covers against a
        // half-ready backend and they come back empty (and stick). Wait until the
        // backend reports the library is ready, then navigate — mirroring what a
        // manual reopen does. Poll up to ~30s, then go anyway as a fallback.
        (async () => {
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            try {
              const s = await getServiceStatus();
              if (s?.status === 'connected' && s?.library_ready) break;
            } catch { /* backend not routing yet */ }
            await new Promise((r) => setTimeout(r, 1000));
          }
          try { Navigation.CloseSideMenus(); } catch { /* ignore */ }
          try { Navigation.Navigate("/romm-sync-library"); }
          catch (e) { console.error('[RomM] reopen home after update', e); }
          // Belt and braces: some Decky builds restore the QAM a beat later.
          setTimeout(() => { try { Navigation.CloseSideMenus(); } catch { /* ignore */ } }, 600);
        })();
      } else {
        // Stale flag from an old/abandoned update — drop it.
        localStorage.removeItem(_LS_REOPEN_HOME);
      }
    }
  } catch { /* ignore */ }

  // Passive update check on load: if enabled, look for a newer release on the
  // selected channel and toast the user (no auto-install — they install from
  // Settings ▸ Updates). The backend logs the outcome to debug.log.
  (async () => {
    try {
      if (!(await getCheckOnStartup())) return;
      const ch = await getUpdateChannel();
      const info = await checkForUpdate(ch);
      if (info?.success && info.available) {
        toaster.toast({
          title: `Update available: v${info.latest}`,
          body: '',
          duration: 6000,
        });
      }
    } catch (e) { console.error('[RomM] startup update check', e); }
  })();

  // Re-bind the launch intercept if the Ludo tile was added in a prior session,
  // and auto-open the setup wizard once when no connection is configured.
  (async () => {
    let configured = false;
    try { configured = !!(await getConfig())?.configured; } catch { /* ignore */ }
    if (configured) {
      try {
        // The tile is mandatory: ensure it EXISTS (create if missing), not just
        // reconcile. The shortcut store may not be ready this early, so retry
        // with exponential backoff until it is.
        const MAX_ATTEMPTS = 8;
        const ensureTile = async (attempt: number) => {
          try {
            if ((await host.launcher.reconcileTile()) != null) return;   // found + repaired
            // Create only once the shortcut store is populated — an empty
            // store usually means "not loaded yet", and creating then
            // duplicates the tile. On the final attempt force-create so a
            // user with a genuinely empty shortcut list still gets the tile.
            if ((await host.launcher.ensureTile(attempt >= MAX_ATTEMPTS)) != null) return;
          } catch (e) { console.error('[RomM] ensure tile', e); }
          if (attempt < MAX_ATTEMPTS) {
            const delay = Math.min(4000 * Math.pow(1.5, attempt), 15000);
            setTimeout(() => { ensureTile(attempt + 1); }, delay);
          }
        };
        await ensureTile(0);
      } catch (e) { console.error('[RomM] shortcut ensure', e); }
    } else if (!_setupAutoOpened) {
      // No connection yet: auto-open the wizard once per session (the tile is
      // created on wizard finish). Never re-trap the user after setup.
      _setupAutoOpened = true;
      setTimeout(() => { try { Navigation.Navigate("/romm-sync-setup"); } catch (e) { console.error('[RomM] setup auto-open', e); } }, 1500);
    }
  })();

  return {
    stop: () => {
      console.log('[PLUGIN] stop - Stopping background monitoring');
      stopBackgroundMonitoring();
      try {
        window.removeEventListener('offline', onNetOffline);
        window.removeEventListener('online', onNetOnline);
      } catch { /* ignore */ }
      host.launcher.stop();

      routerHook.removeRoute("/romm-sync-setup");
      routerHook.removeRoute("/romm-sync-settings");
      routerHook.removeRoute("/romm-sync-stats");
      routerHook.removeRoute("/romm-sync-cores");
      routerHook.removeRoute("/romm-sync-bios");
      routerHook.removeRoute("/romm-sync-platforms");
      routerHook.removeRoute("/romm-sync-downloads");
      routerHook.removeRoute("/romm-sync-config");
      routerHook.removeRoute("/romm-sync-library");
      routerHook.removeRoute("/romm-sync-library/:key");
      routerHook.removeRoute("/romm-sync-game/:romId");
    },
  };
}
