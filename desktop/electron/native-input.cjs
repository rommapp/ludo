// Gamepad INPUT read straight from the kernel, for pads Chromium won't hand to
// the renderer.
//
// Why this exists (measured, not assumed): Chromium only exposes a gamepad to a
// page after the user presses a button on it, and on Linux a pad that is turned
// on AFTER the window opened never clears that bar — navigator.getGamepads()
// keeps returning an empty list no matter how many buttons are pressed, with the
// window focused the whole time. A pad present at launch works fine. Captured
// side by side, kernel vs. Chromium, same seconds:
//
//   [native]   A = 1                       ← every press arrives here
//   [chromium] hasFocus=true (none visible) ← every frame, for the whole capture
//
// So preload.cjs's navigator.getGamepads() poll — correct for a pad that was
// already on — is deaf to a hot-plugged one, which is exactly when a user reaches
// for the controller. The footer legend still updated (it comes from the sysfs
// scan in native-pads.cjs), making it look like the app had noticed the pad while
// nothing responded to it.
//
// This module fills that hole: it reads the pad's evdev node itself and hands the
// events to the renderer, which feeds them to the same window.__rommGamepad API
// the Chromium poll drives. The renderer prefers Chromium whenever Chromium is
// actually reporting a pad, so only the pads the browser refuses to surface come
// from here — see preload.cjs.
//
// LINUX ONLY: it depends on evdev and on the sysfs scan in native-pads.cjs.
// Elsewhere start() is a no-op and the Chromium poll remains the only path.
//
// evdev, not joydev (/dev/input/jsN), deliberately: joydev button and axis
// NUMBERS vary by driver, while evdev reports stable kernel CODES — the same
// codes the GTK shell's libmanette bridge used, so the mapping below is the table
// already documented in gamepad_bridge.py and preload.cjs.

const fs = require("fs");
const { spawnSync } = require("child_process");
const { findNativePads } = require("./native-pads.cjs");

// GamepadButtonId, as used by the plugin UI (mirrors preload.cjs).
const OK = 1, CANCEL = 2, SECONDARY = 3, OPTIONS = 4;
const START = 5, SELECT = 6, TRIGGER_LEFT = 7, TRIGGER_RIGHT = 8;
const BUMPER_LEFT = 9, BUMPER_RIGHT = 10;

// struct input_event = struct timeval (2×64-bit on a 64-bit kernel) + __u16 type
// + __u16 code + __s32 value. Electron ships 64-bit builds only, so 24 bytes.
const EVENT_SIZE = 24;
const EV_KEY = 0x01, EV_ABS = 0x03;

// EV_KEY codes → GamepadButtonId.
const KEY_MAP = {
  0x130: OK,            // BTN_SOUTH  (A)
  0x131: CANCEL,        // BTN_EAST   (B)
  0x133: SECONDARY,     // BTN_NORTH  (X on an Xbox pad's kernel numbering)
  0x134: OPTIONS,       // BTN_WEST   (Y)
  0x136: BUMPER_LEFT,   // BTN_TL
  0x137: BUMPER_RIGHT,  // BTN_TR
  0x138: TRIGGER_LEFT,  // BTN_TL2 — pads that report triggers as buttons
  0x139: TRIGGER_RIGHT, // BTN_TR2
  0x13a: SELECT,        // BTN_SELECT (Back/View)
  0x13b: START,         // BTN_START  (Start/Menu)
};

// Some pads (and some kernels) deliver the d-pad as buttons instead of a hat.
const DPAD_KEYS = { 0x220: "up", 0x221: "down", 0x222: "left", 0x223: "right" };

const ABS_X = 0x00, ABS_Y = 0x01, ABS_Z = 0x02, ABS_RZ = 0x05;
const ABS_HAT0X = 0x10, ABS_HAT0Y = 0x11;

// Stick deflection past which a direction counts as pressed, as a FRACTION of the
// axis range — 0.6 matches STICK_DEADZONE in preload.cjs and gamepad_bridge.py.
const STICK_DEADZONE = 0.6;
// Analog triggers, same 0.3 threshold the other two paths use.
const TRIGGER_ON = 0.3;

