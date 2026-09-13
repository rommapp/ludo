#!/bin/bash
# Build and package the Ludo Decky plugin as a ZIP for installation
# via Decky Loader → gear icon → "Install plugin from ZIP".
set -e

PLUGIN_NAME="ludo"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_ZIP="${SCRIPT_DIR}/../${PLUGIN_NAME}.zip"

# ── Vendored Python dependencies ─────────────────────────────────────────────
# Decky Loader is a PyInstaller AppImage running Python 3.11 — NOT the system
# Python — and it exposes none of these to plugins, so every one of them has to
# ride along in py_modules/ (main.py puts that directory on sys.path).
#
# This used to refresh Pillow alone and take the rest on faith from whatever the
# build machine happened to have lying around in py_modules/. Those directories
# are gitignored, so a clean checkout — which is exactly what CI builds from —
# had none of them: v1.0.0-beta.1 shipped with PIL and the backend and nothing
# else. sync_core imports requests, psutil and watchdog at module scope, so the
# whole engine failed to import on device and the plugin fell back to its
# "sync_core not available" path. Vendoring them here, from a pinned list rather
# than from the working tree, is what makes the zip reproducible.
#
# Binary wheels (Pillow, psutil, watchdog, charset_normalizer) must match
# cp311/manylinux or they silently fail to import; --only-binary :all: with an
# explicit --python-version is what pins that. Transitive deps are resolved
# rather than listed by hand — qrcode's typing_extensions is the kind of thing
# --no-deps drops and nobody notices until a QR code fails to draw.
DEPS=(requests watchdog psutil qrcode Pillow)

echo "==> Vendoring Python deps for Decky's Python 3.11: ${DEPS[*]}"
WHEEL_TMP=$(mktemp -d)
trap 'rm -rf "$WHEEL_TMP"' EXIT
pip download "${DEPS[@]}" \
    --python-version 3.11 \
    --platform manylinux_2_28_x86_64 \
    --only-binary :all: \
    -d "$WHEEL_TMP" \
    --quiet

