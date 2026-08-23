/**
 * This shell's answers to Ludo's host contract: what it can do, its on-screen
 * keyboard (there isn't one), and its application-lifetime controls.
 *
 * Deliberately free of React and of the widget kit, so it can be exercised on
 * its own with nothing but a stub `window` — see tests/host-shell.test.mjs.
 */
import { launcher } from "./launcher";
import { focus } from "./focus";
import type {
  HostApp,
  HostCapabilities,
  HostKeyboard,
  HostShell,
  LaunchSpec,
} from "../../../ui/host/contract";

/**
 * The Electron preload's bridge into the main process, or undefined under a
 * plain WebView with no preload.
 *
 * Confined to this file on purpose. The shared UI used to feature-detect
 * `window.__rommDesktop` in ten places to decide how to behave, which made
 * "am I on a PC" mean "did the Electron preload happen to run" — so any other
 * host of the same UI silently got Deck behaviour. Now the bridge is a detail
 * of this adapter and the UI asks about capabilities instead.
 */
type DesktopBridge = {
  quit?: () => void;
  restart?: () => void;
  launchSpec?: () => LaunchSpec | null;
};

function bridge(): DesktopBridge | undefined {
  return (window as any).__rommDesktop;
}

// ── On-screen keyboard ──────────────────────────────────────────────────────
//
// A desktop has a real keyboard. There is nothing to summon and nothing to
// dismiss, so these are honest no-ops rather than failed attempts at Steam's.
const keyboard: HostKeyboard = {
  available: false,
  show() {},
  hide() {},
  isOpen() {
    return false;
  },
};

// ── Application lifetime ────────────────────────────────────────────────────
//
// We own our process here, but only the main process knows how it was started
// — whether this is an AppImage, a packaged binary or a dev checkout — so the
// launch spec comes back over the bridge.
const app: HostApp = {
  quit() {
    try {
      bridge()?.quit?.();
    } catch {
      /* no-op */
    }
  },
  restart() {
    try {
      bridge()?.restart?.();
    } catch {
      /* no-op */
    }
  },
  launchSpec(): LaunchSpec | null {
    try {
      return bridge()?.launchSpec?.() ?? null;
    } catch {
      return null;
    }
  },
};

/**
 * Capabilities that depend on the bridge are reported live rather than latched
 * at module load: the preload installs `window.__rommDesktop` before the app
 * script runs today, but a getter costs nothing and removes the ordering
 * assumption.
 */
const capabilities: HostCapabilities = {
  // The release asset is a single AppImage. We download it, swap the running
  // file, and the swap only takes effect on restart.
  get selfUpdate() {
    return !!bridge()?.restart;
  },
  get exit() {
    return !!bridge()?.quit;
  },
  // No SteamClient out here, so a Steam tile means writing shortcuts.vdf — which
  // needs a launch spec to point at.
  get shortcutTile() {
    return !!bridge()?.launchSpec;
  },
  // ToastHost draws our toasts, so their corner is ours to offer.
  toastPlacement: true,
};

export const host: HostShell = {
  name: "desktop",
  capabilities,
  keyboard,
  app,
  launcher,
  focus,
  // One window, one document — the UI renders straight into it.
  uiDocument: () => document,
};
