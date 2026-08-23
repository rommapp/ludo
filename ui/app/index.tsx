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
import { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import {
  FaSync,
  FaTrash,
  FaCog,
  FaGamepad,
  FaBookmark,
  FaHome,
  FaSearch,
  FaDownload,
  FaPlay,
  FaRegClock,
  FaLayerGroup,
  FaChevronRight,
  FaExternalLinkAlt,
  FaPuzzlePiece,
  FaCheck,
  FaEllipsisH,
  FaChevronDown,
  FaChartBar,
  FaExclamationTriangle,
  FaPowerOff,
  FaCloudUploadAlt,
  FaMicrochip,
} from "react-icons/fa";
import {
  ackLibraryAnnouncement,
  checkForUpdate,
  checkLibraryStale,
  deleteCollectionRoms,
  drainNotifications,
  emulatorInstallState,
  getAccountUsername,
  getAvatar,
  getCheckOnStartup,
  getConfig,
  getDownloadProgress,
  getEmulatorStatus,
  getHomeData,
  getImage,
  getLibraryGames,
  getLibraryGroups,
  getPlatformSync,
  getResumeStateEnabled,
  getRetrodeckButtonEnabled,
  getRetrodeckLogo,
  getServiceStatus,
  getStateThumbnails,
  getSyncIndicator,
  getUpdateChannel,
  installEmulator,
  notifyNetworkState,
  refreshFromRomm,
  repairEmulatorPaths,
  searchGames,
  setPlatformSync,
  toggleCollectionSync,
} from "./rpc";
import { V2, formatEta, formatSpeed } from "./theme";
import { LibGroup, LibGame } from "./types";
import { _lsAvail, _LS_REOPEN_HOME } from "./storage";
import { _libRefreshListeners, _broadcastLibRefresh, _downloadedListeners } from "./events";
import { _LS_PLATICON, _coverInflight } from "./media";
import { setPreDownloadHook } from "./downloads";
import { V2_FOCUS_STYLE, v2Page } from "./focus";
import { NavId, LibView, navExitPlugin, libNavigate, libBack, RouteGuard } from "./nav";
import { setLibViewHooks, pushLibView } from "./nav";
import { StatsPage } from "./pages/stats";
import { DownloadsPage } from "./pages/downloads";
import { CoresPage } from "./pages/cores";
import { ConfigPage } from "./pages/config";
import { SetupWizard } from "./pages/setup";
import { SettingsPage } from "./pages/settings";
import { BiosPage, BiosDetailModal} from "./pages/bios";
import { PlatformsPage } from "./pages/platforms";
import { maybePromptSwitchFirmware } from "./firmware";
import { GameDetailPage } from "./pages/game";
import { GameTile, CollectionTile, PlatformTile, CardRow } from "./tiles";
import { runLaunch, lastLaunchedRomId} from "./launch";
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
  persistGroupsCache,
  persistHomeCache,
  getHomeCache,
  getLibGroupHolder,
  getLibGroupsHolder,
  getLibLastTab,
  setHomeCache,
  setLibGameHolder,
  setLibGameOrigin,
  setLibGroupHolder,
  setLibGroupsHolder,
  setLibLastTab,
  libCacheSet,
} from "./libcache";
import {
  _subscribeStatus,
  refreshStatusNow,
  useOffline,
  useServiceStatus,
  useDownloadGlimpse,
  SaveActivity,
  _pushSaveActivity,
  useSaveActivity,
} from "./status";
import {
  useEtaFromPct,
  ProgressRing,
  PlatformIcon,
  UserMenuRow,
  Bumper,
  GameActionButton,
  V2SearchField,
  V2SettingsRow,
  V2Switch,
  _gameLabel,
  useRowHighlight,
} from "./kit";
import {
  _forceGamepadFocus,
  _gpFocusEl,
  _summonVirtualKeyboard,
  _dismissVirtualKeyboard,
  _autoFocusFirstRef,
  useAutoFocus,
  playSteamSound,
} from "./shell";
import {
  _dlActive,
  _dlQueue,
  _dlSucceeded,
  _dlListeners,
  _setDlActive,
  _batchJobs,
  useBatchJob,
  runCollectionBatch,
} from "./downloads";
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



// What a refresh actually did, for the completion toast. The backend already
// phrases the counts ("12 added, 1 removed"); this only supplies the wording for
// the quiet case, which is by far the common one.
//
// "Up to date." used to be shown unconditionally, which is the message that
// makes a refresh that silently found nothing indistinguishable from one that
// worked — the same reason argosy-launcher reports added/updated/removed rather
// than a bare success.
function _refreshSummary(res: any): string {
  const r = res?.reconciled;
  if (r && (r.added || r.removed || r.updated)) return res.message || 'Library updated.';
  return 'No changes — your library matches RomM.';
}







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

// Every stale path now earns a Home banner. That was once saves-only, on the
// grounds that only saves fail silently — but staleness itself was then loose
// enough to flag a ROM folder that worked fine, and interrupting for a
// non-problem is what the restraint was really guarding against. With that false
// positive gone (see stale_emulator_paths), the survivors all genuinely break
// the app: saves lose progress, BIOS blocks the games that need it, and a dead
// executable override stops launching altogether.
// Headline and detail per kind, worst first. Saves lead when several are broken:
// it's the only one that loses data you can't recreate.
const _STALE_RANK: Record<string, number> = { saves: 0, exe: 1, bios: 2, roms: 3 };

function staleCopy(stale: EmuStalePath[]): { title: string; body: string } {
  const worst = [...stale].sort(
    (a, b) => (_STALE_RANK[a.kind] ?? 9) - (_STALE_RANK[b.kind] ?? 9))[0];
  const rest = stale.length < 2 ? ''
    : stale.length === 2 ? ' One other folder needs the same fix.'
      : ` ${stale.length - 1} other folders need the same fix.`;
  // Both emulators installed, folders pointing at the one we don't launch. The
  // 'removed' copy below is a plain falsehood here — nothing was uninstalled,
  // and a user who reads "an emulator that was removed" while both are in their
  // library will distrust the banner rather than tap it. Naming the two is also
  // the whole explanation: it's the only version of this that tells someone why
  // a BIOS they can see in one folder isn't found by the game.
  if (worst?.cause === 'other_install') {
    const owner = worst.owner || 'another emulator';
    const active = worst.active || 'your emulator';
    const both = stale.length > 1
      && stale.every((p) => p.cause === 'other_install');
    if (both) {
      return { title: `Your folders point at ${owner}, but games run on ${active}`,
        body: `Saves and BIOS files are going to ${owner}’s folders, so `
          + `${active} never sees them — games that need a BIOS will not start, `
          + 'and your saves are being written where nothing reads them.' };
    }
    return worst.kind === 'bios'
      ? { title: `${active} cannot see your BIOS files`,
        body: `Your BIOS folder points at ${owner}, but games run on ${active}. `
          + `The files are downloaded — ${active} just looks somewhere else, so `
          + 'the games that need them will not start.' + rest }
      : { title: `Your saves are going to ${owner}`,
        body: `Games run on ${active}, so it writes its saves elsewhere and `
          + 'nothing here is syncing the ones you actually make.' + rest };
  }
  switch (worst?.kind) {
    case 'saves':
      return { title: 'Saves are going to the wrong place',
        body: 'Your save folder still points into an emulator that was removed. '
          + 'Saves are being written where nothing will read them.' + rest };
    case 'bios':
      return { title: 'BIOS files are going to the wrong place',
        body: 'Your BIOS folder still points into an emulator that was removed, so '
          + 'games that need a BIOS will not start.' + rest };
    case 'exe':
      return { title: 'Your emulator path is broken',
        body: 'Ludo is set to launch an emulator that is no longer there, so nothing '
          + 'will start until this is cleared.' + rest };
    default:
      return { title: 'A folder points at a removed emulator',
        body: 'One of your folders belongs to an emulator that is gone.' + rest };
  }
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




// RomM AppNav — fixed glass top bar: logo (left) · centered tab pill
// (Home/Platforms/Collections/Search) · right cluster. Geometry is grid
// 1fr/auto/1fr so the pill stays viewport-centered (AppNav.vue). The tab
// pill is RSliderBtnGroup's "tab" variant: surface bg + strong border, pill
// radius, and the ACTIVE tab is a solid white (--r-color-fg) pill with dark
// (--r-color-bg) text.
// Compact labeled pill for the top bar's optional "Launch RetroDECK" action.
// Sits beside the 32px brand mark: app icon + short label so the action reads
// clearly (vs. a bare glyph). Fully controller-focusable.
function NavLaunchButton({ iconSrc, label, onActivate }:
  { iconSrc: string | null; label?: string; onActivate: () => void }) {
  const [active, setActive] = useState(false);
  return (
    <Focusable noFocusRing
      onActivate={onActivate} onClick={onActivate}
      onFocus={() => setActive(true)} onBlur={() => setActive(false)}
      onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '7px',
        height: '34px', padding: iconSrc ? '0 7px 0 5px' : '0 10px',
        borderRadius: V2.radiusPill, cursor: 'pointer',
        background: active ? 'rgba(255,255,255,0.10)' : V2.surface,
        color: active ? V2.fg : V2.fg2,
        fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap',
        border: `1px solid ${active ? V2.brand : V2.borderStrong}`,
        boxShadow: active ? `0 0 0 1px ${V2.brand}` : 'none',
        transition: 'background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.15s',
      }}
    >
      {iconSrc
        ? <img src={iconSrc} style={{ width: '26px', height: '26px', display: 'block', flexShrink: 0, borderRadius: '50%' }} />
        : <FaExternalLinkAlt size={13} style={{ marginLeft: '3px' }} />}
      <FaPlay size={11} style={{ flexShrink: 0 }} />
      {label && <span>{label}</span>}
    </Focusable>
  );
}


// Remembered account identity (username / role / avatar data URI), mirrored to
// localStorage the same way the browse caches are. The identity is the same on
// every launch, so serving last session's copy paints the real pill on the first
// frame instead of a placeholder; the fetch below still runs and overwrites it, so
// a renamed account or a new avatar corrects itself as soon as the answer lands.
// No TTL — a revalidation happens every launch by construction. Cleared on logout
// (see handleLogout) so the next user never sees the previous one's pill.
type NavIdentity = { username: string; role: string; avatar: string | null };
const _LS_IDENTITY = 'romm:identity:v1';
function readIdentity(): NavIdentity | null {
  if (!_lsAvail) return null;
  try {
    const o = JSON.parse(localStorage.getItem(_LS_IDENTITY) || 'null');
    if (o && typeof o.username === 'string' && o.username)
      return { username: o.username, role: typeof o.role === 'string' ? o.role : '', avatar: o.avatar || null };
  } catch { }
  return null;
}
function writeIdentity(id: NavIdentity) {
  if (!_lsAvail) return;
  // An avatar is a data URI; a huge one would blow the quota and take the browse
  // caches down with it, so skip persisting anything oversized (the pill just
  // falls back to the initial for one frame, then the fetched image lands).
  const avatar = id.avatar && id.avatar.length < 512 * 1024 ? id.avatar : null;
  try { localStorage.setItem(_LS_IDENTITY, JSON.stringify({ ...id, avatar })); } catch { }
}
// Not exported: this is the plugin's rollup ENTRY, and decky's config declares
// output.exports "default". A second named export off the entry fails the whole
// bundle ("default" was specified … has the following exports: clearIdentityCache
// and default), which is why the Decky zip stopped building. Both callers are in
// this file, so the keyword bought nothing.
export function clearIdentityCache() {
  if (!_lsAvail) return;
  try { localStorage.removeItem(_LS_IDENTITY); } catch { }
}

// Everything the top-bar chrome needs (brand marks, account identity, RetroDECK
// launch button state). Lifted into a hook so the owning page (LibraryGroupsPage)
// can drive both the V2NavBar rendering AND the controller shortcuts / footer
// hints from one fetch, instead of the nav bar owning state the page can't reach.
export type NavChrome = {
  iso: string | null; word: string | null;
  username: string; role: string; avatar: string | null;
  rdEnabled: boolean; rdIcon: string | null;
};
function useNavChrome(): NavChrome {
  const [iso, setIso] = useState<string | null>(null);
  const [word, setWord] = useState<string | null>(null);
  // Last session's identity if we have one, else empty — NOT 'Guest': the fetch
  // answers a beat after first paint, and seeding the real default made every
  // cold launch flash "Guest" + a "G" avatar before snapping to the actual
  // account. While empty the pill renders a neutral placeholder, and 'Guest' is
  // only set once we know there's no account to show.
  const cached = useRef(readIdentity()).current;
  const [username, setUsername] = useState<string>(cached?.username || '');
  const [role, setRole] = useState<string>(cached?.role || '');
  const [avatar, setAvatar] = useState<string | null>(cached?.avatar || null);
  const [rdEnabled, setRdEnabled] = useState<boolean>(false);
  const [rdIcon, setRdIcon] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // The fetched values are authoritative over the cached seed above, and
    // whatever they resolve to becomes next launch's seed. `fresh` starts from
    // the cache so a failed leg keeps the remembered value rather than
    // persisting a blank over a good one.
    const fresh: NavIdentity = {
      username: cached?.username || '', role: cached?.role || '', avatar: cached?.avatar || null,
    };
    // Identity runs as its own chain, started in the same tick as the brand /
    // RetroDECK art rather than after it. These were one serial await chain, so
    // the account pill sat on its placeholder for five round-trips (two SVGs +
    // the RetroDECK flag + its logo) before the username fetch even began.
    const identity = (async () => {
      // `connected` distinguishes "signed out" from "the backend hasn't
      // finished connecting yet" — see get_account_username. Only the former
      // may paint 'Guest' or invalidate the cache.
      // Retried because "not connected yet" is transient: auto-connect's login
      // round-trip routinely finishes after first paint, and without this the
      // pill would hold the cached seed (or the placeholder) until something
      // remounted it. ~30s of patience, then we stop asking.
      let known = false;
      for (let attempt = 0; alive && !known && attempt < 20; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 1500));
        try {
          const acc = await getAccountUsername();
          if (!acc?.connected) continue;
          known = true;
          fresh.username = acc?.username || 'Guest';
          fresh.role = acc?.role || '';
          if (alive) { setUsername(fresh.username); setRole(fresh.role); }
        } catch { if (alive && !fresh.username) setUsername('Guest'); }
      }
      if (!alive) return;
      // Avatar fetched raw by the backend (get_avatar) — keeps transparency and
      // logs a wrong path/404 instead of silently showing the initial fallback.
      // Skipped when we never reached the account: a null here would blank a
      // perfectly good cached avatar on a slow connect.
      if (known) {
        try {
          const av = await getAvatar();
          fresh.avatar = av?.data_uri || null;
          if (alive) setAvatar(fresh.avatar);
        } catch { }
      }
      // Only remember a real identity: 'Guest' means signed out, and caching it
      // would paint "Guest" on the next launch before the fetch corrects it —
      // exactly the flash this cache exists to remove.
      if (known && fresh.username && fresh.username !== 'Guest') writeIdentity(fresh);
      else if (known) clearIdentityCache();
    })();
    const chrome = (async () => {
      try { const a = await getImage('/assets/isotipo.svg'); if (alive) setIso(a?.data_uri || null); } catch { }
      try { const b = await getImage('/assets/logotipo.svg'); if (alive) setWord(b?.data_uri || null); } catch { }
      await readRd();
    })();
    void Promise.all([identity, chrome]);
    // Settings can flip the toggle while this page is still mounted, and the
    // fetch above only runs once — without this the button (or its removal)
    // waited for the next launch. Same window-event pattern as 'romm:toastpos'.
    const onRdChange = () => { void readRd(); };
    try { window.addEventListener('romm:rdbutton', onRdChange); } catch { /* ignore */ }
    return () => {
      alive = false;
      try { window.removeEventListener('romm:rdbutton', onRdChange); } catch { /* ignore */ }
    };

    // Declared last (hoisted) so the two chains above read top-to-bottom.
    // The logo is fetched the first time the button turns on and kept after —
    // re-enabling shouldn't cost another round-trip, and a stale icon behind a
    // hidden button is harmless.
    async function readRd() {
      try {
        const on = await getRetrodeckButtonEnabled();
        if (!alive) return;
        setRdEnabled(!!on);
        if (on) {
          const r = await getRetrodeckLogo();
          if (alive) setRdIcon(r?.data_uri || null);
        }
      } catch { /* leave whatever we last knew */ }
    }
  }, []);
  return { iso, word, username, role, avatar, rdEnabled, rdIcon };
}

