// Thin wrappers over the host, and why they are worth having.
//
// Forcing gamepad focus and raising an on-screen keyboard are things only the
// shell can do, and the two shells do them completely differently — Steam's
// VirtualKeyboardManager on the Deck, the browser's own focus on the desktop.
// The UI names the intent; ui/host/contract.ts is where the difference lives.
// All four no-op where the shell has no such facility, which is why call sites
// never check first.

import { useRef, useEffect } from "react";
import { host } from "@ludo/host";

// Returns a ref to attach to the FIRST selectable item on a screen; once `ready`
// flips true (content loaded), it drops gamepad focus onto that item with a few
// retries to beat Steam's default focus-acquisition — so a direction press moves
// straight into the grid instead of needing a DOWN press out of the header.
// Gamepad focus and the on-screen keyboard are the shell's, not ours: what
// they cost differs completely between a Deck and a PC (see ui/host/contract.ts
// and each adapter's focus.ts). These four wrappers keep the call sites reading
// as intent, and all four no-op where the shell has no such facility — which is
// why no caller checks first.
export function _forceGamepadFocus(el: any): void { host.focus.force(el); }

export function _gpFocusEl(): Element | null { return host.focus.current(); }

export function _summonVirtualKeyboard(): void { host.keyboard.show(); }

export function _dismissVirtualKeyboard(): void { host.keyboard.hide(); }

// The most recently readied auto-focus target (the active panel's first item);
// the post-emulator-session focus restore aims here so the first game/group is
// highlighted, matching what a normal tab switch lands on.
export let _autoFocusFirstRef: React.MutableRefObject<any> | null = null;

// Set while backing out of a game page: returns that game's tile when it is on
// screen. useAutoFocus aims there instead of the first item, so focus goes
// straight back to the game rather than flashing on the top of the list first.
// The rom id is there for a grid that mounts tiles in chunks: it has to mount
// that far first, or there is no tile to land on.
let _returnFocusTarget: (() => any) | null = null;
let _returnFocusRomId: number | null = null;
let _returnFocusExpiry: any = null;
/** Aim autofocus at `fn`'s element for `ms`. A new target replaces the old one
 *  and its expiry: going back again within the window must not have the
 *  previous back's timer clear this one partway through. */
export function setReturnFocusTarget(fn: () => any, romId: number | null, ms: number) {
  clearTimeout(_returnFocusExpiry);
  _returnFocusTarget = fn;
  _returnFocusRomId = romId;
  _returnFocusExpiry = setTimeout(() => { _returnFocusTarget = null; _returnFocusRomId = null; }, ms);
}
export function returnFocusRomId(): number | null { return _returnFocusRomId; }

export function useAutoFocus(ready: boolean, dep?: any) {
  const ref = useRef<any>(null);
  useEffect(() => {
    if (!ready) return;
    _autoFocusFirstRef = ref;
    // _forceGamepadFocus, not plain focus(): gamescope leaves the window
    // OS-unfocused after an emulator session, so element.focus() fires no DOM
    // focus event and Steam never converts it into gamepad focus — the panel
    // would come up with nothing selected and the next press gets spent
    // re-acquiring focus. In the healthy state it degrades to the same focus().
    const timers = [0, 60, 160, 320].map((d) =>
      setTimeout(() => {
        try {
          const el = _returnFocusTarget?.() || ref.current;
          if (el) _forceGamepadFocus(el);
        } catch { }
      }, d));
    return () => timers.forEach(clearTimeout);
  }, [ready, dep]);
  return ref;
}

// Play a Steam Deck UI sound (the same .wav files Big Picture / the Deck UI use
// for its own navigation). Steam serves them from the SP window's loopback host,
// so a plain Audio element reaches them. Everything is wrapped/swallowed: a
// missing file or a blocked autoplay must never break navigation. Elements are
// cached and cloned so rapid LB/RB presses can overlap instead of cutting off.
// The desktop app has no steamloopback.host, so its shell sets
// __ludoSoundBase to a backend route that serves the same files off the local
// Steam install; on the Deck the constant below is used unchanged.
export const _navSoundCache: Record<string, HTMLAudioElement> = {};

export function soundBase(): string {
  return (window as any).__ludoSoundBase || 'https://steamloopback.host/sounds/';
}

export function playSteamSound(name: string) {
  try {
    let base = _navSoundCache[name];
    if (!base) {
      base = new Audio(`${soundBase()}${name}.wav`);
      base.preload = 'auto';
      _navSoundCache[name] = base;
    }
    const a = base.cloneNode(true) as HTMLAudioElement;
    a.volume = 1;
    // play() REJECTS when the source won't load, and the try/catch around this
    // only sees synchronous throws — so on any machine whose shell serves no
    // Steam sounds (a PC with no Steam install; the backend logs "silent" and
    // 404s), every navigation press left an unhandled rejection in the console.
    // Swallow it here: a missing sound is the expected case, not an error.
    void a.play?.()?.catch(() => { });
  } catch { /* no audio → silent, never fatal */ }
}
