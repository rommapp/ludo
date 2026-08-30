/**
 * Steam, as this shell's implementation of Ludo's HostLauncher.
 *
 * Every line below moved here unchanged from the shared UI, where it sat among
 * the React pages reaching for `window.SteamClient`, `window.appStore` and
 * `window.collectionStore` directly. It is undocumented, version-fragile, and
 * several of its comments record behaviour measured live on a Deck — all good
 * reasons for it to have one home rather than being threaded through a 9.7k-line
 * file.
 *
 * Three couplings back into the app became hooks, so routing stays the app's:
 * opening the library, and deciding whether a path is one of ours.
 */
import { Router } from "@decky/ui";
import { callable, toaster } from "@decky/api";
import type { HostLauncher, LauncherHooks } from "./contract";

// Backend calls this file makes on its own behalf. Same method names the app
// binds; `callable` just marshals to the Python side either way.
const getPluginLogo = callable<[], any>("get_plugin_logo");
const getRommArtwork = callable<[], any>("get_romm_artwork");
const getSessionHostPath = callable<[], any>("get_session_host_path");
const getShortcutIconPath = callable<[], any>("get_shortcut_icon_path");
const installShortcutIcon = callable<[number], any>("install_shortcut_icon");
const launchRetrodeckNative = callable<[], { ok: boolean; reason?: string }>("launch_retrodeck");

let _hooks: LauncherHooks | null = null;

/**
 * Where Big Picture currently is. Plugin code runs in Decky's SharedJSContext,
 * so this is not `location.pathname` — it comes off the Steam window's own
 * history.
 */
function _currentPath(): string | null {
  try {
    return (Router as any)?.WindowStore?.GamepadUIMainWindowInstance?.m_history?.location?.pathname ?? null;
  } catch {
    return null;
  }
}

// ─── Steam library "Ludo" shortcut (mandatory) ───────────────────────────────
// A non-Steam shortcut named "Ludo" is auto-created at plugin load (once RomM is
// configured) and is required: launching it from the library opens the Game
// Browser, and picking a game RunGame's this same tile so the emulator runs as a
// Steam-tracked child (working overlay). All SteamClient calls are undocumented +
// version-fragile, so every call is feature-detected and wrapped — failures
// degrade to a toast, never a crash.
const ROMM_SHORTCUT_NAME = "Ludo";
// Tiles created before the rename still carry "RomM" on disk. They're matched
// (and renamed on the next reconcile) rather than left behind as a duplicate.
const ROMM_SHORTCUT_LEGACY_NAMES = ["RomM"];
// Fallback exe when the session-host script can't be resolved. With /bin/true the
// tile still opens the browser (via the launch intercept) but the Steam-overlay
// session-host launch path is unavailable, so Play falls back to a direct launch.
const ROMM_SHORTCUT_EXE = "/bin/true";
// The real exe: bin/romm-session-host. When the tile is RunGame'd after a game is
// picked, Steam launches this as a tracked game (opening the overlay session) and
// it execs the resolved emulator argv in-place — so the emulator inherits the
// overlay. Resolved lazily from the backend (absolute, plugin-dir dependent).
let _sessionHostExe: string | null = null;
async function rommShortcutExe(): Promise<string> {
  if (_sessionHostExe) return _sessionHostExe;
  try {
    const r = await getSessionHostPath();
    const p = typeof r === 'string' ? r : r?.path;
    if (p) { _sessionHostExe = p; return p; }
  } catch (e) { console.error('[RomM] getSessionHostPath', e); }
  return ROMM_SHORTCUT_EXE;
}
// Stamped into the shortcut's launch options so we can re-identify our tile
// even when Steam hasn't persisted its name (the root cause of duplicates and
// the toggle flipping off after an update).
const ROMM_TILE_SENTINEL = "ludo-tile";
let _rommAppId: number | null = null;
let _rommNavTimer: any = null;
let _rommActionReg: { unregister: () => void } | null = null;
// Set true immediately before we RunGame the tile to launch a *picked* game, so
// the launch intercept lets the session-host run (and execs the emulator) instead
// of treating it as a bare tile click (terminate + open the browser).
let _rommLaunchPending = false;
// Set true while a *picked-game* session is running (host execs the emulator as a
// Steam-tracked child). When that session ends we want to return to the Game
// Browser, not leave the user dropped on the Steam/Big-Picture library.
let _rommSessionActive = false;
// Set when the session-end watch navigates back to the Game Browser: the route
// comes back without gamepad focus (Steam parks it on its own chrome after a
// game exits), leaving the user unable to see or move a selection. The library
// root consumes this and pulls focus onto the tile that was played.
let _rommReturnFocusPending = false;
// Notified when the flag is armed. Consuming it on mount alone was not enough:
// a game launched from a TILE never leaves the Game Browser route, so the page
// is still mounted when the session ends and the mount effect — which is where
// the whole restore lived — simply never ran again. That is the "launch from
// Home, come back to no selection" case.
const _returnFocusSubs = new Set<() => void>();
function armReturnFocus() {
  _rommReturnFocusPending = true;
  _returnFocusSubs.forEach((f) => { try { f(); } catch { /* ignore */ } });
}
let _rommLifetimeReg: { unregister: () => void } | null = null;
const _sc = (): any => (typeof window !== 'undefined' ? (window as any).SteamClient : undefined);

