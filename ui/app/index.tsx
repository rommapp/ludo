import {
  Navigation,
  DialogButton,
  Focusable,
  GamepadButton,
  showModal,
  ModalRoot,
  showContextMenu,
  Menu,
  MenuItem,
  toaster,
  routerHook,
  host,
} from "@ludo/host";
import { useState, useEffect, useLayoutEffect, useRef, useMemo, memo } from "react";
import { FaSync, FaTrash, FaCog, FaGithub, FaBug, FaUndo, FaCopy, FaGamepad, FaBookmark, FaHome, FaSearch, FaTimes, FaTimesCircle, FaDownload, FaPlay, FaInfoCircle, FaRegClock, FaLayerGroup, FaChevronLeft, FaChevronRight, FaCheckCircle, FaUsers, FaExternalLinkAlt, FaPuzzlePiece, FaBoxOpen, FaClone, FaRedo, FaClock, FaCheck, FaEllipsisH, FaGlobe, FaChevronDown, FaChartBar, FaSave, FaUser, FaExclamationTriangle, FaHistory, FaPowerOff, FaCloudUploadAlt, FaMicrochip, FaStopwatch, FaUnlink, FaFolder, FaLink } from "react-icons/fa";
import { MdFlashOn } from "react-icons/md";
import {
  ackLibraryAnnouncement,
  applyAppImageUpdate,
  checkForUpdate,
  checkLibraryStale,
  clearRecentActivity,
  deleteCollectionRoms,
  deleteGame,
  downloadBios,
  downloadCore,
  downloadGame,
  downloadUpdate,
  drainNotifications,
  emulatorInstallState,
  getAccountUsername,
  getAvatar,
  getBiosInventory,
  getCheckOnStartup,
  getConfig,
  getDownloadProgress,
  getEmulatorStatus,
  getFetchBenchmark,
  getGameDetail,
  getHomeData,
  getImage,
  getLibraryAutoUpdate,
  getLibraryGames,
  getLibraryGroups,
  getLocalDiscs,
  getLocalSiblings,
  getLoggingEnabled,
  getPlatformSync,
  getPluginVersion,
  getRaEarned,
  getRecentActivity,
  getResumeStateEnabled,
  getRetrodeckButtonEnabled,
  getRetrodeckLogo,
  getSaveHistory,
  getSaveScreenshot,
  getServiceStatus,
  getStateThumbnails,
  getSteamTileStatus,
  getSwitchAddOns,
  getSwitchAddonMode,
  getSwitchFirmwareProgress,
  getSyncEpoch,
  getSyncIndicator,
  getUpdateChannel,
  getVirtualCollectionsVisible,
  installEmulator,
  installSwitchFirmware,
  isDebugMode,
  launchGame,
  logout,
  notifyNetworkState,
  prepareSteamLaunch,
  rebuildLibrary,
  refreshFromRomm,
  repairEmulatorPaths,
  restoreSaveVersion,
  resyncPlatform,
  searchGames,
  setCheckOnStartup,
  setCoreOverride,
  setLibraryAutoUpdate,
  setPlatformSync,
  setResumeStateEnabled,
  setRetrodeckButtonEnabled,
  setSteamTile,
  setSwitchAddonMode,
  setSyncIndicatorRpc,
  setUpdateChannel,
  setVirtualCollectionsVisibleRpc,
  switchFirmwareStatus,
  switchPrereqForRom,
  timeColdFetch,
  toggleCollectionSync,
  updateLoggingEnabled,
} from "./rpc";
import { MdVerified } from "react-icons/md";
import { V2, fmtBytes, fmtReleaseDate, fmtAgo, formatEta, formatSpeed } from "./theme";
import { LibGroup, LibGame } from "./types";
import { _lsAvail, _LS_REOPEN_HOME } from "./storage";
import { _libRefreshListeners, _broadcastLibRefresh, _downloadedListeners } from "./events";
import { _LS_PLATICON, _coverInflight } from "./media";
import { setPreDownloadHook } from "./downloads";
import { V2_FOCUS_STYLE, V2Focus, v2Page } from "./focus";
import { NavId, LibView, navExitPlugin, libNavigate, libBack, RouteGuard } from "./nav";
import { setLibViewHooks, pushLibView } from "./nav";
import { StatsPage } from "./pages/stats";
import { DownloadsPage } from "./pages/downloads";
import { CoresPage } from "./pages/cores";
import { ConfigPage } from "./pages/config";
import { SetupWizard, FoldersSection} from "./pages/setup";
import {
  _subscribeStatus,
  refreshStatusNow,
  useCollectionSync,
  useOffline,
  useServiceStatus,
  useDownloadGlimpse, SaveActivity, _pushSaveActivity, useSaveActivity} from "./status";
import {
  useEtaFromPct,
  ProgressRing,
  PlatformIcon,
  UserMenuRow,
  Bumper,
  V2Button,
  GameActionButton,
  V2SearchField,
  V2SettingsSection,
  V2SettingsRow,
  V2Switch,
  V2Segment,
  UpdateActionBtn, _gameLabel, useRowHighlight,
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
  awaitDownload,
  _dlActive,
  _dlQueue,
  _dlSucceeded,
  _dlListeners,
  _setDlActive,
  downloadOne,
  _batchJobs,
  useBatchJob,
  runCollectionBatch,
  useIsDownloading,
  useDownloadProgress,
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
  GameCover,
  ScreenshotArt,
  CoverPip,
} from "./media";


// "2m 29s", not "149.3s" — this number gets read aloud in bug reports, and
// minutes are how people describe a fetch. Sub-minute keeps one decimal,
// because the difference between 3.2s and 3.8s is the whole story on a small
// library; past a minute that precision is noise, so seconds are rounded.
function fmtFetchDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '?';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  // Drop the seconds only when they round to exactly zero, so "5m" stays
  // readable but "5m 1s" never silently becomes "5m".
  return s ? `${m}m ${s}s` : `${m}m`;
}

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

// RomM GameActionBtn round buttons: glassy scrim with blur (default), or the
// "emphasized" white look used by Play. Circular; size in px.
function roundBtn(size: number, variant: 'glass' | 'emphasized' | 'danger'): any {
  const base: any = {
    width: `${size}px`, height: `${size}px`, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
    backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    transition: 'background 0.15s, color 0.15s, border-color 0.15s',
  };
  if (variant === 'emphasized') return { ...base, background: '#ffffff', border: '1px solid #ffffff', color: '#111117' };
  if (variant === 'danger') return { ...base, background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,80,80,0.55)', color: V2.danger };
  return { ...base, background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.95)' };
}


// Region/language code -> flag emoji, ported from RomM's
// frontend/src/utils/index.ts (regionToEmoji / languageToEmoji). RomM accepts
// both the short ROM-tag code ("u", "j", "e") and the spelled-out name, since
// which one a row carries depends on the naming convention the file came from.
// An unrecognised value falls through to itself, so it still shows as text
// rather than vanishing — same as RomM.
const REGION_EMOJI: Record<string, string> = {
  as: '🇦🇺', australia: '🇦🇺',
  a: '🌏', asia: '🌏',
  b: '🇧🇷', bra: '🇧🇷', brazil: '🇧🇷',
  c: '🇨🇦', canada: '🇨🇦',
  ch: '🇨🇳', chn: '🇨🇳', china: '🇨🇳',
  e: '🇪🇺', eu: '🇪🇺', eur: '🇪🇺', europe: '🇪🇺',
  f: '🇫🇷', france: '🇫🇷',
  fn: '🇫🇮', finland: '🇫🇮',
  g: '🇩🇪', germany: '🇩🇪',
  gr: '🇬🇷', greece: '🇬🇷',
  h: '🇳🇱', holland: '🇳🇱',
  hk: '🇭🇰', 'hong kong': '🇭🇰',
  i: '🇮🇹', italy: '🇮🇹',
  j: '🇯🇵', jp: '🇯🇵', japan: '🇯🇵',
  k: '🇰🇷', korea: '🇰🇷',
  nl: '🇳🇱', netherlands: '🇳🇱',
  no: '🇳🇴', norway: '🇳🇴',
  r: '🇷🇺', russia: '🇷🇺',
  s: '🇪🇸', spain: '🇪🇸',
  sw: '🇸🇪', sweden: '🇸🇪',
  t: '🇹🇼', taiwan: '🇹🇼',
  u: '🇺🇸', us: '🇺🇸', usa: '🇺🇸',
  uk: '🇬🇧', england: '🇬🇧',
  unk: '🌎', unknown: '🌎',
  unl: '🌎', unlicensed: '🌎',
  w: '🌎', global: '🌎', world: '🌎',
};
const LANGUAGE_EMOJI: Record<string, string> = {
  af: '🇿🇦', afrikaans: '🇿🇦',
  ar: '🇦🇪', arabic: '🇦🇪',
  be: '🇧🇾', belarusian: '🇧🇾',
  bg: '🇧🇬', bulgarian: '🇧🇬',
  ca: '🇦🇩', catalan: '🇦🇩',
  cs: '🇨🇿', czech: '🇨🇿',
  da: '🇩🇰', danish: '🇩🇰',
  de: '🇩🇪', german: '🇩🇪',
  el: '🇬🇷', greek: '🇬🇷',
  en: '🇬🇧', english: '🇬🇧',
  es: '🇪🇸', spanish: '🇪🇸',
  et: '🇪🇪', estonian: '🇪🇪',
  fi: '🇫🇮', finnish: '🇫🇮',
  fr: '🇫🇷', french: '🇫🇷',
  he: '🇮🇱', hebrew: '🇮🇱',
  hi: '🇮🇳', hindi: '🇮🇳',
  hr: '🇭🇷', croatian: '🇭🇷',
  hu: '🇭🇺', hungarian: '🇭🇺',
  hy: '🇦🇲', armenian: '🇦🇲',
  id: '🇮🇩', indonesian: '🇮🇩',
  is: '🇮🇸', icelandic: '🇮🇸',
  it: '🇮🇹', italian: '🇮🇹',
  ja: '🇯🇵', japanese: '🇯🇵',
  ko: '🇰🇷', korean: '🇰🇷',
  la: '🇻🇦', latin: '🇻🇦',
  lt: '🇱🇹', lithuanian: '🇱🇹',
  lv: '🇱🇻', latvian: '🇱🇻',
  mk: '🇲🇰', macedonian: '🇲🇰',
  nl: '🇳🇱', dutch: '🇳🇱',
  no: '🇳🇴', norwegian: '🇳🇴',
  pl: '🇵🇱', polish: '🇵🇱',
  pt: '🇵🇹', portuguese: '🇵🇹',
  ro: '🇷🇴', romanian: '🇷🇴',
  ru: '🇷🇺', russian: '🇷🇺',
  sk: '🇸🇰', slovak: '🇸🇰',
  sl: '🇸🇮', slovenian: '🇸🇮',
  sq: '🇦🇱', albanian: '🇦🇱',
  sr: '🇷🇸', serbian: '🇷🇸',
  sv: '🇸🇪', swedish: '🇸🇪',
  th: '🇹🇭', thai: '🇹🇭',
  tr: '🇹🇷', turkish: '🇹🇷',
  uk: '🇺🇦', ukrainian: '🇺🇦',
  vi: '🇻🇳', vietnamese: '🇻🇳',
  zh: '🇨🇳', chinese: '🇨🇳',
  nolang: '🌎', 'no language': '🌎',
};
function regionToEmoji(region: string): string {
  return REGION_EMOJI[(region || '').toLowerCase()] || region;
}
function languageToEmoji(language: string): string {
  return LANGUAGE_EMOJI[(language || '').toLowerCase()] || language;
}






