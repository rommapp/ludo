# Security

## Reporting a vulnerability

Please report security issues **privately**, through GitHub's
[private vulnerability reporting](https://github.com/Covin90/ludo/security/advisories/new)
(the Security tab → Report a vulnerability). Don't open a public issue for
anything exploitable.

Include what it affects, how to reproduce it, and what an attacker gets. You
should get a first response within a week. Ludo is maintained by one person in
their spare time, so please be patient with fixes — but do chase if you hear
nothing.

## What Ludo handles

Ludo holds credentials for **your own** RomM server, and moves ROMs, saves and
firmware between that server and your machine. It has no cloud service, no
telemetry, and no backend of its own: every request goes to the server you
pointed it at.

The parts worth a careful look, if you're auditing:

- **RomM credentials** — `SettingsManager` in `engine/romm_sync_engine/sync_core.py`.
- **The update mechanism** — Ludo updates itself in place from GitHub releases
  (`select_release`, and `apply_appimage_update` in `decky_plugin/main.py`).
- **Switch keys and firmware** — `prod.keys` / `title.keys` handling in
  `emulator_saves.py` and `bios_manager.py`.
- **The local HTTP backend** — `desktop/backend/server.py` binds a random high
  port on loopback and dispatches `POST /api/<method>` straight to backend
  methods.

## Known limitations, stated plainly

**Stored credentials are obfuscated, not protected.** Settings are encrypted
with a Fernet key derived by SHA-256 from your username plus a machine ID. That
key material is available to anything running as you, and the derivation is
public — it's in the source you're reading. It stops a config file copied to
another machine from being useful; it does **not** protect against anything with
local access to your account. If `cryptography` is unavailable the code says so
on stderr and falls back to plaintext.

**The config file is written with default permissions.** No explicit `0600`, so
it inherits your umask.

**The local API has no authentication.** It binds loopback on a random high
port, and any process on the machine that finds that port can call it. This is
the same trust boundary as the credential storage above: Ludo assumes your user
account is not hostile to you.

None of these are bugs to report — they're documented design limits. What *is*
worth reporting: anything letting a **remote** party or another user on a shared
machine reach your credentials, your library, or code execution.

## Third-party binaries

Ludo ships two prebuilt binaries, each documented with its upstream source,
version, license and SHA-256 in the `bin/README.md` beside it:

- `engine/romm_sync_engine/bin/libsigil.so` — built by `scripts/build_sigil.sh`
- `decky_plugin/bin/7zz` — 7-Zip's official Linux x64 build