function V2NavBar({ active, onTab, activeRef, chrome, onLaunchRd }:
  { active: NavId; onTab: (id: NavId) => void; activeRef?: React.MutableRefObject<any>;
    chrome: NavChrome; onLaunchRd: () => void }) {
  const { iso, word, username, role, avatar, rdEnabled, rdIcon } = chrome;
  const wideBar = useWideTopBar();
  const tabs: { id: NavId; label: string; Icon: any }[] = [
    { id: 'home', label: 'Home', Icon: FaHome },
    { id: 'platforms', label: 'Platforms', Icon: FaGamepad },
    { id: 'collections', label: 'Collections', Icon: FaBookmark },
    { id: 'search', label: 'Search', Icon: FaSearch },
  ];

  // Sliding active indicator (RSliderBtnGroup): one white pill whose left/width
  // animates between the active tab's measured position, instead of toggling a
  // background per button.
  const btnRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);
  const [shown, setShown] = useState(false); // drives the first-load grow/fade-in
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);
  const activeIdx = tabs.findIndex((t) => t.id === active);
  // Drop any lingering focus tint when the active tab changes: on an LB/RB
  // switch the old panel's unmount can leave focusedIdx pointing at the
  // previous tab (its blur never fires), which kept that tab looking
  // highlighted. A genuinely focused pill re-tints via its own onFocus.
  useEffect(() => { setFocusedIdx(null); }, [active]);
  useEffect(() => {
    const el = btnRefs.current[activeIdx];
    if (el) {
      setInd({ left: el.offsetLeft, width: el.offsetWidth });
      // Next frame: flip from the collapsed/transparent initial state to full so
      // the indicator animates into place on first paint.
      requestAnimationFrame(() => setShown(true));
    }
  }, [activeIdx]);

  return (
    // Horizontal-flow Focusable so the three clusters (RetroDECK launch · nav
    // tabs · user pill) navigate with LEFT/RIGHT. Without this the row is a plain
    // div inside the page's vertical-flow Focusable, so Steam stacked the three
    // as a vertical list and you had to press UP/DOWN to reach the side clusters.
    <Focusable noFocusRing flow-children="horizontal" style={{
      position: 'sticky', top: 0, zIndex: 50, height: '58px',
      display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center',
      padding: '0 20px', background: 'rgba(7,7,15,0.78)',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      borderBottom: `1px solid ${V2.border}`,
    }}>
      {/* Left cluster: brand mark + wordmark. When the RetroDECK launch button
          is enabled, the wordmark gives way to the button so the left column
          stays compact on small (Deck) screens — mark + button, never both
          the wordmark and the button. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        {iso && <img src={iso} style={{ width: '32px', height: '32px', display: 'block' }} />}
        {rdEnabled
          ? <NavLaunchButton iconSrc={rdIcon} onActivate={onLaunchRd} />
          : (word && <img src={word} style={{ height: '22px', width: 'auto', display: 'block' }} />)}
      </div>
      <div style={{ justifySelf: 'center', display: 'flex', alignItems: 'center', gap: '10px' }}>
        <Bumper label="L1" />
        {/* shim-topnav marks the tabs pill so the desktop gamepad shim, when an
            Up move enters the sticky top bar, always lands INSIDE this pill (the
            column-nearest tab) rather than on the side clusters — matching the
            Deck, where Up into the nav always lands on a nav tab. Harmless on the
            Deck (just an extra class). */}
        <Focusable noFocusRing className="shim-topnav" flow-children="horizontal" style={{
          position: 'relative', display: 'flex', gap: '2px', padding: '4px',
          background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusPill,
        }}>
          {/* Sliding indicator */}
          {ind && (
            <div style={{
              position: 'absolute', top: '4px', bottom: '4px',
              left: `${ind.left}px`, width: `${ind.width}px`,
              background: V2.fg, borderRadius: V2.radiusPill, zIndex: 0,
              opacity: shown ? 1 : 0,
              transform: shown ? 'scaleX(1)' : 'scaleX(0.6)', transformOrigin: 'center',
              transition: 'left 0.28s cubic-bezier(0.22,1,0.36,1), width 0.28s cubic-bezier(0.22,1,0.36,1), opacity 0.28s ease, transform 0.28s cubic-bezier(0.22,1,0.36,1)',
            }} />
          )}
          {tabs.map(({ id, label, Icon }, i) => {
            const on = active === id;
            return (
              <Focusable noFocusRing key={id} ref={on && activeRef ? activeRef : undefined}
                className={on ? 'shim-navtab-active' : undefined}
                onActivate={() => onTab(id)} onClick={() => onTab(id)}
                onFocus={() => setFocusedIdx(i)} onBlur={() => setFocusedIdx(null)}
                onMouseEnter={() => setFocusedIdx(i)} onMouseLeave={() => setFocusedIdx(null)}>
                <div ref={(el) => { btnRefs.current[i] = el; }}
                  style={{
                    position: 'relative', zIndex: 1,
                    display: 'flex', alignItems: 'center', gap: '7px', padding: '7px 18px',
                    borderRadius: V2.radiusPill, fontSize: '13.5px', cursor: 'pointer',
                    fontWeight: on ? 600 : 500, color: on ? V2.bg : V2.fg2,
                    // Focus affordance is the brand ring, shown whenever a pill is
                    // focused — including the ALREADY-ACTIVE one, so the controller
                    // highlight is visible on the selected tab (it rides on top of
                    // the white sliding indicator). Inactive pills also get a tint;
                    // the active pill's white indicator is tint enough on its own.
                    background: (!on && focusedIdx === i) ? 'rgba(255,255,255,0.10)' : 'transparent',
                    boxShadow: (focusedIdx === i) ? `inset 0 0 0 1.5px ${V2.brand}` : 'none',
                    transition: 'color 0.2s ease, background 0.15s ease, box-shadow 0.15s ease',
                  }}>
                  <Icon size={12} /><span>{label}</span>
                </div>
              </Focusable>
            );
          })}
        </Focusable>
        <Bumper label="R1" />
      </div>
      {/* User pill — RomM AppShell/UserMenu.vue's .r-v2-user, copied 1:1:
          avatar(30) + username + chevron, pill radius, surface bg + strong
          border, tight 3px padding on the avatar side. Opens the account menu
          (Stats / Settings for now). */}
      <div style={{ justifySelf: 'end', display: 'flex', alignItems: 'center', gap: '8px' }}>
        {/* Wide top bars get a dedicated download chip; on the Deck the same
            glimpse collapses onto the user pill's avatar (no extra width). */}
        <NavDownloadGlimpse />
        <UserPill username={username} role={role} avatar={avatar} glimpse={!wideBar} />
      </div>
    </Focusable>
  );
}

// Renders the chip only when wide AND something is downloading — kept as its
// own component so the glimpse polling doesn't re-render the whole nav bar.
function NavDownloadGlimpse() {
  const wide = useWideTopBar();
  const dl = useDownloadGlimpse();
  if (!wide || dl.count === 0) return null;
  return <DownloadChip count={dl.count} pct={dl.pct} />;
}

