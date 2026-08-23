import { memo, useEffect, useRef, useState } from "react";
import { LibGame, LibGroup } from "./types";
import { _dlSucceeded, _setDlActive, awaitDownload, runCollectionBatch, useDownloadProgress, useIsDownloading } from "./downloads";
import { V2, roundBtn} from "./theme";
import {
  LocalDisc,
  ToastCover,
  openDiscPicker,
  openGameById,
  useSaveActivityFor,
  _tileElsByRomId,
  _tileFocusScrub,
  libCacheDelete,
  MODAL_SCRIM_INSET,
  PickerModal,
  libCacheDrop,
  NAV_MAINTAIN_X,
} from "./index";
import { useCollectionSync, useOffline } from "./status";
import { deleteCollectionRoms, deleteGame, downloadGame, getLibraryGames, getLocalDiscs, getLocalSiblings, resyncPlatform, toggleCollectionSync } from "./rpc";
import { Focusable, GamepadButton, Menu, MenuItem, showContextMenu, showModal, toaster, ModalRoot} from "@ludo/host";
import { maybePromptSwitchFirmware } from "./firmware";
import { _libGamesCache, libCacheSetDownloaded, _focusedPlatform, _setFocusedPlatform} from "./libcache";
import { V2Focus, V2_FOCUS_STYLE} from "./focus";
import { CoverPip, GameCover, ScreenshotArt, awaitCover, peekCover, qGetImage } from "./media";
import { PlatformIcon, ProgressRing, UserMenuRow} from "./kit";
import { FaBookmark, FaBoxOpen, FaCheck, FaChevronLeft, FaChevronRight, FaClone, FaCloudUploadAlt, FaDownload, FaEllipsisH, FaGlobe, FaInfoCircle, FaPlay, FaSync, FaTrash, FaUnlink, FaGamepad, FaMicrochip} from "react-icons/fa";
import { _broadcastLibRefresh } from "./events";
import { MdFlashOn } from "react-icons/md";
import { _forceGamepadFocus } from "./shell";
import { BiosDetailModal } from "./pages/bios";
import { launchGameSmart, offerCoreInstall, cannotLaunch, runLaunch} from "./launch";
import { _emuStatus, standaloneFor } from "./emulator";
// The things a grid is made of.
//
// A tile is not just a cover: it carries the download state, the focus
// treatment, the resume thumbnail and the multi-disc/region affordances, and it
// has to stay correct while a download it does not own progresses somewhere
// else. That is why it subscribes to the registries rather than taking
// everything as props — a grid of a hundred of these cannot re-render wholesale
// on every progress tick.

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

function regionToEmoji(region: string): string {
  return REGION_EMOJI[(region || '').toLowerCase()] || region;
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

export const GameTile = memo(function GameTile({ game, onOpen, onActiveCover, focusRef, index, onFocusIdx, focusable, resume, stateThumb }:
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
export function PathImage({ path }: { path: string }) {
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
export function CollectionMosaic({ covers }: { covers: string[] }) {
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

// Collection tile — mosaic cover + kind badge + name/count below, with the
// focus scale + brand glow (RomM CollectionTile).
export function CollectionTile({ group, onOpen, focusRef, focusable }: { group: LibGroup; onOpen: (g: LibGroup) => void; focusRef?: React.Ref<any>; focusable?: boolean }) {
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
export function PlatformTile({ group, onOpen, focusRef, focusable }: { group: LibGroup; onOpen: (g: LibGroup) => void; focusRef?: React.Ref<any>; focusable?: boolean }) {
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

// Small count tag — RomM RTag x-small used in CardRow headers.
export function Tag({ children }: { children: any }) {
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
export function CardRow({ icon, title, count, children }:
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
