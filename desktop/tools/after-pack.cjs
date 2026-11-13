// electron-builder afterPack hook: puts a small launcher in front of the
// Electron binary.
//
// Steam injects its overlay through LD_PRELOAD on every launch, even with the
// overlay switched off, and that library crashes Chromium's child processes.
// Clearing it from main.cjs is too late because the zygote is forked before any
// app code runs, so it has to go before the binary starts. Other preloads, such
// as a user's own, are left alone.
const fs = require("fs");
const path = require("path");

exports.default = async (context) => {
  if (context.electronPlatformName !== "linux") return;
  const name = context.packager.executableName;
  const bin = path.join(context.appOutDir, name);
  fs.renameSync(bin, `${bin}.bin`);
  fs.writeFileSync(bin, `#!/bin/sh
case "$LD_PRELOAD" in
  *gameoverlayrenderer*) unset LD_PRELOAD ;;
esac
exec "$(dirname "$(readlink -f "$0")")/${name}.bin" "$@"
`, { mode: 0o755 });
};
