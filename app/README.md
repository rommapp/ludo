# ludo-app

Ludo's backend, independent of the shell that hosts it.

`LudoBackend` is every RPC method the UI can call plus the sync machinery behind
them. Two shells construct it and expose those methods over their own transport:

| Shell | Entry point | Transport | Updates from |
|---|---|---|---|
| Decky plugin (Steam Deck) | `decky_plugin/main.py` | Decky `callable` IPC | `*-decky.zip` |
| Desktop (Linux/Windows PC) | `desktop/backend/server.py` | HTTP `POST /api/<method>` | `*-x86_64.AppImage` |

Neither shell imports the other. The handful of facts that genuinely differ
between them — the running version, which release asset the updater pulls, where
downloads may land — are passed in as a `HostProfile` (`host.py`) instead of
being read from the environment or patched onto module globals.

Sync itself lives one layer down in `romm_sync_engine` (`engine/`), which is
shared with RomM RetroArch Sync and is not Ludo-specific.

## Development

```bash
pip install -e ../engine
pip install -e . --no-deps          # romm-sync-engine isn't on PyPI
pip install -e '.[test]'  --no-deps
pytest
```

The Deck has no pip install step, so `decky_plugin/py_modules/ludo_app` is a dev
symlink to this package that `decky-build.sh` dereferences (`cp -rL`) when it
builds the zip. The AppImage build pip-installs it instead, in
`desktop/tools/prepare-runtime.sh`.
