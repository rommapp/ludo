import { LibGame, LibGroup } from "../types";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { deleteCollectionRoms, getConfig, getDownloadProgress, getHomeData, getLibraryGames, getLibraryGroups, getResumeStateEnabled, getServiceStatus, repairEmulatorPaths, searchGames, toggleCollectionSync, checkLibraryStale, refreshFromRomm} from "../rpc";
import { CardRow, CollectionTile, GameTile, PlatformTile, _resumeStatesPref, _setResumeStatesPref, _stateThumbListeners, _stateThumbs, _tileElsByRomId, loadStateThumbs} from "../tiles";
import { _autoFocusFirstRef, _forceGamepadFocus, _gpFocusEl, playSteamSound, useAutoFocus } from "../shell";
import { Bumper, GameActionButton, V2SearchField, useEtaFromPct, Shimmer} from "../kit";
import { V2, formatEta, formatSpeed } from "../theme";
import { Focusable, GamepadButton, Navigation, host, showModal } from "@ludo/host";
import { toaster } from "../toast";
import { FaBookmark, FaCheck, FaChevronRight, FaDownload, FaEllipsisH, FaExclamationTriangle, FaGamepad, FaLayerGroup, FaPlay, FaRegClock, FaSync } from "react-icons/fa";
import { LibView, NavId, libBack, libNavigate, navExitPlugin, pushLibView, setLibViewHooks } from "../nav";
import { _groupsCache, _libGamesCache, getHomeCache, getLibGroupHolder, getLibGroupsHolder, getLibLastTab, libCacheSet, libCacheSetDownloaded, persistGroupsCache, persistHomeCache, setHomeCache, setLibGameHolder, setLibGameOrigin, setLibGroupHolder, setLibGroupsHolder, setLibLastTab, _focusedPlatformSubs, _focusedPlatform, libCacheDelete} from "../libcache";
import { useOffline, useServiceStatus, StaleInfo, _STALE_CHECK_MS, _STALE_RANK, _setStale, _staleInfo, _staleSubs, _clearStale, lastStaleCheck, markStaleChecked} from "../status";
import { _broadcastLibRefresh, _libRefreshListeners } from "../events";
import { ScrubOverlay, letterJump, setLetterJump, setScrubGlimpse, _scrubLetterOf, _scrubTargetIdx, NAV_MAINTAIN_X} from "../scrub";
import { GameDetailPage } from "./game";
import { SettingsPage } from "./settings";
import { StatsPage } from "./stats";
import { CoresPage } from "./cores";
import { BiosPage } from "./bios";
import { DownloadsPage } from "./downloads";
import { PlatformsPage } from "./platforms";
import { _LS_REOPEN_HOME } from "../storage";
import { lastLaunchedRomId } from "../launch";
import { CollectionActionsModal, NAV_ORDER, UserMenuModal, V2NavBar, useNavChrome } from "../topbar";
import { v2Page } from "../focus";
import { _dlActive, runCollectionBatch, useBatchJob } from "../downloads";
import { EmuStalePath, InstallProgressBar, installSize, loadEmulatorStatus, publishEmulatorStatus, startEmulatorInstall, useEmulatorInstall, useEmulatorStatus } from "../emulator";
// The library: home, platforms, collections, search, and the grid underneath.
//
// The root page keeps all four panels mounted and hides the inactive ones
// rather than unmounting them. That is deliberate — a tab switch has to be
// instant on a gamepad, and remounting would re-fetch and re-fade every cover
// each time you page past a tab. It also means their silent-refresh effects do
// not re-run on a switch, which is what the refresh broadcast in events.ts is
// for.

// Search tab — debounced text filter over the whole library, results as a
// cover-art grid (the nav 'Search' destination).
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

