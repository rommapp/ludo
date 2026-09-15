import { useEffect, useRef, useState } from "react";
import { applyAppImageUpdate, checkForUpdate, clearRecentActivity, downloadUpdate, deleteOrphanGame, getAccountUsername, getCheckOnStartup, getConfig, getFetchBenchmark, getLibraryAutoUpdate, getLoggingEnabled, getOrphanGames, getPlatformSync, getPluginVersion, getRecentActivity, getResumeStateEnabled, getRetrodeckButtonEnabled, getSteamTileStatus, getUpdateChannel, getVirtualCollectionsVisible, getScreenshotMode, setScreenshotModeRpc, isDebugMode, logout, rebuildLibrary, setCheckOnStartup, setLibraryAutoUpdate, setResumeStateEnabled, setRetrodeckButtonEnabled, setSteamTile, setSyncIndicatorRpc, setUpdateChannel, setVirtualCollectionsVisibleRpc, timeColdFetch, updateLoggingEnabled, getSyncIndicator} from "../rpc";
import { GameActionButton, UpdateActionBtn, V2Button, V2Segment, V2SettingsRow, V2SettingsSection, V2Switch, _gameLabel, V2CardRow} from "../kit";
import { V2, fmtAgo, fmtBytes } from "../theme";
import { FaBookmark, FaBug, FaCameraRetro, FaCheck, FaCheckCircle, FaChevronDown, FaChevronLeft, FaChevronRight, FaCloudUploadAlt, FaDownload, FaExternalLinkAlt, FaGithub, FaHistory, FaInfoCircle, FaLayerGroup, FaPlay, FaRedo, FaStopwatch, FaSync, FaTimes, FaTimesCircle, FaTrash, FaUndo, FaExclamationTriangle, FaSave, FaUser} from "react-icons/fa";
import { Focusable, Navigation, host, toaster } from "@ludo/host";
import { useAutoFocus } from "../shell";
import { _broadcastLibRefresh } from "../events";
import { _LS_REOPEN_HOME, _lsAvail} from "../storage";
import { libBack, libNavigate } from "../nav";
import { V2Focus, v2Page } from "../focus";
import { FoldersSection } from "./setup";
import { _groupsCache, clearBrowseCaches, persistGroupsCache, _setSyncPillPref, _syncPillListeners, syncPillPref} from "../libcache";
import { clearIdentityCache } from "../topbar";
import { _clearStale } from "../status";
import { resetAnnouncementShown } from "../notifications";
import { _resumeStatesPref, _setResumeStatesPref } from "../tiles";
// Settings: the account, the folders, updates, and what the app is allowed to do.
//
// Most of it is capability-gated rather than shell-gated — the Steam-tile row
// and the toast-position row appear because the shell can do those things, not
// because of which shell it is. The update section carries a short-lived cache
// so re-opening the page does not re-hit GitHub on every visit.

// Session cache for update checks: the section auto-checks on open, and this
// keeps reopening Settings from burning GitHub's anonymous rate limit (60/hr).
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

// Cold-fetch timer poll, module-level rather than owned by the Settings page.
// Starting the timer navigates back to the library — watching a settings row
// for two minutes is not the point — so the poll has to outlive that page's
// unmount or the result it was started for would never be reported.
let _benchPoll: any = null;

// Notified when the result lands, so a Settings page that IS open updates its
// row without re-fetching. Also serves as the "in flight" signal for a page
// mounted after the run started.
const _benchListeners = new Set<(b: any) => void>();

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
    if (syncPillPref() === null) {
      getSyncIndicator()
        .then((r) => _setSyncPillPref(r?.enabled !== false))
        .catch(() => _setSyncPillPref(true));
    }
    return () => { _syncPillListeners.delete(listener); };
  }, []);
  return syncPillPref() !== false;
}

// Set while a timed fetch is in flight, so re-entering Settings shows the row
// still busy instead of an idle button that would start a second run.
let _benchRunning = false;

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

// Settings ▸ Recent Activity — a curated feed of what the plugin actually did
// (downloads, collection syncs, save/state sync, account events). Backed by the
// persisted backend activity log (get_recent_activity), so it covers background
// work that happened while no UI was open.
const ACTIVITY_ICONS: Record<string, any> = {
  download: FaDownload, sync: FaSync, save: FaSave, delete: FaTrash,
  account: FaUser, error: FaExclamationTriangle,
};

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

export let _updCheckCache: { t: number; channel: string; info: any } | null = null;

export const _UPD_CACHE_MS = 5 * 60 * 1000;

// Floor on how long a MANUAL update check shows its busy state, so the press
// reads as an action that ran rather than a flicker (see runUpdateCheck).
export const MIN_CHECK_MS = 900;

