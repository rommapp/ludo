import {
  Navigation,
  Focusable,
  GamepadButton,
  showModal,
  ModalRoot,
  toaster,
  routerHook,
  host,
} from "@ludo/host";
import { useState, useEffect, useRef } from "react";
import { FaCheck } from "react-icons/fa";
import {
  checkForUpdate,
  getCheckOnStartup,
  getConfig,
  getServiceStatus,
  getStateThumbnails,
  getUpdateChannel,
  notifyNetworkState,
} from "./rpc";
import { V2 } from "./theme";
import { LibGame } from "./types";
import { _lsAvail, _LS_REOPEN_HOME } from "./storage";
import { _libRefreshListeners, _broadcastLibRefresh, _downloadedListeners } from "./events";
import { _LS_PLATICON, _coverInflight } from "./media";
import { setPreDownloadHook } from "./downloads";
import { V2_FOCUS_STYLE } from "./focus";
import { RouteGuard } from "./nav";
import { pushLibView } from "./nav";
import { StatsPage } from "./pages/stats";
import { DownloadsPage } from "./pages/downloads";
import { CoresPage } from "./pages/cores";
import { ConfigPage } from "./pages/config";
import { SetupWizard } from "./pages/setup";
import { SettingsPage } from "./pages/settings";
import { BiosPage } from "./pages/bios";
import { PlatformsPage } from "./pages/platforms";
import { maybePromptSwitchFirmware } from "./firmware";
import { GameDetailPage } from "./pages/game";
import { runLaunch } from "./launch";
import { scrubGlimpse, _scrubLetterOf} from "./scrub";
import { LibraryRootPage, LibraryGamesPage } from "./pages/library";
import {
  _LS_GROUPS_KEY,
  _LS_HOME_KEY,
  _LS_LIB_PREFIX,
  _LS_TTL_MS,
  _dropLibGroup,
  _groupsCache,
  _libGamesCache,
  _persistLibGroup,
  libCacheSetDownloaded,
  getHomeCache,
  setHomeCache,
  setLibGameHolder,
  setLibGameOrigin,
  libCacheSet,
} from "./libcache";
import {
  _subscribeStatus,
  refreshStatusNow,
  SaveActivity,
  _pushSaveActivity,
  useSaveActivity,
  _clearStale,
} from "./status";
import { UserMenuRow, _gameLabel, useRowHighlight } from "./kit";
import {
  _forceGamepadFocus,
  _gpFocusEl,
  _summonVirtualKeyboard,
  _dismissVirtualKeyboard,
  _autoFocusFirstRef,
} from "./shell";
import { _dlActive, _dlQueue, _dlSucceeded, _dlListeners, _setDlActive, _batchJobs } from "./downloads";
import { startBackgroundMonitoring, stopBackgroundMonitoring } from "./notifications";
import {
  qGetImage,
  qGetGameCover,
  _platIconCache,
  _platIconCacheSet,
  _coverCache,
  _coverCacheReset,
  peekCover,
  awaitCover,
} from "./media";










// Full-screen modal scrims stop short of the button legend at the bottom of the
// screen, so the hints for the modal's own buttons stay readable while it is
// open — dimming and blurring the one bar that says which button does what is
// exactly backwards. The desktop shim publishes its legend height as
// --shim-legend-h; on the Deck the variable is absent and the fallback is
// Steam's own fixed legend, measured at 42px on-device.
export const MODAL_SCRIM_INSET = '0 0 var(--shim-legend-h, 42px) 0';











// Box art for a toast's logo slot, so a "Downloaded" notification shows the
// game rather than just naming it. The cover is nearly always already in
// `_coverCache` — the tile the user pressed painted it — so this renders on the
// first frame; a cache miss loads in behind nothing rather than reserving an
// empty box, and a rom with no art renders nothing at all, which lets the host
// fall back to its own icon instead of showing a grey rectangle.
export function ToastCover({ romId, hasCover }: { romId: number; hasCover: boolean }) {
  const ck = `cover:${romId}:false`;
  const [uri, setUri] = useState<string | null>(peekCover(ck) ?? null);
  useEffect(() => {
    if (!hasCover || peekCover(ck) !== undefined) return;
    let alive = true;
    awaitCover(ck, () => qGetGameCover(romId, false))
      .then((u) => { if (alive) setUri(u); })
      .catch(() => { /* no art, no logo */ });
    return () => { alive = false; };
  }, [romId]);
  if (!uri) return null;
  return (
    <img src={uri} style={{
      // Box art is the fastest way to recognise which game a toast is about,
      // and at 32px it read as an icon rather than a cover. Height-capped as
      // well as width-set: the toast is only so tall, and a 3:4 portrait is the
      // dimension that runs out first.
      width: '56px', maxHeight: '76px', aspectRatio: '3 / 4',
      objectFit: 'cover', display: 'block',
      borderRadius: V2.radiusSm, border: '1px solid rgba(255,255,255,0.12)',
    }} />
  );
}




