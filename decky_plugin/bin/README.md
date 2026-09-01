# Bundled binaries

## `romm-session-host` — Steam session host

The executable behind the "RomM" Steam tile. When a game is picked, the backend's
`prepare_steam_launch` writes a launch-spec and the frontend `RunGame`s the tile;
Steam launches this script as a tracked game — which is what opens an overlay
session — and it `exec`s the resolved emulator argv in place, so the emulator
inherits that session. `backend.get_session_host_path()` resolves it here.

`decky-build.sh` copies it into the zip and marks it executable. It must stay
`chmod +x`: without it, Play falls back to a direct launch and the Steam overlay
does not work in Gaming Mode.

## `7zz` — removed

A static 7-Zip CLI used to live here, to extract `.7z` PC games on SteamOS,
which ships no system 7-Zip. Nothing ever packaged it — `decky-build.sh` did not
copy `bin/` at all — so it sat in the tree for its whole life without reaching a
single user, and was removed rather than left as 2.7 MB of dead weight.

Nothing depends on it. `sync_core._find_7z()` still resolves, in order: the
`ROMM_7ZIP` env var, a `bin/7zz` beside the engine package, then anything on
`PATH`; and `.7z` handling falls back to the `py7zr` dependency, which the
desktop build installs. `.7z` console ROMs load through RetroArch's native
archive support either way — only `.7z` PC games on a Deck are affected.

To bring it back, drop the binary in here and add a `cp` for it beside the
`romm-session-host` copy in `decky-build.sh`:

- 7-Zip 23.01 (2023-06-20), x86-64
- Source: https://www.7-zip.org/a/7z2301-linux-x64.tar.xz
- tarball sha256: `23babcab045b78016e443f862363e4ab63c77d75bc715c0b3463f6134cbcf318`
- `7zz` sha256: `c7f8769e2bc8df6bcbfba34571ee0340670a52dec824dbac844dd3b5bd1a69e1`
- License: the 7-Zip License (main code GNU LGPL v2.1+; parts BSD 3-clause; the
  unRAR portion under its own restriction). See https://www.7-zip.org/license.txt
