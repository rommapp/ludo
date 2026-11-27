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
import { addEventListener, callable, removeEventListener, toaster } from "@decky/api";
import type { GameShortcutResult, HostLauncher, LauncherHooks } from "./contract";

// Backend calls this file makes on its own behalf. Same method names the app
// binds; `callable` just marshals to the Python side either way.
const getPluginLogo = callable<[], any>("get_plugin_logo");
const getRommArtwork = callable<[], any>("get_romm_artwork");
const getSessionHostPath = callable<[], any>("get_session_host_path");
const getShortcutIconPath = callable<[], any>("get_shortcut_icon_path");
const installShortcutIcon = callable<[number], any>("install_shortcut_icon");
const getSteamTileStatus = callable<[], any>("get_steam_tile_status");
const launchRetrodeckNative = callable<[], { ok: boolean; reason?: string }>("launch_retrodeck");
const getDeckSteamShortcuts = callable<[], any>("get_deck_steam_shortcuts");
const getGameSteamArt = callable<[number, number | null], any>("get_game_steam_art");
const recordGameSteamShortcut = callable<[number, number | null], any>("record_game_steam_shortcut");

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
let _rommFocusReg: { unregister: () => void } | null = null;
// Steam's own gamepad UI, as gamescope reports it.
const STEAM_UI_APPID = 769;
// The emulator's window has closed and the session host is only lingering:
// still a running app to Steam, but nothing to resume.
let _rommWindowGone = false;
// ...which only means something once the window has existed: at launch Steam
// reports focus on itself before the emulator has mapped one.
let _rommWindowSeen = false;
const _sc = (): any => (typeof window !== 'undefined' ? (window as any).SteamClient : undefined);

// Enumerate all non-Steam shortcut overviews. This build does NOT expose
// SteamClient.Apps.GetAllShortcuts, so we read the app stores Steam keeps in
// memory and keep only entries that report themselves as shortcuts.
// AppIds of all non-Steam shortcuts. deckDesktopApps.apps is a Map keyed by
// appid on this build; the map values are not overviews, so we resolve each
// overview separately via appStore.GetAppOverviewByAppID.
// app_type of a non-Steam shortcut overview.
const SHORTCUT_APP_TYPE = 1073741824;

function _shortcutAppIds(): number[] {
  const m = (window as any).collectionStore?.deckDesktopApps?.apps;
  try { if (m?.keys) return Array.from(m.keys()).map((k: any) => Number(k)); } catch { /* ignore */ }
  // deckDesktopApps is null outside the Deck's own build (desktop Steam with
  // Decky, e.g. Bazzite), so read the overviews themselves. Without this every
  // lookup came back empty: duplicates were never collapsed and the forced
  // last retry added a fresh "Ludo" on every plugin load.
  try {
    const all = (window as any).appStore?.m_mapApps;
    if (all?.values) {
      return Array.from(all.values())
        .filter((o: any) => o?.app_type === SHORTCUT_APP_TYPE)
        .map((o: any) => Number(o.appid));
    }
  } catch { /* ignore */ }
  return [];
}

