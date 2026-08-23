/**
 * Decky Loader on a Steam Deck, as an implementation of Ludo's host contract.
 *
 * Most of this is re-export: on the Deck, Valve and Decky already provide the
 * widget kit and the RPC/toast/router services, and `@decky/ui` is an external
 * global (`window.DFL`) that Decky Loader supplies at runtime rather than
 * something we bundle. What the file adds is the Deck-specific behaviour behind
 * the parts of the contract Decky has no direct answer for — chiefly Steam's
 * on-screen keyboard, which the shared UI used to poke at directly.
 */

// ── Widget kit ──────────────────────────────────────────────────────────────
// Steam's own components, straight through.
export {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  TextField,
  Navigation,
  Router,
  staticClasses,
  DialogButton,
  Focusable,
  GamepadButton,
  showModal,
  ModalRoot,
  showContextMenu,
  Menu,
  MenuItem,
} from "@decky/ui";

// ── Services ────────────────────────────────────────────────────────────────
// Decky's IPC, toaster, router and file picker are already the shape Ludo wants.
export {
  callable,
  toaster,
  routerHook,
  openFilePicker,
  FileSelectionType,
} from "@decky/api";

export type { LaunchSpec } from "./contract";

// ── The shell itself ────────────────────────────────────────────────────────
export { host } from "./shell";
