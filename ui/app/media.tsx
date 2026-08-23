// Art: fetching it, caching it, and the four components that draw it.
//
// Every cover, screenshot and platform icon arrives base64 over RPC, one at a
// time — the backend serves images serially. A home page mounts dozens of tiles
// at once, so the queue in here is what keeps that from becoming dozens of
// parallel requests that starve each other and arrive in the wrong order.
//
// Batching is the other half of it: everything enqueued in one tick shares a
// batch number, so tiles from one render land together and keep their DOM
// order, while a later render — a scroll, a focus jump, a new page — outranks
// whatever is still waiting from before it.

import { useState, useEffect } from "react";
import { V2 } from "./theme";
import { _lsAvail } from "./storage";
import { getImage, getGameCover } from "./rpc";

// Shared image-fetch queue. The home page mounts dozens of tiles at once, each
// of which needs a base64 cover / screenshot / platform-icon over RPC. Firing
// them all in parallel slams the backend (it serves one image at a time) and
// stalls the whole grid. Instead we funnel every image RPC through a small
// concurrency-limited queue so tiles fill in progressively, FIFO (≈ left to
// right / top to bottom) — the same one-at-a-time backbone the Save Data page
// uses for its state screenshots.
// Generous: a cold cache means a real RomM download + downscale per cover, and
// a slot released too eagerly would double-fetch rather than wait.
export const IMAGE_RPC_TIMEOUT_MS = 30_000;

// Newer batches are served BEFORE older ones (see currentBatch): a focus jump
// down a long grid used to queue its 30 on-screen tiles behind every cover
// still pending from where the user came from, so the screen they're looking
// at filled last. Within a batch it stays FIFO — the ≈left-to-right fill.
export function makeImageQueue(concurrency: number) {
  let active = 0;
  let seq = 0;
  const pending: Array<{ batch: number; seq: number; run: () => void }> = [];
  const takeNext = () => {
    let best = 0;
    for (let i = 1; i < pending.length; i++) {
      const p = pending[i], b = pending[best];
      if (p.batch > b.batch || (p.batch === b.batch && p.seq < b.seq)) best = i;
    }
    return pending.splice(best, 1)[0];
  };
  const pump = () => {
    while (active < concurrency && pending.length) {
      active++;
      try {
        takeNext().run();
      } catch {
        // A job that throws synchronously must not take its slot to the grave —
        // three of those and the queue is wedged for the rest of the session
        // with every remaining tile stuck on its placeholder forever.
        active--;
      }
    }
  };
  return function enqueue<T>(job: () => Promise<T>, batch = currentBatch()): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      pending.push({
        batch, seq: seq++,
        run: () => {
          // Watchdog. A slot is only ever freed by the job settling, so an RPC
          // whose reply never arrives — the backend restarting mid-flight drops
          // in-flight replies, and the plugin backend does restart under us —
          // would hold its slot permanently. Observed as: a handful of images
          // paint, then nothing loads until the page is remounted. Releasing
          // the slot lets the queue drain; the rejection reaches awaitCover,
          // which leaves the result uncached so the tile's own retry refetches.
          let settled = false;
          const release = () => {
            if (settled) return;
            settled = true;
            active--;
            pump();
          };
          const timer = setTimeout(() => {
            if (settled) return;
            reject(new Error('image rpc timeout'));
            release();
          }, IMAGE_RPC_TIMEOUT_MS);
          job().then(resolve, reject).finally(() => { clearTimeout(timer); release(); });
        },
      });
      pump();
    });
  };
}

// Everything enqueued in one tick shares a batch number. Tiles mounted by the
// same render land together (so they keep their DOM order) while a later
// render — a scroll, a focus jump, a new page — outranks whatever is still
// waiting from before it.
export let _batch = 0;

export let _batchScheduled = false;

export function currentBatch(): number {
  if (!_batchScheduled) {
    _batchScheduled = true;
    setTimeout(() => { _batch++; _batchScheduled = false; }, 0);
  }
  return _batch;
}

export const imageQueue = makeImageQueue(3);