// Enumerate all non-Steam shortcut overviews. This build does NOT expose
// SteamClient.Apps.GetAllShortcuts, so we read the app stores Steam keeps in
// memory and keep only entries that report themselves as shortcuts.
// AppIds of all non-Steam shortcuts. deckDesktopApps.apps is a Map keyed by
// appid on this build; the map values are not overviews, so we resolve each
// overview separately via appStore.GetAppOverviewByAppID.
function _shortcutAppIds(): number[] {
  const m = (window as any).collectionStore?.deckDesktopApps?.apps;
  try { if (m?.keys) return Array.from(m.keys()).map((k: any) => Number(k)); } catch { /* ignore */ }
  return [];
}

// True once Steam's shortcut store is actually populated. Early in Steam
// startup deckDesktopApps.apps can be missing or still empty; creating a
// shortcut then duplicates a tile that already exists on disk but isn't
// visible yet — the root cause of multiple "Ludo" entries piling up.
function _shortcutStoreReady(): boolean {
  try {
    const m = (window as any).collectionStore?.deckDesktopApps?.apps;
    return !!m?.keys && Array.from(m.keys()).length > 0;
  } catch { return false; }
}

function _appName(appid: number): string {
  try { return String((window as any).appStore?.GetAppOverviewByAppID?.(appid)?.display_name ?? ''); } catch { return ''; }
}

// All our tiles carry the name "Ludo" (or "RomM", pre-rename); also accept the
// exe-derived fallback names Steam uses when a name didn't persist. Real games
// carry their own names.
function _isRommName(nm: string): boolean {
  return nm === ROMM_SHORTCUT_NAME || ROMM_SHORTCUT_LEGACY_NAMES.includes(nm)
    || nm === 'true' || nm === '/bin/true'
    || nm === 'romm-session-host';
}

function _rommAppIds(): number[] {
  return _shortcutAppIds().filter((aid) => _isRommName(_appName(aid)));
}

// Stamp "played just now" onto the Ludo tile's overview so it surfaces in the
// home row's Recent Games. Steam only records last-played for sessions it ran
// to completion — bare tile clicks are terminated by the intercept before that
// happens, and opening the browser from the Decky panel never touches the tile
// at all. Writing rt_last_time_played on the in-memory overview is how Steam's
// own recents sort is fed (same approach MoonDeck uses); real picked-game
// sessions still persist it properly on exit.
function touchRommRecency() {
  try {
    const aid = _rommAppId ?? _rommAppIds()[0];
    if (aid == null) return;
    const ov = (window as any).appStore?.GetAppOverviewByAppID?.(aid);
    if (!ov) return;
    ov.rt_last_time_played = Math.floor(Date.now() / 1000);
    // The recents carousel can exclude apps with zero recorded playtime, and a
    // plain field write doesn't always notify the (MobX-backed) collections.
    // Give the tile a minute of playtime and poke the store's change hooks so
    // the home row actually re-sorts without needing a real session first.
    if (!Number(ov.minutes_playtime_forever)) ov.minutes_playtime_forever = "1";
    try { ov.OnAppOverviewChanged?.(); } catch { /* ignore */ }
    try { (window as any).appStore?.m_mapApps?.set?.(Number(aid), ov); } catch { /* ignore */ }
  } catch { /* ignore */ }
}

