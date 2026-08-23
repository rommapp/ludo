// The visual language, and the four ways this app writes a number.
//
// V2 is a port of RomM's own design tokens (rommapp/romm,
// frontend/src/v2/styles/tokens.css). The Game Browser renders plain divs
// styled with these rather than Steam/Decky chrome, so the two apps look like
// the same product; Focusable is used only for gamepad navigation.
//
// The formatters live beside them because they are the same kind of thing —
// presentation with no state and no dependencies — and because putting them
// here is what lets a module render a size or an ETA without importing a page.

// ---------------------------------------------------------------------------
// RomM v2 visual language (from rommapp/romm frontend/src/v2/styles/tokens.css).
// The Game Browser renders custom divs styled with these tokens instead of the
// Steam/Decky chrome; Focusable is used only for gamepad navigation.
// ---------------------------------------------------------------------------
export const V2 = {
  bg: '#07070f',
  surface: 'rgba(255,255,255,0.07)',
  surfaceHover: 'rgba(255,255,255,0.12)',
  border: 'rgba(255,255,255,0.07)',
  borderStrong: 'rgba(255,255,255,0.15)',
  fg: '#ffffff',
  fg2: 'rgba(255,255,255,0.75)',
  fgMuted: 'rgba(255,255,255,0.45)',
  fgFaint: 'rgba(255,255,255,0.25)',
  bgElevated: 'rgba(255,255,255,0.045)',
  brand: '#8b74e8',
  brandHover: '#a18fff',
  brandPressed: '#6043c8',
  success: '#4ade80',
  warning: '#fbbf24',
  danger: '#ff5050',
  igdb: '#6366f1',
  ra: '#ef4444',
  coverPlaceholder: '#1a1a2e',
  radiusArt: '8px',
  radiusSm: '4px',
  radiusMd: '8px',
  radiusChip: '6px',
  radiusLg: '10px',
  radiusCard: '14px',
  radiusPill: '100px',
  elev2: '0 8px 24px rgba(0,0,0,.45)',
  font: '"Motiva Sans","Segoe UI",system-ui,-apple-system,sans-serif',
};

export function fmtBytes(n: number | null | undefined): string {
  if (!n || isNaN(n as any)) return '';
  let v = Number(n);
  for (const u of ['B', 'KB', 'MB', 'GB']) {
    if (v < 1024) return u === 'B' ? `${v.toFixed(0)} ${u}` : `${v.toFixed(1)} ${u}`;
    v /= 1024;
  }
  return `${v.toFixed(1)} TB`;
}

// Full release date "02 Jan 2024" — RomM GameHeader meta uses the localized
// day/short-month/year form rather than just the year.
export function fmtReleaseDate(ts: number | null | undefined): string {
  if (!ts) return '';
  try {
    // RomM stores first_release_date as a Unix timestamp in milliseconds and
    // formats it directly (new Date(ms)); match that exactly.
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  } catch { return ''; }
}

export function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

// "1m 23s" / "45s" — compact ETA from a seconds count (0 / unknown → '').
export const formatEta = (secs: number): string => {
  if (!secs || secs <= 0 || !isFinite(secs)) return '';
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
};

export const formatSpeed = (bytesPerSec: number): string => {
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSec.toFixed(0)} B/s`;
};

// RomM GameActionBtn round buttons: glassy scrim with blur (default), or the
// "emphasized" white look used by Play. Circular; size in px.
export function roundBtn(size: number, variant: 'glass' | 'emphasized' | 'danger'): any {
  const base: any = {
    width: `${size}px`, height: `${size}px`, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
    backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    transition: 'background 0.15s, color 0.15s, border-color 0.15s',
  };
  if (variant === 'emphasized') return { ...base, background: '#ffffff', border: '1px solid #ffffff', color: '#111117' };
  if (variant === 'danger') return { ...base, background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,80,80,0.55)', color: V2.danger };
  return { ...base, background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.95)' };
}
