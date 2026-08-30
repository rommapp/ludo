// The controls every page is built out of.
//
// These are shared for the ordinary reason — a settings row looks the same in
// Settings, in the wizard and on the game page — but also for a less obvious
// one: each of them already knows how to be driven by a gamepad. Focus, the
// hold-to-repeat, the on-screen keyboard handshake and the focus vocabulary in
// focus.tsx are wired in here once, so a page composes controls rather than
// re-deriving what a focusable thing has to do.

import { useState, useEffect, useRef, forwardRef, type Ref, ChangeEvent} from "react";
import { Focusable, TextField, GamepadButton, ModalRoot} from "@ludo/host";
import { V2, fmtBytes, formatEta, formatSpeed } from "./theme";
import { V2Focus, V2_FOCUS_STYLE} from "./focus";
import { _forceGamepadFocus, _summonVirtualKeyboard, _dismissVirtualKeyboard } from "./shell";
import { useDownloadProgress } from "./downloads";
import { _platIconCache, _platIconCacheSet, qGetImage, awaitCover, peekCover, qGetGameCover} from "./media";
import { FaBoxOpen, FaGamepad, FaSearch, FaTimesCircle, FaCheck} from "react-icons/fa";
// Box art for a Downloads-page row, so each entry is recognisable at a glance
// rather than being a name in a list. Same cache/queue path as the tiles, so a
// game whose grid cover was already painted renders on the first frame. The
// frame is drawn whether or not art arrives — a rom with no cover (or one still
// loading) keeps the row's text aligned with its neighbours instead of shifting
// left, which is why this doesn't return null the way ToastCover does.
export function DownloadRowCover({ romId }: { romId: number }) {
  const ck = `cover:${romId}:false`;
  const [uri, setUri] = useState<string | null>(peekCover(ck) ?? null);
  useEffect(() => {
    if (peekCover(ck) !== undefined) return;
    let alive = true;
    awaitCover(ck, () => qGetGameCover(romId, false))
      .then((u) => { if (alive) setUri(u); })
      .catch(() => { /* no art — the empty frame stands in */ });
    return () => { alive = false; };
  }, [romId]);
  return (
    <div style={{
      flexShrink: 0, width: '30px', aspectRatio: '3 / 4', borderRadius: V2.radiusSm,
      overflow: 'hidden', background: V2.surface,
      border: '1px solid rgba(255,255,255,0.10)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: V2.fgFaint,
    }}>
      {uri
        ? <img src={uri} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        : <FaGamepad size={11} />}
    </div>
  );
}
// Names reaching these lists are whatever the caller had to hand, which for an
// unmatched rom (or an activity-log entry) is the file name as it sits on disk:
// "Chrono Trigger (USA).sfc", or the Switch scene form
// "Mario Kart 8 Deluxe [0100152000022000][v0] (6.77 GB)". Reduce it to the title
// the rest of the UI shows, by peeling three things off the END only:
//   • a trailing ROM/archive extension,
//   • trailing [...] groups (title id, [v0] version, [BASE]/[DLC] tags),
//   • a trailing size in parentheses.
// Matched against a known extension set rather than "text after the last dot",
// because plenty of real titles end in one ("Mr. Do!", "R-Type II"), and size
// parens are matched by shape so region/revision tags — "(USA)", "(Rev 1)" —
// survive: those distinguish real entries from one another.
const _ROM_EXTS = new Set([
  'zip', '7z', 'rar', 'gz', 'chd', 'iso', 'bin', 'cue', 'img', 'm3u', 'pbp', 'rvz', 'wbfs',
  'nes', 'fds', 'sfc', 'smc', 'n64', 'z64', 'v64', 'gb', 'gbc', 'gba', 'nds', 'dsi', '3ds',
  'cia', 'nsp', 'xci', 'nca', 'gcm', 'gcz', 'wad', 'sms', 'gg', 'md', 'smd', 'gen', '32x',
  'cdi', 'a26', 'a78', 'lnx', 'ngp', 'ngc', 'ws', 'wsc', 'pce', 'sgx', 'vb', 'vec', 'col',
  'int', 'd64', 'tap', 'tzx', 'adf', 'dsk', 'st', 'ipf', 'rom', 'cart', 'j64', 'jag', 'min',
  'sv', 'xcz', 'nsz',
]);

const _SIZE_TAIL = /\s*\((?:<\s*)?\d+(?:[.,]\d+)?\s*(?:[KMGT]i?B|bytes)\)$/i;

const _BRACKET_TAIL = /\s*\[[^\][]*\]$/;

// A focusable surface row: leading icon, title + optional subtitle, optional
// trailing control. Acts as a button when onClick is given.
// Row highlight — hover and focus tracked separately, because they are not the
// same thing once a modal is involved. Closing a modal restores focus to the row
// that opened it (right for the gamepad: that's where the cursor should resume),
// but with a mouse the pointer has since moved on, leaving that row lit next to
// whatever you're now hovering — two highlighted rows.
//
// So a row lights up for focus only when the pointer isn't the thing driving,
// which takes two checks — the restore happens in a rAF after the modal closes,
// so it can land either side of the pointer's own movement:
//
//   1. At focus time, look BACK: if the pointer was active in the last moment,
//      this focus is the tail of a mouse interaction, not a gamepad landing on
//      the row — don't light it. Needed when the pointer has already settled on
//      its new row before the restore fires, leaving no later event to react to.
//   2. While lit, look FORWARD: any pointer movement retires the highlight.
//      Needed when the restore fires first and the pointer moves away after.
//
// A gamepad leaves the pointer untouched, so neither check ever trips and its
// focus highlight behaves exactly as before.
const POINTER_IDLE_MS = 500;

let _lastPointerAt = 0;

const _pointerSubs = new Set<() => void>();
if (typeof window !== 'undefined') {
  // Capture phase: still observed if something downstream stops propagation.
  // mousedown counts too — dismissing a modal by clicking the backdrop can
  // reach the row underneath without producing a single mousemove.
  for (const evt of ['mousemove', 'mousedown']) {
    window.addEventListener(evt, () => {
      _lastPointerAt = Date.now();
      if (_pointerSubs.size) [..._pointerSubs].forEach((f) => f());
    }, true);
  }
}


export function _gameLabel(name: string): string {
  let out = (name || '').trim();
  // Extension first: it sits inside the tags in "Game [id][v0].nsp (6.77 GB)"
  // only after the size/brackets are gone, so this loops until nothing peels.
  for (let i = 0; i < 8; i++) {
    const before = out;
    out = out.replace(_SIZE_TAIL, '').replace(_BRACKET_TAIL, '').trimEnd();
    const dot = out.lastIndexOf('.');
    if (dot > 0 && _ROM_EXTS.has(out.slice(dot + 1).toLowerCase())) out = out.slice(0, dot).trimEnd();
    if (out === before) break;
  }
  // Never hand back an empty label — a name that was ALL tags is better shown raw.
  return out || name;
}

export function useRowHighlight() {
  const [hover, setHover] = useState(false);
  const [focusLit, setFocusLit] = useState(false);
  useEffect(() => {
    if (!focusLit) return;
    const drop = () => setFocusLit(false);
    _pointerSubs.add(drop);
    return () => { _pointerSubs.delete(drop); };
  }, [focusLit]);
  return {
    active: hover || focusLit,
    highlightHandlers: {
      onFocus: () => setFocusLit(Date.now() - _lastPointerAt > POINTER_IDLE_MS),
      onBlur: () => setFocusLit(false),
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
    },
  };
}