// Every app overview Steam knows about (installed games + non-Steam shortcuts),
// used to locate RetroDECK's library entry by name.
function _allAppOverviews(): any[] {
  try { return (window as any).collectionStore?.allAppsCollection?.allApps ?? []; }
  catch { return []; }
}

// Launch RetroDECK via its Steam library entry instead of spawning the flatpak
// ourselves. Steam runs it inside the real graphical session (correct display/
// dbus/env + overlay), sidestepping the env contamination that makes a
// daemon-spawned `flatpak run` crash. RetroDECK's installer adds a non-Steam
// shortcut named "RetroDECK"; we also scan installed apps as a fallback.
async function launchRetrodeckViaSteam(): Promise<{ ok: boolean; reason?: string }> {
  const apps = _sc()?.Apps;
  // No SteamClient — spawn RetroDECK from the backend instead. Nothing here is
  // Steam-tracked, but there is no Steam session to track it in either.
  if (!apps?.RunGame) {
    try { return await launchRetrodeckNative(); }
    catch (e) { return { ok: false, reason: String(e) }; }
  }
  const isRd = (nm: string) => /retrodeck/i.test(nm || '');
  const shortcutIds = _shortcutAppIds();
  let appId: number | null = null;
  for (const aid of shortcutIds) { if (isRd(_appName(aid))) { appId = aid; break; } }
  if (appId == null) {
    for (const ov of _allAppOverviews()) {
      if (isRd(ov?.display_name)) { appId = Number(ov.appid); break; }
    }
  }
  if (appId == null) {
    // Installed but never added to Steam: still launchable directly.
    try {
      const r = await launchRetrodeckNative();
      if (r.ok) return r;
    } catch { /* fall through to the library-side message */ }
    return { ok: false, reason: 'RetroDECK not found in your Steam library' };
  }
  // A non-Steam shortcut launches by its 64-bit gameID ((appid<<32)|0x02000000);
  // a real Steam app launches by its bare appid.
  const gid = shortcutIds.includes(appId)
    ? ((BigInt(appId) << 32n) | 0x2000000n).toString()
    : String(appId);
  await apps.RunGame(gid, "", -1, 100);
  return { ok: true };
}

async function findRommShortcut(): Promise<number | null> {
  if (_rommAppId != null) return _rommAppId;
  try {
    const ids = _rommAppIds();
    if (ids.length) return ids[0];
  } catch (e) { console.error('[RomM] findRommShortcut', e); }
  return null;
}

// Remove duplicate Ludo tiles left behind by earlier sessions, keeping one.
// Returns the surviving appId (or null if none).
async function cleanupRommShortcuts(): Promise<number | null> {
  try {
    const apps = _sc()?.Apps;
    const mine = _rommAppIds();
    if (mine.length === 0) return null;
    // Keep the tile the user has actually used (play history / recent-games
    // placement lives on the appid), not whichever duplicate enumerates first.
    const score = (aid: number): number => {
      try {
        const ov = (window as any).appStore?.GetAppOverviewByAppID?.(aid);
        return (Number(ov?.rt_last_time_played) || 0) * 1e6
          + (Number(ov?.minutes_playtime_forever) || 0);
      } catch { return 0; }
    };
    const keep = mine.reduce((a, b) => (score(b) > score(a) ? b : a));
    for (const aid of mine.filter((x) => x !== keep)) {
      try { await apps?.RemoveShortcut?.(aid); } catch (e) { console.error('[RomM] dedup remove', e); }
    }
    return keep;
  } catch (e) { console.error('[RomM] cleanupRommShortcuts', e); return null; }
}

