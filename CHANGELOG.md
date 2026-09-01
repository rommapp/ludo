# Changelog

Notable changes per release. Ludo ships one version across both front-ends —
a tag builds the Decky zip and the AppImage together, and they are never
released apart (see [RELEASING.md](RELEASING.md)).

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions are [semantic](https://semver.org/). Full history is in the commit log,
which follows Conventional Commits.

## [Unreleased]

### Added
- `CONTRIBUTING.md`, `SECURITY.md`, issue and pull-request templates, and a
  top-level README.
- CI on every push and pull request: the engine suite, the backend suite, both
  typechecks, and the desktop render walk.

### Fixed
- The Decky zip now contains `bin/romm-session-host`. Nothing copied `bin/` into
  the zip, so no release had ever carried it, and Play fell back to a direct
  launch with no working Steam overlay in Gaming Mode.
- `pip install -e 'app[test]' --no-deps` skipped the extras it was meant to
  install, so the documented setup never installed pytest.
- `desktop/package-lock.json` was out of sync with `package.json`, so `npm ci`
  failed on a fresh clone.

### Changed
- The backend moved out of the Decky plugin into `app/`, shared with the desktop
  shell, and the sync engine into `engine/`. Both front-ends now construct the
  same `LudoBackend`, and neither imports the other.

### Removed
- The Decky plugin template's leftovers: its README, `defaults/defaults.txt`,
  and the Hello World C backend under `backend/`.
- `bin/7zz` (2.7 MB, never packaged) and the superseded GTK shell
  `desktop/app.py`.

## [1.0.0-beta.8] — 2026-08-22

The substantial beta. 141 commits: 48 features, 82 fixes, 4 performance.

### Added
- **Switch support, end to end** — save sync, Eden firmware install and version
  checks, `prod.keys` synced as its own RomM firmware entry, master-key
  generation reporting, and add-ons placed in a folder Eden reads.
- **Collections** — smart and virtual collections sync, browse and badge as they
  do in RomM, with a Library toggle to show or hide them.
- **QR code login** through RomM's device-auth flow.
- **Per-platform sync switches**, in Settings and the setup wizard.
- **A Files tab** with per-file presence, and a `LUDO_DEBUG` gate.
- Region and language flags on game tiles; readable labels and box art on the
  Downloads page; upload progress for saves.

## [1.0.0-beta.1] – [1.0.0-beta.7] — 2026-07-27

Seven same-day tags, each one or two commits, shaking out the release pipeline:
version lockstep between the two `package.json` files, asset naming, and the
updater's release selection. No user-facing changes worth separating.