// Circular avatar — real RomM avatar when uploaded, else the RAvatar fallback
// (surface circle with the user's initial). Shared by the pill and the menu.
function UserAvatar({ username, avatar, size }: { username: string; avatar: string | null; size: number }) {
  return (
    <div style={{
      width: `${size}px`, height: `${size}px`, borderRadius: '50%', flexShrink: 0,
      background: V2.bgElevated, border: `1px solid ${V2.borderStrong}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: `${Math.round(size * 0.43)}px`, fontWeight: 700, color: V2.fg2, overflow: 'hidden',
    }}>
      {/* No initial while the username is still unknown — an empty circle reads
          as "loading", a letter reads as a real (wrong) account. */}
      {avatar
        ? <img src={avatar} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : username.slice(0, 1).toUpperCase()}
    </div>
  );
}






// RomM UserMenu, rebuilt in the v2 design language (matches RestoreModal's
// chrome): a glass panel anchored top-right (RomM's location="bottom end"),
// with the identity header card over Stats / Settings / Log out.
function UserMenuModal({ username, role, avatar, closeModal }:
  { username: string; role: string; avatar: string | null; closeModal?: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60); return () => clearTimeout(t); }, []);
  const [refreshing, setRefreshing] = useState(false);
  // Live count badge for the Downloads row (registry + collection auto-sync).
  const dlGlimpse = useDownloadGlimpse();

  // In-library view when the library route hosts us (keeps the tabs tree
  // mounted underneath), real navigation otherwise.
  const go = (route: string) => { closeModal?.(); libNavigate(route); };
  const doRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await refreshFromRomm(false); // incremental
      if (res?.success) {
        toaster.toast({ title: 'Library refreshed', body: _refreshSummary(res) });
        // A manual refresh IS the update the stale banner was offering, so it
        // dismisses it — otherwise the banner survives the very thing that
        // resolved it and reads as a failure.
        _clearStale();
        _broadcastLibRefresh();
      } else if (res?.busy) {
        // Not a failure — a fetch is already doing exactly what was asked.
        toaster.toast({ title: 'Already refreshing', body: 'A library fetch is in progress.' });
      } else {
        toaster.toast({ title: 'Refresh failed', body: res?.message ?? 'Unknown error' });
      }
    } catch (e) {
      toaster.toast({ title: 'Refresh failed', body: String(e) });
    } finally {
      setRefreshing(false);
    }
  };
  // Only a shell that owns its own process can be exited from in-app; inside a
  // plugin host, quitting would mean closing someone else's application. Logout
  // lives in Settings.
  const canExit = host.capabilities.exit;
  // Quit is one keypress away from killing a session, so it arms on the first
  // activate and only exits on the second (same arm → confirm shape as
  // CollectionActionsModal's "Remove downloaded"), disarming after 4s.
  const [quitArmed, setQuitArmed] = useState(false);
  useEffect(() => { if (!quitArmed) return; const t = setTimeout(() => setQuitArmed(false), 4000); return () => clearTimeout(t); }, [quitArmed]);
  const doQuit = () => {
    if (!quitArmed) { setQuitArmed(true); return; }
    setQuitArmed(false);
    closeModal?.();
    host.app.quit();
  };

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
        {/* Click-away scrim */}
        <div onClick={() => closeModal?.()} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          position: 'relative', width: '260px', maxWidth: '90vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          {/* Identity header card — RomM UserMenu __header. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 8px 12px', minWidth: 0 }}>
            <UserAvatar username={username} avatar={avatar} size={34} />
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontSize: '13px', fontWeight: 700, color: V2.fg, lineHeight: 1.3,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{username}</div>
              {role && <div style={{
                fontSize: '10.5px', fontWeight: 600, textTransform: 'capitalize',
                color: V2.fgMuted, marginTop: '2px', whiteSpace: 'nowrap',
              }}>{role}</div>}
            </div>
          </div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />
          <UserMenuRow icon={<FaChartBar size={15} />} label="Stats" onSelect={() => go("/romm-sync-stats")} />
          <UserMenuRow icon={<FaPuzzlePiece size={15} />} label="Emulator Cores" onSelect={() => go("/romm-sync-cores")} />
          <UserMenuRow icon={<FaMicrochip size={15} />} label="Firmware / BIOS" onSelect={() => go("/romm-sync-bios")} />
          <UserMenuRow icon={<FaCog size={15} />} label="Settings" onSelect={() => go("/romm-sync-settings")} />
          <UserMenuRow
            icon={<FaSync size={15} style={refreshing ? { animation: 'spin 1s linear infinite' } : undefined} />}
            label={refreshing ? 'Refreshing…' : 'Refresh library'} disabled={refreshing} onSelect={doRefresh} />
          <UserMenuRow icon={<FaDownload size={15} />}
            label={`Downloads${dlGlimpse.count > 0 ? ` (${dlGlimpse.count})` : ''}`}
            onSelect={() => go("/romm-sync-downloads")} />
          {canExit && (
            <>
              <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
              <UserMenuRow icon={quitArmed ? <FaCheck size={15} /> : <FaPowerOff size={15} />}
                label={quitArmed ? 'Confirm quit' : 'Quit'} danger armed={quitArmed} onSelect={doQuit} />
            </>
          )}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}








// Collection / platform actions menu, in the same v2 glass chrome as the
// account dropdown (UserMenuModal). Opened from the games-count rail. Holds
// "Sync/Download missing" and the destructive "Remove downloaded" (arm →
// confirm, matching the game-tile delete affordance).
function CollectionActionsModal({ title, isCollection, isVirtual, isSynced, missing, downloaded, syncing, platformSlug, onSyncMissing, onToggleSync, onRemove, closeModal }:
  {
    title: string; isCollection: boolean; isVirtual: boolean; isSynced: boolean;
    missing: number; downloaded: number; syncing: boolean; platformSlug?: string;
    onSyncMissing: () => void; onToggleSync: () => void; onRemove: () => void; closeModal?: () => void;
  }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => { const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60); return () => clearTimeout(t); }, []);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 4000); return () => clearTimeout(t); }, [armed]);

  const syncDisabled = syncing || missing === 0;
  const removeDisabled = downloaded === 0;
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
          position: 'relative', width: '270px', maxWidth: '90vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          {/* Header — collection/platform name. */}
          <div style={{
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
            color: V2.fgMuted, padding: '6px 8px 10px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{title}</div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />
          <UserMenuRow
            icon={syncing ? <FaSync size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <FaDownload size={14} />}
            label={`Download missing${missing ? ` (${missing})` : ''}`}
            disabled={syncDisabled}
            onSelect={() => { if (syncDisabled) return; closeModal?.(); onSyncMissing(); }} />
          <UserMenuRow icon={<FaRegClock size={14} />} label="View downloads"
            onSelect={() => { closeModal?.(); libNavigate("/romm-sync-downloads"); }} />
          {/* Platforms only — BIOS is a property of the platform, and a
              collection spans several. Opens this platform's panel in place
              rather than navigating: the answer is three lines long, and the
              user is mid-browse in the grid underneath. */}
          {platformSlug && (
            <UserMenuRow icon={<FaMicrochip size={14} />} label="Firmware / BIOS"
              onSelect={() => {
                closeModal?.();
                showModal(<BiosDetailModal slug={platformSlug} platformName={title} />);
              }} />
          )}
          {/* Auto-sync toggle — collections only (platforms have no continuous
              sync). Virtual collections sync too, keyed by their base64 id. */}
          {isCollection && (
            <UserMenuRow
              icon={<FaSync size={14} />}
              label={isSynced ? 'Disable auto-sync' : 'Enable auto-sync'}
              onSelect={() => { closeModal?.(); onToggleSync(); }} />
          )}
          {!isVirtual && (
            <>
              <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
              <UserMenuRow
                icon={armed ? <FaCheck size={14} /> : <FaTrash size={14} />}
                label={armed ? 'Confirm remove' : `Remove downloaded${downloaded ? ` (${downloaded})` : ''}`}
                danger disabled={removeDisabled}
                onSelect={() => {
                  if (removeDisabled) return;
                  if (!armed) { setArmed(true); return; }
                  setArmed(false); closeModal?.(); onRemove();
                }} />
            </>
          )}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}


// The focused platform tile's actions menu, published so the library page's Y
// handler can reach it. Y opens the account menu everywhere EXCEPT a focused
// platform tile, where the platform's own menu is the more useful thing and the
// account menu is still one press away on ☰ Start. A module-level handle rather
// than prop drilling: the handler lives on the page root, five components above
// the tile, and only ever wants whichever tile is focused right now.
export let _focusedPlatform: { label: string; open: () => void } | null = null;
const _focusedPlatformSubs = new Set<(p: typeof _focusedPlatform) => void>();
export function _setFocusedPlatform(p: typeof _focusedPlatform) {
  _focusedPlatform = p;
  _focusedPlatformSubs.forEach((fn) => { try { fn(p); } catch { /* ignore */ } });
}
function useFocusedPlatform() {
  const [p, setP] = useState(_focusedPlatform);
  useEffect(() => {
    const fn = (v: typeof _focusedPlatform) => setP(v);
    _focusedPlatformSubs.add(fn);
    setP(_focusedPlatform);
    return () => { _focusedPlatformSubs.delete(fn); };
  }, []);
  return p;
}

// True on viewports with top-bar room to spare (external monitor / desktop Big
// Picture). The Deck's 1280×800 stays false — there the download glimpse must
// not add width, so it lives on the avatar instead of a separate chip.
function useWideTopBar(): boolean {
  const [wide, setWide] = useState(() => {
    try { return window.matchMedia('(min-width: 1440px)').matches; } catch { return false; }
  });
  useEffect(() => {
    try {
      const mq = window.matchMedia('(min-width: 1440px)');
      const l = (e: any) => setWide(e.matches);
      mq.addEventListener('change', l);
      return () => mq.removeEventListener('change', l);
    } catch { /* ignore */ }
    // Explicit: with no matchMedia there is nothing to tear down. React
    // treats a missing return the same way, but noImplicitReturns wants the
    // two paths to agree.
    return undefined;
  }, []);
  return wide;
}

// Wide-viewport download glimpse: a dedicated pill next to the user pill with a
// progress ring, active count and aggregate percent. Opens the Downloads page.
// Only rendered while something is downloading (and only on wide top bars).
function DownloadChip({ count, pct }: { count: number; pct: number | null }) {
  const [active, setActive] = useState(false);
  const open = () => libNavigate("/romm-sync-downloads");
  return (
    <Focusable noFocusRing onActivate={open} onClick={open}
      onFocus={() => setActive(true)} onBlur={() => setActive(false)}
      onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '7px',
        background: active ? 'rgba(255,255,255,0.10)' : V2.surface,
        border: `1px solid ${active ? V2.brand : V2.borderStrong}`,
        boxShadow: active ? `0 0 0 1px ${V2.brand}` : 'none',
        borderRadius: V2.radiusPill, padding: '3px 12px 3px 5px',
        color: V2.fg, cursor: 'pointer', transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
      }}>
      <ProgressRing pct={pct} size={26} stroke={2.5}>
        <FaDownload size={10} style={{ color: V2.fg2 }} />
      </ProgressRing>
      <span style={{ fontSize: '12.5px', fontWeight: 600, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {count}{pct != null ? ` · ${Math.round(pct)}%` : ''}
      </span>
    </Focusable>
  );
}

// The account menu pill. Click/A opens the RomM-styled account dropdown.
// `glimpse` false suppresses the avatar download ring (a separate DownloadChip
// is showing it instead on wide top bars).
function UserPill({ username, role, avatar, glimpse = true }:
  { username: string; role: string; avatar: string | null; glimpse?: boolean }) {
  const [active, setActive] = useState(false);
  // Download glimpse: while anything is downloading, the avatar gains an
  // aggregate progress ring + count dot — zero extra top-bar width (the Deck's
  // bar is too tight for a separate chip).
  const dlRaw = useDownloadGlimpse();
  const dl = glimpse ? dlRaw : { count: 0, pct: null };
  const openMenu = () => showModal(
    <UserMenuModal username={username} role={role} avatar={avatar} />,
  );
  return (
    <Focusable noFocusRing onActivate={openMenu} onClick={openMenu}
      onFocus={() => setActive(true)} onBlur={() => setActive(false)}
      onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '8px',
        // Verified on-device: the old white tint was indistinguishable from the
        // resting surface on the Deck panel, so focus landing here (UP from the
        // first grid row) read as "selection disappeared". Brand ring instead.
        background: active ? 'rgba(255,255,255,0.10)' : V2.surface,
        border: `1px solid ${active ? V2.brand : V2.borderStrong}`,
        boxShadow: active ? `0 0 0 1px ${V2.brand}` : 'none',
        borderRadius: V2.radiusPill, padding: '3px 12px 3px 3px',
        color: V2.fg, cursor: 'pointer', transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
      }}>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        {dl.count > 0 ? (
          <ProgressRing pct={dl.pct} size={30} stroke={2.5}>
            <UserAvatar username={username} avatar={avatar} size={24} />
          </ProgressRing>
        ) : (
          <UserAvatar username={username} avatar={avatar} size={30} />
        )}
        {dl.count > 0 && (
          <span style={{
            position: 'absolute', top: '-3px', right: '-3px',
            minWidth: '13px', height: '13px', padding: '0 3px', boxSizing: 'border-box',
            borderRadius: '7px', background: V2.brand, color: '#fff',
            fontSize: '8.5px', fontWeight: 700, lineHeight: '13px', textAlign: 'center',
            border: '1.5px solid rgba(10,10,18,0.9)',
          }}>{dl.count}</span>
        )}
      </div>
      {/* Placeholder bar while the account is still loading, so the pill keeps
          its shape instead of collapsing and then jumping to full width. */}
      {username
        ? <span style={{ fontSize: '13px', fontWeight: 500, whiteSpace: 'nowrap' }}>{username}</span>
        : <span style={{
            width: '58px', height: '9px', borderRadius: '5px',
            background: V2.bgElevated, opacity: 0.7,
          }} />}
      <FaChevronDown size={11} style={{ color: V2.fgMuted }} />
    </Focusable>
  );
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

// Open a platform/collection grid from outside the library (a toast click).
// Siblings are optional but strongly preferred: the grid header's carousel pages
// through them with L1/R1, and leaving a stale list from a different mode behind
// means the selected group isn't in its own carousel.
function openGroupPage(mode: string, group: LibGroup, siblings?: LibGroup[]) {
  setLibGroupHolder({ mode, group });
  if (siblings?.length) setLibGroupsHolder({ mode, groups: siblings });
  else if (getLibGroupsHolder()?.mode !== mode) setLibGroupsHolder({ mode, groups: [group] });
  if (!pushLibView('grid')) Navigation.Navigate(`/romm-sync-library/${encodeURIComponent(group.key)}`);
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






const NAV_ORDER: NavId[] = ['home', 'platforms', 'collections', 'search'];







// Search tab — debounced text filter over the whole library, results as a
// cover-art grid (the nav 'Search' destination).
function SearchPanel({ onOpen, onBg, visible }: { onOpen: (g: LibGame) => void; onBg: (uri: string | null) => void; visible: boolean }) {
  // Minimum characters before we hit the backend. Browsing the whole library
  // (empty query) renders every cover tile, which tanks performance on big
  // collections — so search is gated until the user starts typing.
  const MIN_CHARS = 2;
  const [q, setQ] = useState('');
  const [results, setResults] = useState<LibGame[]>([]);
  const [loading, setLoading] = useState(false);
  const query = q.trim();
  const tooShort = query.length < MIN_CHARS;
  useEffect(() => {
    // Below the threshold: don't search, clear any prior results.
    if (tooShort) { setResults([]); setLoading(false); return; }
    // Keep the current results on screen while the new query debounces/fetches
    // — refining "syph" → "sypho" shouldn't blow the grid away and flash
    // "Searching…" on every keystroke. The full-screen loading state is only
    // shown when there's nothing to display yet (see render below).
    setLoading(true);
    const t = setTimeout(async () => {
      try { const r = await searchGames(q); setResults(r?.success ? (r.games || []) : []); }
      catch { setResults([]); }
      finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  // On-demand windowed mount — same scheme as the platform/collection games
  // page (visN + focus-driven growth + IO sentinel). A broad query (e.g. "ma")
  // can match hundreds of ROMs; mounting every Focusable tree at once stutters,
  // so render the first screenful and grow as the user scrolls toward the end.
  const GRID_FIRST = 30, GRID_CHUNK = 30;
  const [visN, setVisN] = useState(GRID_FIRST);
  useEffect(() => { setVisN(Math.min(results.length, GRID_FIRST)); }, [results]);
  const visNRef = useRef(visN); visNRef.current = visN;
  const resultsLenRef = useRef(results.length); resultsLenRef.current = results.length;
  const onTileFocus = useRef((i: number) => {
    if (i >= visNRef.current - 12)
      setVisN((n) => Math.min(resultsLenRef.current, Math.max(n, i + 1 + GRID_CHUNK)));
  }).current;
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (visN >= results.length) return;
    const el = sentinelRef.current;
    const bump = () => setVisN((n) => Math.min(results.length, n + GRID_CHUNK));
    if (!el || typeof IntersectionObserver === 'undefined') { bump(); return; }
    let io: IntersectionObserver | null = null;
    try {
      io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) bump(); },
        { rootMargin: '400px' });
      io.observe(el);
    } catch { bump(); }
    return () => { try { io?.disconnect(); } catch { } };
  }, [visN, results.length]);

  // Stable callback identity so memo(GameTile) isn't invalidated each render.
  const onOpenRef = useRef(onOpen); onOpenRef.current = onOpen;
  const openGame = useRef((g: LibGame) => onOpenRef.current(g)).current;
  const onBgRef = useRef(onBg); onBgRef.current = onBg;
  const setBg = useRef((uri: string | null) => onBgRef.current(uri)).current;

  const gridTiles = useMemo(() => results.slice(0, visN).map((g, i) => (
    <GameTile key={g.rom_id} game={g} onOpen={openGame} onActiveCover={setBg}
      index={i} onFocusIdx={onTileFocus} focusable={visible} />
  )), [results, visN, visible]);

  // Land gamepad focus on the search field when the tab opens (same retry
  // cadence as the group grids) — entering Search with nothing highlighted
  // parked focus on the page-root container, which showed a stray outline.
  // NOTE: deliberately a LOCAL effect, not useAutoFocus — useAutoFocus writes
  // the shared _autoFocusFirstRef that the post-game return-focus effect reads
  // as its target. Letting the search field register there meant returning from
  // a game launched off the Search tab focused the empty field instead of a
  // game (the "broke focus coming back from a game" regression).
  const searchFieldRef = useRef<any>(null);
  useEffect(() => {
    // Panels stay mounted across tab switches (display:none) — refire the
    // focus grab each time the tab becomes the visible one, not just on mount.
    if (!visible) return;
    // _forceGamepadFocus, not focus(): silent while the window is OS-unfocused
    // after an emulator session (same as useAutoFocus).
    const timers = [0, 60, 160, 320].map((d) =>
      setTimeout(() => { try { if (searchFieldRef.current) _forceGamepadFocus(searchFieldRef.current); } catch { } }, d));
    return () => timers.forEach(clearTimeout);
  }, [visible]);

  return (
    <div style={{ padding: '16px 16px 0' }}>
      <div style={{ maxWidth: '520px', margin: '0 auto 16px' }}>
        {/* Unmounted while the tab is hidden: the wrapper Focusable AND the
            TextField's DialogInput otherwise linger in Steam's nav tree as 0×0
            phantom focus targets (display:none doesn't remove them — verified
            on-device; these two were the last phantoms after the tiles got
            focusable={visible}). Remount is cheap — it's one input, and `q`
            lives up here so the text survives. */}
        {visible ? <V2SearchField ref={searchFieldRef} value={q} onChange={setQ} />
          : <div style={{ height: '40px' }} />}
      </div>
      {tooShort ? (
        <div style={{ padding: '24px', color: V2.fgMuted, fontSize: '13px', textAlign: 'center' }}>
          {`Type at least ${MIN_CHARS} characters to search your library.`}
        </div>
      ) : results.length === 0 ? (
        // Only the empty grid swaps to a text state: loading on first fetch,
        // "no match" once a fetch has resolved with nothing.
        <div style={{ padding: loading ? '16px' : '24px', color: V2.fgMuted, fontSize: '13px', textAlign: 'center' }}>
          {loading ? 'Searching…' : `No games match "${query}".`}
        </div>
      ) : (
        // Results present: keep the grid mounted even while a refined query is
        // in flight, so typing another letter doesn't flash "Searching…".
        <Focusable noFocusRing {...NAV_MAINTAIN_X} style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
          gap: '18px 16px', padding: '6px 0',
        }}>
          {gridTiles}
          {visN < results.length && (
            <div ref={sentinelRef} style={{ gridColumn: '1 / -1', height: '1px' }} />
          )}
        </Focusable>
      )}
    </div>
  );
}



// Placeholder block with a slow left-to-right sheen — the shared building brick
// for every "we don't know this yet" shape.
function Shimmer({ style }: { style?: any }) {
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

// Home's first-run state: the real layout with its content greyed out, instead
// of a centred "Loading…". A cold start has no cached lists to seed from, and a
// single line of text on an empty screen gave no sense of what was coming — the
// page then snapped from nothing to a full dashboard. Same row count, header
// sizes, tile widths and paddings as the real CardRows below, so the content
// lands in place rather than pushing a different layout out of the way.
function HomeSkeleton() {
  // Row 1 is landscape (Continue playing's screenshot cards), the rest portrait
  // covers — matching what usually renders in each slot.
  const rows: { tiles: number; w: number; ratio: string }[] = [
    { tiles: 4, w: 234, ratio: '16 / 9' },
    { tiles: 7, w: 132, ratio: '3 / 4' },
    { tiles: 7, w: 132, ratio: '3 / 4' },
  ];
  return (
    <div style={{ paddingTop: '8px' }} aria-busy="true">
      <style>{`
        @keyframes rommShimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
        @keyframes rommSkelIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
      {rows.map((row, r) => (
        // Stagger the rows in so the skeleton itself arrives calmly rather than
        // all at once — and so a fast backend never flashes the full set.
        <section key={r} style={{
          marginBottom: '22px', opacity: 0,
          animation: `rommSkelIn 0.5s ease ${r * 0.12 + 0.15}s forwards`,
        }}>
          <header style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '0 16px', marginBottom: '12px',
          }}>
            <Shimmer style={{ width: '14px', height: '14px', borderRadius: '4px' }} />
            <Shimmer style={{ width: `${110 + r * 22}px`, height: '13px', borderRadius: '4px' }} />
          </header>
          <div style={{ display: 'flex', gap: '12px', padding: '24px 16px 28px', overflow: 'hidden' }}>
            {Array.from({ length: row.tiles }).map((_, i) => (
              <div key={i} style={{ width: `${row.w}px`, flexShrink: 0 }}>
                <Shimmer style={{ width: '100%', aspectRatio: row.ratio, borderRadius: V2.radiusArt }} />
                {/* The title line under each cover, so the row's height matches
                    the real one and nothing shifts when the data lands. */}
                <Shimmer style={{ width: `${60 + ((i * 37) % 35)}%`, height: '9px', marginTop: '8px', borderRadius: '4px' }} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// Same idea for the Platforms/Collections index: the real grid geometry, greyed
// out, so the tiles fade into position instead of replacing a line of text.
function GroupGridSkeleton() {
  return (
    <div style={{ paddingTop: '6px', opacity: 0, animation: 'rommSkelIn 0.5s ease 0.15s forwards' }} aria-busy="true">
      <style>{`
        @keyframes rommShimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
        @keyframes rommSkelIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
      <div style={{ padding: '6px 16px 10px' }}>
        <Shimmer style={{ width: '92px', height: '10px', borderRadius: '4px' }} />
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
        gap: '18px 16px', padding: '0 16px 8px',
      }}>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i}>
            <Shimmer style={{ width: '100%', aspectRatio: '3 / 4', borderRadius: V2.radiusArt }} />
            <Shimmer style={{ width: `${55 + ((i * 41) % 40)}%`, height: '9px', marginTop: '8px', borderRadius: '4px' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

// And for a group's games page: the real grid geometry (3:4 covers + title
// lines) greyed out. A first open of a collection — the fetch pulls its whole
// ROM list before anything paints — used to show a line of text, which the
// home and index pages had already moved past.
function GamesGridSkeleton() {
  return (
    <div style={{ opacity: 0, animation: 'rommSkelIn 0.5s ease 0.15s forwards' }} aria-busy="true">
      <style>{`
        @keyframes rommShimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
        @keyframes rommSkelIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
        gap: '18px 16px', padding: '16px 16px 0',
      }}>
        {Array.from({ length: 18 }).map((_, i) => (
          <div key={i}>
            <Shimmer style={{ width: '100%', aspectRatio: '3 / 4', borderRadius: V2.radiusArt }} />
            <Shimmer style={{ width: `${55 + ((i * 41) % 40)}%`, height: '9px', marginTop: '8px', borderRadius: '4px' }} />
          </div>
        ))}
      </div>
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

function EmulatorBanner() {
  const status = useEmulatorStatus();
  const install = useEmulatorInstall();
  const [fixing, setFixing] = useState(false);
  if (!status) return null;

  const stale = status.stale_paths || [];
  if (status.installed && !stale.length && !install.active) return null;
  const copy = staleCopy(stale);

  const tone = status.installed ? V2.warning : V2.brandHover;
  // Fixes everything the banner is complaining about, since that is what it now
  // reports. BIOS repair only redirects where new files go — it moves nothing —
  // so the toast says which folders changed rather than implying a migration.
  const fixStale = async () => {
    setFixing(true);
    const title = 'Emulator folders';
    try {
      const keys = stale.map((p) => `${p.section}.${p.key}`);
      const r = await repairEmulatorPaths(keys);
      // success with nothing repaired is not success — say so rather than
      // congratulating the user next to a warning that hasn't moved.
      if (r?.success && r.repaired?.length) {
        publishEmulatorStatus({ ...status, stale_paths: r.stale_paths || [] });
        const names = r.repaired.map((x: any) => x.label || x.key).join(', ');
        toaster.toast({ title, body: `Pointed back at your emulator: ${names}` });
      } else if (r?.success) {
        await loadEmulatorStatus(true);
        toaster.toast({ title, body: 'Nothing changed — check Settings ▸ Emulator & folders' });
      } else {
        toaster.toast({ title, body: r?.message || 'Could not update them' });
      }
    } catch { toaster.toast({ title, body: 'Could not update them' }); }
    finally { setFixing(false); }
  };

  const body = install.active
    ? [install.phase || 'Installing RetroArch',
       installSize(install),
       install.detail,
       'You can keep browsing while it runs.']
      .filter(Boolean).join(' · ')
    : status.installed
      ? copy.body
      : status.install.available
        ? 'Downloading and syncing still work — you just need an emulator to play. Installing RetroArch takes a few minutes.'
        // Can't install from here (Windows, no flatpak, running as root): say why
        // rather than offering a button that can only fail.
        : `Downloading and syncing still work, but playing needs RetroArch or RetroDECK — ${status.install.reason || 'install one to play'}.`;

  return (
    <div style={{ padding: '4px 20px 12px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px',
        borderRadius: V2.radiusCard, background: V2.surface,
        border: `1px solid ${tone}`, boxShadow: `inset 3px 0 0 ${tone}`,
      }}>
        <div style={{
          flexShrink: 0, width: '36px', height: '36px', borderRadius: V2.radiusMd,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: V2.bgElevated, color: tone,
        }}>
          {status.installed ? <FaExclamationTriangle size={16} /> : <FaGamepad size={17} />}
        </div>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ fontSize: '14px', fontWeight: 700 }}>
            {install.active ? 'Installing RetroArch'
              : status.installed ? copy.title
                : 'No emulator installed'}
          </div>
          <div style={{ fontSize: '12px', color: V2.fgMuted, lineHeight: 1.4, marginTop: '2px' }}>{body}</div>
          {install.active && <InstallProgressBar pct={install.pct} />}
        </div>
        {!install.active && (
          <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            {status.installed ? (
              <>
                <GameActionButton variant="emphasized" disabled={fixing} onClick={fixStale}
                  label={fixing ? 'Fixing…' : stale.length > 1 ? 'Fix all' : 'Fix'}
                  icon={fixing
                    ? <FaSync size={14} style={{ animation: 'spin 1s linear infinite' }} />
                    : <FaCheck size={14} />} />
                {/* Review it instead: Settings ▸ Folders shows every path and
                    what each would become. */}
                <GameActionButton variant="surface" onClick={() => libNavigate('/romm-sync-settings')}
                  icon={<FaChevronRight size={15} />} />
              </>
            ) : (
              <>
                {status.install.available && (
                  <GameActionButton variant="emphasized" onClick={startEmulatorInstall}
                    label="Install RetroArch" icon={<FaDownload size={14} />} />
                )}
                <GameActionButton variant="surface" onClick={() => libNavigate('/romm-sync-cores')}
                  icon={<FaChevronRight size={15} />} />
              </>
            )}
          </Focusable>
        )}
      </div>
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
const _stateThumbs = new Map<number, string | null>();
let _stateThumbsInflight: Promise<void> | null = null;
// Fetches every missing thumbnail in ONE backend call. Per-tile calls turned a
// 15-card row into 15 websocket round-trips, each of which could fall through
// to its own RomM request; batched, the backend overlaps the misses on a thread
// pool and answers once. Resolves when the map has been filled.
// A play session creates or replaces save states, and "this game has no state"
// is cached as null just as firmly as a picture — so after playing, the row
// would keep showing box art until the next app start. Drop the lot; the row's
// own effect refetches, and a Continue-playing-sized batch is one call.
const _stateThumbListeners = new Set<() => void>();
export function invalidateStateThumbs() {
  _stateThumbs.clear();
  // Clearing alone isn't enough: the row refetches from an effect keyed on the
  // games it shows, and after a session those are usually the same games.
  _stateThumbListeners.forEach((l) => { try { l(); } catch { } });
}

async function loadStateThumbs(romIds: number[], force = false): Promise<void> {
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

function HomePanel({ onOpen, onOpenGroup, onBg, visible }:
  { onOpen: (g: LibGame) => void; onOpenGroup: (mode: string, g: LibGroup, gs: LibGroup[]) => void; onBg: (uri: string | null) => void; visible: boolean }) {
  // Seed from the module-level cache so re-mounting (tab switch back to Home)
  // paints instantly instead of flashing "Loading…" and refetching.
  const c0 = getHomeCache();
  const [recent, setRecent] = useState<LibGame[]>(c0?.recent || []);
  const [continuePlaying, setContinuePlaying] = useState<LibGame[]>(c0?.continuePlaying || []);
  const [downloaded, setDownloaded] = useState<LibGame[]>(c0?.downloaded || []);
  const [platforms, setPlatforms] = useState<LibGroup[]>(c0?.platforms || []);
  const [collections, setCollections] = useState<LibGroup[]>(c0?.collections || []);
  const [loading, setLoading] = useState(!c0);
  const offline = useOffline();
  // "Resume from the newest save state" (Settings → Gameplay). Cached at module
  // level so returning to Home doesn't re-ask the backend and re-render the row.
  const [resumeStates, setResumeStates] = useState<boolean>(_resumeStatesPref);
  useEffect(() => {
    let alive = true;
    getResumeStateEnabled()
      .then((v) => { _setResumeStatesPref(!!v); if (alive) setResumeStates(!!v); })
      .catch(() => { /* keep the last known answer */ });
    return () => { alive = false; };
  }, [visible]);
  // One batched fetch for the whole row, started as soon as the games are known
  // — not per tile, and not gated on anything else finishing.
  const [thumbTick, setThumbTick] = useState(0);
  // Bumped when a play session invalidates the cache, so the fetch below reruns
  // even though the row is showing the same games it was before.
  const [thumbEpoch, setThumbEpoch] = useState(0);
  useEffect(() => {
    const l = () => setThumbEpoch((e) => e + 1);
    _stateThumbListeners.add(l);
    return () => { _stateThumbListeners.delete(l); };
  }, []);
  useEffect(() => {
    if (!resumeStates || !continuePlaying.length) return;
    let alive = true;
    // After a session, force: the backend's own memory cache is keyed per rom,
    // so without this it would hand back the picture from the PREVIOUS state.
    loadStateThumbs(continuePlaying.map((g) => g.rom_id), thumbEpoch > 0)
      .then(() => { if (alive) setThumbTick((t) => t + 1); })
      .catch(() => { /* the row keeps its existing art */ });
    return () => { alive = false; };
  }, [resumeStates, continuePlaying, thumbEpoch]);

  useEffect(() => {
    let alive = true;
    let retry: any = null;
    const load = async (attempt = 0) => {
      try {
        const [h, p, c] = await Promise.all([
          getHomeData(), getLibraryGroups('platform'), getLibraryGroups('collection'),
        ]);
        if (!alive) return;
        const prev = getHomeCache();   // state mirrors this (seed + paired setStates)
        const next = { ...prev } as NonNullable<ReturnType<typeof getHomeCache>>;
        // Only setState when a list actually changed — the silent refresh runs
        // on every tab switch back to Home, and unconditional setStates with
        // fresh array identities re-rendered every tile (visible pop-in +
        // stutter) even when the data was byte-identical to the cache seed.
        const upd = <T,>(fresh: T, prev: T | undefined, set: (v: any) => void): T => {
          if (JSON.stringify(fresh) !== JSON.stringify(prev)) set(fresh);
          return fresh;
        };
        if (h?.success) {
          next.recent = upd(h.recent || [], prev?.recent, setRecent);
          next.downloaded = upd(h.downloaded_games || [], prev?.downloaded, setDownloaded);
        }
        // Continue playing is the one row fetched live from RomM, so it alone
        // can come back "unknown" (null) — not authenticated yet at boot,
        // offline, a 5xx. Keep whatever we last knew instead of blanking the
        // row; an empty ARRAY is a real answer and does clear it. Runs outside
        // the h.success guard so a failed payload can't clear it either.
        if (h?.continue_playing != null) {
          next.continuePlaying = upd(h.continue_playing, prev?.continuePlaying, setContinuePlaying);
        } else if (attempt < 3) {
          // Losing the race with login is the common case on a cold start, and
          // it resolves silently a second or two later — without this the row
          // would stay missing until something else triggered a reload.
          retry = setTimeout(() => { if (alive) load(attempt + 1); }, 2500);
        }
        if (p?.success) next.platforms = upd(p.groups || [], prev?.platforms, setPlatforms);
        if (c?.success) next.collections = upd(c.groups || [], prev?.collections, setCollections);
        // On a first run the wizard lands here while the initial fetch is still
        // going, so the game-derived answers come back truthfully-empty: no games
        // yet means no Recently added and no Platforms. Those must not reach
        // localStorage — that copy is the seed Home paints on the next mount, and
        // nothing else would have gone back for the real ones. Whatever IS ready
        // (Continue playing, Collections — both fetched long before the ROM list)
        // still renders now rather than waiting on the rest.
        const notReady = h?.library_ready === false
          || p?.library_ready === false || c?.library_ready === false;
        // In-memory cache always advances, so a row that has arrived isn't
        // re-setState'd on every poll; only the durable copy waits.
        setHomeCache(next);
        if (notReady) {
          // Every 3s, capped at ~10min: enough for the 50–80k libraries this is
          // worst on, and bounded so a backend that never becomes ready doesn't
          // leave a poll running for the whole session.
          if (attempt < 200) {
            clearTimeout(retry);
            retry = setTimeout(() => { if (alive) load(attempt + 1); }, 3000);
          }
          return;
        }
        persistHomeCache();
      } catch (e) { console.error('home load failed', e); }
      finally { if (alive) setLoading(false); }
    };
    load();
    // Re-fetch on a manual "Refresh library" (account menu) so a same-tab
    // refresh shows up immediately instead of waiting for a tab switch.
    _libRefreshListeners.add(load);
    return () => { alive = false; clearTimeout(retry); _libRefreshListeners.delete(load); };
    // Re-fetch when connectivity flips: offline filters the library to
    // downloaded-only, so the rows must rebuild without a tab switch.
  }, [offline]);

  // Autogenerated (virtual) collections render as their own row — same split the
  // Collections tab makes. Both still hand the FULL list to onOpenGroup so L1/R1
  // paging inside a collection walks every one of them, as it did before.
  const ownCollections = collections.filter((g) => !g.virtual);
  const virtualCollections = collections.filter((g) => g.virtual);

  // Land focus on the first card of whichever row renders first, so the user can
  // navigate straight in (no DOWN press needed off the nav bar).
  const firstList = continuePlaying.length ? 'cp' : downloaded.length ? 'dl'
    : recent.length ? 'rc' : platforms.length ? 'pf'
    : ownCollections.length ? 'cl' : virtualCollections.length ? 'vc' : null;
  // visible in the ready flag: the panel stays mounted while hidden, so the
  // focus grab must refire on each return to the tab, not just on mount.
  const firstRef = useAutoFocus(visible && !loading && firstList !== null, firstList);

  if (loading) return <HomeSkeleton />;
  return (
    <div style={{ paddingTop: '8px' }}>
      <EmulatorBanner />
      {/* Continue playing — per-user last_played from RomM (cross-device). */}
      {continuePlaying.length > 0 && (
        <CardRow icon={<FaPlay size={14} />} title="Continue playing" count={continuePlaying.length}>
          {continuePlaying.map((g, i) => (
            // Screenshot cards size to their natural (landscape) width; games
            // with no screenshot fall back to the portrait 132px cover.
            <div key={g.rom_id} style={{
              flexShrink: 0,
              // In resume mode the tile owns its width — a state screenshot can
              // turn a portrait card landscape after this wrapper is laid out.
              ...(resumeStates || g.screenshot ? {} : { width: '132px' }),
            }}>
              <GameTile game={g} onOpen={onOpen} onActiveCover={onBg} resume={resumeStates}
                // thumbTick is what re-reads the module-level map once the batch
                // lands; the value itself carries no meaning.
                stateThumb={resumeStates && thumbTick >= 0 ? (_stateThumbs.get(g.rom_id) ?? null) : null}
                focusRef={firstList === 'cp' && i === 0 ? firstRef : undefined} focusable={visible} />
            </div>
          ))}
        </CardRow>
      )}

      {/* Downloaded — locally installed games, latest download first, so a
          just-downloaded game is one row away instead of a search away. */}
      {downloaded.length > 0 && (
        <CardRow icon={<FaDownload size={14} />} title="Recently Downloaded" count={downloaded.length}>
          {downloaded.map((g, i) => (
            <div key={g.rom_id} style={{ width: '132px', flexShrink: 0 }}>
              <GameTile game={g} onOpen={onOpen} onActiveCover={onBg}
                focusRef={firstList === 'dl' && i === 0 ? firstRef : undefined} focusable={visible} />
            </div>
          ))}
        </CardRow>
      )}

      {/* Recently added */}
      {recent.length > 0 && (
        <CardRow icon={<FaRegClock size={16} />} title="Recently added" count={recent.length}>
          {recent.map((g, i) => (
            <div key={g.rom_id} style={{ width: '132px', flexShrink: 0 }}>
              <GameTile game={g} onOpen={onOpen} onActiveCover={onBg}
                focusRef={firstList === 'rc' && i === 0 ? firstRef : undefined} focusable={visible} />
            </div>
          ))}
        </CardRow>
      )}

      {/* Platforms */}
      {platforms.length > 0 && (
        <CardRow icon={<FaGamepad size={16} />} title="Platforms" count={platforms.length}>
          {platforms.map((g, i) => (
            <div key={g.key} style={{ width: '150px', flexShrink: 0 }}>
              <PlatformTile group={g} onOpen={(grp) => onOpenGroup('platform', grp, platforms)}
                focusRef={firstList === 'pf' && i === 0 ? firstRef : undefined} focusable={visible} />
            </div>
          ))}
        </CardRow>
      )}

      {/* Collections — the user's own. Autogenerated ones get their own row
          below: they're server-generated groupings rather than something the
          user curated, and the Collections tab already separates them the same
          way. Merged into one row they buried the handful of real collections. */}
      {ownCollections.length > 0 && (
        <CardRow icon={<FaLayerGroup size={15} />} title="Collections" count={ownCollections.length}>
          {ownCollections.map((g, i) => (
            <div key={g.key} style={{ width: '132px', flexShrink: 0 }}>
              <CollectionTile group={g} onOpen={(grp) => onOpenGroup('collection', grp, collections)}
                focusRef={firstList === 'cl' && i === 0 ? firstRef : undefined} focusable={visible} />
            </div>
          ))}
        </CardRow>
      )}

      {/* Autogenerated (virtual) collections */}
      {virtualCollections.length > 0 && (
        <CardRow icon={<FaLayerGroup size={15} />} title="Virtual collections" count={virtualCollections.length}>
          {virtualCollections.map((g, i) => (
            <div key={g.key} style={{ width: '132px', flexShrink: 0 }}>
              <CollectionTile group={g} onOpen={(grp) => onOpenGroup('collection', grp, collections)}
                focusRef={firstList === 'vc' && i === 0 ? firstRef : undefined} focusable={visible} />
            </div>
          ))}
        </CardRow>
      )}

      {continuePlaying.length === 0 && downloaded.length === 0 && recent.length === 0 && platforms.length === 0 && collections.length === 0 && (
        <div style={{ padding: '16px', color: V2.fgMuted, fontSize: '13px' }}>
          {offline
            ? 'No downloaded games yet. Reconnect to browse and download your library.'
            : 'No games in your library yet.'}
        </div>
      )}
    </div>
  );
}

// Platforms/Collections index grid — one component instance per mode, kept
// mounted across tab switches (the parent hides inactive panels with
// display:none) so switching back doesn't rebuild 150+ cover <img>s from
// scratch: measured on-device, each remount inserted ~170–270 fresh imgs and
// cost ~100–200ms of main-thread long tasks (the visible repopulation+stutter).
// L2/R2 alphabet fast-scroll ("letter scrubber", à la Big Picture): the visible
// GroupsPanel registers its jump function here; the library root page's
// onButtonDown dispatches trigger presses into it.
let _libLetterJump: ((dir: 1 | -1) => void) | null = null;
const _scrubLetterOf = (s: string) => {
  const c = (s || '').trim().charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
};

// Entering a grid/row container from above or below should land on the tile in
// the SAME COLUMN you came from, not the container's remembered last-active
// child (Steam's default "preferred child" made UP/DOWN between rows snap back
// to wherever you were last in that row — verified on-device by live-patching
// nav nodes). 2 = NavEntryPositionPreferences.MAINTAIN_X (@decky/ui declares
// the enum but doesn't export it at runtime). Spread as any: not in decky's
// FocusableProps typing, but Steam's Focusable forwards it into m_Properties.
export const NAV_MAINTAIN_X = { navEntryPreferPosition: 2 } as any;

// Fast-scroll glimpse (Big Picture-style): show the current letter only while
// the user is genuinely flying through the grid — a sustained run of held-repeat
// focus moves. Deliberate d-pad taps land ~250ms+ apart even when quick, while
// Steam's held-repeat cadence is well under 200ms, so the tight window plus a
// long streak keeps the overlay away from normal browsing.
let _scrubGlimpse: ((letter: string) => void) | null = null;
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
  if (_scrubStreak >= 5) { try { _scrubGlimpse?.(_scrubLetterOf(label)); } catch { /* ignore */ } }
}

// Shared jump math: given the displayed labels and the current index, the index
// to land on. R2 → first item of the next letter block (last item from the last
// block); L2 → first item of the current block, or of the previous block when
// already there.
function _scrubTargetIdx(labels: string[], cur: number, dir: 1 | -1): number {
  const curL = _scrubLetterOf(labels[cur]);
  if (dir === 1) {
    for (let i = cur + 1; i < labels.length; i++) {
      if (_scrubLetterOf(labels[i]) !== curL) return i;
    }
    return labels.length - 1;
  }
  let start = cur;
  while (start > 0 && _scrubLetterOf(labels[start - 1]) === curL) start--;
  if (start === cur && start > 0) {
    const prevL = _scrubLetterOf(labels[start - 1]);
    let i = start - 1;
    while (i > 0 && _scrubLetterOf(labels[i - 1]) === prevL) i--;
    return i;
  }
  return start;
}

// Big Picture-style letter overlay shown while scrubbing — dims/blurs the
// whole screen (not just a small centered card) so the letter reads as a
// full-screen state change rather than a floating window.
function ScrubOverlay({ letter }: { letter: string | null }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'grid', placeItems: 'center',
      pointerEvents: 'none', zIndex: 60,
      background: 'rgba(6,7,10,0.55)', backdropFilter: 'blur(6px)',
      opacity: letter ? 1 : 0, transition: 'opacity 0.18s ease',
    }}>
      <div style={{
        fontSize: '220px', fontWeight: 800, lineHeight: 1, color: V2.fg,
        textShadow: '0 12px 44px rgba(0,0,0,0.6)',
      }}>
        {letter ?? ''}
      </div>
    </div>
  );
}

// ── Staleness detection ─────────────────────────────────────────────────────
// Games appear and disappear on RomM while the app is open, and until now
// nothing asked unless the user pressed a button — the library was fetched on
// connect and never again.
//
// Detect automatically, apply on consent. This started as a silent automatic
// reconcile and that was the wrong shape: applying costs a walk of every
// platform that moved (seconds to minutes), it renders a sticky fetch toast and
// a loading banner, and it reorders the grid — all of it landing on someone who
// is mid-browse and asked for none of it. Detection, by contrast, is one
// /api/platforms call: 0.04s on a 20k-ROM instance, flat in library size,
// touching nothing. So the cheap half runs unasked and the expensive half waits
// for a press.
//
// Fires on the library tab becoming visible, at most once per interval —
// event-driven rather than a timer, because a poll running while the user is in
// a game can change nothing they are looking at, whereas arriving at the library
// is exactly when a stale grid is about to be seen. argosy-launcher checks at
// app start on a 7-day bound; it can only afford that because every sync it runs
// is a full walk.
//
// No setting. There is no cost to trade away, and an interval nobody can predict
// the value of is not a choice, it is a guess with a slider.
const _STALE_CHECK_MS = 15 * 60 * 1000;
let _lastStaleCheck = 0;

type StaleInfo = { added: number; removed: number; platforms: string[] };
let _staleInfo: StaleInfo | null = null;
const _staleSubs = new Set<(s: StaleInfo | null) => void>();
function _setStale(s: StaleInfo | null) {
  _staleInfo = s;
  _staleSubs.forEach((fn) => { try { fn(s); } catch { /* ignore */ } });
}
// Any path that brings the library back in step retires the banner and restarts
// the interval — a manual refresh resolves it just as the banner's own button
// does, and one left on screen after the fact reads as a failure.
export function _clearStale() { _setStale(null); _lastStaleCheck = Date.now(); }

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
function useStaleLibrary(): StaleInfo | null {
  const [s, setS] = useState<StaleInfo | null>(_staleInfo);
  useEffect(() => {
    const fn = (v: StaleInfo | null) => setS(v);
    _staleSubs.add(fn);
    setS(_staleInfo);
    return () => { _staleSubs.delete(fn); };
  }, []);
  return s;
}

async function _maybeCheckStale(svcStatus: any) {
  if (!svcStatus || svcStatus.connection === 'offline_cached'
      || svcStatus.connection === 'disconnected') return;
  // Nothing to compare against until the first fetch has landed, and a fetch in
  // flight is about to rewrite the baselines — the backend refuses either way,
  // but asking it to is a pointless round trip.
  if (svcStatus.library_ready === false || svcStatus.library_progress) return;
  // Already announced and not yet acted on. Re-asking would only redraw the
  // same banner, and the numbers it shows came from the same source.
  if (_staleInfo) return;
  const now = Date.now();
  if (now - _lastStaleCheck < _STALE_CHECK_MS) return;
  // Stamped before the await, not after: two visibility flips in quick
  // succession would otherwise both pass the check.
  _lastStaleCheck = now;
  try {
    const res = await checkLibraryStale();
    if (res?.stale) {
      _setStale({ added: res.added || 0, removed: res.removed || 0,
        platforms: res.platforms || [] });
    }
  } catch {
    // Offline, server down, mid-reconnect — all reasons to try again later, and
    // none worth interrupting someone who never asked for this.
  }
}

// Apply what the check found. This is the expensive half, and the only path
// that reaches it is a person pressing Update.
async function _applyStaleUpdate(): Promise<boolean> {
  try {
    const res = await refreshFromRomm(false);
    if (res?.busy) {
      toaster.toast({ title: 'Already refreshing', body: 'A library fetch is in progress.' });
      return false;
    }
    if (!res?.success) {
      toaster.toast({ title: 'Update failed', body: res?.message ?? 'Unknown error' });
      return false;
    }
    // Clear only on success. A failed update leaves the library genuinely
    // stale, and the banner is the accurate thing to keep showing.
    _clearStale();
    // Both caches: the per-group game lists AND the group list itself, whose
    // per-platform counts just moved. Without the second, the grid keeps
    // showing the pre-update numbers until the tab is left and re-entered.
    _libGamesCache.clear();
    delete _groupsCache['platform'];
    delete _groupsCache['collection'];
    _broadcastLibRefresh();
    toaster.toast({ title: 'Library updated', body: res.message || 'Synced with RomM.' });
    return true;
  } catch (e) {
    toaster.toast({ title: 'Update failed', body: String(e) });
    return false;
  }
}

function GroupsPanel({ mode, visible, onOpenGroup, svcStatus }:
  { mode: 'platform' | 'collection'; visible: boolean; onOpenGroup: (mode: string, g: LibGroup, gs: LibGroup[]) => void; svcStatus: any }) {
  const c0 = _groupsCache[mode];
  const [groups, setGroups] = useState<LibGroup[]>(c0 || []);
  const [loading, setLoading] = useState(!c0);
  const offline = svcStatus?.connection === 'offline_cached' || svcStatus?.connection === 'disconnected';

  // Silent refresh each time the tab becomes visible (and on connectivity
  // flips while visible — offline filters the list to downloaded-only). The
  // seq guard drops stale responses when the user bumper-cycles faster than
  // the RPC; the JSON compare skips the setState (and the full grid
  // re-render) when nothing changed, which is the common case.
  const seq = useRef(0);
  useEffect(() => {
    if (!visible) return;
    let retry: any = null;
    const load = async () => {
      const s = ++seq.current;
      try {
        const res = await getLibraryGroups(mode);
        if (s !== seq.current) return;
        if (res?.success) {
          const next: LibGroup[] = res.groups || [];
          // Same first-run trap as HomePanel: an answer given before the
          // initial fetch lands is empty and correct, and must not become the
          // cached seed. Show it, don't persist it, and come back for the
          // real one.
          if (res.library_ready === false) {
            setGroups(next);
            retry = setTimeout(() => { if (s === seq.current) load(); }, 3000);
            return;
          }
          if (JSON.stringify(next) !== JSON.stringify(_groupsCache[mode])) {
            _groupsCache[mode] = next;
            persistGroupsCache();
            setGroups(next);
          }
        } else if (!_groupsCache[mode]) {
          setGroups([]);
        }
      } catch (e) {
        console.error('get_library_groups failed', e);
      } finally {
        if (s === seq.current) setLoading(false);
      }
    };
    load();
    // Re-fetch on a manual "Refresh library" (account menu) so a same-tab
    // refresh shows up immediately instead of waiting for a tab switch.
    _libRefreshListeners.add(load);
    return () => { clearTimeout(retry); _libRefreshListeners.delete(load); };
    // library_ready is in here so a fetch FINISHING re-loads the panel. Without
    // it the only triggers were a visibility flip, a connectivity flip, and the
    // 3s self-retry the not-ready answer schedules — so a panel that was handed
    // an empty pre-fetch answer and then lost its retry chain (any effect
    // re-run cancels the pending timer) sat on "No games found." until the app
    // was restarted, with a full library behind it. This makes the transition
    // itself the trigger, which is what it should always have been.
  }, [visible, offline, svcStatus?.library_ready]);

  // visible in the ready flag so the focus grab refires on each return to the
  // tab (the panel no longer remounts). Backing out of a group should land on
  // the group you were just in, not the first tile — getLibGroupHolder() still
  // holds the last-viewed group (updated on open AND on L1/R1 paging).
  const heldGroup = getLibGroupHolder();
  const lastKey = heldGroup && heldGroup.mode === mode ? heldGroup.group.key : null;
  const focusKey = (lastKey && groups.some((g) => g.key === lastKey)) ? lastKey : (groups[0]?.key ?? null);
  const firstGroupRef = useAutoFocus(visible && !loading && groups.length > 0, `${mode}:${focusKey}`);
  const openGroup = (g: LibGroup) => onOpenGroup(mode, g, groups);

  // ---- L2/R2 letter scrubbing -------------------------------------------
  // Displayed order (regular/favorite/smart share one section, virtual has
  // its own, so the jump order must match what's on screen, not raw order).
  const order: LibGroup[] = mode === 'platform' ? groups
    : ([['favorite', 'collection', 'smart'], ['virtual']] as string[][])
        .flatMap((kinds) => groups.filter((g) => kinds.includes(g.kind || 'collection')));
  const orderRef = useRef<LibGroup[]>(order);
  orderRef.current = order;
  // Every tile registers its DOM node so the jump can (a) locate the currently
  // focused tile via .gpfocus containment and (b) force focus onto the target.
  const tileEls = useRef(new Map<string, any>());
  const tileRef = (key: string, autoKey: string | null) => (el: any) => {
    if (el) tileEls.current.set(key, el); else tileEls.current.delete(key);
    if (key === autoKey) firstGroupRef.current = el;
  };
  // Big centered letter overlay while scrubbing (Big Picture-style).
  const [scrubLetter, setScrubLetter] = useState<string | null>(null);
  const scrubTimer = useRef<any>(null);
  useEffect(() => () => clearTimeout(scrubTimer.current), []);
  const showScrubRef = useRef<(l: string) => void>(() => { });
  showScrubRef.current = (l) => {
    setScrubLetter(l);
    clearTimeout(scrubTimer.current);
    scrubTimer.current = setTimeout(() => setScrubLetter(null), 750);
  };
  const jumpRef = useRef<(dir: 1 | -1) => void>(() => { });
  jumpRef.current = (dir) => {
    const ord = orderRef.current;
    if (!ord.length) return;
    const focusEl = _gpFocusEl();
    let cur = ord.findIndex((o) => {
      const el = tileEls.current.get(o.key);
      return !!(el && focusEl && el.contains(focusEl));
    });
    if (cur < 0) cur = 0;
    const target = _scrubTargetIdx(ord.map((o) => o.label), cur, dir);
    const g = ord[target];
    const el = tileEls.current.get(g.key);
    if (el && target !== cur) {
      _forceGamepadFocus(el);
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* ignore */ }
      playSteamSound('deck_ui_tab_transition_01');
    }
    showScrubRef.current(_scrubLetterOf(g.label));
  };
  useEffect(() => {
    if (!visible) return;
    const fn = (d: 1 | -1) => jumpRef.current(d);
    _libLetterJump = fn;
    // Fast-scroll glimpse: tiles report rapid focus moves here.
    const gl = (l: string) => showScrubRef.current(l);
    _scrubGlimpse = gl;
    return () => {
      if (_libLetterJump === fn) _libLetterJump = null;
      if (_scrubGlimpse === gl) _scrubGlimpse = null;
    };
  }, [visible]);
  const scrubOverlay = <ScrubOverlay letter={scrubLetter} />;
  // -----------------------------------------------------------------------

  if (loading) return <GroupGridSkeleton />;
  if (groups.length === 0) {
    // "No games found." is a verdict, and during a fetch it's a wrong one — the
    // library is on its way, not absent. Show the same shimmering grid a first
    // load shows, so an empty Platforms tab mid-fetch reads as work in progress
    // rather than an empty server.
    //
    // Skeleton only, no caption. The banner directly above is already
    // saying "Loading your library… 2,300 of 14,112 games", and a second copy
    // of the same sentence under the grid reads as two different things
    // happening. The shimmer's job here is only to show the tab isn't empty.
    if (svcStatus?.library_progress || svcStatus?.library_ready === false) {
      return <GroupGridSkeleton />;
    }
    return (
      <div style={{ padding: '16px', color: V2.fgMuted, fontSize: '13px' }}>
        {offline
          ? (mode === 'collection'
              ? "Collections aren't available offline — reconnect to browse them."
              : 'No downloaded games yet. Reconnect to download from your library.')
          : (mode === 'collection' ? 'No collections found on the server.' : 'No games found.')}
      </div>
    );
  }
  if (mode === 'platform') {
    return (
      <Focusable noFocusRing {...NAV_MAINTAIN_X}
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
          // 16px + the 8px tab spacer = 24px above row one; the bottom gap
          // comes from v2Page's 64px page padding, which nets ~22px of visible
          // clearance above Steam's 42px footer legend once scrolled — the
          // same breathing room as the top.
          gap: '14px', padding: '16px 16px 0',
        }}
      >
        {groups.map((g) => <PlatformTile key={g.key} group={g} onOpen={openGroup} focusRef={tileRef(g.key, focusKey)} focusable={visible} />)}
        {scrubOverlay}
      </Focusable>
    );
  }
  // Collections grouped into sections like RomM's collection index: regular,
  // favorite and smart collections share one list (smart told apart by its
  // bolt badge), virtual (autogenerated) ones get their own section.
  const sections: { title: string; kinds: string[] }[] = [
    { title: 'Collections', kinds: ['favorite', 'collection', 'smart'] },
    { title: 'Virtual', kinds: ['virtual'] },
  ];
  // Focus target across all sections: the remembered group (focusKey) if it
  // renders here, else the very first rendered tile.
  let firstKey: string | null = null;
  for (const s of sections) {
    const it = groups.find((g) => s.kinds.includes(g.kind || 'collection'));
    if (it) { firstKey = it.key; break; }
  }
  if (focusKey && groups.some((g) => g.key === focusKey)) firstKey = focusKey;
  return (
    <div style={{ paddingTop: '16px' }}>
      {scrubOverlay}
      {sections.map((s) => {
        const items = groups.filter((g) => s.kinds.includes(g.kind || 'collection'));
        if (items.length === 0) return null;
        return (
          <div key={s.title} style={{ marginBottom: '6px' }}>
            <div style={{
              fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em',
              textTransform: 'uppercase', color: V2.fgMuted, padding: '6px 16px 10px',
              display: 'flex', alignItems: 'center', gap: '6px',
            }}>
              <FaBookmark size={10} /><span>{s.title}</span>
            </div>
            <Focusable noFocusRing {...NAV_MAINTAIN_X}
              style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
                gap: '18px 16px', padding: '0 16px 8px',
              }}
            >
              {items.map((g) => <CollectionTile key={g.key} group={g} onOpen={openGroup} focusRef={tileRef(g.key, firstKey)} focusable={visible} />)}
            </Focusable>
          </div>
        );
      })}
    </div>
  );
}

// Slim, full-width strip shown ONLY when the backend reports a non-online
// connection state. It explains what offline means rather than just flagging an
// error: cached browse + downloaded-game launch keep working, and any saves made
// offline will sync on reconnect. Self-hides when online so the normal case is
// untouched. Reads connection/snapshot_fetched_at/pending_saves from
// get_service_status (see main.py get_service_status).
// "Your library moved on RomM" — the announce half of the detect/apply split.
// Same frame as OfflineBanner (dot + title + detail, identical geometry) so the
// library never has two visual grammars for "something is up", with one action
// on the right. Deliberately NOT a toast: a toast is a fire-and-forget report of
// something that already happened, and this is a standing offer that has to
// survive being ignored, tabbed away from, and come back to.
function StaleLibraryBanner({ status }: { status: any }) {
  const stale = useStaleLibrary();
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  // A fetch in flight already draws the loading banner, and stacking this on
  // top would offer an Update button for work that is running.
  if (!stale || status?.library_progress) return null;

  const bits = [];
  if (stale.added) bits.push(`${stale.added.toLocaleString()} added`);
  if (stale.removed) bits.push(`${stale.removed.toLocaleString()} removed`);
  // Name the platforms while the list is short enough to read — that is what
  // turns "something changed" into "I know what this is and whether I care".
  // The SUBJECT of the headline, not a trailing clause: as a suffix on the
  // second line it landed as "from your last sync in Game Boy Advance", which
  // reads as though the sync itself happened in GBA.
  const what = stale.platforms.length === 0 ? 'Your library'
    : stale.platforms.length <= 3 ? stale.platforms.join(', ')
      : `${stale.platforms.length} platforms`;

  const onUpdate = async () => {
    if (busy) return;
    setBusy(true);
    try { await _applyStaleUpdate(); } finally { setBusy(false); }
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px',
      margin: '0 16px 8px', padding: '8px 12px',
      background: V2.surface, border: `1px solid ${V2.borderStrong}`,
      borderRadius: V2.radiusMd, fontSize: '12px',
    }}>
      <div style={{
        width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
        background: V2.brand, boxShadow: `0 0 6px ${V2.brand}`,
      }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, color: V2.fg }}>
          {/* Row counts, pre-grouping — so this says what changed on the
              server, not how many library entries will appear. */}
          {bits.length ? `${what} changed on RomM — ${bits.join(', ')}`
            : `${what} changed on RomM`}
        </div>
        <div style={{ color: V2.fgMuted, marginTop: '1px' }}>
          {busy
            ? 'Fetching the platforms that changed…'
            : "You're still seeing your last sync."}
        </div>
      </div>
      <Focusable noFocusRing
        onActivate={onUpdate} onClick={onUpdate}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
        style={{
          flexShrink: 0, padding: '5px 14px', borderRadius: V2.radiusPill,
          cursor: busy ? 'default' : 'pointer', fontSize: '12px', fontWeight: 700,
          whiteSpace: 'nowrap', opacity: busy ? 0.6 : 1,
          background: focused ? V2.brandHover : V2.brand, color: '#fff',
          border: `1px solid ${focused ? V2.brandHover : V2.brand}`,
          transition: 'background 0.15s, border-color 0.15s',
        }}>
        {busy ? 'Updating…' : 'Update'}
      </Focusable>
    </div>
  );
}

