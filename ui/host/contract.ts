/**
 * What Ludo's UI needs from the shell it is running inside.
 *
 * The UI used to be authored against `@decky/ui` and `@decky/api` — Valve's and
 * Decky's APIs — and the desktop build reached parity by *impersonating* them:
 * a shim under `desktop/src/` was aliased over those specifiers so the same
 * source would compile. That made the Steam Deck the definition of the app and
 * the PC a lookalike, and it left the UI feature-detecting hosts by name
 * (`window.__rommDesktop`) to decide how to behave.
 *
 * This file inverts that. Ludo names the surface; each shell implements it:
 *
 *     decky_plugin/src/host/   →  Decky Loader on a Steam Deck
 *     desktop/src/host/        →  the Electron/WebView shell on a PC
 *
 * Both are reached through the `@ludo/host` specifier, which each build resolves
 * to its own adapter. Nothing in the shared UI imports `@decky/*` any more, and
 * nothing branches on which shell it happens to be in — it asks what the shell
 * can do.
 *
 * Scope note: this covers host *services* and capabilities. Cohesive
 * subsystems get their own seams inside this file rather than being flattened
 * into the capability flags — see `HostLauncher` for the platform's library
 * tile and `HostFocus` for gamepad focus.
 */

/** How to relaunch this shell, for a Steam shortcut that points back at it. */
export type LaunchSpec = {
  exe: string;
  startDir?: string;
  args?: string;
};

/**
 * What this shell can do that another might not.
 *
 * Every flag answers a question about *capability*, never about identity. Ask
 * `capabilities.selfUpdate`, not "am I the desktop build" — a third shell, or a
 * test, should be able to answer these without pretending to be either of the
 * two that exist today.
 */
export type HostCapabilities = {
  /**
   * The shell replaces its own executable when it updates, so the UI must
   * download the asset itself and then prompt for a restart. False where a
   * loader swaps the code in place and no restart is involved.
   */
  selfUpdate: boolean;

  /**
   * The UI can quit the whole application. True in a standalone window; false
   * inside a plugin host, where quitting would mean closing someone else's app.
   */
  exit: boolean;

  /**
   * Steam library tiles are created by writing `shortcuts.vdf` (which needs a
   * LaunchSpec and a Steam restart) rather than through SteamClient's live API.
   */
  shortcutTile: boolean;

  /**
   * The shell draws notification toasts itself, so where they appear on screen
   * is Ludo's choice to offer. False where the platform owns toast presentation.
   */
  toastPlacement: boolean;
};

/**
 * The on-screen keyboard, where the shell provides one.
 *
 * On a Deck this drives Steam's VirtualKeyboardManager; on a PC with a physical
 * keyboard there is nothing to summon and both calls are no-ops. Callers must
 * not care which — that was the point of `_summonVirtualKeyboard()`'s silent
 * `try/catch` in the shared UI, expressed as an interface instead.
 */
export type HostKeyboard = {
  /** Whether this shell has an on-screen keyboard at all. */
  readonly available: boolean;
  /** Raise it for the input that currently holds DOM focus. */
  show(): void;
  /** Dismiss it — e.g. when submitting a field advances a wizard step. */
  hide(): void;
  /** Whether it is currently covering part of the screen. */
  isOpen(): boolean;
};

/** Application-lifetime controls, where the shell owns its own process. */
export type HostApp = {
  /** Quit. No-op unless `capabilities.exit`. */
  quit(): void;
  /** Relaunch, after the executable has been swapped by a self-update. */
  restart(): void;
  /** How to start this shell again, or null if it cannot be determined. */
  launchSpec(): LaunchSpec | null;
};

/**
 * What the app needs from the launcher its shell sits inside, when there is one.
 *
 * On a Deck that is Steam: Ludo keeps a non-Steam shortcut ("RomM") in the
 * library, and a picked game is started by launching that tile so the emulator
 * runs as a Steam-tracked child and inherits the overlay. Every call into that
 * machinery is undocumented and version-fragile, which is exactly why it should
 * live in one adapter rather than threaded through the interface.
 *
 * Where there is no launcher to drive — a plain PC window — `available` is
 * false and every method is an honest no-op. That shell integrates with Steam
 * through the backend instead (it writes shortcuts.vdf; see
 * `capabilities.shortcutTile`), which is a different mechanism with different
 * limits, not a degraded version of this one.
 */
