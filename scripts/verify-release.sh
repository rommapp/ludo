#!/usr/bin/env bash
# Confirm a published release is actually reachable by the in-app updater.
#
# CI runs the same check (release.yml's verify-updater job), but this is the
# version you can run by hand — after a manual publish, after deleting a bad
# release, or when a user reports "no update available" and you need to know
# whether the release or the client is at fault.
#
# Usage: scripts/verify-release.sh [version]   (default: desktop/package.json)
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./desktop/package.json').version")}"
VERSION="${VERSION#v}"

# On a private repo an unauthenticated read returns 404, which the updater
# cannot tell apart from "nothing published". Borrow gh's token when there is
# one so this script works the way CI does; the app itself never sets these.
if [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
  GH_TOKEN="$(gh auth token 2>/dev/null || true)"
  export GH_TOKEN
fi

# Import the shipping module rather than reimplementing its selection rules,
# so this tests the code users actually run.
VERSION="$VERSION" python3 - <<'PY'
import os, sys, logging
logging.basicConfig(level=logging.WARNING)
# The updater lives in the shared backend; the Decky entry point is only a
# bootstrap shim. Both dirs go on the path so ludo_app can import the engine
# without an install step.
sys.path[:0] = ['app', 'engine']
from ludo_app import backend

version = os.environ['VERSION']
channel = 'beta' if '-' in version else 'stable'
print(f'checking v{version} on the {channel} channel\n')

failures = []
for suffix in ('-decky.zip', '-x86_64.AppImage'):
    rel = backend.select_release(channel, suffix)
    if not rel:
        failures.append(f'{suffix}: updater resolves no release at all')
        print(f'FAIL {suffix}: no release carries this asset')
        continue
    asset = backend._release_asset(rel, suffix)
    tag = rel['tag_name'].lstrip('v')
    status = 'OK  ' if tag == version else 'FAIL'
    print(f'{status} {suffix} -> v{tag} / {asset["name"]} '
          f'({asset.get("size", 0) / 1e6:.1f} MB)')
    if tag != version:
        # Resolving an older tag means this release is not the semver max, or
        # it is missing the asset — either way the updater will never offer it.
        failures.append(f'{suffix}: resolved v{tag}, expected v{version}')

if failures:
    raise SystemExit('\n' + '\n'.join(failures))
print('\nboth front-ends can see this release')
PY
