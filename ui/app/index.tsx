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
import { FaLayerGroup, FaCheck, FaCloudUploadAlt } from "react-icons/fa";
import {
  ackLibraryAnnouncement,
  checkForUpdate,
  drainNotifications,
  emulatorInstallState,
  getCheckOnStartup,
  getConfig,
  getEmulatorStatus,
  getPlatformSync,
  getServiceStatus,
  getStateThumbnails,
  getSyncIndicator,
  getUpdateChannel,
  installEmulator,
  notifyNetworkState,
  refreshFromRomm,
  setPlatformSync,
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
  useServiceStatus,
  SaveActivity,
  _pushSaveActivity,
  useSaveActivity, _clearStale} from "./status";
import { PlatformIcon, UserMenuRow, V2SettingsRow, V2Switch, _gameLabel, useRowHighlight } from "./kit";
import {
  _forceGamepadFocus,
  _gpFocusEl,
  _summonVirtualKeyboard,
  _dismissVirtualKeyboard,
  _autoFocusFirstRef,
} from "./shell";
import { _dlActive, _dlQueue, _dlSucceeded, _dlListeners, _setDlActive, _batchJobs } from "./downloads";
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
export let _syncPillPref: boolean | null = null;
export const _syncPillListeners = new Set<() => void>();
export function _setSyncPillPref(on: boolean) {
  _syncPillPref = on;
  _syncPillListeners.forEach((l) => { try { l(); } catch { } });
}

// ── Emulator status ─────────────────────────────────────────────────────────
// Whether RetroArch/RetroDECK is actually installed, and whether any saved
// folder still points into an emulator that was uninstalled. One fetch serves
// the whole UI (Home banner, Play button, Emulator page). The backend re-detects
// on every plugin start, so this cache only needs invalidating when WE change
// something — a path repair or an install — which is what refresh does.
export type EmuStalePath = {
  section: string; key: string; label: string; kind: string;
  value: string; reason: string; suggested: string;
  // Why it's wrong. 'removed': the install it belonged to is gone.
  // 'other_install': that install is alive, it just isn't the one we launch —
  // then `owner` and `active` name the two, which the copy needs to be
  // comprehensible ("going to RetroArch, but games run on RetroDECK").
  cause?: 'removed' | 'other_install'; owner?: string; active?: string;
};
type EmuStandalone = {
  key: string; name: string; installed: boolean; executable: string;
  // Lowercase tokens matched against a game's platform name and slug.
  platforms: string[];
};
export type EmuStatus = {
  installed: boolean;
  kind: 'retrodeck' | 'flatpak' | 'snap' | 'native' | 'none';
  executable: string | null;
  cores_dir: string | null;
  core_count: number;
  stale_paths: EmuStalePath[];
  // Emulators outside RetroArch that own a platform outright (Eden for Switch).
  // Independent of `installed` above: their games play with no RetroArch here.
  standalone: EmuStandalone[];
  save_dirs: Record<string, string>;
  bios_dir: string;
  // Raw configured values by kind — '' means "not set, we detect it".
  configured_paths: Record<string, string>;
  // What each folder would be with nothing chosen, so a row can offer to go
  // back to it. '' means "clear it and let detection answer".
  default_paths: Record<string, string>;
  // Where the detected emulator keeps things, existing yet or not — what a row
  // shows when nothing is configured and nothing is on disk to detect.
  expected_paths: Record<string, string>;
  // Whether Ludo can install an emulator itself. False on Windows, without
  // flatpak, or as root — the reason is what we show instead of the button.
  install: { available: boolean; reason: string };
};
export let _emuStatus: EmuStatus | null = null;
let _emuInflight: Promise<EmuStatus | null> | null = null;
const _emuSubs = new Set<() => void>();

export function publishEmulatorStatus(s: EmuStatus | null) {
  _emuStatus = s;
  [..._emuSubs].forEach((f) => f());
}

export async function loadEmulatorStatus(refresh = false): Promise<EmuStatus | null> {
  // Coalesce: several components mount at once on a cold start and would
  // otherwise each pay for the (filesystem-probing) detection.
  if (!refresh && _emuInflight) return _emuInflight;
  const run = (async () => {
    try {
      const r = await getEmulatorStatus(refresh);
      if (r?.success) {
        publishEmulatorStatus({
          installed: !!r.installed,
          kind: r.kind || 'none',
          executable: r.executable || null,
          cores_dir: r.cores_dir || null,
          core_count: r.core_count || 0,
          stale_paths: r.stale_paths || [],
          standalone: r.standalone || [],
          save_dirs: r.save_dirs || {},
          bios_dir: r.bios_dir || '',
          configured_paths: r.configured_paths || {},
          default_paths: r.default_paths || {},
          expected_paths: r.expected_paths || {},
          install: r.emulator_install || { available: false, reason: '' },
        });
      }
    } catch { /* leave the last known answer in place */ }
    finally { _emuInflight = null; }
    return _emuStatus;
  })();
  _emuInflight = run;
  return run;
}