// The Switch firmware prompt is a modal, so it belongs to the page tree, not to
// the download registry — which is why downloads.ts asks for it to be installed
// rather than calling it. Registered once, at module load.
setPreDownloadHook(maybePromptSwitchFirmware);



















// Live game tiles by rom_id, and the rom_id of the last game launched. Coming
// back from a session, restoring focus to the FIRST tile lost the user's place
// — on a long list the game they just played could be scrolled far off screen.
// Aiming at the tile they launched keeps the selection where they left it.
// A plain Map (not WeakMap): the value IS the key's only strong ref here, and
// entries are removed on unmount.
export const _tileElsByRomId = new Map<number, any>();







// Is THIS game's save the one moving? The engine resolves the rom_id from the
// save file it is uploading, so the answer is exact rather than a name match.
//
// Siblings count as the same tile. A multi-region game is ONE card standing for
// several server rows, and the save came from whichever row was launched — with
// a bare rom_id test, playing the USA copy of a game whose card is keyed to the
// European one lights nothing at all.
export function useSaveActivityFor(game?: { rom_id: number; sibling_roms?: { rom_id: number }[] } | null): SaveActivity | null {
  const a = useSaveActivity();
  if (!a || a.rom_id == null || !game) return null;
  if (a.rom_id === game.rom_id) return a;
  return (game.sibling_roms || []).some((sib) => sib.rom_id === a.rom_id) ? a : null;
}

// Whether the live save-sync notification may appear. Cached module-side: it is
// read from the background notification poll (which is not a component at all)
// as well as from the Settings switch, and it changes only when the user flips
// that switch. The listener set is what lets the flip take effect without a
// reload.
let _syncPillPref: boolean | null = null;

/** The sync-pill preference, or null until it has been read from storage. */
export function syncPillPref(): boolean | null { return _syncPillPref; }
export const _syncPillListeners = new Set<() => void>();
export function _setSyncPillPref(on: boolean) {
  _syncPillPref = on;
  _syncPillListeners.forEach((l) => { try { l(); } catch { } });
}


















































// ── GameDetails sub-components (faithful to RomM's OverviewTab / MetadataTab) ──

// Uppercase eyebrow heading for an overview section (RomM
// .overview-tab__section-heading).
export function SectionHeading({ icon, children }: { icon?: any; children: any }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: '6px', margin: 0,
      fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em',
      textTransform: 'uppercase', color: V2.fgFaint,
    }}>
      {icon}{children}
    </div>
  );
}
























// The downloader announces; the cache is what acts on it. See events.ts for
// why this is a subscription rather than a call from the other direction.
_downloadedListeners.add((romId, downloaded) => libCacheSetDownloaded(romId, downloaded));




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
function libCacheFindGame(romId: number): LibGame | null {
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
















// Placeholder block with a slow left-to-right sheen — the shared building brick
// for every "we don't know this yet" shape.
export function Shimmer({ style }: { style?: any }) {
  return (
    <div style={{
      background: V2.bgElevated, borderRadius: V2.radiusSm, overflow: 'hidden',
      position: 'relative', ...style,
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.055) 50%, transparent 80%)',
        animation: 'rommShimmer 1.4s ease-in-out infinite',
      }} />
    </div>
  );
}






// Last known value of the resume-from-state preference. Persisted, because the
// Home row has to decide how to draw itself on the FIRST frame: read from the
// backend it arrives a round-trip late, and the row visibly re-lays-itself out
// from box art to state screenshots every time Home opens.
const _LS_RESUME_PREF = 'romm:resumestates:v1';
export let _resumeStatesPref = (() => {
  try { return _lsAvail && localStorage.getItem(_LS_RESUME_PREF) === '1'; }
  catch { return false; }
})();
export function _setResumeStatesPref(v: boolean) {
  _resumeStatesPref = v;
  try { if (_lsAvail) localStorage.setItem(_LS_RESUME_PREF, v ? '1' : '0'); } catch { }
}