export const qGetImage = (path: string) => imageQueue(() => getImage(path));

export const qGetGameCover = (romId: number, large: boolean) => imageQueue(() => getGameCover(romId, large));

// Resolved platform-icon cache: platformKey -> data URI (or null = no icon).
// Persisted to localStorage because there are only ~dozens of tiny icons and
// they're the same every session — so they paint instantly even after a reload
// instead of compositing in one-by-one on the Platforms tab.
export const _platIconCache = new Map<string, string | null>();

export const _LS_PLATICON = 'romm:platicons:v1';

export function _platIconCacheSet(key: string, uri: string | null) {
  _platIconCache.set(key, uri);
  if (!_lsAvail) return;
  try {
    const obj: Record<string, string | null> = {};
    _platIconCache.forEach((v, k) => { obj[k] = v; });
    localStorage.setItem(_LS_PLATICON, JSON.stringify(obj));
  } catch { }
}

// Decoded-art cache (data URIs) so covers persist across tile remounts and can be
// prefetched for neighbouring groups — the grid then slides in fully painted
// instead of popping each cover in as its base64 fetch lands.
// Keys: `cover:${romId}:${large}` for ROM covers, `img:${path}` for screenshots.
export const _coverCache = new Map<string, string | null>();   // resolved results only

export const _coverInflight = new Map<string, Promise<string | null>>(); // dedup in-flight
// LRU bound. This map used to grow without limit, and it is the one structure
// that outlives the tiles: leaving a group unmounts its grid, but every cover
// it painted stayed pinned here for the rest of the session. base64 in a JS
// string is UTF-16, so a ~24KB thumbnail costs ~64KB of heap — a few thousand
// covers browsed across a session is already hundreds of MB, which the
// gamescope web view does not have to spare.
//
// Budgeted in characters (≈2 bytes each), not entries, because screenshots and
// alpha-preserved art are far bigger than a grid thumbnail. Nulls — "this rom
// genuinely has no art" — are exempt: they cost nothing and evicting one would
// send the tile back to the backend to be told the same thing again.
export const _COVER_CACHE_MAX_CHARS = 48_000_000;   // ≈96MB heap

export let _coverCacheChars = 0;

// Blurred full-bleed background art — the defining RomM v2 surface. The
// focused/first cover is painted behind everything, heavily blurred and dimmed,
// with a bg-coloured gradient scrim on top (recipe lifted verbatim from RomM's
// frontend/src/v2/styles/global.css: blur(28px) brightness(0.45), scale 1.08).
// The fallback asset is fetched once per session and shared: each V2Bg mount
// used to issue its own getImage round-trip, so opening any page while the
// backend was busy (a library walk, say) painted plain black until the loop
// got around to answering — a visible black → background → content sequence.
export let _v2BgFallback: string | null | undefined;


export function _coverCacheEvict() {
  // Map iterates in insertion order and every hit re-inserts (see peekCover),
  // so the front of the map is the least recently used entry.
  for (const [k, v] of _coverCache) {
    if (_coverCacheChars <= _COVER_CACHE_MAX_CHARS * 0.8) return;
    if (v === null) continue;
    _coverCache.delete(k);
    _coverCacheChars -= v.length;
  }
}

export function _coverCacheSet(key: string, uri: string | null) {
  const prev = _coverCache.get(key);
  if (typeof prev === 'string') _coverCacheChars -= prev.length;
  _coverCache.delete(key);
  _coverCache.set(key, uri);
  if (uri !== null) _coverCacheChars += uri.length;
  if (_coverCacheChars > _COVER_CACHE_MAX_CHARS) _coverCacheEvict();
}

export function _coverCacheReset() {
  _coverCache.clear();
  _coverCacheChars = 0;
}

// Sync peek: resolved URI (string | null) or undefined if not yet loaded.
// A hit re-inserts, which is what makes insertion order an LRU order. Note the
// eviction only reclaims what the cache itself pins: a cover whose tile is
// still mounted stays alive through that tile's own state, by design — it's
// on screen.
export const peekCover = (key: string): string | null | undefined => {
  if (!_coverCache.has(key)) return undefined;
  const v = _coverCache.get(key)!;
  if (v !== null) { _coverCache.delete(key); _coverCache.set(key, v); }
  return v;
};

