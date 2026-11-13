import { getGameDetail } from "./rpc";

// What the game page last knew about each game, and the warm-up that fills it.
//
// The page opens on whatever is here and replaces it when the fresh answer
// lands, so a game seen (or lingered on) before opens without a loader.
const MAX = 30;
const _cache = new Map<number, any>();

export const peekDetail = (romId: number) => _cache.get(romId);

export function storeDetail(romId: number, detail: any) {
  _cache.delete(romId);          // re-insert: Map order is the recency order
  _cache.set(romId, detail);
  if (_cache.size > MAX) _cache.delete(_cache.keys().next().value as number);
}

// Warm the cache for the tile focus has rested on. Dwell first, so moving
// quickly across covers asks for nothing; one request at a time, so slowing
// down on a few of them asks for at most one at once.
const DWELL_MS = 250;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _inFlight = false;

export function cancelDetailPrefetch() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

export function scheduleDetailPrefetch(romId: number) {
  cancelDetailPrefetch();
  if (_cache.has(romId)) return;
  _timer = setTimeout(async () => {
    _timer = null;
    if (_inFlight || _cache.has(romId)) return;
    _inFlight = true;
    try {
      const res = await getGameDetail(romId);
      if (res?.success) storeDetail(romId, res);
    } catch { /* the page asks again when it opens */ }
    finally { _inFlight = false; }
  }, DWELL_MS);
}