// Save-state screenshots for the Continue playing row, rom_id → data URI (null
// = this game has no state picture). Module-level so returning to Home repaints
// from memory instead of re-asking, and shared by every mount of the row.
export const _stateThumbs = new Map<number, string | null>();
let _stateThumbsInflight: Promise<void> | null = null;
// Fetches every missing thumbnail in ONE backend call. Per-tile calls turned a
// 15-card row into 15 websocket round-trips, each of which could fall through
// to its own RomM request; batched, the backend overlaps the misses on a thread
// pool and answers once. Resolves when the map has been filled.
// A play session creates or replaces save states, and "this game has no state"
// is cached as null just as firmly as a picture — so after playing, the row
// would keep showing box art until the next app start. Drop the lot; the row's
// own effect refetches, and a Continue-playing-sized batch is one call.
export const _stateThumbListeners = new Set<() => void>();
export function invalidateStateThumbs() {
  _stateThumbs.clear();
  // Clearing alone isn't enough: the row refetches from an effect keyed on the
  // games it shows, and after a session those are usually the same games.
  _stateThumbListeners.forEach((l) => { try { l(); } catch { } });
}

export async function loadStateThumbs(romIds: number[], force = false): Promise<void> {
  const missing = romIds.filter((id) => !_stateThumbs.has(id));
  if (!missing.length) return;
  if (_stateThumbsInflight) await _stateThumbsInflight;
  const still = romIds.filter((id) => !_stateThumbs.has(id));
  if (!still.length) return;
  _stateThumbsInflight = (async () => {
    try {
      const r = await getStateThumbnails(still, force);
      const thumbs = r?.thumbs || {};
      // Absent keys are recorded as null too: the backend answered, and without
      // this the next visit would ask again for the same nothing.
      for (const id of still) _stateThumbs.set(id, thumbs[String(id)] ?? null);
    } catch {
      // Leave them unset so the next visit retries rather than caching a
      // failure as "no state".
    } finally {
      _stateThumbsInflight = null;
    }
  })();
  await _stateThumbsInflight;
}



// Entering a grid/row container from above or below should land on the tile in
// the SAME COLUMN you came from, not the container's remembered last-active
// child (Steam's default "preferred child" made UP/DOWN between rows snap back
// to wherever you were last in that row — verified on-device by live-patching
// nav nodes). 2 = NavEntryPositionPreferences.MAINTAIN_X (@decky/ui declares
// the enum but doesn't export it at runtime). Spread as any: not in decky's
// FocusableProps typing, but Steam's Focusable forwards it into m_Properties.
export const NAV_MAINTAIN_X = { navEntryPreferPosition: 2 } as any;

let _scrubFocusTs = 0;
let _scrubStreak = 0;
// The letter glimpse is for flying VERTICALLY through the alphabetized grid, so
// only a sustained run of fast ROW-TO-ROW moves should raise it. Browsing
// horizontally within a row must never trigger it — on a wide desktop row that's
// a long run of quick focus moves, which is exactly what popped the overlay
// unbidden. The shim records the axis of the last directional move on
// window.__rommNavH; a horizontal move resets the streak. On the Deck (Steam's
// native nav) the flag is undefined, so behaviour there is unchanged.
export function _tileFocusScrub(_el: any, label: string) {
  if ((window as any).__rommNavH) { _scrubStreak = 0; return; }
  const now = Date.now();
  _scrubStreak = now - _scrubFocusTs < 200 ? _scrubStreak + 1 : 1;
  _scrubFocusTs = now;
  if (_scrubStreak >= 5) { try { scrubGlimpse(_scrubLetterOf(label)); } catch { /* ignore */ } }
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









// Fetch an auth-gated RomM resource path as a base64 data URI (backend proxy).
export function useRommImage(path: string | null): string | null {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!path) { setUri(null); return; }
    (async () => {
      try { const r = await qGetImage(path); if (alive) setUri(r?.data_uri || null); }
      catch { if (alive) setUri(null); }
    })();
    return () => { alive = false; };
  }, [path]);
  return uri;
}








// ── Multi-disc helpers (shared by the cover tile, the Play button and the
// Files tab) ────────────────────────────────────────────────────────────────
export type LocalDisc = { name: string; path: string; is_m3u: boolean; is_region?: boolean };

// Friendly label for a disc file: keep the "(Disc N)" tail when present, else
// fall back to the bare filename (sans extension).
export function discDisplayLabel(fname: string): string {
  const base = fname.replace(/\.[^.]+$/, '');
  const m = base.match(/\(dis[ck]\s*\d+[^)]*\)/i);
  return m ? m[0].replace(/[()]/g, '') : base;
}

