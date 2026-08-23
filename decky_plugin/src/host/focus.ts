/**
 * Gamepad focus on a Steam Deck — the Decky side of `HostFocus`.
 *
 * Steam does not use DOM focus for the gamepad cursor. It runs its own
 * focus-navigation trees (`FocusNavController`), in the Big Picture window's
 * document rather than the SharedJSContext one plugin code sees, and moving
 * focus through them emits no DOM focus events at all. Three consequences
 * shape everything below:
 *
 *   1. `element.focus()` alone only works while Steam's focus context already
 *      sits inside our tree. After an emulator session it does not, so we have
 *      to find the element's node in the nav trees and take focus through the
 *      controller (`BTakeFocus`).
 *   2. Because that emits no events, React never learns focus moved and every
 *      focus-gated overlay stays hidden. We synthesize the focusin/focusout
 *      pairs ourselves and then mirror Steam's `.gpfocus` marker for as long
 *      as the degraded state lasts.
 *   3. Coming back from a game, the context returns deactivated and heals over
 *      several seconds, swallowing button presses while it does.
 *
 * None of these internals are documented or stable, which is why every access
 * here is defensive: the worst outcome of a wrong guess should be degrading to
 * a plain `focus()`, never a thrown error inside the UI.
 */
import type { HostFocus } from "./contract";

