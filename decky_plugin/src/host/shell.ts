/**
 * This shell's answers to Ludo's host contract: Steam's on-screen keyboard, the
 * application-lifetime controls we deliberately don't have as a plugin, and
 * what a Deck can do that a PC can't (and vice versa).
 *
 * Deliberately free of the widget kit, so it can be exercised on its own with
 * stubbed Steam globals — see desktop/tests/host-shell.test.mjs, which checks
 * both shells against the same contract.
 */
import { Router } from "@decky/ui";
import { launcher } from "./launcher";
import { focus } from "./focus";
import type {
  HostApp,
  HostCapabilities,
  HostKeyboard,
  HostShell,
  LaunchSpec,
} from "./contract";

// Plugin code runs in Decky's SharedJSContext, so the keyboard manager and the
// document gamepad focus lives in both hang off the Big Picture window instance
// rather than off our own `window`. Reaching them is inherently Deck-shaped,
// which is exactly why it belongs here and not in the shared UI.
function vkm(): any {
  try {
    const win: any = (Router as any)?.WindowStore?.GamepadUIMainWindowInstance;
    return win?.VirtualKeyboardManager;
  } catch {
    return undefined;
  }
}

function gamepadUIDocument(): any {
  try {
    const win: any = (Router as any)?.WindowStore?.GamepadUIMainWindowInstance;
    return win?.BrowserWindow?.document;
  } catch {
    return undefined;
  }
}

// ── Steam's on-screen keyboard ──────────────────────────────────────────────
//
const keyboard: HostKeyboard = {
  available: true,

  /**
   * Summon the keyboard for an input that already has DOM focus.
   *
   * Normally DialogInput shows it by itself on focus. In the degraded
   * post-session state the focus context is inactive and the show is
   * suppressed even though the input has registered itself as the keyboard's
   * target, so we re-register and show it through the manager's own recovery
   * hook. gamescope never returns OS focus to the Steam window after a game
   * session (`document.hasFocus()` stays false), so `input.focus()` moves
   * activeElement WITHOUT firing a DOM focus event — DialogInput's own listener
   * never runs and nothing appears. Verified live on-device.
   */
  show(): void {
    setTimeout(() => {
      try {
        const manager = vkm();
        const doc = gamepadUIDocument();
        const input: any = doc?.activeElement;
        if (!manager || !input || input.tagName !== "INPUT") return;
        if (manager.m_bIsInlineVirtualKeyboardOpen?.m_currentValue) return;
        const ref = manager.CreateVirtualKeyboardRef?.({
          BIsElementValidForInput: () => doc.activeElement === input,
        });
        ref?.ShowVirtualKeyboard?.();
      } catch {
        /* ignore */
      }
    }, 150);
  },

  /**
   * Close it programmatically — used when Enter/R2 submits a wizard field, so
   * the keyboard doesn't linger over the next step. Method names verified
   * on-device: SetVirtualKeyboardDone is the "user finished" path,
   * SetVirtualKeyboardHidden the plain hide.
   */
  hide(): void {
    try {
      const manager = vkm();
      if (!manager) return;
      if (typeof manager.SetVirtualKeyboardDone === "function") manager.SetVirtualKeyboardDone();
      else manager.SetVirtualKeyboardHidden?.();
    } catch {
      /* ignore */
    }
  },

  isOpen(): boolean {
    try {
      return !!vkm()?.m_bIsInlineVirtualKeyboardOpen?.m_currentValue;
    } catch {
      return false;
    }
  },
};

// ── Application lifetime ────────────────────────────────────────────────────
//
// We are a plugin inside someone else's application: quitting and relaunching
// are not ours to do, and Decky Loader reloads updated plugins in place.
const app: HostApp = {
  quit() {},
  restart() {},
  launchSpec(): LaunchSpec | null {
    return null;
  },
};

const capabilities: HostCapabilities = {
  // Decky Loader unpacks the new plugin and reloads it; no restart, no
  // executable to swap.
  selfUpdate: false,
  exit: false,
  // Steam is right here: tiles go through SteamClient's live API, not
  // shortcuts.vdf.
  shortcutTile: false,
  // SteamOS owns toast presentation.
  toastPlacement: false,
};

export const host: HostShell = {
  name: "decky",
  capabilities,
  keyboard,
  app,
  launcher,
  focus,
  uiDocument: () => gamepadUIDocument() ?? document,
};
