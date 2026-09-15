#!/usr/bin/env bash
# Confirm a published release is actually reachable by the in-app updater.
#
# CI runs the same check (release.yml's verify-updater job), but this is the
# version you can run by hand — after a manual publish, after deleting a bad
# release, or when a user reports "no update available" and you need to know
# whether the release or the client is at fault.
#
# Checked ANONYMOUSLY, because that is what a shipped install is: the app never
# sets a token. This script used to borrow gh's token to "work like CI", which
# made it pass on a private repo while every real user saw nothing — a green
# check for the one condition it exists to catch. The authenticated read now
# runs only as a follow-up, to tell "the repo is private" apart from "the
# release is broken".
#
# Usage: scripts/verify-release.sh [version]   (default: desktop/package.json)
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./desktop/package.json').version")}"
VERSION="${VERSION#v}"

# Import the shipping module rather than reimplementing its selection rules,
# so this tests the code users actually run.
read -r -d '' CHECK <<'PY' || true
import os, sys, logging
logging.basicConfig(level=logging.WARNING)
# The updater lives in the shared backend; the Decky entry point is only a
# bootstrap shim. Both dirs go on the path so ludo_app can import the engine
# without an install step.
sys.path[:0] = ['app', 'engine']
from ludo_app import backend

version = os.environ['VERSION']
channel = 'beta' if '-' in version else 'stable'

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

raise SystemExit(1 if failures else 0)
PY

channel=beta; case "$VERSION" in *-*) ;; *) channel=stable ;; esac
echo "checking v$VERSION on the $channel channel, as a shipped install sees it"
echo

if VERSION="$VERSION" GH_TOKEN= GITHUB_TOKEN= python3 -c "$CHECK"; then
  echo
  echo "both front-ends can see this release"
  exit 0
fi

# Anonymous failed. A token read distinguishes the two causes, and they need
# very different fixes — one is a repo setting, the other is a bad release.
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$TOKEN" ] && command -v gh >/dev/null 2>&1; then
  TOKEN="$(gh auth token 2>/dev/null || true)"
fi

echo
if [ -n "$TOKEN" ] && VERSION="$VERSION" GH_TOKEN="$TOKEN" python3 -c "$CHECK" >/dev/null 2>&1; then
  echo "The release itself is fine — it resolves when authenticated."
  echo "Users cannot see it because the repository is private: GitHub answers"
  echo "an unauthenticated read with 404, which the updater cannot tell apart"
  echo "from 'nothing published'. Make the repo public, or ship a token."
else
  echo "The release is unreachable even with a token — this is the release,"
  echo "not the repository's visibility. Check the tag, the assets, and that"
  echo "this version is the semver maximum."
fi
exit 1
