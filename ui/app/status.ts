// One poller, and everything that reads from it.
//
// get_service_status is the app's heartbeat: connection state, the collection
// syncs in flight, the offline flag, the pending-upload count. Every surface
// that shows any of it used to poll for itself, which on the library page meant
// several timers asking the same question on their own schedules. There is one
// timer here instead, reference-counted so it stops when the last subscriber
// unmounts, and the hooks below are views onto its result.

import { useState, useEffect, useRef} from "react";
import { getServiceStatus, getDownloadProgress, getPendingUploads} from "./rpc";
import { _dlActive, _dlListeners, _dlQueue } from "./downloads";

// Shared per-collection sync state, polled ONCE for the whole grid (not one poll
// per tile) from get_service_status, broadcast to every CollectionTile. Lets the
// tiles show the same download ring as game covers while a collection syncs.
export interface ColSyncState { state: string; pct: number | null; downloaded?: number; total?: number; }

export const _colSync = new Map<string, ColSyncState>();

export const _colSyncListeners = new Set<() => void>();

export let _colSyncTimer: any = null;

export let _colSyncRefs = 0;

// Latest connection state from the shared poll ('online'|'offline_cached'|
// 'disconnected'|'connecting'), so tiles can disable server-only actions (e.g.
// download) without each one polling get_service_status independently.
export let _connState: string | null = null;

// Last full status object from the shared poll, so components can read
// connection/snapshot_fetched_at/pending_saves without their own poller.
export let _lastStatus: any = null;
// ── Live save-sync indicator ────────────────────────────────────────────────
// Closing a game used to say nothing at all about the save on its way to RomM:
// the only feedback was the completion toast, which arrives after the moment
// you were worried about. `save_activity` rides the shared status poll above,
// so this whole feature costs no poller of its own.
//
// Two states, and the first is the important one. A save that has just changed
// waits out the engine's settle delay before a single byte moves, so an
// indicator that lit up only for real HTTP would stay dark for most of the
// window it exists for.
export type SaveActivity = {
  active: boolean;
  state: 'queued' | 'uploading' | null;
  game: string | null;
  rom_id: number | null;
  games: number;
};

// Kept in its own tiny store rather than read off useServiceStatus, because a
// library grid mounts one subscriber PER TILE: going through the full status
// object would re-render every visible cover on every 1.5s poll, forever, to
// deliver a value that changes a few times a day. This fires only when the
// activity actually changes.
export let _saveActivity: SaveActivity | null = null;

export const _saveActivityListeners = new Set<() => void>();

export function _pushSaveActivity(a: any) {
  const next: SaveActivity | null = a && a.active ? a as SaveActivity : null;
  const same = (!next && !_saveActivity)
    || (!!next && !!_saveActivity
        && next.state === _saveActivity.state
        && next.rom_id === _saveActivity.rom_id
        && next.game === _saveActivity.game
        && next.games === _saveActivity.games);
  if (same) return;
  _saveActivity = next;
  _saveActivityListeners.forEach((l) => { try { l(); } catch { } });
}

export function useSaveActivity(): SaveActivity | null {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    _saveActivityListeners.add(listener);
    return () => { _saveActivityListeners.delete(listener); };
  }, []);
  // The store is filled by the shared status poll, which needs at least one
  // subscriber to be running — the tiles that use this are always on a screen
  // that has other status consumers, but a lone subscriber must still tick.
  useEffect(() => _subscribeStatus(() => { }), []);
  return _saveActivity;
}


export async function _colSyncTick() {
  try {
    const st = await getServiceStatus();
    _lastStatus = st ?? null;
    _connState = st?.connection ?? null;
    _pushSaveActivity(st?.save_activity);
    _colSync.clear();
    for (const c of (st?.collections || [])) {
      // `key` is the sync key — name for regular collections, base64 id for
      // virtual ones — matching what tiles pass to the sync toggle.
      _colSync.set(c.key ?? c.name, {
        state: c.sync_state,
        pct: typeof c.downloaded_pct === 'number' ? c.downloaded_pct : null,
        downloaded: c.downloaded, total: c.total,
      });
    }
    _colSyncListeners.forEach((l) => { try { l(); } catch { } });
  } catch { /* transient */ }
}

// Subscribe a component to the shared status poll, starting/stopping the timer
// via the shared ref count. Returns the unsubscribe cleanup.
export function _subscribeStatus(listener: () => void): () => void {
  _colSyncListeners.add(listener);
  _colSyncRefs++;
  if (!_colSyncTimer) { _colSyncTick(); _colSyncTimer = setInterval(_colSyncTick, 1500); }
  return () => {
    _colSyncListeners.delete(listener);
    _colSyncRefs--;
    if (_colSyncRefs <= 0 && _colSyncTimer) { clearInterval(_colSyncTimer); _colSyncTimer = null; }
  };
}

// Force an immediate poll outside the 1.5s cadence — used when the device's
// network state flips so the UI reflects it without waiting for the next tick.
export function refreshStatusNow() { _colSyncTick(); }

export function useCollectionSync(name: string): ColSyncState | undefined {
  const [, force] = useState(0);
  useEffect(() => _subscribeStatus(() => force((n) => n + 1)), []);
  return _colSync.get(name);
}

// True when the server isn't reachable (cached-offline or disconnected) — used
// by tiles to dim/disable download actions that would just fail offline.
export function useOffline(): boolean {
  const [, force] = useState(0);
  useEffect(() => _subscribeStatus(() => force((n) => n + 1)), []);
  return _connState === 'offline_cached' || _connState === 'disconnected';
}