// True once Steam's shortcut store is actually populated. Early in Steam
// startup the stores can be missing or still empty; creating a shortcut then
// duplicates a tile that already exists on disk but isn't visible yet — the
// root cause of multiple "Ludo" entries piling up.
function _shortcutStoreReady(): boolean {
  try { return _shortcutAppIds().length > 0; } catch { return false; }
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

// The desktop app's own "Ludo" tile, when this machine also runs it. It carries
// the same name as ours but is a different shortcut (another exe, written to
// shortcuts.vdf by the desktop app), so every name-based lookup below would
// treat it as a duplicate -- deleting it, or worse, rewriting its exe to ours.
let _desktopTileId: number | null = null;

async function refreshDesktopTileId(): Promise<void> {
  try {
    const st = await getSteamTileStatus();
    const aid = st?.installed ? Number(st.appid) : NaN;
    _desktopTileId = Number.isFinite(aid) ? aid >>> 0 : null;
  } catch { /* keep the last answer */ }
}

function _rommAppIds(): number[] {
  // A game's own shortcut runs the same session-host, so until it is renamed
  // Steam calls it "romm-session-host" too; it is never a duplicate tile.
  // Another machine's tile (Remote Play) is never ours either.
  return _shortcutAppIds().filter((aid) =>
    (aid >>> 0) !== _desktopTileId && _romForApp(aid >>> 0) == null
    && !_isRemote(aid) && _isRommName(_appName(aid)));
}

// Steam lists the apps of the user's other machines on the network for Remote
// Play streaming, Ludo tiles and game shortcuts included. They are not
// shortcuts on this device: never adopt, repaint, remove or intercept them, so
// Play streams them as Steam intends. per_client_data names the machines an
// app is on; this one is clientid "0".
function _isRemote(aid: number): boolean {
  try {
    const pcd = (window as any).appStore?.GetAppOverviewByAppID?.(aid >>> 0)?.per_client_data;
    if (!Array.isArray(pcd) || !pcd.length) return false;
    return !pcd.some((c: any) => String(c?.clientid) === '0');
  } catch { return false; }
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
    await refreshDesktopTileId();
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
    //   3 or 4 -> {appid}.png (landscape capsule) : THIS is the image Big
    //        Picture's "Recent Games" featured banner uses, so it must get the
    //        background-only landscape art, not the centered-mark icon.
    // Which type writes the landscape changed between Steam builds: older ones
    // ignored 3 and took 4; current ones (Nov 2026, Deck and Arch) take 3 and
    // reject 4. So it's sent as both; the unsupported one fails harmlessly.
    const res = await getRommArtwork();
    const art = res?.art as Record<string, string> | undefined;
    if (art && Object.keys(art).length) {
      const ext = res.ext || 'png';
      // type -> source art key. Type 4 (the landscape {appid}.png) is fed the
      // header (bg-only) art instead of the icon.
      const plan: [number, string][] = [[0, '0'], [1, '1'], [2, '2'], [3, '3'], [4, '3']];
      await setArtwork(apps, appId, plan.filter(([, key]) => art[key]).map(([n, key]) => [n, art[key]]), ext);
      return;
    }
    // Fallback to the flat logo if branded artwork is unavailable.
    const logo = await getPluginLogo();
    if (!logo?.b64) return;
    try { await apps.SetCustomArtworkForApp(appId, logo.b64, logo.ext || 'png', 0); } catch { /* ignore */ }
    try { await apps.SetCustomArtworkForApp(appId, logo.b64, logo.ext || 'png', 3); } catch { /* ignore */ }
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
    await refreshDesktopTileId();
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
      if (_interceptGameShortcut(aid >>> 0, String(strAppId))) return;
      // Another machine's tile: let Steam stream it.
      if (_isRemote(aid) || _isRemote(raw)) return;
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
          // Usually already done: the window-gone watch routed here while the
          // session host was still lingering. Navigating again would only
          // re-push the route under the user.
          const here = _currentPath();
          if (!(_rommWindowGone && here && _hooks?.isOwnRoute(here))) nav();
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


// Go back to Ludo the moment the emulator window closes, not when Steam
// reports the app exited. Steam applies a navigation ~2s after the game window
// goes, and after an EXIT it first routes to the tile's own library page, so
// waiting for the lifetime notification showed that page for a couple of
// seconds ("back to Big Picture, then Ludo"). bin/romm-session-host outlives
// the emulator for a moment so that this fires while the app still runs, and
// Steam never gets to put its page up.
function registerRommWindowGoneWatch() {
  try {
    if (_rommFocusReg) return;
    const ui = _sc()?.System?.UI;
    if (!ui?.RegisterForFocusChangeEvents) return;
    _rommFocusReg = ui.RegisterForFocusChangeEvents((f: any) => {
      try {
        if (!_rommSessionActive || !_sessionRunning()) return;
        if (Number(f?.focusedApp?.appid) !== STEAM_UI_APPID) {
          if (Number(f?.focusedApp?.appid) === _rommAppId) _rommWindowSeen = true;
          return;
        }
        // Still focusable means the game is up and the user opened Steam's
        // menu over it; only a game with no window left has ended.
        const ours = (f?.rgFocusable ?? []).some((w: any) => Number(w?.appid) === _rommAppId);
        if (ours) { _rommWindowSeen = true; return; }
        if (!_rommWindowSeen) return;
        // Steam's placeholder for the running game -- anywhere else, the user
        // has already gone somewhere on purpose.
        if (_currentPath() !== '/apprunning') return;
        _rommWindowGone = true;
        armReturnFocus();
        _hooks?.openLibrary();
      } catch (e) { console.error('[RomM] windowGone', e); }
    });
  } catch (e) { console.error('[RomM] registerRommWindowGoneWatch', e); }
}

// ─── Per-game shortcuts (#105) ───────────────────────────────────────────────
// A game the user added to Steam gets its own shortcut. Its exe is the same
// session-host as the Ludo tile, and its launch options carry GAME_SENTINEL
// plus the rom id. Steam launching it directly would run the host with no
// launch-spec, so the intercept cancels that launch and asks the app to run
// its normal launch of the game (save sync, conflict prompt, core picker).
// That ends in launchTile(romId), which RunGames this shortcut rather than
// the Ludo tile, so the session and its play time belong to the game.
// When the game exits the user stays in Steam, where they started.
//
// The backend keeps the rom id → appid registry, because it is the side that
// learns a game left the device; it queues those removals and nudges us.
const GAME_SENTINEL = "ludo-rom:";
// rom id → unsigned appid of the live shortcut.
const _gameShortcuts = new Map<number, number>();
let _gameShortcutsLoad: Promise<void> | null = null;
let _gameShortcutEventsOff: (() => void) | null = null;
let _gameShortcutRetry: any = null;
// Which shortcut the launch the intercept started should run. Keyed by rom so
// a different game's Play in Ludo never picks it up, and expiring because a
// save-conflict prompt the user dismisses ends that launch without a word.
let _gameLaunchTarget: { romId: number; appid: number; at: number } | null = null;
const GAME_LAUNCH_TARGET_TTL_MS = 10 * 60 * 1000;
// The shortcut we are RunGame'ing ourselves, which the intercept lets through.
let _gameLaunchPending: number | null = null;

function _gid(appid: number): string {
  return ((BigInt(appid >>> 0) << 32n) | 0x2000000n).toString();
}

function _shortcutExists(appid: number): boolean {
  try { return !!(window as any).appStore?.GetAppOverviewByAppID?.(appid >>> 0); } catch { return false; }
}

function _romForApp(appid: number): number | null {
  for (const [romId, aid] of _gameShortcuts) if (aid === appid) return romId;
  return null;
}

// Pull the registry, apply queued removals, and forget shortcuts the user
// deleted in Steam themselves. Safe to call repeatedly.
async function syncGameShortcuts(): Promise<void> {
  const r = await getDeckSteamShortcuts();
  if (!r?.success) return;
  const apps = _sc()?.Apps;
  for (const [rom, appid] of Object.entries<any>(r.removals || {})) {
    const aid = Number(appid) >>> 0;
    try { if (_shortcutExists(aid)) await apps?.RemoveShortcut?.(aid); }
    catch (e) { console.error('[RomM] remove game shortcut', e); continue; }
    _gameShortcuts.delete(Number(rom));
    try { await recordGameSteamShortcut(Number(rom), null); } catch { /* retried next sync */ }
  }
  _gameShortcuts.clear();
  const ready = _shortcutStoreReady();
  for (const [rom, appid] of Object.entries<any>(r.shortcuts || {})) {
    const aid = Number(appid) >>> 0;
    if (ready && !_shortcutExists(aid)) {
      // Removed from Steam's side (the user deleted the shortcut there).
      try { await recordGameSteamShortcut(Number(rom), null); } catch { /* ignore */ }
      continue;
    }
    _gameShortcuts.set(Number(rom), aid);
  }
}

function _gameShortcutsLoaded(): Promise<void> {
  if (!_gameShortcutsLoad) {
    _gameShortcutsLoad = syncGameShortcuts().catch((e) => {
      console.error('[RomM] syncGameShortcuts', e);
      _gameShortcutsLoad = null;
    });
  }
  return _gameShortcutsLoad;
}

function startGameShortcutSync() {
  void _gameShortcutsLoaded();
  // At plugin load Steam's shortcut store can still be empty, which stops the
  // prune above from telling "deleted in Steam" from "not loaded yet". Look
  // again once it has had time to fill.
  _gameShortcutRetry = setTimeout(() => {
    _gameShortcutRetry = null;
    void syncGameShortcuts().catch(() => { });
  }, 15000);
  if (!_gameShortcutEventsOff) {
    // 'game' is published when a deleted game queues its shortcut's removal;
    // '*' means nudges may have been missed.
    const l = addEventListener<[string]>("ludo_changed", (topic) => {
      const t = String(topic);
      if (t === 'game' || t === '*') void syncGameShortcuts().catch(() => { });
    });
    _gameShortcutEventsOff = () => removeEventListener("ludo_changed", l);
  }
}

function stopGameShortcutSync() {
  try { _gameShortcutEventsOff?.(); } catch { /* ignore */ }
  _gameShortcutEventsOff = null;
  if (_gameShortcutRetry != null) { try { clearTimeout(_gameShortcutRetry); } catch { /* ignore */ } }
  _gameShortcutRetry = null;
}

// Steam asset types: 0 portrait capsule, 1 hero, 3/4 landscape capsule (see
// ensureRommArtwork for why the landscape is sent as both).
const GAME_ART_TYPES: [number, string][] = [[0, 'portrait'], [1, 'hero'], [3, 'landscape'], [4, 'landscape']];

function _gameArtPlan(art: Record<string, string>): [number, string][] {
  return GAME_ART_TYPES.filter(([, key]) => art[key]).map(([type, key]) => [type, art[key]]);
}

// Set custom artwork, as [asset type, base64] pairs. Every type is cleared
// before any is set: Steam won't overwrite an existing custom asset, so a
// repaint over stale art would otherwise silently no-op. Clearing all first
// matters because on current builds clearing type 4 deletes the landscape
// that setting type 3 just wrote.
async function setArtwork(apps: any, appid: number, plan: [number, string][], ext: string) {
  for (const [type] of plan) {
    try { await apps.ClearCustomArtworkForApp?.(appid, type); } catch { /* ignore */ }
  }
  for (const [type, b64] of plan) {
    try { await apps.SetCustomArtworkForApp(appid, b64, ext, type); } catch { /* ignore */ }
  }
}

async function addGameShortcut(romId: number): Promise<GameShortcutResult> {
  const apps = _sc()?.Apps;
  if (!apps?.AddShortcut) {
    return { ok: false, installed: false, message: 'Steam shortcuts are not available on this Steam build.' };
  }
  try {
    await _gameShortcutsLoaded();
    const exe = await rommShortcutExe();
    if (exe === ROMM_SHORTCUT_EXE) {
      return { ok: false, installed: false, message: "Ludo's launcher could not be found." };
    }
    let appid = _gameShortcuts.get(romId);
    if (appid == null || (_shortcutStoreReady() && !_shortcutExists(appid))) {
      appid = Number(await apps.AddShortcut(`Game ${romId}`, exe, "", "")) >>> 0;
      _gameShortcuts.set(romId, appid);
      // Named now, not after the cover fetch: AddShortcut's name does not
      // stick, and a shortcut still called "romm-session-host" when the plugin
      // reloads would look like a duplicate Ludo tile to cleanupRommShortcuts.
      try { await apps.SetShortcutName?.(appid, `Game ${romId}`); } catch { /* ignore */ }
      await recordGameSteamShortcut(romId, appid);
    }
    try { await apps.SetShortcutLaunchOptions?.(appid, `${GAME_SENTINEL}${romId}`); } catch { /* ignore */ }
    // The art call also names the game and writes its grid icon file.
    const info = await getGameSteamArt(romId, appid);
    if (info?.name) {
      try { await apps.SetShortcutName?.(appid, info.name); } catch { /* ignore */ }
    }
    const art = (info?.art || {}) as Record<string, string>;
    if (apps.SetCustomArtworkForApp) await setArtwork(apps, appid, _gameArtPlan(art), 'png');
    if (info?.icon_path) {
      try { await apps.SetShortcutIcon?.(appid, info.icon_path); } catch { /* ignore */ }
    }
    return { ok: true, installed: true };
  } catch (e) {
    console.error('[RomM] addGameShortcut', e);
    return { ok: false, installed: _gameShortcuts.has(romId), message: String(e) };
  }
}

async function removeGameShortcut(romId: number): Promise<GameShortcutResult> {
  try {
    await _gameShortcutsLoaded();
    const appid = _gameShortcuts.get(romId);
    if (appid != null && _shortcutExists(appid)) await _sc()?.Apps?.RemoveShortcut?.(appid);
    _gameShortcuts.delete(romId);
    await recordGameSteamShortcut(romId, null);
    return { ok: true, installed: false };
  } catch (e) {
    console.error('[RomM] removeGameShortcut', e);
    return { ok: false, installed: _gameShortcuts.has(romId), message: String(e) };
  }
}

// GameActionStart for one of our game shortcuts. True when handled.
function _interceptGameShortcut(appid: number, strAppId: string): boolean {
  const romId = _romForApp(appid);
  if (romId == null) return false;
  if (_gameLaunchPending === appid) {
    // Our own RunGame after the prep: let the host exec the emulator.
    _gameLaunchPending = null;
    return true;
  }
  // Started from Steam's library: no launch-spec yet. Cancel it and run Ludo's
  // launch, which comes back through launchTile(romId).
  try { _sc()?.Apps?.TerminateApp?.(strAppId, false); } catch { /* ignore */ }
  _gameLaunchTarget = { romId, appid, at: Date.now() };
  const name = _appName(appid) || 'Game';
  setTimeout(() => {
    try { _hooks?.launchGame(romId, name); } catch (e) { console.error('[RomM] launchGame', e); }
  }, 0);
  return true;
}

function _takeGameLaunchTarget(romId?: number): number | null {
  const t = _gameLaunchTarget;
  if (!t || romId == null || t.romId !== romId) return null;
  _gameLaunchTarget = null;
  if (Date.now() - t.at > GAME_LAUNCH_TARGET_TTL_MS) return null;
  return t.appid;
}

async function _runGameShortcut(appid: number): Promise<boolean> {
  _gameLaunchPending = appid;
  try {
    await _sc()?.Apps?.RunGame?.(_gid(appid), "", -1, 100);
    return true;
  } catch (e) {
    _gameLaunchPending = null;
    console.error('[RomM] RunGame game shortcut', e);
    return false;
  }
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
    registerRommWindowGoneWatch();
    startGameShortcutSync();
  },

  stop() {
    try { _rommActionReg?.unregister(); } catch { /* ignore */ }
    _rommActionReg = null;
    try { _rommLifetimeReg?.unregister(); } catch { /* ignore */ }
    _rommLifetimeReg = null;
    try { _rommFocusReg?.unregister(); } catch { /* ignore */ }
    _rommFocusReg = null;
    if (_rommNavTimer != null) { try { clearTimeout(_rommNavTimer); } catch { /* ignore */ } }
    _rommNavTimer = null;
    stopGameShortcutSync();
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

  async launchTile(romId?: number): Promise<boolean> {
    const target = _takeGameLaunchTarget(romId);
    if (target != null) return _runGameShortcut(target);
    if (_rommAppId == null) return false;
    _rommLaunchPending = true;
    _rommWindowGone = false;
    _rommWindowSeen = false;
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

  sessionRunning: () => _sessionRunning(),

  resumeSession(): boolean {
    if (!_sessionRunning()) return false;
    try {
      // The same call Steam's own "Resume" makes: route the main window to the
      // running app, which gamescope follows by focusing its window. Measured
      // on a Deck: focus moves from Steam (769) back to the tile's app id.
      (window as any).SteamUIStore.NavigateToRunningApp(true);
      return true;
    } catch (e) {
      console.error('[RomM] resumeSession', e);
      return false;
    }
  },

  async hasGameShortcut(romId: number): Promise<boolean> {
    await _gameShortcutsLoaded();
    const aid = _gameShortcuts.get(romId);
    return aid != null && (!_shortcutStoreReady() || _shortcutExists(aid));
  },

  setGameShortcut: (romId: number, enabled: boolean) =>
    (enabled ? addGameShortcut(romId) : removeGameShortcut(romId)),
};

// Our session flag alone can outlive the game (a lifetime notification Steam
// never sent), so it also has to be one of Steam's running apps.
function _sessionRunning(): boolean {
  if (!_rommSessionActive || _rommWindowGone || _rommAppId == null) return false;
  try {
    const apps: any[] = (window as any).SteamUIStore?.RunningApps ?? [];
    return apps.some((a) => Number(a?.appid) === _rommAppId);
  } catch {
    return false;
  }
}
