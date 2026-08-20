# Bundled binaries

## `libsigil.so` — argosy-sigil (x86-64)

Reads the game-native title ID out of a ROM, including the containers this
package's own Python reader cannot open: Switch NSP/XCI, whose ID lives in an
NCA header encrypted under a key from `prod.keys`. See `title_ids` for how it
is used and `switch_content` for what depends on it.

It lives **inside the package**, not in a sibling `bin/`, because that is the
one location both builds already carry. The Decky zip vendors
`romm_sync_engine` wholesale (`cp -rL py_modules/*`), and the desktop app
imports the engine straight from the tree — so a file here reaches a user
without either build script learning anything new. A top-level `bin/` does not:
`decky-build.sh` never copies one, which is why the `7zz` beside this comment's
sibling README has never actually shipped.

Without it nothing breaks: identification falls back to reading filenames,
which is correct for tagged dumps and blind for everything else. That fallback
was the *only* behaviour before this was bundled, and it is why a plainly named
"Metroid Dread.xci" could not be told apart from its own update.

- Version: 0.1.0-dev
- Source: https://github.com/rommforge/argosy-sigil (MPL-2.0)
- Built by: `scripts/build_sigil.sh`, which installs its result here
- Links: libc only. Highest requirement `GLIBC_2.33` — fine on SteamOS 3
  (2.36+), Arch, Fedora, Debian 12, Ubuntu 22.04+; too new for Ubuntu 20.04.
- Built WITHOUT the 3DS and Wii U extractors (they need zstd); those return
  `SIGIL_ERR_UNSUPPORTED_FORMAT`.

To refresh: run `scripts/build_sigil.sh` and commit the result.