// Estimates remaining seconds from the velocity of a 0..100 percentage: anchors
// at the start of a run and divides the remaining percent by the average rate.
// Generic enough to drive a collection ETA whether the bytes come from the
// one-shot batch or the background sync worker. Returns 0 until it has a rate.
export function useEtaFromPct(pct: number, active: boolean): number {
  const anchor = useRef<{ t: number; p: number } | null>(null);
  const [eta, setEta] = useState(0);
  useEffect(() => {
    if (!active) { anchor.current = null; setEta(0); return; }
    const now = Date.now();
    // (Re)anchor at run start or if progress resets (a new run).
    if (!anchor.current || pct < anchor.current.p) anchor.current = { t: now, p: pct };
    const dt = (now - anchor.current.t) / 1000;
    const dp = pct - anchor.current.p;
    if (dt > 2 && dp > 0.5) setEta(Math.max(0, ((100 - pct) / (dp / dt))));
  }, [pct, active]);
  return eta;
}

// Circular progress ring drawn around a centered glyph (used on the cover's
// download button). `pct` null renders an empty track.
export function ProgressRing({ pct, size = 40, stroke = 3, glow = false, color = V2.brand, children }:
  { pct: number | null; size?: number; stroke?: number; glow?: boolean; color?: string; children?: any }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <div style={{ position: 'relative', width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width={size} height={size} style={{ position: 'absolute', top: 0, left: 0, transform: 'rotate(-90deg)', overflow: 'visible' }}>
        {/* `glow` mode draws only the blurred arc — it's rendered behind the
            opaque button so the inner half is masked and only the outer halo shows. */}
        {!glow && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(0,0,0,0.22)" strokeWidth={stroke} />}
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={c * (1 - p / 100)} strokeLinecap="round"
          style={{
            transition: 'stroke-dashoffset 0.3s ease, stroke 0.3s ease',
            ...(glow ? { filter: `drop-shadow(0 0 5px ${color}) drop-shadow(0 0 3px ${color})` } : {})
          }} />
      </svg>
      {children}
    </div>
  );
}

// True RomM platform icon, served by the RomM server at
// /assets/platforms/{slug}.svg (the RPlatformIcon fallback chain:
// fsSlug.svg → fsSlug.ico → slug.svg → slug.ico). Each candidate is fetched
// via the backend get_image RPC; falls back to a gamepad glyph if none load.
export function PlatformIcon({ slug, fsSlug, size, onTone }: { slug?: string | null; fsSlug?: string | null; size: number; onTone?: (dark: boolean) => void }) {
  const key = `${(fsSlug || '').toLowerCase().trim()}|${(slug || '').toLowerCase().trim()}`;
  // Resolved-icon cache: which candidate URL actually exists is unknown up
  // front, so we cache the RESOLVED data URI (or null = none) per platform key.
  // Seeding from it means a tab switch repaints icons synchronously instead of
  // popping them in one-by-one as each async RPC lands.
  const cached = _platIconCache.has(key) ? _platIconCache.get(key) : undefined;
  const [uri, setUri] = useState<string | null>(cached ?? null);
  const [failed, setFailed] = useState(cached === null);
  useEffect(() => {
    if (_platIconCache.has(key)) {
      const c = _platIconCache.get(key)!;
      setUri(c ?? null); setFailed(c === null); return;
    }
    let alive = true;
    const fs = (fsSlug || slug || '').toLowerCase().trim();
    const s = (slug || '').toLowerCase().trim();
    const cands: string[] = [];
    if (fs) cands.push(`/assets/platforms/${fs}.svg`, `/assets/platforms/${fs}.ico`);
    if (s && s !== fs) cands.push(`/assets/platforms/${s}.svg`, `/assets/platforms/${s}.ico`);
    cands.push('/assets/platforms/default.ico');
    (async () => {
      for (const c of cands) {
        try {
          const r = await awaitCover(`img:${c}`, () => qGetImage(c));
          if (!alive) return;
          if (r) { _platIconCacheSet(key, r); setUri(r); return; }
        } catch { /* try next */ }
      }
      if (alive) { _platIconCacheSet(key, null); setFailed(true); }
    })();
    return () => { alive = false; };
  }, [key]);
  // Report the icon's own tone so a caller's scrim can flip for contrast (dark
  // logo → light scrim), mirroring the screenshot-edge arrows. Average only the
  // opaque pixels — platform SVGs are mostly transparent, so counting the empty
  // field would wash every icon toward "light".
  useEffect(() => {
    if (!uri || !onTone) return;
    let alive = true;
    const img = new Image();
    img.onload = () => {
      try {
        const s = 24;
        const c = document.createElement('canvas');
        c.width = s; c.height = s;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, s, s);
        const d = ctx.getImageData(0, 0, s, s).data;
        let lum = 0, a = 0;
        for (let k = 0; k < d.length; k += 4) {
          const w = d[k + 3] / 255;
          lum += (0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]) * w;
          a += w;
        }
        if (alive) onTone(a > 4 ? lum / a < 120 : false);
      } catch { /* tainted canvas: leave the default scrim */ }
    };
    img.src = uri;
    return () => { alive = false; };
  }, [uri]);
  if (uri) return <img src={uri} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />;
  if (failed || (!slug && !fsSlug)) return <FaGamepad size={Math.round(size * 0.75)} />;
  return null; // loading
}

// One RomM RMenuItem row: leading icon + label, hover/focus highlight, optional
// danger variant. Closes the menu, then runs the action.
// `armed` inverts the danger combination — the tinted-background/red-text row
// becomes a solid red fill with light text, so a half-pressed destructive row
// reads as live at a glance rather than as another idle menu entry.
export function UserMenuRow({ icon, label, danger, armed, disabled, onSelect }:
  { icon: any; label: string; danger?: boolean; armed?: boolean; disabled?: boolean; onSelect: () => void }) {
  const [hot, setHot] = useState(false);
  const fg = disabled ? V2.fgFaint : (armed ? '#fff' : (danger ? V2.danger : V2.fg));
  const bg = armed
    ? (hot ? '#ff6a6a' : V2.danger)
    : ((hot && !disabled) ? (danger ? 'rgba(255,80,80,0.12)' : V2.surfaceHover) : 'transparent');
  return (
    <Focusable noFocusRing onActivate={() => !disabled && onSelect()} onClick={() => !disabled && onSelect()}
      onFocus={() => setHot(true)} onBlur={() => setHot(false)}
      onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: '11px', padding: '9px 12px',
        borderRadius: V2.radiusMd, cursor: disabled ? 'default' : 'pointer',
        background: bg,
        color: fg, transition: 'background 0.12s ease, color 0.12s ease', opacity: disabled ? 0.55 : 1,
      }}>
      <div style={{ flexShrink: 0, width: '16px', display: 'flex', justifyContent: 'center', color: disabled ? V2.fgFaint : (armed ? '#fff' : (danger ? V2.danger : V2.fgMuted)) }}>{icon}</div>
      <span style={{ fontSize: '13.5px', fontWeight: 500 }}>{label}</span>
    </Focusable>
  );
}

