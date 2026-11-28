import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { test } from "node:test";
import { bootShell } from "./support/backend-shell.mjs";

const resources = String.raw`C:\Oyun Alanı\東京\resources`;
const desktop = String.raw`C:\Kaynak Kod\İzmir\desktop`;

const settings = { resources, desktop, paths: path.win32, env: { ROMM_PORT: "8723" } };

for (const [mode, packaged, expected] of [
  ["packaged", true, path.win32.join(resources, "python", "python.exe")],
  ["development", false, path.win32.join(desktop, ".venv", "Scripts", "python.exe")],
]) {
  test(mode + " Windows shell launches Python from a spaced Unicode path", async () => {
    let spawnArgs;
    const { events } = bootShell({
      ...settings, packaged, existsSync: p => p === expected,
      spawn(...args) { spawnArgs = args; throw new Error("fixture launch failed"); },
    });
    const message = await Promise.race([
      once(events, "dialog").then(([detail]) => detail),
      once(events, "quit").then(() => "quit without a startup error dialog"),
    ]);
    assert.equal(spawnArgs?.[0], expected);
    assert.equal(spawnArgs[1].length, 1);
    assert.equal(spawnArgs[1][0], path.win32.join(packaged ? path.win32.join(resources, "app-src", "desktop") : desktop, "backend", "server.py"));
    assert.equal(spawnArgs[2].windowsHide, true);
    assert.match(message, /fixture launch failed/);
  });
}

test("split readiness, profile switch, PID reuse and close during restart", async () => {
  const children = [];
  const timers = new Map();
  const { app, ipc, events } = bootShell({
    ...settings, packaged: false, existsSync: () => true,
    timers: {
      setTimeout(fn, ms) { const handle = {}; timers.set(handle, { fn, ms }); return handle; },
      clearTimeout(handle) { timers.delete(handle); },
    },
    spawn() {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        pid: 1701, exitCode: null, signalCode: null,
        kill() { assert.fail("a stale timer signalled the reused process ID"); },
      });
      children.push(child);
      return child;
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  const first = children[0];
  const loaded = once(events, "load");
  first.stderr.write("e".repeat(128 * 1024));
  first.stdout.write("x".repeat(128 * 1024) + "\n[server] listen");
  first.stdout.write("ing on http://127.0.0.1:8723\r\n");
  await loaded;

  ipc.emit("romm:reload-backend");
  ipc.emit("romm:reload-backend");
  assert.equal(first.stdin.read().toString(), "Q");
  assert.equal(children.length, 1, "wait for the old backend");
  first.exitCode = 0;
  first.emit("exit", 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(children.length, 2);
  const replacement = children[1];
  first.emit("close", 0); // old pipes can close after PID reuse
  assert.ok(![...timers.values()].some(t => t.ms === 11000));
  const reloaded = once(events, "load");
  replacement.stdout.write("[server] listening on http://127.0.0.1:8723\n");
  await reloaded;
  ipc.emit("romm:reload-backend");
  app.emit("window-all-closed");
  const quit = once(events, "quit");
  replacement.exitCode = 0;
  replacement.emit("exit", 0);
  replacement.emit("close", 0);
  await quit;
  assert.equal(children.length, 2, "closing the window suppresses relaunch");
});

test("occupied port detail reaches the startup dialog after stderr closes", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
  });
  const { events } = bootShell({ ...settings, packaged: false, spawn: () => child });
  const dialog = once(events, "dialog");
  await new Promise(resolve => setImmediate(resolve));
  child.emit("exit", 1);
  child.stderr.write("OSError: [WinError 10048] Only one usage of each socket address");
  child.emit("close", 1);
  const [message] = await dialog;
  assert.match(message, /127\.0\.0\.1:8723/);
  assert.match(message, /WinError 10048/);
});
