// Run the production Electron main entry with only its UI and OS boundary replaced.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import vm from "node:vm";

const main = new URL("../../electron/main.cjs", import.meta.url);
const requireMain = createRequire(main);

export function bootShell({ packaged, resources, desktop, paths, platform = "win32", env, spawn, existsSync = fs.existsSync, timers = {} }) {
  const events = new EventEmitter();
  const ipc = new EventEmitter();
  ipc.handle = () => {};
  const sink = () => new Writable({ write(_data, _enc, done) { done(); } });
  const proc = Object.assign(new EventEmitter(), {
    platform, argv: [], env, resourcesPath: resources, stdout: sink(), stderr: sink(),
  });
  const app = Object.assign(new EventEmitter(), {
    isPackaged: packaged, getPath: () => desktop, setName() {}, setPath() {},
    commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), getGPUFeatureStatus: () => ({}),
    quit() {
      let wait = false;
      this.emit("before-quit", { preventDefault() { wait = true; } });
      if (!wait) events.emit("quit");
    },
  });
  class BrowserWindow extends EventEmitter {
    webContents = new EventEmitter();
    setMenuBarVisibility() {}
    loadURL(url) { events.emit("load", url); }
  }
  const modules = {
    electron: {
      app, BrowserWindow, ipcMain: ipc, dialog: { showErrorBox(_title, detail) { events.emit("dialog", detail); } },
      protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    },
    path: paths, fs: { existsSync }, child_process: { spawn },
    "./native-input.cjs": { startNativeInput() {} },
  };
  vm.runInNewContext(fs.readFileSync(main, "utf8"), {
    require: name => modules[name] ?? requireMain(name),
    process: proc, __dirname: paths.join(desktop, "electron"),
    console: { error() {}, log() {} }, setTimeout, clearTimeout, ...timers,
  });
  return { app, events, ipc };
}