// One entry on the Downloads page: game name over a live progress track, with
// speed/percent on the right and a bytes/ETA detail line while transferring.
export function DownloadStatusRow({ romId, name }: { romId: number; name: string }) {
  const prog = useDownloadProgress(romId, true);
  const pct = Math.max(0, Math.min(100, prog?.percent ?? 0));
  const extracting = prog?.state === 'extracting';
  const bytes = prog && prog.total > 0 ? `${fmtBytes(prog.downloaded)} / ${fmtBytes(prog.total)}` : '';
  const eta = prog ? formatEta(prog.eta) : '';
  // During extraction there's no transfer to report — surface the phase instead.
  const sub = extracting
    ? 'Unpacking archive…'
    : [bytes, eta ? `${eta} left` : ''].filter(Boolean).join('  ·  ');
  const barColor = V2.brand;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px 12px' }}>
      <DownloadRowCover romId={romId} />
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', minWidth: 0 }}>
        <span style={{
          fontSize: '13px', fontWeight: 600, color: V2.fg, minWidth: 0, display: 'inline-flex',
          alignItems: 'center', gap: '7px', overflow: 'hidden',
        }}>
          {extracting && <FaBoxOpen size={12} style={{ color: V2.fgMuted, flexShrink: 0 }} />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{_gameLabel(name)}</span>
        </span>
        <span style={{ fontSize: '11.5px', fontWeight: 600, color: V2.fgMuted, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {extracting ? `Extracting… ${pct}%` : `${prog && prog.speed > 0 ? `${formatSpeed(prog.speed)} · ` : ''}${pct}%`}
        </span>
      </div>
      <div style={{ height: '4px', borderRadius: '2px', background: V2.surface, marginTop: '7px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: '2px', transition: 'width 0.3s ease, background 0.3s ease' }} />
      </div>
      {sub && <div style={{ fontSize: '10.5px', color: V2.fgMuted, marginTop: '5px', fontVariantNumeric: 'tabular-nums' }}>{sub}</div>}
      </div>
    </div>
  );
}

// Same row shape for a backend collection auto-sync pass (CollectionSyncManager),
// which downloads outside the frontend registry — surfaced from the shared
// service-status poll (sync_state 'syncing').
export function CollectionSyncStatusRow({ col }: { col: any }) {
  const pct = typeof col.downloaded_pct === 'number'
    ? Math.max(0, Math.min(100, col.downloaded_pct))
    : (col.total ? Math.max(0, Math.min(100, (col.downloaded || 0) / col.total * 100)) : 0);
  return (
    <div style={{ padding: '10px 14px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', minWidth: 0 }}>
        <span style={{
          fontSize: '13px', fontWeight: 600, color: V2.fg, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>Collection · {col.name}</span>
        <span style={{ fontSize: '11.5px', fontWeight: 600, color: V2.fgMuted, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {col.speed > 0 ? `${formatSpeed(col.speed)} · ` : ''}{col.downloaded || 0}/{col.total || 0} games
        </span>
      </div>
      <div style={{ height: '4px', borderRadius: '2px', background: V2.surface, marginTop: '7px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: V2.brand, borderRadius: '2px', transition: 'width 0.3s ease' }} />
      </div>
    </div>
  );
}

// Bumper keycap hint (L1 / R1) flanking the nav pill — signals that the
// shoulder buttons page through the tabs.
export function Bumper({ label }: { label: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '10px', fontWeight: 700, letterSpacing: '0.03em', color: V2.fg2,
      padding: '3px 8px', borderRadius: V2.radiusChip, background: V2.surface,
      border: `1px solid ${V2.borderStrong}`, boxShadow: '0 1px 2px rgba(0,0,0,0.4)',
      lineHeight: 1, whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

// RomM RBtn language: 8px rounded-rect (not a pill), three tones — filled
// brand (primary CTA), translucent surface (tonal), and bare text. Focus/hover
// brightens + paints the brand ring (matches RBtn's currentColor overlay +
// focus glow).
export function V2Button({ children, onClick, variant = 'tonal', color, disabled }:
  { children: any; onClick: () => void; variant?: 'primary' | 'danger' | 'tonal' | 'text'; color?: string; disabled?: boolean }) {
  const [active, setActive] = useState(false);
  const base: any = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
    height: '36px', padding: '0 16px', borderRadius: V2.radiusMd, fontSize: '14px',
    fontWeight: 600, whiteSpace: 'nowrap', border: '1px solid transparent',
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
    transition: 'background 0.15s, box-shadow 0.15s, filter 0.15s',
  };
  const tone =
    variant === 'primary' ? { background: V2.brand, color: '#fff' }
      : variant === 'danger' ? { background: V2.danger, color: '#fff' }
        : variant === 'tonal' ? { background: V2.surface, color: color || V2.fg, border: `1px solid ${V2.border}` }
          : { background: 'transparent', color: color || V2.fg2 };
  const glow = active && !disabled
    ? { boxShadow: `0 0 0 2px ${V2.brand}`, filter: 'brightness(1.12)' }
    : {};
  return (
    <Focusable noFocusRing
      className="romm-btn"
      onActivate={() => !disabled && onClick()}
      onClick={() => !disabled && onClick()}
      onFocus={() => setActive(true)} onBlur={() => setActive(false)}
      onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}
      style={{ ...base, ...tone, ...glow }}
    >
      {children}
    </Focusable>
  );
}

// GameActionButton — RomM's GameActionBtn vocabulary (the action ribbon in the
// GameDetails header), distinct from V2Button's RBtn rounded-rect. Two shapes:
//   • emphasized + label → white pill CTA (#fff / #111117), used by Play / the
//     primary Download (overlay-emphasis tokens).
//   • surface, icon-only  → circular translucent-grey glass button matching the
//     page background (RTag tokens); used for Delete / secondary actions.
// `danger` is a filled-danger pill for the delete-confirm step. Pill radius
// throughout; controller focus paints a brand ring + slight scale.
export function GameActionButton({ icon, label, onClick, variant = 'surface', accent, disabled, progress, progressColor,
  onOptionsButton, optionsHint, focusRef, onFocused, onBlurred }:
  {
    icon: any; label?: string; onClick: () => void;
    variant?: 'emphasized' | 'surface' | 'danger'; accent?: 'danger'; disabled?: boolean;
    progress?: number | null; progressColor?: string; onOptionsButton?: () => void; optionsHint?: boolean;
    focusRef?: React.MutableRefObject<any>;
    onFocused?: () => void; onBlurred?: () => void;
  }) {
  const [active, setActive] = useState(false);
  const labelled = !!label;
  const hasProgress = typeof progress === 'number';
  const pct = hasProgress ? Math.max(0, Math.min(100, progress as number)) : 0;
  // One-shot width "pop" when a download begins: as the label grows from
  // "Download" to "Downloading… 0%", the button overshoots wider then settles.
  const [pop, setPop] = useState(false);
  const wasProg = useRef(false);
  useEffect(() => {
    if (hasProgress && !wasProg.current) {
      wasProg.current = true;
      setPop(true);
      const t = setTimeout(() => setPop(false), 480);
      return () => clearTimeout(t);
    }
    if (!hasProgress) wasProg.current = false;
    // No timer was started on this path, so there is nothing to clear.
    return undefined;
  }, [hasProgress]);
  const base: any = {
    position: 'relative', overflow: 'hidden',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
    height: '44px', borderRadius: V2.radiusPill, fontSize: '14px', fontWeight: 600,
    whiteSpace: 'nowrap', border: '1px solid transparent',
    // Equal-width digits, so a percentage counting up does not reflow the
    // label under itself. Proportional digits make "11%" narrower than "88%".
    fontVariantNumeric: 'tabular-nums',
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
    ...(labelled ? { padding: '0 24px' } : { width: '44px' }),
    // A progress label grows by a whole digit at 10% and again at 100%, and the
    // pill is sized by its content — so without a floor it visibly widens twice
    // during a download, after the one-shot dlGrow pop has already settled.
    // Sized for the longest label this button ever shows ("Downloading… 100%").
    ...(labelled && hasProgress ? { minWidth: '208px' } : {}),
    transition: 'background 0.15s, color 0.15s, transform 0.15s, box-shadow 0.15s, border-color 0.15s',
    // Grow rightward from the left edge as the label widens — no overshoot.
    ...(pop ? { animation: 'dlGrow 0.4s ease', transformOrigin: 'left center' } : {}),
  };
  // Danger-accented surface (Delete): red icon + red-tinted surface/border that
  // intensifies on focus, so it reads as destructive without being a filled CTA.
  const dangerSurface = accent === 'danger';
  const tone =
    variant === 'emphasized'
      ? { background: active ? '#e6e6e6' : '#ffffff', color: '#111117', borderColor: '#ffffff' }
      : variant === 'danger'
        ? { background: V2.danger, color: '#fff', borderColor: V2.danger }
        : dangerSurface
          ? {
            background: active ? 'rgba(255,80,80,0.18)' : 'rgba(255,80,80,0.10)',
            color: V2.danger, borderColor: active ? V2.danger : 'rgba(255,80,80,0.40)'
          }
          : {
            background: active ? V2.surfaceHover : V2.surface,
            color: active ? V2.fg : V2.fg2, borderColor: V2.borderStrong
          };
  const ring = dangerSurface ? V2.danger : V2.brand;
  const glow = active && !disabled ? { boxShadow: `0 0 0 2px ${ring}` } : {};
  return (
    <Focusable noFocusRing ref={focusRef}
      onActivate={() => !disabled && onClick()}
      onClick={() => !disabled && onClick()}
      onOptionsButton={onOptionsButton ? () => !disabled && onOptionsButton() : undefined}
      onOptionsActionDescription={onOptionsButton ? 'Select disc' : undefined}
      onFocus={() => { setActive(true); onFocused?.(); }} onBlur={() => { setActive(false); onBlurred?.(); }}
      onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}
      style={{ ...base, ...tone, ...glow }}
    >
      {/* Download fill — a brand-tinted bar sweeping left→right behind the
          label, tracking the live download percentage. */}
      {hasProgress && (
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`,
          background: progressColor
            ? progressColor
            : variant === 'emphasized' ? 'rgba(139,116,232,0.30)' : 'rgba(139,116,232,0.45)',
          // Smoothly sweep the semi-transparent fill across the white button, and
          // fade it in on the first frame so the colour change is animated too.
          transition: 'width 0.45s cubic-bezier(0.22,1,0.36,1), background 0.3s ease',
          animation: 'dlFillIn 0.3s ease', pointerEvents: 'none',
        }} />
      )}
      <span style={{ position: 'relative', zIndex: 1, display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
        {icon}
        {label && <span>{label}</span>}
        {optionsHint && (
          <span style={{
            marginLeft: '2px', fontSize: '11px', fontWeight: 700, lineHeight: 1,
            padding: '2px 5px', borderRadius: '6px',
            background: variant === 'emphasized' ? 'rgba(17,17,23,0.12)' : V2.surfaceHover,
            color: variant === 'emphasized' ? '#111117' : V2.fgMuted,
          }}>Y</span>
        )}
      </span>
      <style>{`
        @keyframes dlGrow { from { transform: scaleX(0.72); } to { transform: scaleX(1); } }
        @keyframes dlValIn { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes dlFillIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
    </Focusable>
  );
}

// RomM RTextField (filled) search field — uses @decky/ui TextField for
// Steam virtual keyboard support, with CSS overrides to strip the default
// Steam DialogInput styling and apply the V2 theme. Wrapped in Focusable for
// gamepad navigation; onActivate focuses the inner input to trigger keyboard.
export const V2SearchField = forwardRef(function V2SearchField(
  { value, onChange }: { value: string; onChange: (v: string) => void },
  fwdRef: Ref<any>,
) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);

  return (
    <Focusable
      ref={(el: any) => {
        wrapperRef.current = el;
        if (typeof fwdRef === 'function') fwdRef(el);
        else if (fwdRef) (fwdRef as any).current = el;
      }}
      noFocusRing
      onActivate={() => {
        const input = wrapperRef.current?.querySelector('input');
        if (input) input.focus();
        _summonVirtualKeyboard();
      }}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      style={{ borderRadius: V2.radiusMd }}
    >
      <style>{`
        .romm-search-input label { display: none !important; }
        .romm-search-input, .romm-search-input > div, .romm-search-input > div > div { background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important; margin: 0 !important; width: 100% !important; }
        .romm-search-input input { background: transparent !important; border: none !important; outline: none !important; box-shadow: none !important; color: ${V2.fg} !important; font-size: 14px !important; font-family: inherit !important; padding: 0 10px !important; margin: 0 !important; height: auto !important; min-height: 0 !important; caret-color: ${V2.brand} !important; }
        .romm-search-input input::placeholder { color: rgba(255,255,255,0.45) !important; }
      `}</style>
      {/* Mirrors RomM's gallery search RTextField (outlined + inline icon
          "well"): a left adornment box with its own elevated fill and a
          divider that turns brand on focus, brand border + halo when active. */}
      <div className="romm-search-wrap" style={{
        display: 'flex', alignItems: 'stretch', height: '40px', overflow: 'hidden',
        borderRadius: V2.radiusMd,
        background: V2.bgElevated,
        border: `1px solid ${V2.border}`,
        transition: 'background 0.2s, border-color 0.2s, box-shadow 0.2s',
        ...V2Focus.field(focused),
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', padding: '0 11px', flexShrink: 0,
          background: 'rgba(255,255,255,0.06)',
          borderRight: `1px solid ${focused ? V2.brand : V2.border}`,
          color: focused ? V2.brandHover : V2.fgMuted,
          transition: 'border-right-color 0.2s, color 0.2s',
        }}>
          <FaSearch size={14} />
        </div>
        <div className="romm-search-input" style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center' }}
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={() => setFocused(false)}
        >
          <TextField
            value={value}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          />
        </div>
        {value && (
          <div onClick={() => onChange('')}
            style={{
              flexShrink: 0, cursor: 'pointer', color: V2.fgMuted, display: 'flex', alignItems: 'center',
              padding: '0 11px',
            }}>
            <FaTimesCircle size={15} />
          </div>
        )}
      </div>
    </Focusable>
  );
});

// V2TextField — labeled text input sharing the V2SearchField look (RomM
// RTextField filled variant): rounded surface box, brand focus border + halo.
// Used by the setup wizard so its fields match the library search bar.
export function V2TextField({ label, value, onChange, password, placeholder, icon, mono, maxLength, onKb, focusRef, onEnter }:
  { label?: string; value: string; onChange: (v: string) => void; password?: boolean; placeholder?: string; icon?: any; mono?: boolean; maxLength?: number; onKb?: (open: boolean) => void; focusRef?: React.MutableRefObject<any>; onEnter?: () => void }) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);
  const uid = useRef(`v2tf-${Math.random().toString(36).slice(2, 8)}`).current;
  useEffect(() => {
    if (placeholder) {
      const input = wrapperRef.current?.querySelector('input');
      if (input) input.setAttribute('placeholder', placeholder);
    }
  }, [placeholder]);
  // Bring up the Steam keyboard AND lift the field clear of it: the keyboard is
  // an overlay that covers the bottom ~half of the screen without reflowing the
  // page, so a centered field would sit behind it. onKb(true) asks the wizard to
  // add bottom scroll room, then we scroll the field to the top of the scroll
  // area (scrollMarginTop keeps it off the very edge).
  const enterInput = () => {
    const input = wrapperRef.current?.querySelector('input');
    if (input) (input as HTMLElement).focus();
    _summonVirtualKeyboard();
    onKb?.(true);
    // Two passes: one right after the kbRoom padding lands, one after the
    // keyboard's own open animation settles (it can scroll-fight the first).
    [120, 600].forEach((d) => setTimeout(() => {
      try { wrapperRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { }
    }, d));
  };
  // Blur the inner input when gamepad focus leaves the field: it registered
  // itself as the virtual-keyboard target on focus and would otherwise stay
  // activeElement after you move away.
  const leaveInput = () => {
    setFocused(false);
    onKb?.(false);
    const input = wrapperRef.current?.querySelector('input');
    if (input) (input as HTMLElement).blur();
  };
  return (
    // Focusable noFocusRing wrapper: without it the bare TextField carries
    // Steam's own gamepad focus box, which leaves a stray white ring behind
    // after the highlight moves away. noFocusRing suppresses it; our own field
    // halo (V2Focus.field) is the only focus affordance.
    <Focusable
      noFocusRing
      className="wiz-field"
      ref={(el: any) => { wrapperRef.current = el; if (focusRef) focusRef.current = el; }}
      onActivate={enterInput}
      onFocus={() => setFocused(true)} onBlur={leaveInput}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      // Enter on the on-screen keyboard (also R2, which Steam maps to Enter)
      // reaches the input as a keydown — treat it as "submit this field":
      // collapse the keyboard and hand off.
      onKeyDownCapture={onEnter ? (e: any) => { if (e.key === 'Enter') { e.preventDefault(); _dismissVirtualKeyboard(); onEnter(); } } : undefined}
      style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%', scrollMarginTop: '12vh' }}
    >
      {label && <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: V2.fgMuted, textAlign: 'center' }}>{label}</div>}
      <style>{`.${uid} label{display:none!important}.${uid}>div{background:transparent!important;border:none!important;box-shadow:none!important;padding:0!important;margin:0!important}.${uid}>div>div{background:transparent!important;border:none!important;box-shadow:none!important;padding:0!important}.${uid} input,.${uid} input:focus,.${uid} input:focus-visible{background:transparent!important;border:none!important;outline:none!important;box-shadow:none!important;color:${V2.fg}!important;font-size:${mono ? '20px' : '14px'}!important;font-weight:${mono ? '700' : '400'}!important;font-family:${mono ? 'monospace' : 'inherit'}!important;padding:0!important;margin:0!important;height:auto!important;min-height:0!important;caret-color:${V2.brand}!important;text-align:center!important;letter-spacing:${mono ? '.3em' : 'normal'}!important;text-indent:${mono ? '.3em' : 0}!important;text-transform:${mono ? 'uppercase' : 'none'}!important}.${uid} input::placeholder{color:rgba(255,255,255,0.40)!important}`}</style>
      <div className={uid} style={{
        display: 'flex', alignItems: 'center', gap: '10px', height: '38px', padding: '0 12px',
        borderRadius: V2.radiusMd,
        background: focused ? V2.surfaceHover : 'rgba(255,255,255,0.045)',
        border: `1px solid ${V2.border}`,
        transition: 'background 0.2s, border-color 0.2s, box-shadow 0.2s',
        ...V2Focus.field(focused),
      }}>
        {icon && <span style={{ flexShrink: 0, color: focused ? V2.brandHover : V2.fgMuted, display: 'inline-flex' }}>{icon}</span>}
        <div style={{ flex: '1 1 auto', minWidth: 0 }}
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={() => setFocused(false)}
        >
          <TextField
            value={value}
            bIsPassword={password}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(maxLength != null ? e.target.value.slice(0, maxLength) : e.target.value)}
          />
        </div>
      </div>
    </Focusable>
  );
}

// PairCodeField — masked XXXX-XXXX entry. Shows an 8-slot template where each
// typed character replaces one `*` (rather than a placeholder that vanishes on
// the first keystroke). A transparent, char-aligned input sits over the mask so
// the caret lands on the next empty slot.
export function PairCodeField({ label, value, onChange, onKb, onEnter }:
  { label?: string; value: string; onChange: (v: string) => void; onKb?: (open: boolean) => void; onEnter?: () => void }) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);
  const digits = value.replace(/-/g, '');
  const font: any = { fontFamily: 'monospace', fontSize: '20px', fontWeight: 700, letterSpacing: '0.3em', textIndent: '0.3em' };
  const cells: any[] = [];
  for (let i = 0; i < 8; i++) {
    const ch = digits[i];
    cells.push(<span key={i} style={{ color: ch ? V2.fg : V2.fgMuted }}>{ch || '*'}</span>);
    if (i === 3) cells.push(<span key="dash" style={{ color: digits.length > 4 ? V2.fg : V2.fgMuted }}>-</span>);
  }
  const uid = useRef(`v2pf-${Math.random().toString(36).slice(2, 8)}`).current;
  const enterInput = () => {
    const input = wrapperRef.current?.querySelector('input');
    if (input) (input as HTMLElement).focus();
    _summonVirtualKeyboard();
    onKb?.(true);
    [120, 600].forEach((d) => setTimeout(() => {
      try { wrapperRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { }
    }, d));
  };
  // See V2TextField.leaveInput — drop the VK target on blur so no white ring lingers.
  const leaveInput = () => {
    setFocused(false);
    onKb?.(false);
    const input = wrapperRef.current?.querySelector('input');
    if (input) (input as HTMLElement).blur();
  };
  return (
    // See V2TextField: Focusable noFocusRing suppresses Steam's stray white
    // focus box; scrollIntoView lifts the field clear of the on-screen keyboard.
    <Focusable
      noFocusRing
      className="wiz-field"
      ref={(el: any) => { wrapperRef.current = el; }}
      onActivate={enterInput}
      onFocus={() => setFocused(true)} onBlur={leaveInput}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      onKeyDownCapture={onEnter ? (e: any) => { if (e.key === 'Enter') { e.preventDefault(); _dismissVirtualKeyboard(); onEnter(); } } : undefined}
      style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%', scrollMarginTop: '12vh' }}
    >
      {label && <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: V2.fgMuted, textAlign: 'center' }}>{label}</div>}
      <style>{`.${uid} label{display:none!important}.${uid}>div{background:transparent!important;border:none!important;box-shadow:none!important;padding:0!important;margin:0!important}.${uid}>div>div{background:transparent!important;border:none!important;box-shadow:none!important;padding:0!important}.${uid} input,.${uid} input:focus,.${uid} input:focus-visible{position:absolute!important;inset:0!important;width:100%!important;background:transparent!important;border:none!important;outline:none!important;box-shadow:none!important;color:transparent!important;caret-color:${V2.brand}!important;padding:0!important;margin:0!important;height:100%!important;min-height:0!important;font-family:monospace!important;font-size:20px!important;font-weight:700!important;letter-spacing:.3em!important;text-indent:.3em!important;text-transform:uppercase!important}`}</style>
      <div className={uid} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', height: '40px', padding: '0 12px',
        borderRadius: V2.radiusMd,
        background: focused ? V2.surfaceHover : 'rgba(255,255,255,0.045)',
        border: `1px solid ${V2.border}`,
        transition: 'background 0.2s, border-color 0.2s, box-shadow 0.2s',
        ...V2Focus.field(focused),
      }}>
        <div style={{ position: 'relative', display: 'inline-block', width: '100%' }}
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={() => setFocused(false)}
        >
          <div style={{ ...font, whiteSpace: 'pre', pointerEvents: 'none' }}>{cells}</div>
          <TextField
            value={value}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value.slice(0, 9))}
          />
        </div>
      </div>
    </Focusable>
  );
}

