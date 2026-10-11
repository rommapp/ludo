// Per-pad button maps in the kernel gamepad reader (rommapp/ludo#33).
//
// The 8BitDo M30 in Android mode reports its shoulder L/R as BTN_TL2/BTN_TR2
// and its face Z/C as BTN_TL/BTN_TR. These drive PadReader.handle() with the
// raw evdev codes and check what reaches the UI, without opening a device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { keyMapFor, PadReader } = require("../electron/native-input.cjs");

const TRIGGER_LEFT = 7, TRIGGER_RIGHT = 8, BUMPER_LEFT = 9, BUMPER_RIGHT = 10;
const EV_KEY = 0x01;
const BTN_TL = 0x136, BTN_TR = 0x137, BTN_TL2 = 0x138, BTN_TR2 = 0x139;

// A PadReader with the constructor's device I/O skipped, recording each press.
function reader(pad) {
  const r = Object.create(PadReader.prototype);
  r.node = "/dev/input/event-test";
  r.keyMap = keyMapFor(pad);
  r.held = new Set();
  r.dpad = { up: false, down: false, left: false, right: false };
  r.pressed = [];
  r.emit = { button: (id, down) => { if (down) r.pressed.push(id); } };
  return r;
}

function press(pad, code) {
  const r = reader(pad);
  r.handle(EV_KEY, code, 1);
  return r.pressed;
}

test("M30: shoulder L/R are bumpers", () => {
  assert.deepEqual(press("2dc8:0651", BTN_TL2), [BUMPER_LEFT]);
  assert.deepEqual(press("2dc8:0651", BTN_TR2), [BUMPER_RIGHT]);
});

test("M30: face Z/C are triggers", () => {
  assert.deepEqual(press("2dc8:0651", BTN_TL), [TRIGGER_LEFT]);
  assert.deepEqual(press("2dc8:0651", BTN_TR), [TRIGGER_RIGHT]);
});

test("other pads keep the generic map", () => {
  for (const pad of ["045e:028e", undefined]) {
    assert.deepEqual(press(pad, BTN_TL), [BUMPER_LEFT]);
    assert.deepEqual(press(pad, BTN_TR), [BUMPER_RIGHT]);
    assert.deepEqual(press(pad, BTN_TL2), [TRIGGER_LEFT]);
    assert.deepEqual(press(pad, BTN_TR2), [TRIGGER_RIGHT]);
  }
});

test("the M30 override leaves its other buttons alone", () => {
  const m30 = keyMapFor("2dc8:0651"), generic = keyMapFor(undefined);
  for (const code of Object.keys(generic)) {
    if ([BTN_TL, BTN_TR, BTN_TL2, BTN_TR2].includes(Number(code))) continue;
    assert.equal(m30[code], generic[code], `code 0x${Number(code).toString(16)}`);
  }
});