// Games deleted on the RomM server that still have local data. Shown ONLY
// when there are any — the empty state is the healthy one and a permanent
// empty section would just be noise. Deleting is two presses (arm, then
// confirm), and the backend moves to trash rather than unlinking, so a slip
// is recoverable by hand.
export function RemovedFromRomMSection() {
  const [games, setGames] = useState<any[]>([]);
  const [armed, setArmed] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    getOrphanGames()
      .then(r => setGames(r?.games || []))
      .catch(() => { });
  }, []);

  if (!games.length) return null;

  const doDelete = async (romId: number) => {
    if (armed !== romId) { setArmed(romId); return; }
    setBusy(romId);
    try {
      const r = await deleteOrphanGame(romId);
      if (r?.success) {
        toaster.toast({ title: 'Moved to trash', body: r.trash || '' });
        setGames(gs => gs.filter(g => g.rom_id !== romId));
      } else {
        toaster.toast({ title: 'Could not delete', body: r?.message || '' });
      }
    } catch {
      toaster.toast({ title: 'Could not delete', body: 'The backend did not answer.' });
    }
    setArmed(null);
    setBusy(null);
  };

  return (
    <V2SettingsSection title="Removed from RomM">
      <div style={{
        borderRadius: V2.radiusCard, background: V2.surface,
        border: `1px solid ${V2.border}`, overflow: 'hidden',
      }}>
        <div style={{
          padding: '10px 14px', fontSize: '11px', color: V2.fgMuted,
          borderBottom: `1px solid ${V2.border}`,
        }}>
          Deleted on RomM but still on this device. Deleting removes the game
          files and its saves together — moved to trash, never unlinked.
        </div>
        {games.map((g, i) => (
          <div key={g.rom_id} style={{
            display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 14px',
            borderTop: i > 0 ? `1px solid ${V2.border}` : 'none',
          }}>
            <div style={{ flexShrink: 0, color: V2.fgFaint, display: 'flex' }}>
              <FaTrash size={13} />
            </div>
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <div style={{
                fontSize: '12px', fontWeight: 600, color: V2.fg,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{_gameLabel(g.name)}</div>
              <div style={{ fontSize: '11px', color: V2.fgMuted }}>
                {g.platform || 'Unknown platform'}
                {g.local_size ? ` · ${fmtBytes(g.local_size)}` : ''}
              </div>
            </div>
            <Focusable>
              <V2Button
                variant={armed === g.rom_id ? 'danger' : 'tonal'}
                onClick={() => busy === null && doDelete(g.rom_id)}
              >
                {busy === g.rom_id ? 'Deleting…'
                  : armed === g.rom_id ? 'Press again to confirm' : 'Delete'}
              </V2Button>
            </Focusable>
          </div>
        ))}
      </div>
    </V2SettingsSection>
  );
}

export function RecentActivitySection() {
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

export function SettingsPage() {
  const [loggingEnabled, setLoggingEnabled] = useState<boolean>(_settingsToggles.logging ?? true);
  const [debugMode, setDebugMode] = useState<boolean>(_settingsToggles.debug ?? false);
  const [screenshotMode, setScreenshotMode] = useState<boolean>(_settingsToggles.screenshotMode ?? false);
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

  // Screenshot mode. Every browse list AND the account pill's identity are
  // served by the backend but cached on this side, so flipping the switch has
  // to drop both — otherwise the hidden platforms and the real username keep
  // painting from localStorage until something else refetches.
  const handleScreenshotModeToggle = async (enabled: boolean) => {
    setScreenshotMode(enabled);
    try {
      const r = await setScreenshotModeRpc(enabled);
      if (r && r.success === false) throw new Error(r.message || 'failed');
      _rememberSettingsToggle('screenshotMode', enabled);
      clearBrowseCaches();
      clearIdentityCache();
      // …and tell a mounted top bar to re-read it; its identity fetch runs once
      // on mount, so without this the real name stays on screen until a remount.
      try { window.dispatchEvent(new Event('romm:identity')); } catch { /* ignore */ }
      _broadcastLibRefresh();
    } catch {
      setScreenshotMode(!enabled);
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
          if (dbg) {
            const hn = await getScreenshotMode();
            setScreenshotMode(!!hn?.enabled);
            _rememberSettingsToggle('screenshotMode', !!hn?.enabled);
          }
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
        const dl = await downloadUpdate(updateInfo.url, updateInfo.asset_name);
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
        // The loader downloads the URL with its own (absent) credentials, so
        // it can't fetch an asset that needs our release token. Fall through to
        // the manual route below, which downloads through OUR backend.
        if (!updateInfo.loader_url) throw new Error('asset requires authentication');

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
          updateInfo.loader_url,
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
      const dl = await downloadUpdate(updateInfo.url, updateInfo.asset_name);
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
        resetAnnouncementShown();
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

      <RemovedFromRomMSection />

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
              You’ll return to the setup wizard either way. Deleting also removes
              local saves and savestates — anything not already synced to RomM is gone.
            </div>
            <GameActionButton icon={<FaUndo size={14} />} label={loggingOut ? 'Logging out…' : 'Log out (keep downloads)'}
              focusRef={logoutFirstRef} onClick={() => handleLogout(false)} disabled={loggingOut} />
            <GameActionButton icon={<FaTrash size={14} />} label={loggingOut ? 'Logging out…' : 'Log out & delete downloads and saves'}
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
        {debugMode && <V2SettingsRow
          icon={<FaCameraRetro size={16} />}
          title="Screenshot mode"
          subtitle="Hides Nintendo platforms, games and collections, and shows the account as \u201CUser\u201D with the default avatar. Nothing is renamed, unsynced or deleted."
          onClick={() => handleScreenshotModeToggle(!screenshotMode)}
          right={<V2Switch checked={screenshotMode} />}
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
              { icon: <FaGithub size={13} />, label: 'GitHub', url: 'https://github.com/rommapp/ludo' },
              { icon: <FaBug size={13} />, label: 'Report Issue', url: 'https://github.com/rommapp/ludo/issues' },
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

// RomSwitch — React port of RomM's frontend/src/v2/lib/forms/RSwitch/RSwitch.vue.
// An iOS-style 36×20px track with a 14px knob that slides on toggle, with the
// brand-purple background, inner sheen, outer glow, spring easing and active
// press squash that define the RomM v2 toggle's feel.
export function RomSwitch({ checked, onChange, disabled, label, description }:
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
