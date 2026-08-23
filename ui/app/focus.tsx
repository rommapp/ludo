// What focus looks like, and the frame every page is drawn in.
//
// The focus vocabulary is one place on purpose: a tile, a row and a button all
// have to say "you are here" the same way, and on a gamepad that reading is the
// only cursor there is. v2Page is the frame — background art, the ambient
// gradient, and the .romm-ui marker the focus CSS and the shell's own focus
// walker both key off.

import { V2 } from "./theme";
import { V2Bg } from "./media";

// Suppress Steam's gamepad focus highlight (the square "overdraw" box drawn on
// every Focusable) inside the plugin UI. We rely on our own per-component focus
// styling (card scale/glow, row lift, button glow) instead, so the Steam box is
// fully removed rather than restyled.
// Steam draws its gamepad focus box in JS; we disable it per-element via the
// noFocusRing prop on every Focusable. Here we only strip the CEF :focus
// outline (our components supply their own glow), without touching box-shadow
// so our focus glows survive.
export const V2_FOCUS_STYLE = `
  .romm-ui *:focus, .romm-ui *:focus-visible { outline: none !important; }
  /* Nothing here is a document to be read and copied — drag-selecting a game
     title just leaves stray highlight behind. Scoped to .romm-ui so Steam's own
     UI is untouched; inputs keep selection so the caret still works. */
  .romm-ui { user-select: none; -webkit-user-select: none; }
  .romm-ui input, .romm-ui textarea, .romm-ui [contenteditable="true"] {
    user-select: text; -webkit-user-select: text;
  }
`;
// Shared list-row / tile hover+focus treatment — the canonical RomM interaction
// vocabulary (brand ring + soft purple glow + slight lift). Injected globally by
// v2Page so every list (saves, achievements, …) reads identically instead of
// each component reinventing it. `.romm-row` for full-width rows, `.romm-tile`
// for the card grid. Note: hosts must NOT clip these (no overflow:hidden on the
// immediate wrapper) or the outset glow gets cut off.
const _EASE = 'cubic-bezier(0.22,1,0.36,1)';

// ── Focus system ────────────────────────────────────────────────────────────
// Single source of truth for how a focused (gamepad or mouse) element reads.
// Gamepad focus under gamescope doesn't reliably fire CSS :focus-within, so most
// call sites drive focus with JS state (onFocus/onBlur) and spread one of these
// fragments; the .romm-row / .romm-tile CSS below is sourced from the SAME
// constants so mouse (:hover/:focus-within) and gamepad focus render identically.
//
//   V2Focus.tile(f)   — card/tile-shaped things that pop toward you (scale)
//   V2Focus.row(f)    — full-width list rows (lift instead of scale)
//   V2Focus.field(f)  — text inputs: quiet halo, no lift/ring
//   V2Focus.flat(f)   — buttons/pills: crisp ring, no lift; opts.glow adds a
//                       faint halo for filled/primary buttons
//   V2Focus.segment(f)— selected-segment tint (nav tabs / channel switch); the
//                       one intentional no-ring affordance
const _RING = `0 0 0 2px ${V2.brand}`;

const _GLOW = 'rgba(139,116,232,0.45)';


export const V2Focus = {
  tile: (f: boolean) => f ? {
    transform: 'scale(1.04)', borderColor: V2.brand,
    boxShadow: `0 8px 28px rgba(0,0,0,0.4), ${_RING}, 0 0 18px rgba(139,116,232,0.55)`,
  } : {},
  row: (f: boolean) => f ? {
    background: V2.surfaceHover, borderColor: V2.brand, transform: 'translateY(-1px)',
    boxShadow: `0 8px 22px rgba(0,0,0,0.4), ${_RING}, 0 0 16px ${_GLOW}`,
  } : {},
  // field returns borderColor on BOTH branches: callers pair it with a
  // `border: 1px solid …` shorthand, and if the longhand is only present while
  // focused, React drops border-color entirely on blur (without re-applying the
  // shorthand) — border-color then falls back to currentColor and the field
  // keeps a solid white 1px ring. Verified live on-device via CDP.
  field: (f: boolean) => f ? {
    borderColor: V2.brand, boxShadow: `0 0 0 3px rgba(139,116,232,0.22)`,
  } : { borderColor: V2.border },
  flat: (f: boolean, opts?: { glow?: boolean }) => f ? {
    boxShadow: opts?.glow ? `${_RING}, 0 0 14px rgba(139,116,232,0.35)` : _RING,
  } : {},
  segment: (f: boolean) => f ? { background: 'rgba(255,255,255,0.10)' } : {},
};

