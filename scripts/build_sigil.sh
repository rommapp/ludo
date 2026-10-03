#!/usr/bin/env bash
# Build libsigil.so for Ludo.
#
# argosy-sigil (https://github.com/rommapp/argosy-sigil, MPL-2.0) reads the
# game-native title ID out of a ROM, and names the save files an emulator keeps
# for it. Argosy, the Android RomM client, uses the same library for both, which
# is the point of bundling it: two clients that read a game's identity the same
# way agree on which save is whose.
#
# The full upstream build: every extractor (3DS and Wii U included), the CHD,
# CSO, zip and ZArchive readers, and the save-unit resolver. Its dependencies
# (zlib, zstd, lzma, libchdr, tiny-AES-c) are vendored as submodules and linked
# statically, so the result still needs nothing but libc.
#
#   ./scripts/build_sigil.sh [build-dir]     # default: ./sigil-build
#
# Then point Ludo at the result, or let it pick up the copy installed into the
# engine package:
#   export LUDO_SIGIL_LIB=<build-dir>/libsigil.so
set -euo pipefail

# The commit Ludo is built and tested against. Bump deliberately: the version
# string upstream reports has read "0.1.0-dev" for every build so far, so this
# is the only record of which code is bundled.
SIGIL_REPO="${SIGIL_REPO:-https://github.com/rommapp/argosy-sigil}"
SIGIL_COMMIT="${SIGIL_COMMIT:-8a3b008}"

# Resolved before any cd: "$0" may be relative.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${1:-$PWD/sigil-build}"
SRC_DIR="$BUILD_DIR/argosy-sigil"

for tool in gcc git cmake; do
  command -v "$tool" >/dev/null || { echo "$tool is required"; exit 1; }
done

mkdir -p "$BUILD_DIR"
if [ ! -d "$SRC_DIR/.git" ]; then
  echo "==> cloning argosy-sigil"
  git clone "$SIGIL_REPO" "$SRC_DIR"
fi
cd "$SRC_DIR"
git fetch --quiet origin
git checkout --quiet "$SIGIL_COMMIT"
echo "==> argosy-sigil $(git rev-parse --short HEAD)"
git submodule update --init --depth 1

echo "==> compiling"
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
  -DSIGIL_BUILD_SHARED=ON -DSIGIL_BUILD_CLI=OFF -DSIGIL_BUILD_TESTS=ON >/dev/null
cmake --build build -j"$(nproc)" >/dev/null 2>&1
echo "==> upstream unit tests"
(cd build && ctest --output-on-failure | grep -E 'tests passed|tests failed')

LIB="$(readlink -f build/libsigil.so)"
if ldd "$LIB" | grep -vqE 'linux-vdso|libc\.so|ld-linux'; then
  echo "!! libsigil.so links more than libc:"
  ldd "$LIB"
  exit 1
fi
cp "$LIB" "$BUILD_DIR/libsigil.so"

# Install into the engine package, which is where a shipped build lives: both
# the Decky zip and the desktop app carry romm_sync_engine wholesale, so a file
# there reaches users without either build script changing. title_ids finds it
# with no env var set. See engine/romm_sync_engine/bin/README.md.
BUNDLE_DIR="$REPO_ROOT/engine/romm_sync_engine/bin"
if [ -d "$BUNDLE_DIR" ]; then
  cp "$BUILD_DIR/libsigil.so" "$BUNDLE_DIR/libsigil.so"
  echo "==> installed into $BUNDLE_DIR/libsigil.so"
fi

echo
echo "built: $BUILD_DIR/libsigil.so ($(git rev-parse --short HEAD))"
echo "  glibc floor: $(objdump -T "$BUILD_DIR/libsigil.so" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)"
echo
echo "Ludo picks this up automatically. To force a specific build instead:"
echo "  export LUDO_SIGIL_LIB=$BUILD_DIR/libsigil.so"
echo "  python3 scripts/eden_doctor.py"
