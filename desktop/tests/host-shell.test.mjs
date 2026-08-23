/**
 * Both shells, checked against the one contract they share.
 *
 * This is the test the old arrangement could not have: the UI decided how to
 * behave by looking for `window.__rommDesktop`, so "what does the Deck do here"
 * and "what does the PC do here" were only answerable by running on a Deck and
 * on a PC. Now each shell is an object implementing ui/host/contract.ts, and
 * both can be built and interrogated in the same process with stubs.
 *
 * Run with:  npm test        (from desktop/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let cacheBust = 0;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

/**
 * Bundle one shell to a data: URL so it can be imported with stubbed globals.
 * `@decky/ui` is a runtime global on a Deck (window.DFL), never something we
 * bundle, so the Decky shell gets a stub in its place.
 */
async function loadShell(entry, { deckyUi } = {}) {
  const stub = deckyUi
    ? {
        name: "stub-decky",
        setup(b) {
          // On a Deck these are runtime globals Decky Loader supplies, never
          // something we bundle — so they have to be stood in for here.
          b.onResolve({ filter: /^@decky\/(ui|api)$/ }, (a) => ({
            path: a.path.endsWith("/api") ? "api" : "ui",
            namespace: "stub",
          }));
          b.onLoad({ filter: /^ui$/, namespace: "stub" }, () => ({
            // A getter, not a binding: each test installs a fresh stub, and the
            // shell must read whatever is current rather than whatever existed
            // when the module first evaluated.
            contents: `export const Router = {
              get WindowStore() { return globalThis.__stubRouter?.WindowStore; },
            };`,
            loader: "js",
          }));
          b.onLoad({ filter: /^api$/, namespace: "stub" }, () => ({
            contents: `
              export const callable = (m) => async (...a) => {
                (globalThis.__rpcCalls ??= []).push([m, a]);
                return globalThis.__rpcReply?.[m] ?? null;
              };
              export const toaster = {
                toast: (o) => (globalThis.__toasts ??= []).push(o),
              };`,
            loader: "js",
          }));
        },
      }
    : null;
  const out = await build({
    entryPoints: [resolve(REPO, entry)],
    bundle: true,
    format: "esm",
    write: false,
    platform: "neutral",
    plugins: stub ? [stub] : [],
  });
  // Node caches modules by URL, so give each load a distinct one — otherwise
  // every test after the first would silently reuse the first one's stubs.
  const code = out.outputFiles[0].text + `\n//${cacheBust++}`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const DESKTOP = "desktop/src/host/shell.ts";
const DECKY = "decky_plugin/src/host/shell.ts";

// ── The PC shell ────────────────────────────────────────────────────────────

test("desktop: with no preload bridge, it claims nothing it cannot do", async () => {
  globalThis.window = {};
  globalThis.document = {};
  const { host } = await loadShell(DESKTOP);
  assert.equal(host.name, "desktop");
  assert.equal(host.capabilities.exit, false);
  assert.equal(host.capabilities.selfUpdate, false);
  assert.equal(host.capabilities.shortcutTile, false);
  assert.equal(host.app.launchSpec(), null);
  // ...and calling through anyway must not throw. The UI gates on capabilities,
  // but a no-op is the honest fallback, not an exception.
  assert.doesNotThrow(() => host.app.quit());
  assert.doesNotThrow(() => host.app.restart());
});

test("desktop: the bridge turns capabilities on, and calls reach it", async () => {
  const calls = [];
  const spec = { exe: "/opt/Ludo.AppImage", startDir: "/opt", args: "" };
  globalThis.window = {
    __rommDesktop: {
      quit: () => calls.push("quit"),
      restart: () => calls.push("restart"),
      launchSpec: () => spec,
    },
  };
  globalThis.document = {};
  const { host } = await loadShell(DESKTOP);
  assert.equal(host.capabilities.exit, true);
  assert.equal(host.capabilities.selfUpdate, true);
  assert.equal(host.capabilities.shortcutTile, true);
  assert.deepEqual(host.app.launchSpec(), spec);
  host.app.quit();
  host.app.restart();
  assert.deepEqual(calls, ["quit", "restart"]);
});

test("desktop: a PC has a real keyboard, so there is none to summon", async () => {
  globalThis.window = {};
  globalThis.document = {};
  const { host } = await loadShell(DESKTOP);
  assert.equal(host.keyboard.available, false);
  assert.equal(host.keyboard.isOpen(), false);
  assert.doesNotThrow(() => host.keyboard.show());
  assert.doesNotThrow(() => host.keyboard.hide());
});

test("desktop: toasts are ours to place, and there is one document", async () => {
  const doc = { marker: "the only document" };
  globalThis.window = {};
  globalThis.document = doc;
  const { host } = await loadShell(DESKTOP);
  assert.equal(host.capabilities.toastPlacement, true);
  assert.equal(host.uiDocument(), doc);
});

// ── The Deck shell ──────────────────────────────────────────────────────────

/** Enough of Steam's window store for the shell to talk to. */
function stubSteam({ keyboardOpen = false } = {}) {
  const events = [];
  const bpDocument = { marker: "big picture document", activeElement: null };
  const keyboard = {
    m_bIsInlineVirtualKeyboardOpen: { m_currentValue: keyboardOpen },
    CreateVirtualKeyboardRef: () => ({ ShowVirtualKeyboard: () => events.push("show") }),
    SetVirtualKeyboardDone: () => events.push("done"),
  };
  globalThis.__stubRouter = {
    WindowStore: {
      GamepadUIMainWindowInstance: {
        VirtualKeyboardManager: keyboard,
        BrowserWindow: { document: bpDocument },
      },
    },
  };
  globalThis.window = {};
  globalThis.document = { marker: "shared js context document" };
  return { events, bpDocument, keyboard };
}

test("decky: as a plugin, it owns no process and updates in place", async () => {
  stubSteam();
  const { host } = await loadShell(DECKY, { deckyUi: true });
  assert.equal(host.name, "decky");
  // Quitting would close Steam, not us.
  assert.equal(host.capabilities.exit, false);
  // Decky Loader swaps the plugin; there is no executable to replace.
  assert.equal(host.capabilities.selfUpdate, false);
  // Steam is right here — tiles go through its live API, not shortcuts.vdf.
  assert.equal(host.capabilities.shortcutTile, false);
  // SteamOS owns toast presentation.
  assert.equal(host.capabilities.toastPlacement, false);
  assert.equal(host.app.launchSpec(), null);
  assert.doesNotThrow(() => host.app.quit());
});

test("decky: the on-screen keyboard is Steam's, and it is reachable", async () => {
  const { events, bpDocument } = stubSteam();
  const { host } = await loadShell(DECKY, { deckyUi: true });
  assert.equal(host.keyboard.available, true);
  assert.equal(host.keyboard.isOpen(), false);

  // show() only acts on a focused <input>, and defers — matching the on-device
  // behaviour it replaced.
  bpDocument.activeElement = { tagName: "INPUT" };
  host.keyboard.show();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(events, ["show"]);

  host.keyboard.hide();
  assert.deepEqual(events, ["show", "done"]);
});

test("decky: show() does nothing when focus is not on an input", async () => {
  const { events, bpDocument } = stubSteam();
  const { host } = await loadShell(DECKY, { deckyUi: true });
  bpDocument.activeElement = { tagName: "DIV" };
  host.keyboard.show();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(events, []);
});

test("decky: an already-open keyboard is not summoned again", async () => {
  const { events, bpDocument } = stubSteam({ keyboardOpen: true });
  const { host } = await loadShell(DECKY, { deckyUi: true });
  assert.equal(host.keyboard.isOpen(), true);
  bpDocument.activeElement = { tagName: "INPUT" };
  host.keyboard.show();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(events, []);
});

test("decky: uiDocument is Big Picture's, NOT the plugin context's", async () => {
  const { bpDocument } = stubSteam();
  const { host } = await loadShell(DECKY, { deckyUi: true });
  // The bug this prevents: querying the SharedJSContext document silently
  // returns nothing, because that is not where the UI is rendered.
  assert.equal(host.uiDocument(), bpDocument);
  assert.notEqual(host.uiDocument(), globalThis.document);
});

test("decky: with Steam's globals absent, nothing throws", async () => {
  globalThis.__stubRouter = undefined;
  globalThis.window = {};
  globalThis.document = { marker: "fallback" };
  const { host } = await loadShell(DECKY, { deckyUi: true });
  assert.equal(host.keyboard.isOpen(), false);
  assert.doesNotThrow(() => host.keyboard.show());
  assert.doesNotThrow(() => host.keyboard.hide());
  assert.equal(host.uiDocument(), globalThis.document);
});

// ── Both ────────────────────────────────────────────────────────────────────

test("both shells expose the same surface", async () => {
  globalThis.window = {};
  globalThis.document = {};
  const desktop = (await loadShell(DESKTOP)).host;
  stubSteam();
  const decky = (await loadShell(DECKY, { deckyUi: true })).host;

  assert.deepEqual(Object.keys(desktop).sort(), Object.keys(decky).sort());
  assert.deepEqual(
    Object.keys(desktop.capabilities).sort(),
    Object.keys(decky.capabilities).sort(),
  );
  for (const shell of [desktop, decky]) {
    for (const fn of ["quit", "restart", "launchSpec"]) {
      assert.equal(typeof shell.app[fn], "function", `${shell.name}.app.${fn}`);
    }
    for (const fn of ["show", "hide", "isOpen"]) {
      assert.equal(typeof shell.keyboard[fn], "function", `${shell.name}.keyboard.${fn}`);
    }
    for (const fn of ["force", "current", "wakeInput"]) {
      assert.equal(typeof shell.focus[fn], "function", `${shell.name}.focus.${fn}`);
    }
    assert.equal(typeof shell.uiDocument, "function");
  }
});

// ── The launcher ────────────────────────────────────────────────────────────
//
// Steam's library-tile machinery only runs on a Deck, so before it was behind
// this seam nothing could exercise it at all. These do not prove the
// undocumented SteamClient calls are right — only a Deck can — but they do
// pin the contract around them: what happens when Steam is absent, that the
// desktop degrades honestly, and that the app can always fall back.

/** Steam's client surface, enough for the launcher to drive. */
function stubSteamClient({ shortcuts = {}, runGameThrows = false } = {}) {
  const calls = [];
  globalThis.window = {
    SteamClient: {
      Apps: {
        RunGame: async (...a) => {
          calls.push(["RunGame", ...a]);
          if (runGameThrows) throw new Error("RunGame unavailable");
        },
        TerminateApp: (...a) => calls.push(["TerminateApp", ...a]),
        SetShortcutName: async () => {},
        SetShortcutLaunchOptions: async () => {},
        RegisterForGameActionStart: (cb) => {
          globalThis.__onGameAction = cb;
          return { unregister: () => calls.push(["unregister:action"]) };
        },
      },
      GameSessions: {
        RegisterForAppLifetimeNotifications: (cb) => {
          globalThis.__onLifetime = cb;
          return { unregister: () => calls.push(["unregister:lifetime"]) };
        },
      },
    },
    collectionStore: {
      deckDesktopApps: { apps: new Map(Object.keys(shortcuts).map((k) => [Number(k), {}])) },
      allAppsCollection: { allApps: [] },
    },
    appStore: {
      GetAppOverviewByAppID: (id) => shortcuts[id],
      m_mapApps: new Map(),
    },
  };
  globalThis.document = {};
  globalThis.__stubRouter = { WindowStore: { GamepadUIMainWindowInstance: {} } };
  return calls;
}

test("desktop: no launcher to drive, and it says so", async () => {
  globalThis.window = {};
  globalThis.document = {};
  const { host } = await loadShell(DESKTOP);
  assert.equal(host.launcher.available, false);
  assert.equal(await host.launcher.hasTile(), false);
  assert.equal(await host.launcher.reconcileTile(), null);
  assert.equal(await host.launcher.ensureTile(true), null);
  // False, so launchGameSmart falls back to launching the emulator directly.
  assert.equal(await host.launcher.launchTile(), false);
  assert.equal(host.launcher.consumeReturnFocus(), false);
  assert.doesNotThrow(() => host.launcher.markRecentlyUsed());
  assert.doesNotThrow(() => host.launcher.start({ openLibrary() {}, isOwnRoute: () => true }));
  assert.doesNotThrow(() => host.launcher.stop());
});

test("desktop: RetroDECK still launches, just not Steam-tracked", async () => {
  globalThis.window = {};
  globalThis.document = {};
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push([url, JSON.parse(init.body)]);
    return { ok: true, json: async () => ({ result: { ok: true } }) };
  };
  const { host } = await loadShell(DESKTOP);
  assert.deepEqual(await host.launcher.launchRetroDeck(), { ok: true });
  assert.deepEqual(seen, [["/api/launch_retrodeck", { args: [] }]]);
  delete globalThis.fetch;
});