// The standalone emulator that owns a game's platform, installed or not — Eden
// for a Switch ROM. Matched on the same tokens the backend uses, against both
// the platform name and its slug, so "Nintendo Switch" and "switch" both hit.
export function standaloneFor(status: EmuStatus | null,
                       platform?: string | null,
                       slug?: string | null): EmuStandalone | null {
  if (!status?.standalone?.length) return null;
  const hay = `${platform || ''} ${slug || ''}`.toLowerCase();
  if (!hay.trim()) return null;
  return status.standalone.find((s) => s.platforms.some((p) => hay.includes(p))) || null;
}


export function useEmulatorStatus(): EmuStatus | null {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    _emuSubs.add(f);
    if (!_emuStatus) loadEmulatorStatus();
    return () => { _emuSubs.delete(f); };
  }, []);
  return _emuStatus;
}



// ── RetroArch install ───────────────────────────────────────────────────────
// The install runs in a backend thread (a few hundred MB of flatpak, plus the
// KDE runtime if it isn't already there); the UI polls its
// progress. Module-level so the Home banner and the Emulator page show the same
// run, and so navigating away mid-install doesn't orphan it.
type EmuInstall = {
  active: boolean; phase: string; pct: number | null; detail: string; error: string | null;
  // Real byte counts from flatpak's own ref table, or null when it couldn't be
  // read — the size varies hugely with whether the KDE runtime tags along, so
  // there is no sane fallback number to invent.
  bytesDone: number | null; bytesTotal: number | null;
};
let _emuInstall: EmuInstall = { active: false, phase: '', pct: null, detail: '', error: null,
                                bytesDone: null, bytesTotal: null };
const _emuInstallSubs = new Set<() => void>();
let _emuInstallPoll: any = null;
// True while the setup wizard is on screen. Its Emulator step reports the
// install's every state inline — progress, failure, and a "Emulator ready"
// panel — so the module-level toasts would just repeat it back over a screen
// that already says so.
let _wizardOpen = false;

/**
 * Set while the setup wizard is on screen. A function rather than the binding
 * itself because an imported `let` is read-only at the importing end.
 */
export function setWizardOpen(v: boolean) { _wizardOpen = v; }

function _publishInstall(next: EmuInstall) {
  _emuInstall = next;
  [..._emuInstallSubs].forEach((f) => f());
}

function _pollInstall() {
  if (_emuInstallPoll) return;
  _emuInstallPoll = setInterval(async () => {
    try {
      const r = await emulatorInstallState();
      _publishInstall({
        active: !!r?.active, phase: r?.phase || '',
        pct: r?.pct ?? null, detail: r?.detail || '', error: r?.error || null,
        bytesDone: r?.bytes_done ?? null, bytesTotal: r?.bytes_total ?? null,
      });
      if (!r?.active) {
        clearInterval(_emuInstallPoll); _emuInstallPoll = null;
        // The emulator either exists now or the attempt failed — either way the
        // cached status is stale, and a fresh install ships zero cores, so the
        // Cores page needs to re-read too.
        await loadEmulatorStatus(true);
        if (_wizardOpen) return;
        if (r?.error) toaster.toast({ title: 'RetroArch', body: r.error });
        else if (r?.installed) {
          // Folders the install moved off the emulator that was removed. Worth
          // saying: it changes where saves and BIOS files land from now on.
          const fixed: string[] = r?.repaired || [];
          toaster.toast({
            title: 'RetroArch',
            body: fixed.length
              ? `Installed, and pointed ${fixed.join(' and ').toLowerCase()} at it.`
              : 'Installed',
          });
        }
      }
    } catch { /* keep polling; a dropped IPC frame isn't a failure */ }
  }, 1000);
}