function OfflineBanner({ status }: { status: any }) {
  const conn = status?.connection;
  // A library fetch in flight is worth a banner even when the connection is
  // healthy — that IS the normal case, since auth completes long before the
  // fetch does. Without this the loading state was unreachable in practice.
  // ...but only when there is nothing else to look at. From the second run on,
  // the library is already on screen and the sticky fetch toast is narrating
  // the walk wherever the user goes — the banner then said the same thing a
  // second time, directly above it. On a first run the toast can't do the job
  // alone: the page behind it is empty, and the emptiness is the thing that
  // needs explaining. So the progress-only banner is the first-run banner.
  const loading = status?.library_progress && !status?.snapshot_fetched_at;
  if (!conn || (conn === 'online' && !loading)) return null;

  // Distinguish "the Deck has no internet" from "the Deck is online but the
  // RomM server isn't responding" — same offline browse experience, but the
  // cause (and what the user should check) is different.
  const reason = status?.unreachable_reason;
  const airplane = reason === 'airplane_mode';
  // 'airplane_mode' and 'no_network' share the "device has no connectivity"
  // experience; only the remedy copy differs (toggle airplane vs. join a
  // network). 'server_unreachable' is the device-online-but-server-down case.
  const noNetwork = airplane || reason === 'no_network';
  const pending = status?.pending_saves || 0;

  // Short title fragment + remedy sentence for the no-connectivity cases.
  const netTitle = airplane ? 'Airplane mode is on' : 'No internet connection';
  const netRemedy = airplane
    ? 'Turn off airplane mode to browse your library and sync saves.'
    : 'Connect to a network to browse your library and sync saves.';

  let dot = V2.warning, title = '', detail = '';
  if (conn === 'connecting' || (conn === 'online' && loading)) {
    dot = V2.fgMuted;
    // Connecting is over in well under a second; the rest of the wait is the
    // library, so say so and put a number on it. A count that moves is what
    // separates "busy" from "hung" — which is the whole reason a big library
    // felt broken. No percentage bar: it implies an ETA we can't honour when
    // the server stalls mid-fetch.
    const prog = status?.library_progress;
    // Nothing has ever been fetched, so there is nothing downloaded to fall
    // back on — the "play your downloaded games meanwhile" line is only true
    // from the second run onward, and on a first run it points at an empty
    // library. snapshot_fetched_at is present in both status branches and is
    // null until a fetch has succeeded once.
    const firstRun = !status?.snapshot_fetched_at;
    const meanwhile = firstRun ? '' : ' — you can play your downloaded games meanwhile';
    if (prog?.platform_name && prog?.platform_total > 0) {
      // A scoped walk — reconciliation re-reading the platforms that actually
      // changed, not the library. The banner used to report only the raw
      // counter, so a 17,000-ROM c64 walk looked identical to a full fetch of
      // a library that size and gave no hint why it was happening. The toast
      // has carried platform_name/index all along; this is the same payload.
      title = 'Updating your library…';
      detail = `${prog.platform_name} — `
        + `${(prog.platform_loaded ?? 0).toLocaleString()} of `
        + `${prog.platform_total.toLocaleString()}`
        + (prog.platform_count > 1 ? ` · platform ${prog.platform_index} of ${prog.platform_count}` : '')
        + `${meanwhile}.`;
    } else if (prog?.total > 0) {
      title = 'Loading your library…';
      detail = `${(prog.loaded ?? 0).toLocaleString()} of ${prog.total.toLocaleString()} games${meanwhile}.`;
    } else {
      title = prog ? 'Loading your library…' : 'Connecting to RomM…';
      detail = firstRun
        ? 'This can take a minute on a large library.'
        : 'Your downloaded games are ready to play in the meantime.';
    }
  } else if (conn === 'offline_cached') {
    dot = V2.warning;
    title = noNetwork
      ? `${netTitle} — showing your downloaded games`
      : "Can't reach your RomM server — showing your downloaded games";
    detail = noNetwork
      ? `Only games saved on this device are shown. ${netRemedy} Your full library and saves sync when you’re back online.`
      : 'The server isn’t responding. Only games saved on this device are shown; everything syncs once it’s reachable.';
  } else { // 'disconnected' — no cached library to show
    dot = V2.danger;
    title = noNetwork ? netTitle : "Can't reach your RomM server";
    detail = noNetwork
      ? netRemedy
      : 'Your device is online but the RomM server isn’t responding. Check that it’s running and reachable.';
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px',
      margin: '0 16px 8px', padding: '8px 12px',
      background: V2.surface, border: `1px solid ${V2.borderStrong}`,
      borderRadius: V2.radiusMd, fontSize: '12px',
    }}>
      <div style={{
        width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
        background: dot, boxShadow: `0 0 6px ${dot}`,
      }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: V2.fg }}>{title}</div>
        <div style={{ color: V2.fgMuted, marginTop: '1px' }}>{detail}</div>
        {conn !== 'connecting' && pending > 0 && (
          <div style={{ color: V2.brandHover, marginTop: '4px', fontWeight: 600 }}>
            {pending === 1 ? '1 game waiting to sync' : `${pending} games waiting to sync`}
          </div>
        )}
      </div>
    </div>
  );
}

