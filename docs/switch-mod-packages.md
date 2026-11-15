# Switch mod packages

Ludo can install ZIP files attached to a Switch game with RomM's `mod` file
category. Open the game's **Files** tab, then choose a package under **Mod
packages**. The base game must identify a Switch title ID. Use a package made
for the installed game update: a matching title ID alone does not establish
patch/build compatibility.

Any archive Eden's own **Import Mod from ZIP** accepts works. Like Eden, Ludo
treats the folder holding an `exefs`, `romfs`, `romfs_ext`, `romfslite` or
`cheats` folder (any letter case) as one mod, so all of these install:

```text
romfs/...                                   mod named after the ZIP
<mod name>/romfs/...
<BASE_TITLE_ID>/<mod name>/exefs/...
atmosphere/contents/<BASE_TITLE_ID>/romfs/... mod named after the ZIP
```

An archive holding several mod folders installs each one; turn them on or off
under **Updates & DLC**. Files outside a mod folder are skipped, and a title ID
in the path must be the selected game's.

Archives can instead use logical paths, which also allow UltraCam settings files:

```text
load/<BASE_TITLE_ID>/<mod name>/{exefs,romfs,romfs_ext,romfslite,cheats}/...
sdmc/UltraCam/TOTK/Config/maxlastbreath.ini
sdmc/UltraCam/TOTK/Config/PaletteCFG.json
```

The load title must match the selected game. UltraCam configuration is limited
to `TOTK` for `0100F2C0115B6000` and `BOTW` for `01007EF00011E000`, with INI or
JSON files directly inside `Config`. Other framework layouts are unsupported.
The same archive can be consumed by an Android installer using those logical
roots; it contains no host scripts, shell commands, or hardcoded device paths.

Root README/license files, macOS metadata, and
`config/custom/<BASE_TITLE_ID>.ini` are skipped. Whole emulator settings are
not imported. Other unknown paths, title mismatches, links, encrypted members,
duplicate case-insensitive destinations, traversal, and oversized archives
reject the entire package before target writes. Limits are 10,000 entries,
256 MiB per file, and 1 GiB uncompressed/downloaded.

Packages are installed exactly as they are; configure emulator options in Eden
itself.

Ludo uses Eden's configured load and SD directories, or its normal data
directory. Multiple detected Eden installs are rejected as ambiguous. Native
and Flatpak installations need their matching configuration folder; portable
and custom data-folder layouts are not yet supported. Eden must be closed for
installation, updates, removal, or recovery.

Receipts and a persistent transaction journal live below Ludo's configuration
directory in `switch-mod-packages`. Updates refuse externally changed files.
Removal asks first when a file changed since it was installed, then deletes
Ludo's files including the edits; files that were there before are kept.
Differing unowned files and overlaps with another managed
package are never overwritten. Identical pre-existing files can be borrowed,
but are not modified by updates or deleted by removal. A failed or interrupted
transaction restores previous files and receipts on the next mutation;
external edits or damaged rollback data stop recovery for manual review.
The Files tab offers recovery explicitly; Ludo's normal and Steam-host launch
paths recover a pending transaction before booting a Switch game, or refuse
the launch if recovery cannot finish. They also refuse launch while a mod
package operation is in progress. External emulator launches are outside
Ludo's control.

The path conformance fixture is
`engine/tests/fixtures/switch-mod-paths.tsv`. It uses TOTK as the selected title
and records `install`, `skip`, or `reject` for each logical archive path.
No game or mod binaries are included in tests.
