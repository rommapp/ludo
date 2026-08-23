// Getting from one screen to another, and back out again.
//
// Back is the awkward one. Steam's own back walks its history, which includes
// our route entries, so a plugin page can be surfaced by a POP we did not
// initiate — stale or otherwise — and the user ends up somewhere they never
// navigated to. RouteGuard is the answer: a page reached by an unexpected POP
// pops straight back out. _expectedPopAt is how it tells the two apart.
//
// The library is a second layer on top of that: its tabs and sub-views are not
// routes at all, so pushLibView hands them to whichever library page is
// currently mounted, and falls back to a real navigation when none is.

import { useEffect } from "react";
import { Navigation, Router } from "@ludo/host";

export type NavId = 'home' | 'platforms' | 'collections' | 'search';

// ── In-library view switching (route-level keep-alive) ───────────────────────
// Steam's router unmounts a route's entire tree on navigation, so every trip
// into a platform grid / game detail / settings used to rebuild the four
// keep-alive tab panels on the way back (~100–200ms of long tasks plus a
// cover re-decode burst). Instead of leaving /romm-sync-library at all, the
// inner pages now mount as views INSIDE that route (LibraryRootPage) while
// the tabs tree stays mounted hidden underneath — same display:none trick
// that made tab switching instant, extended one level up.
// These module hooks are only set while LibraryRootPage is mounted; when they
// are null (e.g. Settings opened from the QAM as a real route) callers fall
// back to genuine navigation, preserving the old behavior.
export type LibView = 'grid' | 'game' | 'settings' | 'stats' | 'cores' | 'bios' | 'downloads';

// ── History-aware back navigation ────────────────────────────────────────────
// Navigation.Navigate always PUSHES a history entry. Backing out of our pages
// by pushing the origin route filled the router history with /romm-sync-*
// entries, so after leaving the plugin, B in Steam's OWN library popped that
// polluted stack and dragged the user back into the plugin (endless loop).
// The fix is to genuinely POP our entries. The Gamepad UI's react-router
// history is undocumented but reachable; everything is feature-detected with
// the old push as fallback.
export const _gpHistory = (): any => {
  try { return (Router as any)?.WindowStore?.GamepadUIMainWindowInstance?.m_history; }
  catch { return undefined; }
};

// Timestamp of the last pop WE initiated. RouteGuard uses it to tell "the user
// backed out of a plugin page" (expected — render normally) apart from "Steam's
// own back walked into a plugin history entry" (unexpected — keep popping).
export let _expectedPopAt = 0;

// Pop one history entry: react-router v5 history has goBack(), the newer
// history lib has back(); Steam's native NavigateBack as a last resort.
export function _histBack(h: any): boolean {
  try {
    if (typeof h?.goBack === 'function') { h.goBack(); return true; }
    if (typeof h?.back === 'function') { h.back(); return true; }
  } catch { /* ignore */ }
  try { Navigation.NavigateBack(); return true; } catch { /* ignore */ }
  return false;
}

// Back out of a plugin page by genuinely POPPING the router history (pushing
// the origin route instead is what polluted the history and made Steam's own
// B walk back into the plugin). The entry below is the page that pushed us —
// a plugin page or, for e.g. Settings opened from the QAM, the Steam page the
// user was on; both are correct destinations.
export function navBack(fallback: string) {
  _expectedPopAt = Date.now();
  if (!_histBack(_gpHistory())) {
    try { Navigation.Navigate(fallback); } catch { /* ignore */ }
  }
}

// B at the library root: leave the plugin with an UNEXPECTED pop — if the
// entry below is another plugin page (e.g. stale entries left by an earlier
// visit or a pre-update build), its RouteGuard keeps the cascade going until
// a real Steam page is on top.
export function navExitPlugin() {
  _expectedPopAt = 0;
  _histBack(_gpHistory());
}

let _libPushView: ((v: LibView) => void) | null = null;

let _libPopView: (() => void) | null = null;
const _libViewForRoute: Record<string, LibView> = {
  '/romm-sync-settings': 'settings',
  '/romm-sync-stats': 'stats',
  '/romm-sync-cores': 'cores',
  '/romm-sync-bios': 'bios',
  '/romm-sync-downloads': 'downloads',
};


// Open a plugin page: as an in-library view when the library route hosts us,
// as a real route otherwise (QAM entry points, stale fallbacks).
export function libNavigate(route: string) {
  const v = _libViewForRoute[route];
  if (v && _libPushView) { _libPushView(v); return; }
  try { Navigation.Navigate(route); } catch { /* ignore */ }
}

// Back out of a plugin page: pop the in-library view stack when hosted,
// otherwise genuinely pop the router history.
export function libBack(fallback: string) {
  if (_libPopView) { _libPopView(); return; }
  navBack(fallback);
}

// Wraps every plugin route. A plugin page entered via a history POP we did not
// initiate means Steam's back navigation surfaced one of our history entries
// (possibly stale, from before a plugin update) — immediately pop again, so B
// cascades through plugin entries and always lands on a real Steam page. All
// intentional entries into the plugin arrive via PUSH and render normally.
export function RouteGuard({ children }: { children: any }) {
  useEffect(() => {
    try {
      const h = _gpHistory();
      if (h?.action === 'POP') {
        if (Date.now() - _expectedPopAt < 1500) _expectedPopAt = 0;
        else _histBack(h);
      }
    } catch { /* ignore */ }
  }, []);
  return children;
}

/**
 * Installed by the library root while it is mounted, cleared on unmount.
 *
 * Exported as a function rather than as the two bindings themselves because an
 * imported `let` is read-only at the importing end — the assignment has to
 * happen on this side.
 */
export function setLibViewHooks(push: ((v: LibView) => void) | null, pop: (() => void) | null) {
  _libPushView = push;
  _libPopView = pop;
}

/** Push an in-library view; false if no library route is hosting us. */
export function pushLibView(v: LibView): boolean {
  if (!_libPushView) return false;
  _libPushView(v);
  return true;
}

/** Pop one in-library view; false if no library route is hosting us. */
export function popLibView(): boolean {
  if (!_libPopView) return false;
  _libPopView();
  return true;
}
