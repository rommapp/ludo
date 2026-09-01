# Ludo — desktop client

A generic build of the sync app, for people running RetroArch **without** a
Steam Deck / Decky. Only Linux is built and shipped (an AppImage); the shell
source is Windows-portable but no Windows artifact is produced or tested.

It shares the UI, the backend and the sync engine with the Decky plugin, and
differs only in the shell around them — see [CONTRIBUTING.md](../CONTRIBUTING.md).
This shell replaces Decky's `callable` IPC with HTTP: `callable` POSTs to
`/api/<method>`, and `backend/server.py` dispatches to `backend.<method>(*args)`.

`npm test` runs both suites in `tests/`:

- **`host-shell.test.mjs`** — the seam. Exercises both shells' adapters in one
  process against `ui/host/contract.ts`.
- **`routes.render.test.mjs`** — the other side of that seam. Mounts the built
  bundle in headless Chromium and walks every route `startApp()` registers,
  asserting each one draws real content with a silent console. `support/`
  holds the fake backend: `fixtures.mjs` answers every RPC with a
  correctly-shaped reply, in an empty profile and a populated one.

  Run it alone with `npm run test:render`. It needs `npm run build` first —
  it deliberately drives `dist/`, because `dist/` is what ships — and it skips
  itself (loudly) if Playwright or the build is missing.

  This exists because `ui/app/` is code both shells render and that nothing
  else covered — and it was written while that code was still one 15k-line
  file, as the net for splitting it up. Its failure mode is not a crash: a reply whose shape drifted,
  or an asset that stopped being packaged, shows up as a page that renders a
  header and nothing else. A build and a typecheck both pass through that
  happily; this does not. It earned its keep immediately — the click-through
  walk surfaced an unhandled promise rejection on every navigation press on any
  machine with no Steam sounds installed.

```
browser (webview)  ──POST /api/get_status──▶  backend/server.py ──▶ LudoBackend.get_status()
   host callable    ◀──── {"result": …} ────                     (sync_core, watchdog)
```

## Run it (dev)