// Bring the Ludo tile into a known-good state: collapse duplicates to one,
// repair the survivor's name + sentinel, repaint art, and bind the launch
// intercept. Safe to call repeatedly. Returns the surviving appId (or null).
// Run this when the shortcut store is ready (e.g. on Settings open), not only
// at plugin load, where GetAllShortcuts can still be empty.
async function reconcileRommTile(): Promise<number | null> {
  // No live Steam client to reconcile against — nothing to do. (This used to
  // ask the host whether tiles go through shortcuts.vdf, which was a roundabout
  // way of asking the same thing from the wrong side of the seam.)
  if (!_sc()) return null;
  const appId = (await cleanupRommShortcuts()) ?? (await findRommShortcut());
  if (appId == null) return null;
  _rommAppId = appId;
  const apps = _sc()?.Apps;
  try { await apps?.SetShortcutName?.(appId, ROMM_SHORTCUT_NAME); } catch { /* ignore */ }
  try { await apps?.SetShortcutLaunchOptions?.(appId, ROMM_TILE_SENTINEL); } catch { /* ignore */ }
  // Migrate the exe to the session-host script (older tiles used /bin/true).
  try {
    const exe = await rommShortcutExe();
    if (apps?.SetShortcutExe) await apps.SetShortcutExe(appId, exe);
  } catch (e) { console.error('[RomM] reconcile SetShortcutExe', e); }
  // Stamping name/launch-options can renumber the shortcut appid (it's a hash of
  // exe+name+options). Re-resolve so the cache, intercept and artwork all target
  // the live tile rather than the now-dead pre-stamp appid.
  const liveId = (_rommAppIds()[0]) ?? appId;
  _rommAppId = liveId;
  registerRommLaunchIntercept();
  ensureRommArtwork(liveId);
  // Keep the tile visible in the home row's Recent Games across restarts: the
  // recency stamp is in-memory, so re-assert it whenever we reconcile (plugin
  // load included) rather than only when the browser opens.
  touchRommRecency();
  return liveId;
}

async function ensureRommArtwork(appId: number) {
  try {
    const apps = _sc()?.Apps;
    if (!apps?.SetCustomArtworkForApp) return;
    // The small square icon, which is NOT one of the artwork asset types: it is
    // the shortcut's own `icon` field in shortcuts.vdf, a path on disk. Nothing
    // was ever writing it, so the field stayed empty and Steam drew its grey
    // placeholder beside "Ludo" in the Steam menu and on Home — while the big
    // logo above Resume, which IS an asset type, looked perfectly fine.
    try {
      const icon = await getShortcutIconPath();
      if (icon?.path) await apps.SetShortcutIcon?.(appId, icon.path);
      // And the copy Gaming Mode actually paints from: grid/<appid>_icon.png.
      // The field alone was not enough — it pointed at the plugin's assets
      // directory and the placeholder stayed put. Every shortcut on the device
      // that shows an icon has this file.
      await installShortcutIcon(appId);
    } catch (e) { console.error('[RomM] shortcut icon', e); }
    // Steam asset types -> files this build writes:
    //   0 -> {appid}p.png   (portrait capsule)  : grid
    //   1 -> {appid}_hero   (hero background)    : hero
    //   2 -> {appid}_logo   (transparent logo)   : logo
    //   4 -> {appid}.png    (landscape capsule)  : THIS is the image Big
    //        Picture's "Recent Games" featured banner uses, so it must get the
    //        background-only landscape art, not the centered-mark icon.
    // (Type 3 is a no-op on this build, so the landscape goes through type 4.)
    const res = await getRommArtwork();
    const art = res?.art as Record<string, string> | undefined;
    if (art && Object.keys(art).length) {
      const ext = res.ext || 'png';
      // type -> source art key. Type 4 (the landscape {appid}.png) is fed the
      // header (bg-only) art instead of the icon.
      const plan: [number, string][] = [[0, '0'], [1, '1'], [2, '2'], [4, '3']];
      for (const [n, key] of plan) {
        if (!art[key]) continue;
        // Clear first: Steam won't overwrite an existing custom asset, so a
        // repaint over stale art would otherwise silently no-op.
        try { await apps.ClearCustomArtworkForApp?.(appId, n); } catch { /* ignore */ }
        try { await apps.SetCustomArtworkForApp(appId, art[key], ext, n); } catch { /* ignore */ }
      }
      return;
    }
    // Fallback to the flat logo if branded artwork is unavailable.
    const logo = await getPluginLogo();
    if (!logo?.b64) return;
    try { await apps.SetCustomArtworkForApp(appId, logo.b64, logo.ext || 'png', 0); } catch { /* ignore */ }
    try { await apps.SetCustomArtworkForApp(appId, logo.b64, logo.ext || 'png', 4); } catch { /* ignore */ }
  } catch (e) { console.error('[RomM] ensureRommArtwork', e); }
}

