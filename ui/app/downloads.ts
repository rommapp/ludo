// Downloads, as a module-level registry rather than page state.
//
// The same game can be on screen in three places at once — its grid tile, the
// detail page, the Downloads list — and all three have to show the one
// download. Page-local useState cannot do that, and worse, it dies on unmount:
// leaving a syncing collection used to lose the header progress even though the
// batch was still running. So the truth lives here, in module scope, and every
// surface subscribes to _dlListeners.

import { createElement, useState, useEffect } from "react";
import { ToastCover } from "./kit";
import { toaster } from "./toast";
import { cancelDownloadRpc, downloadGame, getDownloads } from "./rpc";
import { watchTopic } from "./push";
import { libCacheFindGame } from "./libcache";
import { _broadcastLibRefresh, _broadcastDownloaded } from "./events";

// A single library grid card: art-only with a centered, single-line label
// underneath (RomM's GameCard language). Focus/hover scales the art and paints
// the brand glow; activating it opens the game; gaining focus feeds the cover
// to the page's background art. When `game.screenshot` is set (continue-playing
// rail), the art is a landscape screenshot with the box-art floated as a PIP,
// matching RomM's Home — otherwise it's the portrait cover.
// ── Live progress: one store, one poller ─────────────────────────────────────
//
// A download in flight is on screen in several places at once (cover ring,
// detail-page button, top-bar ring, Downloads row, collection header) and each
// used to poll get_download_progress on its own clock, 350-600ms apart: several
// calls per game per tick, and views that disagreed by a few percent and
// finished a beat apart. Now one poller reads every download in one call while
// anyone is watching, and every view reads the same snapshot. Phase changes
// (start, extracting, done, error) also arrive as the backend's 'downloads'
// nudge, so they land the moment they happen rather than at the next tick.
const PROGRESS_MS = 250;
const _prog = new Map<number, any>();
const _progListeners = new Set<() => void>();
let _progWatchers = 0;
let _progTimer: ReturnType<typeof setInterval> | null = null;
let _progStopNudge: (() => void) | null = null;
let _progInFlight: Promise<void> | null = null;

/** Fetch every tracked download now and notify subscribers. Concurrent calls share one fetch. */
export function refreshProgress(): Promise<void> {
  if (_progInFlight) return _progInFlight;
  _progInFlight = (async () => {
    try {
      const all = await getDownloads();
      _prog.clear();
      for (const [k, v] of Object.entries(all || {})) _prog.set(Number(k), v);
      _progListeners.forEach((l) => { try { l(); } catch { /* one view's bug isn't the rest's */ } });
    } catch { /* transient: next tick */ }
    finally { _progInFlight = null; }
  })();
  return _progInFlight;
}

/** Latest backend entry for a game, or undefined when nothing is tracked for it. */
export const progressOf = (romId: number): any => _prog.get(romId);

/** Keep the shared poller running while the caller needs live progress. Returns release. */
export function watchProgress(): () => void {
  if (_progWatchers++ === 0) {
    refreshProgress();
    _progTimer = setInterval(refreshProgress, PROGRESS_MS);
    // Fast fallback is the same 250ms: nothing to gain from waiting longer.
    _progStopNudge = watchTopic('downloads', refreshProgress, 60000, 60000);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--_progWatchers === 0) {
      if (_progTimer) clearInterval(_progTimer);
      _progTimer = null;
      _progStopNudge?.(); _progStopNudge = null;
    }
  };
}

/** Subscribe to every progress snapshot. Returns unsubscribe. */
export function onProgress(fn: () => void): () => void {
  _progListeners.add(fn);
  return () => { _progListeners.delete(fn); };
}

// Downloads this UI didn't start — an install requested from RomM's web UI —
// are shown exactly like one started here: entered in the registry while they
// run (cover ring, detail-page progress, top-bar ring, Downloads row), marked
// installed when they land. Their start and end arrive as 'downloads' nudges.
// The backend raises the toast, since nobody here asked for it.
const _lastState = new Map<number, string>();
const _bgOwned = new Set<number>();
let _bgInstallsWatched = false;
export function watchBackgroundInstalls() {
  if (_bgInstallsWatched) return;
  _bgInstallsWatched = true;
  let baseline = true;
  onProgress(() => {
    for (const [id, p] of _prog) {
      const st = p?.state, was = _lastState.get(id);
      _lastState.set(id, st);
      if (baseline && st !== 'downloading' && st !== 'extracting') continue;
      const running = st === 'downloading' || st === 'extracting' || st === 'preparing';
      if (running && !_dlActive.has(id)) {
        _bgOwned.add(id);
        _setDlActive(id, true, libCacheFindGame(id)?.name);
      } else if (!running && _bgOwned.has(id)) {
        _bgOwned.delete(id);
        if (st === 'done' && was !== 'done') {
          _dlSucceeded.add(id);
          _broadcastDownloaded(id, true);
        }
        _setDlActive(id, false);
      }
    }
    baseline = false;
  });
  watchTopic('downloads', refreshProgress, 60000, 60000);
  refreshProgress();
}