Backend — needs a venv with the engine deps (NOT the Deck-only vendored ones):

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/pip install -e ../engine -e ../app --no-deps   # romm_sync_engine + ludo_app
.venv/bin/python backend/server.py          # serves API + built UI on :8723
```

Frontend:

```bash
npm install
npm run build            # emits dist/, which the backend serves at :8723
# or, for hot-reload dev with the backend proxied:
npm run dev              # Vite on :5173, /api proxied to :8723
```

Then open <http://127.0.0.1:8723> (built) or <http://127.0.0.1:5173> (dev).

## Native window shell (Electron)

`electron/main.cjs` is the desktop window. It replaces the old Linux-only
GTK3/WebKit2GTK shell (`app.py`), which stays in the tree as superseded
reference only — nothing imports it. Same lifecycle as `app.py`: spawn
`backend/server.py` on a free localhost port at launch, load a `BrowserWindow`
at it, and stop the backend cleanly on window close — no background daemon.

```bash
npm run electron       # build the UI, then launch the window
npm run electron:dev   # launch against the Vite dev server (hot reload)
```

The interpreter is `desktop/.venv/bin/python` (or `.venv/Scripts/python.exe` on
Windows) if present, else `python3`/`python`; override with `ROMM_PYTHON`.

### Launch from the host, not from a container (NVIDIA)

**On an NVIDIA host, do not run the app from inside a distrobox/toolbox
container.** It will start, look correct, and render entirely on the CPU.

`/dev/dri` is passed into the container, but that is only half of what NVIDIA
needs: its GL/EGL implementation lives in proprietary userspace libraries
(`libGLX_nvidia`, `libEGL_nvidia`, `libnvidia-glcore`) that must version-match
the host kernel module exactly, and they are not present unless the box was
created with `distrobox create --nvidia`. EGL init fails and Chromium silently
falls back to the SwiftShader software rasterizer.

Mesa has no such split — the driver ships inside the image and needs only the
device node — so **the same container is fast on AMD/Intel**. That asymmetry is
what makes this look like an app performance bug instead of a missing driver.

Measured on one machine (RTX 2080 Ti, 2560×1440@180Hz, Wayland), scrolling the
library:

| Launched from | Renderer | fps |
| --- | --- | --- |
| host | NVIDIA RTX 2080 Ti (OpenGL 4.5) | ~175 |
| distrobox (no `--nvidia`) | SwiftShader (CPU) | unusable |

Build in the container if that is where `npm` lives, but launch outside it. The
host does not need `node` — the Electron binary takes the app directory:

```bash
distrobox enter <box> -- bash -lc 'cd /path/to/ludo/desktop && npm run build'
cd /path/to/ludo/desktop && env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron .
```

`env -u ELECTRON_RUN_AS_NODE` applies the same guard `electron/launch.cjs`
exists to provide; bypassing the launcher means applying it yourself.

Alternatively recreate the box with `distrobox create --nvidia`, then re-check —
that integration has to keep matching the host driver across updates.

The shell warns on startup (`[gpu] SOFTWARE RENDERING`) whenever it detects this,
so check the console before investigating a performance complaint.

What the shell reproduces from `app.py`:

- **Zoom-to-fit** — the UI is authored for the Deck's 1280×800 gamepad viewport,
  so `webContents.setZoomFactor` scales the page so the 800px design height fills
  the window height, re-applied on every resize/(un)fullscreen.
- **Fullscreen by default** — F11 toggles it (Escape is the UI's back key). Set
  `ROMM_FULLSCREEN=0` for a normal window.
- **Gamepad** — `electron/preload.cjs` polls Chromium's native
  `navigator.getGamepads()` and drives the same `window.__rommGamepad` API the UI
  installs. No native module: the GTK build's `libmanette` bridge existed only to
  work around a WebKitGTK Bluetooth-pad bug that Chromium doesn't share. The
  "standard" mapping matches what `src/host/gamepad.ts` expects (see the mapping
  table in `preload.cjs`). If some pad ever misbehaves, `preload.cjs` is the one
  place to add a `node-hid`/XInput fallback.

## Packaging (AppImage)

```bash
npm run dist     # build UI → prepare-runtime.sh → electron-builder
```

`tools/prepare-runtime.sh` is the part that matters: the AppImage has no venv and
no source tree, so it bundles a pinned standalone CPython with the engine
installed into it, plus a mirror of the repo layout the backend expects. The
output lands in `release/` at ~170 MB — an image dramatically smaller than that
means the runtime failed to bundle.

Cutting an actual release is tag-driven and builds this *and* the Decky zip
together — see [RELEASING.md](../RELEASING.md). Don't publish an AppImage to a
GitHub release by hand: the two front-ends share an updater that skips releases
missing either asset.

## Button-hint legend

`src/host/footer.tsx` rebuilds the Deck's bottom hint bar, out of the glyphs in
`src/host/glyphs.tsx` — a generated, committed file; `tools/gen-glyphs.mjs`
documents its regeneration and its artwork licence.

The set follows the device last touched (`lastInputKind()`): press the pad and it
shows that pad's art — `controllerFamily()` picks Xbox / PlayStation / Switch /
neutral by USB vendor ID — reach for the keyboard or mouse and it shows
Enter/Esc. Before anything has been touched (`lastInputKind()` is null) it leans
on the pad, so a launch with a controller attached already shows pad glyphs.

One subtlety in that "last touched" signal: the FIRST mousemove is ignored.
Opening the window under a stationary cursor makes Chromium synthesise one, and
counting it handed the legend to the keyboard set at launch even with a pad
plugged in. Real mouse use always produces a second, differing position. The neutral
set uses the Steam Deck art, the only one in the pack with plain grey lettered
ABXY. Note `padConnected()` is tracked separately from the family because an
unrecognised pad reports family "neutral" — indistinguishable from no pad.

**Getting the first frame right.** Chromium refuses to reveal a gamepad until the
user presses something on it (anti-fingerprinting), so at launch `getGamepads()`
is empty even with a pad plugged in — the legend would open on keyboard glyphs
every time. The page can't ask "is a pad attached", so the shell asks the OS:
`electron/native-pads.cjs` scans `/sys/class/input` for devices advertising
`BTN_SOUTH` and hands the list to the renderer via `window.__rommNativePads()`
(installed in `preload.cjs`). `refreshFamily()` falls back to it whenever the
Gamepad API reports nothing, so the correct family is known on frame one.

Two traps worth keeping in mind if you touch that file:

- **Don't classify by "has a `jsN` node".** joydev creates one for anything with
  axes and buttons, so virtual pointer devices qualify — a "Mouse passthrough
  (absolute)" held `js0` on the dev machine and outranked the real pad on `js1`.
  `BTN_SOUTH` is what udev and SDL use, and it excludes such devices cleanly.
- **`null` means "can't tell", not "no pad".** Non-Linux platforms return null,
  and it must never be read as a negative. Windows has no dependency-free
  enumeration (it needs XInput/HID via a native addon), so there the legend falls
  back to the remembered family in `localStorage` — persisted whenever a pad is
  seen, retired by the first real keypress or pointer move (`sawKbmInput()`), and
  deliberately *not* cleared on disconnect.

Both `gamepadconnected` and `gamepaddisconnected` are unreliable (the former
doesn't fire until a press, the latter often not at all on unplug), so
`refreshFamily` is also polled every 2s; it only notifies subscribers on an
actual change.

The keyboard/mouse set advertises only bindings that exist, so `Focusable`
(`src/host/kit.tsx`) gained desktop equivalents for the pad's non-primary face
buttons — without them the legend would name actions no keyboard could reach:

| Action | Pad | Keyboard / mouse |
| --- | --- | --- |
| Navigate | D-pad / stick | arrow keys, pointer |
| Confirm | A | Enter, Space, left click |
| Alternate | X | Shift+Enter, Shift+click |
| Options | Y | right click, Menu key |
| Back | B | Escape |
| Select / Start | View / Menu | *(no equivalent — hint hidden)* |

Arrow keys route into `direction()` in `gamepad.ts` — the *same* function the pad
drives, so keyboard nav inherits spatial movement, hold-to-repeat and
scroll-into-view rather than reimplementing them. Left unhandled they'd fall
through to Chromium, which scrolls the page without moving focus. They're ignored
inside text fields (the caret needs them) and when a modifier is held.

The NVIDIA/Wayland `__NV_DISABLE_EXPLICIT_SYNC` workaround from `app.py` is
deliberately **not** ported — it's a WebKitGTK-specific bug.

Installers/AppImage packaging are a separate follow-up.

## Steam library tile

The setup wizard's last step ("Ready to go") offers this as an opt-in toggle, on
by default, and applies it in `doFinish` — the same place the Deck build creates
its mandatory tile. Afterwards it lives in
Settings → Steam → *Add to Steam library*, which creates a "RomM" non-Steam shortcut
that launches this shell, mirroring the tile the Decky plugin puts in Big
Picture. The mechanism differs by necessity: the plugin calls
`SteamClient.Apps.AddShortcut`, a live API that exists only inside Steam's own
UI process, while here the backend edits `shortcuts.vdf` directly
(`add_desktop_tile` / `remove_desktop_tile` in `src/sync_core.py`) and drops the
bundled RomM artwork into `userdata/<id>/config/grid/`.

Two consequences worth knowing:

* **Steam must be restarted.** It holds shortcuts in memory and rewrites the file
  on exit, so a tile written underneath a running Steam is discarded. The
  Settings row says so after you toggle it.
* The tile is tagged `romm-sync-desktop`, so it's found and updated in place even
  if the launch path changes — no duplicate tiles pile up, and the GTK app's own
  `romm-sync` per-ROM shortcuts are left untouched.

The launch command comes from the main process (`romm:launch-spec`), which is the
only side that knows whether we're running as an AppImage (`$APPIMAGE`), a
packaged binary (`process.execPath`) or a dev checkout (electron binary + app
dir).

## Status

Wired and working end-to-end: the engine boots, connects to RomM, and every
`/api/<method>` dispatches to the real plugin backend. The Electron shell boots
the backend, loads the UI, and the round-trip (window → shim `callable` → POST
`/api` → engine) is verified. There is intentionally **no background daemon** —
the engine runs only while the app is open (see the project discussion); sync
catches up on next launch via the startup pass.

## What is NOT here

No Steam system bars and no in-Gaming-Mode background sync — those are
Deck/Decky-native and stay in the plugin. Gamepad *focus navigation* works here
via the shim; this client targets desktop Linux with a controller or
mouse + keyboard.
