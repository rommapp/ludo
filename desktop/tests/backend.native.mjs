// Native CI: real interpreters, backend, pipes, bind and profile RPC.
// The packaged layout links to the CI interpreter installation.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootShell } from "./support/backend-shell.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const next = (events, name) => once(events, name, { signal: AbortSignal.timeout(75000) });

function fixtureEnvironment(root) {
  const env = {};
  if (process.platform === "win32" && process.env.USERNAME) env.USERNAME = process.env.USERNAME;
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "SystemDrive",
                     "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "LANG", "LC_ALL"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const [folder, names] of [
    ["Kullanıcı İzmir 東京", ["HOME", "USERPROFILE"]], ["local", ["LOCALAPPDATA"]],
    ["roaming", ["APPDATA"]], ["temp", ["TMP", "TEMP", "TMPDIR"]],
    ["config", ["XDG_CONFIG_HOME"]], ["cache", ["XDG_CACHE_HOME"]], ["data", ["XDG_DATA_HOME"]],
  ]) {
    const dir = path.join(root, folder);
    fs.mkdirSync(dir);
    for (const name of names) env[name] = dir;
  }
  return env;
}

for (const mode of ["development", "packaged layout", "occupied port"]) {
  test(mode + " with the real " + process.platform + " backend", async t => {
    const windows = process.platform === "win32";
    // The installation and the account home are independent on a real PC.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-lifecycle-"));
    const install = path.join(root, "Ludo İzmir 東京");
    const children = [];
    t.after(async () => {
      for (const child of children) {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          const exited = next(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const env = fixtureEnvironment(root);
    const packaged = mode !== "development";
    const resources = path.join(install, "resources");
    const desktop = packaged ? path.join(resources, "app-src", "desktop") : path.join(install, "desktop");
    fs.mkdirSync(path.join(desktop, "backend"), { recursive: true });
    for (const file of ["server.py", "windows_lifetime.py"]) {
      const source = path.join(repo, "desktop", "backend", file);
      const target = path.join(desktop, "backend", file);
      fs.copyFileSync(source, target);
      assert.deepEqual(fs.readFileSync(target), fs.readFileSync(source));
    }
    fs.copyFileSync(path.join(repo, "desktop", "package.json"), path.join(desktop, "package.json"));
    const py = (...args) => execFileSync(windows ? "python" : "python3", args, { env, cwd: root, encoding: "utf8" }).trim();
    if (packaged) {
      fs.symlinkSync(py("-c", "import sys; print(sys.base_prefix)"), path.join(resources, "python"), windows ? "junction" : "dir");
    } else {
      py("-m", "venv", "--system-site-packages", "--without-pip", path.join(desktop, ".venv"));
    }
    const reserve = net.createServer().listen(0, "127.0.0.1");
    await once(reserve, "listening");
    const port = reserve.address().port;
    const closeListener = () => new Promise(resolve => reserve.close(resolve));
    if (mode === "occupied port") t.after(closeListener);
    else await closeListener();

    env.ROMM_PORT = String(port);
    if (windows) env.PYTHONHOME = "poisoned parent Python home";
    const { events, ipc, app } = bootShell({
      packaged, desktop, resources, paths: path, platform: process.platform, env,
      spawn(exe, args, opts) {
        assert.equal(opts.windowsHide, windows);
        const child = spawn(exe, args, { ...opts, cwd: root });
        children.push(child);
        return child;
      },
    });
    // A real startup error should fail immediately and include Python's diagnostic.
    const windowResult = () => Promise.race([
      next(events, "load").then(() => "loaded"), next(events, "dialog").then(([msg]) => msg),
    ]);
    if (mode === "occupied port") {
      assert.match(await windowResult(), /10048|10013|address already in use/i);
      assert.ok(children[0].exitCode);
      return;
    }
    assert.equal(await windowResult(), "loaded");
    const rpc = async (method, ...args) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
        method: "POST", body: JSON.stringify({ args }), signal: AbortSignal.timeout(5000),
      });
      const reply = await res.json();
      assert.ok(!reply.error, reply.error);
      return reply.result;
    };
    assert.equal((await rpc("get_profiles")).current, "default");
    const firstConfig = await rpc("get_config");
    assert.ok(firstConfig.rom_directory.includes("Kullanıcı İzmir 東京"));
    const created = await rpc("create_profile", "İzmir 東京");
    assert.equal(created.status, "reload", JSON.stringify(created));
    const reloaded = windowResult();
    ipc.emit("romm:reload-backend");
    assert.equal(await reloaded, "loaded");
    assert.equal(children.length, 2);
    assert.equal(children[0].exitCode, 0, "old backend exited gracefully before rebinding");
    assert.equal((await rpc("get_profiles")).current, created.id);
    const profileConfig = await rpc("get_config");
    assert.equal(profileConfig.rom_directory, firstConfig.rom_directory);
    assert.ok(profileConfig.save_directory.includes(created.id));
    const quit = next(events, "quit");
    app.emit("window-all-closed");
    await quit;
    assert.equal(children[1].exitCode, 0);
  });
}