const _nextSnapshot = () => new Promise<void>((r) => { const off = onProgress(() => { off(); r(); }); });

// Polls get_download_progress until the background download reaches a terminal
// state, resolving with the outcome. The download itself is kicked off by
// download_game (which returns immediately); this drives completion + the toast.
//
// A finished download can still carry a warning: the files arrived, but the
// game or an add-on could not be decompressed. That toast is raised here, once,
// for every caller -- batch downloads included -- and `warning` tells the
// callers that show their own "Downloaded" toast to leave it out.
//
// A cancelled download is reported once here too, so callers only need to
// leave their failure toast out when `cancelled` is set.
export async function awaitDownload(romId: number): Promise<{ ok: boolean; message?: string; removed?: boolean; warning?: boolean; cancelled?: boolean }> {
  const release = watchProgress();
  try {
    await refreshProgress();
    return await _awaitTerminal(romId);
  } finally { release(); }
}

async function _awaitTerminal(romId: number): Promise<{ ok: boolean; message?: string; removed?: boolean; warning?: boolean; cancelled?: boolean }> {
  for (; ;) {
    const p: any = progressOf(romId) ?? { state: 'idle' };
    if (p?.state === 'done') {
      if (!p.warning) return { ok: true };
      toaster.toast({ title: p.warning.title, body: p.warning.body, duration: 10000 });
      return { ok: true, warning: true };
    }
    // `removed` means the backend confirmed with the server that this ROM is
    // gone and dropped it from the library. A different outcome from a failed
    // download, and it needs different words: nothing went wrong, the game
    // isn't there any more.
    if (p?.state === 'error') return { ok: false, message: p.message, removed: !!p.removed };
    if (p?.state === 'cancelled') {
      // hasCover true: a game without art just fails the fetch and shows no logo.
      toaster.toast({ title: 'Download cancelled', body: _dlNames.get(romId) || '',
        logo: createElement(ToastCover, { romId, hasCover: true }) });
      return { ok: false, cancelled: true };
    }
    if (p?.state === 'idle') return { ok: false, message: 'Download did not start' };
    await _nextSnapshot();
  }
}

// Global registry of in-flight downloads (by rom_id) so EVERY surface showing a
// game (its cover tile + its details page) reflects the download — not just the
// one whose button was clicked. doDownload toggles membership; surfaces subscribe.
export const _dlActive = new Set<number>();

// Display names for the registry (keyed by rom_id) so the account menu's
// Downloads section can label each in-flight download.
export const _dlNames = new Map<number, string>();

// Batch items waiting for a worker slot (rom_id → name) — shown as "Queued" on
// the Downloads page. Seeded by downloadBatch, drained as each download starts.
export const _dlQueue = new Map<number, string>();

// Queued items the user removed; downloadBatch's workers skip them.
const _dlDequeued = new Set<number>();

/** Stop an active download. The outcome (and its toast) comes back through awaitDownload. */
export async function cancelDownload(romId: number): Promise<void> {
  try { await cancelDownloadRpc(romId); } catch { /* the poll reports the real state */ }
}

// Downloads being started: between the press and _setDlActive there is an
// await (the Switch firmware check), and every press landing in it used to
// start the same download again — each then waited on it and toasted its end.
const _dlStarting = new Set<number>();

/** Claim the start of a download; false if it is already starting or running. */
export function claimDownloadStart(romId: number): boolean {
  if (_dlStarting.has(romId) || _dlActive.has(romId)) return false;
  _dlStarting.add(romId);
  return true;
}

/** Mark a download as started (or abandoned): _dlActive takes over from here. */
export function releaseDownloadStart(romId: number) { _dlStarting.delete(romId); }

