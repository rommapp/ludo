import { V2 } from "./theme";
// Letter jumping: holding a bumper to skate through an alphabetised grid.
//
// A library of a few thousand games is unusable by scrolling, and a Deck has no
// scrollbar to drag. The overlay is the feedback that makes it usable — it says
// which letter you are on while you hold, then gets out of the way.
//
// The hooks are installed by whichever grid is mounted, so the chrome above can
// drive a list it does not own.

// Platforms/Collections index grid — one component instance per mode, kept
// mounted across tab switches (the parent hides inactive panels with
// display:none) so switching back doesn't rebuild 150+ cover <img>s from
// scratch: measured on-device, each remount inserted ~170–270 fresh imgs and
// cost ~100–200ms of main-thread long tasks (the visible repopulation+stutter).
// L2/R2 alphabet fast-scroll ("letter scrubber", à la Big Picture): the visible
// GroupsPanel registers its jump function here; the library root page's
// onButtonDown dispatches trigger presses into it.
let _libLetterJump: ((dir: 1 | -1) => void) | null = null;

// Fast-scroll glimpse (Big Picture-style): show the current letter only while
// the user is genuinely flying through the grid — a sustained run of held-repeat
// focus moves. Deliberate d-pad taps land ~250ms+ apart even when quick, while
// Steam's held-repeat cadence is well under 200ms, so the tight window plus a
// long streak keeps the overlay away from normal browsing.
let _scrubGlimpse: ((letter: string) => void) | null = null;

// Big Picture-style letter overlay shown while scrubbing — dims/blurs the
// whole screen (not just a small centered card) so the letter reads as a
// full-screen state change rather than a floating window.
export function ScrubOverlay({ letter }: { letter: string | null }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'grid', placeItems: 'center',
      pointerEvents: 'none', zIndex: 60,
      background: 'rgba(6,7,10,0.55)', backdropFilter: 'blur(6px)',
      opacity: letter ? 1 : 0, transition: 'opacity 0.18s ease',
    }}>
      <div style={{
        fontSize: '220px', fontWeight: 800, lineHeight: 1, color: V2.fg,
        textShadow: '0 12px 44px rgba(0,0,0,0.6)',
      }}>
        {letter ?? ''}
      </div>
    </div>
  );
}

/**
 * Installed by the mounted grid, cleared on unmount — a function rather than
 * the bindings themselves because an imported `let` is read-only at the
 * importing end.
 */
export function setLetterJump(fn: ((dir: 1 | -1) => void) | null) { _libLetterJump = fn; }
export function setScrubGlimpse(fn: ((letter: string) => void) | null) { _scrubGlimpse = fn; }

/** Jump a letter; false when no grid is mounted to jump in. */
export function letterJump(dir: 1 | -1): boolean {
  if (!_libLetterJump) return false;
  _libLetterJump(dir);
  return true;
}

/** Flash a letter in the overlay, if a grid is showing one. */
export function scrubGlimpse(letter: string) { _scrubGlimpse?.(letter); }
