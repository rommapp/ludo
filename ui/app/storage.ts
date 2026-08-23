// localStorage, and whether we have one at all.
//
// Every persisted cache in the app goes through _lsAvail first. It is resolved
// once, at module load, because the check itself can throw — a browser with
// site data blocked raises on the property access, not on the call.

export const _lsAvail = (() => { try { return typeof localStorage !== 'undefined'; } catch { return false; } })();

// Set right before a self-update reload; consumed once on startup to reopen home.
export const _LS_REOPEN_HOME = 'romm:reopen-home';