export const V2_ROW_STYLE = `
  .romm-row { background: ${V2.surface}; border: 1px solid ${V2.border}; transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ${_EASE}, box-shadow 0.15s ease; }
  .romm-row:hover, .romm-row.gpfocuswithin {
    background: ${V2.surfaceHover}; border-color: ${V2.brand}; transform: translateY(-1px);
    box-shadow: 0 8px 22px rgba(0,0,0,0.4), ${_RING}, 0 0 16px ${_GLOW};
  }
  .romm-tile { background: ${V2.surface}; border: 1px solid ${V2.border}; transition: background 0.15s ease, transform 0.15s ${_EASE}, box-shadow 0.15s ease, border-color 0.15s ease; }
  .romm-tile:hover, .romm-tile.gpfocuswithin {
    background: ${V2.surfaceHover}; transform: translateY(-2px); border-color: ${V2.brand};
    box-shadow: 0 8px 22px rgba(0,0,0,0.4), ${_RING}, 0 0 16px ${_GLOW};
  }
  /* Gamepad focus can be FORCED onto a tile (returning from an emulator
     session) without firing React's onFocus, so the highlight must also be
     reachable via CSS. Keyed to Steam's own .gpfocuswithin marker — NOT DOM
     :focus-within: gamescope leaves the window unfocused after a session, so
     element.focus() (e.g. useAutoFocus on remount) moves DOM activeElement
     silently and :focus-within would light a SECOND tile alongside the one
     Steam actually has gamepad focus on. */
  .romm-ptile-wrap:hover .romm-ptile-v, .romm-ptile-wrap.gpfocuswithin .romm-ptile-v {
    background: ${V2.surface} !important; border-color: ${V2.brand} !important; transform: scale(1.04) !important;
    box-shadow: 0 8px 28px rgba(0,0,0,0.4), ${_RING}, 0 0 18px rgba(139,116,232,0.55) !important;
  }
  .romm-ptile-wrap:hover .romm-ptile-ic, .romm-ptile-wrap.gpfocuswithin .romm-ptile-ic { color: ${V2.brandHover} !important; opacity: 1 !important; }
  .romm-ptile-wrap:hover .romm-ptile-lb, .romm-ptile-wrap.gpfocuswithin .romm-ptile-lb { color: ${V2.fg} !important; }
  .romm-gt-wrap:hover .romm-gt-cover, .romm-gt-wrap.gpfocuswithin .romm-gt-cover {
    transform: scale(1.04) !important;
    box-shadow: 0 8px 28px rgba(0,0,0,0.4), ${_RING}, 0 0 18px rgba(139,116,232,0.55) !important;
  }
  /* Reveal the cover's action overlay on real mouse hover, not just the React
     focused state — onMouseEnter can miss when the pointer ends up inside a
     cover without crossing its boundary (see the overlay comment in GameTile),
     which otherwise left the Details/Delete/Play buttons unclickable. */
  .romm-gt-wrap:hover .romm-gt-scrim,
  .romm-gt-wrap:hover .romm-gt-primary { opacity: 1 !important; }
  .romm-gt-wrap:hover .romm-gt-actions { opacity: 1 !important; transform: translateY(0) !important; }
  .romm-ct-wrap:hover .romm-ct-cover, .romm-ct-wrap.gpfocuswithin .romm-ct-cover {
    transform: scale(1.04) !important;
    box-shadow: 0 8px 28px rgba(0,0,0,0.4), ${_RING}, 0 0 18px rgba(139,116,232,0.55) !important;
  }
`;

export function v2Page(children: any, bgUri: string | null = null) {
  return (
    <div className="romm-ui" style={{
      fontFamily: V2.font, color: V2.fg, background: V2.bg,
      position: 'relative', overflowY: 'auto', height: 'calc(100vh - 40px)',
      marginTop: '40px', scrollPaddingTop: '120px', scrollPaddingBottom: '80px',
    }}>
      <style>{V2_FOCUS_STYLE}{V2_ROW_STYLE}</style>
      <V2Bg uri={bgUri} />
      {/* Bottom padding covers Steam's fixed footer button legend (measured
          42px tall on-device, overlaying the screen bottom) + ~22px of real
          clearance, so a fully scrolled last row sits above the glass bar
          instead of under it. */}
      <div style={{ position: 'relative', zIndex: 2, padding: '0 0 64px' }}>
        {children}
      </div>
    </div>
  );
}