export async function startEmulatorInstall() {
  _publishInstall({ active: true, phase: 'Starting…', pct: null, detail: '', error: null, bytesDone: null, bytesTotal: null });
  try {
    const r = await installEmulator();
    if (!r?.success) {
      _publishInstall({ active: false, phase: '', pct: null, detail: '', error: r?.message || 'Could not start the install', bytesDone: null, bytesTotal: null });
      // The wizard's Emulator step renders install.error itself.
      if (!_wizardOpen) toaster.toast({ title: 'RetroArch', body: r?.message || 'Could not start the install' });
      return;
    }
    _pollInstall();
  } catch (e) {
    _publishInstall({ active: false, phase: '', pct: null, detail: '', error: String(e), bytesDone: null, bytesTotal: null });
  }
}

// "142 MB of 409 MB" while the sizes are known, '' when flatpak's ref table
// couldn't be read — better to say nothing than to quote a made-up total.
// flatpak reports SI sizes, so divide by 1000, not 1024, to match what it and
// Flathub show for the same app.
export function installSize(s: EmuInstall): string {
  if (!s.bytesTotal) return '';
  const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
  return s.bytesDone == null ? mb(s.bytesTotal)
    : `${mb(s.bytesDone)} of ${mb(s.bytesTotal)}`;
}

export function useEmulatorInstall(): EmuInstall {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    _emuInstallSubs.add(f);
    return () => { _emuInstallSubs.delete(f); };
  }, []);
  return _emuInstall;
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



// Background notification polling — drains events the backend emits at the exact
// moment a sync/removal happens. No state diffing, no transition inference: the
// backend is the single source of truth (see CollectionSyncManager.push_notification).
let backgroundInterval: any = null;
// Last connection state seen by the background poller, for edge detection. Only
// an online→offline (or offline→online) TRANSITION toasts — a cold start that's
// already offline must not fire a spurious "connection lost".
let _prevConn: string | null = null;
// Consecutive offline samples seen since the last online one. The toast needs
// two (~4s at this interval), because a SINGLE bad sample is routinely not an
// outage: the reachability probe times out under load, and every deliberate sync
// restart (a path repair, an emulator install) tears the client down and rebuilds
// it. Both produced a "Can't reach RomM server" toast on a server that was never
// down — reported from inside the setup wizard, where installing RetroArch
// saturates the connection AND restarts sync at the same moment.
let _offSamples = 0;

// The ack is a round trip and this poll runs every 2s, so without this the same
// announcement toasts two or three times before the backend clears it.
let _annShown = false;

/**
 * Clear the "already toasted this announcement" latch, so the next poll shows
 * it again. A function because an imported `let` is read-only at the importing
 * end, and Settings resets this when the user re-enables announcements.
 */
export function resetAnnouncementShown() { _annShown = false; }



// Live handle on the library-fetch toast, and the count of consecutive polls
// that have seen a fetch in flight. The toast exists because OfflineBanner is
// scoped to the library root page: navigate into a game or Settings mid-fetch
// and the only sign the sync is still running disappears. A toast host is
// global, so this follows the user wherever they go.
let _fetchToast: { dismiss: () => void } | null = null;
let _fetchSamples = 0;
// Not an expected lifetime — the toast is dismissed the moment progress clears.
// This is the leak guard for a sync that hangs without ever clearing it, so the
// user isn't left with a permanent notification they can't get rid of.
const FETCH_TOAST_MAX_MS = 30 * 60 * 1000;

// Body of that toast. A component rather than a string because NEITHER toaster
// can update a toast that's already on screen — Decky's returns only
// {data, dismiss}, and the shim snapshots opts at push time. But `body` is a
// ReactNode rendered inside the host's own tree, so a node that subscribes to
// the shared status poll re-renders itself in place. That's what lets the count
// move while the toast stays put.
function LibraryFetchToastBody() {
  const st = useServiceStatus();
  const prog = st?.library_progress;
  // Per-platform walk: name the platform and count within it, with the
  // library-wide position alongside. Both numbers are required — the platform
  // bar alone is nearly useless on a lopsided library (one platform is 79% of
  // the measured one, so it would read "1 of 13" for most of the sync), and the
  // library counter alone is the bare number this work exists to replace.
  // Fixed box. The toast sizes itself to its content, so without this every
  // digit the counter gains and every platform name of a different length
  // resizes the whole notification — it visibly jitters for the entire fetch.
  // A fixed width plus two fixed single-line rows makes the frame constant and
  // lets only the glyphs inside it change.
  const box = (rows: React.ReactNode) => (
    <span style={{
      display: 'block', width: '210px',
      // Proportional digits are individually different widths, so a counter
      // rendered in them shuffles sideways as it climbs even inside a fixed box.
      fontVariantNumeric: 'tabular-nums',
    }}>{rows}</span>
  );
  const line = (content: React.ReactNode, extra?: React.CSSProperties) => (
    <span style={{
      display: 'block', whiteSpace: 'nowrap', overflow: 'hidden',
      textOverflow: 'ellipsis', ...extra,
    }}>{content}</span>
  );

  if (prog?.platform_name && prog?.platform_total > 0) {
    const pl = (prog.platform_loaded ?? 0).toLocaleString();
    const pt = prog.platform_total.toLocaleString();
    // Name on its own line so a long one ("Super Nintendo Entertainment
    // System") ellipsises instead of wrapping and changing the toast's HEIGHT
    // — the same jitter in the other axis.
    return box(<>
      {line(prog.platform_name)}
      {line(<>{`${pl} of ${pt}`}
        <span style={{ opacity: 0.6 }}>{`  ·  ${prog.platform_index}/${prog.platform_count}`}</span>
      </>)}
    </>);
  }
  if (prog?.total > 0) {
    return box(line(`${(prog.loaded ?? 0).toLocaleString()} of ${prog.total.toLocaleString()} games`));
  }
  // Before the first page lands there's no total to divide by, and the fetch is
  // dismissed the instant progress clears — so this covers the opening seconds
  // and the single frame between the last page and the dismiss.
  return box(line('Fetching from RomM…'));
}