test("desktop: a backend failure is reported, not thrown", async () => {
  globalThis.window = {};
  globalThis.document = {};
  globalThis.fetch = async () => { throw new Error("backend down"); };
  const { host } = await loadShell(DESKTOP);
  const r = await host.launcher.launchRetroDeck();
  assert.equal(r.ok, false);
  assert.match(r.reason, /backend down/);
  delete globalThis.fetch;
});

test("decky: with Steam present the launcher is available", async () => {
  stubSteamClient();
  const { host } = await loadShell(DECKY, { deckyUi: true });
  assert.equal(host.launcher.available, true);
});

test("decky: with Steam absent it degrades instead of throwing", async () => {
  globalThis.window = {};          // no SteamClient at all
  globalThis.document = {};
  globalThis.__stubRouter = undefined;
  const { host } = await loadShell(DECKY, { deckyUi: true });
  assert.equal(host.launcher.available, false);
  assert.equal(await host.launcher.hasTile(), false);
  assert.equal(await host.launcher.reconcileTile(), null);
  assert.equal(await host.launcher.ensureTile(true), null);
  assert.equal(await host.launcher.launchTile(), false);
  assert.doesNotThrow(() => host.launcher.start({ openLibrary() {}, isOwnRoute: () => true }));
  assert.doesNotThrow(() => host.launcher.stop());
});