// A tile that Steam focused without DOM events highlights via CSS
// (:focus-within) but keeps its React `focused` state false, so its focus-gated
// overlays — play button, download scrim — stay hidden. The mirror below fixes
// that by synthesizing the events Steam skipped.
let _focusMirrorStop: (() => void) | null = null;
// The element the mirror currently considers focused — module-level so a
// mirror RESTART (every forced focus) can flush the previous element's
// synthetic blur. Without this, tearing down the old observer before it
// processed the pending gpfocus change loses that focusout forever and the
// old element (e.g. a nav pill) keeps its React focused tint.
let _focusMirrorCur: any = null;
function fireReactFocus(doc: any): void {
  try {
    const ae = doc?.activeElement;
    if (!ae) return;
    const FE = doc.defaultView?.FocusEvent || (window as any).FocusEvent;
    if (_focusMirrorCur && _focusMirrorCur !== ae) {
      try { _focusMirrorCur.dispatchEvent(new FE('focusout', { bubbles: true })); } catch { /* ignore */ }
    }
    // After the post-session restore, Steam moves its gpfocus WITHOUT emitting
    // DOM focus events at all — not just for the forced element but for every
    // subsequent dpad move (tiles highlight via CSS but their React onFocus
    // never fires, so focus-gated overlays only ever showed on the first one).
    // Mirror Steam's gpfocus marker into synthetic focusin/focusout pairs so
    // React state follows the cursor. Duplicate events on tiles whose native
    // handlers DO fire are harmless (state setters are idempotent).
    try { _focusMirrorStop?.(); } catch { /* ignore */ }
    let cur: any = ae;
    _focusMirrorCur = ae;
    cur.dispatchEvent(new FE('focusin', { bubbles: true }));
    // React to the class change itself, not on a timer: a polling mirror lags
    // behind fast dpad movement, leaving the previous tile lit (double
    // highlight) until the next tick. The observer fires in the same frame
    // Steam moves the gpfocus marker.
    const sync = () => {
      try {
        const next = doc.querySelector('.gpfocus');
        if (next === cur) return;
        if (cur) { try { cur.dispatchEvent(new FE('focusout', { bubbles: true })); } catch { /* ignore */ } }
        cur = next;
        _focusMirrorCur = cur;
        if (cur) cur.dispatchEvent(new FE('focusin', { bubbles: true }));
      } catch { /* ignore */ }
    };
    const MO = doc.defaultView?.MutationObserver || (window as any).MutationObserver;
    const obs = new MO(sync);
    obs.observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
    // Steam can flip the focus context back to inactive while it's still
    // healing (~5.5s after app exit); an inactive context swallows the next
    // button press to reactivate itself — the "press LB/RB twice to switch
    // tabs" bug. Keep re-asserting the context active through the healing
    // window so every press lands on the first try, like a fresh open.
    const ctxIv = setInterval(() => {
      try {
        const fnc: any = (window as any).FocusNavController;
        const ctx: any = fnc?.m_ActiveContext ?? fnc?.m_LastActiveContext ?? fnc?.m_rgAllContexts?.[0];
        if (ctx && !ctx.BIsActive?.()) ctx.SetActive?.(true);
      } catch { /* ignore */ }
    }, 300);
    setTimeout(() => clearInterval(ctxIv), 8000);
    const stop = () => {
      try { obs.disconnect(); } catch { /* ignore */ }
      try { clearInterval(ctxIv); } catch { /* ignore */ }
      if (_focusMirrorStop === stop) _focusMirrorStop = null;
    };
    _focusMirrorStop = stop;
    setTimeout(stop, 600000);   // leak guard
  } catch { /* ignore */ }
}
function forceGamepadFocus(el: any): void {
  try { el?.focus?.(); } catch { /* ignore */ }
  // Fast path — healthy state only. The degraded state this function exists
  // for (post-emulator-session) is precisely characterized by the window
  // being OS-unfocused: gamescope never returns focus to Steam's window, so
  // document.hasFocus() stays false and focus() fires no DOM events. When the
  // window IS focused and the context is active, the plain focus() above
  // already landed gamepad focus natively — skip the full nav-tree DFS and
  // the focus-mirror restart, which burn main-thread ms on every tab switch
  // (×5: the pill bridge + 4 useAutoFocus retries), and more so now that all
  // tab panels stay mounted and the tree holds every hidden panel's nodes.
  try {
    const ctx0: any = (window as any).FocusNavController?.m_ActiveContext;
    if (ctx0?.BIsActive?.() && ctx0?.m_rootWindow?.document?.hasFocus?.()) return;
  } catch { /* ignore */ }
  try {
    const fnc: any = (window as any).FocusNavController;
    // Verified live on-device: after an emulator session ends, Steam leaves the
    // gamepad focus CONTEXT deactivated (m_ActiveContext === undefined) and no
    // nav tree active — BTakeFocus then "succeeds" but paints no highlight
    // (no .gpfocus class) and the user steers an invisible cursor. Reactivate
    // the context and re-declare the main page tree active before focusing.
    const ctx: any = fnc?.m_ActiveContext ?? fnc?.m_LastActiveContext ?? fnc?.m_rgAllContexts?.[0];
    try { if (ctx && !ctx.BIsActive?.()) ctx.SetActive?.(true); } catch { /* ignore */ }
    try {
      const mainTree = ctx?.m_rgGamepadNavigationTrees?.find?.((t: any) => t?.m_ID === 'GamepadUI_Full_Root');
      if (mainTree) ctx.SetActiveNavTree?.(mainTree);
    } catch { /* ignore */ }
    const doc: any = ctx?.m_rootWindow?.document;
    const ctxs: any[] = fnc?.m_rgAllContexts ?? (ctx ? [ctx] : []);
    let pageTree: any = null;
    for (const ctx of ctxs) {
      for (const t of (ctx?.m_rgGamepadNavigationTrees ?? [])) {
        if (t?.m_ID === 'GamepadUI_Full_Root') pageTree = t;
        const root = t?.m_Root;
        if (!root) continue;
        const stack: any[] = [root];
        while (stack.length) {
          const n = stack.pop();
          const nEl = n?.m_element;
          // Match by identity OR containment: the ref may point at a wrapper
          // whose actual focus-registered element is a descendant.
          if (nEl && el && (nEl === el || (typeof el.contains === 'function' && el.contains(nEl)))) {
            try { if (n.BTakeFocus?.(3)) { fireReactFocus(doc); return; } } catch { /* ignore */ }
          }
          const kids = n?.m_rgChildren;
          if (Array.isArray(kids)) for (const k of kids) stack.push(k);
        }
      }
    }
    // No node matched the target element — put focus SOMEWHERE visible on the
    // gamepad-UI page tree so the user isn't stranded with an invisible cursor.
    try {
      pageTree?.m_Root?.BFocusFirstChild?.(3);
      fireReactFocus(doc);
    } catch { /* ignore */ }
  } catch (e) { console.error('[RomM] forceGamepadFocus', e); }
}
// Steam marks the gamepad-focused element with a `.gpfocus` class — in the Big
// Picture window's document, not this one, so the query has to start from the
// controller's context rather than from our own `document`.
function gpFocusEl(): Element | null {
  try {
    const fnc: any = (window as any).FocusNavController;
    // m_ActiveContext is undefined while the context is deactivated (the very
    // state the post-session restore runs in) — fall back to the last one.
    const ctx = fnc?.m_ActiveContext ?? fnc?.m_LastActiveContext ?? fnc?.m_rgAllContexts?.[0];
    return ctx?.m_rootWindow?.document?.querySelector?.('.gpfocus') ?? null;
  } catch { return null; }
}

export const focus: HostFocus = {
  force: (el) => forceGamepadFocus(el),
  current: () => gpFocusEl(),
  // Steam swallows the first button press after a session while its input
  // pipeline wakes back up. Feed it a virtual press of an unbound button
  // (INVALID = 0) so that press is spent here instead of on the user.
  wakeInput: () => {
    try { (window as any).FocusNavController?.DispatchVirtualButtonClick?.(0, true); } catch { /* ignore */ }
  },
};
