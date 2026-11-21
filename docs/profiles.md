# Profiles

Several people can share one PC, each with their own RomM account, saves, play
history and Steam tiles. Downloaded games, covers, firmware and emulator cores
are shared, so nothing is downloaded twice. Profiles are a desktop app
feature; the Deck plugin keeps a single profile.

## Using profiles

Open the account menu and choose **Switch profile**. Each card shows the RomM
account the profile is signed in as and which Steam user it opens for.

- **A** opens a profile. Ludo restarts its engine under that profile.
- **Add profile** creates a signed-out profile and opens the setup wizard to
  sign in with another RomM account. The wizard's first screen has a
  **Switch profile** button to go back without signing in.
- **X** (Details) manages a profile: rename it, unlink its Steam user, or
  remove it. Removing deletes the profile's local settings and history; its
  saves on RomM and its local save folder are kept.

Every person needs their own RomM user, created on the RomM server.

## Which profile opens

1. A profile chosen in the app opens on the next start.
2. `--profile=<name or id>` on the command line (or `LUDO_PROFILE`).
3. The profile linked to the Steam account that launched Ludo. Steam passes
   the signed-in account to every app it starts (`SteamAppUser`), and Ludo
   matches it against Steam's `loginusers.vdf`.
4. The last profile used.

When a Steam account with no profile yet starts Ludo on a machine with more
than one profile, Ludo asks **Who's playing?** once. The answer links that
Steam account, so each person lands in their own profile from then on.
Switching profile later relinks the Steam account to the new choice.

## Where things are kept

```text
~/.config/ludo/                     first profile (unchanged from before profiles)
~/.config/ludo/profiles.json        profile list, Steam links, last used
~/.config/ludo/profiles/<id>/       every other profile: settings, sign-in, history
~/.config/ludo/cache/firmware/      shared: installed firmware and keys
~/.config/ludo/switch-mod-packages/ shared: Switch mod receipts
~/Ludo/profiles/<id>/{saves,states} RetroArch saves for every other profile
```

The first profile keeps RetroArch's own save folders. Every other profile
hands RetroArch its own `savefile_directory` and `savestate_directory` in the
per-launch overlay (`ludo-launch.cfg`); `retroarch.cfg` is never changed for
it. Ludo's Steam tiles go into the `userdata` of the Steam account using the
profile.

Switch saves are kept per profile through Eden's own users. The first profile
keeps the user Eden already had selected; every other profile gets an Eden
user of its own, added to Eden's user list (named after the profile) the first
time it is needed, while Eden is closed. Ludo starts Eden with `-u` for that
user and syncs only that user's save folder
(`nand/user/save/0000000000000000/<user>/<title>`). When Eden has never started, Ludo first
writes the user list Eden would make itself (one user named "Eden", which
stays the first profile's). Eden allows eight users; once they are all taken,
Ludo leaves Switch saves alone for any new profile.

Wii U saves work the same way through Cemu's accounts. The first profile
keeps the account Cemu has active; every other profile gets a Cemu account
of its own (named after the profile), added while Cemu is closed. When Cemu
has never started, Ludo first creates the "default" account Cemu would make
itself, so that account stays the first profile's. Ludo starts Cemu with
`-a <account>` and syncs only that account's folder
(`mlc01/usr/save/<title>/user/<account>`), plus the game's shared `common`
folder and its `meta` folder. Cemu allows twelve accounts; once they are
all taken, Ludo leaves Wii U saves alone for any new profile.