test("decky: launchTile refuses when no tile has been resolved", async () => {
  const calls = stubSteamClient();
  const { host } = await loadShell(DECKY, { deckyUi: true });
  // hasTile() was never called, so there is no appid to launch.
  assert.equal(await host.launcher.launchTile(), false);
  assert.deepEqual(calls.filter((c) => c[0] === "RunGame"), []);
});

test("decky: a resolved tile is launched by its 64-bit gameID", async () => {
  const appid = 1234567890;
  const calls = stubSteamClient({
    shortcuts: { [appid]: { display_name: "RomM", app_type: 1073741824 } },
  });
  const { host } = await loadShell(DECKY, { deckyUi: true });
  assert.equal(await host.launcher.hasTile(), true);
  assert.equal(await host.launcher.launchTile(), true);
  const run = calls.find((c) => c[0] === "RunGame");
  assert.ok(run, "RunGame was called");
  // gameID = (appid << 32) | 0x02000000 — the shortcut tag.
  assert.equal(run[1], ((BigInt(appid) << 32n) | 0x2000000n).toString());
});

test("decky: a failed RunGame reports false so the app can fall back", async () => {
  const appid = 42;
  stubSteamClient({
    shortcuts: { [appid]: { display_name: "RomM", app_type: 1073741824 } },
    runGameThrows: true,
  });
  const { host } = await loadShell(DECKY, { deckyUi: true });
  assert.equal(await host.launcher.hasTile(), true);
  assert.equal(await host.launcher.launchTile(), false);
});