// Route component for /romm-sync-library. Hosts the tabs page permanently and
// stacks the inner pages (game grid, game detail, settings family) on top as
// internal views, so backing out of any of them re-shows the still-mounted
// tabs tree instead of rebuilding it (see the LibView comment above).
function LibraryRootPage() {
  const [stack, setStack] = useState<LibView[]>([]);
  const viewRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setLibViewHooks(
      (v) => setStack((s) => [...s, v]),
      () => setStack((s) => s.slice(0, -1)),
    );
    return () => setLibViewHooks(null, null);
  }, []);

  // Logged-out guard: after a logout the credentials are cleared, but the tile
  // still launches straight into this route (and Back can land here too). If
  // RomM is no longer configured, don't show a stale signed-out home — bounce to
  // the setup wizard so the only way forward is signing back in.
  useEffect(() => {
    (async () => {
      try {
        const c = await getConfig();
        if (!c?.configured) {
          try { Navigation.NavigateBack(); } catch { /* ignore */ }
          setTimeout(() => { try { Navigation.Navigate("/romm-sync-setup"); } catch { /* ignore */ } }, 60);
        }
      } catch { /* ignore */ }
    })();
  }, []);
  const top = stack.length ? stack[stack.length - 1] : null;

  // An internally pushed view gets no route-change focus pass from Steam (that
  // only happens on real navigation), so pull gamepad focus onto its first
  // focusable element — unless the page's own autofocus (e.g. the grid's first
  // tile) already landed inside it. On pop, no work is needed here: the tab
  // panels' useAutoFocus re-fires when their `visible` flips back on and lands
  // on the first item, exactly what a route remount used to do.
  useEffect(() => {
    if (!top) return;
    const timers = [80, 240, 500].map((d) => setTimeout(() => {
      try {
        const host = viewRef.current;
        if (!host) return;
        const cur = _gpFocusEl();
        if (cur && host.contains(cur)) return;
        const first = host.querySelector('[tabindex]') as HTMLElement | null;
        if (first) _forceGamepadFocus(first);
      } catch { /* ignore */ }
    }, d));
    return () => timers.forEach(clearTimeout);
  }, [top]);

  return (
    <>
      {/* Never unmounts while inside the library — that's the whole point.
          NOTE display:none does NOT remove hidden Focusables from gamepad nav
          (verified on-device — they linger as 0×0 "phantom" focus targets);
          the tiles opt out themselves via focusable={visible}. */}
      <div style={{ display: top ? 'none' : undefined }}>
        <LibraryGroupsPage covered={!!top} />
      </div>
      {top && (
        <div ref={viewRef}>
          {top === 'grid' && <LibraryGamesPage />}
          {top === 'game' && <GameDetailPage />}
          {top === 'settings' && <SettingsPage />}
          {top === 'stats' && <StatsPage />}
          {top === 'cores' && <CoresPage />}
          {top === 'bios' && <BiosPage />}
          {top === 'downloads' && <DownloadsPage />}
        </div>
      )}
    </>
  );
}

