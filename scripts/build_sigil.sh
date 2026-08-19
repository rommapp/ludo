#!/usr/bin/env bash
# Build libsigil.so for Ludo, without cmake.
#
# argosy-sigil (https://github.com/rommforge/argosy-sigil, MPL-2.0) reads the
# game-native title ID out of a ROM. Ludo uses it for the containers its own
# reader cannot open — above all Switch NSP/XCI, whose ID lives in an NCA header
# encrypted under a key from prod.keys.
#
# The upstream build wants cmake. This builds the subset Ludo actually uses with
# nothing but gcc, which is what an immutable/atomic desktop tends to have. 3DS
# and Wii U are omitted (they need zstd) and stubbed out below.
#
#   ./scripts/build_sigil.sh [build-dir]     # default: ./sigil-build
#
# Then point Ludo at the result:
#   export LUDO_SIGIL_LIB=<build-dir>/libsigil.so
set -euo pipefail

BUILD_DIR="${1:-$PWD/sigil-build}"
SRC_DIR="$BUILD_DIR/argosy-sigil"

command -v gcc >/dev/null || { echo "gcc is required"; exit 1; }
command -v git >/dev/null || { echo "git is required"; exit 1; }

mkdir -p "$BUILD_DIR"
if [ ! -d "$SRC_DIR/.git" ]; then
  echo "==> cloning argosy-sigil"
  git clone --depth 1 https://github.com/rommforge/argosy-sigil "$SRC_DIR"
fi
cd "$SRC_DIR"

echo "==> fetching tiny-AES-c (AES-XTS for NCA headers)"
git submodule update --init --depth 1 third_party/tiny-AES-c

# sigil.c dispatches to every platform extractor, so the two we exclude still
# have to resolve at link time. They return the same code the library uses for a
# format it was not built with.
cat > stubs.c <<'STUB'
/* 3DS and Wii U need zstd; this build omits them. */
#include "sigil.h"
#include "sigil_internal.h"
int sigil_extract_3ds(const sigil_io *io, const char *hint,
                      const sigil_options *opts, sigil_result *out)
{ (void)io; (void)hint; (void)opts; (void)out; return SIGIL_ERR_UNSUPPORTED_FORMAT; }
int sigil_extract_wiiu(const sigil_io *io, const char *hint,
                       const sigil_options *opts, sigil_result *out)
{ (void)io; (void)hint; (void)opts; (void)out; return SIGIL_ERR_UNSUPPORTED_FORMAT; }
STUB

echo "==> compiling"
# ECB and CTR are tiny-AES-c's feature switches: XTS is built on ECB, and the
# CNMT reader needs CTR. CBC is unused.
gcc -shared -fPIC -O2 -std=c99 \
  -D_POSIX_C_SOURCE=200809L -D_DEFAULT_SOURCE -D_FILE_OFFSET_BITS=64 \
  -DSIGIL_EXPORTS -DSIGIL_WITH_SWITCH=1 -DSIGIL_WITH_FILENAME=1 \
  -DECB=1 -DCTR=1 -DCBC=0 \
  -Iinclude -Isrc -Ithird_party/tiny-AES-c \
  src/sigil.c src/aes_xts.c src/cnf_parser.c src/filename.c src/io_file.c \
  src/io_raw_cd.c src/iso9660.c src/ps2.c src/ps3.c src/psp.c src/psvita.c \
  src/psx.c src/sfo_parser.c src/switch_cnmt.c src/switch_keys.c \
  src/switch_nca.c src/switch_nsp.c src/switch_xci.c src/wii.c src/xbox360.c \
  stubs.c third_party/tiny-AES-c/aes.c \
  -o "$BUILD_DIR/libsigil.so"

if nm -D --undefined-only "$BUILD_DIR/libsigil.so" | grep -q sigil_; then
  echo "!! unresolved sigil symbols remain:"
  nm -D --undefined-only "$BUILD_DIR/libsigil.so" | grep sigil_
  exit 1
fi

echo
echo "built: $BUILD_DIR/libsigil.so"
echo
echo "use it with:"
echo "  export LUDO_SIGIL_LIB=$BUILD_DIR/libsigil.so"
echo "  python3 scripts/switch_check.py"
