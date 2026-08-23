// What the library remembers between screens.
//
// The holders (_libGroupHolder, _libGameHolder, …) pass a selection from one
// route to the next. This is why /romm-sync-library/:key and
// /romm-sync-game/:romId look like they take parameters but do not: the page
// reads the holder the previous screen set, and arriving cold lands on "No
// group selected" rather than a 404.
//
// The caches underneath them are what make a back-navigation instant instead of
// a re-fetch, and they are persisted so a cold start paints the last known
// library before the server answers — or instead of it, when offline.

import { _lsAvail } from "./storage";
import { _LS_PLATICON, _platIconCache } from "./media";
import { _downloadedListeners, _broadcastLibRefresh} from "./events";
import type { LibGroup, LibGame } from "./types";
import type { NavId } from "./nav";
import { _dlSucceeded } from "./downloads";
import { pushLibView } from "./nav";
import { Navigation } from "@ludo/host";
import { _clearStale } from "./status";

// Module-level holders pass the selection between Game Browser routes without
// re-fetching (same pattern as _historyGameHolder).
let _libGroupHolder: { mode: string; group: LibGroup } | null = null;

// Sibling groups (same mode) so the game grid can page prev/next with L1/R1.
let _libGroupsHolder: { mode: string; groups: LibGroup[] } | null = null;

let _libGameHolder: LibGame | null = null;

// Route to return to when backing out of the game detail page. Steam's default
// NavigateBack on these custom Decky routes drops to the home/library root, so
// we navigate to the explicit origin route instead (set wherever a game opens).
let _libGameOrigin: string = "/romm-sync-library";

// Remember which library tab the user was on, so backing out of a games page
// returns to that tab (platforms/collections) instead of resetting to 'home'.
let _libLastTab: NavId = 'home';

// Per-group games cache (key: `${mode}:${groupKey}`) so paging to an already
// prefetched neighbour shows its covers instantly — the grid slides in with real
// content instead of popping in after an async fetch.
export const _libGamesCache = new Map<string, LibGame[]>();

// Wipe every cached browse list, in memory and in localStorage. Called on logout:
// the caches outlive the session, so without this the next sign-in paints the
// previous account's games from disk until a fetch replaces them.
// Not exported — see clearIdentityCache: a named export off this entry file
// breaks the bundle.
export function clearBrowseCaches() {
  _libGamesCache.clear();
  _homeCache = null;
  for (const k of Object.keys(_groupsCache)) delete _groupsCache[k];
  if (!_lsAvail) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(_LS_LIB_PREFIX)) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
    localStorage.removeItem(_LS_HOME_KEY);
    localStorage.removeItem(_LS_GROUPS_KEY);
  } catch { }
}

// ---- Persistent browse cache -------------------------------------------------
// The Maps/vars above live in module scope, so they reset every time the plugin
// is reloaded or the Steam UI restarts — the browse lists then have to be
// refetched from the RomM server on the next open. Mirror them into localStorage
// (which survives reloads) so a restart paints from disk instantly and only
// silently refreshes in the background.
export const _LS_LIB_PREFIX = 'romm:libcache:v1:';

export const _LS_HOME_KEY = 'romm:homecache:v1';

export const _LS_TTL_MS = 1000 * 60 * 60 * 24; // 24h; lists rarely churn, dots refresh on fetch

export function _persistLibGroup(key: string, list: LibGame[]) {
  if (!_lsAvail) return;
  try { localStorage.setItem(_LS_LIB_PREFIX + key, JSON.stringify({ t: Date.now(), v: list })); } catch { }
}

export function _dropLibGroup(key: string) {
  if (!_lsAvail) return;
  try { localStorage.removeItem(_LS_LIB_PREFIX + key); } catch { }
}
// Write-through helpers — use these instead of touching _libGamesCache directly.
export function libCacheSet(key: string, list: LibGame[]) { _libGamesCache.set(key, list); _persistLibGroup(key, list); }