// ── V2 settings primitives (full-screen, controller-first) ──────────────────
// Uppercase eyebrow + a column of rows, matching the GameDetails section look.
export function V2SettingsSection({ title, children }: { title: string; children: any }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '24px' }}>
      <div style={{
        fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: V2.fgMuted, padding: '0 2px',
      }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>{children}</div>
    </div>
  );
}

export function V2SettingsRow({ icon, title, subtitle, onClick, right, danger, disabled, bareIcon }:
  { icon?: any; title: any; subtitle?: any; onClick?: () => void; right?: any; danger?: boolean; disabled?: boolean; bareIcon?: boolean }) {
  const { active, highlightHandlers } = useRowHighlight();
  const interactive = !!onClick && !disabled;
  const accent = danger ? V2.danger : V2.brand;
  return (
    <Focusable noFocusRing
      onActivate={interactive ? onClick : undefined}
      onClick={interactive ? onClick : undefined}
      {...highlightHandlers}
      style={{
        display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px',
        borderRadius: V2.radiusCard, background: active ? V2.surfaceHover : V2.surface,
        border: `1px solid ${active && interactive ? accent : V2.border}`,
        boxShadow: active && interactive ? `0 0 0 2px ${accent}` : 'none',
        cursor: interactive ? 'pointer' : 'default', opacity: disabled ? 0.5 : 1,
        transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
      }}>
      {icon && (
        <div style={{
          flexShrink: 0, width: '36px', height: '36px', borderRadius: V2.radiusMd,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          // bareIcon: no chip background (used for full-bleed platform icons,
          // matching the Stats page's plain icon cell).
          background: bareIcon ? 'transparent' : (danger ? 'rgba(255,80,80,0.12)' : V2.bgElevated),
          color: bareIcon ? V2.fg2 : (danger ? V2.danger : V2.brandHover),
        }}>{icon}</div>
      )}
      <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: danger ? V2.danger : V2.fg }}>{title}</div>
        {subtitle && <div style={{ fontSize: '12px', color: V2.fgMuted, lineHeight: 1.35 }}>{subtitle}</div>}
      </div>
      {right != null && <div style={{ flexShrink: 0 }}>{right}</div>}
    </Focusable>
  );
}