// Axis ranges differ per pad and guessing them is not survivable, so ASK the
// kernel: EVIOCGABS reports each axis's real minimum, maximum and current value.
// Node has no ioctl, so the query runs in the Python interpreter this app already
// ships and spawns for its backend (see absInfoFor below). When that is
// unavailable the assumption below is the fallback, and it is only ever a
// fallback now.
//
// This used to be assumption-only, and the assumption — signed 16-bit, as
// xpad reports — is wrong for an Xbox pad on BLUETOOTH, which reports
// 0..65535 centred near 32768. Measured on one:
//
//   ABS_X value=32311 min=0 max=65535     ← resting
//   ABS_Y value=33091 min=0 max=65535     ← resting
//
// Divided by 32767 that resting stick reads 0.99 — past the deadzone — so the
// pad announced a permanent "down". Vertical beats horizontal in
// updateDirection, so Left/Right/Down did nothing at all, D-pad Up won only
// while held, and releasing it handed the grid straight back to the phantom
// down: focus "moved up, then snapped back", and a held press walked to the
// bottom of the library. Only for a pad connected AFTER launch, because that is
// exactly when Chromium refuses to report it and this reader is the only source.
function normalizeStick(seen, code, value, abs) {
  // Kernel-reported range: centre is the midpoint, scale is the half-range.
  const info = abs && abs[code];
  if (info && info.max > info.min) {
    const mid = (info.max + info.min) / 2;
    const half = (info.max - info.min) / 2;
    return (value - mid) / half;
  }
  let s = seen.get(code);
  if (!s) { s = { max: value, min: value }; seen.set(code, s); }
  if (value > s.max) s.max = value;
  if (value < s.min) s.min = value;
  if (s.min >= 0 && s.max <= 255 && s.max >= 200) return (value - 128) / 127;
  // Never seen a negative value, but values far outside a signed-16 stick's
  // resting band: an unsigned range this code could not measure. Treat it as
  // centred rather than divide by a scale that makes rest look like full
  // deflection — the failure above, in the case where the ioctl is unavailable.
  if (s.min >= 0 && s.max > 4096) return (value - 32768) / 32768;
  return value / 32767;
}

// EVIOCGABS for every axis this module reads, via the bundled Python.
//
// _IOR('E', 0x40 + axis, struct input_absinfo): dir=2, size=24, type=0x45. The
// struct is six int32s — value, minimum, maximum, fuzz, flat, resolution — and
// only the range matters here.
//
// The script is passed to python as a command-line ARGUMENT, so it must contain
// no NUL byte — Node refuses to spawn otherwise ("must be a string without null
// bytes") and the query fails silently, leaving every pad on the guessed range.
// That is why the buffer below is bytes(24) rather than a zero-byte literal, and
// why nothing here may mention one, comments included. Synchronous and once per pad at open: a few tens
// of milliseconds when a controller is plugged in, and nothing at all after.
function absInfoFor(node, python) {
  if (!python) return null;
  const codes = [ABS_X, ABS_Y];
  const script = `
import fcntl, json, struct, sys
out = {}
try:
    f = open(sys.argv[1], "rb")
except OSError:
    print("{}"); raise SystemExit
for a in [${codes.join(", ")}]:
    try:
        buf = fcntl.ioctl(f, (2 << 30) | (24 << 16) | (0x45 << 8) | (0x40 + a), bytes(24))
        value, lo, hi, fuzz, flat, res = struct.unpack("<6i", buf)
        if hi > lo:
            out[a] = {"min": lo, "max": hi}
    except OSError:
        pass
print(json.dumps(out))
`;
  try {
    const r = spawnSync(python, ["-c", script, node], {
      encoding: "utf8", timeout: 4000,
    });
    if (r.status !== 0 || !r.stdout) {
      console.error("[pad] axis range query failed for", node,
                    r.status, (r.stderr || "").slice(0, 200));
      return null;
    }
    const parsed = JSON.parse(r.stdout);
    const out = {};
    for (const [k, v] of Object.entries(parsed)) out[Number(k)] = v;
    if (!Object.keys(out).length) return null;
    // One line per pad, because a wrong range here is invisible in the UI and
    // presents as "the controller drives the menu on its own".
    console.log("[pad] axis ranges for", node, JSON.stringify(out));
    return out;
  } catch (e) {
    console.error("[pad] axis range query threw for", node, e && e.message);
    return null;
  }
}