function LibraryGroupsPage({ covered = false }: { covered?: boolean }) {
  // Reaching the library is the success signal for the post-update "reopen Home"
  // breadcrumb — consume it here (not on plugin load) so it survives the double
  // reload the installer causes. See the _LS_REOPEN_HOME consumer in definePlugin.
  useEffect(() => { try { localStorage.removeItem(_LS_REOPEN_HOME); } catch { /* ignore */ } }, []);
  // Opening the Game Browser counts as "using RomM": surface the tile in the
  // home row's Recent Games even when no emulator session runs this visit.
  useEffect(() => { host.launcher.markRecentlyUsed(); }, []);
  const [active, setActive] = useState<NavId>(getLibLastTab());
  const [bgUri, setBgUri] = useState<string | null>(null);
  const svcStatus = useServiceStatus();

  // Staleness check lives here, at the page root, NOT in a panel. It used to
  // fire from GroupsPanel's platform mode, so the banner only appeared once you
  // happened to visit Platforms — Home could sit on an out-of-date library
  // indefinitely without a word. The banner has always rendered above all four
  // tabs; only its trigger was tab-bound. Re-runs when the status poll changes
  // the fields it gates on; _maybeCheckStale owns its own throttle and
  // already-announced guard, so extra calls are free.
  const svcRef = useRef(svcStatus);
  svcRef.current = svcStatus;
  useEffect(() => {
    _maybeCheckStale(svcStatus);
  }, [svcStatus?.connection, svcStatus?.library_ready, !!svcStatus?.library_progress]);
  // ...plus a tick, because the deps above can stay put for hours while someone
  // browses. The interval is deliberately shorter than _STALE_CHECK_MS and does
  // no work of its own — it just gives the throttle something to fire on when
  // the window comes round.
  useEffect(() => {
    const t = setInterval(() => _maybeCheckStale(svcRef.current), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // Panels mount lazily on first visit, then STAY mounted (hidden with
  // display:none) — see GroupsPanel's comment for the measured remount cost.
  const seenRef = useRef<Record<string, boolean>>({});
  seenRef.current[active] = true;
  const seen = seenRef.current;

  // Home rows carry their own mode + sibling list (independent of the active tab).
  const openGroupFrom = (m: string, g: LibGroup, gs: LibGroup[]) => {
    setLibGroupHolder({ mode: m, group: g });
    setLibGroupsHolder({ mode: m, groups: gs });
    if (!pushLibView('grid')) Navigation.Navigate(`/romm-sync-library/${encodeURIComponent(g.key)}`);
  };

  const openGame = (g: LibGame) => {
    setLibGameHolder(g);
    // Opened from the home/search/index grid → back returns to the library root.
    setLibGameOrigin("/romm-sync-library");
    if (!pushLibView('game')) Navigation.Navigate(`/romm-sync-game/${g.rom_id}`);
  };

  const onTab = (id: NavId) => { setLibLastTab(id); setActive(id); };

  // L1 / R1 page through the nav tabs (BackgroundArt cleared on home/search).
  // After switching, the active panel remounts and drops gamepad focus, so we
  // re-anchor focus on the persistent active nav pill — otherwise Steam eats the
  // next bumper press to re-acquire focus (the "press twice to switch" bug).
  const navPillRef = useRef<any>(null);

  // Returning from an emulator session: the session-end watch navigated here,
  // but after a game exits Steam re-acquires gamepad focus onto its own chrome
  // on a slower schedule than a plain tab switch — the page renders with no
  // visible selection and the dpad does nothing predictable. Pull focus onto
  // the persistent nav pill with a longer retry tail than useAutoFocus.
  //
  // Armed as an EVENT, not only on mount: launching from a tile never leaves
  // this route, so on the way back the page is still mounted and a mount-only
  // effect never runs. It still fires on mount too, for the remount case.
  const returnFocusIv = useRef<any>(null);
  const runReturnFocusRestore = () => {
    if (!host.launcher.consumeReturnFocus()) return;
    if (returnFocusIv.current) clearInterval(returnFocusIv.current);
    // Steam's input pipeline swallows the first button press after a session
    // to wake itself back up (the "press twice" bug: LB/RB, dpad, anything).
    // Feed it a sacrificial virtual press of an unbound button (INVALID=0) so
    // the wake-up happens now and the user's first real press lands.
    host.focus.wakeInput();
    // After a game exits Steam often parks gamepad focus on our ROOT Focusable
    // (noFocusRing — buttons respond but nothing is highlighted) or on its own
    // chrome, so "some element has .gpfocus" is not success. Poll and re-assert
    // focus onto the target, but ONLY while focus is somewhere unhelpful — the
    // nav pill fallback or outside our UI (Steam chrome). The instant focus is
    // on any real element inside our content (the target, OR a sibling tile the
    // user has already navigated to), hand off and stop: re-forcing then would
    // yank the user back to the first tile the moment they press a direction
    // (the "press right → snaps back to the first game" bug). Give up after 8s.
    const started = Date.now();
    const iv = setInterval(() => {
      try {
        if (Date.now() - started > 8000) { clearInterval(iv); return; }
        // Prefer the tile of the game just played, so returning lands where the
        // user left off rather than at the top of the list. It may legitimately
        // be absent — the grid re-renders on the way back, and a filtered or
        // paged list may not include it — so fall through to the old targets.
        //
        // "Usable" is stricter than connected: the panels stay MOUNTED when
        // hidden (display:none) and opt out of gamepad nav, so a tile from a
        // tab or a covered panel is still in the map and still connected while
        // being impossible to focus — forcing focus onto one lands nowhere.
        const usable = (el: any) => el && el.isConnected && el.offsetParent !== null;
        const played = lastLaunchedRomId() != null
          ? _tileElsByRomId.get(lastLaunchedRomId()!) : null;
        const first = _autoFocusFirstRef?.current;
        const target = usable(played) ? played
          : usable(first) ? first : navPillRef.current;
        const cur = _gpFocusEl();
        // Done: focus reached a REAL target tile (not the nav-pill fallback,
        // which is invisible — keep polling for the real first item then).
        const onRealTarget = target && target !== navPillRef.current;
        if (onRealTarget && cur && (cur === target || (typeof target.contains === 'function' && target.contains(cur)))) { clearInterval(iv); return; }
        // Hand off: focus is on a real element inside our content that isn't the
        // nav-pill fallback — the user is now driving, don't fight them.
        const inOurUI = cur && typeof (cur as any).closest === 'function' && (cur as any).closest('.romm-ui');
        const onNavPill = cur && navPillRef.current && (cur === navPillRef.current || (typeof navPillRef.current.contains === 'function' && navPillRef.current.contains(cur)));
        if (inOurUI && !onNavPill) { clearInterval(iv); return; }
        // Otherwise focus is nowhere useful (null / Steam chrome / nav pill) —
        // keep pulling it to the target.
        if (target) _forceGamepadFocus(target);
      } catch { /* ignore */ }
    }, 250);
    returnFocusIv.current = iv;
  };
  // Keep the callback the subscription sees current (it closes over navPillRef,
  // which is stable, but not over anything a stale render would get wrong).
  const returnFocusRef = useRef(runReturnFocusRestore);
  returnFocusRef.current = runReturnFocusRestore;
  useEffect(() => {
    const fire = () => returnFocusRef.current();
    const unsubscribe = host.launcher.onReturnFocus(fire);
    // Mount path: a session that DID unmount this route (launched from the game
    // detail page, or Steam navigated away) arms the flag while nobody is
    // subscribed, so the pending flag has to be checked here as well.
    fire();
    return () => {
      unsubscribe();
      if (returnFocusIv.current) clearInterval(returnFocusIv.current);
    };
  }, []);

  const cycle = (dir: -1 | 1) => {
    const i = NAV_ORDER.indexOf(active);
    const next = NAV_ORDER[(i + dir + NAV_ORDER.length) % NAV_ORDER.length];
    playSteamSound('deck_ui_tab_transition_01');   // native LB/RB tab-switch sound
    setLibLastTab(next);
    setActive(next);
    // Bridge the remount gap with a SINGLE pill focus, then hand off to the new
    // panel's useAutoFocus (which retries onto its first item). This timer fires
    // before the panel mounts, so its useAutoFocus runs afterwards and wins the
    // final resting place — the first tile/field, matching a fresh tab switch.
    // Don't keep re-focusing the pill on a retry ladder: that raced useAutoFocus
    // and yanked focus back to the pill after the panel had already moved it,
    // leaving BOTH the pill and the first item highlighted (the double-focus).
    // The lone pill focus only lingers while the destination is still loading
    // (no item to focus yet); once it loads, useAutoFocus takes over.
    // _forceGamepadFocus, not plain focus(): post-session the window is
    // OS-unfocused (no DOM focus events), so focus() moves nothing gamepad-wise
    // and Steam eats the next bumper press re-acquiring focus.
    setTimeout(() => { try { if (navPillRef.current) _forceGamepadFocus(navPillRef.current); } catch { } }, 0);
  };

  // Top-bar chrome (account + RetroDECK) is fetched here — not inside V2NavBar —
  // so the same data drives the visible pills AND the controller shortcuts below.
  // The side clusters (RetroDECK button, user pill) sit in separate grid columns
  // that Steam's directional focus can't reliably reach from the content grid, so
  // we expose them as buttons too: Y opens the user menu, X launches RetroDECK.
  const chrome = useNavChrome();
  const launchRd = async () => {
    try {
      const r = await host.launcher.launchRetroDeck();
      if (r.ok) { try { Navigation.CloseSideMenus(); } catch { /* ignore */ } }
      else toaster.toast({ title: 'RetroDECK', body: r.reason || 'Launch failed' });
    } catch (e) { toaster.toast({ title: 'RetroDECK', body: String(e) }); }
  };
  const openUserMenu = () => showModal(
    <UserMenuModal username={chrome.username} role={chrome.role} avatar={chrome.avatar} />,
  );
  // Which platform tile (if any) currently holds gamepad focus — decides what Y
  // does and what the footer calls it.
  const focusedPlatform = useFocusedPlatform();
  const platformY = active === 'platforms' && !!focusedPlatform;

  const onButtonDown = (evt: any) => {
    const b = evt?.detail?.button;
    if (b === GamepadButton.BUMPER_LEFT) cycle(-1);
    else if (b === GamepadButton.BUMPER_RIGHT) cycle(1);
    else if (b === GamepadButton.SELECT) { playSteamSound('deck_ui_show_modal'); libNavigate("/romm-sync-settings"); }
    else if (b === GamepadButton.START) openUserMenu();                 // ☰ Start → account menu
    // L2/R2 → alphabet fast-scroll on the platform/collection grids (repeats
    // allowed so holding the trigger keeps scrubbing).
    else if (b === GamepadButton.TRIGGER_LEFT || b === GamepadButton.TRIGGER_RIGHT) {
      if (active === 'platforms' || active === 'collections') {
        _libLetterJump?.(b === GamepadButton.TRIGGER_RIGHT ? 1 : -1);
      }
    }
  };
  // X → RetroDECK, but through Steam's action-button dispatch (NOT the raw
  // onButtonDown hook): onButtonDown sees every press in the tree, so it also
  // fired when X was pressed on a game tile whose own onSecondaryButton opens
  // the detail page — the tile opened Details AND RetroDECK launched over it.
  // As an action handler, the focused tile consumes X first and this only runs
  // when nothing focused claims it.
  const onSecondary = chrome.rdEnabled ? launchRd : undefined;

  // Y → the focused platform's own menu when there is one, account menu
  // otherwise. Same reason X goes through the action-button dispatch rather
  // than onButtonDown: onButtonDown sees every press in the tree, so a Y press
  // on a home tile ran the tile's Delete AND opened the account menu over it
  // (and again over the delete confirmation). As an action handler this only
  // runs when nothing focused claims Y — game tiles claim it while a game is
  // downloaded; platform tiles don't, so their menu still opens from here.
  const onOptions = () => {
    if (active === 'platforms' && focusedPlatform) focusedPlatform.open();
    else openUserMenu();
  };

  // B at the library root: consume it and leave the plugin UI deliberately.
  // Every inner page "backs out" by PUSHING /romm-sync-library (Steam's default
  // NavigateBack misbehaves on custom Decky routes), so the history stack fills
  // with our own routes — letting Steam's default back run here popped that
  // stack and bounced the user between home and the page they just left,
  // endlessly. Exiting to Steam's library breaks the loop.
  const onExit = navExitPlugin;

  // Surface the page-level shortcuts in Steam's NATIVE bottom hint bar (not a
  // custom overlay). Settings goes through actionDescriptionMap because Select
  // (the View button) has no dedicated on*ActionDescription prop — and Steam
  // slots that map entry into the far-left navigation cluster of the footer,
  // ahead of the A/B/X/Y group. Account (Y) and RetroDECK (X) use their standard
  // named props. Set on the root Focusable so the labels show for the whole
  // library regardless of which tile is focused (a focused tile only overrides
  // the specific buttons it defines).
  return v2Page(
    <Focusable noFocusRing onButtonDown={onButtonDown}
      onSecondaryButton={onSecondary} onOptionsButton={onOptions} onCancelButton={onExit}
      actionDescriptionMap={{ [GamepadButton.SELECT]: 'Settings', [GamepadButton.START]: 'Account' }}
      onOptionsActionDescription={platformY ? 'Platform' : 'Account'}
      onSecondaryActionDescription={chrome.rdEnabled ? 'RetroDECK' : undefined}>
      <V2NavBar active={active} onTab={onTab} activeRef={navPillRef} chrome={chrome} onLaunchRd={launchRd} />

      <div style={{ height: '8px' }} />

      <OfflineBanner status={svcStatus} />
      <StaleLibraryBanner status={svcStatus} />

      {/* All four panels stay mounted once visited; only the active one is
          displayed. Unmounting on switch rebuilt every cover <img> and cost
          ~100–200ms long tasks per switch (measured on-device). `covered`
          (an inner view is stacked on top of this whole page) gates `visible`
          too, so a hidden panel's useAutoFocus can't steal gamepad focus from
          the view above when a silent refetch changes its first item. */}
      <div style={{ display: active === 'home' ? undefined : 'none' }}>
        {seen['home'] && <HomePanel visible={!covered && active === 'home'} onOpen={openGame} onOpenGroup={openGroupFrom} onBg={setBgUri} />}
      </div>
      <div style={{ display: active === 'platforms' ? undefined : 'none' }}>
        {seen['platforms'] && <GroupsPanel mode="platform" visible={!covered && active === 'platforms'} onOpenGroup={openGroupFrom} svcStatus={svcStatus} />}
      </div>
      <div style={{ display: active === 'collections' ? undefined : 'none' }}>
        {seen['collections'] && <GroupsPanel mode="collection" visible={!covered && active === 'collections'} onOpenGroup={openGroupFrom} svcStatus={svcStatus} />}
      </div>
      <div style={{ display: active === 'search' ? undefined : 'none' }}>
        {seen['search'] && <SearchPanel visible={!covered && active === 'search'} onOpen={openGame} onBg={setBgUri} />}
      </div>
    </Focusable>,
    bgUri,
  );
}

function LibraryGamesPage() {
  const holder = getLibGroupHolder();
  const mode = holder?.mode || 'platform';
  const [group, setGroup] = useState<LibGroup | null>(holder?.group || null);
  const cacheKey = (k: string) => `${mode}:${k}`;
  const cached0 = group ? _libGamesCache.get(cacheKey(group.key)) : undefined;
  const [games, setGames] = useState<LibGame[]>(cached0 || []);
  const [loading, setLoading] = useState(!cached0);
  const [bgUri, setBgUri] = useState<string | null>(null);

  // Sibling groups (same mode) so the game grid can page prev/next with L1/R1.
  const heldGroups = getLibGroupsHolder();
  const siblings = heldGroups && heldGroups.mode === mode ? heldGroups.groups : [];

  // Prefetch a neighbour group's games LIST only (cheap, small JSON) so an
  // L1/R1 page lands instantly. Covers are deliberately NOT warmed here — those
  // tiles aren't on screen, and warming ~18 covers per neighbour fetched ~70
  // covers (≈14MB of base64) for platforms the user never opened, which is what
  // caused the load freeze. Each tile fetches its own cover when it mounts.
  const prefetch = async (key: string) => {
    const ck = cacheKey(key);
    if (_libGamesCache.get(ck)) return;
    try {
      const res = await getLibraryGames(mode, key);
      const list: LibGame[] | null = res?.success ? (res.games || []) : null;
      if (list) libCacheSet(ck, list);
    } catch { /* best-effort prefetch */ }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!group) { setLoading(false); return; }
      setBgUri(null);
      const ck = cacheKey(group.key);
      const hit = _libGamesCache.get(ck);
      if (hit) {
        // Instant: real covers slide in with the carousel, no pop-in.
        setGames(hit); setLoading(false);
        // …then silently reconcile against the backend. The cache survives
        // restarts (localStorage), so a game deleted off-device in a previous
        // session would otherwise keep showing as downloaded until the 24h TTL —
        // and launching it fails ("not downloaded"). Refetch and, if the
        // download state (or membership) drifted, repaint from truth.
        (async () => {
          try {
            const res = await getLibraryGames(mode, group.key);
            if (!alive || !res?.success) return;
            const fresh: LibGame[] = res.games || [];
            const changed = fresh.length !== hit.length ||
              fresh.some((g, i) => g.rom_id !== hit[i]?.rom_id ||
                                   !!g.is_downloaded !== !!hit[i]?.is_downloaded);
            if (changed) { libCacheSet(ck, fresh); setGames(fresh); }
          } catch { /* offline / transient — keep the cached paint */ }
        })();
      } else {
        setLoading(true);
        try {
          const res = await getLibraryGames(mode, group.key);
          if (res?.success) libCacheSet(ck, res.games || []);
          if (alive) setGames(res?.success ? (res.games || []) : []);
        } catch (e) {
          console.error('get_library_games failed', e);
          if (alive) setGames([]);
        } finally {
          if (alive) setLoading(false);
        }
      }
      // Warm the immediate neighbours so the next L1/R1 is instant.
      const i = siblings.findIndex((s) => s.key === group.key);
      if (i >= 0) {
        const nbrs = [siblings[i - 1], siblings[i + 1],
        siblings[(i + 1) % siblings.length], siblings[(i - 1 + siblings.length) % siblings.length]];
        for (const n of nbrs) if (n) prefetch(n.key);
      }
    })();
    return () => { alive = false; };
  }, [group?.key]);

  // Repaint from cache when a download/delete/refresh elsewhere flips a game's
  // state (libCacheSetDownloaded → _broadcastLibRefresh). Without this, a
  // launch-failure self-heal or a delete on another surface wouldn't update the
  // tiles mounted here until the group was re-entered.
  useEffect(() => {
    if (!group) return;
    const ck = cacheKey(group.key);
    const l = () => { const list = _libGamesCache.get(ck); if (list) setGames(list); };
    _libRefreshListeners.add(l);
    return () => { _libRefreshListeners.delete(l); };
  }, [group?.key]);

  // Once games load (initial entry or after L1/R1 paging), drop focus onto the
  // first tile so the user can navigate straight into the grid — no extra DOWN
  // press to leave the header carousel.
  const firstTileRef = useAutoFocus(!loading && games.length > 0, group?.key);

  // Progressive mount: a big platform (e.g. GBA = 480 games) mounted all tiles
  // in one commit → ~360ms layout before anything showed. Render the first
  // screenful immediately, then grow the count in chunks across frames so first
  // paint is fast and the rest fill in without blocking. Covers are viewport-
  // gated already, so off-screen appended tiles cost almost nothing.
  // On-demand mount (infinite scroll): rather than eagerly mounting all 480
  // tiles for a big platform (480 Focusable trees is inherently heavy, even
  // spread across frames), keep only what's reached. A sentinel below the last
  // rendered tile grows the count by a chunk whenever it nears the viewport, so
  // typically ~2-3 screens of tiles are mounted and the grid stays fluid.
  const GRID_FIRST = 30, GRID_CHUNK = 30;
  const [visN, setVisN] = useState(() => Math.min(games.length || 0, GRID_FIRST));
  useEffect(() => { setVisN(Math.min(games.length || 0, GRID_FIRST)); }, [group?.key]);
  // Focus-driven growth — the reliable trigger under gamescope. When the
  // focused tile nears the end of the mounted set, mount another chunk. (The IO
  // sentinel below stays as a touch-scroll fallback.) Stable identity via refs
  // so it doesn't invalidate memo(GameTile).
  const visNRef = useRef(visN); visNRef.current = visN;
  const gamesLenRef = useRef(games.length); gamesLenRef.current = games.length;
  const gamesRef = useRef(games); gamesRef.current = games;
  const onTileFocus = useRef((i: number) => {
    if (i >= visNRef.current - 12)
      setVisN((n) => Math.min(gamesLenRef.current, Math.max(n, i + 1 + GRID_CHUNK)));
  }).current;

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (visN >= games.length) return;
    const el = sentinelRef.current;
    const bump = () => setVisN((n) => Math.min(games.length, n + GRID_CHUNK));
    // ~one screen of lookahead — enough that tiles are ready just before you
    // reach them, without over-mounting rows you may never scroll to.
    if (!el || typeof IntersectionObserver === 'undefined') { bump(); return; }
    let io: IntersectionObserver | null = null;
    try {
      io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) bump(); },
        { rootMargin: '400px' });
      io.observe(el);
    } catch { bump(); }
    return () => { try { io?.disconnect(); } catch { } };
  }, [visN, games.length]);

  // Stable identity across renders so memo(GameTile) isn't invalidated every
  // time the page re-renders (e.g. on background-art / progress updates). The
  // latest `group` is read through a ref.
  const openGameImpl = (g: LibGame) => {
    setLibGameHolder(g);
    // Return to THIS collection/platform's games page when backing out.
    setLibGameOrigin(group ? `/romm-sync-library/${encodeURIComponent(group.key)}` : "/romm-sync-library");
    if (!pushLibView('game')) Navigation.Navigate(`/romm-sync-game/${g.rom_id}`);
  };
  const openGameImplRef = useRef(openGameImpl);
  openGameImplRef.current = openGameImpl;
  const openGame = useRef((g: LibGame) => openGameImplRef.current(g)).current;

  // Memoize the tile elements so a background-art re-render (setBgUri fires on
  // EVERY focus move) reuses the same element references instead of rebuilding
  // and re-diffing all `visN` tiles — that O(mounted) reconciliation per dpad
  // press is what made scrolling degrade as more tiles mounted. Recomputed only
  // when the game list or mounted count actually changes.
  // ---- L2/R2 letter scrubbing (same UX as the index grids) ---------------
  // Every mounted tile registers its DOM node; the jump grows visN first (the
  // target tile may not be mounted yet — the grid is virtualized) and then
  // retries focusing until the tile appears.
  const gameTileEls = useRef(new Map<number, any>());
  const gameTileRef = (romId: number, first: boolean) => (el: any) => {
    if (el) gameTileEls.current.set(romId, el); else gameTileEls.current.delete(romId);
    if (first) firstTileRef.current = el;
  };
  const [scrubLetter, setScrubLetter] = useState<string | null>(null);
  const scrubTimer = useRef<any>(null);
  const scrubFocusTimer = useRef<any>(null);
  useEffect(() => () => { clearTimeout(scrubTimer.current); clearTimeout(scrubFocusTimer.current); }, []);
  const showScrubRef = useRef<(l: string) => void>(() => { });
  showScrubRef.current = (l) => {
    setScrubLetter(l);
    clearTimeout(scrubTimer.current);
    scrubTimer.current = setTimeout(() => setScrubLetter(null), 750);
  };
  // Fast-scroll glimpse while this page is up (tiles report rapid focus moves).
  useEffect(() => {
    const gl = (l: string) => showScrubRef.current(l);
    _scrubGlimpse = gl;
    return () => { if (_scrubGlimpse === gl) _scrubGlimpse = null; };
  }, []);
  const scrubJump = (dir: 1 | -1) => {
    const list = gamesRef.current;
    if (!list.length) return;
    const focusEl = _gpFocusEl();
    let cur = -1;
    if (focusEl) {
      for (let i = 0; i < list.length; i++) {
        const el = gameTileEls.current.get(list[i].rom_id);
        if (el && el.contains(focusEl)) { cur = i; break; }
      }
    }
    if (cur < 0) cur = 0;
    const target = _scrubTargetIdx(list.map((g) => g.name), cur, dir);
    const g = list[target];
    if (target !== cur) {
      setVisN((n) => Math.min(gamesLenRef.current, Math.max(n, target + 1 + GRID_CHUNK)));
      const tryFocus = (attempt: number) => {
        const el = gameTileEls.current.get(g.rom_id);
        if (el) {
          _forceGamepadFocus(el);
          try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* ignore */ }
          playSteamSound('deck_ui_tab_transition_01');
        } else if (attempt < 8) scrubFocusTimer.current = setTimeout(() => tryFocus(attempt + 1), 80);
      };
      clearTimeout(scrubFocusTimer.current);
      tryFocus(0);
    }
    showScrubRef.current(_scrubLetterOf(g.name));
  };
  // -----------------------------------------------------------------------

  const gridTiles = useMemo(() => games.slice(0, visN).map((g, i) => (
    <GameTile key={g.rom_id} game={g} onOpen={openGame} onActiveCover={setBgUri}
      focusRef={gameTileRef(g.rom_id, i === 0)} index={i} onFocusIdx={onTileFocus} />
  )), [games, visN]);

  // L1 / R1 page through sibling groups (same mode) without backing out.
  // (`siblings` is declared above for the prefetch logic.)
  // Re-anchor focus on the persistent header row after paging — the games grid
  // remounts on group change and drops gamepad focus, which would otherwise make
  // Steam eat the next bumper press ("press twice to switch").
  const headerRef = useRef<any>(null);
  // The selected slot grows to fit its full label (no truncation); measure its
  // real width so the track translate keeps it perfectly centred.
  const selSlotRef = useRef<HTMLDivElement | null>(null);
  const [selW, setSelW] = useState(120);
  // Right-hand status column (count + synced dot, or live sync progress). It's
  // content-sized so the count never clips on smaller screens; we measure its
  // real width and mirror it to the left spacer so the carousel stays centred.
  const railRef = useRef<HTMLDivElement | null>(null);
  const [railW, setRailW] = useState(64);
  // Which carousel name slot holds gamepad focus — the unselected slots are
  // half-faded, so without an explicit focus tint, landing on one (UP from the
  // first grid row) read as "selection disappeared".
  const [focSlot, setFocSlot] = useState<string | null>(null);
  // Focus/hover state for the games-count action trigger, so it reads as a
  // pressable control rather than a static label.
  const [actHot, setActHot] = useState(false);
  // Direction of the last group change, so the games grid slides in from the same
  // side as the carousel — making the header + covers read as one moving surface.
  const [slideDir, setSlideDir] = useState<1 | -1>(1);
  const cycle = (dir: -1 | 1) => {
    if (!group || siblings.length < 2) return;
    const i = siblings.findIndex((s) => s.key === group.key);
    if (i < 0) return;
    const next = siblings[(i + dir + siblings.length) % siblings.length];
    setSlideDir(dir);
    setLibGroupHolder({ mode, group: next });
    setGroup(next);
    requestAnimationFrame(() => { try { if (headerRef.current) _forceGamepadFocus(headerRef.current); } catch { } });
  };
  // Collection auto-sync toggle (Y). Keyed by the group key — the name for
  // regular collections, the base64 id for virtual ones.
  // Optimistic local override layered over the backend's `synced` flag so the
  // header reflects the change instantly; backend persists it to settings.ini.
  const isCollection = mode === 'collection';
  // Virtual collections still can't be local-deleted wholesale here.
  const isVirtual = !!group?.virtual;
  const [syncOverrides, setSyncOverrides] = useState<Record<string, boolean>>({});
  const isSynced = isCollection && group
    ? (syncOverrides[group.key] ?? !!group.synced) : false;
  const toggleSync = async () => {
    if (!isCollection || !group) return;
    const name = group.key;
    const next = !(syncOverrides[name] ?? !!group.synced);
    setSyncOverrides((m) => ({ ...m, [name]: next }));
    try {
      const ok = await toggleCollectionSync(name, next);
      if (ok === false) throw new Error('backend declined');
      toaster.toast({ title: next ? 'Auto-sync on' : 'Auto-sync off', body: name });
    } catch (e) {
      setSyncOverrides((m) => ({ ...m, [name]: !next })); // revert
      toaster.toast({ title: 'Sync toggle failed', body: String(e) });
    }
  };

  // One-shot "Sync missing": download every game in this collection that isn't
  // already local, through the per-game download path (covers light up as they
  // go). Job state lives in the module-level _batchJobs so it survives leaving
  // and re-entering this page mid-batch.
  const syncJob = useBatchJob(group ? cacheKey(group.key) : null);
  const syncMissing = () => {
    if (!group || syncJob) return; // already running for this group
    const missing = games.filter((g) => !g.is_downloaded).map((g) => ({ id: g.rom_id, name: g.name }));
    if (missing.length === 0) { toaster.toast({ title: 'Nothing to sync', body: 'All games are already downloaded' }); return; }
    // Started from this page, but the toast can land long after the user has
    // navigated away — so it still needs a way back to this collection.
    const g = group, sibs = siblings;
    runCollectionBatch(cacheKey(group.key), missing, () => openGroupPage(mode, g, sibs));
  };

  // Re-pull the list when a batch completes anywhere (runCollectionBatch fires
  // _broadcastLibRefresh), so the dots update even if the batch was started
  // from a previous mount of this page or from a collection tile's menu.
  useEffect(() => {
    const l = () => { refreshGames(); };
    _libRefreshListeners.add(l);
    return () => { _libRefreshListeners.delete(l); };
  }, [group?.key]);

  // Re-fetch this group's games (bypassing the stale cache) so the downloaded
  // dots reflect games pulled in by a collection sync without a plugin restart.
  const refreshGames = async () => {
    if (!group) return;
    try {
      const res = await getLibraryGames(mode, group.key);
      if (res?.success) {
        const list: LibGame[] = res.games || [];
        libCacheSet(cacheKey(group.key), list);
        setGames(list);
      }
    } catch (e) { console.error('refreshGames failed', e); }
  };

  // Background auto-sync progress for THIS collection, polled from the backend so
  // the header reflects the CollectionSyncManager's downloads — not only the
  // frontend one-shot batch. build_sync_status emits sync_state/downloaded/total.
  // pct (when present) is the backend's fine-grained byte-level percent for the
  // collection, so the bar moves continuously rather than stepping per game.
  const [autoProg, setAutoProg] = useState<{ done: number; total: number; speed: number; pct: number | null } | null>(null);
  useEffect(() => {
    if (!isCollection || isVirtual || !group) { setAutoProg(null); return; }
    let alive = true;
    const tick = async () => {
      try {
        const st = await getServiceStatus();
        const col = (st?.collections || []).find((c: any) => c.name === group.key);
        if (!alive) return;
        if (col && col.sync_state === 'syncing' && typeof col.total === 'number') {
          setAutoProg({
            done: col.downloaded || 0, total: col.total, speed: col.speed || 0,
            pct: typeof col.downloaded_pct === 'number' ? col.downloaded_pct : null,
          });
        } else {
          // Just finished a backend auto-sync pass → refresh the dots once.
          setAutoProg((prev) => { if (prev) refreshGames(); return null; });
        }
      } catch { /* transient */ }
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [isCollection, group?.key]);

  // Fine-grained fill for the one-shot batch: poll the in-flight downloads (≤
  // concurrency) and sum their percentages AND speeds, so the bar advances
  // smoothly within each game and we get a live aggregate transfer rate.
  const [syncStats, setSyncStats] = useState<{ frac: number; speed: number }>({ frac: 0, speed: 0 });
  useEffect(() => {
    if (!syncJob) { setSyncStats({ frac: 0, speed: 0 }); return; }
    let alive = true;
    const tick = async () => {
      const active = syncJob.ids.filter((id) => _dlActive.has(id));
      let frac = 0, speed = 0;
      await Promise.all(active.map(async (id) => {
        try {
          const p = await getDownloadProgress(id);
          if (p) {
            if (typeof p.percent === 'number') frac += p.percent / 100;
            if (typeof p.speed === 'number') speed += p.speed;
          }
        } catch { /* transient */ }
      }));
      if (alive) setSyncStats({ frac, speed });
    };
    tick();
    const id = setInterval(tick, 350);
    return () => { alive = false; clearInterval(id); };
  }, [syncJob]);

  // Unified progress: the one-shot "Sync missing" batch takes precedence (it's
  // the user's explicit action), otherwise fall back to background auto-sync.
  const prog = syncJob
    ? { done: syncJob.done, total: syncJob.total, speed: syncStats.speed }
    : autoProg;
  // Fine-grained percent (0..100): one-shot uses completed + in-flight fraction;
  // auto-sync prefers the backend's byte-level pct, falling back to the ratio.
  const progPctRaw = !prog || !prog.total ? 0 : Math.min(100, Math.round(
    syncJob
      ? ((syncJob.done + syncStats.frac) / syncJob.total) * 100
      : (autoProg?.pct != null ? autoProg.pct : (prog.done / prog.total) * 100),
  ));
  // Monotonic clamp: at download boundaries the in-flight fraction and the
  // completed count update on different ticks, so the raw value can dip for a
  // beat (finished item leaves the fraction before done++ lands, or a new item
  // starts at 0). True batch progress never decreases — hold the max.
  const progPctMax = useRef(0);
  if (!prog) progPctMax.current = 0;
  else progPctMax.current = Math.max(progPctMax.current, progPctRaw);
  const progPct = prog ? progPctMax.current : 0;
  // Remaining-time estimate from the percentage velocity (works for both paths).
  const progEta = useEtaFromPct(progPct, !!prog);

  // Remove this collection's downloaded ROMs. Per the chosen UX: turn auto-sync
  // OFF first (so the worker doesn't immediately re-download), then delete the
  // local files. The dots clear via the setGames update below; we deliberately
  // do NOT remount the grid (that would replay the slide/fade animation).
  const [reloadTick] = useState(0);
  const doRemove = async () => {
    if (!group) return;
    const name = group.key;
    try {
      if (isSynced) {
        await toggleCollectionSync(name, false);
        setSyncOverrides((m) => ({ ...m, [name]: false }));
      }
      const ok = await deleteCollectionRoms(name, mode);
      if (ok === false) throw new Error('backend declined');
      // Clear download state for every affected ROM across ALL cached groups
      // (these games also live in their platform view / other collections),
      // then drop this group's own entry so it re-fetches fresh on next entry.
      for (const g of games) if (g.is_downloaded) libCacheSetDownloaded(g.rom_id, false);
      setGames((gs) => gs.map((g) => ({ ...g, is_downloaded: false })));
      libCacheDelete(cacheKey(name));
      _broadcastLibRefresh(); // Home/groups panels re-pull their downloaded counts
    } catch (e) {
      toaster.toast({ title: 'Remove failed', body: String(e) });
    }
  };

  // Press A / activate on the games-count opens the collection action menu,
  // styled in the v2 glass chrome (matching the account dropdown). The
  // destructive "Remove downloaded" arms on first select then commits on the
  // second — matching the game-tile delete affordance.
  const openActions = () => {
    const missing = games.filter((g) => !g.is_downloaded).length;
    const downloaded = games.filter((g) => g.is_downloaded).length;
    showModal(
      <CollectionActionsModal
        title={group?.label || 'Library'} isCollection={isCollection} isVirtual={isVirtual} isSynced={isSynced}
        platformSlug={!isCollection ? (group?.slug || '') : ''}
        missing={missing} downloaded={downloaded} syncing={!!syncJob}
        onSyncMissing={syncMissing} onToggleSync={toggleSync} onRemove={doRemove} />,
    );
  };

  const onButtonDown = (evt: any) => {
    const b = evt?.detail?.button;
    if (b === GamepadButton.BUMPER_LEFT) cycle(-1);
    else if (b === GamepadButton.BUMPER_RIGHT) cycle(1);
    // No page-level Y binding: Y is the tiles' delete button, and an invisible
    // "toggle auto-sync" shortcut here could silently kick off (or cancel) a
    // whole-collection download. Auto-sync lives in the actions menu (Start /
    // games-count rail) and on the collection tile's hinted Y in the index grid.
    else if (b === GamepadButton.SELECT) { playSteamSound('deck_ui_show_modal'); libNavigate("/romm-sync-settings"); }
    else if (b === GamepadButton.START) openActions();                  // ☰ Start → games-count actions menu (top-right)
    // L2/R2 → alphabet fast-scroll across the game grid.
    else if (b === GamepadButton.TRIGGER_LEFT || b === GamepadButton.TRIGGER_RIGHT) {
      scrubJump(b === GamepadButton.TRIGGER_RIGHT ? 1 : -1);
    }
  };
  // Back → library index. Use onCancelButton (not a CANCEL case in onButtonDown):
  // it CONSUMES the B press so Steam's default router-back doesn't ALSO fire and
  // pop us right back into this platform.
  const onBack = () => libBack("/romm-sync-library");

  const jumpTo = (g: LibGroup) => {
    const from = siblings.findIndex((s) => s.key === group?.key);
    const to = siblings.findIndex((s) => s.key === g.key);
    if (from >= 0 && to >= 0) setSlideDir(to >= from ? 1 : -1);
    setLibGroupHolder({ mode, group: g });
    setGroup(g);
  };

  if (!group) {
    return v2Page(<div style={{ padding: '16px', color: V2.fgMuted }}>No group selected.</div>);
  }

  const canPage = siblings.length > 1;
  const ci = siblings.findIndex((s) => s.key === group.key);
  // Sliding-track carousel: every sibling is a content-sized slot on a track
  // anchored at left:50%. We measure the selected slot's real centre offset and
  // translate the track by -that, so the selected name sits dead-centre no matter
  // its width. All slots show their full label (no truncation). Bumpers live
  // outside the clipped viewport so the edge fade never hides them.
  const DOTGAP = 16; // px gap on each side of a separator dot
  // Re-measure the selected slot's centre whenever the group/list changes.
  useLayoutEffect(() => {
    const el = selSlotRef.current;
    if (el) setSelW(el.offsetLeft + el.offsetWidth / 2);
  }, [group?.key, siblings.length]);

  // Width reserved for the right-hand status column (and mirrored by the left
  // spacer so the carousel stays screen-centred). While syncing it's a fixed
  // box so the per-second speed/ETA text doesn't resize it; otherwise we let it
  // size to its content and measure that real width so the count never clips.
  useLayoutEffect(() => {
    if (prog) { setRailW(188); return; }
    const el = railRef.current;
    if (el) setRailW(el.offsetWidth + 16); // + outer box's 12+4px horizontal padding
  }, [prog, games.length, isSynced, loading, group?.key]);

  return v2Page(
    <Focusable noFocusRing onButtonDown={onButtonDown} onCancelButton={onBack}
      actionDescriptionMap={{ [GamepadButton.START]: 'Actions' }}
      onOptionsActionDescription={isCollection && !isVirtual ? (isSynced ? 'Stop syncing' : 'Sync collection') : undefined}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 50,
        background: 'rgba(7,7,15,0.78)',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        borderBottom: `1px solid ${V2.border}`,
        padding: '6px 0',
      }}>
        <Focusable noFocusRing ref={headerRef} style={{
          display: 'flex', alignItems: 'center', height: '46px',
        }}>
          {/* Spacer mirrors the games-count column on the right so the carousel
              stays centred on the screen, not just within the flex row. */}
          <div style={{ flexShrink: 0, width: `${railW}px`, padding: '0 4px 0 12px', boxSizing: 'border-box', transition: 'width 0.32s cubic-bezier(0.22, 1, 0.36, 1)' }} />
          {canPage && <div style={{ flexShrink: 0, padding: '0 4px', zIndex: 2, display: 'flex', alignItems: 'center' }}><Bumper label="L1" /></div>}
          <div style={{
            position: 'relative', overflow: 'hidden', height: '100%', flex: 1,
            // Soft fade only at the inner edges, between bumpers and names.
            maskImage: 'linear-gradient(to right, transparent, #000 8%, #000 92%, transparent)',
            WebkitMaskImage: 'linear-gradient(to right, transparent, #000 8%, #000 92%, transparent)',
          }}>
            <div style={{
              position: 'absolute', top: 0, left: '50%', height: '100%',
              display: 'flex', alignItems: 'center',
              transform: `translateX(${-selW}px)`,
              transition: 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)',
            }}>
              {siblings.map((g, idx) => {
                const sel = idx === ci;
                return [
                  idx > 0 && (
                    <span key={`dot-${g.key}`} style={{
                      flexShrink: 0, padding: `0 ${DOTGAP}px`,
                      color: V2.fgMuted, opacity: 0.5, fontSize: '13px',
                    }}>·</span>
                  ),
                  <Focusable noFocusRing key={g.key} ref={sel ? selSlotRef : undefined}
                    onActivate={() => jumpTo(g)} onClick={() => jumpTo(g)}
                    onFocus={() => setFocSlot(g.key)} onBlur={() => setFocSlot((k) => (k === g.key ? null : k))}
                    style={{
                      flexShrink: 0, height: '100%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', boxSizing: 'border-box',
                      fontSize: sel ? '22px' : '14px',
                      fontWeight: sel ? 800 : 500,
                      letterSpacing: sel ? '-0.01em' : '0',
                      color: sel || focSlot === g.key ? V2.fg : V2.fgMuted,
                      opacity: sel ? 1 : (focSlot === g.key ? 0.95 : 0.5),
                      whiteSpace: 'nowrap',
                      transition: 'opacity 0.32s, color 0.32s',
                    }}>
                    <span style={{
                      padding: '4px 10px', borderRadius: V2.radiusPill,
                      background: !sel && focSlot === g.key ? 'rgba(255,255,255,0.10)' : 'transparent',
                      border: `1px solid ${!sel && focSlot === g.key ? V2.brand : 'transparent'}`,
                      transition: 'background 0.15s ease, border-color 0.15s ease',
                    }}>{g.label}</span>
                  </Focusable>,
                ];
              })}
            </div>
          </div>
          {canPage && <div style={{ flexShrink: 0, padding: '0 4px', zIndex: 2, display: 'flex', alignItems: 'center' }}><Bumper label="R1" /></div>}
          {/* Games count doubles as the collection action trigger: focus it and
              press A to open the actions menu (Sync missing). While a sync job is
              running it shows live progress instead of the static count. */}
          {/* Outer box owns the animated px width (and clips during the slide);
              the inner node keeps its natural width so we can measure the real
              content size without a feedback loop. Width changes — entering or
              leaving sync, or the count growing after a sync — glide instead of
              snapping, in step with the left spacer. */}
          <Focusable noFocusRing onActivate={openActions} onClick={openActions}
            onFocus={() => setActHot(true)} onBlur={() => setActHot(false)}
            onMouseEnter={() => setActHot(true)} onMouseLeave={() => setActHot(false)}
            style={{
              flexShrink: 0, width: `${railW}px`, boxSizing: 'border-box',
              // Vertical padding exists purely so the pill's focus ring has room:
              // `overflow: hidden` is here to clip the width slide, and with a
              // content-height box it cropped the ring off entirely, leaving only
              // the border to show focus.
              padding: '6px 12px 6px 4px', overflow: 'hidden',
              fontSize: '11px',
              cursor: 'pointer', transition: 'width 0.32s cubic-bezier(0.22, 1, 0.36, 1)',
              color: V2.fgMuted,
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
            }}>
            {/* The inner node reads as a pressable pill: subtle border + a
                trailing kebab so it's clearly a control, not a static count.
                Highlights on focus/hover. */}
            <div ref={railRef} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
              gap: '6px', whiteSpace: 'nowrap', flexShrink: 0, textAlign: 'right',
              // Roomier than the text needs: the tint is the hover affordance, so
              // it has to have some body to it. UserPill gets its height from a
              // 30px avatar rather than padding, so matching it means padding here.
              padding: '7px 14px', borderRadius: V2.radiusPill, boxSizing: 'border-box',
              // Same treatment as UserPill in the top bar — the other pill-shaped
              // menu trigger in the chrome. Kept literal rather than via V2Focus
              // so the two stay visibly identical; if one moves, move both.
              border: `1px solid ${actHot ? V2.brand : V2.borderStrong}`,
              boxShadow: actHot ? `0 0 0 1px ${V2.brand}` : 'none',
              background: actHot ? 'rgba(255,255,255,0.10)' : V2.surface,
              color: actHot ? V2.fg : V2.fgMuted,
              transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease',
            }}>
              {/* Synced indicator — same green dot as downloaded games/tiles. */}
              {isSynced && !prog && (
                <span style={{
                  width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                  background: V2.success, boxShadow: '0 0 0 2px rgba(0,0,0,0.45)',
                }} />
              )}
              {!loading && (prog
                ? `${progPct}%${prog.speed ? `   ·   ${formatSpeed(prog.speed)}` : ''}${formatEta(progEta) ? `   ·   ${formatEta(progEta)} left` : ''}`
                : `${games.length} ${games.length === 1 ? 'game' : 'games'}`)}
              {/* Kebab affordance — signals the count opens an actions menu. */}
              {!loading && !prog && (
                <FaEllipsisH size={10} style={{ flexShrink: 0, opacity: actHot ? 0.9 : 0.55 }} />
              )}
            </div>
          </Focusable>
        </Focusable>
        {/* Determinate sync bar — pinned to the header's bottom border, like
            Steam's achievement bar. The gradient is painted across the FULL
            width and revealed up to progPct (so the colour transition is visible
            at any fill level, not just the left stop). Fed by the unified,
            fine-grained model (one-shot batch + background auto-sync). */}
        {prog && prog.total > 0 && (
          <div style={{
            position: 'absolute', left: 0, right: 0, bottom: '-1px', height: '3px',
            overflow: 'hidden', background: 'rgba(255,255,255,0.12)',
          }}>
            {/* Gradient fill, clipped to progPct so it actually reflects progress. */}
            <div style={{
              height: '100%', width: `${progPct}%`,
              background: 'linear-gradient(90deg, #7c5cff 0%, #a18fff 45%, #5ce0ff 100%)',
              transition: 'width 0.3s ease',
            }} />
          </div>
        )}
      </div>

      {loading ? (
        <GamesGridSkeleton />
      ) : games.length === 0 ? (
        <div style={{ padding: '16px', color: V2.fgMuted, fontSize: '13px' }}>No games in this group.</div>
      ) : (
        <Focusable noFocusRing {...NAV_MAINTAIN_X}
          key={`${group.key}:${reloadTick}`}
          className={slideDir === 1 ? 'lib-slide-r' : 'lib-slide-l'}
          style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
            gap: '18px 16px', padding: '16px 16px 0',
          }}
        >
          {gridTiles}
          {visN < games.length && (
            <div ref={sentinelRef} style={{ gridColumn: '1 / -1', height: '1px' }} />
          )}
        </Focusable>
      )}
      <ScrubOverlay letter={scrubLetter} />
      <style>{`
        @keyframes libSlideR { from { transform: translateX(7%); } to { transform: translateX(0); } }
        @keyframes libSlideL { from { transform: translateX(-7%); } to { transform: translateX(0); } }
        @keyframes libFade { from { opacity: 0.55; } to { opacity: 1; } }
        .lib-slide-r { animation: libSlideR 0.34s cubic-bezier(0.22, 1, 0.36, 1) both, libFade 0.16s ease-out both; }
        .lib-slide-l { animation: libSlideL 0.34s cubic-bezier(0.22, 1, 0.36, 1) both, libFade 0.16s ease-out both; }
      `}</style>
    </Focusable>,
    bgUri,
  );
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
