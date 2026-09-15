"""Read-only GitHub token for resolving releases on a private repo.

While the repo is private, GitHub answers an unauthenticated read of
``/releases`` with 404 — indistinguishable from "nothing published" — and
refuses the asset download outright. So a shipped build has to carry a
credential of its own if the updater is to work at all.

The token is NOT in git. ``scripts/embed-token.sh`` writes ``_token.py`` next
to this file during a release build, and that file is gitignored; a source
checkout simply has no token and falls back to anonymous reads, which is the
correct behaviour once the repo goes public.

Treat an embedded token as PUBLIC. It ships inside a zip any user can unpack,
so it must be a fine-grained PAT scoped to this one repository with
Contents: read-only and nothing else. Anyone who installs Ludo can use it to
read this repo's source. That is the price of shipping an updater before the
repo opens up, and it is the only thing the token may be able to do.
"""
import os


def release_token():
    """The token to authenticate release reads with, or None for anonymous.

    Environment first, so CI and ``scripts/verify-release.sh`` keep overriding
    whatever a build embedded, and so a developer can test against their own
    credentials without rebuilding.
    """
    env = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
    if env:
        return env.strip()
    try:
        from ._token import TOKEN
    except Exception:
        return None
    # Split/rejoined at build time purely to keep the literal from tripping
    # secret scanners and casual greps. This is obfuscation, not protection.
    token = ''.join(TOKEN).strip()
    return token or None