/** Take a game out of the batch queue before it starts. */
export function dequeueDownload(romId: number) {
  if (!_dlQueue.delete(romId)) return;
  _dlDequeued.add(romId);
  _notifyDl();
}

// Roms whose download completed successfully this session, so a mounted tile
// can light its downloaded dot the moment its global download finishes (the
// games-list prop only updates on the next refetch).
export const _dlSucceeded = new Set<number>();

export const _dlListeners = new Set<() => void>();

export function _notifyDl() { _dlListeners.forEach((l) => { try { l(); } catch { } }); }

export function _setDlActive(romId: number, on: boolean, name?: string) {
  if (on) { _dlActive.add(romId); if (name) _dlNames.set(romId, name); }
  else { _dlActive.delete(romId); _dlNames.delete(romId); }
  _notifyDl();
}

// Downloads one game through the same path as the tile button: registers it in
// the global registry (so its cover tile shows the ring), kicks off the backend
/**
 * Asked once before each download starts, if anything installed it.
 *
 * A Switch rom needs firmware and keys on the device before it will boot, and
 * the user is asked about that with a modal — which is a page's job, not this
 * module's. So the gate is registered from above rather than called from here;
 * this file must not import the page tree (see events.ts for the same rule
 * applied to the other direction). Nothing registered means nothing to ask.
 */
let _preDownload: ((romId: number) => Promise<void>) | null = null;

/**
 * Install the pre-download gate. A function rather than the binding itself
 * because an imported `let` is read-only at the importing end — the assignment
 * has to happen on this side.
 */
export function setPreDownloadHook(fn: ((romId: number) => Promise<void>) | null) {
  _preDownload = fn;
}

// download, then polls to completion. Returns whether it succeeded.
export async function downloadOne(romId: number, name?: string): Promise<boolean> {
  if (_dlActive.has(romId)) { // already downloading elsewhere — just wait it out
    return (await awaitDownload(romId)).ok;
  }
  // Gate first, THEN mark active. The other way round painted the tile as
  // downloading while the firmware confirm was still on screen — the button
  // said the transfer had begun before the user had answered whether it should.
  if (_preDownload) await _preDownload(romId);
  _setDlActive(romId, true, name);
  try {
    const start = await downloadGame(romId);
    if (!start?.success) return false;
    const ok = (await awaitDownload(romId)).ok;
    if (ok) {
      // Reflect the new local copy everywhere immediately: cached group lists
      // (so a remounted grid seeds correct dots) and mounted tiles (via
      // _dlSucceeded + the registry notification from _setDlActive below).
      _dlSucceeded.add(romId);
      _broadcastDownloaded(romId, true);
    }
    return ok;
  } catch { return false; }
  finally { _setDlActive(romId, false); }
}

// Runs a batch of downloads with bounded concurrency, reporting progress after
// each one finishes. Returns the count that succeeded.
export async function downloadBatch(
  items: { id: number; name: string }[], concurrency: number, onProgress: (done: number, ok: number) => void,
): Promise<number> {
  for (const it of items) if (!_dlActive.has(it.id)) _dlQueue.set(it.id, it.name);
  _notifyDl();
  let done = 0, ok = 0, i = 0;
  const worker = async () => {
    while (i < items.length) {
      const it = items[i++];
      if (_dlDequeued.delete(it.id)) { done++; onProgress(done, ok); continue; }
      _dlQueue.delete(it.id); _notifyDl();
      if (await downloadOne(it.id, it.name)) ok++;
      done++;
      onProgress(done, ok);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  } finally {
    for (const it of items) { _dlQueue.delete(it.id); _dlDequeued.delete(it.id); }
    _notifyDl();
  }
  return ok;
}

// One-shot collection batch with MODULE-level job state, keyed by the group's
// cache key. The old per-page useState died on unmount, so leaving a syncing
// collection and coming back lost the header progress even though the batch
// kept running — this survives, and useBatchJob re-attaches any remount.
export interface BatchJob { done: number; ok: number; total: number; ids: number[]; }

export const _batchJobs = new Map<string, BatchJob>();

export function useBatchJob(key: string | null): BatchJob | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    _dlListeners.add(l);
    return () => { _dlListeners.delete(l); };
  }, []);
  return key ? (_batchJobs.get(key) || null) : null;
}