// Save-state art — the same landscape box as ScreenshotArt, but for an image
// the caller already holds (get_state_thumbnail returns the bytes inline, so
// there is nothing left to fetch here).
function StateArt({ uri, onLoaded, onRatio }:
  { uri: string; onLoaded?: (uri: string | null) => void; onRatio?: (ratio: number) => void }) {
  useEffect(() => { onLoaded?.(uri); }, [uri]);
  return (
    <div style={{
      position: 'absolute', inset: 0, background: V2.coverPlaceholder,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <img src={uri}
        onLoad={(e: any) => {
          const w = e.target?.naturalWidth, h = e.target?.naturalHeight;
          if (w && h) onRatio?.(w / h);
        }}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
    </div>
  );
}


// Box art for a toast's logo slot, so a "Downloaded" notification shows the
// game rather than just naming it. The cover is nearly always already in
// `_coverCache` — the tile the user pressed painted it — so this renders on the
// first frame; a cache miss loads in behind nothing rather than reserving an
// empty box, and a rom with no art renders nothing at all, which lets the host
// fall back to its own icon instead of showing a grey rectangle.
function ToastCover({ romId, hasCover }: { romId: number; hasCover: boolean }) {
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


// Starts the detached install and polls it to completion, reporting progress
// as it goes. Returns the final state, so callers still read as "await the
// install" while the RPC socket stays free the whole time.
async function installSwitchFirmwareWatched(
  onTick?: (p: { phase: string; have: number; total: number; bps: number }) => void,
): Promise<any> {
  const start = await installSwitchFirmware();
  if (!start?.success) return start;
  // Poll a little under a second: the backend recomputes speed on roughly
  // that cadence, so asking faster returns the same numbers.
  for (;;) {
    await new Promise((r) => setTimeout(r, 700));
    let p: any;
    try { p = await getSwitchFirmwareProgress(); } catch { continue; }
    if (!p) continue;
    onTick?.({ phase: p.phase || '', have: p.have || 0, total: p.total || 0, bps: p.bps || 0 });
    if (!p.active) return p;
  }
}

// Human-readable transfer line: "142 / 325 MB · 8.4 MB/s". Speed is omitted
// until the backend has a sample worth showing rather than printing 0 MB/s.
function fmtFirmwareProgress(p: { phase: string; have: number; total: number; bps: number }): string {
  if (p.phase === 'installing') return 'Unpacking…';
  if (!p.total) return 'Starting…';
  const mb = (n: number) => (n / 1048576).toFixed(0);
  const speed = p.bps > 0 ? `  ·  ${(p.bps / 1048576).toFixed(1)} MB/s` : '';
  return `${mb(p.have)} / ${mb(p.total)} MB${speed}`;
}

// What actually happened, in the terms someone cares about. "229 file(s)" is
// an implementation detail of how a firmware set is packaged -- what a person
// installed is "the firmware", and separately "the keys".
function switchInstallSummary(r: any): string {
  const status = r?.status;
  if (status === 'no-emulator') return 'Eden isn’t installed on this device';
  if (status === 'no-firmware') return 'No Switch firmware on the server';
  // Firmware landed but nothing can decrypt it: the fix is an upload, not a
  // retry, so say which.
  if (status === 'no-keys') return 'Firmware installed, but prod.keys is missing — upload it to the Switch platform on RomM';
  if (status === 'installed') {
    const parts: string[] = [];
    if (r.installed) parts.push('Firmware');
    if (r.keys) parts.push('keys');
    return parts.length ? `${parts.join(' and ')} installed` : 'Installed';
  }
  if (status === 'up-to-date') return 'Firmware and keys are already installed';
  return r?.message || 'Install failed';
}
// The Switch firmware prompt is a modal, so it belongs to the page tree, not to
// the download registry — which is why downloads.ts asks for it to be installed
// rather than calling it. Registered once, at module load.
setPreDownloadHook(maybePromptSwitchFirmware);


// Getting a Switch game is the moment the firmware actually matters, so the
// prompt belongs here rather than only on the BIOS page, which someone may
// never open. Deliberately not a gate: declining installs no firmware and the
// game still downloads, because a ROM on disk with no firmware is a recoverable
// state and blocking the download would not make it less so.
//
// Once per session. The check is cheap, but a modal in front of every download
// is not something anyone wants twice.
let _switchPromptDone = false;
async function maybePromptSwitchFirmware(romId: number): Promise<void> {
  if (_switchPromptDone) return;
  try {
    const info = await switchPrereqForRom(romId);
    if (!info?.needed) return;
    _switchPromptDone = true;
    // Keys missing but no firmware to fetch: nothing to confirm, so say it
    // and move on rather than opening a modal whose only button is Cancel.
    if (!info.available) {
      toaster.toast({
        title: 'Switch firmware',
        body: 'prod.keys is missing — Switch games won’t boot until it’s uploaded to RomM',
      });
      return;
    }
    const mb = info.size ? `${(info.size / 1048576).toFixed(0)} MB` : 'a large download';
    const ok = await new Promise<boolean>((resolve) => {
      showModal(
        <SwitchFirmwareConfirm
          fileName={info.file_name} size={mb} reason={info.reason}
          keysOk={info.keys_ok} version={info.version}
          installedVersion={info.installed_version}
          onAnswer={resolve} />
      );
    });
    if (!ok) return;
    const r = await installSwitchFirmwareWatched();
    toaster.toast({ title: 'Switch firmware', body: switchInstallSummary(r) });
  } catch { /* never let this stop a download */ }
}











// Eases a displayed integer toward a target so a stepwise percentage (updated
// every poll) counts up smoothly. Resets to 0 when inactive.
function useSmoothNumber(target: number | null, active: boolean): number {
  const [val, setVal] = useState(0);
  const cur = useRef(0);
  const raf = useRef<any>(null);
  useEffect(() => {
    if (!active) { cur.current = 0; setVal(0); return; }
    const t = target ?? 0;
    const step = () => {
      const diff = t - cur.current;
      if (Math.abs(diff) < 0.5) { cur.current = t; setVal(t); return; }
      cur.current += diff * 0.18;
      setVal(cur.current);
      raf.current = requestAnimationFrame(step);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, active]);
  return Math.round(val);
}






// Live game tiles by rom_id, and the rom_id of the last game launched. Coming
// back from a session, restoring focus to the FIRST tile lost the user's place
// — on a long list the game they just played could be scrolled far off screen.
// Aiming at the tile they launched keeps the selection where they left it.
// A plain Map (not WeakMap): the value IS the key's only strong ref here, and
// entries are removed on unmount.
const _tileElsByRomId = new Map<number, any>();
let _rommLastLaunchedRomId: number | null = null;

// memo: a focus move updates the parent page's background-art state, which
// would otherwise re-render every tile in the grid on each dpad press (felt
// like the whole grid remounting). With stable props (game ref, useCallback'd
// onOpen, useState setter onActiveCover) only the newly focused/blurred tile
// re-renders for its own scale animation.
// `resume` is set by the Continue playing row when the resume-from-state
// setting is on: the tile then boots into the newest save state and shows that
// state's own screenshot instead of the rom's marketing art.
// `stateThumb` is fetched by the ROW, not here: one batched call fills every
// card at once (see loadStateThumbs). Until it lands the card shows whatever art
// it would otherwise have had, so the row never flashes empty.
// One pill treatment per cover. The platform chip flips to a light scrim when
// its own logo is dark (PlatformIcon reports the tone; see its onTone effect),
// and every other corner badge follows it — a white platform chip sitting
// beside black region/disc/flag chips on the same cover reads as two unrelated
// systems rather than one set of badges.
function coverPill(dark: boolean) {
  return {
    background: dark ? 'rgba(255,255,255,0.82)' : 'rgba(0,0,0,0.78)',
    border: dark ? '1px solid rgba(0,0,0,0.18)' : '1px solid rgba(255,255,255,0.12)',
    color: dark ? 'rgba(0,0,0,0.82)' : V2.fg,
  };
}
// Semantic accents restated for the light pill: V2.warning and V2.success are
// picked to carry on a dark scrim and both wash out on the white one.
const pillWarning = (dark: boolean) => (dark ? '#b45309' : V2.warning);
const pillSuccess = (dark: boolean) => (dark ? '#15803d' : V2.success);

const GameTile = memo(function GameTile({ game, onOpen, onActiveCover, focusRef, index, onFocusIdx, focusable, resume, stateThumb }:
  { game: LibGame; onOpen: (g: LibGame) => void; onActiveCover: (uri: string | null) => void; focusRef?: React.Ref<any>; index?: number; onFocusIdx?: (i: number) => void; focusable?: boolean; resume?: boolean; stateThumb?: string | null }) {
  const wide = !!game.screenshot || !!stateThumb;
  // Wide cards adopt the screenshot's NATURAL aspect ratio (RomM derives the
  // card width from the cover's true shape at a fixed height); 16:9 until loaded.
  const [shotRatio, setShotRatio] = useState(16 / 9);
  const uriRef = useRef<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [iconDark, setIconDark] = useState(false);
  const [dl, setDl] = useState(!!game.is_downloaded);
  const [busy, setBusy] = useState<null | 'download' | 'delete' | 'launch'>(null);
  const [activeDlRomId, setActiveDlRomId] = useState<number>(game.rom_id);
  const dlProgress = useDownloadProgress(activeDlRomId, busy === 'download');
  const dlPct = dlProgress?.percent ?? null;
  const extracting = dlProgress?.state === 'extracting';
  const globalDownloading = useIsDownloading(activeDlRomId);
  const downloading = busy === 'download' || globalDownloading;
  const ringColor = V2.brand;
  // A batch/global download for this tile finished successfully → light the dot
  // now instead of waiting for the next list refetch.
  const wasGlobalDl = useRef(false);
  useEffect(() => {
    if (wasGlobalDl.current && !globalDownloading && _dlSucceeded.has(game.rom_id)) setDl(true);
    wasGlobalDl.current = globalDownloading;
  }, [globalDownloading, game.rom_id]);
  // Track the list prop both ways: light when it turns downloaded, and CLEAR
  // when it turns not-downloaded (bulk "Remove downloaded" flips the prop with
  // no tile handler involved — the dot used to stay lit until re-entry). The
  // guards keep a transient refetch from undoing an in-flight or just-finished
  // download (_dlSucceeded is dropped again on delete by libCacheSetDownloaded).
  useEffect(() => {
    if (game.is_downloaded) setDl(true);
    else if (!downloading && !_dlSucceeded.has(game.rom_id)) setDl(false);
  }, [game.is_downloaded, downloading, game.rom_id]);
  // Offline: downloaded games still launch, but a fetch from the server can't
  // succeed — so block + visually dim download on not-yet-downloaded tiles
  // rather than letting the user trigger a guaranteed failure.
  // A save for this game on its way to RomM. Transient, and it takes the
  // top-left corner from whatever normally holds it — see the badge below.
  const syncing = useSaveActivityFor(game);
  const offline = useOffline();
  // An orphan blocks the same way: the server has no row to serve. This only
  // becomes reachable after its file is deleted (dl flips false while the entry
  // survives until the next walk), and without it the tile would offer a
  // download that is certain to 404.
  const downloadBlocked = (offline || !!game.is_orphan) && !dl;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmTimer = useRef<any>(null);
  const activate = () => { onActiveCover(uriRef.current); };

  // Multi-disc support on the cover: fetch the on-disk disc list when the tile
  // is first focused (for the disc-picker menu). The badge visibility is driven
  // by the backend is_multi_disc flag so it appears immediately.
  const [discs, setDiscs] = useState<LocalDisc[]>([]);
  const [discLast, setDiscLast] = useState<string>('');
  const discsTried = useRef(false);
  const pickableDiscs = discs.filter((d) => !d.is_m3u);
  const isMultiDisc = !!game.is_multi_disc && dl;
  // A downloaded multi-FILE ROM whose members are regional variants (no disc
  // playlist). Detected once the on-disk entries are fetched (on focus).
  const discsAreRegion = discs.length > 0 && discs.every((d) => d.is_region);
  const isMultiRegion = !!game.region_count && game.region_count > 1;
  const [activeRegionId, setActiveRegionId] = useState<number>(game.rom_id);
  const [downloadedRegionIds, setDownloadedRegionIds] = useState<Set<number>>(new Set());
  const siblingFetchTried = useRef(false);
  const ensureDiscs = async (force?: boolean) => {
    if ((discsTried.current && !force) || !dl) return;
    discsTried.current = true;
    try {
      const r = await getLocalDiscs(game.rom_id);
      setDiscs(r?.success ? (r.discs || []) : []);
      setDiscLast(r?.last || '');
    } catch { /* leave empty */ }
  };
  const ensureSiblings = async (force?: boolean) => {
    if ((siblingFetchTried.current && !force) || !isMultiRegion) return;
    siblingFetchTried.current = true;
    try {
      const r = await getLocalSiblings(game.rom_id);
      if (r?.success) setDownloadedRegionIds(new Set(r.downloaded_ids || []));
    } catch { /* leave empty */ }
  };
  // Hold A to open the disc/region picker; a quick press launches. The OK
  // button's onActivate fires on the PRESS edge on Steam Deck, so we can't let
  // it launch (it would fire before a hold is recognised). Instead, for multi
  // games launch is driven entirely from the release handler: arm a timer on
  // A-down that opens the picker at 500ms; on release, if the timer hasn't fired
  // yet it was a short press → launch. onActivate is suppressed for multi games.
  const isMulti = isMultiRegion || isMultiDisc;
  const longFired = useRef(false);
  const pressTimer = useRef<any>(null);
  // Set when a press starts on an overlay sub-button (Details / Delete). The
  // multi-game OK handlers below run on the PARENT and aren't stopped by the
  // child's stopPropagation, so without this a tap on Details would also launch.
  const subPress = useRef(false);
  const onBtnDown = (e: any) => {
    if (subPress.current) return;
    if (e?.detail?.button === GamepadButton.OK && isMulti) {
      longFired.current = false;
      if (pressTimer.current) clearTimeout(pressTimer.current);
      pressTimer.current = setTimeout(() => {
        longFired.current = true;
        pressTimer.current = null;
        if (isMultiRegion) {
          const allSiblings = game.sibling_roms || [];
          openRegionPicker(game.rom_id, game.name, allSiblings, downloadedRegionIds,
            activeRegionId, handleRegionSelected);
        } else {
          openDiscPicker(game.rom_id, game.name, discs, discLast, setBusy,
            () => ensureDiscs(true));
        }
      }, 500);
    }
  };
  const onBtnUp = (e: any) => {
    if (subPress.current) {
      subPress.current = false;
      if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
      return;
    }
    if (e?.detail?.button === GamepadButton.OK && isMulti) {
      // Short press (timer still pending) → launch the default; long press
      // already opened the picker, so do nothing.
      if (pressTimer.current) {
        clearTimeout(pressTimer.current); pressTimer.current = null;
        if (!longFired.current) primary();
      }
    }
  };

  // Button scheme (RomM GameActions): A = download (if absent) / launch (if
  // present); X = details; Y = delete. Mouse: overlay buttons mirror these.
  const doDownload = async () => {
    if (busy) return;
    if (downloadBlocked) {
      toaster.toast({ title: 'Offline', body: 'Connect to RomM to download this game.' });
      return;
    }
    setBusy('download');
    setActiveDlRomId(game.rom_id);
    _setDlActive(game.rom_id, true, game.name);
    try {
      await maybePromptSwitchFirmware(game.rom_id);
      const start = await downloadGame(game.rom_id);
      if (!start?.success) { toaster.toast({ title: 'Download failed', body: start?.message || 'Error' }); return; }
      const res = await awaitDownload(game.rom_id);
      if (res.ok) {
        setDl(true); libCacheSetDownloaded(game.rom_id, true);
        toaster.toast({
          title: 'Downloaded', body: game.name,
          logo: <ToastCover romId={game.rom_id} hasCover={game.has_cover} />,
          // Clicking the toast opens the game it names. Origin is the library
          // root because the toast can outlive whatever page started the
          // download — backing out to a page that's no longer there would strand
          // the user.
          onClick: () => openGameById(game.rom_id, game.name, "/romm-sync-library"),
        });
      }
      else if (res.removed) {
        // Not a failure. The game was deleted on RomM and we have just found
        // out the only way counts allow — by touching it.
        toaster.toast({ title: 'No longer on RomM', body: `${game.name} has been removed from your server.` });
        libCacheDrop(game.rom_id);
      }
      else toaster.toast({ title: 'Download failed', body: res.message || 'Error' });
    } catch (e) { toaster.toast({ title: 'Download failed', body: String(e) }); }
    finally { _setDlActive(game.rom_id, false); setBusy(null); }
  };
  const doLaunch = async () => {
    if (busy) return;
    // A on a tile has no dimmed state to read, so say it out loud instead.
    if (cannotLaunch(_emuStatus, game.platform, game.platform_slug)) {
      const alt = standaloneFor(_emuStatus, game.platform, game.platform_slug);
      toaster.toast({
        title: 'No emulator',
        body: alt ? `${alt.name} is not installed — ${game.platform || 'this platform'} needs it.`
                  : 'Install RetroArch from Home to play this.',
      });
      return;
    }
    setBusy('launch');
    try {
      const r = await launchGameSmart(game.rom_id, null, null, !!resume);
      // No success toast — the screen transitions to the launch immediately, so
      // the toast just races the thing it announces. Surface failures only.
      if (!r?.success && !offerCoreInstall(r, () => void doLaunch())) {
        toaster.toast({ title: 'Launch failed', body: r?.message || 'Error' });
      }
    } catch (e) { toaster.toast({ title: 'Launch failed', body: String(e) }); }
    finally { setBusy(null); }
  };
  const handleRegionSelected = async (selectedRomId: number) => {
    setActiveRegionId(selectedRomId);
    const isMainRom = selectedRomId === game.rom_id;
    const isAlreadyDownloaded = isMainRom ? dl : downloadedRegionIds.has(selectedRomId);
    if (!isAlreadyDownloaded) {
      if (busy) { toaster.toast({ title: 'Busy', body: 'Please wait for the current operation' }); return; }
      if (offline) {
        toaster.toast({ title: 'Offline', body: 'Connect to RomM to download this version.' });
        return;
      }
      setBusy('download');
      setActiveDlRomId(selectedRomId);
      _setDlActive(selectedRomId, true, game.name);
      try {
        await maybePromptSwitchFirmware(selectedRomId);
        const start = await downloadGame(selectedRomId);
        if (!start?.success) { toaster.toast({ title: 'Download failed', body: start?.message || 'Error' }); return; }
        const res = await awaitDownload(selectedRomId);
        if (res.ok) {
          setDownloadedRegionIds(prev => new Set([...prev, selectedRomId]));
          if (isMainRom) { setDl(true); libCacheSetDownloaded(game.rom_id, true); }
          // The main rom's art even when a regional sibling was the download —
          // it's the same game, and only `game` carries a known has_cover.
          toaster.toast({
            title: 'Downloaded', body: game.name,
            logo: <ToastCover romId={game.rom_id} hasCover={game.has_cover} />,
            // The main rom again, not selectedRomId: the detail page is the
            // game's, and regional siblings don't have one of their own.
            onClick: () => openGameById(game.rom_id, game.name, "/romm-sync-library"),
          });
        } else {
          toaster.toast({ title: 'Download failed', body: res.message || 'Error' });
          return;
        }
      } catch (e) { toaster.toast({ title: 'Download failed', body: String(e) }); return; }
      finally { _setDlActive(selectedRomId, false); setBusy(null); }
    }
    // After download (or if already downloaded): check if this region is multi-disc
    try {
      const localDiscs = await getLocalDiscs(selectedRomId);
      const discList: LocalDisc[] = localDiscs?.success ? (localDiscs.discs || []) : [];
      const pickable = discList.filter((d: LocalDisc) => !d.is_m3u);
      if (discList.length > 1 || pickable.length > 1) {
        openDiscPicker(selectedRomId, game.name, discList, localDiscs?.last || '', setBusy);
      } else {
        await runLaunch(selectedRomId, game.name, null, game.name, setBusy);
      }
    } catch {
      await runLaunch(selectedRomId, game.name, null, game.name, setBusy);
    }
  };
  const doDelete = async () => {
    if (busy) return;
    setBusy('delete');
    try {
      const r = await deleteGame(game.rom_id);
      if (r?.success) { setDl(false); libCacheSetDownloaded(game.rom_id, false); }
      else toaster.toast({ title: 'Delete failed', body: r?.message || 'Error' });
    } catch (e) { toaster.toast({ title: 'Delete failed', body: String(e) }); }
    finally { setConfirmDelete(false); setBusy(null); }
  };
  // Two-step confirm on the cover (matching the details page): the first delete
  // press arms it (button turns into a check), the second within 3s commits.
  const requestDelete = () => {
    if (busy) return;
    // An orphan's local copy is the only one left, and a two-press gesture on a
    // cover tile is too easy to fire by accident for something unrecoverable.
    // Send it to the details page, which has room to say why.
    if (game.is_orphan) {
      toaster.toast({ title: 'No longer on RomM', body: 'Open the game to delete your only copy.' });
      onOpen(game);
      return;
    }
    if (confirmDelete) { doDelete(); return; }
    setConfirmDelete(true);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmDelete(false), 3000);
  };
  const primary = () => {
    if (dl) doLaunch();
    else doDownload();
  };

  // Keep our own handle on the DOM node (for the focus reveal/glimpse) while
  // still honoring the parent's object-or-callback focusRef.
  const selfRef = useRef<any>(null);
  const setRefs = (el: any) => {
    const prev = selfRef.current;
    selfRef.current = el;
    // Register by rom_id so the post-session focus restore can aim at the tile
    // the user actually launched instead of the first one in the grid. Cleared
    // on unmount (el === null) so detached nodes are not held or focused.
    // Unregister only if the entry is still OUR node: the same game is on Home
    // twice (Continue playing + Recently Downloaded) and again in the library,
    // and React runs the new tile's ref BEFORE the old one's null cleanup — a
    // blind delete here dropped the entry that had just been registered, so
    // after a session the map was empty and focus fell back to the first tile.
    try {
      if (el) _tileElsByRomId.set(game.rom_id, el);
      else if (prev && _tileElsByRomId.get(game.rom_id) === prev) _tileElsByRomId.delete(game.rom_id);
    } catch { /* ignore */ }
    if (typeof focusRef === 'function') focusRef(el);
    else if (focusRef) (focusRef as any).current = el;
  };
  // `focusable: false` while the containing panel is hidden — display:none does
  // NOT drop a Focusable from Steam's nav tree (verified on-device: hidden
  // tiles sit at rect 0×0 and spatial nav happily jumps to them — "phantom"
  // focus with a live footer legend but no visible selection).
  return (
    <Focusable noFocusRing className="romm-gt-wrap"
      {...({ focusable: focusable !== false } as any)}
      ref={setRefs}
      onActivate={() => {
        // A press that started on an overlay sub-button (Details / Delete) must
        // not also activate the cover — Steam routes the tap to this parent
        // Focusable since the sub-buttons are plain divs.
        if (subPress.current) { subPress.current = false; return; }
        // Multi games drive launch from the release handler (onBtnUp) so a hold
        // can open the picker without the press-edge activation launching first.
        if (isMulti) { longFired.current = false; return; }
        primary();
      }}
      onClick={primary}
      onButtonDown={onBtnDown}
      onButtonUp={onBtnUp}
      onSecondaryButton={() => onOpen(game)}
      onSecondaryActionDescription="Details"
      onOptionsButton={dl ? requestDelete : undefined}
      onOptionsActionDescription={dl ? (confirmDelete ? 'Confirm delete' : 'Delete') : undefined}
      onOKActionDescription={dl ? (isMultiRegion ? 'Launch (hold: regions)' : isMultiDisc ? (discsAreRegion ? 'Launch (hold: regions)' : 'Launch (hold: discs)') : (resume ? 'Resume' : 'Launch')) : 'Download'}
      onFocus={() => { setFocused(true); activate(); ensureDiscs(); ensureSiblings(); if (index !== undefined) onFocusIdx?.(index); _tileFocusScrub(selfRef.current, game.name); }}
      onBlur={() => setFocused(false)}
      onMouseEnter={() => { setFocused(true); activate(); ensureDiscs(); ensureSiblings(); }}
      onMouseLeave={() => setFocused(false)}
      style={{
        cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '7px',
        // Resume tiles size themselves: the row can't know in advance whether a
        // state screenshot will arrive and turn a portrait card landscape, so
        // the portrait width lives here rather than on the row's wrapper.
        ...(resume && !wide ? { width: '132px' } : {}),
      }}
    >
      <div className="romm-gt-cover" style={{
        position: 'relative', overflow: 'hidden',
        // Wide (continue-playing) cards are a fixed-height 16:9 screenshot with
        // natural width; portrait cards keep the cover's 3:4 footprint.
        ...(wide ? { height: '176px', aspectRatio: String(shotRatio) } : {}),
        transform: 'scale(1)',
        transition: 'transform 0.18s ease, box-shadow 0.18s ease',
        borderRadius: V2.radiusArt,
        ...V2Focus.tile(focused),
      }}>
        {wide ? (
          <>
            {stateThumb
              ? <StateArt uri={stateThumb} onLoaded={(u) => { uriRef.current = u; }} onRatio={setShotRatio} />
              : <ScreenshotArt path={game.screenshot!} onLoaded={(u) => { uriRef.current = u; }} onRatio={setShotRatio} />}
            <CoverPip romId={game.rom_id} hasCover={game.has_cover} hidden={focused} />
          </>
        ) : (
          <GameCover romId={game.rom_id} hasCover={game.has_cover}
            onLoaded={(u) => { uriRef.current = u; }} />
        )}
        {/* Platform icon badge — top-right circular scrim with the real RomM
            platform icon (RomM GameCard .r-gc__platform-icon: 7px inset, 3px
            pad, 78% black scrim, 12%-white border, always visible). */}
        {game.platform_slug && (
          <div style={{
            position: 'absolute', top: '7px', right: '7px', zIndex: 2,
            padding: '3px', borderRadius: '50%',
            ...coverPill(iconDark),
            lineHeight: 0, transition: 'background 0.2s ease, border-color 0.2s ease',
          }}>
            <div style={{
              width: '22px', height: '22px', display: 'flex',
              alignItems: 'center', justifyContent: 'center', color: 'inherit',
            }}>
              <PlatformIcon slug={game.platform_slug} size={22} onTone={setIconDark} />
            </div>
          </div>
        )}
        {/* Save going up — top-left, and it takes that corner from the
            downloaded dot, the region badge and the orphan badge for as long
            as it lasts. It wins because it is the only one of the four that is
            about to stop being true: the others state a standing fact and can
            wait a few seconds to say it again.

            Unlike its neighbours this does NOT fade out on focus. They step
            aside so the action overlay reads cleanly; this is the answer to
            "did my save go up?", and hiding it from the person looking
            straight at the tile would defeat it. */}
        {syncing && (
          <div style={{
            position: 'absolute', left: '7px', top: '7px', zIndex: 3,
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            padding: '2px 6px', borderRadius: V2.radiusPill, fontSize: '10px', fontWeight: 600,
            ...coverPill(iconDark),
            transition: 'background 0.2s ease, border-color 0.2s ease',
          }}>
            <FaCloudUploadAlt size={9} />
          </div>
        )}

        {/* Downloaded status dot — top-left corner, opposite the platform
            icon so the two affordances don't collide. Hidden for multi-region
            games (the region badge replaces it). */}
        {dl && !isMultiRegion && !game.is_orphan && !syncing && (
          <div style={{
            position: 'absolute', top: '7px', left: '7px', zIndex: 2,
            width: '10px', height: '10px', borderRadius: '50%',
            background: V2.success, boxShadow: '0 0 0 2px rgba(0,0,0,0.45)',
          }} />
        )}

        {/* Region badge — globe icon + region count, top-left corner. Shown for
            multi-region games so the region picker is discoverable. */}
        {isMultiRegion && !syncing && (
          <div style={{
            position: 'absolute', left: '7px', top: '7px', zIndex: 2,
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            padding: '2px 6px', borderRadius: V2.radiusPill, fontSize: '10px', fontWeight: 600,
            ...coverPill(iconDark),
            opacity: focused ? 0 : 1,
            transition: 'opacity 0.18s ease, background 0.2s ease, border-color 0.2s ease',
          }}>
            <FaGlobe size={9} />{game.region_count}
          </div>
        )}

        {/* Orphan badge — this game is on disk but no longer exists on RomM, so
            the copy in front of the user is the only one left. Warning-toned
            rather than danger: nothing is broken, the game just stands alone now.

            Top-left, and it REPLACES the downloaded dot rather than sitting over
            it — same corner, same coordinates, and an orphan is downloaded by
            construction, so stacking them was a guaranteed overlap. The dot is
            absorbed into the pill instead (still conditional on dl, which can
            turn false if the user deletes the file before the next walk drops
            the entry), so one element carries both facts.

            Cannot co-occur with the region badge: a removed game has no server
            rows left to have regions with. */}
        {game.is_orphan && !syncing && (
          <div style={{
            position: 'absolute', left: '7px', top: '7px', zIndex: 2,
            display: 'inline-flex', alignItems: 'center', gap: '5px',
            padding: '2px 6px', borderRadius: V2.radiusPill, fontSize: '10px', fontWeight: 600,
            ...coverPill(iconDark),
            // Keeps its warning tone, restated for whichever scrim it landed on.
            border: `1px solid ${pillWarning(iconDark)}`, color: pillWarning(iconDark),
            opacity: focused ? 0 : 1,
            transition: 'opacity 0.18s ease, background 0.2s ease, border-color 0.2s ease',
          }}>
            {dl && (
              <span style={{
                width: '7px', height: '7px', borderRadius: '50%',
                background: pillSuccess(iconDark), flexShrink: 0,
              }} />
            )}
            <FaUnlink size={9} />
          </div>
        )}

        {/* Multi-disc badge — a small disc-count pill (RomM-style scrim chip)
            shown for downloaded multi-disc games so the hold-A picker is
            discoverable. Shows the actual count once fetched, otherwise a
            generic disc icon. */}
        {dl && isMultiDisc && (
          <div style={{
            position: 'absolute', left: '7px', bottom: '7px', zIndex: 2,
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            padding: '2px 6px', borderRadius: V2.radiusPill, fontSize: '10px', fontWeight: 600,
            ...coverPill(iconDark),
            opacity: focused ? 0 : 1,
            transition: 'opacity 0.18s ease, background 0.2s ease, border-color 0.2s ease',
          }}>
            {discsAreRegion
              ? <><FaGlobe size={9} />{discs.length || game.disc_count || ''}</>
              : <><FaClone size={9} />{game.disc_count || pickableDiscs.length || ''}</>}
          </div>
        )}

        {/* Region + language flag chips — bottom-right, the one corner the
            other badges don't use (platform icon top-right, downloaded dot /
            region / orphan top-left, disc count bottom-left).

            This is RomM's Card Flags.vue: one translucent chip per axis, at
            most three emoji each, titled with the full list. Like the rest of
            the corner badges they fade out on focus so the action overlay is
            unobstructed.

            On a wide (continue-playing) card the same corner already holds the
            CoverPip box art, so the chips step to the left of it — 46px pip +
            its 6px inset + a 6px gap — instead of covering the cover. */}
        {((game.regions?.length || 0) > 0 || (game.languages?.length || 0) > 0) && (
          <div style={{
            position: 'absolute', bottom: '7px', zIndex: 2,
            right: wide && game.has_cover ? '58px' : '7px',
            display: 'flex', alignItems: 'center', gap: '4px',
            maxWidth: 'calc(100% - 14px)', overflow: 'hidden',
            opacity: focused ? 0 : 1, transition: 'opacity 0.18s ease',
          }}>
            {([['regions', game.regions, regionToEmoji],
               ['languages', game.languages, languageToEmoji]] as const)
              .filter(([, vals]) => (vals?.length || 0) > 0)
              .map(([kind, vals, toEmoji]) => (
                <div key={kind} title={`${kind === 'regions' ? 'Regions' : 'Languages'}: ${vals!.join(', ')}`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '2px',
                    padding: '2px 5px', borderRadius: V2.radiusPill,
                    fontSize: '10px', lineHeight: 1.2, whiteSpace: 'nowrap',
                    ...coverPill(iconDark),
                    transition: 'background 0.2s ease, border-color 0.2s ease',
                  }}>
                  {vals!.slice(0, 3).map((v) => <span key={v}>{toEmoji(v)}</span>)}
                </div>
              ))}
          </div>
        )}

        {/* GameActions overlay — gradient scrim, center primary (download/play),
            bottom Details + Delete; revealed on hover/focus. The reveal is
            ALSO driven by CSS :hover (.romm-gt-actions/.romm-gt-primary/
            .romm-gt-scrim) so the mouse can reach the buttons even when no
            React onMouseEnter fires — on desktop the pointer often ends up
            inside a cover without crossing its boundary (gamepad mode toggles
            body pointer-events), which left the buttons unclickable. */}
        <div className="romm-gt-scrim" style={{
          position: 'absolute', inset: 0, borderRadius: V2.radiusArt, pointerEvents: 'none',
          background: 'linear-gradient(to top, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0) 55%)',
          opacity: focused ? 1 : 0, transition: 'opacity 0.18s ease',
        }} />
        {/* Outer-only download glow — a blurred copy of the arc painted BEHIND
            the opaque white button, so the button masks the inner half and only
            the outward halo escapes. */}
        {downloading && (
          <div style={{
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%,-50%)', pointerEvents: 'none',
          }}>
            <ProgressRing pct={dlPct} size={48} stroke={4} glow color={ringColor} />
          </div>
        )}
        {/* Center primary (A) — emphasized white round button (RomM Play). */}
        <div
          className="romm-gt-primary"
          onClick={(e: any) => { e.stopPropagation(); primary(); }}
          style={{
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            ...roundBtn(44, 'emphasized'), boxShadow: '0 2px 10px rgba(0,0,0,0.55)',
            // Stay visible while downloading so the fill ring is always shown,
            // even if focus moves away mid-download. Same for a save going up:
            // the corner chip is the unfocused tile's answer, but on the tile
            // you are actually pointing at, the button is where the eye is —
            // and a plain Play there says nothing about the upload.
            opacity: (focused || downloading || syncing) ? (downloadBlocked ? 0.4 : 1) : 0,
            filter: downloadBlocked ? 'grayscale(1)' : 'none',
            transition: 'opacity 0.18s ease',
          }}>
          {/* While downloading, the progress ring rides ON the button's border:
              the 44px button has radius 22, so a 48px ring with a 4px stroke has
              its circle radius at exactly (48-4)/2 = 22, centered on the rim. */}
          {downloading && (
            <div style={{
              position: 'absolute', top: '50%', left: '50%',
              transform: 'translate(-50%,-50%)', pointerEvents: 'none',
            }}>
              <ProgressRing pct={dlPct} size={48} stroke={4} color={ringColor} />
            </div>
          )}
          {downloading
            ? (extracting ? <FaBoxOpen size={15} /> : <FaDownload size={15} />)
            : busy === 'launch'
              ? <FaSync size={16} style={{ animation: 'spin 1s linear infinite' }} />
              /* Ranked below launching: if you just pressed Play, what that
                 press did outranks a background upload. The button still
                 launches while it shows this — the glyph reports what is
                 happening, it does not change what A does. */
              : syncing ? <FaCloudUploadAlt size={15} />
                : dl ? <FaPlay size={15} style={{ marginLeft: '2px' }} /> : <FaDownload size={15} />}
        </div>
        {/* Bottom row: Details (X) + Delete (Y, when downloaded) — glass buttons. */}
        <div className="romm-gt-actions" style={{
          position: 'absolute', left: '8px', right: '8px', bottom: '8px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          opacity: focused ? 1 : 0, transform: focused ? 'translateY(0)' : 'translateY(6px)',
          transition: 'opacity 0.18s ease, transform 0.18s ease',
        }}>
          <div onPointerDown={() => { subPress.current = true; }}
            onClick={(e: any) => { e.stopPropagation(); subPress.current = false; onOpen(game); }} style={roundBtn(30, 'glass')}>
            <FaInfoCircle size={13} />
          </div>
          {dl && (
            <div onPointerDown={() => { subPress.current = true; }}
              onClick={(e: any) => { e.stopPropagation(); subPress.current = false; requestDelete(); }}
              style={{
                ...roundBtn(30, 'danger'),
                // Armed state: solid red fill + check glyph, so it's clear the
                // next press commits the delete.
                ...(confirmDelete ? { background: V2.danger, borderColor: V2.danger, color: '#fff' } : {})
              }}>
              {busy === 'delete'
                ? <FaSync size={12} style={{ animation: 'spin 1s linear infinite' }} />
                : confirmDelete ? <FaCheck size={12} /> : <FaTrash size={12} />}
            </div>
          )}
        </div>
      </div>
      <div style={{
        fontSize: '11.5px', color: focused ? V2.fg : V2.fg2, textAlign: 'center',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        transition: 'color 0.18s', padding: '0 1px',
        // Wide cards have no fixed-width parent — pin the label to the art's
        // width so a long name ellipsises instead of widening the card.
        ...(wide ? { width: 0, minWidth: '100%', maxWidth: '100%' } : {}),
      }}>
        {game.name}
      </div>
    </Focusable>
  );
});

// One image fetched by RomM resource path (collection mosaic cells), base64
// via the backend, cached. Renders nothing visible until loaded.
function PathImage({ path }: { path: string }) {
  const ik = `img:${path}`;
  const [uri, setUri] = useState<string | null>(peekCover(ik) ?? null);
  // Not viewport-gated: IO doesn't fire on gamepad focus-scroll under gamescope.
  useEffect(() => {
    let alive = true;
    const p = peekCover(ik);
    if (p !== undefined) { setUri(p); return; }
    (async () => {
      try { const u = await awaitCover(ik, () => qGetImage(path)); if (alive) setUri(u); }
      catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [path]);
  return (
    <div style={{ width: '100%', height: '100%', background: V2.coverPlaceholder, overflow: 'hidden' }}>
      {uri && <img src={uri} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
    </div>
  );
}

// Collection cover mosaic — 1 cover fills the box, 2+ paint a 2×2 grid
// (RomM CollectionMosaic). Portrait 3:4 to match the game cards.
function CollectionMosaic({ covers }: { covers: string[] }) {
  const cs = (covers || []).slice(0, 4);
  return (
    <div style={{
      position: 'relative', width: '100%', aspectRatio: '3 / 4',
      borderRadius: V2.radiusLg, overflow: 'hidden', background: V2.coverPlaceholder,
      display: 'grid',
      gridTemplateColumns: cs.length <= 1 ? '1fr' : '1fr 1fr',
      gridTemplateRows: cs.length <= 1 ? '1fr' : '1fr 1fr',
    }}>
      {cs.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: V2.fgMuted }}>
          <FaBookmark size={20} />
        </div>
      ) : cs.map((p, i) => <PathImage key={i} path={p} />)}
    </div>
  );
}



// Is THIS game's save the one moving? The engine resolves the rom_id from the
// save file it is uploading, so the answer is exact rather than a name match.
//
// Siblings count as the same tile. A multi-region game is ONE card standing for
// several server rows, and the save came from whichever row was launched — with
// a bare rom_id test, playing the USA copy of a game whose card is keyed to the
// European one lights nothing at all.
function useSaveActivityFor(game?: { rom_id: number; sibling_roms?: { rom_id: number }[] } | null): SaveActivity | null {
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
const _syncPillListeners = new Set<() => void>();
function _setSyncPillPref(on: boolean) {
  _syncPillPref = on;
  _syncPillListeners.forEach((l) => { try { l(); } catch { } });
}
function useSyncPillEnabled(): boolean {
  const [, force] = useState(0);
  useEffect(() => {
    // Bump a counter rather than subscribing `force` directly: called bare it
    // would set state to undefined every time, and React bails out of the
    // second identical update — the switch would move once and then stick.
    const listener = () => force((n) => n + 1);
    _syncPillListeners.add(listener);
    // Undefined until the first answer lands, and treated as ON meanwhile —
    // suppressing it on the launch where it matters most would be the worse
    // failure, and the round-trip beats any save to the finish anyway.
    if (_syncPillPref === null) {
      getSyncIndicator()
        .then((r) => _setSyncPillPref(r?.enabled !== false))
        .catch(() => _setSyncPillPref(true));
    }
    return () => { _syncPillListeners.delete(listener); };
  }, []);
  return _syncPillPref !== false;
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
let _emuStatus: EmuStatus | null = null;
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
function standaloneFor(status: EmuStatus | null,
                       platform?: string | null,
                       slug?: string | null): EmuStandalone | null {
  if (!status?.standalone?.length) return null;
  const hay = `${platform || ''} ${slug || ''}`.toLowerCase();
  if (!hay.trim()) return null;
  return status.standalone.find((s) => s.platforms.some((p) => hay.includes(p))) || null;
}

// True when this game can't be launched: no RetroArch, and no standalone
// emulator that covers its platform either.
function cannotLaunch(status: EmuStatus | null,
                      platform?: string | null, slug?: string | null): boolean {
  if (status == null) return false;
  const alt = standaloneFor(status, platform, slug);
  if (alt) return !alt.installed;   // its platform never uses a core
  return !status.installed;
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

// Collection tile — mosaic cover + kind badge + name/count below, with the
// focus scale + brand glow (RomM CollectionTile).
function CollectionTile({ group, onOpen, focusRef, focusable }: { group: LibGroup; onOpen: (g: LibGroup) => void; focusRef?: React.Ref<any>; focusable?: boolean }) {
  const [focused, setFocused] = useState(false);
  // Virtual (autogenerated) collections key their sync by the opaque base64 id
  // (== group.key), and still can't be local-deleted wholesale — removal below
  // looks collections up by name.
  const isVirtual = !!group.virtual;
  // Per-tile auto-sync state (optimistic), so Y toggles sync straight from the
  // collections grid/rail and the green dot reflects it instantly.
  const [synced, setSynced] = useState(!!group.synced);
  // Live sync state from the shared poll — drives the download ring (same as
  // game covers) while this collection is actively downloading.
  const live = useCollectionSync(group.key);
  const syncing = live?.state === 'syncing';
  const syncPct = live?.pct != null ? live.pct
    : (live && live.total ? Math.round(((live.downloaded || 0) / live.total) * 100) : 0);
  const toggleSync = async () => {
    const next = !synced;
    setSynced(next);
    try {
      const ok = await toggleCollectionSync(group.key, next);
      if (ok === false) throw new Error('backend declined');
      toaster.toast({ title: next ? 'Auto-sync on' : 'Auto-sync off', body: group.label });
    } catch (e) {
      setSynced(!next); // revert
      toaster.toast({ title: 'Sync toggle failed', body: String(e) });
    }
  };
  // Collection actions menu (same as the in-collection header menu): one-shot
  // "Sync missing" + destructive "Remove downloaded" (arm→confirm). Reached by
  // HOLDING A on the tile (or right-click / the ⋯ chip for mouse).
  const removeArmed = useRef(false);
  const doTileRemove = async () => {
    try {
      if (synced) { await toggleCollectionSync(group.key, false); setSynced(false); }
      const ok = await deleteCollectionRoms(group.key, 'collection');
      if (ok === false) throw new Error('backend declined');
      // Mirror the deletion into the shared caches (these games also live in
      // their platform lists), then refetch whatever is mounted — without this
      // the dots stayed lit until the group was re-entered.
      const list = _libGamesCache.get(`collection:${group.key}`) || [];
      for (const g of list) if (g.is_downloaded) libCacheSetDownloaded(g.rom_id, false);
      libCacheDelete(`collection:${group.key}`);
      _broadcastLibRefresh();
    } catch (e) { toaster.toast({ title: 'Remove failed', body: String(e) }); }
  };
  const openMenu = () => {
    const armed = removeArmed.current;
    showContextMenu(
      <Menu label={group.label} onCancel={() => { removeArmed.current = false; }}>
        <MenuItem onSelected={async () => {
          const res = await getLibraryGames('collection', group.key).catch(() => null);
          const missing = res?.success ? (res.games || []).filter((g: LibGame) => !g.is_downloaded).map((g: LibGame) => ({ id: g.rom_id, name: g.name })) : [];
          if (!missing.length) { toaster.toast({ title: 'Nothing to sync', body: 'All games are already downloaded' }); return; }
          // Shared module-level batch: same job key as the collection page, so
          // opening the collection mid-batch shows the running header progress.
          // Toast click reuses the tile's own open handler, so it lands on the
          // collection with the same sibling list the tile would have given it.
          runCollectionBatch(`collection:${group.key}`, missing, () => onOpen(group));
        }}>{isVirtual ? 'Download missing' : 'Sync missing'}</MenuItem>
        {!isVirtual && (
          <MenuItem tone="destructive" onSelected={() => {
            if (!armed) {
              removeArmed.current = true;
              setTimeout(() => { removeArmed.current = false; }, 4000);
              requestAnimationFrame(openMenu);
            } else { removeArmed.current = false; doTileRemove(); }
          }}>{armed ? 'Confirm remove' : 'Remove downloaded'}</MenuItem>
        )}
      </Menu>,
    );
  };

  // Distinguish tap (open) from hold (actions menu) on the A button. onButtonDown
  // starts the hold timer; onActivate (fires on release) opens only if the hold
  // didn't already trigger the menu. Repeats are ignored so the timer fires once.
  const holdTimer = useRef<any>(null);
  const held = useRef(false);
  const onBtnDown = (e: any) => {
    if (e?.detail?.button !== GamepadButton.OK || e?.detail?.is_repeat) return;
    held.current = false;
    clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => { held.current = true; openMenu(); }, 500);
  };
  const onActivate = () => {
    clearTimeout(holdTimer.current);
    if (held.current) { held.current = false; return; } // hold opened the menu
    onOpen(group);
  };

  // Kind badges match RomM's exact tokens: smart is the mdi-flash glyph
  // (MdFlash here) in the warm brand accent #e1a38d, virtual the cool
  // brand-primary #8b74e8, favorites --r-color-fav #ff4f6b. Icon-only on a
  // translucent dark chip so it stays readable over any cover, like RomM's
  // colored-on-dark kind badges.
  const badge = group.kind === 'smart' ? { icon: <MdFlashOn size={10} />, label: '', bg: 'rgba(16,16,20,0.65)', fg: '#e1a38d' }
    : group.kind === 'virtual' ? { label: 'VIRTUAL', bg: 'rgba(16,16,20,0.65)', fg: '#8b74e8' }
      : group.kind === 'favorite' ? { label: '★', bg: 'rgba(16,16,20,0.65)', fg: '#ff4f6b' }
        : null;
  // Terse footer labels — the long "Open · Hold: Actions" + "Sync collection"
  // pair wrapped the Deck's button legend onto two rows. The hold affordance
  // is already advertised by the tile's ⋯ HOLD chip.
  const selfRef = useRef<any>(null);
  const setRefs = (el: any) => {
    selfRef.current = el;
    if (typeof focusRef === 'function') focusRef(el);
    else if (focusRef) (focusRef as any).current = el;
  };
  return (
    <Focusable noFocusRing className="romm-ct-wrap"
      {...({ focusable: focusable !== false } as any)}
      ref={setRefs}
      onClick={() => onOpen(group)}
      onActivate={onActivate}
      onButtonDown={onBtnDown}
      onOKActionDescription="Open"
      onOptionsButton={toggleSync}
      onOptionsActionDescription={synced ? 'Sync off' : 'Sync'}
      onFocus={() => { setFocused(true); _tileFocusScrub(selfRef.current, group.label); }} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '8px' }}
    >
      <div className="romm-ct-cover" style={{
        position: 'relative', borderRadius: V2.radiusLg,
        transform: 'scale(1)', transition: 'transform 0.18s ease, box-shadow 0.18s ease',
        boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
        ...V2Focus.tile(focused),
      }}>
        <CollectionMosaic covers={group.covers || []} />
        {/* Download ring + glyph while syncing — mirrors the game-cover affordance
            so a downloading collection reads the same as a downloading game. */}
        {syncing && (
          <>
            <div style={{
              position: 'absolute', inset: 0, borderRadius: V2.radiusLg,
              background: 'rgba(0,0,0,0.45)', pointerEvents: 'none', zIndex: 1,
            }} />
            <div style={{
              position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
              zIndex: 2, ...roundBtn(44, 'emphasized'), boxShadow: '0 2px 10px rgba(0,0,0,0.55)',
            }}>
              <div style={{
                position: 'absolute', top: '50%', left: '50%',
                transform: 'translate(-50%,-50%)', pointerEvents: 'none',
              }}>
                <ProgressRing pct={syncPct} size={48} stroke={4} />
              </div>
              <FaDownload size={15} />
            </div>
          </>
        )}
        {/* Synced status dot — same green dot as downloaded games, placed
            top-right so it never collides with the kind badge (top-left).
            Hidden while the ring is showing. */}
        {synced && !syncing && (
          <div style={{
            position: 'absolute', top: '7px', right: '7px', zIndex: 2,
            width: '10px', height: '10px', borderRadius: '50%',
            background: V2.success, boxShadow: '0 0 0 2px rgba(0,0,0,0.45)',
          }} />
        )}
        {badge && (
          <span style={{
            position: 'absolute', top: '6px', left: '6px',
            fontSize: '9px', fontWeight: 800, letterSpacing: '0.04em',
            padding: '2px 7px', borderRadius: V2.radiusChip, color: badge.fg,
            background: badge.bg, boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}>{badge.icon ?? badge.label}</span>
        )}
        {/* Actions hint — a ⋯ chip on focus/hover signals the long-press (hold A)
            / right-click actions menu exists; also clickable for mouse users. */}
        {focused && !syncing && (
          <div
            onClick={(e: any) => { e.stopPropagation(); openMenu(); }}
            style={{
              position: 'absolute', bottom: '6px', right: '6px', zIndex: 3,
              display: 'flex', alignItems: 'center', gap: '4px',
              padding: '2px 6px', borderRadius: V2.radiusChip,
              background: 'rgba(0,0,0,0.62)', color: V2.fg,
              fontSize: '9px', fontWeight: 700, letterSpacing: '0.02em',
              boxShadow: '0 1px 3px rgba(0,0,0,0.5)', pointerEvents: 'auto',
            }}>
            <FaEllipsisH size={9} /><span>HOLD</span>
          </div>
        )}
      </div>
      <div>
        <div style={{
          fontSize: '12.5px', fontWeight: 600, color: focused ? V2.fg : V2.fg2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          transition: 'color 0.18s',
        }}>{group.label}</div>
        <div style={{ fontSize: '11px', color: V2.fgMuted }}>
          {group.count} {group.count === 1 ? 'game' : 'games'}
        </div>
      </div>
    </Focusable>
  );
}


// Platform tile — centered icon-led card (RomM PlatformTile): bg-elevated
// card, large icon on top, name + count, focus brand glow.
function PlatformTile({ group, onOpen, focusRef, focusable }: { group: LibGroup; onOpen: (g: LibGroup) => void; focusRef?: React.Ref<any>; focusable?: boolean }) {
  const [focused, setFocused] = useState(false);
  const selfRef = useRef<any>(null);
  const setRefs = (el: any) => {
    selfRef.current = el;
    if (typeof focusRef === 'function') focusRef(el);
    else if (focusRef) (focusRef as any).current = el;
  };

  // Re-read this one platform from RomM. The automatic check only reacts to a
  // platform's server count changing, which cannot see an add and a delete that
  // net out — and cannot be hurried by someone who already knows they just
  // added games here. This walks it unconditionally, in seconds, where a
  // library-wide refresh is minutes.
  const [resyncing, setResyncing] = useState(false);
  const doResync = async () => {
    if (resyncing) return;
    setResyncing(true);
    try {
      // slug when the group carries one (RomM's own identifier), else the
      // display key — resync_platform resolves either against /api/platforms.
      const res = await resyncPlatform(String(group.slug || group.key));
      if (res?.success) {
        toaster.toast({ title: `${group.label} synced`, body: res.message || 'No changes' });
        libCacheDelete(`platform:${group.key}`);
        _broadcastLibRefresh();
      } else if (res?.busy) {
        toaster.toast({ title: 'Already refreshing', body: 'A library fetch is in progress.' });
      } else {
        toaster.toast({ title: 'Sync failed', body: res?.message ?? 'Unknown error' });
      }
    } catch (e) {
      toaster.toast({ title: 'Sync failed', body: String(e) });
    } finally {
      setResyncing(false);
    }
  };
  const openMenu = () => showModal(
    <PlatformActionsModal
      label={group.label} slug={group.slug || group.fs_slug || undefined}
      count={group.count} downloaded={group.downloaded ?? undefined}
      resyncing={resyncing} onSync={doResync} onOpen={() => onOpen(group)} />,
  );

  // Y opens this menu while the tile is focused — published to the page root,
  // which owns the button handler. Cleared on blur only if we are still the
  // current holder: focus moves as leave-then-enter on some transitions, and a
  // blind clear on blur would drop the tile that just took over.
  const openRef = useRef(openMenu);
  openRef.current = openMenu;
  const claimFocus = () => _setFocusedPlatform({ label: group.label, open: () => openRef.current() });
  const releaseFocus = () => { if (_focusedPlatform?.label === group.label) _setFocusedPlatform(null); };
  useEffect(() => releaseFocus, []);

  // Hold A as well, exactly as CollectionTile does it — the grid already
  // teaches that idiom, and it comes with the ⋯ chip that advertises itself.
  const holdTimer = useRef<any>(null);
  const held = useRef(false);
  const onBtnDown = (e: any) => {
    if (e?.detail?.button !== GamepadButton.OK || e?.detail?.is_repeat) return;
    held.current = false;
    clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => { held.current = true; openMenu(); }, 500);
  };
  const onActivate = () => {
    clearTimeout(holdTimer.current);
    if (held.current) { held.current = false; return; } // hold opened the menu
    onOpen(group);
  };
  useEffect(() => () => clearTimeout(holdTimer.current), []);

  return (
    <Focusable noFocusRing className="romm-ptile-wrap"
      {...({ focusable: focusable !== false } as any)}
      ref={setRefs}
      onActivate={onActivate} onClick={() => onOpen(group)}
      onButtonDown={onBtnDown}
      onOKActionDescription="Open"
      onContextMenu={(e: any) => { e.preventDefault(); e.stopPropagation(); openMenu(); }}
      onFocus={() => { setFocused(true); claimFocus(); _tileFocusScrub(selfRef.current, group.label); }}
      onBlur={() => { setFocused(false); releaseFocus(); }}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      style={{ cursor: 'pointer' }}
    >
      {/* Visuals live on this inner wrapper — NOT the Focusable itself — so the
          gamepad-focusable box carries no ring of its own (Steam otherwise draws
          a faint default outline over our brand ring). Mirrors GameTile. The
          focused look is ALSO expressed as CSS :focus-within (romm-ptile-*
          classes, see V2_ROW_STYLE) so a forced gamepad focus that skips React's
          onFocus still highlights. */}
      <div className="romm-ptile-v" style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: '12px', padding: '24px 16px 18px',
        background: focused ? V2.surface : 'rgba(255,255,255,0.045)',
        border: `1px solid ${focused ? V2.brand : V2.border}`, borderRadius: V2.radiusCard,
        transform: 'scale(1)',
        transition: 'background 0.15s, border-color 0.15s, transform 0.15s, box-shadow 0.15s',
        ...V2Focus.tile(focused),
        position: 'relative',
      }}>
        {/* Same ⋯ HOLD chip CollectionTile uses, so the actions affordance
            reads identically on both grids — and is clickable for mouse users
            on the desktop shell. */}
        {focused && (
          <div
            onClick={(e: any) => { e.stopPropagation(); openMenu(); }}
            style={{
              position: 'absolute', bottom: '6px', right: '6px', zIndex: 3,
              display: 'flex', alignItems: 'center', gap: '4px',
              padding: '2px 6px', borderRadius: V2.radiusChip,
              background: 'rgba(0,0,0,0.62)', color: V2.fg,
              fontSize: '9px', fontWeight: 700, letterSpacing: '0.02em',
              boxShadow: '0 1px 3px rgba(0,0,0,0.5)', pointerEvents: 'auto',
            }}>
            <FaEllipsisH size={9} /><span>{resyncing ? 'SYNCING' : 'HOLD'}</span>
          </div>
        )}
        <div className="romm-ptile-ic" style={{
          width: '72px', height: '72px', display: 'grid', placeItems: 'center',
          color: focused ? V2.brandHover : V2.fg2, opacity: focused ? 1 : 0.9,
          transition: 'color 0.15s',
        }}>
          <PlatformIcon slug={group.slug} fsSlug={group.fs_slug} size={72} />
        </div>
        {/* Fixed two-line box (clamped) so a long name can't make its tile
            taller than its row siblings — every tile ends up the same height
            regardless of label length. */}
        <div className="romm-ptile-lb" style={{
          fontSize: '12px', fontWeight: 600, textAlign: 'center', lineHeight: 1.35,
          color: focused ? V2.fg : V2.fg2,
          height: '2.7em', display: '-webkit-box', WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>
          {group.label}
        </div>
        <div style={{ fontSize: '11px', color: V2.fgMuted }}>
          {group.count} {group.count === 1 ? 'game' : 'games'}
          {group.downloaded != null && group.downloaded > 0 && (
            <span style={{ color: V2.success }}>{`  ·  ${group.downloaded} ↓`}</span>
          )}
        </div>
      </div>
    </Focusable>
  );
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
function clearIdentityCache() {
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


// ── Missing-core picker ──────────────────────────────────────────────────────
// A launch that fails for a missing core is fixable right there, so instead of a
// toast that only names the problem, offer the fix: install the recommended core
// for that platform (or a different one), then start the game. Same glass chrome
// as the user menu.
type CoreGap = {
  platform_name: string;
  platform_slug: string;
  candidates: string[];
  installed_cores: string[];
  can_download: boolean;
  download_reason: string;
};

// Alternatives shown without asking. Two rows cost less attention than a row
// that says "two more rows in here".
const INLINE_CORES = 2;

function coreLabel(name: string): string {
  // Buildbot names are like 'mupen64plus_next' — readable enough once the
  // separators are spaces, and the real identifier still shows underneath.
  return name.replace(/_libretro$/, '').replace(/_/g, ' ');
}

function MissingCoreModal({ gap, onPlay, closeModal }:
  { gap: CoreGap; onPlay: () => void; closeModal?: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<string>('');
  const [showAll, setShowAll] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const recommended = gap.candidates[0] || '';
  const others = gap.candidates.slice(1);

  const install = async (core: string) => {
    setBusy(core); setFailed('');
    try {
      const r = await downloadCore(core);
      if (!r?.success) {
        setFailed(r?.message || `Could not install ${core}`);
        return;
      }
      // Pin it for this platform when it isn't the one we'd have guessed:
      // otherwise resolution could pick a different installed core next time and
      // the user's choice here would look ignored.
      if (core !== recommended && gap.platform_slug) {
        try { await setCoreOverride(gap.platform_slug, core); } catch { /* non-fatal */ }
      }
      setDone(core);
      // The cores page and the emulator status both cache a core count.
      try { await loadEmulatorStatus(true); } catch { /* non-fatal */ }
    } catch (e) {
      setFailed(String(e));
    } finally {
      setBusy(null);
    }
  };

  const playNow = () => { closeModal?.(); onPlay(); };

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
          position: 'relative', width: '420px', maxWidth: '92vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '11px', padding: '10px 10px 12px', minWidth: 0 }}>
            <div style={{
              flexShrink: 0, width: '34px', height: '34px', borderRadius: V2.radiusMd,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: V2.bgElevated, color: V2.brandHover,
            }}><FaPuzzlePiece size={16} /></div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '14px', fontWeight: 700, lineHeight: 1.3 }}>
                {done ? 'Core installed' : `${gap.platform_name} needs a core`}
              </div>
              <div style={{ fontSize: '11.5px', color: V2.fgMuted, marginTop: '2px' }}>
                {done
                  ? `${coreLabel(done)} is ready — start the game.`
                  : 'A core is the emulator that actually runs the game.'}
              </div>
            </div>
          </div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />

          {failed && (
            <div style={{
              margin: '4px', padding: '9px 11px', borderRadius: V2.radiusMd,
              background: 'rgba(255,80,80,0.10)', color: V2.danger,
              fontSize: '11.5px', lineHeight: 1.4,
            }}>{failed}</div>
          )}

          {done ? (
            <UserMenuRow icon={<FaPlay size={14} />} label="Play now" onSelect={playNow} />
          ) : !gap.can_download ? (
            // Dead ends still need a focusable row: without one nothing inside
            // the panel takes gamepad focus, so B never reaches this modal and
            // navigates the page behind it instead.
            <>
              <div style={{ padding: '4px 12px 10px', fontSize: '12px', color: V2.fgMuted, lineHeight: 1.45 }}>
                {gap.download_reason
                  || 'Cores cannot be installed from here. Add one in RetroArch, then try again.'}
              </div>
              <CoreDeadEndActions closeModal={closeModal} />
            </>
          ) : !gap.candidates.length ? (
            <>
              <div style={{ padding: '4px 12px 10px', fontSize: '12px', color: V2.fgMuted, lineHeight: 1.45 }}>
                No core for {gap.platform_name} is available from the libretro
                buildbot for this system. You can install one inside RetroArch and
                pick it in Settings ▸ Emulator Cores.
              </div>
              <CoreDeadEndActions closeModal={closeModal} />
            </>
          ) : (
            <>
              <CoreOption core={recommended} recommended busy={busy === recommended}
                disabled={!!busy} onSelect={() => install(recommended)} />
              {/* One or two alternatives are shorter than the row that would
                  hide them, so show them. Collapse only when the list is long
                  enough that it would bury the recommendation. */}
              {others.length > 0 && others.length <= INLINE_CORES && others.map((c) => (
                <CoreOption key={c} core={c} busy={busy === c} disabled={!!busy}
                  onSelect={() => install(c)} />
              ))}
              {others.length > INLINE_CORES && !showAll && (
                <UserMenuRow icon={<FaChevronRight size={13} />}
                  label={`Other cores (${others.length})`} disabled={!!busy}
                  onSelect={() => setShowAll(true)} />
              )}
              {others.length > INLINE_CORES && showAll && others.map((c) => (
                <CoreOption key={c} core={c} busy={busy === c} disabled={!!busy}
                  onSelect={() => install(c)} />
              ))}
              <div style={{ height: '1px', background: V2.border, margin: '4px' }} />
              <UserMenuRow icon={<FaCog size={14} />} label="Manage cores"
                disabled={!!busy}
                onSelect={() => { closeModal?.(); libNavigate('/romm-sync-cores'); }} />
            </>
          )}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

// Rows for the branches that have no core to offer. "Manage cores" is the only
// way forward from here; "Close" exists so the panel always owns focus.
function CoreDeadEndActions({ closeModal }: { closeModal?: () => void }) {
  return (
    <>
      <div style={{ height: '1px', background: V2.border, margin: '4px' }} />
      <UserMenuRow icon={<FaCog size={14} />} label="Manage cores"
        onSelect={() => { closeModal?.(); libNavigate('/romm-sync-cores'); }} />
      <UserMenuRow icon={<FaTimes size={14} />} label="Close"
        onSelect={() => closeModal?.()} />
    </>
  );
}

// One installable core in the picker: name, what it is, and its state.
function CoreOption({ core, recommended, busy, disabled, onSelect }:
  { core: string; recommended?: boolean; busy?: boolean; disabled?: boolean; onSelect: () => void }) {
  const [hot, setHot] = useState(false);
  return (
    <Focusable noFocusRing onActivate={() => !disabled && onSelect()} onClick={() => !disabled && onSelect()}
      onFocus={() => setHot(true)} onBlur={() => setHot(false)}
      onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: '11px', padding: '9px 12px',
        borderRadius: V2.radiusMd, cursor: disabled ? 'default' : 'pointer',
        background: (hot && !disabled) ? V2.surfaceHover : 'transparent',
        transition: 'background 0.12s ease', opacity: disabled && !busy ? 0.55 : 1,
      }}>
      <div style={{ flexShrink: 0, width: '16px', display: 'flex', justifyContent: 'center', color: V2.fgMuted }}>
        {busy
          ? <FaSync size={13} style={{ animation: 'spin 1s linear infinite' }} />
          : <FaDownload size={13} />}
      </div>
      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
        <div style={{ fontSize: '13.5px', fontWeight: 500, textTransform: 'capitalize' }}>
          {coreLabel(core)}
          {recommended && (
            <span style={{
              marginLeft: '7px', fontSize: '9.5px', fontWeight: 800, letterSpacing: '0.04em',
              textTransform: 'uppercase', color: V2.brandHover,
            }}>recommended</span>
          )}
        </div>
        <div style={{ fontSize: '10.5px', color: V2.fgFaint, marginTop: '1px' }}>
          {busy ? 'Installing…' : core}
        </div>
      </div>
    </Focusable>
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

// Per-platform actions from the platforms grid, in the account-menu chrome.
// This was a Steam `showContextMenu` and looked borrowed — Steam's menu carries
// its own typography, radius and highlight, so it read as a different product
// dropped into the middle of ours. Every other menu in the library (account,
// collection, folder) is this glass panel, so this one is too.
function PlatformActionsModal({ label, slug, count, downloaded, resyncing, onSync, onOpen, closeModal }:
  {
    label: string; slug?: string; count?: number; downloaded?: number;
    resyncing: boolean; onSync: () => void; onOpen: () => void; closeModal?: () => void;
  }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60); return () => clearTimeout(t); }, []);
  const sub = [
    count != null ? `${count.toLocaleString()} ${count === 1 ? 'game' : 'games'}` : '',
    downloaded ? `${downloaded.toLocaleString()} downloaded` : '',
  ].filter(Boolean).join('  ·  ');
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
          {/* Identity header — the platform's own icon and name, in the slot
              UserMenuModal gives the avatar. The menu is opened from a grid of
              near-identical cards, so it has to say which one it belongs to. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 8px 12px', minWidth: 0 }}>
            <div style={{ width: '30px', height: '30px', flexShrink: 0, display: 'grid', placeItems: 'center', color: V2.fg2 }}>
              <PlatformIcon slug={slug} size={30} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontSize: '13px', fontWeight: 700, color: V2.fg, lineHeight: 1.3,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{label}</div>
              {sub && <div style={{
                fontSize: '10.5px', fontWeight: 600, color: V2.fgMuted,
                marginTop: '2px', whiteSpace: 'nowrap',
              }}>{sub}</div>}
            </div>
          </div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />
          <UserMenuRow icon={<FaGamepad size={15} />} label="Open platform"
            onSelect={() => { closeModal?.(); onOpen(); }} />
          <UserMenuRow
            icon={<FaSync size={15} style={resyncing ? { animation: 'spin 1s linear infinite' } : undefined} />}
            label={resyncing ? 'Syncing…' : 'Sync this platform'} disabled={resyncing}
            onSelect={() => { if (resyncing) return; closeModal?.(); onSync(); }} />
          {/* BIOS is a property of the platform, so it belongs here for the same
              reason CollectionActionsModal only offers it on platforms. */}
          {slug && (
            <UserMenuRow icon={<FaMicrochip size={15} />} label="Firmware / BIOS"
              onSelect={() => { closeModal?.(); showModal(<BiosDetailModal slug={slug} platformName={label} />); }} />
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
let _focusedPlatform: { label: string; open: () => void } | null = null;
const _focusedPlatformSubs = new Set<(p: typeof _focusedPlatform) => void>();
function _setFocusedPlatform(p: typeof _focusedPlatform) {
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


// RomM RTabNav "underlined" variant — tabs over a bottom border with a 2px
// brand underline that slides between the active tab (GameDetails tab strip).
function V2TabNav({ tabs, active, onTab }:
  { tabs: { id: string; label: string }[]; active: string; onTab: (id: string) => void }) {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);
  const idx = tabs.findIndex((t) => t.id === active);
  useEffect(() => {
    const el = refs.current[idx];
    if (el) setInd({ left: el.offsetLeft, width: el.offsetWidth });
  }, [idx, tabs.length]);
  return (
    // Deliberately NOT gamepad-focusable: tabs switch with L1/R1 only (the
    // Bumper hints render beside the strip), so the dpad walks straight from
    // the action buttons into the tab CONTENT without stepping through pills.
    // The labels stay clickable for touch/mouse.
    <div style={{ position: 'relative', display: 'flex', gap: '2px', borderBottom: `1px solid ${V2.borderStrong}` }}>
      {tabs.map((t, i) => {
        const on = active === t.id;
        return (
          <div key={t.id} onClick={() => onTab(t.id)} ref={(el) => { refs.current[i] = el; }}
            style={{
              padding: '8px 18px', fontSize: '13px', cursor: 'pointer',
              fontWeight: 500, color: on ? V2.fg : V2.fgMuted, transition: 'color 0.15s ease',
            }}>
            {t.label}
          </div>
        );
      })}
      {ind && (
        <div style={{
          position: 'absolute', bottom: '-1px', height: '2px', borderRadius: '2px 2px 0 0',
          left: `${ind.left}px`, width: `${ind.width}px`, background: V2.brand,
          transition: 'left 0.25s cubic-bezier(0.22,1,0.36,1), width 0.25s cubic-bezier(0.22,1,0.36,1)',
        }} />
      )}
    </div>
  );
}


// A percentage padded to three cells with U+2007 FIGURE SPACE, which in any
// sane font is exactly one digit wide. Combined with `fontVariantNumeric:
// tabular-nums` on the button, this makes "5%" and "100%" render at the SAME
// width, so a counting progress label cannot resize the pill around it. A
// pixel minWidth alone could not do this: it only sets a floor, and the label
// still outgrew it at 100%.
function padPct(n: number): string {
  return String(n).padStart(3, '\u2007');
}


// ── GameDetails sub-components (faithful to RomM's OverviewTab / MetadataTab) ──

// Uppercase eyebrow heading for an overview section (RomM
// .overview-tab__section-heading).
function SectionHeading({ icon, children }: { icon?: any; children: any }) {
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

// PlayerCountBadge — pill with a player icon whose glyph scales with the
// max player count parsed from the free-form string (RomM PlayerCountBadge).
function PlayerCountBadge({ value }: { value: string }) {
  const nums = (value.match(/\d+/g) || []).map(Number);
  const n = nums.length ? Math.max(...nums) : null;
  const label = n === 1 ? 'Single player' : (n && n > 1) ? `${value} players` : value;
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '5px 12px 5px 10px',
      background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusPill,
      fontSize: '12px', color: V2.fg2,
    }}>
      <FaUsers size={14} color={V2.brand} />
      <span style={{ fontWeight: 600, letterSpacing: '0.01em' }}>{label}</span>
    </div>
  );
}

// AgeRatingBadges — 44px icon badges from the IGDB rating-icon CDN (loaded
// directly), falling back to a shield text chip when the icon 404s (RomM
// AgeRatingBadges).
function AgeRatingBadge({ item }: { item: { category: string; rating: string; icon_url: string | null } }) {
  const [failed, setFailed] = useState(false);
  const label = item.category ? `${item.category}: ${item.rating}` : item.rating;
  if (item.icon_url && !failed) {
    return <img src={item.icon_url} alt={label} title={label} loading="lazy"
      onError={() => setFailed(true)}
      style={{
        width: '44px', height: '44px', objectFit: 'contain', borderRadius: V2.radiusSm,
        background: V2.surface, padding: '3px', border: `1px solid ${V2.border}`
      }} />;
  }
  return (
    <span title={label} style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '4px 10px',
      background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusChip,
      fontSize: '11.5px', fontWeight: 600, color: V2.fg2, letterSpacing: '0.02em',
    }}>🛡 {label}</span>
  );
}
function AgeRatingBadges({ items }: { items: any[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
      {items.map((b, i) => <AgeRatingBadge key={i} item={b} />)}
    </div>
  );
}

// HLTBStrip — up to four columns (main story / +extra / completionist / all
// styles). Durations are seconds → hours rounded to 0.5h (RomM HLTBStrip).
function HLTBStrip({ hltb }: { hltb: any }) {
  const fmtHours = (secs?: number | null): string | null => {
    if (!secs || secs <= 0) return null;
    const hours = secs / 3600;
    if (hours < 1) { const m = Math.round(secs / 60); return m > 0 ? `${m}m` : null; }
    return `${Math.round(hours * 2) / 2}h`;
  };
  const candidates: [string, number | undefined, number | undefined][] = [
    ['Main Story', hltb?.main_story, hltb?.main_story_count],
    ['Main + Extra', hltb?.main_plus_extra, hltb?.main_plus_extra_count],
    ['Completionist', hltb?.completionist, hltb?.completionist_count],
    ['All Styles', hltb?.all_styles, hltb?.all_styles_count],
  ];
  const entries = candidates
    .map(([label, v, c]) => ({ label, value: fmtHours(v), count: c }))
    .filter((e) => e.value);
  if (!entries.length) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', background: V2.bgElevated,
      border: `1px solid ${V2.border}`, borderRadius: V2.radiusLg, padding: '14px 0', maxWidth: '720px',
    }}>
      {entries.map((e, i) => (
        <div key={e.label} style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
          padding: '0 12px', borderRight: i < entries.length - 1 ? `1px solid ${V2.border}` : 'none',
        }}>
          <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: V2.fgFaint, textAlign: 'center' }}>{e.label}</div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: V2.fg }}>{e.value}</div>
          {e.count ? <div style={{ fontSize: '10px', color: V2.fgFaint }}>{e.count.toLocaleString()} players</div> : null}
        </div>
      ))}
    </div>
  );
}