shopt -s nullglob
WHEELS=("$WHEEL_TMP"/*.whl)
[ ${#WHEELS[@]} -gt 0 ] || { echo "ERROR: pip downloaded no wheels" >&2; exit 1; }
for whl in "${WHEELS[@]}"; do
    # -o: later wheels never conflict, but re-running the build over an existing
    # py_modules must overwrite rather than prompt.
    unzip -q -o "$whl" -d "${SCRIPT_DIR}/py_modules" -x '*.dist-info/RECORD'
    echo "    $(basename "$whl")"
done
shopt -u nullglob

# Prove the vendored tree is complete before it is packaged. The pure-Python
# packages are imported for real, which is what catches a missing transitive
# dependency. The cp311 binary wheels can only be imported when the build
# machine is itself on 3.11 (CI pins that deliberately); anywhere else they are
# checked as files, since a 3.12 interpreter cannot load a cp311 .so at all.
for d in PIL pillow.libs psutil; do
    [ -e "${SCRIPT_DIR}/py_modules/$d" ] || {
        echo "ERROR: py_modules/$d missing after vendoring" >&2; exit 1; }
done
PYTHONPATH="${SCRIPT_DIR}/py_modules" python3 - <<'PYCHECK'
import sys
missing = []
mods = ["requests", "watchdog.observers", "qrcode"]
if sys.version_info[:2] == (3, 11):
    mods += ["PIL.Image", "psutil"]
for mod in mods:
    try:
        __import__(mod)
    except Exception as e:                      # noqa: BLE001 - report, don't raise
        missing.append(f"{mod}: {e}")
# Encoding something is the only proof qrcode arrived complete: qr_matrix()
# swallows an ImportError and returns None, which would ship as a pairing screen
# with no code on it rather than as a crash.
try:
    import qrcode
    qr = qrcode.QRCode(box_size=1, border=0)
    qr.add_data("https://example.com/pair/device?user_code=TEST1234")
    qr.make(fit=True)
    assert qr.get_matrix()
except Exception as e:                          # noqa: BLE001
    missing.append(f"qrcode encode: {e}")
if missing:
    print("ERROR: vendored py_modules is incomplete:", file=sys.stderr)
    for m in missing:
        print(f"  - {m}", file=sys.stderr)
    sys.exit(1)
print("    vendored deps import OK")
PYCHECK

echo "==> Building frontend..."
cd "$SCRIPT_DIR"
pnpm run build

echo "==> Packaging zip..."
TMP_DIR=$(mktemp -d)
mkdir -p "${TMP_DIR}/${PLUGIN_NAME}/dist"
mkdir -p "${TMP_DIR}/${PLUGIN_NAME}/py_modules"
mkdir -p "${TMP_DIR}/${PLUGIN_NAME}/assets"
mkdir -p "${TMP_DIR}/${PLUGIN_NAME}/bin"

cp "${SCRIPT_DIR}/plugin.json"             "${TMP_DIR}/${PLUGIN_NAME}/"
cp "${SCRIPT_DIR}/package.json"            "${TMP_DIR}/${PLUGIN_NAME}/"
cp "${SCRIPT_DIR}/LICENSE"                 "${TMP_DIR}/${PLUGIN_NAME}/"
cp "${SCRIPT_DIR}/main.py"                 "${TMP_DIR}/${PLUGIN_NAME}/"
cp "${SCRIPT_DIR}/dist/index.js"           "${TMP_DIR}/${PLUGIN_NAME}/dist/"
cp "${SCRIPT_DIR}/dist/index.js.map"       "${TMP_DIR}/${PLUGIN_NAME}/dist/"
# Copy all py_modules (the ludo_app backend, the romm_sync_engine sync core, and
# bundled dependencies like requests and watchdog). -L dereferences the
# ludo_app and romm_sync_engine dev symlinks, vendoring both into the zip — the
# Deck has no pip install step, so main.py finds them on sys.path instead.
cp -rL "${SCRIPT_DIR}/py_modules/"* "${TMP_DIR}/${PLUGIN_NAME}/py_modules/"
# Remove unnecessary files
rm -rf "${TMP_DIR}/${PLUGIN_NAME}/py_modules/__pycache__" "${TMP_DIR}/${PLUGIN_NAME}/py_modules/bin" "${TMP_DIR}/${PLUGIN_NAME}/py_modules/"*.dist-info \
    "${TMP_DIR}/${PLUGIN_NAME}/py_modules/romm_sync_engine/__pycache__" \
    "${TMP_DIR}/${PLUGIN_NAME}/py_modules/ludo_app/__pycache__"
# The artwork is package data of ludo_app now, so the `cp -rL py_modules/*`
# above already vendored it at py_modules/ludo_app/assets/ — which is where
# backend.py looks. This copy is only for the plugin-root logo Decky Loader
# shows in its plugin list.
cp "${SCRIPT_DIR}/py_modules/ludo_app/assets/logo.png" "${TMP_DIR}/${PLUGIN_NAME}/assets/"

# The exe behind the "RomM" Steam tile. Steam launches this as a tracked game so
# the overlay opens, and it execs the resolved emulator argv in place. Without it
# in the zip, backend.get_session_host_path() finds nothing and Play falls back
# to a direct launch with no working overlay -- which is what every release
# before this shipped, because nothing copied bin/ at all.
cp "${SCRIPT_DIR}/bin/romm-session-host" "${TMP_DIR}/${PLUGIN_NAME}/bin/"
chmod +x "${TMP_DIR}/${PLUGIN_NAME}/bin/romm-session-host"

rm -f "$OUT_ZIP"
(cd "$TMP_DIR" && zip -r "$OUT_ZIP" "${PLUGIN_NAME}/")
rm -rf "$TMP_DIR"

echo "==> Done: ${OUT_ZIP}"