// Create the shortcut if missing; returns the appId (or null on failure).
// `force` skips the store-readiness gate — used only as a last resort when the
// store never reported ready (e.g. a user with zero non-Steam shortcuts, where
// the empty store is legitimate and creating cannot duplicate anything).
async function addRommShortcut(force = false): Promise<number | null> {
  // No live Steam client to add to — never attempt it (this is where the
  // "Steam shortcuts API unavailable" toast came from).
  if (!_sc()) return null;
  try {
    // Never create while the shortcut store is empty/unloaded: the existing
    // Ludo tile may simply not be visible yet, and AddShortcut here is exactly
    // how duplicate "Ludo" entries were piling up on each Steam restart.
    if (!force && !_shortcutStoreReady()) return null;
    const apps = _sc()?.Apps;
    if (!apps?.AddShortcut) { toaster.toast({ title: 'Ludo', body: 'Steam shortcuts API unavailable on this build.' }); return null; }
    const exe = await rommShortcutExe();
    let appId = await findRommShortcut();
    if (appId == null) {
      appId = Number(await apps.AddShortcut(ROMM_SHORTCUT_NAME, exe, "", ""));
    } else if (apps.SetShortcutExe) {
      // Migrate older /bin/true tiles to the session-host exe so the overlay
      // launch path works. Harmless if already set.
      try { await apps.SetShortcutExe(appId, exe); } catch (e) { console.error('[RomM] SetShortcutExe', e); }
    }
    // Always (re)assert the display name. AddShortcut's name arg doesn't reliably
    // persist to the shortcut's strAppName on all Steam builds, so the tile can
    // show up blank/"true" without an explicit SetShortcutName.
    if (apps.SetShortcutName) {
      try { await apps.SetShortcutName(appId, ROMM_SHORTCUT_NAME); } catch (e) { console.error('[RomM] SetShortcutName', e); }
    }
    // Stamp the sentinel so we can always re-find this tile even if the name
    // doesn't persist — this is what prevents duplicate tiles piling up.
    if (apps.SetShortcutLaunchOptions) {
      try { await apps.SetShortcutLaunchOptions(appId, ROMM_TILE_SENTINEL); } catch (e) { console.error('[RomM] SetShortcutLaunchOptions', e); }
    }
    _rommAppId = appId;
    await ensureRommArtwork(appId);
    registerRommLaunchIntercept();
    registerRommSessionEndWatch();
    return appId;
  } catch (e) {
    console.error('[RomM] addRommShortcut', e);
    toaster.toast({ title: 'Ludo', body: 'Could not add the library tile.' });
    return null;
  }
}