// Full service status from the shared poll (one poller for the whole UI).
export function useServiceStatus(): any {
  const [, force] = useState(0);
  useEffect(() => _subscribeStatus(() => force((n) => n + 1)), []);
  return _lastStatus;
}

export interface PendingUpload {
  game: string;
  type: 'saves' | 'states';
  emulator?: string | null;
  modified: number;
  files: { name: string; path: string; modified: number; size: number }[];
}

// The itemized upload queue for the Downloads page: local saves/states waiting
// to push on reconnect. Backed by get_pending_uploads (which groups by game,
// same drift test as the pending_saves count). Read-only — the sync engine
// flushes these automatically on connect; this only surfaces WHAT is waiting.
// Polls slowly, and only while there's actually something pending (the offline
// banner's pending_saves count tells us when to look), so an online, idle Deck
// never hits the backend for this.
export function usePendingUploads(pendingCount: number): PendingUpload[] {
  const [items, setItems] = useState<PendingUpload[]>([]);
  useEffect(() => {
    if (!pendingCount) { setItems([]); return; }
    let alive = true;
    const load = async () => {
      try {
        const res = await getPendingUploads();
        if (alive && Array.isArray(res)) setItems(res as PendingUpload[]);
      } catch { /* transient */ }
    };
    load();
    const iv = setInterval(load, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, [pendingCount]);
  return items;
}

// Lightweight aggregate for the top-bar glimpse (the user pill's avatar ring):
// how many downloads are running (per-game registry + backend collection
// auto-sync passes) and their mean percent. Polls only while something is active.
export function useDownloadGlimpse(): { count: number; pct: number | null } {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    _dlListeners.add(l);
    const unsub = _subscribeStatus(l);
    return () => { _dlListeners.delete(l); unsub(); };
  }, []);
  const syncingCount = ((_lastStatus?.collections || []) as any[])
    .filter((c) => c.sync_state === 'syncing').length;
  // Queued batch items count toward the badge (total outstanding work); the
  // ring percent stays the mean of what's actually transferring.
  const count = _dlActive.size + _dlQueue.size + syncingCount;
  const [pct, setPct] = useState<number | null>(null);
  // Session ledger: every rom seen active/queued since the last idle moment.
  // Overall percent = (finished units + in-flight fractions) / all units, so a
  // download finishing contributes exactly 1.0 with no jump at the boundary
  // (the old per-active mean lurched when an item entered or left the set).
  // The value only drops when new work is genuinely added.
  const seenIds = useRef(new Set<number>());
  const on = count > 0;
  useEffect(() => {
    if (!on) { seenIds.current.clear(); setPct(null); return; }
    let alive = true;
    const tick = async () => {
      for (const id of _dlActive) seenIds.current.add(id);
      for (const id of _dlQueue.keys()) seenIds.current.add(id);
      let units = seenIds.current.size, done = 0;
      for (const id of seenIds.current) {
        if (!_dlActive.has(id) && !_dlQueue.has(id)) done += 1; // finished (or failed) unit
      }
      await Promise.all(Array.from(_dlActive).map(async (id) => {
        try {
          const p = await getDownloadProgress(id);
          if (typeof p?.percent === 'number') done += p.percent / 100;
        } catch { /* transient */ }
      }));
      for (const c of ((_lastStatus?.collections || []) as any[])) {
        if (c.sync_state === 'syncing' && typeof c.downloaded_pct === 'number') {
          units += 1; done += c.downloaded_pct / 100;
        }
      }
      if (alive) setPct(units > 0 ? Math.min(100, (done / units) * 100) : null);
    };
    tick();
    const iv = setInterval(tick, 600);
    return () => { alive = false; clearInterval(iv); };
  }, [on]);
  return { count, pct: on ? pct : null };
}

// ── Library staleness ───────────────────────────────────────────────────────
//
// Whether what is on disk still matches the server. Checked on a long interval
// rather than polled, because the answer only changes when someone adds or
// removes roms on the RomM side.

// Every stale path now earns a Home banner. That was once saves-only, on the
// grounds that only saves fail silently — but staleness itself was then loose
// enough to flag a ROM folder that worked fine, and interrupting for a
// non-problem is what the restraint was really guarding against. With that false
// positive gone (see stale_emulator_paths), the survivors all genuinely break
// the app: saves lose progress, BIOS blocks the games that need it, and a dead
// executable override stops launching altogether.
// Headline and detail per kind, worst first. Saves lead when several are broken:
// it's the only one that loses data you can't recreate.
export const _STALE_RANK: Record<string, number> = { saves: 0, exe: 1, bios: 2, roms: 3 };

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
export const _STALE_CHECK_MS = 15 * 60 * 1000;

let _lastStaleCheck = 0;

/** When the staleness check last ran, and a way to say it just did. */
export function lastStaleCheck(): number { return _lastStaleCheck; }
export function markStaleChecked() { _lastStaleCheck = Date.now(); }

export type StaleInfo = { added: number; removed: number; platforms: string[] };

export let _staleInfo: StaleInfo | null = null;

export const _staleSubs = new Set<(s: StaleInfo | null) => void>();

export function _setStale(s: StaleInfo | null) {
  _staleInfo = s;
  _staleSubs.forEach((fn) => { try { fn(s); } catch { /* ignore */ } });
}

// Any path that brings the library back in step retires the banner and restarts
// the interval — a manual refresh resolves it just as the banner's own button
// does, and one left on screen after the fact reads as a failure.
export function _clearStale() { _setStale(null); markStaleChecked(); }
