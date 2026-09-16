// Environment handed to the Python backend.
//
// LUDO_DEBUG is a developer escape hatch, but a packaged AppImage is a release
// runtime even when it was launched from a terminal that happens to export the
// variable. Do not let that ambient shell state enable developer-only features
// (notably screenshot mode's Nintendo filter) in a production build.
function backendEnv(baseEnv, host, port, packaged) {
  const env = { ...baseEnv, ROMM_HOST: host, ROMM_PORT: String(port) };
  if (packaged) delete env.LUDO_DEBUG;
  return env;
}

module.exports = { backendEnv };