// Small pill switch in the V2 palette (the row owns activation).
export function V2Switch({ checked }: { checked: boolean }) {
  return (
    <div style={{
      width: '40px', height: '22px', borderRadius: V2.radiusPill, flexShrink: 0,
      background: checked ? V2.brand : 'rgba(255,255,255,0.18)',
      transition: 'background 0.15s', position: 'relative',
    }}>
      <div style={{
        position: 'absolute', top: '2px', left: checked ? '20px' : '2px',
        width: '18px', height: '18px', borderRadius: '50%', background: '#fff',
        transition: 'left 0.15s',
      }} />
    </div>
  );
}

// RomM SettingsSection chrome: a header bar (surface bg, rounded-top only) over
// a body box (bg-elevated, rounded-bottom).
export function V2StatsSectionBox({ title, icon, children }: { title: string; icon?: any; children: any }) {
  return (
    <section>
      <header style={{
        display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px',
        background: V2.surface, border: `1px solid ${V2.border}`, borderBottom: 'none',
        borderRadius: '10px 10px 0 0', color: V2.fgMuted,
      }}>
        {icon}
        <span style={{
          fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: V2.fg2,
        }}>{title}</span>
      </header>
      <div style={{
        border: `1px solid ${V2.border}`, borderRadius: '0 0 10px 10px',
        overflow: 'hidden', background: V2.bgElevated,
      }}>{children}</div>
    </section>
  );
}