// Apply what the check found. This is the expensive half, and the only path
// that reaches it is a person pressing Update.
export async function _applyStaleUpdate(): Promise<boolean> {
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

export async function _maybeCheckStale(svcStatus: any) {
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
  if (now - lastStaleCheck() < _STALE_CHECK_MS) return;
  // Stamped before the await, not after: two visibility flips in quick
  // succession would otherwise both pass the check.
  markStaleChecked();
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

export function SearchPanel({ onOpen, onBg, visible }: { onOpen: (g: LibGame) => void; onBg: (uri: string | null) => void; visible: boolean }) {
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

// Home's first-run state: the real layout with its content greyed out, instead
// of a centred "Loading…". A cold start has no cached lists to seed from, and a
// single line of text on an empty screen gave no sense of what was coming — the
// page then snapped from nothing to a full dashboard. Same row count, header
// sizes, tile widths and paddings as the real CardRows below, so the content
// lands in place rather than pushing a different layout out of the way.
export function HomeSkeleton() {
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

export function EmulatorBanner() {
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

export function HomePanel({ onOpen, onOpenGroup, onBg, visible }:
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
  // Whether the last payload said the first library fetch is still running, so
  // an empty Home can tell "you have no games" apart from "the games haven't
  // arrived yet" — see the empty state. Taken from the library payload itself
  // rather than from the service-status poll: it is the same answer the retry
  // below already keys on, it arrives in the same response as the empty rows it
  // explains, and it cannot be undefined-because-the-poll-hasn't-landed, which
  // is what made the status-derived version fall through to the wrong message.
  const [fetching, setFetching] = useState(false);
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
        setFetching(notReady);
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
        // Straight out of the setup wizard the rows are empty because the first
        // fetch is still running, not because the library is. Saying "no games"
        // there is wrong for the few seconds it lasts — and it's the first thing
        // a new user ever reads. While the backend reports a fetch in flight (or
        // a library that hasn't finished loading), show the skeleton the rest of
        // the app uses for the same wait; the verdict can keep until it's true.
        // `fetching` is exactly the condition the loader above re-polls every 3s,
        // so the skeleton is guaranteed to resolve on its own rather than
        // latching on a state nothing re-fetches out of.
        (!offline && fetching)
          ? <HomeSkeleton />
          : (
            <div style={{ padding: '16px', color: V2.fgMuted, fontSize: '13px' }}>
              {offline
                ? 'No downloaded games yet. Reconnect to browse and download your library.'
                : 'No games in your library yet.'}
            </div>
          )
      )}
    </div>
  );
}

export function GroupsPanel({ mode, visible, onOpenGroup, svcStatus }:
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
    setLetterJump((d: 1 | -1) => jumpRef.current(d));
    // Fast-scroll glimpse: tiles report rapid focus moves here.
    setScrubGlimpse((l: string) => showScrubRef.current(l));
    return () => { setLetterJump(null); setScrubGlimpse(null); };
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
export function StaleLibraryBanner({ status }: { status: any }) {
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

export function OfflineBanner({ status }: { status: any }) {
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

// Another Ludo has the auto-sync lock, so this one is browsing only.
//
// Both shells set app_id "ludo" and therefore share ~/.config/ludo, which is
// deliberate — the AppImage in Desktop Mode and the plugin in Gaming Mode are
// one account, one library, one set of settings. What they cannot share is the
// save watcher: AutoSyncLock hands it to whichever started first, and the other
// simply doesn't sync. Correct, and until now invisible — the UI went on
// looking exactly like a working sync.
//
// Same chrome as OfflineBanner above rather than a new shape: it answers the
// same kind of question ("why isn't my library/saves doing the thing"), so it
// gets the same dot-title-detail row in the same place.
export function SyncBlockedBanner({ status }: { status: any }) {
  if (!status?.sync_blocked) return null;
  const pending = status?.pending_saves || 0;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px',
      margin: '0 16px 8px', padding: '8px 12px',
      background: V2.surface, border: `1px solid ${V2.borderStrong}`,
      borderRadius: V2.radiusMd, fontSize: '12px',
    }}>
      <div style={{
        width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
        background: V2.warning, boxShadow: `0 0 6px ${V2.warning}`,
      }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: V2.fg }}>
          Save sync is running in another Ludo
        </div>
        <div style={{ color: V2.fgMuted, marginTop: '1px' }}>
          {/* Names the fix, not the mechanism. "Close it" is the whole remedy,
              and nothing is lost either way — the other instance is doing the
              syncing, and both read the same library. */}
          Another copy of Ludo is watching your saves — most likely the desktop
          app. Close it and reopen this one to sync from here. Browsing and
          downloading work normally.
        </div>
        {pending > 0 && (
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
export function LibraryRootPage() {
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
          {top === 'platforms' && <PlatformsPage />}
        </div>
      )}
    </>
  );
}

export function LibraryGroupsPage({ covered = false }: { covered?: boolean }) {
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
        letterJump(b === GamepadButton.TRIGGER_RIGHT ? 1 : -1);
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
      <SyncBlockedBanner status={svcStatus} />
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

export function LibraryGamesPage() {
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
    setScrubGlimpse((l: string) => showScrubRef.current(l));
    return () => setScrubGlimpse(null);
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