export type HostLauncher = {
  /** A live launcher this shell can drive. False ⇒ every method no-ops. */
  readonly available: boolean;

  /**
   * Begin watching launches and session ends. The hooks let the adapter act on
   * app-level concerns — where the library lives, which routes are ours —
   * without knowing Ludo's routing.
   */
  start(hooks: LauncherHooks): void;

  /** Stop watching and release every registration. Safe to call twice. */
  stop(): void;

  /** Whether a tile exists that a game could be launched through. */
  hasTile(): Promise<boolean>;

  /**
   * Bring the tile to a known-good state: collapse duplicates, repair the
   * survivor's name and artwork. Resolves to its id, or null if there is none.
   */
  reconcileTile(): Promise<number | null>;

  /**
   * Create the tile if it is missing. `force` skips the store-readiness gate,
   * for the user-initiated case where an empty shortcut list is legitimate.
   */
  ensureTile(force?: boolean): Promise<number | null>;

  /**
   * Launch the game the backend has already prepared, through the tile.
   * Resolves false if the launch could not be started, so the caller can fall
   * back to a direct launch.
   */
  launchTile(): Promise<boolean>;

  /** Launch RetroDECK through the platform, rather than as a bare process. */
  launchRetroDeck(): Promise<{ ok: boolean; reason?: string }>;

  /** Bump the tile's recency so it surfaces in the platform's recent games. */
  markRecentlyUsed(): void;

  /**
   * True exactly once after a session ended and returned the user to us. The
   * page that mounts on the way back uses it to re-seed gamepad focus, which
   * the platform does not restore on its own.
   */
  consumeReturnFocus(): boolean;

  /**
   * Subscribe to that same signal; returns an unsubscribe.
   *
   * Consuming it on mount is not sufficient on its own. A game launched from a
   * tile never leaves the library route, so the page is still mounted when the
   * session ends and a mount-only effect never runs again — which is the
   * "launch from Home, come back with nothing selected" case. A shell with no
   * sessions to return from never calls back, and returns a no-op teardown.
   */
  onReturnFocus(cb: () => void): () => void;
};

/**
 * Gamepad focus.
 *
 * This is the one place the two shells diverge in *behaviour* rather than just
 * in API shape, so the contract is deliberately about intent, not mechanism.
 *
 * On a PC, gamepad focus IS DOM focus: `element.focus()` moves it, the browser
 * emits the focus events React listens for, and `document.activeElement` is the
 * answer to "where is it". Every method below is a one-liner there.
 *
 * On a Deck it is a parallel system. Steam runs its own focus-navigation trees
 * in a different document from the one plugin code sees; moving focus through
 * them emits no DOM events, so React never learns focus changed, and after an
 * emulator session the whole context comes back deactivated. The Decky adapter
 * carries all of that — the tree walk, the synthetic event mirror, the
 * reactivation — and none of it is visible here.
 *
 * So do not read these as thin wrappers over `focus()`. They are requests:
 * "put the user's cursor here", "tell me where it is". What that costs is the
 * shell's problem.
 */
export type HostFocus = {
  /**
   * Move the user's visible cursor onto `el`, whatever that takes.
   *
   * Safe to call speculatively and repeatedly — call sites retry on a short
   * ladder because content can arrive after the request — and safe to call
   * with a wrapper element whose real focus target is a descendant.
   */
  force(el: unknown): void;

  /**
   * The element the user's cursor is on right now, or null if it is nowhere
   * useful (nothing focused, or focus sits on the shell's own chrome rather
   * than inside Ludo).
   *
   * Callers use this to answer "has the user moved since we last placed
   * focus?", so returning null must mean *not somewhere meaningful* — never
   * "I could not tell".
   */
  current(): Element | null;

  /**
   * Spend a sacrificial input event to wake the shell's input pipeline.
   *
   * Steam swallows the first button press after an emulator session to
   * reactivate itself, which reads to the user as "I have to press everything
   * twice". Calling this on the way back spends that press for them. A shell
   * with no such quirk does nothing.
   */
  wakeInput(): void;
};

/** App-level callbacks the launcher needs, so routing stays in the app. */
export type LauncherHooks = {
  /** Take the user to Ludo's game browser. */
  openLibrary(): void;
  /** Whether a path belongs to Ludo, as opposed to the platform's own UI. */
  isOwnRoute(path: string): boolean;
};

/** The shell, as the shared UI sees it. */
export type HostShell = {
  /** Short identifier for logs and bug reports — never for branching. */
  readonly name: string;
  readonly capabilities: HostCapabilities;
  readonly keyboard: HostKeyboard;
  readonly app: HostApp;
  readonly launcher: HostLauncher;
  readonly focus: HostFocus;

  /**
   * The document the UI's focused element actually lives in.
   *
   * Usually just `document`, but not on a Deck: plugin code runs in Decky's
   * SharedJSContext, whose global `document` is NOT the Big Picture window's.
   * Querying the wrong one silently returns nothing, which is a miserable class
   * of bug to chase — so ask the shell instead of assuming.
   */
  uiDocument(): Document;
};