// V2Segment — joined pill segmented control, styled 1:1 with the home V2NavBar
// tab group: a white sliding indicator (measured per option), dpad left/right
// navigation (flow-children), and the pill's own rounded shape as the focus
// affordance — no box-shadow ring. Used for the update channel and the setup
// wizard's login/pair switch.
export function V2Segment({ options, value, onChange, disabled }:
  { options: { id: string; label: string }[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const opts = options;
  const activeIdx = Math.max(0, opts.findIndex((o) => o.id === value));
  const btnRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);
  useEffect(() => {
    const el = btnRefs.current[activeIdx];
    if (el) setInd({ left: el.offsetLeft, width: el.offsetWidth });
  }, [activeIdx]);
  return (
    <Focusable noFocusRing flow-children="horizontal" style={{
      position: 'relative', display: 'flex', flexShrink: 0, gap: '2px', padding: '4px',
      background: V2.surface, border: `1px solid ${V2.borderStrong}`, borderRadius: V2.radiusPill,
      opacity: disabled ? 0.55 : 1,
    }}>
      {/* White sliding indicator — same as the home nav */}
      {ind && (
        <div style={{
          position: 'absolute', top: '4px', bottom: '4px',
          left: `${ind.left}px`, width: `${ind.width}px`,
          background: V2.fg, borderRadius: V2.radiusPill, zIndex: 0,
          transition: 'left 0.28s cubic-bezier(0.22,1,0.36,1), width 0.28s cubic-bezier(0.22,1,0.36,1)',
        }} />
      )}
      {opts.map(({ id, label }, i) => {
        const on = activeIdx === i;
        return (
          <Focusable noFocusRing key={id}
            onActivate={() => !disabled && onChange(id)}
            onClick={() => !disabled && onChange(id)}
            onFocus={() => setFocusedIdx(i)} onBlur={() => setFocusedIdx(null)}
            onMouseEnter={() => setFocusedIdx(i)} onMouseLeave={() => setFocusedIdx(null)}>
            {/* Marks this option — and which one is CURRENT — for the desktop
                shim's spatial nav, so entering the control from above/below
                lands on the selected value instead of whichever pill happens to
                be nearest. Inert on the Deck (Steam uses its own preferred-child
                tracking), and purely advisory: styling never keys off these. */}
            <div ref={(el) => { btnRefs.current[i] = el; }}
              data-seg-opt="1" data-seg-on={on ? '1' : undefined}
              style={{
                position: 'relative', zIndex: 1, padding: '5px 16px', borderRadius: V2.radiusPill,
                fontSize: '12.5px', textAlign: 'center', cursor: disabled ? 'default' : 'pointer',
                fontWeight: on ? 600 : 500, color: on ? V2.bg : V2.fg2,
                // Focus affordance: a brand ring shown on whichever option is
                // focused — including the already-active one, so the controller
                // can tell where the selection landed (it rides on the white
                // indicator). Inactive options also get a tint.
                background: (!on && focusedIdx === i) ? 'rgba(255,255,255,0.10)' : 'transparent',
                boxShadow: (focusedIdx === i) ? `inset 0 0 0 1.5px ${V2.brand}` : 'none',
                transition: 'color 0.2s ease, background 0.15s ease, box-shadow 0.15s ease',
              }}>
              {label}
            </div>
          </Focusable>
        );
      })}
    </Focusable>
  );
}

// UpdateActionBtn — full-width fixed-height action button whose background
// fills left→right with the brand color during install (progress lives IN the
// button, so nothing below it shifts).
export function UpdateActionBtn({ label, icon, onClick, disabled, primary, progress, busy }:
  { label: string; icon: any; onClick: () => void; disabled?: boolean; primary?: boolean; progress?: number | null; busy?: boolean }) {
  const [focused, setFocused] = useState(false);
  const filling = progress != null;
  return (
    <Focusable noFocusRing
      onActivate={() => !disabled && onClick()}
      onClick={() => !disabled && onClick()}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onMouseEnter={() => setFocused(true)} onMouseLeave={() => setFocused(false)}
      style={{
        position: 'relative', overflow: 'hidden', width: '100%', height: '40px',
        boxSizing: 'border-box',
        borderRadius: V2.radiusMd, border: `1px solid ${filling ? V2.brand : V2.border}`,
        background: primary && !filling ? V2.brand : V2.surface,
        // Dim only when the button is inert — NOT while it's working. The busy
        // shimmer and the "Checking…" label already say that, and on the desktop
        // shim a dimmed control drops its tabindex (opacity < 1 is that shim's
        // disabled convention), which blurred the button mid-check and threw
        // controller focus up to the page's Back button.
        opacity: disabled && !filling && !busy ? 0.55 : 1, cursor: disabled ? 'default' : 'pointer',
        transition: 'box-shadow 0.15s, background 0.2s, border-color 0.2s',
        ...V2Focus.flat(focused && !disabled, { glow: primary || filling }),
      }}>
      {/* Keyframes for the busy shimmer — scoped, defined inline so this works
          regardless of which other components happen to be mounted.
          translateX percentages are relative to the SWEEPER's width (55% of the
          button), not the button's, so the loop has to overshoot to clear both
          edges: -100% parks it fully off the left, and 200% (= 110% of the
          button) carries it fully off the right. Anything less leaves a bright
          edge on screen when the iteration restarts, which reads as a stutter. */}
      <style>{`@keyframes uabShimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(200%); } }`}</style>
      {filling && (
        <div style={{
          position: 'absolute', inset: 0, width: `${Math.max(2, progress ?? 0)}%`,
          background: V2.brand, transition: 'width 0.3s ease',
        }} />
      )}
      {busy && (
        <div style={{
          position: 'absolute', top: 0, bottom: 0, left: 0, width: '55%', zIndex: 2,
          background: `linear-gradient(90deg, transparent 0%, ${filling || primary ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.14)'} 50%, transparent 100%)`,
          animation: 'uabShimmer 1.15s linear infinite', pointerEvents: 'none',
        }} />
      )}
      <div style={{
        position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center',
        justifyContent: 'center', gap: '8px', height: '100%',
        fontSize: '14px', fontWeight: 600, color: primary || filling ? '#fff' : V2.fg,
      }}>
        {icon}<span>{label}</span>
      </div>
    </Focusable>
  );
}

// Full-screen modal scrims stop short of the button legend at the bottom of the
// screen, so the hints for the modal's own buttons stay readable while it is
// open — dimming and blurring the one bar that says which button does what is
// exactly backwards. The desktop shim publishes its legend height as
// --shim-legend-h; on the Deck the variable is absent and the fallback is
// Steam's own fixed legend, measured at 42px on-device.
export const MODAL_SCRIM_INSET = '0 0 var(--shim-legend-h, 42px) 0';

// Box art for a toast's logo slot, so a "Downloaded" notification shows the
// game rather than just naming it. The cover is nearly always already in
// `_coverCache` — the tile the user pressed painted it — so this renders on the
// first frame; a cache miss loads in behind nothing rather than reserving an
// empty box, and a rom with no art renders nothing at all, which lets the host
// fall back to its own icon instead of showing a grey rectangle.
export function ToastCover({ romId, hasCover }: { romId: number; hasCover: boolean }) {
  const ck = `cover:${romId}:false`;
  const [uri, setUri] = useState<string | null>(peekCover(ck) ?? null);
  useEffect(() => {
    if (!hasCover || peekCover(ck) !== undefined) return;
    let alive = true;
    awaitCover(ck, () => qGetGameCover(romId, false))
      .then((u) => { if (alive) setUri(u); })
      .catch(() => { /* no art, no logo */ });
    return () => { alive = false; };
  }, [romId]);
  if (!uri) return null;
  return (
    // Fit the host's logo slot instead of picking our own box. Both toasters
    // hand `logo` to a container with fixed dimensions — on Decky that is
    // Steam's StandardLogoDimensions, a 44x44 block div — so the 56x76 portrait
    // this used to be spilled out of the notification on both axes. Same
    // treatment the library toast's platform icon already gets.
    <div style={{
      width: '100%', height: '100%', padding: '4px', boxSizing: 'border-box',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {/* Height-led, not width-led: the slot is square and box art is 3:4, so
          height is the dimension that runs out first. Letting width follow from
          the aspect ratio keeps the cover uncropped inside the slot.

          maxHeight in PIXELS as well as the percentage, because only one of the
          two hosts gives this a box to fill. Steam's logo slot is a fixed 44x44
          block, where height:100% resolves; the desktop toaster's .desk-toast-logo
          sets no size at all (only a max), so a percentage there resolves against
          nothing and the image fell back to its natural size — several hundred
          pixels of cover art dragging the toast open. The pixel cap is what that
          case lands on, and it is a no-op inside Steam's smaller slot. */}
      <img src={uri} style={{
        height: '100%', maxHeight: '72px', width: 'auto', maxWidth: '100%',
        aspectRatio: '3 / 4', objectFit: 'cover', display: 'block',
        borderRadius: V2.radiusSm, border: '1px solid rgba(255,255,255,0.12)',
      }} />
    </div>
  );
}

// Uppercase eyebrow heading for an overview section (RomM
// .overview-tab__section-heading).
export function SectionHeading({ icon, children }: { icon?: any; children: any }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: '6px', margin: 0,
      fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em',
      textTransform: 'uppercase', color: V2.fgFaint,
    }}>
      {icon}{children}
    </div>
  );
}