test("decky: stop() releases both registrations and is safe twice", async () => {
  const calls = stubSteamClient();
  const { host } = await loadShell(DECKY, { deckyUi: true });
  host.launcher.start({ openLibrary() {}, isOwnRoute: () => true });
  host.launcher.stop();
  assert.deepEqual(
    calls.filter((c) => String(c[0]).startsWith("unregister")).map((c) => c[0]),
    ["unregister:action", "unregister:lifetime"],
  );
  assert.doesNotThrow(() => host.launcher.stop());
});

test("decky: a bare tile click is terminated and opens the library", async () => {
  const appid = 777;
  const calls = stubSteamClient({
    shortcuts: { [appid]: { display_name: "RomM", app_type: 1073741824 } },
  });
  const { host } = await loadShell(DECKY, { deckyUi: true });
  let opened = 0;
  host.launcher.start({ openLibrary: () => opened++, isOwnRoute: (p) => p.startsWith("/romm-sync") });

  // Steam reports a launch of our tile that we did not initiate.
  globalThis.__onGameAction(6, String(appid));
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(calls.some((c) => c[0] === "TerminateApp"), "the no-op exe is terminated");
  assert.equal(opened, 1, "and the game browser is opened instead");
});

test("decky: our own launch is left alone, and the session end returns focus", async () => {
  const appid = 888;
  const calls = stubSteamClient({
    shortcuts: { [appid]: { display_name: "RomM", app_type: 1073741824 } },
  });
  const { host } = await loadShell(DECKY, { deckyUi: true });
  let opened = 0;
  host.launcher.start({ openLibrary: () => opened++, isOwnRoute: (p) => p.startsWith("/romm-sync") });

  await host.launcher.hasTile();
  await host.launcher.launchTile();               // marks the launch as ours
  globalThis.__onGameAction(6, String(appid));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!calls.some((c) => c[0] === "TerminateApp"), "a picked-game launch runs");
  assert.equal(opened, 0, "and does not bounce the user to the library");

  // The emulator exits.
  assert.equal(host.launcher.consumeReturnFocus(), false, "not until the session ends");
  globalThis.__onLifetime({ bRunning: false, unAppID: appid });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(opened, 1, "the game browser comes back");
  assert.equal(host.launcher.consumeReturnFocus(), true, "and focus is re-seeded");
  assert.equal(host.launcher.consumeReturnFocus(), false, "exactly once");

  host.launcher.stop();
});