// InfoGrid — two-column section grid; each section is icon + uppercase label
// over a row of chips (RomM InfoGrid).
function InfoGrid({ sections }: { sections: { label: string; items: string[]; icon?: any }[] }) {
  const visible = sections.filter((s) => s.items.length > 0);
  if (!visible.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, auto))', gap: '18px 24px', width: '100%' }}>
      {visible.map((s) => (
        <div key={s.label}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px', marginBottom: '8px',
            fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: V2.fgFaint,
          }}>
            {s.icon && <span style={{ color: V2.brand, display: 'inline-flex' }}>{s.icon}</span>}
            <span>{s.label}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {s.items.map((it, i) => (
              <span key={i} style={{
                background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusChip,
                padding: '4px 10px', fontSize: '11.5px', fontWeight: 500, color: V2.fg2,
              }}>{it}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// RelatedGameCard — static cover tile using IGDB's external cover URL (loads
// directly, no auth). Cover + truncated label, focus lift (RomM RelatedGameCard
// in GameCard static mode). Non-navigating (synthetic).
function RelatedGameCard({ game }: { game: { id: number; name: string; cover_url?: string | null } }) {
  const [focused, setFocused] = useState(false);
  // IGDB thumb URLs are tiny (t_thumb); request the bigger cover art variant.
  const cover = game.cover_url ? game.cover_url.replace('/t_thumb/', '/t_cover_big/') : null;
  return (
    <Focusable noFocusRing
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      style={{ width: '110px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '6px', cursor: 'default' }}
    >
      <div style={{
        width: '100%', aspectRatio: '3 / 4', borderRadius: V2.radiusArt, overflow: 'hidden',
        background: V2.coverPlaceholder, display: 'flex', alignItems: 'center', justifyContent: 'center',
        transform: 'scale(1)', transition: 'transform 0.18s ease, box-shadow 0.18s ease',
        ...V2Focus.tile(focused),
      }}>
        {cover
          ? <img src={cover} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          : <span style={{ color: V2.fgMuted, fontSize: '10px', padding: '0 6px', textAlign: 'center' }}>{game.name}</span>}
      </div>
      <div style={{
        fontSize: '11px', color: focused ? V2.fg : V2.fg2, textAlign: 'center',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{game.name}</div>
    </Focusable>
  );
}

// One related-games section: eyebrow heading + flex-wrap row of cards.
function RelatedSection({ icon, title, items }: { icon: any; title: string; items: any[] }) {
  if (!items?.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <SectionHeading icon={icon}>{title}</SectionHeading>
      <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', flexWrap: 'wrap', gap: '14px 16px', padding: '6px 6px 4px' }}>
        {items.map((g) => <RelatedGameCard key={g.id ?? g.name} game={g} />)}
      </Focusable>
    </div>
  );
}

// Metadata-provider registry (RomM providers.ts): id field · brand colour ·
// logo asset · external URL builder.
const PROVIDERS: { key: string; name: string; color: string; logo: string; url: ((id: any) => string) | null }[] = [
  { key: 'igdb_id', name: 'IGDB', color: '#6366f1', logo: '/assets/scrappers/igdb.png', url: (id) => `https://www.igdb.com/search?type=1&q=${id}` },
  { key: 'moby_id', name: 'MobyGames', color: '#f59e0b', logo: '/assets/scrappers/moby.png', url: (id) => `https://www.mobygames.com/game/${id}/` },
  { key: 'ss_id', name: 'ScreenScraper', color: '#3b82f6', logo: '/assets/scrappers/ss.png', url: (id) => `https://www.screenscraper.fr/gameinfos.php?gameid=${id}` },
  { key: 'ra_id', name: 'RetroAchievements', color: '#ef4444', logo: '/assets/scrappers/ra.png', url: (id) => `https://retroachievements.org/game/${id}` },
  { key: 'sgdb_id', name: 'SteamGridDB', color: '#0ea5e9', logo: '/assets/scrappers/sgdb.png', url: (id) => `https://www.steamgriddb.com/game/${id}` },
  { key: 'launchbox_id', name: 'LaunchBox', color: '#8b5cf6', logo: '/assets/scrappers/launchbox.png', url: (id) => `https://gamesdb.launchbox-app.com/games/dbid/${id}` },
  { key: 'hasheous_id', name: 'Hasheous', color: '#6b7280', logo: '/assets/scrappers/hasheous.png', url: null },
  { key: 'flashpoint_id', name: 'Flashpoint Archive', color: '#f97316', logo: '/assets/scrappers/flashpoint.png', url: null },
  { key: 'hltb_id', name: 'HowLongToBeat', color: '#22c55e', logo: '/assets/scrappers/hltb.png', url: (id) => `https://howlongtobeat.com/game/${id}` },
];

// ProviderCard — logo + name + linked id (or "Not linked"); clickable when a
// URL resolves. Logo is base64'd via get_image (RomM-served asset).
function ProviderCard({ p, id }: { p: typeof PROVIDERS[number]; id: any }) {
  const [focused, setFocused] = useState(false);
  const logo = useRommImage(p.logo);
  const linked = id !== null && id !== undefined && id !== '' && id !== 0;
  const href = linked && p.url ? p.url(id) : null;
  const open = () => { if (href) try { Navigation?.NavigateToExternalWeb?.(href); } catch { /* ignore */ } };
  return (
    <Focusable noFocusRing
      onActivate={open} onClick={open}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      style={{
        display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 14px',
        background: V2.bgElevated, borderRadius: V2.radiusMd, color: V2.fg,
        border: `1px solid ${focused && href ? p.color : V2.border}`,
        opacity: linked ? 1 : 0.55, cursor: href ? 'pointer' : 'default',
        transform: focused && href ? 'translateY(-1px)' : 'none',
        transition: 'background 0.15s, border-color 0.15s, transform 0.15s',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {logo && <img src={logo} alt={p.name} style={{ width: '16px', height: '16px', objectFit: 'contain', borderRadius: '2px' }} />}
        <span style={{ flex: 1, fontSize: '12.5px', fontWeight: 600, color: V2.fg }}>{p.name}</span>
        {href && <FaExternalLinkAlt size={11} color={V2.fgMuted} />}
      </div>
      <div style={{ fontSize: '11.5px', color: V2.fg2, fontVariantNumeric: 'tabular-nums' }}>
        {linked ? String(id) : <span style={{ fontStyle: 'italic', color: V2.fgFaint }}>Not linked</span>}
      </div>
    </Focusable>
  );
}

// MetadataTab — file info · hashes (click-to-copy) · verification tags ·
// provider grid (RomM MetadataTab).
function MetadataTab({ detail }: { detail: any }) {
  const providers = detail?.providers || {};
  const ordered = [...PROVIDERS].sort((a, b) => {
    const av = providers[a.key] ? 1 : 0, bv = providers[b.key] ? 1 : 0;
    return bv - av;
  });
  const hashes = detail?.hashes || {};
  const hashRows: [string, string | null][] = [
    ['CRC', hashes.crc], ['MD5', hashes.md5], ['SHA1', hashes.sha1], ['RA', hashes.ra],
  ];
  const copy = (v: string) => { try { navigator.clipboard?.writeText(v); toaster.toast({ title: 'Copied', body: v }); } catch { /* ignore */ } };
  const heading = (txt: string) => (
    <div style={{ fontSize: '13px', fontWeight: 600, color: V2.fg }}>{txt}</div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* File info */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {heading('File info')}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px 24px' }}>
          {[['Filename', detail?.fs_name || '—'], ['Size', detail?.fs_size_bytes ? fmtBytes(detail.fs_size_bytes) : '—']].map(([l, v]) => (
            <div key={l as string} style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
              <div style={{ fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: V2.fgFaint }}>{l}</div>
              <div style={{ fontSize: '13px', color: V2.fg2, wordBreak: 'break-all' }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
      {/* Hashes */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {heading('Hashes')}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
          {hashRows.map(([label, val]) => (
            <Focusable key={label} noFocusRing
              onActivate={() => val && copy(val)} onClick={() => val && copy(val)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px',
                background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusChip,
                fontSize: '11.5px', cursor: val ? 'pointer' : 'default',
              }}>
              <span style={{ fontWeight: 700, color: V2.fgFaint, letterSpacing: '0.06em' }}>{label}</span>
              <span style={{ fontFamily: 'monospace', color: val ? V2.fg2 : V2.fgFaint }}>
                {val ? `${String(val).slice(0, 8)}…` : '—'}
              </span>
            </Focusable>
          ))}
        </div>
      </div>
      {/* Verification */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {heading('Verification')}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
          {(detail?.verifications || []).map((v: any) => (
            <span key={v.label} style={{
              display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '4px 10px',
              borderRadius: V2.radiusChip, fontSize: '11.5px', fontWeight: 600,
              background: v.match ? 'rgba(74,222,128,0.12)' : V2.surface,
              border: `1px solid ${v.match ? 'rgba(74,222,128,0.4)' : V2.borderStrong}`,
              color: v.match ? V2.success : V2.fgMuted,
            }}>{v.match ? <FaCheckCircle size={12} /> : <FaTimes size={12} />}{v.label}</span>
          ))}
        </div>
      </div>
      {/* Provider links */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {heading('Metadata sources')}
        <Focusable noFocusRing style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
          {ordered.map((p) => <ProviderCard key={p.key} p={p} id={providers[p.key]} />)}
        </Focusable>
      </div>
    </div>
  );
}

// ── Files tab ───────────────────────────────────────────────────────────────
// Mirrors RomM's ROM Files tab: a header card for the entry itself (filename,
// file count + total size, ROM-level hashes), then one card per RomFile with its
// category, size and own hashes. Everything is visible at once — nothing
// collapses — and the file's path and modified date are deliberately absent,
// because RomM shows neither.
const FILE_CATEGORY_LABEL: Record<string, string> = {
  game: 'Game', dlc: 'DLC', update: 'Update', mod: 'Mod', patch: 'Patch',
  demo: 'Demo', manual: 'Manual', hack: 'Hack', prototype: 'Prototype',
  translation: 'Translation',
};

// RomM abbreviates a hash to its head and tail (e014f6…8c8fe5) — the full value
// is only useful pasted somewhere, and the chip is a copy button, not a readout.
function shortHash(v: string): string {
  return v.length > 16 ? `${v.slice(0, 6)}…${v.slice(-6)}` : v;
}

// A hash as RomM draws it: the algorithm name on a darker inset, the abbreviated
// value in monospace, and a copy affordance. Activating it copies the FULL hash.
function HashChip({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  const copy = () => {
    try { navigator.clipboard?.writeText(value); toaster.toast({ title: `${label} copied`, body: value }); } catch { /* ignore */ }
  };
  return (
    <Focusable noFocusRing onActivate={copy} onClick={copy} style={{
      display: 'inline-flex', alignItems: 'center', gap: '8px', maxWidth: '100%',
      background: V2.surface, border: `1px solid ${V2.borderStrong}`,
      borderRadius: V2.radiusChip, overflow: 'hidden', cursor: 'pointer', fontSize: '11px',
    }}>
      <span style={{
        alignSelf: 'stretch', display: 'flex', alignItems: 'center', padding: '3px 8px',
        background: 'rgba(0,0,0,0.28)', fontWeight: 700, letterSpacing: '0.04em',
        color: V2.fgFaint,
      }}>{label}</span>
      <span style={{
        fontFamily: 'monospace', color: V2.fg2, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{shortHash(value)}</span>
      <FaCopy size={10} style={{ color: V2.fgFaint, flexShrink: 0, marginRight: '8px' }} />
    </Focusable>
  );
}

function HashChipRow({ crc, md5, sha1 }: { crc?: string | null; md5?: string | null; sha1?: string | null }) {
  if (!crc && !md5 && !sha1) return null;
  return (
    // RomM's order: the strongest hash first.
    <Focusable noFocusRing style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
      <HashChip label="SHA-1" value={sha1} />
      <HashChip label="MD5" value={md5} />
      <HashChip label="CRC" value={crc} />
    </Focusable>
  );
}

// One RomFile, laid out as RomM's file card: name line, then category + size,
// then the file's own hashes. No path or modified date — RomM shows neither.
function FileRow({ f }: { f: any }) {
  const cat = String(f?.category || '').toLowerCase();
  const catLabel = FILE_CATEGORY_LABEL[cat] || (cat ? cat : '');
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '8px',
      // radiusLg is the surface radius the Screenshots, Save Data and
      // Achievements tabs use — the file cards and the header card above them
      // all share it so the tab reads as one stack.
      padding: '12px', borderRadius: V2.radiusLg,
      background: V2.surface, border: `1px solid ${V2.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
        {/* On this device? Only shown when the backend could actually read the
            ROM's folder — an unknown state stays blank rather than guessing. */}
        {f?.on_disk === true
          ? <FaCheckCircle size={12} style={{ color: V2.success, flexShrink: 0 }} />
          : <FaLink size={11} style={{ color: V2.fgFaint, flexShrink: 0 }} />}
        <span style={{
          fontSize: '13px', color: f?.missing ? V2.fgFaint : V2.fg, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          textDecoration: f?.missing ? 'line-through' : 'none',
        }}>{f?.name || '—'}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11.5px' }}>
        {catLabel && (
          <span style={{
            flexShrink: 0, padding: '2px 8px', borderRadius: V2.radiusChip,
            background: 'rgba(139,116,232,0.18)', color: V2.brandHover,
            fontSize: '10.5px', fontWeight: 700,
          }}>{catLabel}</span>
        )}
        <span style={{ color: V2.fgMuted }}>{fmtBytes(f?.size)}</span>
        {/* RomM flags files its scanner can no longer find on disk. */}
        {f?.missing && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: V2.fgMuted }}>
            <FaExclamationTriangle size={11} />Missing on server
          </span>
        )}
      </div>
      <HashChipRow crc={f?.crc} md5={f?.md5} sha1={f?.sha1} />
    </div>
  );
}

// ── Switch updates and DLC ──────────────────────────────────────────────────
// A Switch patch is not a file the game reads from beside itself. Eden applies
// add-on content only out of its own registered cache, so "downloaded" and
// "installed" are two different states for the same file, and neither one is
// visible from the file list above — a patch NSP sitting in the library folder
// looks identical whether or not it is doing anything. This section is the
// only place that says which.
//
// Everything comes from the switch_add_ons RPC, which answers {kind: null} for
// anything that is not Switch content, so this renders nothing at all on every
// other platform without the Files tab having to know the platform.
function switchVersionLabel(v: any): string {
  return (v === null || v === undefined || v === '') ? '' : `v${v}`;
}

// Where an add-on actually lives, which is the thing a file list cannot show.
// A record written before the two modes existed has no 'mode' and is a NAND
// install by construction.
function switchAddOnWhere(record: any): string {
  return record?.mode === 'extcontent'
    ? 'In the updates folder' : 'Installed in Eden’s NAND';
}

function SwitchAddOnsSection({ romId }: { romId: number }) {
  const [state, setState] = useState<any | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = async () => {
    try { setState(await getSwitchAddOns(romId)); }
    catch (e) { console.error('switch_add_ons failed', e); setState(null); }
  };
  useEffect(() => { load(); }, [romId]);

  if (!state?.kind) return null;

  // This ROM is itself a patch or an add-on. Its own detail page should say
  // what it belongs to and whether it is live in Eden — listing "its" add-ons
  // would just list itself.
  if (state.kind !== 'base') {
    const label = state.kind === 'update' ? 'Update' : 'DLC';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <SectionHeading icon={<FaPuzzlePiece size={12} />}>Switch add-on</SectionHeading>
        <V2SettingsRow icon={<FaPuzzlePiece size={14} />}
          title={`${label} for ${state.base_id}`}
          subtitle={[state.title_id, switchVersionLabel(state.version),
                     state.installed ? 'Active in Eden' : 'Not active in Eden']
                    .filter(Boolean).join(' · ')}
          right={state.installed
            ? <FaCheckCircle size={12} style={{ color: V2.success }} />
            : <FaLink size={11} style={{ color: V2.fgFaint }} />} />
      </div>
    );
  }

  const update = state.installed_update;
  const dlc: any[] = state.installed_dlc || [];
  // An available add-on is matched to an installed record by the filename the
  // install recorded, which is the only identifier both sides carry: the
  // server row has no title ID until its name is parsed, and the manifest has
  // no ROM ID at all.
  const installedNames = new Set<string>(
    [update, ...dlc].filter(Boolean).map((r: any) => String(r.file_name || '')));
  const available: any[] = (state.available || [])
    .filter((a: any) => !installedNames.has(String(a.file_name || '')));

  if (!update && !dlc.length && !available.length) return null;

  const fetchAddOn = async (a: any) => {
    setBusy(a.rom_id);
    try {
      // The plugin installs a downloaded .nsp/.xci into Eden on the download
      // worker itself, so there is nothing to trigger here afterwards — only
      // the state to re-read.
      const ok = await downloadOne(a.rom_id, a.name || a.file_name);
      toaster.toast({
        title: ok ? 'Add-on installed' : 'Add-on download failed',
        body: a.name || a.file_name,
      });
      await load();
    } finally { setBusy(null); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <SectionHeading icon={<FaPuzzlePiece size={12} />}>Updates &amp; DLC</SectionHeading>
      {update && (
        <V2SettingsRow icon={<FaMicrochip size={14} />}
          title={`Update ${switchVersionLabel(update.version)}`.trim()}
          subtitle={[update.file_name, switchAddOnWhere(update)].filter(Boolean).join(' · ')}
          right={<FaCheckCircle size={12} style={{ color: V2.success }} />} />
      )}
      {dlc.map((d: any) => (
        <V2SettingsRow key={d.title_id} icon={<FaPuzzlePiece size={14} />}
          title={d.file_name || d.title_id}
          subtitle={[d.title_id, switchAddOnWhere(d)].filter(Boolean).join(' · ')}
          right={<FaCheckCircle size={12} style={{ color: V2.success }} />} />
      ))}
      {available.map((a: any) => (
        <V2SettingsRow key={a.rom_id} icon={<FaPuzzlePiece size={14} />}
          // The filename first, not the name: RomM reports an add-on's name as
          // the base game's, so a list keyed on it is several identical rows.
          // The filename is what carries the title ID and the DLC's label.
          title={a.file_name || a.name}
          subtitle={busy === a.rom_id ? 'Downloading…'
            : a.is_downloaded ? 'Downloaded · not active in Eden'
            : 'On the server'}
          disabled={busy !== null}
          onClick={() => fetchAddOn(a)}
          right={<FaDownload size={12} style={{ color: V2.fgMuted }} />} />
      ))}
    </div>
  );
}

function FilesTab({ detail }: { detail: any }) {
  const list = detail?.files || [];
  const total = list.reduce((a: number, f: any) => a + (Number(f?.size) || 0), 0)
    || Number(detail?.fs_size_bytes) || 0;
  // RomM groups the ROM's own files ahead of the extras (DLC, updates, manuals);
  // within a group it keeps filename order, which is what disc numbering needs.
  const ordered = [...list].sort((a: any, b: any) => {
    const rank = (f: any) => (String(f?.category || 'game').toLowerCase() === 'game' ? 0 : 1);
    return rank(a) - rank(b) || String(a?.name || '').localeCompare(String(b?.name || ''));
  });
  const hashes = detail?.hashes || {};
  const count = ordered.length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* ROM header — the whole entry: its filename, what it weighs, and the
          ROM-level hashes. RomM leads the Files tab with this card, above the
          per-file list. */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: '10px',
        padding: '14px', borderRadius: V2.radiusLg,
        background: V2.surface, border: `1px solid ${V2.border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          <FaFolder size={14} style={{ color: V2.fg2, flexShrink: 0 }} />
          <span style={{
            fontSize: '15px', fontWeight: 600, color: V2.fg, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{detail?.fs_name || detail?.name || '—'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: V2.fgMuted, fontSize: '11.5px' }}>
          <span>{count} file{count === 1 ? '' : 's'}</span>
          {total > 0 && <><span>·</span><span>{fmtBytes(total)}</span></>}
          {ordered.some((f: any) => f?.on_disk === true) && (
            <><span>·</span><span>{ordered.filter((f: any) => f?.on_disk === true).length} on this device</span></>
          )}
        </div>
        <HashChipRow crc={hashes.crc} md5={hashes.md5} sha1={hashes.sha1} />
      </div>

      {/* Per-file list, under the same "N files" label RomM puts above it. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ fontSize: '11.5px', color: V2.fgMuted, padding: '0 2px' }}>
          {count} file{count === 1 ? '' : 's'}
        </div>
        {count === 0 ? (
          <div style={{ color: V2.fgMuted, fontSize: '12px' }}>No file information.</div>
        ) : ordered.map((f: any, i: number) => <FileRow key={f?.id ?? i} f={f} />)}
      </div>
    </div>
  );
}

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
const _libGamesCache = new Map<string, LibGame[]>();

// The downloader announces; the cache is what acts on it. See events.ts for
// why this is a subscription rather than a call from the other direction.
_downloadedListeners.add((romId, downloaded) => libCacheSetDownloaded(romId, downloaded));


// Home tab data cache — survives tab-switch remounts so returning to Home paints
// instantly (then refreshes silently) instead of flashing "Loading…".
let _homeCache: {
  recent: LibGame[]; continuePlaying: LibGame[]; downloaded: LibGame[];
  platforms: LibGroup[]; collections: LibGroup[];
} | null = null;

// ---- Persistent browse cache -------------------------------------------------
// The Maps/vars above live in module scope, so they reset every time the plugin
// is reloaded or the Steam UI restarts — the browse lists then have to be
// refetched from the RomM server on the next open. Mirror them into localStorage
// (which survives reloads) so a restart paints from disk instantly and only
// silently refreshes in the background.
const _LS_LIB_PREFIX = 'romm:libcache:v1:';
const _LS_HOME_KEY = 'romm:homecache:v1';
const _LS_TTL_MS = 1000 * 60 * 60 * 24; // 24h; lists rarely churn, dots refresh on fetch

function _persistLibGroup(key: string, list: LibGame[]) {
  if (!_lsAvail) return;
  try { localStorage.setItem(_LS_LIB_PREFIX + key, JSON.stringify({ t: Date.now(), v: list })); } catch { }
}
function _dropLibGroup(key: string) {
  if (!_lsAvail) return;
  try { localStorage.removeItem(_LS_LIB_PREFIX + key); } catch { }
}
// Write-through helpers — use these instead of touching _libGamesCache directly.
function libCacheSet(key: string, list: LibGame[]) { _libGamesCache.set(key, list); _persistLibGroup(key, list); }
function libCacheDelete(key: string) { _libGamesCache.delete(key); _dropLibGroup(key); }
// A game can appear in several cached groups (its platform + any collections), so
// flip is_downloaded across ALL of them. Without this, re-entering a group serves
// the stale cached list and the deleted game still shows as downloaded.
function libCacheSetDownloaded(romId: number, downloaded: boolean) {
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
// Remove a game from every cached group. Called when the server has confirmed
// the ROM is gone — the backend has already dropped it from the library, but
// the cached lists (its platform, any collections, Home) would keep serving the
// tile until the next full refetch, which is exactly the phantom this exists to
// clear. Mirrors libCacheSetDownloaded's fan-out rather than invalidating
// everything, so nothing else has to be re-fetched.
function libCacheDrop(romId: number) {
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
  for (const list of [_homeCache?.downloaded, _homeCache?.recent, _homeCache?.continuePlaying]) {
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
  _libGameHolder = cached || {
    rom_id: romId, name, platform: null,
    is_downloaded: true, has_cover: true,
  };
  _libGameOrigin = origin;
  if (!pushLibView('game')) Navigation.Navigate(`/romm-sync-game/${romId}`);
}

// Open a platform/collection grid from outside the library (a toast click).
// Siblings are optional but strongly preferred: the grid header's carousel pages
// through them with L1/R1, and leaving a stale list from a different mode behind
// means the selected group isn't in its own carousel.
function openGroupPage(mode: string, group: LibGroup, siblings?: LibGroup[]) {
  _libGroupHolder = { mode, group };
  if (siblings?.length) _libGroupsHolder = { mode, groups: siblings };
  else if (_libGroupsHolder?.mode !== mode) _libGroupsHolder = { mode, groups: [group] };
  if (!pushLibView('grid')) Navigation.Navigate(`/romm-sync-library/${encodeURIComponent(group.key)}`);
}

function persistHomeCache() {
  if (!_lsAvail || !_homeCache) return;
  try { localStorage.setItem(_LS_HOME_KEY, JSON.stringify({ t: Date.now(), v: _homeCache })); } catch { }
}

// Platforms/Collections index grids — same pattern as _homeCache: seed the grid
// from cache on tab switch (no "Loading…" flash / full remount pop-in), then
// refresh silently in the background.
const _groupsCache: Record<string, LibGroup[] | undefined> = {};
const _LS_GROUPS_KEY = 'romm:groupscache:v1';
function persistGroupsCache() {
  if (!_lsAvail) return;
  try { localStorage.setItem(_LS_GROUPS_KEY, JSON.stringify({ t: Date.now(), v: _groupsCache })); } catch { }
}

// Wipe every cached browse list, in memory and in localStorage. Called on logout:
// the caches outlive the session, so without this the next sign-in paints the
// previous account's games from disk until a fetch replaces them.
// Not exported — see clearIdentityCache: a named export off this entry file
// breaks the bundle.
function clearBrowseCaches() {
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
    if (o && o.v && (now - (o.t || 0)) < _LS_TTL_MS) _homeCache = o.v;
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

// Session cache for update checks: the section auto-checks on open, and this
// keeps reopening Settings from burning GitHub's anonymous rate limit (60/hr).
let _updCheckCache: { t: number; channel: string; info: any } | null = null;
const _UPD_CACHE_MS = 5 * 60 * 1000;
// Floor on how long a MANUAL update check shows its busy state, so the press
// reads as an action that ran rather than a flicker (see runUpdateCheck).
const MIN_CHECK_MS = 900;


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

// Cold-fetch timer poll, module-level rather than owned by the Settings page.
// Starting the timer navigates back to the library — watching a settings row
// for two minutes is not the point — so the poll has to outlive that page's
// unmount or the result it was started for would never be reported.
let _benchPoll: any = null;
// Set while a timed fetch is in flight, so re-entering Settings shows the row
// still busy instead of an idle button that would start a second run.
let _benchRunning = false;
// Notified when the result lands, so a Settings page that IS open updates its
// row without re-fetching. Also serves as the "in flight" signal for a page
// mounted after the run started.
const _benchListeners = new Set<(b: any) => void>();

function _startBenchPoll(before: string | null) {
  if (_benchPoll) return;
  _benchRunning = true;
  // No timeout: a 50k library over a slow server legitimately takes a very long
  // time, and cutting the poll off would report failure for a fetch that is
  // still running fine.
  _benchPoll = setInterval(async () => {
    try {
      const b = (await getFetchBenchmark())?.result;
      // Compare `at` rather than "a record exists", or a previous run's result
      // would read as this one's.
      if (b && b.at !== before) {
        clearInterval(_benchPoll); _benchPoll = null;
        _benchRunning = false;
        _benchListeners.forEach((l) => { try { l(b); } catch { /* ignore */ } });
        toaster.toast({
          title: 'Cold fetch timed',
          body: `${fmtFetchDuration(b.seconds)} for ${b.roms ?? '?'} ROMs`,
          onClick: () => { try { Navigation.Navigate('/romm-sync-settings'); } catch { /* ignore */ } },
        });
      }
    } catch { /* keep polling; a transient RPC failure is not an answer */ }
  }, 2000);
}

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

interface HistoryEntry {
  id: number; slot: any; save_type: string; file_name: string;
  updated_at: string | null; size_bytes: number | null;
  device: string | null; has_screenshot: boolean;
}

function fmtHistTs(iso: string | null): string {
  if (!iso) return "Unknown time";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function fmtHistSize(n: number | null): string {
  if (n == null || isNaN(n as any)) return "";
  let v = Number(n);
  for (const u of ['B', 'KB', 'MB', 'GB']) {
    if (v < 1024) return u === 'B' ? `${v.toFixed(0)} ${u}` : `${v.toFixed(1)} ${u}`;
    v /= 1024;
  }
  return `${v.toFixed(1)} TB`;
}

function slotLabel(e: HistoryEntry): string {
  const fn = (e.file_name || '').toLowerCase();
  if (fn.endsWith('.state.auto')) return 'Auto';
  const m = fn.match(/\.state(\d+)$/);
  if (m) return `Slot ${m[1]}`;
  if (fn.endsWith('.state')) return 'Quicksave';
  if (e.slot != null && e.slot !== '') return String(e.slot);
  return e.save_type === 'states' ? 'State' : 'Save';
}

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

// Small count tag — RomM RTag x-small used in CardRow headers.
function Tag({ children }: { children: any }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: '18px', height: '18px', padding: '0 6px', borderRadius: V2.radiusChip,
      background: V2.surface, border: `1px solid ${V2.border}`,
      fontSize: '11px', fontWeight: 700, color: V2.fg2, fontVariantNumeric: 'tabular-nums',
    }}>{children}</span>
  );
}

// CardRow — RomM v2 Home section: header (icon + title + count) over a
// horizontal-scroll track. Gamepad focus scrolls the track natively; the
// gradient chevron arrows (RomM style) appear only when the track overflows
// in that direction, signaling "more to the right".
function CardRow({ icon, title, count, children }:
  { icon: any; title: string; count?: number; children: any }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = () => {
    const el = trackRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 8);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8);
  };
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    requestAnimationFrame(update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c as Element);
    return () => ro.disconnect();
  }, [children]);
  const scroll = (dir: -1 | 1) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  // Arrows are always mounted and fade in/out (opacity + slide) with the
  // overflow state so they don't pop; hidden ones drop pointer events.
  const arrow = (dir: -1 | 1, show: boolean): any => ({
    position: 'absolute', top: '50%', zIndex: 10,
    [dir < 0 ? 'left' : 'right']: '8px',
    width: '36px', height: '36px', borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: show ? 'pointer' : 'default', pointerEvents: show ? 'auto' : 'none',
    background: 'rgba(0,0,0,0.4)', color: V2.fg2, border: `1px solid ${V2.border}`,
    backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
    boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
    opacity: show ? 1 : 0,
    transform: `translateY(-50%) translateX(${show ? '0' : `${dir < 0 ? -6 : 6}px`})`,
    transition: 'opacity 0.2s ease, transform 0.2s ease',
  });

  return (
    <section style={{ marginBottom: '22px' }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '0 16px', marginBottom: '12px', color: V2.fg2,
      }}>
        <span style={{ opacity: 0.6, display: 'inline-flex', alignItems: 'center' }}>{icon}</span>
        <h2 style={{ fontSize: '14.5px', fontWeight: 600, letterSpacing: '0.01em', lineHeight: 1.2, margin: 0 }}>{title}</h2>
        {count != null && <Tag>{count}</Tag>}
      </header>
      <div style={{ position: 'relative' }}>
        <div style={arrow(-1, canLeft)} onClick={() => canLeft && scroll(-1)}><FaChevronLeft size={15} /></div>
        <div style={arrow(1, canRight)} onClick={() => canRight && scroll(1)}><FaChevronRight size={15} /></div>
        {/* Top/bottom padding gives the focus scale + glow room so the
            scroll container (overflow-x:auto clips y too) doesn't crop the
            top of hovered covers. Matches RomM's 16/20 track padding. */}
        <div
          ref={trackRef}
          onScroll={update}
          style={{ overflowX: 'auto', overflowY: 'visible' }}
        >
          <Focusable noFocusRing flow-children="horizontal" {...NAV_MAINTAIN_X} style={{ display: 'flex', gap: '12px', padding: '24px 16px 28px' }}>
            {children}
          </Focusable>
        </div>
      </div>
    </section>
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
let _resumeStatesPref = (() => {
  try { return _lsAvail && localStorage.getItem(_LS_RESUME_PREF) === '1'; }
  catch { return false; }
})();
function _setResumeStatesPref(v: boolean) {
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
function invalidateStateThumbs() {
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
  const c0 = _homeCache;
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
        const prev = _homeCache;   // state mirrors this (seed + paired setStates)
        const next = { ...prev } as NonNullable<typeof _homeCache>;
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
        _homeCache = next;
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
const NAV_MAINTAIN_X = { navEntryPreferPosition: 2 } as any;

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
function _tileFocusScrub(_el: any, label: string) {
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
function _clearStale() { _setStale(null); _lastStaleCheck = Date.now(); }

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
  // the group you were just in, not the first tile — _libGroupHolder still
  // holds the last-viewed group (updated on open AND on L1/R1 paging).
  const lastKey = (_libGroupHolder && _libGroupHolder.mode === mode) ? _libGroupHolder.group.key : null;
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
  const [active, setActive] = useState<NavId>(_libLastTab);
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
    _libGroupHolder = { mode: m, group: g };
    _libGroupsHolder = { mode: m, groups: gs };
    if (!pushLibView('grid')) Navigation.Navigate(`/romm-sync-library/${encodeURIComponent(g.key)}`);
  };

  const openGame = (g: LibGame) => {
    _libGameHolder = g;
    // Opened from the home/search/index grid → back returns to the library root.
    _libGameOrigin = "/romm-sync-library";
    if (!pushLibView('game')) Navigation.Navigate(`/romm-sync-game/${g.rom_id}`);
  };

  const onTab = (id: NavId) => { _libLastTab = id; setActive(id); };

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
        const played = _rommLastLaunchedRomId != null
          ? _tileElsByRomId.get(_rommLastLaunchedRomId) : null;
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
    _libLastTab = next;
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
  const holder = _libGroupHolder;
  const mode = holder?.mode || 'platform';
  const [group, setGroup] = useState<LibGroup | null>(holder?.group || null);
  const cacheKey = (k: string) => `${mode}:${k}`;
  const cached0 = group ? _libGamesCache.get(cacheKey(group.key)) : undefined;
  const [games, setGames] = useState<LibGame[]>(cached0 || []);
  const [loading, setLoading] = useState(!cached0);
  const [bgUri, setBgUri] = useState<string | null>(null);

  // Sibling groups (same mode) so the game grid can page prev/next with L1/R1.
  const siblings = (_libGroupsHolder && _libGroupsHolder.mode === mode) ? _libGroupsHolder.groups : [];

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
    _libGameHolder = g;
    // Return to THIS collection/platform's games page when backing out.
    _libGameOrigin = group ? `/romm-sync-library/${encodeURIComponent(group.key)}` : "/romm-sync-library";
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
    _libGroupHolder = { mode, group: next };
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
    _libGroupHolder = { mode, group: g };
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
function useRommImage(path: string | null): string | null {
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

// Fullscreen screenshot lightbox — RCarousel equivalent. L1/R1 or the
// on-screen arrows page through; A/B close.
function ScreenshotLightbox({ paths, index, closeModal }:
  { paths: string[]; index: number; closeModal?: () => void; }) {
  const [i, setI] = useState(index);
  const uri = useRommImage(paths[i]);
  const go = (d: -1 | 1) => setI((p) => (p + d + paths.length) % paths.length);
  const onButtonDown = (evt: any) => {
    const b = evt?.detail?.button;
    if (b === GamepadButton.BUMPER_LEFT) go(-1);
    else if (b === GamepadButton.BUMPER_RIGHT) go(1);
  };
  const multi = paths.length > 1;

  // Sample the left/right edge luminance of the current shot so each arrow can
  // flip to a light or dark scrim and stay legible over the image behind it.
  // true = that edge is dark → use a light scrim with a dark icon.
  const [edgeDark, setEdgeDark] = useState<{ left: boolean; right: boolean }>({ left: true, right: true });
  useEffect(() => {
    if (!uri) { setEdgeDark({ left: true, right: true }); return; }
    let alive = true;
    const img = new Image();
    img.onload = () => {
      try {
        const w = 64, h = Math.max(1, Math.round(64 * img.height / Math.max(1, img.width)));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const lum = (x0: number) => {
          const d = ctx.getImageData(x0, 0, Math.max(1, Math.round(w * 0.18)), h).data;
          let s = 0, n = 0;
          for (let k = 0; k < d.length; k += 4) { s += 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]; n++; }
          return n ? s / n : 0;
        };
        if (alive) setEdgeDark({ left: lum(0) < 140, right: lum(Math.round(w * 0.82)) < 140 });
      } catch { /* canvas may be tainted; keep default */ }
    };
    img.src = uri;
    return () => { alive = false; };
  }, [uri]);

  // Circular scrim arrow matching the Home CardRow chevrons, but with the
  // scrim/icon inverted on bright screenshot edges for contrast.
  const arrowStyle = (side: 'left' | 'right'): any => {
    const dark = side === 'left' ? edgeDark.left : edgeDark.right;
    return {
      position: 'absolute', [side]: '8px', zIndex: 2,
      minWidth: '36px', width: '36px', height: '36px', padding: 0, borderRadius: '50%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: dark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)',
      color: dark ? '#07070f' : V2.fg2,
      border: dark ? '1px solid rgba(0,0,0,0.2)' : `1px solid ${V2.border}`,
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
      transition: 'background 0.2s ease, color 0.2s ease',
    };
  };
  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <Focusable noFocusRing onButtonDown={onButtonDown}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px' }}>
        <div style={{
          position: 'relative', width: '100%', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
        }}>
          {multi && (
            <DialogButton onClick={() => go(-1)} style={arrowStyle('left')}>
              <FaChevronLeft size={15} />
            </DialogButton>
          )}
          {uri ? (
            <img src={uri} style={{
              maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain',
              borderRadius: V2.radiusMd, boxShadow: V2.elev2,
            }} />
          ) : (
            <div style={{
              width: '100%', aspectRatio: '16 / 9', borderRadius: V2.radiusMd,
              background: V2.surface, display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: V2.fgMuted, fontSize: '12px',
            }}>Loading…</div>
          )}
          {multi && (
            <DialogButton onClick={() => go(1)} style={arrowStyle('right')}>
              <FaChevronRight size={15} />
            </DialogButton>
          )}
        </div>
        {multi && (
          <div style={{ fontSize: '12px', color: V2.fgMuted }}>{i + 1} / {paths.length}</div>
        )}
      </Focusable>
    </ModalRoot>
  );
}

// One 16:9 screenshot thumbnail — opens the lightbox on activate.
function ScreenshotThumb({ paths, index }: { paths: string[]; index: number; }) {
  const uri = useRommImage(paths[index]);
  const [focused, setFocused] = useState(false);
  const open = () => showModal(<ScreenshotLightbox paths={paths} index={index} />);
  return (
    <Focusable noFocusRing
      onActivate={open}
      onClick={open}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)}
      onMouseLeave={() => setFocused(false)}
      style={{
        cursor: 'pointer', position: 'relative', aspectRatio: '16 / 9',
        borderRadius: V2.radiusChip, overflow: 'hidden', background: V2.surface,
        transform: 'scale(1)',
        transition: 'transform 0.18s ease, box-shadow 0.18s ease',
        ...V2Focus.tile(focused),
      }}>
      {uri ? (
        <img src={uri} loading="lazy" style={{
          width: '100%', height: '100%', objectFit: 'cover', display: 'block',
        }} />
      ) : null}
    </Focusable>
  );
}

// Responsive grid of screenshot thumbnails (RomM ScreenshotsTab).
function ScreenshotGrid({ paths }: { paths: string[]; }) {
  return (
    <Focusable noFocusRing style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
      gap: '10px', padding: '6px 6px 4px',
    }}>
      {paths.map((p, i) => <ScreenshotThumb key={p || i} paths={paths} index={i} />)}
    </Focusable>
  );
}

type Achievement = {
  ra_id: number | null; title: string; description: string; points: number;
  type: string; badge_id: string | null; badge_url: string | null;
  badge_url_lock: string | null; earned: boolean;
};
type TypeFilter = 'all' | 'progression' | 'missable' | 'win_condition';
type StatusFilter = 'all' | 'earned' | 'locked';

function AchievementsTab({ achievements }: { achievements: Achievement[] }) {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // Which filter pill is focused, so it shows a highlight under the controller
  // (the pills otherwise only reflect active/inactive, not focus).
  const [filterFocus, setFilterFocus] = useState<string | null>(null);
  // Drive the summary progress bar from 0 → pct after mount so it animates in.
  const [barReady, setBarReady] = useState(false);
  useEffect(() => { const t = setTimeout(() => setBarReady(true), 60); return () => clearTimeout(t); }, []);

  if (!achievements.length) {
    return (
      <div style={{ padding: '30px 0', color: V2.fgMuted, fontSize: '13px', fontStyle: 'italic', textAlign: 'center' }}>
        No achievement data for this game.
      </div>
    );
  }

  const earnedCount = achievements.filter((a) => a.earned).length;
  const totalPoints = achievements.reduce((s, a) => s + (a.points || 0), 0);
  const progressionCount = achievements.filter((a) => a.type === 'progression').length;
  const missableCount = achievements.filter((a) => a.type === 'missable').length;

  const isVisible = (a: Achievement) => {
    if (typeFilter !== 'all' && a.type !== typeFilter) return false;
    if (statusFilter === 'earned' && !a.earned) return false;
    if (statusFilter === 'locked' && a.earned) return false;
    return true;
  };

  const typeLabel = (t: string) => t === 'win_condition' ? 'Win Condition' : t.charAt(0).toUpperCase() + t.slice(1);
  const toggleStatus = (s: StatusFilter) => setStatusFilter((cur) => cur === s ? 'all' : s);

  const stat = (val: any, lbl: string, missable = false) => (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', padding: '0 12px' }}>
      <div style={{ fontSize: '20px', fontWeight: 700, color: missable ? V2.warning : V2.fg, fontVariantNumeric: 'tabular-nums' }}>{val}</div>
      <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: V2.fgMuted }}>{lbl}</div>
    </div>
  );

  const typeTagStyle = (t: string): any => {
    const base: any = { fontSize: '9.5px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '2px 7px', borderRadius: '8px' };
    if (t === 'progression') return { ...base, background: 'rgba(99,102,241,0.18)', color: V2.igdb };
    if (t === 'missable') return { ...base, background: 'rgba(251,191,36,0.18)', color: V2.warning };
    if (t === 'win_condition') return { ...base, background: 'rgba(74,222,128,0.18)', color: V2.success };
    return { ...base, background: V2.surface, color: V2.fg2 };
  };

  const filterBtn = (key: string, label: string, active: boolean, onClick: () => void, accent?: 'earned' | 'locked') => {
    let bg = V2.surface, color = V2.fg2, border = V2.border;
    if (active) {
      if (accent === 'earned') { bg = 'rgba(74,222,128,0.30)'; border = 'rgba(74,222,128,0.50)'; color = V2.fg; }
      else if (accent === 'locked') { bg = 'rgba(255,80,80,0.24)'; border = 'rgba(255,80,80,0.45)'; color = V2.fg; }
      else { bg = V2.fg; border = V2.fg; color = V2.bg; }
    }
    const focused = filterFocus === key;
    return (
      <Focusable noFocusRing
        key={key}
        onActivate={onClick}
        onClick={onClick}
        onFocus={() => setFilterFocus(key)} onBlur={() => setFilterFocus((c) => c === key ? null : c)}
        onMouseEnter={() => setFilterFocus(key)} onMouseLeave={() => setFilterFocus((c) => c === key ? null : c)}
        style={{
          background: focused && !active ? V2.surfaceHover : bg,
          border: `1px solid ${focused ? V2.brand : border}`, borderRadius: V2.radiusPill,
          color, padding: '5px 13px', fontSize: '11.5px', fontWeight: 500, cursor: 'pointer',
          transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
          ...V2Focus.flat(focused, { glow: true }),
        }}
      >
        {label}
      </Focusable>
    );
  };

  const pct = achievements.length ? Math.round((earnedCount / achievements.length) * 100) : 0;
  const EASE = 'cubic-bezier(0.22,1,0.36,1)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <style>{`
        @keyframes achFade { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
        .ach-fade { animation: achFade 320ms ${EASE} both; animation-delay: calc(var(--ach-i, 0) * 28ms); }
        /* Row hover is the shared .romm-row (see V2_ROW_STYLE). */
      `}</style>

      <div className="ach-fade" style={{ display: 'flex', flexDirection: 'column', background: V2.surface, border: `1px solid ${V2.border}`, borderRadius: V2.radiusLg, overflow: 'hidden' }}>
        <div style={{ display: 'flex', padding: '14px 0' }}>
          {stat(
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              {earnedCount} / {achievements.length}
              <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: V2.fgMuted }} />
              {pct}%
            </span>, 'Achievements')}
          <div style={{ width: '1px', background: V2.border }} />
          {stat(totalPoints, 'Total Points')}
          {progressionCount > 0 && <><div style={{ width: '1px', background: V2.border }} />{stat(progressionCount, 'Progression')}</>}
          {missableCount > 0 && <><div style={{ width: '1px', background: V2.border }} />{stat(missableCount, 'Missable', true)}</>}
        </div>
        <div style={{ height: '4px', background: 'rgba(255,255,255,0.06)' }}>
          <div style={{
            height: '100%', width: barReady ? `${pct}%` : '0%',
            background: `linear-gradient(90deg, ${V2.brand}, ${V2.success})`,
            borderRadius: '0 2px 2px 0', transition: `width 800ms ${EASE}`,
          }} />
        </div>
      </div>

      <Focusable noFocusRing className="ach-fade" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', '--ach-i': 1 } as any}>
        {(['all', 'progression', 'missable', 'win_condition'] as TypeFilter[]).map((f) =>
          filterBtn(f, typeLabel(f), typeFilter === f, () => setTypeFilter(f)))}
        <span style={{ width: '1px', height: '16px', background: V2.surfaceHover, margin: '0 4px' }} />
        {filterBtn('earned', '✓ Earned', statusFilter === 'earned', () => toggleStatus('earned'), 'earned')}
        {filterBtn('locked', '⊘ Locked', statusFilter === 'locked', () => toggleStatus('locked'), 'locked')}
      </Focusable>

      {/* Filtered-out rows simply unmount (with a fade on the survivors) so the
          list re-flows without a clipping wrapper — that lets the shared
          .romm-row outset glow show, identical to the saves list. */}
      <Focusable noFocusRing style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {achievements.filter(isVisible).map((a, i) => {
          const src = a.earned ? a.badge_url : a.badge_url_lock;
          // Dim LOCKED rows via their contents, not the Focusable itself: the
          // desktop shim reads an inline opacity<1 on a Focusable as the
          // "disabled control" signal and strips its tabindex, which made locked
          // rows unreachable by the controller (Down dead-ended at the filters).
          const dim = a.earned ? 1 : 0.55;
          return (
            <Focusable noFocusRing key={a.ra_id ?? i} onActivate={() => { }} className="romm-row ach-fade" style={{
              display: 'grid', gridTemplateColumns: '52px 1fr auto', gap: '14px', alignItems: 'center',
              padding: '10px 14px', borderRadius: V2.radiusMd,
              '--ach-i': Math.min(i, 12) + 2,
            } as any}>
              <div style={{ width: '52px', height: '52px', borderRadius: '8px', overflow: 'hidden', background: V2.coverPlaceholder, flexShrink: 0, opacity: dim }}>
                {src && <img src={src} alt={a.title} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />}
              </div>
              <div style={{ minWidth: 0, opacity: dim }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: V2.fg }}>{a.title}</div>
                <div style={{ fontSize: '11.5px', color: V2.fgMuted, marginTop: '2px', lineHeight: 1.4 }}>{a.description}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', whiteSpace: 'nowrap', opacity: dim }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: V2.fg2, fontVariantNumeric: 'tabular-nums' }}>{a.points} pts</div>
                {a.type && <span style={typeTagStyle(a.type)}>{typeLabel(a.type)}</span>}
              </div>
            </Focusable>
          );
        })}
      </Focusable>
    </div>
  );
}

// Restore modal — a bare ModalRoot styled entirely in the RomM v2 design
// language (tokens, V2Button) rather than Steam chrome. Previews the chosen
// version (screenshot for states) and exposes Restore / Restore-as-copy /
// Cancel. closeModal is injected by showModal.
function RestoreModal({ romId, entry, shotUri, onDone, closeModal }: {
  romId: number; entry: HistoryEntry; shotUri?: string; onDone: () => void; closeModal?: () => void;
}) {
  const isState = entry.save_type === 'states';
  const [shot, setShot] = useState<string | null>(shotUri ?? null);
  // Fetch a preview for any version (saves can carry screenshots too), unless
  // we were handed a cached one. Loading runs until the fetch resolves.
  const [loadingShot, setLoadingShot] = useState(!shotUri);
  const [busy, setBusy] = useState<null | 'restore' | 'copy'>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (shotUri) return;
    getSaveScreenshot(romId, entry.id, entry.save_type)
      .then((r: any) => setShot(r?.data_uri || null))
      .catch(() => setShot(null))
      .finally(() => setLoadingShot(false));
  }, []);

  // Move controller focus into the overlay (no ModalRoot to do it for us).
  useEffect(() => {
    const t = setTimeout(() => { if (cardRef.current) _forceGamepadFocus(cardRef.current); }, 60);
    return () => clearTimeout(t);
  }, []);

  const run = async (asCopy: boolean) => {
    if (busy) return;
    setBusy(asCopy ? 'copy' : 'restore');
    try {
      const res = await restoreSaveVersion(romId, entry.id, entry.save_type, asCopy);
      if (res?.success) {
        toaster.toast({ title: 'Restored', body: res.tgt_name ? `→ ${res.tgt_name}` : 'Version restored' });
        onDone();
        closeModal?.();
      } else {
        toaster.toast({ title: 'Restore failed', body: res?.message || 'Unknown error' });
        setBusy(null);
      }
    } catch (e) {
      toaster.toast({ title: 'Restore failed', body: String(e) });
      setBusy(null);
    }
  };

  const meta = [slotLabel(entry), entry.device || '', fmtHistSize(entry.size_bytes)].filter(Boolean).join(' · ');

  return (
    <ModalRoot bHideCloseIcon onCancel={closeModal} onEscKeypress={closeModal}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing
        className="romm-ui"
        onCancelButton={() => closeModal?.()}
        onButtonDown={(e: any) => { if (e?.detail?.button === GamepadButton.CANCEL) closeModal?.(); }}
        style={{
          position: 'fixed', inset: MODAL_SCRIM_INSET, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(7,7,15,0.45)',
          WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
        }}
      >
        <style>{`
        @keyframes sdShimmer { 0% { background-position: -150% 0; } 100% { background-position: 150% 0; } }
        .sd-shimmer { background-image: linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.22) 50%, transparent 80%) !important; background-size: 200% 100% !important; background-repeat: no-repeat; animation: sdShimmer 1.1s linear infinite; }
        ${V2_FOCUS_STYLE}
        /* Collapse ModalRoot's own panel chrome so only our overlay shows. */
        .romm-modal-collapse, .romm-modal-collapse > div {
          background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important;
        }
      `}</style>
        <Focusable noFocusRing autoFocus ref={cardRef} flow-children="vertical" style={{
          fontFamily: V2.font, color: V2.fg, width: '520px', maxWidth: '90vw', boxSizing: 'border-box',
          padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px',
          maxHeight: '82vh', overflowY: 'auto',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
        }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: V2.brand }}>
              Restore {isState ? 'state' : 'save'}
            </div>
            <div style={{ fontSize: '20px', fontWeight: 800, marginTop: '4px' }}>{fmtHistTs(entry.updated_at)}</div>
            {meta && <div style={{ fontSize: '13px', color: V2.fg2, marginTop: '4px' }}>{meta}</div>}
          </div>

          <div className={loadingShot ? 'sd-shimmer' : ''} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            minHeight: loadingShot || !shot ? '120px' : undefined,
            backgroundColor: (loadingShot || !shot) ? V2.coverPlaceholder : 'transparent',
            borderRadius: V2.radiusLg, overflow: 'hidden',
            border: (loadingShot || !shot) ? `1px solid ${V2.border}` : 'none',
          }}>
            {loadingShot ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', color: V2.fgMuted }}>
                <FaSync size={16} style={{ animation: 'spin 1s linear infinite' }} />
                <span style={{ fontSize: '12px' }}>Loading preview…</span>
              </div>
            ) : shot ? (
              <img src={shot} style={{ maxWidth: '100%', maxHeight: '210px', width: 'auto', display: 'block', borderRadius: V2.radiusLg }} />
            ) : (
              <span style={{ fontSize: '12px', color: V2.fgMuted }}>No preview available</span>
            )}
          </div>

          <div style={{ fontSize: '12.5px', color: V2.fg2, lineHeight: 1.55, background: V2.surface, border: `1px solid ${V2.border}`, borderRadius: V2.radiusMd, padding: '10px 12px' }}>
            <span style={{ color: V2.fg, fontWeight: 600 }}>Restore (overwrite)</span> replaces the current file with this version. The current file is backed up first.
            {isState && <><br /><span style={{ color: V2.fg, fontWeight: 600 }}>Restore as copy</span> writes this version into a new free slot, leaving your current slots untouched.</>}
          </div>

          <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', gap: '8px', flexWrap: 'nowrap', justifyContent: 'flex-end', alignItems: 'center' }}>
            <V2Button variant="text" disabled={!!busy} onClick={() => closeModal?.()}>Cancel</V2Button>
            {isState && (
              <V2Button variant="tonal" disabled={!!busy} onClick={() => run(true)}>
                {busy === 'copy' ? <FaSync size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <FaCopy size={12} />}
                <span>Restore as copy</span>
              </V2Button>
            )}
            <V2Button variant="danger" disabled={!!busy} onClick={() => run(false)}>
              {busy === 'restore' ? <FaSync size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <FaUndo size={12} />}
              <span>Restore (overwrite)</span>
            </V2Button>
          </Focusable>
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

// Inline Save Data tab — Saves + States subtabs, mirrors RomM's SaveDataTab.
// Saves are a vertical info list; States are a screenshot tile grid. Selecting
// an item reveals inline restore actions (restore-in-place, and restore-as-copy
// for states) backed by the same callables the standalone history page uses.
function SaveDataTab({ romId }: { romId: number }) {
  const [sub, setSub] = useState<'saves' | 'states'>('saves');
  const [loading, setLoading] = useState(true);
  const [saves, setSaves] = useState<HistoryEntry[]>([]);
  const [states, setStates] = useState<HistoryEntry[]>([]);
  // shots[id]: 'loading' while fetching, '' once resolved with no screenshot,
  // otherwise the data URI. Absence means not yet requested.
  const [shots, setShots] = useState<Record<number, string>>({});
  // Gamepad focus under gamescope doesn't reliably fire CSS :focus-within, so
  // the selected save/state gets no highlight. Track the focused entry in JS
  // and paint the brand highlight explicitly (same approach as the nav tabs).
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [pillFocus, setPillFocus] = useState<'saves' | 'states' | null>(null);
  const EASE = 'cubic-bezier(0.22,1,0.36,1)';

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await getSaveHistory(romId);
      if (res?.success) {
        setSaves(res.saves || []);
        setStates(res.states || []);
      } else if (!silent) {
        setSaves([]); setStates([]);
      }
    } catch (e) {
      console.error('get_save_history failed', e);
      if (!silent) { setSaves([]); setStates([]); }
    } finally {
      if (!silent) setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // After a restore the new version is written locally and the file watcher
  // uploads it to the server a moment later. Mirror the GTK app's
  // _await_restore_sync: snapshot the current ids, wait for the upload debounce,
  // then poll once a second until a new id appears (bounded deadline).
  const pollCancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => pollCancelRef.current?.(), []);
  const reloadAfterRestore = () => {
    pollCancelRef.current?.();
    const baseline = new Set<number>([...saves, ...states].map((e) => e.id));
    let cancelled = false;
    pollCancelRef.current = () => { cancelled = true; };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      await sleep(3500); // upload debounce + buffer
      const deadline = Date.now() + 20000;
      while (!cancelled) {
        try {
          const res = await getSaveHistory(romId);
          if (res?.success) {
            const ids = [...(res.saves || []), ...(res.states || [])].map((e: any) => e.id);
            const hasNew = ids.some((id) => !baseline.has(id));
            if (hasNew || Date.now() >= deadline) {
              setSaves(res.saves || []); setStates(res.states || []);
              return;
            }
          }
        } catch { /* keep polling */ }
        if (Date.now() >= deadline) return;
        await sleep(1000);
      }
    })();
  };

  // Lazily fetch state screenshots once the States subtab is opened. The
  // backend serves them one request at a time, so fetch sequentially, newest
  // first, and commit each result as it lands — tiles fill in progressively
  // instead of all appearing only once the last one finishes.
  const requestedRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (sub !== 'states') return;
    const queue = states
      .filter((s) => !requestedRef.current.has(s.id))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    if (!queue.length) return;
    queue.forEach((s) => requestedRef.current.add(s.id));
    setShots((p) => {
      const next = { ...p };
      queue.forEach((s) => { if (!(s.id in next)) next[s.id] = 'loading'; });
      return next;
    });
    let cancelled = false;
    (async () => {
      for (const s of queue) {
        if (cancelled) return;
        try {
          const r: any = await getSaveScreenshot(romId, s.id, 'states');
          setShots((p) => ({ ...p, [s.id]: r?.data_uri || '' }));
        } catch {
          setShots((p) => ({ ...p, [s.id]: '' }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [sub, states]);

  const openRestore = (e: HistoryEntry) => {
    const cached = shots[e.id];
    const shotUri = (cached && cached !== 'loading') ? cached : undefined;
    showModal(<RestoreModal romId={romId} entry={e} shotUri={shotUri} onDone={reloadAfterRestore} />);
  };

  const pill = (id: 'saves' | 'states', label: string, count: number) => {
    const active = sub === id;
    const focused = pillFocus === id;
    return (
      <Focusable noFocusRing
        key={id}
        onActivate={() => setSub(id)}
        onClick={() => setSub(id)}
        onFocus={() => setPillFocus(id)} onBlur={() => setPillFocus((c) => c === id ? null : c)}
        onMouseEnter={() => setPillFocus(id)} onMouseLeave={() => setPillFocus((c) => c === id ? null : c)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '7px',
          background: active ? V2.fg : (focused ? V2.surfaceHover : V2.surface),
          border: `1px solid ${active ? V2.fg : (focused ? V2.brand : V2.border)}`,
          borderRadius: V2.radiusPill, color: active ? V2.bg : V2.fg2,
          padding: '5px 14px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
          transition: 'background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
          // Ring on focus even when the pill is the ACTIVE one (like the
          // achievements filters) — the tab-switch focus-pull lands here, and
          // without the ring the landing was invisible.
          ...V2Focus.flat(focused, { glow: true }),
        }}
      >
        {label}
        <span style={{
          fontSize: '10px', fontWeight: 700, padding: '0px 6px', borderRadius: V2.radiusPill,
          background: active ? 'rgba(0,0,0,0.18)' : V2.surfaceHover, color: active ? V2.bg : V2.fgMuted,
        }}>{count}</span>
      </Focusable>
    );
  };

  // Group a type's entries by slot, newest-first within each slot (the newest
  // is the live/current file). Mirrors the standalone history browser.
  const groupBySlot = (entries: HistoryEntry[]) => {
    const groups: Record<string, HistoryEntry[]> = {};
    entries.forEach((e) => {
      const slot = (e.slot != null && e.slot !== '') ? String(e.slot) : slotLabel(e);
      (groups[slot] = groups[slot] || []).push(e);
    });
    return Object.keys(groups).sort().map((slot) => ({
      slot,
      items: groups[slot].slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))),
    }));
  };

  const slotHeader = (slot: string, count: number) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '2px 0' }}>
      <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: V2.fgMuted, whiteSpace: 'nowrap' }}>Slot: {slot}</span>
      <span style={{ flex: 1, height: '1px', background: V2.border }} />
      <span style={{ fontSize: '10px', color: V2.fgMuted, whiteSpace: 'nowrap' }}>{count} version{count === 1 ? '' : 's'}</span>
    </div>
  );

  const currentChip = (
    <span style={{ fontSize: '9.5px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', padding: '1px 7px', borderRadius: V2.radiusPill, background: 'rgba(74,222,128,0.18)', color: V2.success }}>Current</span>
  );

  if (loading) {
    return <div style={{ color: V2.fgMuted, fontSize: '12px', padding: '12px 0' }}>Loading save data…</div>;
  }

  const total = saves.length + states.length;
  if (total === 0) {
    return <div style={{ color: V2.fgMuted, fontSize: '13px', padding: '24px 0', textAlign: 'center', fontStyle: 'italic' }}>
      No server saves or states for this game yet.
    </div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <style>{`
        @keyframes sdFade { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .sd-fade { animation: sdFade 300ms ${EASE} both; animation-delay: calc(var(--sd-i, 0) * 26ms); }
        /* Row/tile hover is the shared .romm-row / .romm-tile (see V2_ROW_STYLE). */
        @keyframes sdShimmer { 0% { background-position: -150% 0; } 100% { background-position: 150% 0; } }
        .sd-shimmer { background-image: linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.22) 50%, transparent 80%) !important; background-size: 200% 100% !important; background-repeat: no-repeat; animation: sdShimmer 1.1s linear infinite; }
      `}</style>

      <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', gap: '8px' }}>
        {pill('saves', 'Saves', saves.length)}
        {pill('states', 'States', states.length)}
      </Focusable>

      {sub === 'saves' ? (
        saves.length === 0 ? (
          <div style={{ color: V2.fgMuted, fontSize: '12px', padding: '12px 0' }}>No saves for this game.</div>
        ) : (
          <Focusable noFocusRing style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {groupBySlot(saves).map((g) => (
              <div key={`sg-${g.slot}`} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {slotHeader(g.slot, g.items.length)}
                {g.items.map((e, idx) => {
                  const isCur = idx === 0;
                  const sub2 = [e.device || '', fmtHistSize(e.size_bytes)].filter(Boolean).join(' · ');
                  return (
                    <div key={`save-${e.id}`} className="sd-fade" style={{ '--sd-i': Math.min(idx, 14) } as any}>
                      <Focusable noFocusRing
                        className="romm-row"
                        onActivate={() => openRestore(e)}
                        onClick={() => openRestore(e)}
                        onFocus={() => setFocusedId(e.id)} onBlur={() => setFocusedId((c) => c === e.id ? null : c)}
                        onMouseEnter={() => setFocusedId(e.id)} onMouseLeave={() => setFocusedId((c) => c === e.id ? null : c)}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', textAlign: 'left',
                          padding: '10px 13px', cursor: 'pointer', borderRadius: V2.radiusMd,
                          ...V2Focus.row(focusedId === e.id),
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '13px', fontWeight: 600, color: V2.fg }}>{fmtHistTs(e.updated_at)}</span>
                            {isCur && currentChip}
                          </div>
                          {sub2 && <div style={{ fontSize: '11px', color: V2.fgMuted }}>{sub2}</div>}
                        </div>
                        <FaUndo size={13} style={{ color: V2.fgMuted, flexShrink: 0 }} />
                      </Focusable>
                    </div>
                  );
                })}
              </div>
            ))}
          </Focusable>
        )
      ) : (
        states.length === 0 ? (
          <div style={{ color: V2.fgMuted, fontSize: '12px', padding: '12px 0' }}>No states for this game.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {(() => {
              const pending = states.filter((s) => shots[s.id] === undefined || shots[s.id] === 'loading').length;
              if (pending === 0) return null;
              const loaded = states.length - pending;
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: V2.fgMuted }}>
                  <FaSync size={11} style={{ animation: 'spin 1s linear infinite' }} />
                  <span>Loading previews {loaded}/{states.length}…</span>
                </div>
              );
            })()}
            {groupBySlot(states).map((g) => (
              <div key={`stg-${g.slot}`} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {slotHeader(g.slot, g.items.length)}
                <Focusable noFocusRing style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '12px' }}>
                  {g.items.map((e, idx) => {
                    const isCur = idx === 0;
                    const shot = shots[e.id];
                    const loadingShot = shot === undefined || shot === 'loading';
                    return (
                      <Focusable noFocusRing
                        key={`state-${e.id}`}
                        className="romm-tile sd-fade"
                        onActivate={() => openRestore(e)}
                        onClick={() => openRestore(e)}
                        onFocus={() => setFocusedId(e.id)} onBlur={() => setFocusedId((c) => c === e.id ? null : c)}
                        onMouseEnter={() => setFocusedId(e.id)} onMouseLeave={() => setFocusedId((c) => c === e.id ? null : c)}
                        style={{
                          display: 'flex', flexDirection: 'column', cursor: 'pointer', overflow: 'hidden',
                          borderRadius: V2.radiusLg,
                          '--sd-i': Math.min(idx, 14),
                          ...V2Focus.row(focusedId === e.id),
                        } as any}
                      >
                        <div className={loadingShot ? 'sd-shimmer' : ''} style={{ position: 'relative', aspectRatio: '16 / 9', backgroundColor: V2.coverPlaceholder, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                          {loadingShot ? (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', color: V2.fgMuted }}>
                              <FaSync size={14} style={{ animation: 'spin 1s linear infinite' }} />
                              <span style={{ fontSize: '10px' }}>Downloading…</span>
                            </div>
                          ) : shot ? (
                            <img src={shot} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                          ) : (
                            <span style={{ fontSize: '10px', color: V2.fgMuted }}>No screenshot</span>
                          )}
                          {isCur && <div style={{ position: 'absolute', top: '6px', left: '6px' }}>{currentChip}</div>}
                        </div>
                        <div style={{ padding: '8px 10px' }}>
                          <div style={{ fontSize: '11px', color: V2.fg2 }}>{fmtHistTs(e.updated_at)}</div>
                        </div>
                      </Focusable>
                    );
                  })}
                </Focusable>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

// ── Multi-disc helpers (shared by the cover tile, the Play button and the
// Files tab) ────────────────────────────────────────────────────────────────
type LocalDisc = { name: string; path: string; is_m3u: boolean; is_region?: boolean };

// Friendly label for a disc file: keep the "(Disc N)" tail when present, else
// fall back to the bare filename (sans extension).
function discDisplayLabel(fname: string): string {
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

// Launch a game. Under gamescope (Steam Deck Gaming Mode) this routes through
// the Ludo tile's session-host so the Steam overlay works: prepare_steam_launch
// writes the emulator argv, then we RunGame the tile and the host execs it as a
// Steam-tracked child. Anywhere that fails (not gamescope, no tile, RunGame
// unavailable) it falls back to the direct daemon launch.
async function launchGameSmart(romId: number, disc: string | null = null,
  siblingRomId: number | null = null, resume: boolean = false): Promise<any> {
  // Armed here rather than per caller so every way into a game — tile, disc
  // picker, region picker, resume — gets its rows refreshed when it ends. A
  // launch that never starts is harmless: the watcher gives up on its own.
  watchForSessionEnd();
  // Every route into a game funnels through here (tile, disc picker, region
  // picker, resume), so this is the one place that always knows what was
  // launched — the post-session focus restore reads it.
  _rommLastLaunchedRomId = romId;
  try {
    if (await host.launcher.hasTile()) {
      const prep = await prepareSteamLaunch(romId, disc, siblingRomId, resume);
      if (prep?.steam_host) {
        if (await host.launcher.launchTile()) {
          // Carry the prep's BIOS verdict through: this path returns a synthetic
          // success, so anything prepare_steam_launch resolved (the warning, or
          // the files it fetched to avoid one) is lost unless it is forwarded.
          return { success: true, message: 'Launching',
            ...(prep.bios_warning ? { bios_warning: prep.bios_warning } : {}),
            ...(prep.bios_fetched ? { bios_fetched: prep.bios_fetched } : {}) };
        }
        // launchTile already reset its own session state; fall through to the
        // direct daemon launch below.
      } else if (prep && prep.success === false && prep.steam_host === false
        && prep.message && prep.message !== 'Not running under gamescope') {
        // A real failure (e.g. game not downloaded) — surface it rather than
        // silently falling back to a direct launch that would fail the same way.
        return prep;
      }
    }
  } catch (e) { console.error('[RomM] launchGameSmart', e); }
  return await launchGame(romId, disc, siblingRomId, resume);
}

// A launch that failed for a missing core: offer to install one and start the
// game, instead of a toast that only names the problem. Returns true when the
// picker took over, so the caller skips its own error toast.
function offerCoreInstall(r: any, retry: () => void): boolean {
  if (!r?.needs_core) return false;
  showModal(
    <MissingCoreModal
      gap={{
        platform_name: r.platform_name || 'This platform',
        platform_slug: r.platform_slug || '',
        candidates: r.candidates || [],
        installed_cores: r.installed_cores || [],
        can_download: !!r.can_download,
        download_reason: r.download_reason || '',
      }}
      onPlay={retry} />
  );
  return true;
}

// Refresh what a play session changed, once it has actually ended.
//
// The emulator is a separate process that takes over the screen, so nothing in
// the UI observes the session: Continue playing (RomM's server-side
// last_played) and the resume screenshots both only change after the
// end-of-session save-sync uploads. Without this the row was a restart behind —
// the game just played wasn't in it, and its new state had no thumbnail.
//
// The backend's sync epoch advances when that sync completes, so poll it until
// it moves. Cheap (an int over the existing RPC channel) and self-limiting.
let _sessionWatch: any = null;
function watchForSessionEnd() {
  if (_sessionWatch) return;   // one watcher is enough; launches are serial
  const POLL_MS = 5000;
  // ~4h. A session longer than this is possible, but a watcher that outlives
  // its usefulness should stop rather than poll for the rest of the session.
  const MAX_TICKS = 2880;
  let ticks = 0;
  let base: number | null = null;
  const stop = () => { clearInterval(_sessionWatch); _sessionWatch = null; };
  _sessionWatch = setInterval(async () => {
    if (++ticks > MAX_TICKS) { stop(); return; }
    try {
      const e = (await getSyncEpoch())?.epoch;
      if (typeof e !== 'number') return;
      if (base === null) { base = e; return; }
      if (e === base) return;
      stop();
      invalidateStateThumbs();
      _broadcastLibRefresh();
    } catch { /* transient — keep watching */ }
  }, POLL_MS);
}

async function runLaunch(romId: number, gameName: string, disc: string | null,
  label?: string, setBusy?: (b: any) => void, onDone?: () => void, siblingRomId?: number | null) {
  if (setBusy) setBusy('launch');
  try {
    const r = await launchGameSmart(romId, disc, siblingRomId ?? null);
    if (r?.success && r?.bios_warning) {
      // The launch itself succeeded, so this is deliberately not an error: the
      // core starts and then sits on a black screen with nothing to explain it.
      // Fires whenever RomM holds firmware for the platform that isn't on disk —
      // not only when the resolved core marks it required, because the user can
      // pick a different core inside RetroArch and a pcsx_rearmed-shaped check
      // would go quiet exactly when the BIOS is needed. severity says which.
      const w = r.bios_warning;
      const miss: string[] = w.missing_bios || [];
      toaster.toast({
        title: `${w.platform_name || 'This platform'} BIOS missing`,
        body: `${w.severity === 'required'
          ? `${w.core} will not boot without ` : `${label || gameName} may need `}`
          + `${miss.slice(0, 3).join(', ')}${miss.length > 3 ? '…' : ''}. `
          + 'Open Firmware / BIOS to download them.',
        duration: 10000,
        // The index, not this platform's panel: the toast is clicked at some
        // remove from the launch, often with RetroArch already up, and a modal
        // over whatever is on screen by then is the wrong shape of interruption.
        onClick: () => libNavigate('/romm-sync-bios'),
      });
    }
    // The gap existed and the launch closed it by downloading. Said plainly
    // because the launch visibly took longer than usual and something was
    // written to disk — an unexplained pause reads as a stall, and "we fetched
    // your BIOS" is also the answer to why it works now when it didn't before.
    else if (r?.success && r?.bios_fetched?.length) {
      const got: string[] = r.bios_fetched;
      toaster.toast({
        title: `Launching ${label || gameName}`,
        body: `Downloaded ${got.length} missing BIOS file${got.length > 1 ? 's' : ''} first: `
          + `${got.slice(0, 3).join(', ')}${got.length > 3 ? '…' : ''}`,
      });
    }
    // No toast on a plain successful launch: the emulator takes over the
    // screen a moment later, so the notification announces something the user
    // is already watching happen. The BIOS branch above still fires, because
    // that one is not about the launch -- it explains a longer-than-usual wait
    // and files written to disk.
    else if (offerCoreInstall(r, () => void runLaunch(
      romId, gameName, disc, label, setBusy, onDone, siblingRomId))) {
      // The picker owns the outcome now — no toast.
    } else {
      toaster.toast({ title: 'Launch failed', body: r?.message || 'Error' });
      // Self-heal a stale "downloaded" tile: if launch failed because the files
      // aren't actually there (deleted off-device in a prior session, cache not
      // yet reconciled), flip every cached surface back to not-downloaded so the
      // cover offers Download instead of a Play that keeps failing.
      if (/not downloaded/i.test(r?.message || '')) libCacheSetDownloaded(romId, false);
    }
  } catch (e) {
    toaster.toast({ title: 'Launch failed', body: String(e) });
  } finally {
    if (setBusy) setBusy(null);
    if (onDone) onDone();
  }
}

// V2 glass picker — the disc/region selector in the app's own modal language
// (same chrome as CollectionActionsModal / UserMenuModal) instead of Steam's
// native context menu. Rows reuse UserMenuRow; the remembered/default entry
// carries a check in the icon slot.
function PickerModal({ title, items, closeModal }: {
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
function openDiscPicker(romId: number, gameName: string, discs: LocalDisc[],
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

function openRegionPicker(
  romId: number, gameName: string,
  siblings: { rom_id: number; name: string }[],
  downloadedIds: Set<number>,
  lastUsedId?: number,
  onSelected?: (sibRomId: number) => void,
) {
  const mainEntry = { rom_id: romId, name: gameName };
  const sorted = [...siblings].sort((a, b) => {
    const aDl = downloadedIds.has(a.rom_id) ? 0 : 1;
    const bDl = downloadedIds.has(b.rom_id) ? 0 : 1;
    if (aDl !== bDl) return aDl - bDl;
    return a.name.localeCompare(b.name);
  });
  const all = [mainEntry, ...sorted];

  showModal(
    <PickerModal title="Select region" items={all.map((entry) => ({
      key: entry.rom_id,
      label: entry.name
        + (entry.rom_id !== romId && !downloadedIds.has(entry.rom_id) ? ' (not downloaded)' : ''),
      active: entry.rom_id === lastUsedId,
      onSelect: () => onSelected?.(entry.rom_id),
    }))} />
  );
}

function GameDetailPage() {
  const game = _libGameHolder;
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | 'download' | 'delete' | 'launch'>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDownloaded, setIsDownloaded] = useState<boolean>(!!game?.is_downloaded);
  const [discs, setDiscs] = useState<LocalDisc[]>([]);
  const [discLast, setDiscLast] = useState<string>('');
  const [bgUri, setBgUri] = useState<string | null>(null);
  const [tab, setTab] = useState('overview');
  const dlProg = useDownloadProgress(game?.rom_id ?? -1, busy === 'download');
  const dlPct = dlProg?.percent ?? null;
  const extracting = dlProg?.state === 'extracting';
  const globalDownloading = useIsDownloading(game?.rom_id ?? -1);
  const downloading = busy === 'download' || globalDownloading;
  const smoothPct = useSmoothNumber(dlPct, downloading);
  // Nothing to launch into: Play dims rather than disappearing, and says why
  // when focused. Downloading stays available — building a library before you
  // own an emulator is legitimate.
  const saveActivity = useSaveActivityFor(game);
  const emu = useEmulatorStatus();
  // Per-game, not global: a Switch ROM is playable on a machine with only Eden,
  // and unplayable on one with only RetroArch — no core can run it either way.
  const gameStandalone = standaloneFor(emu, game?.platform, game?.platform_slug);
  // Removed from RomM but kept because it is on disk. The server has nothing to
  // serve for it, so anything that would re-fetch it is a guaranteed failure.
  const orphan = !!game?.is_orphan;
  const noEmulator = cannotLaunch(emu, game?.platform, game?.platform_slug);
  const [ctaFocused, setCtaFocused] = useState(false);
  // Land gamepad focus on the primary CTA (Play / Download) when the page
  // opens. As an internal view (LibraryRootPage) there is no route change, so
  // Steam gives us no focus pass — without this the generic view focus-pull
  // could park focus on the page's invisible root Focusable.
  const ctaRef = useAutoFocus(true, game?.rom_id);

  const load = async () => {
    if (!game) { setLoading(false); return; }
    setLoading(true);
    const rid = game.rom_id;
    try {
      const res = await getGameDetail(rid);
      if (res?.success) {
        setDetail(res);
        // get_game_detail reports is_downloaded from the in-memory games index,
        // which a just-finished download may not have reached yet (and which
        // holds nothing at all for a rom folded into a parent). Treat a
        // completed download in this session as the stronger evidence — it is
        // only ever cleared by an actual delete, via libCacheSetDownloaded.
        setIsDownloaded(!!res.is_downloaded || _dlSucceeded.has(rid));
        // Earned achievements are fetched separately so nothing blocks on the
        // extra /users/me round-trip; patch earned flags in once they arrive.
        if (res.ra_id && (res.achievements?.length)) {
          getRaEarned(res.ra_id).then((r: any) => {
            const earned = new Set<string>(r?.earned || []);
            if (!earned.size) return;
            setDetail((prev: any) => prev && prev.rom_id === rid ? {
              ...prev,
              achievements: prev.achievements.map((a: any) =>
                ({ ...a, earned: a.badge_id != null && earned.has(String(a.badge_id)) })),
            } : prev);
          }).catch(() => { });
        }
      }
    } catch (e) {
      console.error('get_game_detail failed', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // If a download for this game finishes on another surface (e.g. its cover
  // tile), refresh so the CTA flips Download → Play here too.
  const prevDownloading = useRef(false);
  useEffect(() => {
    if (prevDownloading.current && !downloading) {
      // Flip the CTA on the registry alone, before load() answers. The reload
      // is a round-trip to RomM and it can fail outright — a ROM download
      // finishing has just been hammering the same connection, and a reset
      // there returns success:false, which leaves the CTA saying Download for
      // a game that is on disk. The registry cannot fail and is the reason the
      // library tiles heal correctly today.
      if (game && _dlSucceeded.has(game.rom_id)) setIsDownloaded(true);
      load();
    }
    prevDownloading.current = downloading;
  }, [downloading]);

  // Resolve the on-disk disc files once the game is downloaded. A multi-disc
  // game exposes >1 entry (plus an .m3u); a single-disc game returns [].
  // `discReload` bumps after a disc launch so the remembered-disc checkmark and
  // the resume target stay current without leaving the page.
  const [discReload, setDiscReload] = useState(0);
  useEffect(() => {
    if (!game || !isDownloaded) { setDiscs([]); setDiscLast(''); return; }
    let alive = true;
    (async () => {
      try {
        const r = await getLocalDiscs(game.rom_id);
        if (alive) { setDiscs(r?.success ? (r.discs || []) : []); setDiscLast(r?.last || ''); }
      } catch { if (alive) { setDiscs([]); setDiscLast(''); } }
    })();
    return () => { alive = false; };
  }, [isDownloaded, game?.rom_id, discReload]);

  // A game is "multi-disc" for picker purposes when more than one bootable
  // disc exists (the .m3u playlist alone does not count as a choice).
  const pickableDiscs = discs.filter((d) => !d.is_m3u);
  const isMultiDisc = pickableDiscs.length > 1;

  const doDownload = async () => {
    if (!game) return;
    setBusy('download');
    _setDlActive(game.rom_id, true, detail?.name || game.name);
    try {
      await maybePromptSwitchFirmware(game.rom_id);
      const start = await downloadGame(game.rom_id);
      if (!start?.success) {
        toaster.toast({ title: 'Download failed', body: start?.message || 'Unknown error' });
        return;
      }
      const res = await awaitDownload(game.rom_id);
      if (res.ok) {
        toaster.toast({
          title: 'Downloaded', body: detail?.name || game.name,
          logo: <ToastCover romId={game.rom_id} hasCover={game.has_cover} />,
          // Started from this page, but the toast outlives it — a click has to
          // bring the user back rather than do nothing.
          onClick: () => openGameById(game.rom_id, detail?.name || game.name, "/romm-sync-library"),
        });
        setIsDownloaded(true);
        // The same session registry the library tiles heal from. Without it
        // this page is the only surface that does not know the download
        // succeeded, so anything that re-reads state here — a remount with a
        // stale `game` prop, or the reload below — silently flips the CTA back
        // to Download while the library shows the game as present.
        _dlSucceeded.add(game.rom_id);
        libCacheSetDownloaded(game.rom_id, true);
      } else {
        toaster.toast({ title: 'Download failed', body: res.message || 'Unknown error' });
      }
    } catch (e) {
      toaster.toast({ title: 'Download failed', body: String(e) });
    } finally {
      _setDlActive(game.rom_id, false);
      setBusy(null);
    }
  };

  const doLaunch = async (disc?: string | null, label?: string) => {
    if (!game) return;
    await runLaunch(game.rom_id, detail?.name || game.name, disc ?? null, label, setBusy);
    if (disc) setDiscReload((n) => n + 1);  // refresh remembered-disc marker
  };

  // Y / Options on the Play button: pick which disc to boot.
  const openDiscMenu = () => {
    if (game) openDiscPicker(game.rom_id, detail?.name || game.name, discs, discLast,
      setBusy, () => setDiscReload((n) => n + 1));
  };

  const doDelete = async () => {
    if (!game) return;
    setBusy('delete');
    try {
      const res = await deleteGame(game.rom_id);
      if (res?.success) {
        setIsDownloaded(false);
        libCacheSetDownloaded(game.rom_id, false);
      } else {
        toaster.toast({ title: 'Delete failed', body: res?.message || 'Unknown error' });
      }
    } catch (e) {
      toaster.toast({ title: 'Delete failed', body: String(e) });
    } finally {
      setBusy(null);
      setConfirmDelete(false);
    }
  };

  if (!game) {
    return v2Page(<div style={{ padding: '16px', color: V2.fgMuted }}>No game selected.</div>);
  }

  const name = detail?.name || game.name;
  const platform = detail?.platform || game.platform;
  const releaseDate = fmtReleaseDate(detail?.release_date);
  // RomM GameHeader meta row: platform-icon + platform · release date ·
  // verified — text items only (the tag chips render after as RTags).
  const meta: { text: string; color?: string }[] = [];
  if (platform) meta.push({ text: platform });
  if (releaseDate) meta.push({ text: releaseDate });

  // Header tag chips (RomM GameHeader): regions (info), languages (brand),
  // custom tags (neutral) — each an RTag.
  const headerTags: { text: string; tone: 'info' | 'brand' | 'neutral' }[] = [
    ...((detail?.regions || []) as string[]).map((r) => ({ text: r, tone: 'info' as const })),
    ...((detail?.languages || []) as string[]).map((l) => ({ text: l, tone: 'brand' as const })),
    ...((detail?.tags || []) as string[]).map((t) => ({ text: t, tone: 'neutral' as const })),
  ];

  // Overview "InfoGrid" sections — icon + label + chip items (RomM InfoGrid).
  const infoGrid: { label: string; items: string[]; icon?: any }[] = [];
  if (detail?.genres?.length) infoGrid.push({ label: 'Genres', items: detail.genres });
  if (detail?.companies?.length) infoGrid.push({ label: 'Companies', items: detail.companies });
  if (detail?.franchises?.length) infoGrid.push({ label: 'Franchises', items: detail.franchises });
  if (detail?.collections?.length) infoGrid.push({ label: 'Collections', items: detail.collections });

  const related = detail?.related || {};
  const hasRelated = ['expansions', 'dlcs', 'remakes', 'remasters']
    .some((k) => (related[k] || []).length);
  const ageRatings = detail?.age_ratings || [];
  const userCollections: string[] = detail?.user_collections || [];

  // Tab strip — Files only when the server reported files (RomM hides empty tabs).
  const tabList: { id: string; label: string }[] = [{ id: 'overview', label: 'Overview' }];
  if (detail?.files?.length) tabList.push({ id: 'files', label: 'Files' });
  if (detail?.screenshots?.length) tabList.push({ id: 'screenshots', label: 'Screenshots' });
  tabList.push({ id: 'save-data', label: 'Save Data' });
  if (detail?.achievements?.length) tabList.push({ id: 'achievements', label: 'Achievements' });
  tabList.push({ id: 'metadata', label: 'Metadata' });

  // L1 / R1 page through the detail tabs (RomM pages detail tabs with bumpers).
  // After a switch, land gamepad focus on the new tab's FIRST interactive
  // element (subtab pill, screenshot, filter, save row …) so the content is
  // immediately steerable — not back on the Play/Download CTA. The retry
  // ladder covers tabs whose content mounts async (Save Data fetches first);
  // a tab with nothing focusable (Overview's plain text) parks focus on the
  // CTA only if it died with the old tab's unmount, and each attempt bails
  // once focus is inside the content so the user is never fought.
  const tabContentRef = useRef<HTMLDivElement | null>(null);
  const tabFocusSeq = useRef(0);
  const cycleTab = (dir: -1 | 1) => {
    const i = tabList.findIndex((t) => t.id === tab);
    const ni = (i < 0 ? 0 : i + dir + tabList.length) % tabList.length;
    setTab(tabList[ni].id);
    const seq = ++tabFocusSeq.current;
    // The ladder stretches to ~3s because Save Data mounts its content only
    // after a fetch. Two guards keep it polite: it stops for good once focus
    // is inside the content, and it stops if the user has meanwhile driven
    // focus somewhere else themselves (any connected element that is neither
    // where focus was at switch time nor a spot we parked it on).
    const initial: any = _gpFocusEl();
    let parked: any = null;
    [60, 180, 400, 750, 1200, 2000, 3000].forEach((d) => setTimeout(() => {
      try {
        if (seq !== tabFocusSeq.current) return;      // superseded by a newer switch
        const host = tabContentRef.current;
        if (!host) return;
        const cur: any = _gpFocusEl();
        if (cur && cur.isConnected && host.contains(cur)) { tabFocusSeq.current++; return; }  // landed — done
        if (cur && cur.isConnected && cur !== initial && cur !== parked) { tabFocusSeq.current++; return; }  // user moved — don't fight
        // First LEAF focusable: containers (noFocusRing grids/lists) also carry
        // tabindex, but focusing them paints no highlight — skip to their first
        // real item.
        const nodes = Array.from(host.querySelectorAll('[tabindex]')) as HTMLElement[];
        const leaf = nodes.find((n) => !n.querySelector('[tabindex]'));
        if (leaf) { _forceGamepadFocus(leaf); return; }
        if ((!cur || !cur.isConnected) && ctaRef.current) { parked = ctaRef.current; _forceGamepadFocus(parked); }
      } catch { /* ignore */ }
    }, d));
  };
  const onButtonDown = (evt: any) => {
    const b = evt?.detail?.button;
    if (b === GamepadButton.BUMPER_LEFT) cycleTab(-1);
    else if (b === GamepadButton.BUMPER_RIGHT) cycleTab(1);
    else if (b === GamepadButton.SELECT) { playSteamSound('deck_ui_show_modal'); libNavigate("/romm-sync-settings"); }
  };
  // Back returns to the page this game was opened from (collection/platform games
  // page or the library index). onCancelButton CONSUMES B so Steam's default
  // router-back doesn't also fire (which would land somewhere else entirely).
  const onBack = () => libBack(_libGameOrigin);

  return v2Page(
    <Focusable noFocusRing onButtonDown={onButtonDown} onCancelButton={onBack} style={{ padding: '20px 16px' }}>
      <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', gap: '22px', alignItems: 'flex-start' }}>
        {/* Cover */}
        <div style={{ flex: '0 0 220px', maxWidth: '220px' }}>
          <div style={{ boxShadow: V2.elev2, borderRadius: V2.radiusLg, overflow: 'hidden' }}>
            <GameCover romId={game.rom_id} hasCover={game.has_cover || !!detail?.has_cover} large
              radius={V2.radiusLg} onLoaded={setBgUri} />
          </div>
        </div>

        {/* Info + actions */}
        <Focusable noFocusRing flow-children="vertical" style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <div style={{ fontSize: '30px', fontWeight: 800, lineHeight: '1.15', letterSpacing: '-0.01em' }}>{name}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0', marginTop: '8px', fontSize: '13.5px', color: V2.fg2 }}>
              {/* Platform icon leads the meta row (RomM GameHeader). */}
              {game.platform_slug && (
                <span style={{ display: 'inline-flex', width: '16px', height: '16px', marginRight: '6px', alignItems: 'center', justifyContent: 'center' }}>
                  <PlatformIcon slug={game.platform_slug} size={16} />
                </span>
              )}
              {meta.map((m, i) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
                  {i > 0 && <span style={{ opacity: 0.3, margin: '0 8px' }}>·</span>}
                  <span style={{ color: m.color || V2.fg2 }}>{m.text}</span>
                </span>
              ))}
              {/* Verified — icon-only check matching RomM GameHeader
                  (mdi-check-decagram seal); MdVerified is its react-icons twin. */}
              {detail?.verified && (
                <>
                  <span style={{ opacity: 0.3, margin: '0 8px' }}>·</span>
                  <MdVerified size={17} color={V2.success} />
                </>
              )}
              {/* Region / language / custom tag chips (RomM RTags). */}
              {headerTags.length > 0 && (
                <>
                  <span style={{ opacity: 0.3, margin: '0 8px' }}>·</span>
                  <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '6px' }}>
                    {headerTags.map((tg, i) => {
                      const palette =
                        tg.tone === 'info' ? { c: '#93c5fd', b: 'rgba(147,197,253,0.14)', br: 'rgba(147,197,253,0.30)' }
                          : tg.tone === 'brand' ? { c: V2.brandHover, b: 'rgba(139,116,232,0.16)', br: 'rgba(139,116,232,0.30)' }
                            : { c: V2.fg2, b: V2.surface, br: V2.border };
                      return (
                        <span key={i} style={{
                          fontSize: '11px', fontWeight: 600, lineHeight: 1.6, padding: '1px 8px',
                          borderRadius: V2.radiusPill, color: palette.c,
                          background: palette.b, border: `1px solid ${palette.br}`,
                        }}>{tg.text}</span>
                      );
                    })}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Removed-from-RomM notice. Stated once, up front, rather than only
              at the delete step: it changes what the whole page means — no
              re-download, no save sync target, and this copy is the last one. */}
          {orphan && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: '8px', margin: '0 0 14px',
              padding: '8px 12px', borderRadius: V2.radiusMd,
              background: 'rgba(251,191,36,0.10)', border: `1px solid rgba(251,191,36,0.30)`,
              color: V2.warning, fontSize: '12px', lineHeight: 1.4, maxWidth: '560px',
            }}>
              <FaUnlink size={12} style={{ marginTop: '2px', flexShrink: 0 }} />
              <span>This game was removed from RomM. Your downloaded copy still plays, but
                it can't be downloaded again — keep a backup if you want to be sure of it.</span>
            </div>
          )}

          {/* Actions — RomM GameActions ribbon: an emphasized white pill for the
              primary CTA (Download when absent, Play when present) + circular
              surface icon buttons for the secondary actions (Delete). */}
          <Focusable noFocusRing flow-children="horizontal" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
            {!isDownloaded ? (
              <GameActionButton variant="emphasized" focusRef={ctaRef} disabled={!!busy || downloading} onClick={doDownload}
                progress={downloading ? (dlPct ?? 0) : undefined}
                label={downloading
                  ? (extracting ? (dlPct != null ? `Extracting… ${padPct(dlPct)}%` : 'Extracting…')
                     : dlPct != null ? `Downloading… ${padPct(smoothPct)}%` : 'Downloading…')
                  : 'Download'}
                icon={downloading
                  ? (extracting ? <FaBoxOpen size={15} />
                     : <FaSync size={15} style={{ animation: 'spin 1s linear infinite' }} />)
                  : <FaDownload size={15} />} />
            ) : !confirmDelete ? (
              <>
                <GameActionButton variant="emphasized" focusRef={ctaRef} disabled={!!busy || noEmulator}
                  onClick={() => doLaunch()}
                  onFocused={() => setCtaFocused(true)} onBlurred={() => setCtaFocused(false)}
                  onOptionsButton={isMultiDisc && !noEmulator ? openDiscMenu : undefined}
                  optionsHint={isMultiDisc && !noEmulator}
                  label={busy === 'launch' ? 'Launching…' : 'Play'}
                  icon={busy === 'launch'
                    ? <FaSync size={15} style={{ animation: 'spin 1s linear infinite' }} />
                    : <FaPlay size={14} style={{ marginLeft: '2px' }} />} />
                {noEmulator && ctaFocused && (
                  <span style={{ fontSize: '12px', color: V2.warning, maxWidth: '260px', lineHeight: 1.35 }}>
                    {gameStandalone
                      ? `${gameStandalone.name} is not installed — ${game?.platform || 'this platform'} needs it to play.`
                      : 'No emulator installed — install RetroArch from Home to play.'}
                  </span>
                )}
                <GameActionButton variant="surface" accent="danger" onClick={() => setConfirmDelete(true)}
                  icon={<FaTrash size={15} />} />
                {/* Sits beside Play rather than replacing it: a save going up
                    doesn't stop you launching again, and swapping the CTA out
                    from under a waiting thumb would. */}
                {saveActivity && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: '7px',
                    fontSize: '12px', fontWeight: 600, color: V2.fgMuted,
                  }}>
                    <FaCloudUploadAlt size={13} style={{ color: V2.brandHover }} />
                    Uploading save…
                  </span>
                )}
              </>
            ) : (
              <>
                <GameActionButton variant="danger" disabled={!!busy} onClick={doDelete}
                  label={busy === 'delete' ? 'Deleting…' : orphan ? 'Delete for good' : 'Confirm delete'}
                  icon={busy === 'delete'
                    ? <FaSync size={15} style={{ animation: 'spin 1s linear infinite' }} />
                    : <FaTrash size={15} />} />
                <GameActionButton variant="surface" onClick={() => setConfirmDelete(false)}
                  icon={<FaTimes size={16} />} />
                {/* Deleting a normal game is undoable — it is still on RomM. For
                    an orphan this local copy is the last one, so the confirm
                    step has to say that rather than reading as routine. */}
                {orphan && (
                  <span style={{ fontSize: '12px', color: V2.warning, maxWidth: '260px', lineHeight: 1.35 }}>
                    This game is no longer on RomM — deleting it here cannot be undone.
                  </span>
                )}
              </>
            )}
            {/* Live transfer readout — speed · ETA, shown beside the button only
                while a download is in flight (kept off the cover tiles by design). */}
            {downloading && dlProg && (dlProg.speed > 0 || dlProg.eta > 0) && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: V2.fg2,
                animation: 'dlValIn 0.35s ease'
              }}>
                <span style={{ opacity: 0.3 }}>·</span>
                {dlProg.speed > 0 && <span>{formatSpeed(dlProg.speed)}</span>}
                {dlProg.speed > 0 && formatEta(dlProg.eta) && <span style={{ opacity: 0.3 }}>·</span>}
                {formatEta(dlProg.eta) && <span>{formatEta(dlProg.eta)} left</span>}
              </span>
            )}
          </Focusable>

          {/* Tabbed panel (RomM GameDetails: RTabNav + tab content). L1/R1 page tabs. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ flex: '1 1 auto', minWidth: 0 }}><V2TabNav tabs={tabList} active={tab} onTab={setTab} /></div>
            <Bumper label="L1" />
            <Bumper label="R1" />
          </div>
          <div ref={tabContentRef} style={{ paddingTop: '14px' }}>
            {loading ? (
              <div style={{ color: V2.fgMuted, fontSize: '12px' }}>Loading details…</div>
            ) : tab === 'overview' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '30px' }}>
                {/* 1. Summary */}
                {detail?.summary && (
                  <div style={{ fontSize: '13.5px', color: V2.fg2, lineHeight: '1.7' }}>{detail.summary}</div>
                )}

                {/* 2. Left-labelled fact rows — Last played · Players · Age rating
                    (RomM OverviewTab __facts). */}
                {(() => {
                  const lp = detail?.last_played ? new Date(detail.last_played) : null;
                  const lpStr = lp && !isNaN(lp.getTime()) ? lp.toLocaleString() : null;
                  const rows: { label: string; field: any }[] = [];
                  if (lpStr) rows.push({ label: 'Last played', field: <span style={{ fontSize: '13px', color: V2.fg2 }}>{lpStr}</span> });
                  if (detail?.player_count) rows.push({ label: 'Players', field: <PlayerCountBadge value={String(detail.player_count)} /> });
                  if (ageRatings.length) rows.push({ label: 'Age rating', field: <AgeRatingBadges items={ageRatings} /> });
                  if (userCollections.length) rows.push({
                    label: 'Collections',
                    field: (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {userCollections.map((c, i) => (
                          <span key={i} style={{
                            display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '4px 10px',
                            background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusPill,
                            fontSize: '11.5px', fontWeight: 600, color: V2.fg2,
                          }}><FaBookmark size={10} color={V2.brand} />{c}</span>
                        ))}
                      </div>
                    ),
                  });
                  if (!rows.length) return null;
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                      {rows.map((r) => (
                        <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                          <div style={{ width: '120px', flexShrink: 0, fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: V2.fgFaint }}>{r.label}</div>
                          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '12px' }}>{r.field}</div>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* 3. Info grid */}
                <InfoGrid sections={infoGrid} />

                {/* 4. HLTB */}
                {detail?.hltb && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <SectionHeading icon={<FaClock size={12} />}>How long to beat</SectionHeading>
                    <HLTBStrip hltb={detail.hltb} />
                  </div>
                )}

                {/* 5. Related games — one labelled section per category. */}
                {hasRelated && (
                  <>
                    <RelatedSection icon={<FaPuzzlePiece size={12} />} title="Expansions" items={related.expansions} />
                    <RelatedSection icon={<FaBoxOpen size={12} />} title="DLC" items={related.dlcs} />
                    <RelatedSection icon={<FaRedo size={12} />} title="Remakes" items={related.remakes} />
                    <RelatedSection icon={<FaClone size={12} />} title="Remasters" items={related.remasters} />
                  </>
                )}

                {!detail?.summary && infoGrid.length === 0 && !hasRelated && !detail?.hltb && !ageRatings.length && (
                  <div style={{ color: V2.fgMuted, fontSize: '12px' }}>No metadata available.</div>
                )}
              </div>
            ) : tab === 'files' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                {/* Discs — bootable entries on disk (downloaded multi-disc games).
                    Each row launches that disc; the playlist row boots all discs
                    with in-game swapping. */}
                {isMultiDisc && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <SectionHeading icon={<FaLayerGroup size={12} />}>Discs</SectionHeading>
                    {discs.some((d) => d.is_m3u) && (
                      <V2SettingsRow icon={<FaLayerGroup size={14} />}
                        title="All discs" subtitle="In-game disc swapping"
                        onClick={() => doLaunch(null, 'All discs')}
                        right={<FaPlay size={12} style={{ color: V2.fgMuted }} />} />
                    )}
                    {pickableDiscs.map((d) => (
                      <V2SettingsRow key={d.name} icon={<FaClone size={14} />}
                        title={discDisplayLabel(d.name)} subtitle={d.name}
                        onClick={() => doLaunch(d.name, discDisplayLabel(d.name))}
                        right={<FaPlay size={12} style={{ color: V2.fgMuted }} />} />
                    ))}
                  </div>
                )}
                {/* Switch patches and DLC. Above the file list because they are
                    the actionable half: the list says what exists, this says
                    what Eden will actually apply. Renders nothing off Switch. */}
                <SwitchAddOnsSection romId={game.rom_id} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {isMultiDisc && <SectionHeading icon={<FaBoxOpen size={12} />}>Files</SectionHeading>}
                  <FilesTab detail={detail} />
                </div>
              </div>
            ) : tab === 'screenshots' ? (
              <ScreenshotGrid paths={detail?.screenshots || []} />
            ) : tab === 'save-data' ? (
              <SaveDataTab romId={game.rom_id} />
            ) : tab === 'metadata' ? (
              <MetadataTab detail={detail} />
            ) : (
              <AchievementsTab achievements={detail?.achievements || []} />
            )}
          </div>
        </Focusable>
      </Focusable>
    </Focusable>,
    bgUri,
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


// Settings ▸ Recent Activity — a curated feed of what the plugin actually did
// (downloads, collection syncs, save/state sync, account events). Backed by the
// persisted backend activity log (get_recent_activity), so it covers background
// work that happened while no UI was open.
const ACTIVITY_ICONS: Record<string, any> = {
  download: FaDownload, sync: FaSync, save: FaSave, delete: FaTrash,
  account: FaUser, error: FaExclamationTriangle,
};


function RecentActivitySection() {
  const [events, setEvents] = useState<Array<{ kind: string, title: string, detail: string, timestamp: number }>>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await getRecentActivity(10);
        if (alive && res?.events) setEvents(res.events);
      } catch { }
    };
    load();
    // Light poll so background events (collection sync, save sync) appear
    // while the user is sitting on the Settings tab.
    const iv = setInterval(load, 10000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const shown = expanded ? events : events.slice(0, 6);

  // One "control panel" card: all entries as compact divided rows inside a
  // single surface, with the controls in a footer bar — not a card per event.
  return (
    <V2SettingsSection title="Recent Activity">
      <div style={{
        borderRadius: V2.radiusCard, background: V2.surface,
        border: `1px solid ${V2.border}`, overflow: 'hidden',
      }}>
        {events.length === 0 ? (
          <div style={{ padding: '14px 16px', fontSize: '12px', color: V2.fgMuted }}>
            Nothing yet — downloads, collection syncs and save syncs will show up here.
          </div>
        ) : shown.map((e, i) => {
          const Icon = ACTIVITY_ICONS[e.kind] || FaHistory;
          const err = e.kind === 'error';
          return (
            <div key={`${e.timestamp}-${i}`} style={{
              display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 14px',
              borderTop: i > 0 ? `1px solid ${V2.border}` : 'none',
            }}>
              <div style={{ flexShrink: 0, color: err ? V2.danger : V2.brandHover, display: 'flex' }}>
                <Icon size={13} />
              </div>
              <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                <div style={{
                  fontSize: '12px', fontWeight: 600, color: err ? V2.danger : V2.fg,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{_gameLabel(e.title)}</div>
                {e.detail && <div style={{
                  fontSize: '11px', color: V2.fgMuted,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{_gameLabel(e.detail)}</div>}
              </div>
              <div style={{ flexShrink: 0, fontSize: '10px', color: V2.fgMuted, whiteSpace: 'nowrap' }}>
                {fmtAgo(e.timestamp)}
              </div>
            </div>
          );
        })}
        {events.length > 0 && (
          <Focusable flow-children="horizontal" style={{
            display: 'flex', gap: '8px', padding: '8px 10px',
            borderTop: `1px solid ${V2.border}`, background: V2.bgElevated,
          }}>
            {events.length > 6 && (
              <V2Button variant="tonal" onClick={() => setExpanded(x => !x)}>
                <FaChevronDown size={11} style={{ transform: expanded ? 'rotate(180deg)' : 'none' }} />
                <span>{expanded ? 'Show less' : `Show all (${events.length})`}</span>
              </V2Button>
            )}
            <V2Button variant="tonal" onClick={async () => {
              try { await clearRecentActivity(); } catch { }
              setEvents([]); setExpanded(false);
            }}>
              <FaTimes size={11} /><span>Clear</span>
            </V2Button>
          </Focusable>
        )}
      </div>
    </V2SettingsSection>
  );
}

// Stats page — 1:1 port of RomM's ServerStats.vue: a section stack of
// SummaryStatsSection (card grid in SettingsSection chrome) + PlatformsStatsSection
// (toolbar + per-platform rows with size/percentage and a progress bar that
// doubles as the row divider). Scope is plugin-local (this device).











// BiosPage — what RomM holds as firmware per platform, versus what's actually in
// RetroArch's system dir, with a button to close the gap.
//
// The server is the source of truth for *which* files a platform wants, not the
// core's libretro .info: the core Ludo resolves is not necessarily the core that
// ends up running the game (the user can switch cores inside RetroArch), so a
// check keyed on the resolved core stays silent for pcsx_rearmed while every PSX
// BIOS is missing. The .info only decides how loudly to say it — 'required'
// means that core won't boot at all, 'optional' means it has an HLE fallback.
function BiosPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [biosDir, setBiosDir] = useState('');
  const [connected, setConnected] = useState(true);
  const [loading, setLoading] = useState(true);
  // The server couldn't be asked (typically busy serving a library fetch) —
  // NOT the same as it holding no firmware, which is what this page used to
  // claim in that case.
  const [unavailable, setUnavailable] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);

  const load = async (refresh = false) => {
    try {
      const r = await getBiosInventory(refresh);
      if (r?.success) {
        setRows(r.platforms || []);
        setBiosDir(r.bios_dir || '');
        setConnected(!!r.connected);
        setUnavailable(!!r.unavailable);
        setLibraryLoading(!!r.library_loading);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // Come back on our own while the server is busy, so the page fills in when
  // the fetch eases off instead of parking on an error the user has to poke.
  useEffect(() => {
    if (!unavailable) return;
    const t = setTimeout(() => load(true), 5000);
    return () => clearTimeout(t);
  }, [unavailable, rows]);

  const openDetail = (row: any) =>
    showModal(<BiosDetailModal slug={row.slug} platformName={row.platform_name || row.name}
      seed={row} onChanged={load} />);

  return v2Page(
    <Focusable noFocusRing
      onCancelButton={() => libBack("/romm-sync-library")}
      style={{ maxWidth: '760px', margin: '0 auto', padding: '20px 20px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <GameActionButton icon={<FaChevronLeft size={16} />} onClick={() => libBack("/romm-sync-library")} />
        <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em' }}>Firmware / BIOS</div>
      </div>

      <V2SettingsSection title={biosDir ? `Stored in ${biosDir}` : 'BIOS'}>
        {loading ? (
          <V2SettingsRow icon={<FaMicrochip size={16} />} title="Checking BIOS files…" />
        ) : !connected ? (
          <V2SettingsRow icon={<FaMicrochip size={16} />}
            title="Not connected to RomM"
            subtitle="Connect to RomM to see its firmware." />
        ) : unavailable ? (
          <V2SettingsRow icon={<FaMicrochip size={16} />}
            title={libraryLoading ? 'Waiting for your library to finish loading…'
              : 'Couldn’t read firmware from RomM'}
            subtitle={libraryLoading
              ? 'Your server is busy sending the library. Retrying…'
              : 'Your server didn’t answer. Retrying…'} />
        ) : rows.length === 0 ? (
          <V2SettingsRow icon={<FaMicrochip size={16} />}
            title="No firmware on the server"
            subtitle="Upload BIOS files to a platform in RomM." />
        ) : rows.map((row) => (
          <V2SettingsRow key={row.slug}
            bareIcon
            icon={<PlatformIcon slug={row.slug} size={28} />}
            title={row.platform_name || row.name}
            subtitle={row.missing_label
              ? `${row.missing_label} missing — A to review`
              : row.missing_count === 0
                ? `${(row.files || []).length} file${(row.files || []).length === 1 ? '' : 's'} in place`
                : `${(row.files || []).length} file${(row.files || []).length === 1 ? '' : 's'} — A to review`}
            onClick={() => openDetail(row)}
            right={biosChip(row, true)} />
        ))}
      </V2SettingsSection>
    </Focusable>
  );
}

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

// PlatformsPage — Settings ▸ Platforms. The header counts what the switches add
// up to, because the number that makes someone want to turn a platform off is
// how many games it costs, not how many platforms there are.
function PlatformsPage() {
  const sync = usePlatformSync();
  const { rows, enabledCount, enabledRoms, totalRoms, loading } = sync;
  const summary = loading || !rows.length
    ? 'Platforms'
    : `${enabledCount} of ${rows.length} syncing · ${enabledRoms.toLocaleString()} of ${totalRoms.toLocaleString()} games`;
  return v2Page(
    <Focusable noFocusRing
      onCancelButton={() => libBack("/romm-sync-settings")}
      style={{ maxWidth: '760px', margin: '0 auto', padding: '20px 20px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <GameActionButton icon={<FaChevronLeft size={16} />} onClick={() => libBack("/romm-sync-settings")} />
        <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em' }}>Platforms</div>
      </div>

      {/* Same bounded-with-fades treatment as the wizard's platform step. The
          page would happily scroll the whole list, but then the header and the
          "nothing is deleted" note scroll away with it — and on a 30-platform
          server the note is the thing a hesitant user scrolls back up looking
          for. Capping the list keeps both in view and puts the scrolling where
          the content actually is. */}
      <V2SettingsSection title={summary}>
        <ScrollFade maxHeight="calc(100vh - 300px)"
          refresh={`${rows.length}:${sync.off.size}`}
          style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '2px' }}>
          <PlatformSyncList sync={sync} />
        </ScrollFade>
      </V2SettingsSection>

      <div style={{
        fontSize: '12px', color: V2.fgMuted, lineHeight: 1.45,
        padding: '0 4px 24px',
      }}>
        Turning a platform off stops Ludo reading it from RomM, so your library
        loads faster and stays smaller. Nothing is deleted — games you already
        downloaded stay on this device and stay playable. Turn it back on and
        Ludo fetches that platform again.
      </div>
    </Focusable>
  );
}

// Per-platform status pill: green once every file the server holds is on disk,
// red when the resolved core cannot boot without what's missing, amber when it
// has an HLE fallback and will merely run worse. Shared by the index row and
// the detail panel so the two never disagree.
function biosChip(row: any, chevron?: boolean) {
  const ok = row.missing_count === 0;
  const color = ok ? V2.success : (row.severity === 'required' ? V2.danger : V2.warning);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{
        fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
        color, border: `1px solid ${color}`, borderRadius: V2.radiusChip, padding: '1px 6px',
      }}>{ok ? 'complete'
            // Switch names what is missing instead of counting files: the
            // platform has exactly two things worth having, and "2 missing"
            // is a number you must open the panel to decode.
            : row.missing_label ? `${row.missing_label} missing`
            : `${row.missing_count} missing`}</span>
      {chevron && <FaChevronRight size={12} style={{ color: V2.fgFaint }} />}
    </div>
  );
}

// Confirmation for the one transfer big enough to deserve one: ~340 MB into
// another application's system tree. Wears the same chrome as the other
// modals here (scrim, blurred card, V2 tokens, V2Button) rather than raw
// dialog furniture -- and is built from ModalRoot/Focusable/DialogButton
// because @decky/ui's ConfirmModal is exported by neither @decky/ui 4.7.2 nor
// the desktop shim, so importing it would break both builds.
// No `installed` count and no `masterKey` here any more. The count was printed
// as "replacing 238 installed file(s)", a number nobody can judge, and the
// master-key generation says how far prod.keys can decrypt WITHOUT proving it
// covers this firmware — so it could not settle the question being asked. The
// keysOk warning below is the keys fact that changes what you'd do. Both are
// still on the backend payload; this component just stopped rendering them.
function SwitchFirmwareConfirm({ fileName, size, reason, keysOk,
                                 version, installedVersion, onAnswer, closeModal }: {
  fileName: string; size: string; reason?: string;
  keysOk?: boolean;
  version?: string | null; installedVersion?: string | null;
  onAnswer: (ok: boolean) => void; closeModal?: () => void;
}) {
  // Answer exactly once. Every dismissal route lands here, and a modal that
  // closes without resolving leaves the caller awaiting a promise forever.
  const answered = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const answer = (ok: boolean) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(ok);
    closeModal?.();
  };
  useEffect(() => {
    const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60);
    return () => clearTimeout(t);
  }, []);
  return (
    <ModalRoot bHideCloseIcon onCancel={() => answer(false)} onEscKeypress={() => answer(false)}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing className="romm-ui"
        onCancelButton={() => answer(false)}
        onButtonDown={(e: any) => { if (e?.detail?.button === GamepadButton.CANCEL) answer(false); }}
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
        {/* Click-away cancels, like every other modal here. */}
        <div onClick={() => answer(false)} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          position: 'relative', width: '420px', maxWidth: '90vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '20px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
            <FaMicrochip size={16} style={{ color: V2.brand, flexShrink: 0 }} />
            {/* The version belongs in the question, since it is the thing
                being decided. Falls back to the generic title only when no
                filename anywhere carried a version to name. */}
            <div style={{ fontSize: '16px', fontWeight: 700, color: V2.fg }}>
              {version ? `Install firmware ${version}?` : 'Install Switch firmware?'}
            </div>
          </div>
          <div style={{ fontSize: '13px', color: V2.fg2, lineHeight: 1.5, marginBottom: '4px' }}>
            {/* One line, and it answers only "what happens to what I have".
                The version being installed is in the title above, so this says
                what it replaces — the fact the decision turns on.

                It used to report the installed FILE COUNT ("replacing 238
                installed file(s)"), which is not something anyone can act on:
                nobody knows whether 238 is the right number, and the version
                they are running is the thing they would actually recognise.
                The count is still there in the panel for anyone who wants it. */}
            {reason === 'missing'
              ? 'Eden has no firmware installed.'
              : installedVersion
                ? `Replaces ${installedVersion}, installed now.`
                // A firmware set is installed but nothing named a version for
                // it — an older marker, or an archive named without one. Say
                // that it gets replaced and stop, rather than reach for the
                // file count to have a number to print.
                : 'Replaces the firmware installed now.'}
          </div>
          <div style={{ fontSize: '13px', color: V2.fgMuted, lineHeight: 1.5, marginBottom: '18px' }}>
            {/* The filename appears only when the title could not name a
                version — then it is the one identifier there is. Alongside
                "Install firmware 20.5.0?" it just restates that, in a worse
                format. */}
            {!version && fileName ? `${fileName} · ` : ''}{size} · goes into Eden’s system directory
          </div>
          {/* Said BEFORE the download, not after it. Firmware without keys
              installs perfectly and then boots nothing, and the only useful
              moment to mention that is while the transfer is still a
              choice. Not a block: installing now and adding keys later is a
              legitimate order to do this in. */}
          {keysOk === false && (
            <div style={{
              display: 'flex', gap: '8px', alignItems: 'flex-start',
              background: 'rgba(251,191,36,0.10)',
              border: `1px solid rgba(251,191,36,0.35)`,
              borderRadius: V2.radiusMd, padding: '10px 12px', marginBottom: '18px',
            }}>
              <FaExclamationTriangle size={13} style={{ color: V2.warning, flexShrink: 0, marginTop: '2px' }} />
              <div style={{ fontSize: '12px', color: V2.fg2, lineHeight: 1.45 }}>
                No prod.keys found here or on RomM. Eden can’t decrypt firmware
                without it, so games still won’t boot until you upload prod.keys
                to the Switch platform.
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <V2Button variant="text" onClick={() => answer(false)}>Cancel</V2Button>
            <V2Button variant="primary" onClick={() => answer(true)}>Install</V2Button>
          </div>
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}


// One platform's firmware, as a panel rather than a page — the same shape as
// CorePickerModal, which is the other "settle one platform's emulation detail"
// surface. Opened from a BiosPage row or straight from a platform's actions
// menu, where the grid underneath is the context the user wants back.
//
// `seed` paints immediately when the caller already has the row; without one
// (the actions-menu path) the panel fetches the inventory itself.
function BiosDetailModal({ slug, platformName, seed, onChanged, closeModal }: {
  slug: string; platformName?: string; seed?: any;
  onChanged?: () => void; closeModal?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [row, setRow] = useState<any>(seed || null);
  const [loading, setLoading] = useState(!seed);
  const [busy, setBusy] = useState(false);
  // Live transfer line while the detached firmware install runs. Empty at
  // rest; a bare "Installing…" with nothing moving is indistinguishable from
  // a hang, which is what this row used to be.
  const [progress, setProgress] = useState('');
  // What is actually installed on THIS device, for the Switch panel only. The
  // file rows above say what RomM holds and whether a file by that name is
  // present; neither answers "which firmware am I running", which is the
  // question someone opens this panel with after an emulator update.
  const [fw, setFw] = useState<any>(null);
  // Where Switch updates and DLC go. Eden 0.2.0-rc1 reads them from a folder;
  // older Eden only applies what is installed into NAND. The panel is the one
  // place that already knows this platform is Switch, so the choice lives here
  // rather than in a global settings list where it would mean nothing.
  const [addOn, setAddOn] = useState<any>(null);
  const [addOnBusy, setAddOnBusy] = useState(false);
  useEffect(() => { const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60); return () => clearTimeout(t); }, []);

  const load = async () => {
    try {
      const r = await getBiosInventory(false);
      if (r?.success) setRow((r.platforms || []).find((p: any) => p.slug === slug) || null);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };
  useEffect(() => { if (!seed) load(); }, []);

  // Stays open through the download: the panel is the only thing confirming it
  // worked, and closing on activate would take the answer away with it.
  // Switch firmware is not a BIOS file. It is a ~324 MB archive of NCAs that
  // belongs in Eden's NAND tree, and download_bios would drop it in RetroArch's
  // system directory where Eden never looks — so this platform routes to its
  // own installer. Everything else keeps the original path unchanged.
  const isSwitch = slug === 'switch' || /nintendo\s*switch/i.test(
    row?.platform_name || row?.name || platformName || '');

  const fetchAll = async () => {
    setBusy(true);
    try {
      if (isSwitch) {
        // Prompt first. ~340 MB into another application's system tree is not
        // something to start on a single button press without saying so --
        // and when nothing has changed, this answers without transferring
        // anything at all. Keys are deliberately NOT gated behind this: they
        // are ~14 KB, Eden cannot start a game without them, and they sync
        // with an ordinary Switch pass.
        const avail = await switchFirmwareStatus();
        if (avail && avail.available === false && avail.file_name) {
          toaster.toast({ title: 'Switch firmware', body: 'Already up to date' });
          return;
        }
        if (avail?.available) {
          const mb = avail.size ? `${(avail.size / 1048576).toFixed(0)} MB` : 'a large download';
          const ok = await new Promise<boolean>((resolve) => {
            showModal(
              <SwitchFirmwareConfirm
                fileName={avail.file_name}
                size={mb}
                reason={avail.reason}
                keysOk={avail.keys_ok}
                version={avail.version}
                installedVersion={avail.installed_version}
                onAnswer={resolve}
              />
            );
          });
          if (!ok) return;
        }
        const r = await installSwitchFirmwareWatched(
          (tick) => setProgress(fmtFirmwareProgress(tick)));
        setProgress('');
        toaster.toast({ title: 'Switch firmware', body: switchInstallSummary(r) });
      } else {
        const r = await downloadBios(slug, '');
        if (!r?.success) toaster.toast({ title: 'BIOS', body: r?.message || 'Download failed' });
      }
      await load();
      if (isSwitch) await loadFirmware();
      onChanged?.();
    } catch {
      toaster.toast({ title: isSwitch ? 'Switch firmware' : 'BIOS', body: 'Download failed' });
    } finally { setBusy(false); }
  };

  const loadFirmware = async () => {
    try { setFw(await switchFirmwareStatus()); } catch { /* leave the line off */ }
  };
  useEffect(() => { if (isSwitch) loadFirmware(); }, [isSwitch]);

  const loadAddOnMode = async () => {
    try { setAddOn(await getSwitchAddonMode()); } catch { /* ignore */ }
  };
  useEffect(() => { if (isSwitch) loadAddOnMode(); }, [isSwitch]);
  const changeAddOnMode = async (mode: string) => {
    if (addOnBusy || mode === addOn?.mode) return;
    setAddOnBusy(true);
    // Optimistic, then replaced by what the backend reports: switching to the
    // folder mode also tries to register it with Eden, and whether THAT
    // worked is the part worth waiting to show.
    setAddOn((a: any) => ({ ...a, mode }));
    try { setAddOn(await setSwitchAddonMode(mode)); }
    catch { await loadAddOnMode(); }
    finally { setAddOnBusy(false); }
  };

  const files = row?.files || [];
  const missing = row?.missing_count || 0;
  // installed_version is deliberately null when Eden's registered/ is empty,
  // so an absent firmware never reads as a version number.
  const fwLine = !isSwitch || !fw ? null
    : fw.installed_version ? `Firmware: ${fw.installed_version}`
    : fw.installed ? `Firmware: version unknown (${fw.installed} files)`
    : 'Firmware: not installed';
  return (
    <ModalRoot bHideCloseIcon onCancel={closeModal} onEscKeypress={closeModal}>
      <Focusable noFocusRing style={{
        position: 'fixed', inset: MODAL_SCRIM_INSET, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(7,7,15,0.45)', WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
      }}>
        <style>{`${V2_FOCUS_STYLE}
          @keyframes umIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: none; } }`}</style>
        <div onClick={() => closeModal?.()} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          position: 'relative', width: '340px', maxWidth: '92vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)', maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '6px 8px 10px',
          }}>
            <div style={{
              flex: '1 1 auto', minWidth: 0,
              fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
              color: V2.fgMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>BIOS · {row?.platform_name || row?.name || platformName || ''}</div>
            {row && biosChip(row)}
          </div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />

          {loading ? (
            <UserMenuRow icon={<FaMicrochip size={13} />} label="Checking…" disabled onSelect={() => {}} />
          ) : !row ? (
            <div style={{ padding: '10px 10px 14px', fontSize: '12px', color: V2.fgMuted, lineHeight: 1.45 }}>
              RomM holds no firmware for this platform. Upload it under the
              platform’s Firmware tab and it will show up here.
            </div>
          ) : (
            <>
              {/* Exact filenames, because RetroArch matches BIOS on the name:
                  knowing it wants scph5501.bin specifically is the difference
                  between a fix and a guess. */}
              {/* A superseded firmware set is neither present nor missing:
                  a device holds exactly one, so an older upload sitting
                  beside the current one is history, not a gap. Shown greyed
                  with its own label rather than a red cross that would never
                  clear no matter how much is installed. */}
              {files.map((f: any) => (
                <UserMenuRow key={f.name}
                  icon={f.superseded
                    ? <FaHistory size={13} style={{ color: V2.fgFaint }} />
                    : f.present
                      ? <FaCheckCircle size={13} style={{ color: V2.success }} />
                      : <FaTimesCircle size={13} style={{ color: row.severity === 'required' ? V2.danger : V2.warning }} />}
                  label={`${f.name}  ·  ${fmtBytes(f.size)}${f.superseded ? '  ·  superseded' : ''}`}
                  disabled onSelect={() => {}} />
              ))}
              {fwLine && (
                <>
                <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
                <div style={{ padding: '8px 10px 12px', fontSize: '12px', color: V2.fgMuted, lineHeight: 1.45 }}>
                  {/* One line, not two. The master-key generation belongs in
                      the install prompt, where it is deciding something; here
                      the only question is whether the set is complete, and
                      "keys installed" is the whole answer. */}
                  {fwLine}{fw?.keys_installed ? ' · Keys installed' : ''}
                </div>
                {/* Updates & DLC placement. Two modes, and the difference is
                    not cosmetic: the folder keeps one file per add-on where
                    the user (and RetroDECK) can see it, while NAND explodes it
                    into anonymous NCAs. The folder needs Eden 0.2.0-rc1 and it
                    needs Eden to know the path — an unregistered folder is the
                    silent failure this block exists to make loud. */}
                <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 10px 12px' }}>
                  <div style={{ fontSize: '12px', color: V2.fg2 }}>Updates &amp; DLC</div>
                  {/* The pill sizes to its labels. In a column flex parent it
                      would otherwise stretch edge to edge, which reads as a
                      progress bar rather than a two-way choice. */}
                  <div style={{ display: 'flex' }}>
                    <V2Segment
                      options={[{ id: 'extcontent', label: 'Folder' },
                                { id: 'nand', label: 'Install to NAND' }]}
                      value={addOn?.mode || 'extcontent'}
                      disabled={addOnBusy}
                      onChange={changeAddOnMode} />
                  </div>
                  <div style={{ fontSize: '11.5px', color: V2.fgMuted, lineHeight: 1.45 }}>
                    {addOn?.mode === 'nand'
                      ? 'Add-ons are installed into Eden’s NAND. Works on any Eden version, and stores each add-on twice.'
                      : addOn?.eden_registered
                      ? `Eden reads add-ons from ${addOn?.folder || 'the library folder'} — one copy, nothing in NAND.`
                      : !addOn?.folder
                      ? 'Add-ons will go in a folder Eden reads. Download a Switch game first, so there is a folder to put them in.'
                      : !addOn?.eden_configured
                      ? 'Add-ons go in a folder Eden reads. Run Eden once so it writes its config — Ludo will point it at the folder by itself after that.'
                      : addOn?.eden_running
                      ? 'Eden is open, and it rewrites its config when it closes — so Ludo will point it at the folder once Eden has quit. Nothing for you to do.'
                      : 'Ludo could not write Eden’s config. Add the folder yourself under Settings → General → External Content. Needs Eden 0.2.0-rc1 or newer.'}
                  </div>
                </div>
                </>
              )}
              {/* Nothing missing means nothing to say: the ticks above
                  already state it, and a paragraph restating them was the
                  panel's largest element for its least informative case. The
                  divider goes with the row it separates -- without one, it
                  would hang under the last file with nothing below it. */}
              {missing > 0 && (
                <>
                  <div style={{ height: '1px', background: V2.border, margin: '4px 4px' }} />
                  <UserMenuRow
                    icon={busy
                      ? <FaSync size={13} style={{ animation: 'spin 1s linear infinite' }} />
                      : <FaDownload size={13} />}
                    label={busy
                      ? (isSwitch ? (progress || 'Installing…') : 'Downloading…')
                      : isSwitch ? 'Install firmware into Eden'
                      : `Download ${missing} missing file${missing === 1 ? '' : 's'}`}
                    disabled={busy}
                    onSelect={() => { if (!busy) fetchAll(); }} />
                </>
              )}
            </>
          )}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}




// Settings' shape — whether the RetroDECK and Steam sections exist, and the
// toggle states inside them. These are stable facts about the machine (was
// RetroDECK installed, does the desktop shell have Steam integration) that
// only change when the machine changes, so the last answer is remembered
// across opens and launches. Without it, every visit held the page's body
// hidden for the round-trips that re-confirm what the last visit established —
// worst during a library walk, when those reads queue behind the fetch.
interface SettingsShape { rd: boolean; rdButton: boolean; tileAvailable: boolean; tileInstalled: boolean; }
let _settingsShape: SettingsShape | null = (() => {
  try {
    const s = localStorage.getItem('romm:settingsShape');
    return s ? JSON.parse(s) : null;
  } catch { return null; }
})();
function _writeSettingsShape(s: SettingsShape) {
  _settingsShape = s;
  try { localStorage.setItem('romm:settingsShape', JSON.stringify(s)); } catch { /* ignore */ }
}

// Last-known values for the toggles that would otherwise paint from an
// optimistic default. The page renders on frame one now, so a toggle stored as
// OFF visibly animated ON → OFF on every visit while its read was in flight.
// Seeded from here; the live read (and every successful toggle) reconciles it.
let _settingsToggles: Record<string, boolean> = (() => {
  try { return JSON.parse(localStorage.getItem('romm:settingsToggles') || '{}'); }
  catch { return {}; }
})();
function _rememberSettingsToggle(key: string, v: boolean) {
  _settingsToggles[key] = v;
  try { localStorage.setItem('romm:settingsToggles', JSON.stringify(_settingsToggles)); } catch { /* ignore */ }
}

function SettingsPage() {
  const [loggingEnabled, setLoggingEnabled] = useState<boolean>(_settingsToggles.logging ?? true);
  const [debugMode, setDebugMode] = useState<boolean>(_settingsToggles.debug ?? false);
  const [loading, setLoading] = useState<boolean>(true);
  const [confirmLogout, setConfirmLogout] = useState<boolean>(false);
  const [loggingOut, setLoggingOut] = useState<boolean>(false);
  // When the log-out confirmation opens, land gamepad focus on its first option
  // instead of leaving the highlight parked on the (now-hidden) Log out row.
  const logoutFirstRef = useAutoFocus(confirmLogout, confirmLogout);
  // And bring the expanded panel on-screen: the forced focus above doesn't make
  // Steam scroll (only real navigation does), so without this the taller panel
  // opens below the fold and the user has to scroll to it manually.
  const confirmPanelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!confirmLogout) return;
    const timers = [120, 400].map((d) => setTimeout(() => {
      try { confirmPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* ignore */ }
    }, d));
    return () => timers.forEach(clearTimeout);
  }, [confirmLogout]);
  // Refetch throws away the cached library and reads everything from the
  // server again. Armed before it fires, like Log out above: nothing on disk
  // is destroyed, but it costs a full walk of the server, so it must not
  // happen on one stray press.
  const [refetchArmed, setRefetchArmed] = useState(false);
  const [refetching, setRefetching] = useState(false);
  useEffect(() => {
    if (!refetchArmed) return;
    const t = setTimeout(() => setRefetchArmed(false), 4000);
    return () => clearTimeout(t);
  }, [refetchArmed]);
  const doRefetch = async () => {
    if (refetching) return;
    if (!refetchArmed) { setRefetchArmed(true); return; }
    setRefetchArmed(false);
    setRefetching(true);
    try {
      const res = await rebuildLibrary();
      if (res?.success) {
        toaster.toast({
          title: 'Refetching library',
          body: 'Reading everything from RomM again. This can take a few minutes.',
        });
        _clearStale();
        _broadcastLibRefresh();
      } else if (res?.busy) {
        toaster.toast({ title: 'Already refreshing', body: 'A library fetch is in progress.' });
      } else {
        toaster.toast({ title: 'Refetch failed', body: res?.message ?? 'Unknown error' });
      }
    } catch (e: any) {
      toaster.toast({ title: 'Refetch failed', body: String(e?.message ?? e) });
    } finally {
      setRefetching(false);
    }
  };
  const [serverInfo, setServerInfo] = useState<string>('');
  const [rdDetected, setRdDetected] = useState<boolean>(!!_settingsShape?.rd);
  const [rdButton, setRdButton] = useState<boolean>(!!_settingsShape?.rdButton);

  // Desktop-only: the Ludo tile in Steam's library. Unlike the Deck plugin —
  // which owns its tile through SteamClient's live API — the desktop shell has
  // no SteamClient and the backend edits shortcuts.vdf, so the tile only shows
  // up after Steam restarts. `tileNote` carries that hint to the row subtitle.
  const [tileState, setTileState] = useState<{ available: boolean; installed: boolean }>(
    _settingsShape
      ? { available: _settingsShape.tileAvailable, installed: _settingsShape.tileInstalled }
      : { available: false, installed: false });
  const [tileBusy, setTileBusy] = useState<boolean>(false);
  const [tileNote, setTileNote] = useState<string>('');

  // Which screen corner notification toasts appear in. Persisted in
  // localStorage and read by the host's own toast host — only offered where the
  // shell draws toasts itself rather than the platform owning presentation.
  const canPlaceToasts = host.capabilities.toastPlacement;
  const [toastPos, setToastPos] = useState<string>(() => {
    try { return localStorage.getItem('romm:toastPos') || 'bottom-right'; }
    catch { return 'bottom-right'; }
  });
  const handleToastPos = (pos: string) => {
    setToastPos(pos);
    try { localStorage.setItem('romm:toastPos', pos); } catch { /* no storage */ }
    try { window.dispatchEvent(new Event('romm:toastpos')); } catch { /* ignore */ }
  };

  // Whether the answers that decide the page's *shape* have landed. The
  // RetroDECK and Steam sections sit above everything else and only exist on
  // some machines, so painting before we know pushes the rest of the page down
  // a step at a time as each reply arrives. Hold the body for one round-trip
  // instead and it arrives whole — but the remembered shape from the last
  // visit (`_settingsShape`) already answers the question, so repeat visits
  // paint whole on frame one and the live reads only reconcile drift (e.g.
  // RetroDECK uninstalled since). See `shapeTimer` below for the escape hatch.
  const [shapeReady, setShapeReady] = useState<boolean>(!!_settingsShape);

  useEffect(() => {
    // The "Ludo" tile is mandatory and auto-created at plugin load. Reconcile
    // here too (the shortcut store is reliably ready by the time Settings opens)
    // to sweep duplicates and repair the survivor's exe/name/art after updates.
    // Deliberately not awaited: nothing on this page renders from it, and
    // chaining it in front of the reads it doesn't feed just delays the paint.
    try { host.launcher.reconcileTile().catch(() => { /* ignore */ }); } catch { /* ignore */ }

    // Never let a wedged IPC hide the whole page — show what we have and let
    // the stragglers fill in, which is the old behaviour but only as a fallback.
    // 600ms, not the old 1500: the reads it waits for are cheap when idle, so
    // the timer really only covers a busy backend (mid-library-walk), and
    // holding a finished background for 1.5s was worse than a section
    // occasionally arriving a beat later.
    const shapeTimer = setTimeout(() => setShapeReady(true), 600);

    // These reads are independent of each other, so run them together rather
    // than awaiting in a chain; the page's first paint costs one round-trip,
    // not five. Each returns the shape fact it learned (null when it failed)
    // so this visit's answers can be remembered for the next one.
    const config = (async () => {
      const cfg = await getConfig();
      const url = cfg?.url || '';
      setRdDetected(!!cfg?.retrodeck_detected);
      // The account name only feeds the Account section's subtitle — and the
      // backend serves it from cache — so its round-trip must not hold the
      // page's first paint alongside the shape reads. It lands when it lands.
      getAccountUsername()
        .then((r) => {
          const name = r?.username || '';
          setServerInfo(name && url ? `${name} · ${url}` : (name || url || ''));
        })
        .catch(() => setServerInfo(url));
      return !!cfg?.retrodeck_detected;
    })();
    const rdBtn = (async () => {
      const on = !!(await getRetrodeckButtonEnabled());
      setRdButton(on);
      return on;
    })();
    const tile = (async () => {
      if (!host.capabilities.shortcutTile) return null;
      const st = await getSteamTileStatus();
      const t = { available: !!st?.available, installed: !!st?.installed };
      setTileState(t);
      return t;
    })();

    Promise.all([config, rdBtn, tile].map((p) => p.catch(() => null)))
      .then((res) => {
        // Positions restored by hand: .map() over the three promises flattens
        // them into one union, which tells TypeScript `rd` might be the tile
        // object and `t` a boolean.
        const [rd, btn, t] = res as [boolean | null, boolean | null,
          { available: boolean; installed: boolean } | null];
        clearTimeout(shapeTimer);
        setShapeReady(true);
        // Remember what this visit learned — but a FAILED read must not
        // clobber a fact an earlier visit established.
        const prev = _settingsShape
          || { rd: false, rdButton: false, tileAvailable: false, tileInstalled: false };
        _writeSettingsShape({
          rd: rd ?? prev.rd,
          rdButton: btn ?? prev.rdButton,
          tileAvailable: t ? t.available : prev.tileAvailable,
          tileInstalled: t ? t.installed : prev.tileInstalled,
        });
      });
    return () => clearTimeout(shapeTimer);
  }, []);

  // Gameplay: resume Continue playing from the newest save state.
  const [resumeStates, setResumeStates] = useState<boolean>(_resumeStatesPref);
  useEffect(() => {
    getResumeStateEnabled()
      .then((v) => { _setResumeStatesPref(!!v); setResumeStates(!!v); })
      .catch(() => { /* leave the last known value */ });
  }, []);
  // Saves: the live upload pill. No local mirror of the value — the pill's own
  // cached pref IS the state, and writing to it re-renders this row and the
  // pill together, so the switch and the thing it controls cannot disagree.
  const syncPill = useSyncPillEnabled();
  const [autoUpdateLib, setAutoUpdateLib] = useState<boolean>(_settingsToggles.autoUpdateLib ?? true);
  useEffect(() => {
    getLibraryAutoUpdate()
      .then((r) => {
        const v = r?.enabled !== false;
        setAutoUpdateLib(v);
        _rememberSettingsToggle('autoUpdateLib', v);
      })
      .catch(() => { /* keep the default */ });
  }, []);
  const [showVirtual, setShowVirtual] = useState<boolean>(_settingsToggles.showVirtual ?? true);
  useEffect(() => {
    getVirtualCollectionsVisible()
      .then((r) => {
        const v = r?.enabled !== false;
        setShowVirtual(v);
        _rememberSettingsToggle('showVirtual', v);
      })
      .catch(() => { /* keep the default */ });
  }, []);
  // Row subtitle for Platforms — only set once something is actually switched
  // off. With everything on there is nothing to report, and the explanatory
  // copy is what a first-time reader needs from that row instead.
  const [platformSummary, setPlatformSummary] = useState<string>('');
  useEffect(() => {
    getPlatformSync()
      .then((r) => {
        const rows = r?.platforms || [];
        const on = r?.enabled_count ?? rows.length;
        if (!r?.success || !rows.length || on === rows.length) return;
        setPlatformSummary(
          `${on} of ${rows.length} platforms syncing · `
          + `${(r.enabled_roms || 0).toLocaleString()} games`);
      })
      .catch(() => { /* the row keeps its explanatory subtitle */ });
  }, []);

  const handleSyncPillToggle = async (enabled: boolean) => {
    _setSyncPillPref(enabled);
    try {
      const r = await setSyncIndicatorRpc(enabled);
      if (r && r.success === false) throw new Error(r.message || 'failed');
    } catch {
      _setSyncPillPref(!enabled);
    }
  };

  const handleAutoUpdateLibToggle = async (enabled: boolean) => {
    setAutoUpdateLib(enabled);
    try {
      const r = await setLibraryAutoUpdate(enabled);
      if (r && r.success === false) throw new Error(r.message || 'failed');
      _rememberSettingsToggle('autoUpdateLib', enabled);
      // Turning it back on doesn't retro-apply anything by itself, but a
      // pending "your library changed" offer is now redundant with the next
      // connect — leave it standing rather than guess; the banner clears
      // itself on any successful refresh.
    } catch {
      setAutoUpdateLib(!enabled);
    }
  };

  const handleShowVirtualToggle = async (enabled: boolean) => {
    setShowVirtual(enabled);
    try {
      const r = await setVirtualCollectionsVisibleRpc(enabled);
      if (r && r.success === false) throw new Error(r.message || 'failed');
      _rememberSettingsToggle('showVirtual', enabled);
      // Drop the cached collections index so the next visit re-fetches groups
      // from the now-changed setting; a stale cache would keep showing (or
      // hiding) the Virtual section until something else refreshed it.
      delete _groupsCache['collection'];
      persistGroupsCache();
      _broadcastLibRefresh();
    } catch {
      setShowVirtual(!enabled);
    }
  };

  const handleResumeStatesToggle = async (enabled: boolean) => {
    setResumeStates(enabled);
    _setResumeStatesPref(enabled);
    try {
      await setResumeStateEnabled(enabled);
    } catch {
      setResumeStates(!enabled);
      _setResumeStatesPref(!enabled);
    }
  };

  const handleRdButtonToggle = async (enabled: boolean) => {
    setRdButton(enabled);
    try {
      await setRetrodeckButtonEnabled(enabled);
      // Tell the (still-mounted) library page's top bar to re-read, so the
      // launch button appears/disappears now rather than on the next launch.
      try { window.dispatchEvent(new Event('romm:rdbutton')); } catch { /* ignore */ }
    } catch { setRdButton(!enabled); }
  };

  const handleSteamTileToggle = async (enabled: boolean) => {
    if (tileBusy) return;
    setTileBusy(true);
    setTileNote('');
    try {
      // The launch command can only come from the Electron main process — it
      // alone knows whether we're an AppImage, a packaged binary or a checkout.
      const spec = enabled ? host.app.launchSpec() : null;
      if (enabled && !spec?.exe) {
        setTileNote('Could not determine how to relaunch this app.');
        return;
      }
      const r = await setSteamTile(enabled, spec?.exe || '', spec?.startDir || '', spec?.args || '');
      if (r?.success) {
        setTileState((s) => ({ ...s, installed: enabled }));
        // "Restart Steam to see the Ludo tile" is exactly what the row's own
        // subtitle already says, so echoing it back reads as a warning about
        // something new. Keep the note for the case the subtitle does NOT
        // cover: Steam wasn't running, so the tile is simply there.
        setTileNote(r.steam_running ? '' : (r.message || ''));
      } else {
        setTileNote(r?.message || 'Could not update the Steam library tile.');
      }
    } catch (e) {
      setTileNote(String(e));
    } finally {
      setTileBusy(false);
    }
  };

  // Auto-update state
  const [version, setVersion] = useState<string>('');
  const [channel, setChannel] = useState<string>('stable');
  const [checking, setChecking] = useState<boolean>(false);
  const [updating, setUpdating] = useState<boolean>(false);
  const [updateInfo, setUpdateInfo] = useState<any>(null);
  // What the update is doing right now. Decky reports real percentages
  // via loader events; the desktop path is a single long download with
  // none, so it names the phase instead of showing a frozen number.
  const [updatePhase, setUpdatePhase] = useState<string | null>(null);
  const [checkOnStartup, setCheckOnStartupState] = useState<boolean>(true);
  // Install progress % (from loader/plugin_download_info events) and the
  // inline status line under the action button ('ok' green / 'err' red).
  const [installPct, setInstallPct] = useState<number | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [lastChecked, setLastChecked] = useState<number | null>(null);

  useEffect(() => {
    // Load initial logging preference
    const loadSettings = async () => {
      try {
        const enabled = await getLoggingEnabled();
        setLoggingEnabled(enabled);
        _rememberSettingsToggle('logging', enabled);
        // Defaults false, so a failed read hides the developer rows rather
        // than showing a cache-wiping button to an ordinary user.
        try {
          const dbg = await isDebugMode();
          setDebugMode(dbg);
          _rememberSettingsToggle('debug', dbg);
        } catch { /* stays hidden */ }
      } catch (error) {
        console.error('Failed to load logging preference:', error);
      } finally {
        setLoading(false);
      }
    };
    loadSettings();
    // Load version + update channel. Three unrelated reads, so fetch them at
    // once — serialised, they made the Updates section fill in field by field.
    (async () => {
      try {
        const [ver, ch, onStartup] = await Promise.all([
          getPluginVersion(), getUpdateChannel(), getCheckOnStartup(),
        ]);
        setVersion(ver);
        setChannel(ch);
        setCheckOnStartupState(onStartup);
        // Auto-check when the section opens so the state is visible without a
        // button press (cached — see _updCheckCache).
        runUpdateCheck(ch, false);
      } catch (error) {
        console.error('Failed to load version/channel:', error);
      }
    })();
  }, []);

  const handleCheckOnStartupToggle = async (enabled: boolean) => {
    setCheckOnStartupState(enabled);
    try {
      await setCheckOnStartup(enabled);
    } catch (error) {
      console.error('Failed to set check-on-startup:', error);
      setCheckOnStartupState(!enabled);
    }
  };

  const handleChannelChange = async (next: string) => {
    if (updating) return;
    setChannel(next);
    setUpdateInfo(null);
    setStatusMsg(null);
    try {
      await setUpdateChannel(next);
    } catch (error) {
      console.error('Failed to set update channel:', error);
    }
    // Re-check right away so switching channels never shows stale state.
    runUpdateCheck(next, false);
  };

  const applyCheckResult = (info: any, ch: string, checkedAt: number) => {
    setUpdateInfo(info);
    setLastChecked(checkedAt);
    if (!info?.success) {
      setStatusMsg({ kind: 'err', text: `Couldn't check for updates — ${info?.message ?? 'unknown error'}` });
    } else if (!info.available) {
      setStatusMsg({ kind: 'ok', text: `Up to date — v${info.current} is the latest on ${ch}.` });
    } else {
      setStatusMsg(null);
    }
  };

  const runUpdateCheck = async (ch: string, force: boolean) => {
    // Auto-checks (section open, channel switch) reuse a recent result; the
    // manual button always hits the network.
    const c = _updCheckCache;
    if (!force && c && c.channel === ch && Date.now() - c.t < _UPD_CACHE_MS) {
      applyCheckResult(c.info, ch, c.t);
      return;
    }
    setChecking(true);
    setUpdateInfo(null);
    setStatusMsg(null);
    const startedAt = Date.now();
    try {
      const info = await checkForUpdate(ch);
      // A manual check that comes back in ~200ms (the usual case) produced no
      // perceptible feedback at all: the subline it lands on is the SAME text
      // the mount-time auto-check already left there, so the only signal was a
      // "Checking…" flash the eye misses. Hold the busy state briefly so the
      // press visibly does something...
      if (force) {
        const remaining = MIN_CHECK_MS - (Date.now() - startedAt);
        if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      }
      const now = Date.now();
      if (info?.success) _updCheckCache = { t: now, channel: ch, info };
      applyCheckResult(info, ch, now);
      // ...and answer the question the user actually asked. Only for manual
      // checks — auto-checks (mount, channel switch) must stay silent.
      if (force) {
        if (!info?.success) {
          toaster.toast({ title: 'Updates', body: `Couldn’t check — ${info?.message ?? 'unknown error'}` });
        } else if (!info.available) {
          toaster.toast({ title: 'Updates', body: `Up to date — v${info.current} is the latest on ${ch}.` });
        }
        // An available update needs no toast: the card itself changes loudly
        // (version line, "Install v…" button, release notes).
      }
    } catch (error) {
      setLastChecked(Date.now());
      setStatusMsg({ kind: 'err', text: `Couldn't check for updates — ${String(error)}` });
    } finally {
      setChecking(false);
    }
  };

  const handleCheckUpdate = () => runUpdateCheck(channel, true);

  const handleInstallUpdate = async () => {
    if (!updateInfo?.url) return;
    setUpdating(true);
    setStatusMsg(null);
    setInstallPct(0);
    try {
      // A self-updating shell has no plugin loader behind it. The release asset
      // is a single executable, so we download it and swap the running file; the
      // swap only takes effect on restart, which a loader never needs since it
      // reloads the code in place.
      if (host.capabilities.selfUpdate) {
        // No progress events on this path — the download is one long request,
        // so a percentage would sit at 0 for the whole ~170MB and read as
        // stalled. Use the busy state and say what is happening instead.
        setInstallPct(null);
        setUpdatePhase(`Downloading v${updateInfo.latest}…`);
        setStatusMsg({ kind: 'ok', text: `Downloading v${updateInfo.latest} — this may take a minute.` });
        const dl = await downloadUpdate(updateInfo.url);
        if (!dl?.success) {
          setStatusMsg({ kind: 'err', text: `Download failed — ${dl?.message ?? 'unknown error'}` });
          setUpdatePhase(null);
          setUpdating(false);
          setInstallPct(null);
          return;
        }
        setUpdatePhase('Installing…');
        const applied = await applyAppImageUpdate(dl.path);
        if (!applied?.success) {
          setStatusMsg({ kind: 'err', text: `Install failed — ${applied?.message ?? 'unknown error'}` });
          setUpdatePhase(null);
          setUpdating(false);
          setInstallPct(null);
          return;
        }
        setInstallPct(null);
        setUpdatePhase(null);
        setUpdating(false);
        // Clear `available`: the update is on disk, so offering "Install"
        // again is wrong. The action button becomes Restart instead.
        setUpdateInfo({ ...updateInfo, available: false, restartRequired: true });
        setStatusMsg({ kind: 'ok', text: `v${updateInfo.latest} installed — restart to finish.` });
        return;
      }

      // One-click install through the loader's WSRouter (window.DeckyBackend) —
      // @decky/api's `call` namespaces routes to our own plugin, so it can't
      // reach loader utilities/*. utilities/install_plugin only REGISTERS an
      // install request and emits loader/add_plugin_install_prompt, which
      // Decky's frontend turns into its own confirmation modal. The user already
      // confirmed in OUR UI, so we suppress Decky's listener for that one event,
      // catch the request_id ourselves, and confirm programmatically — no Decky
      // modal. Progress/completion arrive as loader/plugin_download_* events.
      try {
        const backend = (window as any).DeckyBackend;
        if (!backend?.call || !backend?.eventListeners?.get) throw new Error('DeckyBackend unavailable');

        const PROMPT = 'loader/add_plugin_install_prompt';
        const promptSet: Set<any> | undefined = backend.eventListeners.get(PROMPT);
        const saved = promptSet ? Array.from(promptSet) : [];
        promptSet?.clear();

        let restored = false;
        const restore = () => {
          if (restored) return;
          restored = true;
          try {
            backend.removeEventListener(PROMPT, onPrompt);
            for (const l of saved) backend.addEventListener(PROMPT, l);
            backend.removeEventListener('loader/plugin_download_info', onInfo);
            backend.removeEventListener('loader/plugin_download_finish', onFinish);
          } catch { /* ignore */ }
        };

        const onPrompt = (name: string, _version: string, request_id: string) => {
          if (name !== 'Ludo') return;
          // Put Decky's listeners back immediately — store installs must keep
          // prompting normally; only OUR request skips the modal.
          try {
            backend.removeEventListener(PROMPT, onPrompt);
            for (const l of saved) backend.addEventListener(PROMPT, l);
          } catch { /* ignore */ }
          backend.call('utilities/confirm_plugin_install', request_id).catch((e: any) => {
            restore();
            setUpdating(false);
            setInstallPct(null);
            setStatusMsg({ kind: 'err', text: `Install failed — ${String(e?.message ?? e)}` });
          });
        };
        const onInfo = (percent: number) => {
          if (typeof percent === 'number') setInstallPct(Math.max(0, Math.min(100, Math.round(percent))));
        };
        const onFinish = (name: string) => {
          if (name !== 'Ludo') return;
          restore();
          setInstallPct(100);
          toaster.toast({ title: `Updated to v${updateInfo.latest}`, body: '', duration: 5000 });
          // Do NOT call loader/reload_plugin here: utilities/install_plugin
          // ALREADY reloads us (its _install does stop() + import_plugin(), and
          // import_plugin re-imports the frontend via the loader/import_plugin
          // event). An extra reload stacked a 3× reload storm that left the UI
          // orphaned at 100%. The loader's own single reload picks up the reopen
          // breadcrumb set before the install call below.
        };

        backend.addEventListener(PROMPT, onPrompt);
        backend.addEventListener('loader/plugin_download_info', onInfo);
        backend.addEventListener('loader/plugin_download_finish', onFinish);
        // Safety net: if no prompt/finish ever arrives, restore Decky's
        // listeners and surface an error instead of hanging in "Installing…".
        setTimeout(() => {
          if (!restored) {
            restore();
            setUpdating(false);
            setInstallPct(null);
            setStatusMsg({ kind: 'err', text: 'Install timed out — try again or install from ZIP.' });
          }
        }, 90000);

        // Set the reopen-home breadcrumb NOW, before install — the loader may
        // tear the frontend down mid-install (import_plugin), so setting it in
        // onFinish could be too late. Survives the reload (Chromium-origin
        // localStorage); consumed once on the next startup.
        try { localStorage.setItem(_LS_REOPEN_HOME, String(Date.now())); } catch { /* ignore */ }

        await backend.call(
          'utilities/install_plugin',
          updateInfo.url,
          'Ludo',
          updateInfo.latest,
          '',
        );
        return; // stay in "Installing…" — the loader's install reloads us
      } catch (loaderErr) {
        console.warn('Loader install route unavailable, falling back to manual:', loaderErr);
        // Clear the breadcrumb — no reload will happen on this path, so it must
        // not hijack a later normal launch into reopening Home.
        try { localStorage.removeItem(_LS_REOPEN_HOME); } catch { /* ignore */ }
        setInstallPct(null);
      }

      // Fallback: download the zip ourselves and guide the user through Decky's
      // "Install plugin from ZIP" developer flow.
      const dl = await downloadUpdate(updateInfo.url);
      if (!dl?.success) {
        setStatusMsg({ kind: 'err', text: `Download failed — ${dl?.message ?? 'unknown error'}` });
        return;
      }
      setStatusMsg({ kind: 'ok', text: `v${updateInfo.latest} downloaded — install it via Decky ▸ gear ▸ Install plugin from ZIP.` });
      setUpdateInfo({ ...updateInfo, downloadedPath: dl.path });
      setUpdating(false);
    } catch (error) {
      setStatusMsg({ kind: 'err', text: `Update failed — ${String(error)}` });
      setUpdating(false);
      setInstallPct(null);
      setUpdatePhase(null);
    }
  };

  const handleLoggingToggle = async (enabled: boolean) => {
    setLoggingEnabled(enabled);
    try {
      await updateLoggingEnabled(enabled);
      _rememberSettingsToggle('logging', enabled);
    } catch (error) {
      console.error('Failed to set logging preference:', error);
      setLoggingEnabled(!enabled);
    }
  };

  // Cold-fetch timer (Settings ▸ Debug). The fetch runs for minutes on a large
  // library, so the RPC returns as soon as it starts and we poll for a record
  // newer than the one that was there before — comparing `at` rather than just
  // "a record exists", or a previous run's result would read as this one's.
  const [benchmark, setBenchmark] = useState<any>(null);
  // Seeded from the module-level flag, not false: coming back to Settings while
  // a timed fetch is still running has to show the row busy.
  const [timingFetch, setTimingFetch] = useState(_benchRunning);

  useEffect(() => {
    getFetchBenchmark().then((r) => setBenchmark(r?.result || null)).catch(() => {});
    const onDone = (b: any) => { setBenchmark(b); setTimingFetch(false); };
    _benchListeners.add(onDone);
    // Only the listener is dropped on unmount — the poll itself keeps running.
    return () => { _benchListeners.delete(onDone); };
  }, []);

  const handleTimeColdFetch = async () => {
    if (timingFetch) return;
    setTimingFetch(true);
    try {
      const r = await timeColdFetch();
      if (!r?.success) {
        setTimingFetch(false);
        toaster.toast({ title: 'Cold fetch', body: r?.message || 'Could not start' });
        return;
      }
      _startBenchPoll(r.previous_at || null);
      // Back to the library: the whole run is a cold start, so this lands the
      // user exactly where a cold start does — watching the library refill,
      // with the fetch toast narrating it — instead of on a settings row with
      // nothing to show for two minutes. The result still arrives (the poll is
      // module-level now) and its toast comes back here on click.
      libBack('/romm-sync-library');
    } catch (e) {
      setTimingFetch(false);
      console.error('time cold fetch failed:', e);
    }
  };

  const handleLogout = async (wipeData: boolean) => {
    setLoggingOut(true);
    try {
      const result = await logout(wipeData);
      if (result?.success) {
        // Drop the remembered pill identity, or the next launch paints the
        // signed-out user's name and avatar until the fetch says otherwise.
        clearIdentityCache();
        // The browse lists are cached to localStorage for instant repaint, so
        // they'd otherwise survive the logout and greet the next user.
        clearBrowseCaches();
        // The backend re-arms its one-shot announcement on logout; this latch
        // has to drop too or the next sign-in's "library is ready" is swallowed
        // by a session that already toasted once.
        _annShown = false;
        toaster.toast({
          title: 'Logged out',
          body: wipeData
            ? `${result.deleted_roms ?? 0} ROM file(s) deleted. Signed out of RomM.`
            : 'Signed out of RomM. Downloaded files were kept.',
        });
        // Hand back to the setup wizard so the user can sign in again. Pop the
        // library route off the history stack FIRST (like the wizard's own
        // finish()), otherwise pressing Back from the wizard lands the user
        // right back on the now signed-out library home.
        try { Navigation.NavigateBack(); } catch { /* ignore */ }
        setTimeout(() => { Navigation.Navigate("/romm-sync-setup"); Navigation.CloseSideMenus(); }, 60);
      } else {
        toaster.toast({ title: 'Logout failed', body: result?.error ?? 'Unknown error' });
      }
    } catch (error) {
      toaster.toast({ title: 'Logout failed', body: String(error) });
    } finally {
      setLoggingOut(false);
      setConfirmLogout(false);
    }
  };

  return v2Page(
    <Focusable noFocusRing
      onCancelButton={() => libBack("/romm-sync-library")}
      style={{ maxWidth: '760px', margin: '0 auto', padding: '20px 20px 0' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <GameActionButton icon={<FaChevronLeft size={16} />} onClick={() => libBack("/romm-sync-library")} />
        <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.01em' }}>Settings</div>
      </div>

      {/* Held at opacity 0 for the one round-trip it takes to learn whether the
          RetroDECK and Steam sections apply, then faded in as a finished page.
          Opacity rather than a `shapeReady && ...` gate on purpose: this keeps
          the subtree mounted, so nothing remounts and gamepad focus never has
          to be re-seeded. `shapeTimer` guarantees this always resolves. */}
      <div style={{
        opacity: shapeReady ? 1 : 0,
        transition: 'opacity 140ms ease-out',
      }}>
      <V2SettingsSection title="Library">
        {/* One card, not one per option — same shape as Emulator & folders:
            these are all answers to "what does my library contain", and they
            read as a block. The rows are fixed (no conditional ones), so
            first/divider/last are stated outright instead of computed. */}
        <div style={{
          display: 'flex', flexDirection: 'column',
          borderRadius: V2.radiusCard, background: V2.surface,
          border: `1px solid ${V2.border}`, overflow: 'hidden',
        }}>
          <V2CardRow
            first
            icon={<FaSync size={16} />}
            title="Update your library automatically"
            subtitle="Re-reads changed platforms automatically."
            onClick={() => handleAutoUpdateLibToggle(!autoUpdateLib)}
            right={<V2Switch checked={autoUpdateLib} />}
          />
          <V2CardRow
            divider
            icon={<FaBookmark size={16} />}
            title="Show virtual collections"
            subtitle="Shown on the Home and Collections pages."
            onClick={() => handleShowVirtualToggle(!showVirtual)}
            right={<V2Switch checked={showVirtual} />}
          />
          <V2CardRow
            divider
            icon={refetchArmed ? <FaCheck size={16} /> : <FaRedo size={16} />}
            title={refetching ? 'Refetching…'
              : refetchArmed ? 'Press again to refetch' : 'Refetch library'}
            subtitle={refetchArmed
              ? 'Refetches everything. Nothing downloaded is deleted.'
              : 'Refetch everything from RomM.'}
            onClick={refetching ? undefined : doRefetch}
          />
          <V2CardRow
            divider
            last
            icon={<FaLayerGroup size={16} />}
            title="Platforms"
            subtitle={platformSummary
              || 'Choose which platforms Ludo syncs.'}
            onClick={() => libNavigate("/romm-sync-platforms")}
            right={<FaChevronRight size={12} style={{ color: V2.fgFaint }} />}
          />
        </div>
      </V2SettingsSection>

      <V2SettingsSection title="Saves">
        <V2SettingsRow
          icon={<FaCloudUploadAlt size={16} />}
          title="Show saves being uploaded"
          subtitle="Shows a badge while a save uploads."
          onClick={() => handleSyncPillToggle(!syncPill)}
          right={<V2Switch checked={syncPill} />}
        />
      </V2SettingsSection>

      <V2SettingsSection title="Gameplay">
        <V2SettingsRow
          icon={<FaPlay size={16} />}
          title="Resume from your last save state"
          subtitle="Continue playing boots into the newest save state."
          onClick={() => handleResumeStatesToggle(!resumeStates)}
          right={<V2Switch checked={resumeStates} />}
        />
      </V2SettingsSection>

      {rdDetected && (
        <V2SettingsSection title="RetroDECK">
          <V2SettingsRow
            icon={<FaExternalLinkAlt size={16} />}
            title="Show RetroDECK launch button"
            subtitle="Adds a top-bar button to launch RetroDECK."
            onClick={() => handleRdButtonToggle(!rdButton)}
            right={<V2Switch checked={rdButton} />}
          />
        </V2SettingsSection>
      )}

      {host.capabilities.shortcutTile && tileState.available && (
        <V2SettingsSection title="Steam">
          <V2SettingsRow
            icon={<FaExternalLinkAlt size={16} />}
            title="Add to Steam library"
            subtitle={tileNote
              || 'Adds a "Ludo" tile. Restart Steam to see it.'}
            onClick={() => handleSteamTileToggle(!tileState.installed)}
            right={<V2Switch checked={tileState.installed} />}
          />
        </V2SettingsSection>
      )}

      {canPlaceToasts && (
        <V2SettingsSection title="Notifications">
          <div style={{
            display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px',
            borderRadius: V2.radiusCard, background: V2.surface, border: `1px solid ${V2.border}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
              <FaInfoCircle size={16} style={{ color: V2.fgMuted, flexShrink: 0 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                <span style={{ fontSize: '14px', fontWeight: 600 }}>Overlay position</span>
                <span style={{ fontSize: '12px', color: V2.fgMuted }}>
                  Which corner notifications appear in.
                </span>
              </div>
            </div>
            <div style={{ alignSelf: 'flex-start' }}>
              <V2Segment
                options={[
                  { id: 'top-left', label: 'Top left' },
                  { id: 'top-right', label: 'Top right' },
                  { id: 'bottom-left', label: 'Bottom left' },
                  { id: 'bottom-right', label: 'Bottom right' },
                ]}
                value={toastPos} onChange={handleToastPos} />
            </div>
          </div>
        </V2SettingsSection>
      )}

      <V2SettingsSection title="Updates">
        <div style={{
          display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px',
          borderRadius: V2.radiusCard, background: V2.surface, border: `1px solid ${V2.border}`,
        }}>
          {/* Header: version prominent, channel as a segmented control */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
              <span style={{ fontSize: '16px', fontWeight: 800, lineHeight: 1 }}>v{version || '…'}</span>
              {/* Status subline: one glanceable row with icon */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', lineHeight: 1.3 }}>
                {checking ? (
                  <span style={{ color: V2.fgMuted }}>Checking…</span>
                ) : updateInfo?.available ? (
                  <>
                    <FaDownload size={10} style={{ color: V2.brand, flexShrink: 0 }} />
                    <span style={{ color: V2.brand, fontWeight: 600 }}>
                      v{updateInfo.latest} available{updateInfo.prerelease ? ' (pre-release)' : ''}
                    </span>
                  </>
                ) : statusMsg?.kind === 'err' ? (
                  <>
                    <FaTimesCircle size={10} style={{ color: V2.danger, flexShrink: 0 }} />
                    <span style={{ color: V2.danger }}>{statusMsg.text}</span>
                  </>
                ) : statusMsg?.kind === 'ok' ? (
                  <>
                    <FaCheckCircle size={10} style={{ color: '#4ade80', flexShrink: 0 }} />
                    <span style={{ color: V2.fgMuted }}>
                      Up to date{lastChecked != null && ` · checked ${Date.now() - lastChecked < 60000 ? 'just now' : `${Math.round((Date.now() - lastChecked) / 60000)}m ago`}`}
                    </span>
                  </>
                ) : (
                  <span style={{ color: V2.fgMuted }}>{channel} channel</span>
                )}
              </div>
            </div>
            <V2Segment options={[{ id: 'stable', label: 'Stable' }, { id: 'beta', label: 'Beta' }]}
              value={channel} onChange={handleChannelChange} disabled={updating} />
          </div>
          {/* Action: full width, fixed height; fills with brand color while installing */}
          {/* One action, whose meaning follows the state: check -> install ->
              restart. A separate restart button alongside a re-enabled
              "Install" reads as if the install failed. */}
          <UpdateActionBtn
            label={updating ? (updatePhase ?? `Installing…${installPct != null ? ` ${installPct}%` : ''}`)
              : checking ? 'Checking…'
                : updateInfo?.restartRequired ? 'Restart to finish updating'
                  : updateInfo?.available ? `Install v${updateInfo.latest}`
                    : 'Check for Updates'}
            icon={updateInfo?.restartRequired ? <FaSync size={13} />
              : updateInfo?.available && !updating ? <FaDownload size={13} />
                : <FaSync size={13} />}
            onClick={updateInfo?.restartRequired
              ? () => host.app.restart()
              : updateInfo?.available ? handleInstallUpdate : handleCheckUpdate}
            disabled={checking || updating}
            primary={(!!updateInfo?.available || !!updateInfo?.restartRequired) && !updating}
            progress={updating ? installPct : null}
            busy={checking || updating}
          />
          {updateInfo?.downloadedPath && (
            <div style={{ fontSize: '11px', color: V2.fgMuted, wordBreak: 'break-all' }}>
              Downloaded to: {updateInfo.downloadedPath}
            </div>
          )}
          {updateInfo?.available && !!updateInfo.notes && !updating && (
            <>
              <div style={{ height: '1px', background: V2.border }} />
              <div style={{ fontSize: '12px', color: V2.fg2, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 600, color: V2.fg, marginBottom: '4px' }}>What's new in v{updateInfo.latest}</div>
                {/* Fade-out mask instead of a hard clip, so truncation reads as intentional */}
                <div style={{
                  whiteSpace: 'pre-wrap', maxHeight: '96px', overflow: 'hidden',
                  WebkitMaskImage: 'linear-gradient(180deg, black 62%, transparent 100%)',
                  maskImage: 'linear-gradient(180deg, black 62%, transparent 100%)',
                } as any}>
                  {String(updateInfo.notes).slice(0, 600)}
                </div>
              </div>
            </>
          )}
          <div style={{ height: '1px', background: V2.border }} />
          <RomSwitch
            checked={checkOnStartup}
            onChange={handleCheckOnStartupToggle}
            label="Check on startup"
            description="Notify me when an update is available."
          />
        </div>
      </V2SettingsSection>

      <RecentActivitySection />

      <FoldersSection />

      <V2SettingsSection title="Account">
        {!confirmLogout ? (
          <V2SettingsRow
            icon={<FaUndo size={16} />}
            title="Log out"
            subtitle={serverInfo ? `Signed in as ${serverInfo}` : undefined}
            onClick={() => setConfirmLogout(true)}
            danger
          />
        ) : (
          <div ref={confirmPanelRef} style={{
            display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px',
            borderRadius: V2.radiusCard, background: 'rgba(255,80,80,0.08)',
            border: `1px solid rgba(255,80,80,0.40)`,
          }}>
            <div style={{ fontSize: '13px', color: V2.fg2, lineHeight: 1.4 }}>
              You’ll return to the setup wizard either way.
            </div>
            <GameActionButton icon={<FaUndo size={14} />} label={loggingOut ? 'Logging out…' : 'Log out (keep downloads)'}
              focusRef={logoutFirstRef} onClick={() => handleLogout(false)} disabled={loggingOut} />
            <GameActionButton icon={<FaTrash size={14} />} label={loggingOut ? 'Logging out…' : 'Log out & delete all downloads'}
              variant="danger" onClick={() => handleLogout(true)} disabled={loggingOut} />
            <GameActionButton icon={<FaTimes size={14} />} label="Cancel"
              onClick={() => setConfirmLogout(false)} disabled={loggingOut} />
          </div>
        )}
      </V2SettingsSection>

      <V2SettingsSection title="Debug">
        <V2SettingsRow
          icon={<FaBug size={16} />}
          title="Enable debug logging"
          subtitle="Write logs to ~/.config/ludo/debug.log"
          onClick={loading ? undefined : () => handleLoggingToggle(!loggingEnabled)}
          right={<V2Switch checked={loggingEnabled} />}
          disabled={loading}
        />
        {debugMode && <V2SettingsRow
          icon={<FaStopwatch size={16} />}
          title={timingFetch ? 'Timing a cold fetch…' : 'Time a cold library fetch'}
          subtitle={
            timingFetch
              ? 'Clearing caches and refetching — this can take minutes'
              : benchmark
                ? `Last: ${fmtFetchDuration(benchmark.seconds)} for ${benchmark.roms ?? '?'} ROMs`
                  + (benchmark.pages ? ` (${benchmark.pages} pages` : '')
                  + (benchmark.pages && benchmark.seconds_per_page
                      ? `, ${benchmark.seconds_per_page}s each)` : benchmark.pages ? ')' : '')
                  + (benchmark.incomplete ? ' — INCOMPLETE' : '')
                  + (benchmark.cold === false ? ' — resumed, not cold' : '')
                : undefined
          }
          onClick={timingFetch ? undefined : handleTimeColdFetch}
          disabled={timingFetch}
        />}
      </V2SettingsSection>

      <V2SettingsSection title="About">
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
          padding: '20px 16px', borderRadius: V2.radiusCard, background: V2.surface,
          border: `1px solid ${V2.border}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{ fontWeight: 800, fontSize: '16px' }}>Ludo</span>
            <span style={{ color: V2.fgMuted, fontSize: '12px' }}>v{version || '1.0.0'}</span>
          </div>
          <div style={{ color: V2.fgMuted, fontSize: '12px' }}>by Covin</div>
          <div style={{ display: 'flex', gap: '10px', marginTop: '6px' }}>
            {[
              { icon: <FaGithub size={13} />, label: 'GitHub', url: 'https://github.com/Covin90/ludo' },
              { icon: <FaBug size={13} />, label: 'Report Issue', url: 'https://github.com/Covin90/ludo/issues' },
            ].map(({ icon, label, url }) => (
              <V2Button key={label} variant="tonal" onClick={() => Navigation.NavigateToExternalWeb(url)}>
                {icon}<span>{label}</span>
              </V2Button>
            ))}
          </div>
        </div>
      </V2SettingsSection>
      </div>
    </Focusable>
  );
}


// ─── Setup wizard ────────────────────────────────────────────────────────────
// Full-screen guided first-run flow (RomM v2 visual language): Welcome →
// Connect (login or pair code, with Test) → Folders → Finish. Auto-opened on
// startup when no connection is configured; also reachable from the QAM.

// RomSwitch — React port of RomM's frontend/src/v2/lib/forms/RSwitch/RSwitch.vue.
// An iOS-style 36×20px track with a 14px knob that slides on toggle, with the
// brand-purple background, inner sheen, outer glow, spring easing and active
// press squash that define the RomM v2 toggle's feel.
function RomSwitch({ checked, onChange, disabled, label, description }:
  { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string; description?: string }) {
  const [focused, setFocused] = useState(false);
  const row = (inner: any) => (
    // Focusable (not a bare div) so the gamepad can land on it and it shows a
    // focus highlight — a plain div only reacts to :hover, which never fires
    // under controller navigation.
    <Focusable
      noFocusRing
      onActivate={() => { if (!disabled) onChange(!checked); }}
      onClick={() => { if (!disabled) onChange(!checked); }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)}
      onMouseLeave={() => setFocused(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: '14px', width: '100%',
        // border-box: this webview defaults to content-box, so 100% width plus
        // the 14px side padding + 1px border overflowed the parent card.
        boxSizing: 'border-box',
        padding: '12px 14px', borderRadius: V2.radiusMd, cursor: disabled ? 'not-allowed' : 'pointer',
        background: focused && !disabled ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.045)',
        border: `1px solid ${focused && !disabled ? V2.brand : V2.border}`,
        opacity: disabled ? 0.55 : 1,
        transition: 'background 0.2s, border-color 0.2s, box-shadow 0.15s',
        ...V2Focus.flat(focused && !disabled),
      }}
    >
      <div className={`r-switch${checked ? ' r-switch--on' : ''}${disabled ? ' r-switch--disabled' : ''}`} style={{ display: 'inline-flex', alignItems: 'center', background: 'transparent', border: 'none', padding: 0 }}>
        <span className="r-switch__track" style={{ position: 'relative', flexShrink: 0, borderRadius: '999px', background: checked ? V2.brand : V2.borderStrong, overflow: 'hidden', width: '36px', height: '20px', transition: 'background 260ms cubic-bezier(0.45,0.05,0.55,0.95), box-shadow 260ms cubic-bezier(0.45,0.05,0.55,0.95)' }}>
          <span className="r-switch__knob" style={{ position: 'absolute', top: '3px', left: '3px', // White in both states: on the brand-purple track a dark knob reads as
// unlit/disabled, which is the opposite of what "on" should look like.
borderRadius: '50%', background: V2.fg, width: '14px', height: '14px', transform: checked ? 'translateX(16px) scaleX(1)' : 'translateX(0) scaleX(1)', transformOrigin: checked ? 'right center' : 'left center', transition: 'transform 340ms cubic-bezier(0.34,1.56,0.64,1), background 200ms cubic-bezier(0.22,1,0.36,1)', boxShadow: '0 1px 2px rgba(0,0,0,0.22)' }} />
        </span>
      </div>
      {(label || description) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 auto', minWidth: 0 }}>
          {label && <span style={{ fontSize: '14px', fontWeight: 500, color: V2.fg }}>{label}</span>}
          {description && <span style={{ fontSize: '12px', color: V2.fgMuted, lineHeight: 1.45 }}>{description}</span>}
        </div>
      )}
      {inner}
    </Focusable>
  );
  // The scoped <style> block carries the box-shadow sheen/glow + hover halo +
  // active-press squash that can't be expressed as inline styles.
  return (
    <>
      <style>{`
        .r-switch--on .r-switch__track{box-shadow:inset 0 1px 0 rgba(255,255,255,0.18),0 0 12px rgba(139,116,232,0.38)}
        .r-switch:not(.r-switch--disabled){cursor:pointer}
        .r-switch--disabled{cursor:not-allowed;opacity:0.55}
        .r-switch > div:hover .r-switch__knob,.r-switch:hover:not(.r-switch--disabled) .r-switch__knob{box-shadow:0 2px 4px rgba(0,0,0,0.28),0 0 0 5px rgba(255,255,255,0.10)}
        .r-switch--on:hover .r-switch__knob,.r-switch--on:hover:not(.r-switch--disabled) .r-switch__knob{box-shadow:0 2px 4px rgba(0,0,0,0.28),0 0 0 5px rgba(139,116,232,0.22)}
        .r-switch:active:not(.r-switch--disabled) .r-switch__knob{transform:translateX(0) scaleX(1.35);transition:transform 110ms cubic-bezier(0.22,1,0.36,1)}
        .r-switch--on:active:not(.r-switch--disabled) .r-switch__knob{transform:translateX(16px) scaleX(1.35);transition:transform 110ms cubic-bezier(0.22,1,0.36,1)}
        @media(prefers-reduced-motion:reduce){.r-switch__track,.r-switch__knob{transition:none!important}.r-switch:active .r-switch__knob{transform:translateX(0) scaleX(1)!important}.r-switch--on:active .r-switch__knob{transform:translateX(16px) scaleX(1)!important}}
      `}</style>
      {row(null)}
    </>
  );
}





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