// A game can appear in several cached groups (its platform + any collections), so
// flip is_downloaded across ALL of them. Without this, re-entering a group serves
// the stale cached list and the deleted game still shows as downloaded.
export function libCacheSetDownloaded(romId: number, downloaded: boolean) {
  // A deletion invalidates the "downloaded this session" marker, otherwise the
  // tile's clear-guard would keep the dot lit after delete.
  if (!downloaded) _dlSucceeded.delete(romId);
  for (const [key, list] of _libGamesCache) {
    if (!list.some((g) => g.rom_id === romId && !!g.is_downloaded !== downloaded)) continue;
    libCacheSet(key, list.map((g) => g.rom_id === romId ? { ...g, is_downloaded: downloaded } : g));
  }
  // A single-game download/delete doesn't otherwise touch _homeCache, so Home's
  // "Downloaded" row (and any other mounted grid) would only pick it up on the
  // next tab switch. Bulk syncs already broadcast after the batch (see
  // runCollectionBatch); mirror that here for the single-game path.
  _broadcastLibRefresh();
}

// Home tab data cache — survives tab-switch remounts so returning to Home paints
// instantly (then refreshes silently) instead of flashing "Loading…".
let _homeCache: {
  recent: LibGame[]; continuePlaying: LibGame[]; downloaded: LibGame[];
  platforms: LibGroup[]; collections: LibGroup[];
} | null = null;

export function persistHomeCache() {
  if (!_lsAvail || !_homeCache) return;
  try { localStorage.setItem(_LS_HOME_KEY, JSON.stringify({ t: Date.now(), v: _homeCache })); } catch { }
}

// Platforms/Collections index grids — same pattern as _homeCache: seed the grid
// from cache on tab switch (no "Loading…" flash / full remount pop-in), then
// refresh silently in the background.
export const _groupsCache: Record<string, LibGroup[] | undefined> = {};

export const _LS_GROUPS_KEY = 'romm:groupscache:v1';

export function persistGroupsCache() {
  if (!_lsAvail) return;
  try { localStorage.setItem(_LS_GROUPS_KEY, JSON.stringify({ t: Date.now(), v: _groupsCache })); } catch { }
}

// ── Setters ─────────────────────────────────────────────────────────────────
//
// Each of these is assigned from a page, and an imported `let` is read-only at
// the importing end — so the assignment has to happen on this side. They are
// not ceremony; they are what the language requires.

export function setLibGroupHolder(v: { mode: string; group: LibGroup } | null) { _libGroupHolder = v; }
export function setLibGroupsHolder(v: { mode: string; groups: LibGroup[] } | null) { _libGroupsHolder = v; }
export function setLibGameHolder(v: LibGame | null) { _libGameHolder = v; }
export function setLibGameOrigin(v: string) { _libGameOrigin = v; }
export function setLibLastTab(v: NavId) { _libLastTab = v; }
export function setHomeCache(v: typeof _homeCache) { _homeCache = v; }

// Reading them is a plain export; only the assignment needs a function.
export function getLibGroupHolder() { return _libGroupHolder; }
export function getLibGroupsHolder() { return _libGroupsHolder; }
export function getLibGameHolder() { return _libGameHolder; }
export function getLibGameOrigin() { return _libGameOrigin; }
export function getLibLastTab() { return _libLastTab; }
export function getHomeCache() { return _homeCache; }

// The downloader announces; this cache is what acts on it. See events.ts for
// why the dependency runs this way round.
_downloadedListeners.add((romId, downloaded) => libCacheSetDownloaded(romId, downloaded));

// ── Focused platform ────────────────────────────────────────────────────────
//
// The platform the currently-focused tile belongs to, so the top bar can offer
// "open this platform" without the grid having to reach up into the chrome.

// The focused platform tile's actions menu, published so the library page's Y
// handler can reach it. Y opens the account menu everywhere EXCEPT a focused
// platform tile, where the platform's own menu is the more useful thing and the
// account menu is still one press away on ☰ Start. A module-level handle rather
// than prop drilling: the handler lives on the page root, five components above
// the tile, and only ever wants whichever tile is focused right now.
export let _focusedPlatform: { label: string; open: () => void } | null = null;

export const _focusedPlatformSubs = new Set<(p: typeof _focusedPlatform) => void>();

export function _setFocusedPlatform(p: typeof _focusedPlatform) {
  _focusedPlatform = p;
  _focusedPlatformSubs.forEach((fn) => { try { fn(p); } catch { /* ignore */ } });
}

export function libCacheDelete(key: string) { _libGamesCache.delete(key); _dropLibGroup(key); }

// Remove a game from every cached group. Called when the server has confirmed
// the ROM is gone — the backend has already dropped it from the library, but
// the cached lists (its platform, any collections, Home) would keep serving the
// tile until the next full refetch, which is exactly the phantom this exists to
// clear. Mirrors libCacheSetDownloaded's fan-out rather than invalidating
// everything, so nothing else has to be re-fetched.
export function libCacheDrop(romId: number) {
  _dlSucceeded.delete(romId);
  for (const [key, list] of _libGamesCache) {
    if (!list.some((g) => g.rom_id === romId)) continue;
    libCacheSet(key, list.filter((g) => g.rom_id !== romId));
  }
  _broadcastLibRefresh();
}