// Placeholder block with a slow left-to-right sheen — the shared building brick
// for every "we don't know this yet" shape.
export function Shimmer({ style }: { style?: any }) {
  return (
    <div style={{
      background: V2.bgElevated, borderRadius: V2.radiusSm, overflow: 'hidden',
      position: 'relative', ...style,
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.055) 50%, transparent 80%)',
        animation: 'rommShimmer 1.4s ease-in-out infinite',
      }} />
    </div>
  );
}

// The same row, but flat: no card of its own, so several can live inside ONE
// surface separated by hairlines (see FoldersSection). Highlight is drawn inset
// instead of as a border, which keeps the card's outline unbroken.
export function V2CardRow({ icon, title, subtitle, onClick, right, danger, divider, first, last }:
  { icon?: any; title: any; subtitle?: any; onClick?: () => void; right?: any;
    danger?: boolean; divider?: boolean; first?: boolean; last?: boolean }) {
  const { active, highlightHandlers } = useRowHighlight();
  const interactive = !!onClick;
  const accent = danger ? V2.danger : V2.brand;
  // The highlight ring has to follow the CARD's corners, not its own: a row in
  // the middle is square, but the top and bottom rows sit in the card's rounded
  // ends. One pixel less than the card radius, because the card's 1px border
  // sits outside this ring.
  const end = `calc(${V2.radiusCard} - 1px)`;
  return (
    <Focusable noFocusRing
      onActivate={interactive ? onClick : undefined}
      onClick={interactive ? onClick : undefined}
      {...highlightHandlers}
      style={{
        display: 'flex', alignItems: 'center', gap: '14px', padding: '13px 14px',
        borderTopLeftRadius: first ? end : 0,
        borderTopRightRadius: first ? end : 0,
        borderBottomLeftRadius: last ? end : 0,
        borderBottomRightRadius: last ? end : 0,
        borderTop: divider ? `1px solid ${V2.border}` : 'none',
        background: active && interactive ? V2.surfaceHover : 'transparent',
        boxShadow: active && interactive ? `inset 0 0 0 2px ${accent}` : 'none',
        cursor: interactive ? 'pointer' : 'default',
        transition: 'background 0.15s, box-shadow 0.15s',
      }}>
      {icon && (
        <div style={{
          flexShrink: 0, width: '32px', height: '32px', borderRadius: V2.radiusMd,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: danger ? 'rgba(255,80,80,0.12)' : V2.bgElevated,
          color: danger ? V2.danger : V2.brandHover,
        }}>{icon}</div>
      )}
      <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: danger ? V2.danger : V2.fg }}>{title}</div>
        {subtitle && <div style={{ fontSize: '12px', color: V2.fgMuted, lineHeight: 1.35 }}>{subtitle}</div>}
      </div>
      {right != null && <div style={{ flexShrink: 0 }}>{right}</div>}
    </Focusable>
  );
}

