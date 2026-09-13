# Adding Dependencies to the Decky Plugin

The Decky plugin runs on SteamOS, which has a minimal Python environment, and
Decky Loader's PyInstaller runtime exposes none of its own packages to plugins.
Every third-party package must be **bundled** into `py_modules/`, which
`main.py` puts on `sys.path`.

`decky-build.sh` does that bundling itself, from the `DEPS` list at the top of
the script: it downloads cp311/manylinux wheels and unpacks them into
`py_modules/` on every build, then fails the build if the result cannot be
imported. That is deliberate — the vendored directories are gitignored, so a
clean checkout (which is what CI builds from) has none of them. v1.0.0-beta.1
shipped with only Pillow and the backend for exactly that reason, and the engine
failed to import on device.

So: **there is no manual install step.** Add the package to `DEPS` in
`decky-build.sh` and rebuild.

## Currently Bundled Dependencies

- **requests** — HTTP library
- **watchdog** — File system monitoring
- **psutil** — Process/disk inspection (imported at `sync_core` module scope)
- **PIL (Pillow)** — Image processing
- **qrcode** — QR encoding for the device-auth pairing flow (pure Python, no C extensions)
- **certifi, charset_normalizer, idna, urllib3** — Transitive dependencies of requests
- **pypng, typing_extensions** — Transitive dependencies of qrcode

## How to Add a New Dependency

1. **Add it to `DEPS` in `decky-build.sh`.** Transitive dependencies resolve on
   their own — don't list them.

2. **Add the package to `.gitignore`** (following the existing pattern):
   ```
   py_modules/<package-name>/
   py_modules/<package-name>-*.dist-info/
   ```

3. **Update `DEPLOYMENT.md`** to list the new dependency in the "Required files in the ZIP" table.

4. **Test the build:**
   ```bash
   cd decky_plugin
   ./decky-build.sh
   ```
   The build imports what it vendored before packaging, so a missing or
   wrong-ABI wheel fails here rather than on a Deck.

## Notes

- Binary wheels must be cp311/manylinux — Decky Loader is Python 3.11, not the
  system Python, and a mismatched `.so` fails to import silently.
- `decky-build.sh` includes all `py_modules/` contents in the ZIP
- Bundled dependencies are excluded from git but included in the deployment ZIP
