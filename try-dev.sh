#!/usr/bin/env bash
# Build the current code and launch it as the desktop app against your RomM,
# without touching your setup.
#
# Uses a throwaway copy of ~/.config/ludo (in .dev-sandbox/) with auto-sync and
# auto-download off and saves redirected, so nothing uploads or overwrites your
# real saves. Electron's profile lives in the sandbox too, so it doesn't collide
# with your installed Ludo's single-instance lock — both can be open at once.
#
# UI changes (ui/, desktop/src/) hot-reload into the open window as you save,
# via Vite. Backend changes (app/, engine/) need the app restarted.
#
#   ./try-dev.sh                     launch with hot reload (windowed)
#   ./try-dev.sh --built             build once and run the built UI, as shipped
#   ./try-dev.sh --fresh             re-copy your config into the sandbox first
#   ROMM_FULLSCREEN=1 ./try-dev.sh   launch fullscreen, like the real app
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SANDBOX="$ROOT/.dev-sandbox"
CFG="$SANDBOX/.config/ludo"
REAL_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
REAL="$REAL_CONFIG/ludo"

BUILT=0
for arg in "$@"; do
  case "$arg" in
    --fresh) rm -rf "$SANDBOX" ;;
    --built) BUILT=1 ;;
    *) echo "unknown option: $arg"; exit 2 ;;
  esac
done
# Its own backend port, away from the installed app's.
export ROMM_PORT="${ROMM_PORT:-8799}"

# Ludo keys its config off $HOME, so the app runs with HOME=$SANDBOX. Mirror
# everything else in your real home as links, so RetroArch/RetroDECK/Steam
# lookups still find the real thing; only Ludo's own state is sandboxed.
link_home() {
  mkdir -p "$SANDBOX/.config"
  for e in "$HOME"/.[!.]* "$HOME"/*; do
    n="$(basename "$e")"
    [[ -e "$e" && "$n" != ".config" && ! -e "$SANDBOX/$n" ]] && ln -s "$e" "$SANDBOX/$n"
  done
  for e in "$REAL_CONFIG"/* "$REAL_CONFIG"/.[!.]*; do
    n="$(basename "$e")"
    [[ -e "$e" && "$n" != "ludo" && "$n" != "ludo-desktop" && ! -e "$SANDBOX/.config/$n" ]] \
      && ln -s "$e" "$SANDBOX/.config/$n"
  done
  return 0
}

if [[ ! -f "$CFG/settings.ini" ]]; then
  [[ -f "$REAL/settings.ini" ]] || { echo "No settings at $REAL — set up Ludo first."; exit 1; }
  echo "Copying your config into $SANDBOX"
  mkdir -p "$CFG" "$SANDBOX/saves"
  cp "$REAL/settings.ini" "$CFG/"
  [[ -f "$REAL/library_snapshot.json" ]] && cp "$REAL/library_snapshot.json" "$CFG/"
  sed -i -E 's/^(auto_enable_on_connect|startup_sync_enabled|sync_enabled|auto_download|auto_sync_enabled) = true/\1 = false/' "$CFG/settings.ini"
  sed -i "s|^save_directory = .*|save_directory = $SANDBOX/saves|" "$CFG/settings.ini"
fi

link_home

cd "$ROOT/desktop"
if [[ ! -x .venv/bin/python ]]; then
  echo "Creating backend venv"
  python3 -m venv .venv
  .venv/bin/pip install -q -r backend/requirements.txt
  .venv/bin/pip install -q -e ../engine -e ../app --no-deps
fi
[[ -d node_modules ]] || npm install
export HOME="$SANDBOX" XDG_CONFIG_HOME="$SANDBOX/.config" ROMM_FULLSCREEN="${ROMM_FULLSCREEN:-0}"

if [[ $BUILT == 1 ]]; then
  echo "Building UI"
  npm run -s build >/dev/null
  echo "Launching Ludo (built UI). Log: $SANDBOX/app.log"
  node electron/launch.cjs 2>&1 | tee "$SANDBOX/app.log"
  exit
fi

# Vite serves the UI with hot reload and proxies /api to the backend on
# ROMM_PORT, which Electron starts; launch.cjs --dev points the window at Vite.
# 127.0.0.1, not localhost: Electron loads that address, and "localhost" can
# bind IPv6 only.
npx vite --host 127.0.0.1 --strictPort > "$SANDBOX/vite.log" 2>&1 &
VITE_PID=$!
trap 'kill $VITE_PID 2>/dev/null' EXIT
ready=0
for _ in $(seq 60); do
  curl -s -o /dev/null http://127.0.0.1:5173 && { ready=1; break; }
  kill -0 $VITE_PID 2>/dev/null || break
  sleep 0.5
done
[[ $ready == 1 ]] || { echo "Vite didn't start:"; cat "$SANDBOX/vite.log"; exit 1; }
echo "Launching Ludo (hot reload). Logs: $SANDBOX/app.log, $SANDBOX/vite.log"
node electron/launch.cjs --dev 2>&1 | tee "$SANDBOX/app.log"