// The toggle list itself, shared by Settings ▸ Platforms and the setup wizard's
// optional Platforms step — the two must never drift, because they are the same
// decision made at two different moments.
// A bounded scroll box whose edges fade out only while there is more content
// past them. The fade IS the affordance: a hard-cut edge mid-row reads as a
// layout bug, and on a controller there is no scrollbar to say otherwise —
// nothing else on screen tells you the list continues. Both edges are computed
// independently so the top fade appears only once you have actually scrolled,
// rather than veiling the first row from the start.
export function ScrollFade({ maxHeight, refresh, children, style }: {
  maxHeight: string;
  // Bump when the content's height can have changed without a scroll (rows
  // arriving, a subtitle growing on toggle) — there is no scroll event for that.
  refresh?: any;
  children: any;
  style?: any;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });

  const measure = () => {
    const el = ref.current;
    if (!el) return;
    // 2px slack: fractional scroll offsets (dpad scrollIntoView lands on
    // sub-pixel positions) would otherwise leave a fade stuck on at the end.
    const top = el.scrollTop > 2;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setEdges((p) => (p.top === top && p.bottom === bottom ? p : { top, bottom }));
  };

  useEffect(() => { measure(); }, [refresh, maxHeight]);

  const F = '30px';
  const mask = edges.top && edges.bottom
    ? `linear-gradient(to bottom, transparent 0, #000 ${F}, #000 calc(100% - ${F}), transparent 100%)`
    : edges.top
      ? `linear-gradient(to bottom, transparent 0, #000 ${F})`
      : edges.bottom
        ? `linear-gradient(to bottom, #000 calc(100% - ${F}), transparent 100%)`
        : undefined;

  return (
    <div ref={ref} onScroll={measure}
      style={{
        maxHeight, overflowY: 'auto', overflowX: 'hidden',
        WebkitMaskImage: mask, maskImage: mask,
        // Both properties, or the mask is applied per-box and each row fades
        // against its own edges instead of the container's.
        WebkitMaskSize: '100% 100%', maskSize: '100% 100%',
        ...style,
      }}>
      {children}
    </div>
  );
}

// V2 glass picker — the disc/region selector in the app's own modal language
// (same chrome as CollectionActionsModal / UserMenuModal) instead of Steam's
// native context menu. Rows reuse UserMenuRow; the remembered/default entry
// carries a check in the icon slot.
export function PickerModal({ title, items, closeModal }: {
  title: string;
  items: { key: string | number; label: string; active?: boolean; onSelect: () => void }[];
  closeModal?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => { if (panelRef.current) _forceGamepadFocus(panelRef.current); }, 60); return () => clearTimeout(t); }, []);
  return (
    <ModalRoot bHideCloseIcon onCancel={closeModal} onEscKeypress={closeModal}
      className="romm-modal-collapse" modalClassName="romm-modal-collapse">
      <Focusable noFocusRing className="romm-ui"
        onCancelButton={() => closeModal?.()}
        onButtonDown={(e: any) => { if (e?.detail?.button === GamepadButton.CANCEL) closeModal?.(); }}
        style={{
          position: 'fixed', inset: MODAL_SCRIM_INSET, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(7,7,15,0.45)',
          WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)',
        }}>
        <style>{`
          ${V2_FOCUS_STYLE}
          .romm-modal-collapse, .romm-modal-collapse > div {
            background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important;
          }
          @keyframes umIn { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: none; } }
        `}</style>
        <div onClick={() => closeModal?.()} style={{ position: 'absolute', inset: 0 }} />
        <Focusable noFocusRing autoFocus ref={panelRef} flow-children="vertical" style={{
          position: 'relative', width: '340px', maxWidth: '90vw', boxSizing: 'border-box',
          fontFamily: V2.font, color: V2.fg, padding: '8px',
          display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(180deg, rgba(20,20,30,0.7) 0%, rgba(10,10,18,0.78) 100%)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.1)', backdropFilter: 'blur(28px) saturate(1.1)',
          border: `1px solid rgba(255,255,255,0.12)`, borderRadius: V2.radiusCard,
          boxShadow: '0 16px 48px rgba(0,0,0,0.55)',
          maxHeight: '82vh', overflowY: 'auto',
          animation: 'umIn 0.18s cubic-bezier(0.22,1,0.36,1)',
        }}>
          <div style={{
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
            color: V2.fgMuted, padding: '6px 8px 10px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{title}</div>
          <div style={{ height: '1px', background: V2.border, margin: '0 4px 4px' }} />
          {items.map((it) => (
            <UserMenuRow key={it.key}
              icon={it.active ? <FaCheck size={14} style={{ color: V2.brand }} /> : null}
              label={it.label}
              onSelect={() => { closeModal?.(); it.onSelect(); }} />
          ))}
        </Focusable>
      </Focusable>
    </ModalRoot>
  );
}

// Fetch an auth-gated RomM resource path as a base64 data URI (backend proxy).
export function useRommImage(path: string | null): string | null {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!path) { setUri(null); return; }
    (async () => {
      try { const r = await qGetImage(path); if (alive) setUri(r?.data_uri || null); }
      catch { if (alive) setUri(null); }
    })();
    return () => { alive = false; };
  }, [path]);
  return uri;
}
