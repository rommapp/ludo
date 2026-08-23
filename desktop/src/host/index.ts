/**
 * The PC shell, as an implementation of Ludo's host contract.
 *
 * These files used to be a *shim*: web stand-ins aliased over `@decky/ui` and
 * `@decky/api` so the shared UI, authored against Decky, would compile on a
 * desktop. They are the same implementations, but they are no longer
 * impersonating anything — they satisfy an interface Ludo owns, alongside the
 * Decky adapter, and neither is downstream of the other.
 *
 * The widget kit (`kit.tsx`) and services (`services.tsx`) carry the detail;
 * this file is the front door the `@ludo/host` specifier resolves to.
 */
// ── Widget kit ──────────────────────────────────────────────────────────────
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
} from "./kit";

// ── Services ────────────────────────────────────────────────────────────────
export {
  callable,
  definePlugin,
  toaster,
  routerHook,
  openFilePicker,
  FileSelectionType,
} from "./services";

export type { LaunchSpec } from "../../../ui/host/contract";

// ── The shell itself ────────────────────────────────────────────────────────
export { host } from "./shell";
