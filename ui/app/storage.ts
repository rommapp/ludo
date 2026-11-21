// localStorage, and whether we have one at all.
//
// Every persisted cache in the app goes through _lsAvail first. It is resolved
// once, at module load, because the check itself can throw — a browser with
// site data blocked raises on the property access, not on the call.

export const _lsAvail = (() => { try { return typeof localStorage !== 'undefined'; } catch { return false; } })();

// Set right before a self-update reload; consumed once on startup to reopen home.
export const _LS_REOPEN_HOME = 'romm:reopen-home';

// ── Per-profile storage (#78) ───────────────────────────────────────────────
//
// The window's localStorage outlives a profile switch, and it holds per-person
// caches (home rows, resume states, settings shapes). Each profile keeps its
// own copy: on a switch the current keys are stashed under the old profile and
// the new profile's stash is put back. Only machine facts stay shared.
const _LS_PROFILE_ACTIVE = 'romm:profile-active';
const _LS_PROFILE_STASH = 'romm:profile-stash:';
const _LS_SHARED = new Set(['romm.lastPadFamily', _LS_PROFILE_ACTIVE]);

export function storageProfile(): string {
  if (!_lsAvail) return 'default';
  try { return localStorage.getItem(_LS_PROFILE_ACTIVE) || 'default'; } catch { return 'default'; }
}

export function swapProfileStorage(to: string) {
  if (!_lsAvail) return;
  try {
    const from = storageProfile();
    if (from === to) return;
    const mine: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || _LS_SHARED.has(k) || k.startsWith(_LS_PROFILE_STASH)) continue;
      mine[k] = localStorage.getItem(k) ?? '';
    }
    for (const k of Object.keys(mine)) localStorage.removeItem(k);
    try { localStorage.setItem(_LS_PROFILE_STASH + from, JSON.stringify(mine)); } catch { /* full: the caches rebuild */ }
    const theirs = localStorage.getItem(_LS_PROFILE_STASH + to);
    localStorage.removeItem(_LS_PROFILE_STASH + to);
    if (theirs) {
      const parsed = JSON.parse(theirs) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) localStorage.setItem(k, v);
    }
    localStorage.setItem(_LS_PROFILE_ACTIVE, to);
  } catch { /* a cache that can't move just rebuilds */ }
}

export function dropProfileStorage(id: string) {
  if (!_lsAvail) return;
  try { localStorage.removeItem(_LS_PROFILE_STASH + id); } catch { /* ignore */ }
}