// Deduped fetch into the cache; safe to call from many tiles / prefetch at once.
// Only CONFIRMED results are cached: the backend returns success:false while it
// is still connecting/authenticating (e.g. the window right after a self-update
// reload). Caching that null would poison the tile to black until a fresh module
// import (reopening the plugin). A soft failure is left uncached so the next
// mount retries; a genuine "no cover" (success:true, data_uri:null) is cached.
export function awaitCover(key: string, fetcher: () => Promise<{ success?: boolean; data_uri?: string } | null>): Promise<string | null> {
  if (_coverCache.has(key)) return Promise.resolve(_coverCache.get(key)!);
  let p = _coverInflight.get(key);
  if (!p) {
    p = fetcher()
      .then((r) => {
        const u = r?.data_uri || null;
        if (r && r.success !== false) _coverCacheSet(key, u);
        _coverInflight.delete(key);
        return u;
      })
      .catch(() => { _coverInflight.delete(key); return null; });
    _coverInflight.set(key, p);
  }
  return p;
}

export function V2Bg({ uri }: { uri: string | null }) {
  // RomM's BackgroundArt falls back to /assets/auth_background.svg when no cover
  // is set (platform/collection index pages). Fetch it once as the default.
  const [fallback, setFallback] = useState<string | null>(
    _v2BgFallback !== undefined ? _v2BgFallback : null);
  useEffect(() => {
    if (_v2BgFallback !== undefined) return;
    let alive = true;
    (async () => {
      try {
        const r = await getImage('/assets/auth_background.svg');
        const uri = r?.data_uri || null;
        _v2BgFallback = uri;
        if (alive) setFallback(uri);
      } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, []);
  const shown = uri || fallback;
  return (
    <>
      <div style={{
        position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none',
        backgroundImage: shown ? `url('${shown}')` : 'none',
        backgroundColor: V2.bg,
        backgroundSize: 'cover', backgroundPosition: 'center 20%', backgroundRepeat: 'no-repeat',
        filter: 'blur(28px) brightness(0.45)', transform: 'scale(1.08)',
        transition: 'background-image 0.5s ease',
      }} />
      <div style={{
        position: 'fixed', inset: 0, zIndex: 1, pointerEvents: 'none',
        background:
          `linear-gradient(to right, rgba(7,7,15,0.72) 0%, rgba(7,7,15,0.30) 55%, rgba(7,7,15,0.55) 100%),` +
          `linear-gradient(to bottom, rgba(7,7,15,0.10) 0%, rgba(7,7,15,0) 35%, rgba(7,7,15,0.70) 72%, rgba(7,7,15,0.92) 100%)`,
      }} />
    </>
  );
}

// Lazy, cached cover art. Renders a placeholder until the base64 data URI
// arrives from the backend (the frontend <img> can't auth to RomM directly).
// `onLoaded` bubbles the URI up so a tile can feed the blurred background art.
export function GameCover({ romId, hasCover, large = false, radius = V2.radiusArt, onLoaded }:
  { romId: number; hasCover: boolean; large?: boolean; radius?: string; onLoaded?: (uri: string | null) => void }) {
  const ck = `cover:${romId}:${large}`;
  const peek = peekCover(ck);
  const [uri, setUri] = useState<string | null>(peek ?? null);
  const [done, setDone] = useState(peek !== undefined);
  // Load on mount. We deliberately do NOT viewport-gate the fetch here:
  // IntersectionObserver doesn't fire on gamepad focus-scroll under gamescope
  // (only on touch swipe), so gating left dpad-scrolled covers blank. Instead
  // the parent grid bounds how many tiles are mounted (visN grows as focus
  // advances), so "load every mounted cover" already loads only what's reached.
  useEffect(() => {
    let alive = true;
    if (!hasCover) { setDone(true); onLoaded?.(null); return; }
    const p = peekCover(ck);
    if (p !== undefined) { setUri(p); setDone(true); onLoaded?.(p); return; }
    let attempts = 0;
    const load = async () => {
      const u = await awaitCover(ck, () => qGetGameCover(romId, large));
      if (!alive) return;
      // A null the cache DIDN'T keep is a soft failure (backend still connecting,
      // e.g. right after a self-update reload). Retry with backoff rather than
      // showing "No cover" until the user reopens the plugin. A confirmed result
      // (cached) — real cover or genuine no-cover — is accepted immediately.
      if (u === null && peekCover(ck) === undefined && attempts < 8) {
        attempts++;
        setTimeout(load, Math.min(500 * attempts, 3000));
        return;
      }
      setUri(u); onLoaded?.(u); setDone(true);
    };
    load();
    return () => { alive = false; };
  }, [romId, large]);
  return (
    <div style={{
      position: 'relative', width: '100%', aspectRatio: '3 / 4',
      background: V2.coverPlaceholder, borderRadius: radius, overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {uri ? (
        <img src={uri} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : (
        <span style={{ color: V2.fgMuted, fontSize: '11px' }}>{done ? 'No cover' : '…'}</span>
      )}
    </div>
  );
}

// Landscape screenshot art (RomM continue-playing cover override). Fetches the
// screenshot path as base64 via get_image, fills the art box object-fit:cover.
// `onLoaded` bubbles the URI so the card can feed it to the background art.
export function ScreenshotArt({ path, onLoaded, onRatio }:
  { path: string; onLoaded?: (uri: string | null) => void; onRatio?: (ratio: number) => void }) {
  const ik = `img:${path}`;
  const [uri, setUri] = useState<string | null>(peekCover(ik) ?? null);
  useEffect(() => {
    let alive = true;
    let attempts = 0;
    const load = async () => {
      const u = await awaitCover(ik, () => qGetImage(path));
      if (!alive) return;
      // Same soft-failure retry as GameCover (backend still connecting).
      if (u === null && peekCover(ik) === undefined && attempts < 8) {
        attempts++;
        setTimeout(load, Math.min(500 * attempts, 3000));
        return;
      }
      setUri(u); onLoaded?.(u);
    };
    load();
    return () => { alive = false; };
  }, [path]);
  return (
    <div style={{
      position: 'absolute', inset: 0, background: V2.coverPlaceholder,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {uri && <img src={uri}
        onLoad={(e: any) => {
          const w = e.target?.naturalWidth, h = e.target?.naturalHeight;
          if (w && h) onRatio?.(w / h);
        }}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
    </div>
  );
}

// Cover-art PIP — a small 2D box-art thumbnail floated bottom-right while a
// screenshot covers the rom's own art, so the game stays identifiable (RomM
// CoverArtPip). Fades out on focus so it never collides with the action row.
export function CoverPip({ romId, hasCover, hidden }:
  { romId: number; hasCover: boolean; hidden: boolean }) {
  const ck = `cover:${romId}:false`;
  const [uri, setUri] = useState<string | null>(peekCover(ck) ?? null);
  useEffect(() => {
    let alive = true;
    if (!hasCover) return;
    const p = peekCover(ck);
    if (p !== undefined) { setUri(p); return; }
    (async () => {
      try { const u = await awaitCover(ck, () => qGetGameCover(romId, false)); if (alive) setUri(u); }
      catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [romId]);
  if (!uri) return null;
  return (
    <div style={{
      position: 'absolute', right: '6px', bottom: '6px', width: '46px',
      aspectRatio: '3 / 4', zIndex: 2, borderRadius: V2.radiusSm, overflow: 'hidden',
      border: '1.5px solid rgba(255,255,255,0.12)',
      boxShadow: '0 2px 8px rgba(0,0,0,0.45)', pointerEvents: 'none',
      opacity: hidden ? 0 : 1, transition: 'opacity 0.12s ease',
    }}>
      <img src={uri} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
    </div>
  );
}