// TRIGGERS: unipolar, resting at 0 (0..255 on some pads, 0..1023 on xpad), so
// here the running maximum IS safe — rest stays 0 no matter what scale we assume,
// which is what made it unsafe for a centred stick. Require a little travel
// before trusting it so sensor noise can't cross the threshold.
function normalizeTrigger(seen, code, value) {
  let s = seen.get(code);
  if (!s) { s = { max: 0 }; seen.set(code, s); }
  if (value > s.max) s.max = value;
  if (s.max < 16) return 0;
  return value / s.max;
}

// One open pad: its evdev fd plus the state needed to emit only CHANGES.
class PadReader {
  constructor(node, emit, python) {
    this.node = node;
    this.emit = emit;
    // The kernel's own axis ranges, so a stick at rest normalises to ~0 whatever
    // scale the pad uses. null when the query could not run — normalizeStick
    // falls back to its guesses then.
    this.abs = absInfoFor(node, python);
    // O_NONBLOCK matters: an evdev node opened for blocking reads parks
    // readSync() until the next event, which would freeze the ENTIRE main process
    // (window management, IPC, the backend's lifecycle) between button presses.
    // Non-blocking turns "nothing queued" into an EAGAIN we skip over.
    this.fd = fs.openSync(node, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    this.buf = Buffer.alloc(EVENT_SIZE * 64);
    this.axisSeen = new Map();  // per-axis observed range, for the scalers above
    this.held = new Set();     // GamepadButtonIds currently down
    this.dir = null;           // last emitted direction
    this.axis = { x: 0, y: 0 };   // left stick, normalized
    this.hat = { x: 0, y: 0 };    // d-pad
    this.dpad = { up: false, down: false, left: false, right: false };
  }

  close() {
    // Release anything still held, or the UI keeps a phantom press after unplug.
    for (const id of this.held) this.emit.button(id, false, this.node);
    this.held.clear();
    if (this.dir) { this.dir = null; this.emit.direction(null, this.node); }
    // Drop the renderer's state for this node entirely. Releasing the held
    // buttons above is not enough on its own: a node that disappears while the
    // UI still carries its direction would leave that direction pinned forever.
    this.emit.gone(this.node);
    try { fs.closeSync(this.fd); } catch { /* already gone */ }
    this.fd = null;
  }

  // Returns false when the device went away and this reader should be dropped.
  pump() {
    if (this.fd === null) return false;
    let n = 0;
    try { n = fs.readSync(this.fd, this.buf, 0, this.buf.length, null); }
    catch (err) {
      // EAGAIN just means "nothing queued" on the non-blocking fd.
      if (err.code === "EAGAIN") return true;
      return false; // ENODEV/EIO — unplugged mid-read
    }
    for (let o = 0; o + EVENT_SIZE <= n; o += EVENT_SIZE) {
      this.handle(this.buf.readUInt16LE(o + 16), this.buf.readUInt16LE(o + 18),
                  this.buf.readInt32LE(o + 20));
    }
    this.updateDirection();
    return true;
  }

  handle(type, code, value) {
    if (type === EV_KEY) {
      // value 2 is auto-repeat, which the shim generates itself from a held
      // button; only real transitions matter here.
      if (value === 2) return;
      const dir = DPAD_KEYS[code];
      if (dir) { this.dpad[dir] = value === 1; return; }
      const id = KEY_MAP[code];
      if (id === undefined) return;
      this.setButton(id, value === 1);
      return;
    }
    if (type !== EV_ABS) return;
    switch (code) {
      case ABS_X: this.axis.x = normalizeStick(this.axisSeen, code, value, this.abs); break;
      case ABS_Y: this.axis.y = normalizeStick(this.axisSeen, code, value, this.abs); break;
      // Hat axes are always -1/0/1, so they need no scaling.
      case ABS_HAT0X: this.hat.x = Math.sign(value); break;
      case ABS_HAT0Y: this.hat.y = Math.sign(value); break;
      // Analog triggers: 0..max, so scale then threshold into a button.
      case ABS_Z: this.setButton(TRIGGER_LEFT, normalizeTrigger(this.axisSeen, code, value) > TRIGGER_ON); break;
      case ABS_RZ: this.setButton(TRIGGER_RIGHT, normalizeTrigger(this.axisSeen, code, value) > TRIGGER_ON); break;
      default: break;
    }
  }

  setButton(id, down) {
    if (down === this.held.has(id)) return;
    if (down) this.held.add(id); else this.held.delete(id);
    this.emit.button(id, down, this.node);
  }

  // D-pad first, then the left stick past the deadzone; vertical wins over
  // horizontal — the same precedence as preload.cjs and gamepad_bridge._emit_dir.
  updateDirection() {
    const up = this.dpad.up || this.hat.y < 0 || this.axis.y < -STICK_DEADZONE;
    const down = this.dpad.down || this.hat.y > 0 || this.axis.y > STICK_DEADZONE;
    const left = this.dpad.left || this.hat.x < 0 || this.axis.x < -STICK_DEADZONE;
    const right = this.dpad.right || this.hat.x > 0 || this.axis.x > STICK_DEADZONE;
    const dir = up ? "up" : down ? "down" : left ? "left" : right ? "right" : null;
    if (dir === this.dir) return;
    this.dir = dir;
    this.emit.direction(dir, this.node);
  }
}

// Poll intervals. Reading queued events has to be frequent enough to feel
// immediate; rescanning for new devices does not.
const PUMP_MS = 16;
const SCAN_MS = 1000;

// Start reading attached pads and forwarding their events through `emit`
// ({button(id, down, node), direction(dir|null, node), gone(node)}). Every call
// carries the evdev node it came from: a pad can present several nodes that all
// report the same press (the 8BitDo Ultimate does), and the renderer needs to
// tell them apart to merge them instead of counting each press twice. Returns a
// stop() function.
function startNativeInput(emit, python) {
  if (process.platform !== "linux") return () => {};

  const readers = new Map(); // node path → PadReader
  // Nodes we failed to open, with when to retry. A freshly created node is owned
  // by root for a moment before udev applies the seat ACL — the first open after
  // a pad is switched on really does fail with EACCES, then succeeds ~100ms
  // later, so a permanent give-up would lose exactly the hot-plug case this
  // module exists for.
  const blocked = new Map(); // node path → retry-after timestamp
  const RETRY_MS = 500;

  const scan = () => {
    const pads = findNativePads();
    if (!pads) return;
    const present = new Set(pads.map((p) => p.eventNode).filter(Boolean));
    for (const node of readers.keys()) {
      if (!present.has(node)) { readers.get(node).close(); readers.delete(node); }
    }
    for (const node of present) {
      if (readers.has(node)) continue;
      const until = blocked.get(node);
      if (until && Date.now() < until) continue;
      try {
        readers.set(node, new PadReader(node, emit, python));
        blocked.delete(node);
      } catch (err) {
        // EACCES is the udev-ACL race above; anything else (ENOENT from an
        // unplug mid-scan) is equally worth retrying rather than logging noise.
        blocked.set(node, Date.now() + RETRY_MS);
      }
    }
    for (const node of blocked.keys()) if (!present.has(node)) blocked.delete(node);
  };

  const pump = () => {
    for (const [node, reader] of readers) {
      if (!reader.pump()) { reader.close(); readers.delete(node); }
    }
  };

  scan();
  const scanTimer = setInterval(scan, SCAN_MS);
  const pumpTimer = setInterval(pump, PUMP_MS);

  return function stop() {
    clearInterval(scanTimer);
    clearInterval(pumpTimer);
    for (const reader of readers.values()) reader.close();
    readers.clear();
  };
}

module.exports = { startNativeInput };