// Live handle on the save-sync toast, plus when it went up. Same shape as the
// library-fetch toast above, and for the same reason: a toast host is global,
// so this reaches the user wherever they are — including the case this feature
// exists for, where they have just closed a game and are not in Ludo at all.
let _saveToast: { dismiss: () => void } | null = null;
let _saveToastAt = 0;
// A save that uploads inside a single poll would otherwise appear and vanish in
// well under a second, reading as a glitch rather than as an answer. Hold it
// this long from the moment it went up.
const SAVE_TOAST_MIN_MS = 2600;
// Leak guard, exactly like FETCH_TOAST_MAX_MS: a sync that wedges without ever
// clearing must not leave a notification the user cannot get rid of.
const SAVE_TOAST_MAX_MS = 10 * 60 * 1000;

// Body of that toast, live — the same self-subscribing trick as
// LibraryFetchToastBody, since neither toaster can update a toast in place. It
// matters here because the activity changes KIND partway through: a save waits
// out the settle delay before a byte moves, so the same notification has to be
// able to go from waiting to uploading without being re-raised.
function SaveSyncToastBody() {
  const a = useSaveActivity();
  const live = !a ? null
    : a.games > 1
      ? `${a.games} games`
      : a.game
        ? a.game
        : a.state === 'queued' ? 'Waiting for the save to finish writing' : 'Uploading to RomM';
  // The toast outlives the activity by up to SAVE_TOAST_MIN_MS, and its TITLE
  // is snapshotted at push time and cannot follow. So hold the last real line
  // rather than swapping in a completion message the title would contradict —
  // the notification simply finishes saying what it was saying, and the
  // separate completion toast reports the result.
  const last = useRef<string>('Uploading to RomM');
  if (live) last.current = live;
  const text = live ?? last.current;
  return (
    <span style={{
      display: 'block', maxWidth: '230px', whiteSpace: 'nowrap',
      overflow: 'hidden', textOverflow: 'ellipsis',
    }}>{text}</span>
  );
}

// The save-sync toast's logo slot, live — and it has to be live for the same
// reason the body does: the rom_id is not known at push time when the upload is
// still settling, so a logo snapshotted then would be permanently blank.
//
// Same box art and same treatment the COMPLETION toast has always used, so the
// pair reads as one event reported twice rather than two unrelated messages —
// a generic cloud glyph followed by the game's cover looked like the second
// toast was about something else.
function SaveSyncToastLogo() {
  const a = useSaveActivity();
  if (a?.rom_id == null) return <FaCloudUploadAlt size={22} />;
  return <ToastCover romId={a.rom_id} hasCover />;
}

