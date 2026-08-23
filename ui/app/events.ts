// Announcements between parts of the app that must not import each other.
//
// Both channels here exist to keep a dependency pointing the right way. The
// downloader learns first that a rom's local copy appeared or disappeared, and
// the library cache is what has to act on it; a refresh is started from the
// account menu, or from the Deck's QAM panel, and every mounted grid has to
// hear about it. Routing those through listeners rather than direct calls is
// what lets the modules below stay independent of the page tree above them.

// Broadcast target for "the backend re-fetched from RomM, re-pull whatever's
// on screen now" (fired after a manual Refresh from the account menu). The
// Home/Groups panels stay mounted across tab switches (see below) and their
// silent-refresh effects don't re-run just because a modal closed on top of
// them, so without this a same-tab refresh would sit invisible until the
// user actually switched tabs.
export const _libRefreshListeners = new Set<() => void>();

export function _broadcastLibRefresh() { _libRefreshListeners.forEach((l) => { try { l(); } catch { } }); }

// "This rom's local copy appeared or disappeared."
//
// The downloader knows it first; the library cache is what has to act on it.
// Routing it through here rather than calling the cache directly is what keeps
// the download registry from importing the page tree it is meant to be
// independent of.
export const _downloadedListeners = new Set<(romId: number, downloaded: boolean) => void>();

export function _broadcastDownloaded(romId: number, downloaded: boolean) {
  _downloadedListeners.forEach((l) => { try { l(romId, downloaded); } catch { } });
}