// Friendly label for a regional variant file: surface the "(Region)" tag
// (e.g. "(Italy)", "(USA, Europe)") that RomM/No-Intro dumps carry, else the
// bare filename (sans extension).
function regionDisplayLabel(fname: string): string {
  const base = fname.replace(/\.[^.]+$/, '');
  const m = base.match(/\(([^)]+)\)\s*$/);
  return m ? m[1] : base;
}





// V2 glass picker — the disc/region selector in the app's own modal language
// (same chrome as CollectionActionsModal / UserMenuModal) instead of Steam's
// native context menu. Rows reuse UserMenuRow; the remembered/default entry
// carries a check in the icon slot.
export function PickerModal({ title, items, closeModal }: {
  title: string;
  items: { key: string | number; label: string; active?: boolean; onSelect: () => void }[];
  closeModal?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60); return () => clearTimeout(t); }, []);
  return (
    <ModalRoot bHideCloseIcon onCancel={closeModal} onEscKeypress={closeModal}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing className="romm-ui"
        onCancelButton={() => closeModal?.()}
        onButtonDown={(e: any) => { if (e?.detail?.button === GamepadButton.CANCEL) closeModal?.(); }}
        style={{
          position: 'fixed', inset: MODAL_SCRIM_INSET, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(7,7,15,0.45)',
          WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
        }}>
        <style>{`
          ${V2_FOCUS_STYLE}
          .romm-modal-collapse, .romm-modal-collapse > div {
            background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important;
          }
          @keyframes umIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: none; } }
        `}</style>
        <div onClick={() => closeModal?.()} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          position: 'relative', width: '340px', maxWidth: '90vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          <div style={{
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
            color: V2.fgMuted, padding: '6px 8px 10px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{title}</div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />
          {items.map((it) => (
            <UserMenuRow key={it.key}
              icon={it.active ? <FaCheck size={14} style={{ color: V2.brand }} /> : null}
              label={it.label}
              onSelect={() => { closeModal?.(); it.onSelect(); }} />
          ))}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

// Picker listing the bootable discs (V2 modal). The first item launches the
// .m3u playlist (in-game disc swap) when present, else disc 1. `last` is the
// remembered disc (what a plain Play resumes) and is checkmarked. Choosing the
// playlist persists the .m3u name so a later plain Play resumes the playlist.
export function openDiscPicker(romId: number, gameName: string, discs: LocalDisc[],
  last?: string, setBusy?: (b: any) => void, onLaunched?: () => void) {
  // A regional multi-file ROM has no playlist — every entry is a standalone
  // region. Present it as a region picker (no "all discs" default).
  const isRegion = discs.length > 0 && discs.every((d) => d.is_region);
  if (isRegion) {
    // Default to the remembered region, else the first one.
    const activeName = (last && discs.some((d) => d.name === last)) ? last : discs[0]?.name;
    showModal(
      <PickerModal title="Select region" items={discs.map((d) => ({
        key: d.name, label: regionDisplayLabel(d.name), active: d.name === activeName,
        onSelect: () => runLaunch(romId, gameName, d.name, regionDisplayLabel(d.name), setBusy, onLaunched),
      }))} />
    );
    return;
  }
  const m3u = discs.find((d) => d.is_m3u);
  const pickable = discs.filter((d) => !d.is_m3u);
  // The playlist is the active default when it is the remembered choice, or when
  // nothing is remembered yet (the implicit first-launch default).
  const m3uActive = !!m3u && (last === m3u.name || !last);
  showModal(
    <PickerModal title="Select disc" items={[
      {
        key: '__all__', label: m3u ? 'Play (all discs, in-game swap)' : 'Play (disc 1)',
        active: m3uActive,
        onSelect: () => runLaunch(romId, gameName, m3u ? m3u.name : null,
          m3u ? 'All discs' : undefined, setBusy, onLaunched),
      },
      ...pickable.map((d) => ({
        key: d.name, label: discDisplayLabel(d.name), active: last === d.name,
        onSelect: () => runLaunch(romId, gameName, d.name, discDisplayLabel(d.name), setBusy, onLaunched),
      })),
    ]} />
  );
}






// The same row, but flat: no card of its own, so several can live inside ONE
// surface separated by hairlines (see FoldersSection). Highlight is drawn inset
// instead of as a border, which keeps the card's outline unbroken.
export function V2CardRow({ icon, title, subtitle, onClick, right, danger, divider, first, last }:
  { icon?: any; title: any; subtitle?: any; onClick?: () => void; right?: any;
    danger?: boolean; divider?: boolean; first?: boolean; last?: boolean }) {
  const { active, highlightHandlers } = useRowHighlight();
  const interactive = !!onClick;
  const accent = danger ? V2.danger : V2.brand;
  // The highlight ring has to follow the CARD's corners, not its own: a row in
  // the middle is square, but the top and bottom rows sit in the card's rounded
  // ends. One pixel less than the card radius, because the card's 1px border
  // sits outside this ring.
  const end = `calc(${V2.radiusCard} - 1px)`;
  return (
    <Focusable noFocusRing
      onActivate={interactive ? onClick : undefined}
      onClick={interactive ? onClick : undefined}
      {...highlightHandlers}
      style={{
        display: 'flex', alignItems: 'center', gap: '14px', padding: '13px 14px',
        borderTopLeftRadius: first ? end : 0,
        borderTopRightRadius: first ? end : 0,
        borderBottomLeftRadius: last ? end : 0,
        borderBottomRightRadius: last ? end : 0,
        borderTop: divider ? `1px solid ${V2.border}` : 'none',
        background: active && interactive ? V2.surfaceHover : 'transparent',
        boxShadow: active && interactive ? `inset 0 0 0 2px ${accent}` : 'none',
        cursor: interactive ? 'pointer' : 'default',
        transition: 'background 0.15s, box-shadow 0.15s',
      }}>
      {icon && (
        <div style={{
          flexShrink: 0, width: '32px', height: '32px', borderRadius: V2.radiusMd,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: danger ? 'rgba(255,80,80,0.12)' : V2.bgElevated,
          color: danger ? V2.danger : V2.brandHover,
        }}>{icon}</div>
      )}
      <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: danger ? V2.danger : V2.fg }}>{title}</div>
        {subtitle && <div style={{ fontSize: '12px', color: V2.fgMuted, lineHeight: 1.35 }}>{subtitle}</div>}
      </div>
      {right != null && <div style={{ flexShrink: 0 }}>{right}</div>}
    </Focusable>
  );
}