// The toast's logo slot, live. `logo` is snapshotted at push time exactly like
// every other toast option, so a static icon would freeze on whichever platform
// happened to be current when the toast was raised. It is a ReactNode rendered
// inside the host's own tree though, so the same self-subscribing trick that
// keeps the body counting keeps the icon in step with the platform.
function LibraryFetchToastLogo() {
  const st = useServiceStatus();
  const slug = st?.library_progress?.platform_slug;
  if (!slug) return null;
  return (
    // Explicit pixel box, like ToastCover's img. PlatformIcon renders at
    // width/height 100%, so it has no size of its own — and the logo slot is
    // `flex: none` with no width, so a percentage there resolves against
    // nothing and the artwork renders at its natural size, stretching the whole
    // toast. Wider than tall because platform art is mostly wordmarks;
    // objectFit: contain does the rest.
    <div style={{
      width: '52px', height: '32px', flex: 'none',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <PlatformIcon slug={slug} size={28} />
    </div>
  );
}

const checkForNotifications = async () => {
  try {
    // Connection-lost / restored toast — runs here (not in a component) so it
    // fires even while the RomM app isn't open (e.g. mid-game).
    try {
      const st = await getServiceStatus();
      const conn = st?.connection ?? null;
      if (conn && conn !== 'connecting') {
        const isOff = conn === 'offline_cached' || conn === 'disconnected';
        _offSamples = isOff ? _offSamples + 1 : 0;
        // Going offline has to be CONFIRMED before it counts as the current
        // state — and while an emulator install runs it never counts, since that
        // restarts sync itself and already narrates its own progress. Leaving
        // _prevConn untouched (rather than just skipping the toast) is what stops
        // an unreported blip from being followed by a baffling "Back online".
        const confirmed = !isOff || (_offSamples >= 2 && !_emuInstall.active);
        if (confirmed) {
          if (_prevConn === 'online' && isOff) {
            const r = st?.unreachable_reason;
            const noNet = r === 'no_network' || r === 'airplane_mode';
            toaster.toast({
              title: r === 'airplane_mode' ? 'Airplane mode is on'
                : noNet ? 'No internet connection' : "Can't reach RomM server",
              body: noNet
                ? 'Showing your downloaded games — saves sync when you’re back online.'
                : 'The server isn’t responding — showing your downloaded games.',
              duration: 5000,
            });
          } else if ((_prevConn === 'offline_cached' || _prevConn === 'disconnected') && conn === 'online') {
            toaster.toast({ title: 'Back online', body: 'Reconnected to RomM — syncing.', duration: 4000 });
          }
          _prevConn = conn;
        }
      }
      // Library-fetch toast: raised while a fetch is in flight, dismissed when
      // it clears. Deliberately outside the connection block above — a fetch
      // runs during 'connecting' too, and that's exactly the first-run case
      // where the wait is longest.
      const fetching = st?.library_progress;
      if (fetching) {
        _fetchSamples++;
        // Two samples (~4s) before raising. An incremental refresh is usually
        // done inside a single tick, and a toast that appears and vanishes is
        // pure noise — only a fetch long enough to be worth narrating gets one.
        if (!_fetchToast && _fetchSamples >= 2) {
          _fetchToast = toaster.toast({
            // A scoped walk is an update, not a load — the library is already
            // on screen and only the platforms that moved are being re-read.
            // Snapshotted at push time like the rest of the toast, which is
            // fine: a walk doesn't change kind halfway through.
            title: fetching.platform_name ? 'Updating your library…' : 'Loading your library…',
            body: <LibraryFetchToastBody />,
            logo: <LibraryFetchToastLogo />,
            duration: FETCH_TOAST_MAX_MS,
            // Silent: this one announces a wait the user didn't ask about, and
            // it can fire on any cold start. The completion toast keeps its chime.
            playSound: false,
            onClick: () => { try { Navigation.Navigate('/romm-sync-library'); } catch { /* ignore */ } },
          });
        }
      } else {
        _fetchSamples = 0;
        if (_fetchToast) {
          try { _fetchToast.dismiss(); } catch { /* already gone */ }
          _fetchToast = null;
        }
      }

      // Save-sync toast — raised while a save is on its way up, dismissed when
      // it lands. No sample delay before raising, unlike the fetch toast above:
      // a save sync is over in seconds, and waiting to be sure it was worth
      // narrating would mean narrating nothing at all. SAVE_TOAST_MIN_MS does
      // that job from the other end instead.
      //
      // Feeds the module store as well, so the per-tile badges keep updating on
      // this 2s poll even on a screen with no library subscriber running.
      _pushSaveActivity(st?.save_activity);
      if (_syncPillPref === null) {
        // First read. Fired from here rather than a component so the preference
        // is known even if the user never opens a page that asks for it.
        _syncPillPref = true;
        getSyncIndicator()
          .then((r) => _setSyncPillPref(r?.enabled !== false))
          .catch(() => { /* stays on */ });
      }
      const saving = st?.save_activity?.active && _syncPillPref !== false;
      if (saving) {
        if (!_saveToast) {
          _saveToastAt = Date.now();
          _saveToast = toaster.toast({
            title: 'Uploading save',
            body: <SaveSyncToastBody />,
            logo: <SaveSyncToastLogo />,
            duration: SAVE_TOAST_MAX_MS,
            // Silent, like the fetch toast: this narrates work the user did not
            // ask about. The completion toast keeps its chime, which is the one
            // they actually need to hear from another room.
            playSound: false,
          });
        }
      } else if (_saveToast) {
        const held = Date.now() - _saveToastAt;
        const t = _saveToast;
        _saveToast = null;
        // Past the floor already: go now. Otherwise let it serve out the rest,
        // with the body having fallen through to "Save uploaded" the moment the
        // activity cleared — so the extra time reads as a result, not a stall.
        if (held >= SAVE_TOAST_MIN_MS) { try { t.dismiss(); } catch { } }
        else setTimeout(() => { try { t.dismiss(); } catch { } }, SAVE_TOAST_MIN_MS - held);
      }

      // First-library-load toast. Fires from here rather than a component
      // because the whole point is the user who wandered off to Steam during
      // the ~12s first fetch. The backend only ever raises this once per
      // device — see _announce_library — so there's no rate limiting to do
      // here, and routine reconnects stay silent.
      const ann = st?.library_announcement;
      if (ann?.kind && !_annShown) {
        _annShown = true;   // stop the next 2s tick re-toasting before the ack lands
        if (ann.kind === 'ready') {
          toaster.toast({
            title: 'Your library is ready',
            // Report the server's own ROM count, not our grouped entry count:
            // it's the number RomM shows the user everywhere else, and the
            // grouping is an implementation detail a completion toast is the
            // wrong place to explain.
            body: `${(ann.files ?? ann.games ?? 0).toLocaleString()} games from RomM`,
            duration: 6000,
            onClick: () => { try { Navigation.Navigate('/romm-sync-library'); } catch { /* ignore */ } },
          });
        } else if (ann.kind === 'updated') {
          // A reconcile ran on connect and changed something. Names the
          // platforms, because "your library changed" while a banner counts
          // through 17,000 c64 ROMs is exactly the moment the user wants to
          // know WHICH platform is being read and why.
          const bits: string[] = [];
          if (ann.added) bits.push(`${ann.added.toLocaleString()} added`);
          if (ann.removed) bits.push(`${ann.removed.toLocaleString()} removed`);
          const where = (ann.platforms || []).length
            ? ` in ${(ann.platforms as string[]).slice(0, 3).join(', ')}`
            + ((ann.platforms.length > 3) ? ` +${ann.platforms.length - 3} more` : '')
            : '';
          toaster.toast({
            title: 'Library updated',
            body: `${bits.join(', ') || 'Synced'}${where}`,
            duration: 6000,
            onClick: () => { try { Navigation.Navigate('/romm-sync-library'); } catch { /* ignore */ } },
          });
        } else {
          toaster.toast({
            title: "Couldn't load your library",
            body: "Ludo can’t reach your RomM server. Check that it’s running, then try again from Settings.",
            duration: 8000,
            onClick: () => { try { Navigation.Navigate('/romm-sync-settings'); } catch { /* ignore */ } },
          });
        }
        // Released after the ack, not latched for the session: 'updated' is
        // repeatable, and a permanent latch would let the first announcement
        // silence every later one. The ack has cleared the backend's copy by
        // here, so the next poll has nothing to re-toast. Released even when
        // the ack fails, or a single failed round trip would mute it for good.
        try { await ackLibraryAnnouncement(); } catch { /* retried next load */ }
        finally { _annShown = false; }
      }
    } catch { /* transient */ }

    const { events } = await drainNotifications();
    if (!events?.length) return;
    // A save/state upload replaces that game's state screenshot. The row's own
    // invalidation only arms after a launch started from Ludo, so a session
    // played elsewhere (RetroDECK, another device) would otherwise keep showing
    // box art until the next app start. The backend drops its matching caches
    // in the same call, so the refetch below sees the new picture.
    if (events.some((e: any) => e?.kind === 'save')) invalidateStateThumbs();
    for (let i = 0; i < events.length; i++) {
      // Slight stagger so the toaster doesn't dedupe a burst into one.
      if (i > 0) await new Promise(resolve => setTimeout(resolve, 300));
      const ev = events[i];
      // Events carrying a rom_id are about one specific game (a save/state
      // upload). Give those the download toast's treatment — that game's box
      // art as the logo, and a click that opens it — so a burst of them is
      // still readable as "these games synced" rather than N identical rows.
      const romId = typeof ev.rom_id === 'number' ? ev.rom_id : null;
      toaster.toast({
        title: ev.title,
        body: ev.body,
        duration: 5000,
        ...(romId !== null ? {
          logo: <ToastCover romId={romId} hasCover={!!ev.has_cover} />,
          // Library root as origin: the toast can outlive the page that was
          // open when the sync fired (same reasoning as the download toast).
          onClick: () => openGameById(romId, ev.body || '', "/romm-sync-library"),
        } : {}),
      });
    }
  } catch (error) {
    console.error('[BACKGROUND NOTIFICATION] Error draining notifications:', error);
  }
};

const startBackgroundMonitoring = () => {
  if (backgroundInterval) {
    clearInterval(backgroundInterval);
  }
  console.log('[BACKGROUND] Starting background notification monitoring');
  backgroundInterval = setInterval(checkForNotifications, 2000);
};

const stopBackgroundMonitoring = () => {
  if (backgroundInterval) {
    console.log('[BACKGROUND] Stopping background notification monitoring');
    clearInterval(backgroundInterval);
    backgroundInterval = null;
  }
};

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




// Home dashboard — faithful to RomM v2 Home.vue: horizontal CardRows
// (Continue playing / Recently added / Platforms / Collections).
// Home banner for the two emulator states that change what the app can do:
// nothing installed (games download but can't launch), and a folder pointing at
// an emulator we don't launch — whether because it was uninstalled or because
// the user has both and we run the other one (sync writes where nothing reads,
// while still reporting success). Every other stale path is a quiet
// warning row in Settings ▸ Folders instead — see FoldersSection.
// Install progress. Determinate once flatpak reports a percentage, and a moving
// indeterminate sweep before that — resolving refs and verifying take a while
// with no numbers attached, and a bar frozen at 0% looks like a hung download.
export function InstallProgressBar({ pct }: { pct: number | null }) {
  const known = pct != null;
  return (
    <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '10px' }}>
      <div style={{
        flex: '1 1 auto', height: '6px', borderRadius: V2.radiusPill,
        background: 'rgba(255,255,255,0.12)', overflow: 'hidden', position: 'relative',
      }}>
        <div style={{
          position: 'absolute', top: 0, bottom: 0,
          left: known ? 0 : undefined,
          width: known ? `${Math.max(2, Math.min(100, pct!))}%` : '35%',
          borderRadius: V2.radiusPill,
          background: `linear-gradient(90deg, ${V2.brand}, ${V2.brandHover})`,
          transition: known ? 'width 0.4s ease-out' : 'none',
          animation: known ? undefined : 'rommIndet 1.4s linear infinite',
        }} />
      </div>
      <span style={{
        fontSize: '11px', fontWeight: 700, color: V2.fg2,
        minWidth: '34px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
      }}>{known ? `${pct}%` : '…'}</span>
      {/* Per-component keyframes, the convention everywhere else in this file.
          `spin` is here too because the banner's own Fix button asks for it.
          The offsets are in units of the SWEEPER's width (35% of the track), so
          -115% is what actually parks it off the left edge and 300% clears the
          right — a smaller start left it half-visible at 0%, popping in. */}
      <style>{`
        @keyframes rommIndet {
          0%   { transform: translateX(-115%); }
          100% { transform: translateX(300%); }
        }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
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












// ─── Per-platform sync ───────────────────────────────────────────────────────
// Which platforms Ludo reads from RomM at all. The backend stores the DISABLED
// set (see main.py), so a platform added on the server after the user last
// looked syncs by default rather than being silently ignored.
//
// Switching one off never deletes anything: downloaded games stay on disk and
// stay in the library, and only listings for games that were never downloaded
// go. That is why the copy below says "stop syncing", never "remove".
export function usePlatformSync() {
  const [rows, setRows] = useState<any[]>([]);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  // Slugs with a write in flight. A set, not a single slug: switches are quick
  // to flip and each write is a round-trip, so several are routinely open at
  // once and a scalar would blank the first one's "Saving…" the moment the
  // second started.
  const [saving, setSaving] = useState<Set<string>>(new Set());
  // The latest INTENDED disabled set, including toggles still in flight. `off`
  // is a render snapshot, so building the next set from it would let two quick
  // toggles each send a set that omits the other's change — last write wins and
  // silently reverts one of them.
  const offRef = useRef<Set<string>>(new Set());
  // A platform coming back ON needs a walk to bring its games in. Deferred to
  // the moment the user leaves rather than fired per toggle: turning three
  // platforms back on should cost one walk, not three — and re-fetching under
  // someone who is still flipping switches is the worst possible timing.
  const needsRefresh = useRef(false);

  const load = async () => {
    // Set on every call, not just the first: the wizard re-runs this once the
    // connection exists, and a reload that left `loading` false would let the
    // caller read the previous (unconnected, empty) answer as the real one.
    setLoading(true);
    try {
      const r = await getPlatformSync();
      if (r?.success) {
        setRows(r.platforms || []);
        const stored = new Set<string>(r.disabled || []);
        offRef.current = stored;
        setOff(stored);
        setConnected(!!r.connected);
        setUnavailable(!!r.unavailable);
      }
    } catch { /* leave the page in its loading state; the retry below covers it */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // The platform list shares a server with the library fetch, so an empty
  // answer during a big walk is a timing accident, not a verdict. Same
  // self-healing retry the BIOS page uses.
  useEffect(() => {
    if (!unavailable) return;
    const t = setTimeout(load, 5000);
    return () => clearTimeout(t);
  }, [unavailable]);

  const mark = (slug: string, busy: boolean) => setSaving((prev) => {
    const next = new Set(prev);
    if (busy) next.add(slug); else next.delete(slug);
    return next;
  });

  const toggle = async (slug: string) => {
    // Built from the ref, so a toggle started while another is still in flight
    // sends both changes rather than clobbering the earlier one.
    const turningOff = !offRef.current.has(slug);
    const next = new Set(offRef.current);
    if (turningOff) next.add(slug); else next.delete(slug);
    // Optimistic: the switch has to move under the thumb. A failed write puts
    // it back, which is the only honest thing to show if nothing was stored.
    offRef.current = next;
    setOff(next);
    mark(slug, true);
    try {
      const r = await setPlatformSync([...next]);
      if (r?.success === false) throw new Error(r.message || 'failed');
      if (r?.needs_refresh) needsRefresh.current = true;
    } catch {
      // Undo THIS slug only, against whatever the current intent is. Restoring
      // the snapshot taken before this write would also wipe out any toggle the
      // user made while it was in flight — including ones that succeeded.
      const undone = new Set(offRef.current);
      if (turningOff) undone.delete(slug); else undone.add(slug);
      offRef.current = undone;
      setOff(undone);
    } finally {
      mark(slug, false);
    }
  };

  useEffect(() => () => {
    if (!needsRefresh.current) return;
    needsRefresh.current = false;
    try {
      refreshFromRomm(false)
        .then(() => _broadcastLibRefresh())
        .catch(() => { /* the next connect reconciles it anyway */ });
    } catch { /* ignore */ }
  }, []);

  const on = rows.filter((r) => !off.has(r.slug));
  return {
    rows, off, loading, connected, unavailable, saving, toggle, reload: load,
    enabledCount: on.length,
    enabledRoms: on.reduce((n, r) => n + (r.rom_count || 0), 0),
    totalRoms: rows.reduce((n, r) => n + (r.rom_count || 0), 0),
  };
}

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

export function PlatformSyncList({ sync }: { sync: ReturnType<typeof usePlatformSync> }) {
  const { rows, off, loading, connected, unavailable, saving, toggle } = sync;
  if (loading) {
    return <V2SettingsRow icon={<FaLayerGroup size={16} />} title="Reading your platforms…" />;
  }
  if (!connected) {
    return <V2SettingsRow icon={<FaLayerGroup size={16} />}
      title="Not connected to RomM"
      subtitle="Connect to RomM to choose which platforms to sync." />;
  }
  if (unavailable) {
    return <V2SettingsRow icon={<FaLayerGroup size={16} />}
      title="Couldn’t read your platforms"
      subtitle="Your server didn’t answer. Retrying…" />;
  }
  if (!rows.length) {
    return <V2SettingsRow icon={<FaLayerGroup size={16} />}
      title="No platforms on the server"
      subtitle="Add one in RomM and it’ll show up here." />;
  }
  return (
    <>
      {rows.map((row) => {
        const isOff = off.has(row.slug);
        const count = (row.rom_count || 0).toLocaleString();
        return (
          <V2SettingsRow key={row.slug}
            bareIcon
            icon={<PlatformIcon slug={row.slug} size={28} />}
            title={row.name}
            subtitle={saving.has(row.slug)
              ? 'Saving…'
              : isOff
                ? `Not syncing — ${count} game${row.rom_count === 1 ? '' : 's'} left on RomM.`
                : `${count} game${row.rom_count === 1 ? '' : 's'}`}
            onClick={() => toggle(row.slug)}
            right={<V2Switch checked={!isOff} />} />
        );
      })}
    </>
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