// Find a cached LibGame by rom id, across every group it might sit in. Used to
// open a game from somewhere that only knows an id (the Downloads page's
// completed list). Returns null when nothing is cached — see openGameById for
// what happens then.
export function libCacheFindGame(romId: number): LibGame | null {
  for (const [, list] of _libGamesCache) {
    const g = list.find((x) => x.rom_id === romId);
    if (g) return g;
  }
  // Home's rows aren't in _libGamesCache, and a just-downloaded game is very
  // likely sitting in one of them.
  for (const list of [getHomeCache()?.downloaded, getHomeCache()?.recent, getHomeCache()?.continuePlaying]) {
    const g = list?.find((x) => x.rom_id === romId);
    if (g) return g;
  }
  return null;
}

// Open the game detail page knowing only a rom id (and, at best, a name).
// GameDetailPage fetches its own detail from the backend, so a stub is enough
// to render — the cached LibGame is preferred only because it paints the name,
// platform and downloaded state on the first frame instead of after the fetch.
export function openGameById(romId: number, name: string, origin: string) {
  const cached = libCacheFindGame(romId);
  setLibGameHolder(cached || {
    rom_id: romId, name, platform: null,
    is_downloaded: true, has_cover: true,
  });
  setLibGameOrigin(origin);
  if (!pushLibView('game')) Navigation.Navigate(`/romm-sync-game/${romId}`);
}

// Whether the live save-sync notification may appear. Cached module-side: it is
// read from the background notification poll (which is not a component at all)
// as well as from the Settings switch, and it changes only when the user flips
// that switch. The listener set is what lets the flip take effect without a
// reload.
export let _syncPillPref: boolean | null = null;

/** The sync-pill preference, or null until it has been read from storage. */
export function syncPillPref(): boolean | null { return _syncPillPref; }

export const _syncPillListeners = new Set<() => void>();

export function _setSyncPillPref(on: boolean) {
  _syncPillPref = on;
  _syncPillListeners.forEach((l) => { try { l(); } catch { } });
}

/**
 * "The library just changed underneath you" — retire the staleness banner and
 * tell every mounted view to refetch.
 *
 * Exported because the Deck's Quick Access panel can refresh the library too,
 * from outside the app's own screens. It calls this rather than reaching for
 * _clearStale and _broadcastLibRefresh itself, which keeps what a refresh
 * *means* on this side of the seam and the plugin's import surface at two
 * names.
 */
export function notifyLibraryRefreshed() {
  _clearStale();
  _broadcastLibRefresh();
}

// Hydrate both caches once at module load from any non-expired localStorage data.
(function _hydrateBrowseCaches() {
  if (!_lsAvail) return;
  const now = Date.now();
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(_LS_LIB_PREFIX)) continue;
      try {
        const o = JSON.parse(localStorage.getItem(k) || 'null');
        if (o && Array.isArray(o.v) && (now - (o.t || 0)) < _LS_TTL_MS)
          _libGamesCache.set(k.slice(_LS_LIB_PREFIX.length), o.v);
        else stale.push(k);
      } catch { stale.push(k); }
    }
    stale.forEach((k) => { try { localStorage.removeItem(k); } catch { } });
  } catch { }
  try {
    const o = JSON.parse(localStorage.getItem(_LS_HOME_KEY) || 'null');
    if (o && o.v && (now - (o.t || 0)) < _LS_TTL_MS) setHomeCache(o.v);
    else if (o) localStorage.removeItem(_LS_HOME_KEY);
  } catch { }
  try {
    const o = JSON.parse(localStorage.getItem(_LS_GROUPS_KEY) || 'null');
    if (o && o.v && (now - (o.t || 0)) < _LS_TTL_MS)
      for (const k of Object.keys(o.v)) _groupsCache[k] = o.v[k];
    else if (o) localStorage.removeItem(_LS_GROUPS_KEY);
  } catch { }
  try {
    const o = JSON.parse(localStorage.getItem(_LS_PLATICON) || 'null');
    if (o && typeof o === 'object')
      for (const k of Object.keys(o)) _platIconCache.set(k, o[k]);
  } catch { }
})();