// ── Gamepad focus ───────────────────────────────────────────────────────────
//
// The one part of the contract where the two shells differ in behaviour and
// not just in API: on a PC the gamepad cursor IS DOM focus, on a Deck it is a
// parallel system with its own trees, its own document, and no DOM events.
// These check that the shared UI's three questions get honest answers from
// both, including in the post-session degraded state the Deck code exists for.

test("desktop: focus is DOM focus, and body means nowhere", async () => {
  const focused = [];
  const body = { tag: "body" };
  const el = { tag: "button", focus: () => focused.push("button") };
  globalThis.window = {};
  globalThis.document = { body, activeElement: null };
  const { host } = await loadShell(DESKTOP);

  assert.equal(host.focus.current(), null, "nothing focused");
  globalThis.document.activeElement = body;
  assert.equal(host.focus.current(), null, "body is the absence of focus, not a target");
  globalThis.document.activeElement = el;
  assert.equal(host.focus.current(), el);

  host.focus.force(el);
  assert.deepEqual(focused, ["button"], "force() is just focus() here");
  // No input pipeline to wake, and an element that cannot take focus is not
  // an error — the UI forces speculatively, on a retry ladder.
  assert.doesNotThrow(() => host.focus.wakeInput());
  assert.doesNotThrow(() => host.focus.force({}));
  assert.doesNotThrow(() => host.focus.force(null));
});

test("decky: focus is read from Big Picture's document, not the plugin's", async () => {
  const { bpDocument } = stubSteam();
  // The plugin context has its own document with its own .gpfocus. Reading
  // that one is the bug this indirection exists to prevent.
  globalThis.document.querySelector = () => ({ tag: "WRONG DOCUMENT" });
  const marked = { tag: "tile" };
  bpDocument.querySelector = (sel) => (sel === ".gpfocus" ? marked : null);
  globalThis.window.FocusNavController = { m_ActiveContext: { m_rootWindow: { document: bpDocument } } };

  const { host } = await loadShell(DECKY, { deckyUi: true });
  assert.equal(host.focus.current(), marked);
});