// Intercept the Ludo tile's launch → cancel the no-op run and open the browser.
function registerRommLaunchIntercept() {
  try {
    if (_rommActionReg) return;
    const apps = _sc()?.Apps;
    if (!apps?.RegisterForGameActionStart) return;
    _rommActionReg = apps.RegisterForGameActionStart((_actionType: number, strAppId: string) => {
      const raw = Number(strAppId);
      // GameActionStart may pass the full 64-bit gameID; the 32-bit appid is its
      // high dword. Try both the raw value and the extracted appid.
      const hi = Math.floor(raw / 4294967296);
      const aid = hi > 0 ? hi : raw;
      // Identify by name/overview, not numeric id: GameActionStart's appid
      // representation (signed/unsigned/gameid) doesn't reliably equal the
      // collectionStore key, and stamping renumbers the cached id. Name match
      // sidesteps all of that.
      let mine = aid === _rommAppId || raw === _rommAppId;
      if (!mine) { try { mine = _isRommName(_appName(aid)) || _isRommName(_appName(raw)); } catch { /* ignore */ } }
      if (!mine) { try { mine = _rommAppIds().includes(aid) || _rommAppIds().includes(raw); } catch { /* ignore */ } }
      if (mine) {
        _rommAppId = aid;
        // A picked-game launch: we wrote a launch-spec and RunGame'd the tile so
        // the session-host can exec the emulator as a Steam-tracked child (overlay
        // works). Let it run — do NOT terminate or navigate.
        if (_rommLaunchPending) {
          _rommLaunchPending = false;
          // Remember this is a live emulator session so the app-lifetime
          // listener can navigate back to the Game Browser when it quits
          // (instead of leaving the user on the Steam/Big-Picture library).
          _rommSessionActive = true;
          return;
        }
        // Bare tile click: the exe is a no-op without a fresh spec. The tile
        // fires this twice (launch start type=6, then exit type=7 ~1.5s later).
        // End the launch immediately and open the Game Browser instead.
        try { _sc()?.Apps?.TerminateApp?.(String(strAppId), false); } catch { /* ignore */ }
        if (_rommNavTimer != null) { try { clearTimeout(_rommNavTimer); } catch { /* ignore */ } }
        _rommNavTimer = setTimeout(() => {
          _rommNavTimer = null;
          try { _hooks?.openLibrary(); } catch (e) { console.error('[RomM] nav', e); }
        }, 0);
      }
    });
  } catch (e) { console.error('[RomM] registerRommLaunchIntercept', e); }
}

// When a picked-game emulator session ends, the session-host PID exits and Steam
// returns to the library (Big Picture) — not the plugin. Register for app
// lifetime notifications so that when OUR tile stops running after a real
// session, we navigate straight back to the Game Browser.
function registerRommSessionEndWatch() {
  try {
    if (_rommLifetimeReg) return;
    const gs = _sc()?.GameSessions;
    if (!gs?.RegisterForAppLifetimeNotifications) return;
    _rommLifetimeReg = gs.RegisterForAppLifetimeNotifications((data: any) => {
      try {
        if (data?.bRunning) return;            // only care about stop events
        if (!_rommSessionActive) return;       // not our emulator session
        // Like the launch intercept, the notification may carry the 64-bit
        // gameID rather than the bare 32-bit appid — the appid is its high
        // dword. Check both representations.
        const raw = Number(data?.unAppID);
        const hi = Math.floor(raw / 4294967296);
        const candidates = hi > 0 ? [raw, hi] : [raw];
        let mine = candidates.some((a) => a === _rommAppId);
        if (!mine) { try { const ids = _rommAppIds(); mine = candidates.some((a) => ids.includes(a)); } catch { /* ignore */ } }
        if (!mine) { try { mine = candidates.some((a) => _isRommName(_appName(a))); } catch { /* ignore */ } }
        if (!mine) return;
        _rommSessionActive = false;
        if (_rommNavTimer != null) { try { clearTimeout(_rommNavTimer); } catch { /* ignore */ } }
        // Navigate back almost immediately. Steam runs its own post-exit
        // navigation to Big Picture home on its own schedule — a single early
        // Navigate can get stomped by it (that's why this used to wait 900ms).
        // Instead: go at 250ms, then for the next ~2s re-assert our route if
        // Steam moved it off. Steam's focus context also delivers NO focus
        // events for ~5.5s after an app exits (measured on-device); the
        // forced-focus + gpfocus mirror machinery bridges that gap.
        const nav = () => {
          armReturnFocus();
          try { _hooks?.openLibrary(); } catch (e) { console.error('[RomM] nav', e); }
        };
        _rommNavTimer = setTimeout(() => {
          _rommNavTimer = null;
          nav();
          [500, 1100, 1900].forEach((d) => setTimeout(() => {
            try {
              const p = _currentPath();
              // Only reclaim the screen from STEAM's post-exit navigation. A
              // route of ours means the user is already navigating inside the
              // plugin (e.g. straight into Settings) — yanking them back to the
              // library here caused the "Settings opens then closes" bug.
              if (p && !_hooks?.isOwnRoute(p)) nav();
            } catch { /* ignore */ }
          }, d));
        }, 250);
      } catch (e) { console.error('[RomM] sessionEnd', e); }
    });
  } catch (e) { console.error('[RomM] registerRommSessionEndWatch', e); }
}


