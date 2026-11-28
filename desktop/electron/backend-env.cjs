// Environment handed to the Python backend.
//
// LUDO_DEBUG is a developer escape hatch, but a packaged AppImage is a release
// runtime even when it was launched from a terminal that happens to export the
// variable. Do not let that ambient shell state enable developer-only features
// (notably screenshot mode's Nintendo filter) in a production build.
function backendEnv(baseEnv, host, port, packaged, platform = process.platform) {
  const env = { ...baseEnv, ROMM_HOST: host, ROMM_PORT: String(port) };
  if (platform === "win32") {
    // Environment names on Windows are case insensitive, including in launchers
    // that assembled an ordinary JS object with mixed-case keys.
    for (const key of Object.keys(env)) {
      if (/^(PYTHON.*|__PYVENV_LAUNCHER__|LUDO_OWNER_PIPE|ROMM_HOST|ROMM_PORT)$/i.test(key) ||
          (packaged && /^LUDO_DEBUG$/i.test(key))) delete env[key];
    }
    Object.assign(env, {
      ROMM_HOST: host, ROMM_PORT: String(port), LUDO_OWNER_PIPE: "1",
      PYTHONNOUSERSITE: "1", PYTHONIOENCODING: "utf-8",
    });
  }
  if (packaged) delete env.LUDO_DEBUG;
  return env;
}

module.exports = { backendEnv };