test("decky: a deactivated context still answers, via the last active one", async () => {
  const { bpDocument } = stubSteam();
  const marked = { tag: "tile" };
  bpDocument.querySelector = (sel) => (sel === ".gpfocus" ? marked : null);
  // Exactly the post-emulator-session state: m_ActiveContext is gone.
  globalThis.window.FocusNavController = {
    m_ActiveContext: undefined,
    m_LastActiveContext: { m_rootWindow: { document: bpDocument } },
  };
  const { host } = await loadShell(DECKY, { deckyUi: true });
  assert.equal(host.focus.current(), marked, "focus is still findable while healing");
});

test("decky: with no controller at all, focus reports nowhere", async () => {
  stubSteam();
  const { host } = await loadShell(DECKY, { deckyUi: true });
  assert.equal(host.focus.current(), null);
  assert.doesNotThrow(() => host.focus.force({}));
  assert.doesNotThrow(() => host.focus.wakeInput());
});

test("decky: a healthy, OS-focused window takes the cheap path", async () => {
  stubSteam();
  const focused = [];
  const el = { focus: () => focused.push("el") };
  let walked = false;
  globalThis.window.FocusNavController = {
    m_ActiveContext: {
      BIsActive: () => true,
      m_rootWindow: { document: { hasFocus: () => true } },
      get m_rgGamepadNavigationTrees() { walked = true; return []; },
    },
  };
  const { host } = await loadShell(DECKY, { deckyUi: true });
  host.focus.force(el);
  assert.deepEqual(focused, ["el"], "plain focus() already landed it");
  assert.equal(walked, false, "so the nav-tree walk is skipped — it runs on every tab switch");
});

test("decky: post-session, focus is taken through the nav tree and mirrored", async () => {
  const { bpDocument } = stubSteam();
  const el = { focus() { }, contains: () => false };
  const took = [];
  let activated = false;
  const node = { m_element: el, m_rgChildren: [], BTakeFocus: (n) => (took.push(n), true) };
  const tree = { m_ID: "GamepadUI_Full_Root", m_Root: { m_rgChildren: [node] } };
  // The degraded state: context deactivated, window not OS-focused.
  const ctx = {
    BIsActive: () => activated,
    SetActive: (v) => { activated = v; },
    SetActiveNavTree: () => { },
    m_rgGamepadNavigationTrees: [tree],
    m_rootWindow: { document: bpDocument },
  };
  globalThis.window.FocusNavController = { m_ActiveContext: ctx, m_rgAllContexts: [ctx] };

  // The mirror synthesizes the focus events Steam does not emit.
  const fired = [];
  bpDocument.activeElement = { dispatchEvent: (e) => fired.push(e.type) };
  bpDocument.body = {};
  bpDocument.querySelector = () => null;
  bpDocument.defaultView = {
    FocusEvent: class { constructor(type) { this.type = type; } },
    MutationObserver: class { observe() { } disconnect() { } },
  };

  // The mirror arms a long leak-guard timeout and a healing-window interval,
  // both of which would hold this process open. In a browser they are free;
  // here we just record that they were armed.
  const realTimeout = globalThis.setTimeout, realInterval = globalThis.setInterval;
  const armed = [];
  globalThis.setTimeout = (_fn, ms) => (armed.push(["timeout", ms]), 0);
  globalThis.setInterval = (_fn, ms) => (armed.push(["interval", ms]), 0);
  let host;
  try {
    ({ host } = await loadShell(DECKY, { deckyUi: true }));
    host.focus.force(el);
  } finally {
    globalThis.setTimeout = realTimeout;
    globalThis.setInterval = realInterval;
  }
  assert.ok(
    armed.some(([k, ms]) => k === "interval" && ms === 300),
    "the context is re-asserted through Steam's healing window",
  );

  assert.deepEqual(took, [3], "focus was taken through the controller");
  assert.equal(activated, true, "and the dead context was reactivated first");
  assert.deepEqual(fired, ["focusin"], "React is told focus moved, so overlays show");
});

test("decky: wakeInput spends the press Steam would have swallowed", async () => {
  stubSteam();
  const presses = [];
  globalThis.window.FocusNavController = {
    DispatchVirtualButtonClick: (btn, down) => presses.push([btn, down]),
  };
  const { host } = await loadShell(DECKY, { deckyUi: true });
  host.focus.wakeInput();
  assert.deepEqual(presses, [[0, true]], "button 0 is INVALID — deliberately unbound");
});