// Stats page — 1:1 port of RomM's ServerStats.vue: a section stack of
// SummaryStatsSection (card grid in SettingsSection chrome) + PlatformsStatsSection
// (toolbar + per-platform rows with size/percentage and a progress bar that
// doubles as the row divider). Scope is plugin-local (this device).













// The toggle list itself, shared by Settings ▸ Platforms and the setup wizard's
// optional Platforms step — the two must never drift, because they are the same
// decision made at two different moments.
// A bounded scroll box whose edges fade out only while there is more content
// past them. The fade IS the affordance: a hard-cut edge mid-row reads as a
// layout bug, and on a controller there is no scrollbar to say otherwise —
// nothing else on screen tells you the list continues. Both edges are computed
// independently so the top fade appears only once you have actually scrolled,
// rather than veiling the first row from the start.
export function ScrollFade({ maxHeight, refresh, children, style }: {
  maxHeight: string;
  // Bump when the content's height can have changed without a scroll (rows
  // arriving, a subtitle growing on toggle) — there is no scroll event for that.
  refresh?: any;
  children: any;
  style?: any;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });

  const measure = () => {
    const el = ref.current;
    if (!el) return;
    // 2px slack: fractional scroll offsets (dpad scrollIntoView lands on
    // sub-pixel positions) would otherwise leave a fade stuck on at the end.
    const top = el.scrollTop > 2;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setEdges((p) => (p.top === top && p.bottom === bottom ? p : { top, bottom }));
  };

  useEffect(() => { measure(); }, [refresh, maxHeight]);

  const F = '30px';
  const mask = edges.top && edges.bottom
    ? `linear-gradient(to bottom, transparent 0, #000 ${F}, #000 calc(100% - ${F}), transparent 100%)`
    : edges.top
      ? `linear-gradient(to bottom, transparent 0, #000 ${F})`
      : edges.bottom
        ? `linear-gradient(to bottom, #000 calc(100% - ${F}), transparent 100%)`
        : undefined;

  return (
    <div ref={ref} onScroll={measure}
      style={{
        maxHeight, overflowY: 'auto', overflowX: 'hidden',
        WebkitMaskImage: mask, maskImage: mask,
        // Both properties, or the mask is applied per-box and each row fades
        // against its own edges instead of the container's.
        WebkitMaskSize: '100% 100%', maskSize: '100% 100%',
        ...style,
      }}>
      {children}
    </div>
  );
}














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
