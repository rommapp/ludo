/**
 * Gamepad focus on a PC — the desktop side of `HostFocus`.
 *
 * There is no second focus system here. The gamepad is translated into
 * ordinary DOM focus (see `gamepad.ts`), so the cursor the user sees IS
 * `document.activeElement`, moving it is `element.focus()`, and the browser
 * emits the focus events React is already listening for.
 *
 * That is why this file is short and the Decky one is not. The asymmetry is
 * the point of the seam: the shared UI asks for the same three things on both
 * platforms and never learns which of them it cost anything.
 */
import type { HostFocus } from "../../../ui/host/contract";

export const focus: HostFocus = {
  force: (el) => {
    try { (el as any)?.focus?.(); } catch { /* ignore */ }
  },

  // `body` is where focus falls back to when nothing is focused, so report it
  // as "nowhere" — callers use a non-null result to mean the user has moved
  // the cursor somewhere real.
  current: () => {
    const ae = document.activeElement as Element | null;
    return ae && ae !== document.body ? ae : null;
  },

  // No input pipeline to wake: presses are never swallowed here.
  wakeInput: () => { },
};