// ── The contract ────────────────────────────────────────────────────────────

export const launcher: HostLauncher = {
  // Steam's client object is injected into the plugin's context by Decky. If it
  // is absent this build cannot drive the library, and every method below
  // degrades rather than throwing.
  get available() {
    return !!_sc();
  },

  start(hooks: LauncherHooks) {
    _hooks = hooks;
    registerRommLaunchIntercept();
    registerRommSessionEndWatch();
  },

  stop() {
    try { _rommActionReg?.unregister(); } catch { /* ignore */ }
    _rommActionReg = null;
    try { _rommLifetimeReg?.unregister(); } catch { /* ignore */ }
    _rommLifetimeReg = null;
    if (_rommNavTimer != null) { try { clearTimeout(_rommNavTimer); } catch { /* ignore */ } }
    _rommNavTimer = null;
    _hooks = null;
  },

  async hasTile(): Promise<boolean> {
    // Re-resolve the live tile appid: SetShortcutExe renumbers it (appid is a
    // hash of exe+name), so a cached _rommAppId can be stale.
    const liveIds = _rommAppIds();
    const appId = liveIds.length ? liveIds[0] : (_rommAppId ?? await findRommShortcut());
    if (appId == null) return false;
    _rommAppId = appId;
    return true;
  },

  reconcileTile: () => reconcileRommTile(),

  ensureTile: (force = false) => addRommShortcut(force),

  async launchTile(): Promise<boolean> {
    if (_rommAppId == null) return false;
    _rommLaunchPending = true;
    // Mark the session active HERE, not only in the GameActionStart intercept:
    // on some Steam builds RunGame-initiated launches don't fire
    // GameActionStart, and then the app-lifetime end-watch would never navigate
    // back to the Game Browser.
    _rommSessionActive = true;
    try {
      // A non-Steam shortcut is launched by its 64-bit gameID, not the bare
      // 32-bit appid: gameID = (appid << 32) | 0x02000000 (shortcut tag). This
      // is the same value GameActionStart reports back to the intercept.
      const gid = ((BigInt(_rommAppId) << 32n) | 0x2000000n).toString();
      await _sc()?.Apps?.RunGame?.(gid, "", -1, 100);
      touchRommRecency();
      return true;
    } catch (e) {
      _rommLaunchPending = false;
      _rommSessionActive = false;
      console.error('[RomM] RunGame', e);
      return false;
    }
  },

  launchRetroDeck: () => launchRetrodeckViaSteam(),

  markRecentlyUsed: () => touchRommRecency(),

  consumeReturnFocus(): boolean {
    if (!_rommReturnFocusPending) return false;
    _rommReturnFocusPending = false;
    return true;
  },

  onReturnFocus(cb: () => void): () => void {
    _returnFocusSubs.add(cb);
    return () => { _returnFocusSubs.delete(cb); };
  },
};