// `onOpen` (optional) makes this batch's toasts clickable — it should navigate
// to the collection the batch belongs to. Passed in rather than derived from
// jobKey because only the caller knows the mode and the sibling groups the
// grid header pages through.
export async function runCollectionBatch(jobKey: string, items: { id: number; name: string }[], onOpen?: () => void): Promise<void> {
  if (_batchJobs.has(jobKey) || items.length === 0) return;
  _batchJobs.set(jobKey, { done: 0, ok: 0, total: items.length, ids: items.map((i) => i.id) });
  _notifyDl();
  toaster.toast({ title: 'Syncing collection', body: `Downloading ${items.length} game${items.length === 1 ? '' : 's'}`, onClick: onOpen });
  let ok = 0;
  try {
    ok = await downloadBatch(items, 3, (done, okN) => {
      const j = _batchJobs.get(jobKey);
      if (j) { j.done = done; j.ok = okN; _notifyDl(); }
    });
  } finally {
    _batchJobs.delete(jobKey); _notifyDl();
  }
  toaster.toast({ title: 'Sync complete', body: `${ok} of ${items.length} downloaded`, onClick: onOpen });
  // Any mounted grid refetches its list so downloaded dots reflect the batch
  // even if the page that started it was unmounted meanwhile.
  _broadcastLibRefresh();
}

// Snapshot of every in-flight download (frontend-initiated), for the account
// menu's Downloads section. Re-renders on registry changes.
export function useActiveDownloads(): { romId: number; name: string }[] {
  const snap = () => Array.from(_dlActive).map((id) => ({ romId: id, name: _dlNames.get(id) || `ROM ${id}` }));
  const [v, setV] = useState(snap);
  useEffect(() => {
    const l = () => setV(snap());
    _dlListeners.add(l); l();
    return () => { _dlListeners.delete(l); };
  }, []);
  return v;
}

// Batch items still waiting for a worker slot, for the Downloads page's Queued list.
export function useQueuedDownloads(): { romId: number; name: string }[] {
  const snap = () => Array.from(_dlQueue, ([id, name]) => ({ romId: id, name }));
  const [v, setV] = useState(snap);
  useEffect(() => {
    const l = () => setV(snap());
    _dlListeners.add(l); l();
    return () => { _dlListeners.delete(l); };
  }, []);
  return v;
}

export function useIsDownloading(romId: number): boolean {
  const [v, setV] = useState(_dlActive.has(romId));
  useEffect(() => {
    const l = () => setV(_dlActive.has(romId));
    _dlListeners.add(l); l();
    return () => { _dlListeners.delete(l); };
  }, [romId]);
  return v;
}

// Polls the backend for a game's live download progress (0..100) while a download
// is in flight, returning null when idle. Drives the cover download-ring and the
// GameDetails button fill. Activates on either the local `active` flag or the
// global registry, so progress is shared across the cover tile and details page.
// `message` names the phase when it is not the game's own download -- an
// add-on fetched with it, or a Switch file being decompressed -- and `detail`
// says why, for the Downloads row. Both are absent for a plain download.
export interface DlProgress { percent: number; exact?: number; speed: number; eta: number; downloaded: number; total: number; state?: string; message?: string; detail?: string; }

export function useDownloadProgress(romId: number, active: boolean): DlProgress | null {
  const globalActive = useIsDownloading(romId);
  const on = active || globalActive;
  const [prog, setProg] = useState<DlProgress | null>(null);
  useEffect(() => {
    if (!on) { setProg(null); return; }
    const read = () => {
      const p = progressOf(romId);
      if (!p || typeof p.percent !== 'number') return;
      const exact = typeof p.exact === 'number' ? p.exact : p.percent;
      setProg((prev) => {
        // Same snapshot for this game: keep the object so the view doesn't re-render.
        if (prev && prev.exact === exact && prev.state === p.state && prev.message === (p.message || undefined)
          && prev.speed === (p.speed || 0)) return prev;
        return {
          // Shown as a whole number, floored so it never reads 100% before it's done.
          percent: Math.floor(exact), exact,
          speed: p.speed || 0, eta: p.eta || 0, downloaded: p.downloaded || 0, total: p.total || 0,
          state: p.state, message: p.message || undefined, detail: p.detail || undefined,
        };
      });
    };
    read();
    const off = onProgress(read);
    const release = watchProgress();
    return () => { off(); release(); };
  }, [romId, on]);
  return prog;
}
