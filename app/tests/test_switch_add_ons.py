"""The Updates & DLC section for a Switch game that is a folder ROM.

RomM folds a game and its add-ons into one entry named after the game alone,
so the name carries no title ID. Once downloaded, the base container inside
the folder states it, and the updates folder holds what Eden applies -- which
is all the section needs to show its switches, and to act on them.

Run with:  pytest app/tests
"""
from pathlib import Path
from types import SimpleNamespace

import pytest

from ludo_app import backend as backend_mod
from ludo_app.backend import LudoBackend
from ludo_app.host import HostProfile

DESKTOP = HostProfile("1.0.0", "-x86_64.AppImage", Path("/tmp/desk-rt"), "desktop")
ROM = 413
BASE = '0100F43008C44000'

# What Sigil reads from each container, keyed by filename.
READ = {
    'Pokémon Legends Z-A.nsp': {'title_id': BASE, 'base_id': BASE, 'kind': 'base', 'version': 0},
    'Pokémon Legends Z-A 2.0.0.nsp': {'title_id': '0100F43008C44800', 'base_id': BASE,
                                      'kind': 'update', 'version': 262144},
    'Pokémon Legends Z-A 2.0.2.nsp': {'title_id': '0100F43008C44800', 'base_id': BASE,
                                      'kind': 'update', 'version': 393216},
    'Pokémon Legends Z-A [Mega Dimension].nsp': {'title_id': '0100F43008C45002', 'base_id': BASE,
                                                 'kind': 'dlc', 'version': 0},
    'Other Game 1.1.nsp': {'title_id': '01001F5010DFA800', 'base_id': '01001F5010DFA000',
                           'kind': 'update', 'version': 65536},
}

# What the updates folder holds before each test.
IN_FOLDER = ['Pokémon Legends Z-A 2.0.0.nsp', 'Pokémon Legends Z-A 2.0.2.nsp',
             'Pokémon Legends Z-A [Mega Dimension].nsp', 'Other Game 1.1.nsp']


@pytest.fixture
def backend(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    switch = tmp_path / 'roms' / 'switch'
    game = switch / 'Pokémon Legends Z-A'
    extcontent = switch / 'extcontent'
    game.mkdir(parents=True)
    extcontent.mkdir()
    (game / 'Pokémon Legends Z-A.nsp').write_bytes(b'x' * 64)
    for name in IN_FOLDER:
        (extcontent / name).write_bytes(b'x')

    b = LudoBackend(host=DESKTOP)
    monkeypatch.setattr(b, "_games_index", lambda: {ROM: {
        'name': 'Pokémon Legends Z-A', 'platform_slug': 'switch',
        'file_name': 'Pokémon Legends Z-A', 'is_downloaded': True,
        'local_path': str(game)}})
    monkeypatch.setattr(b, "_prod_keys", lambda: None)
    monkeypatch.setattr(backend_mod.title_ids, "switch_content",
                        lambda path, prod_keys=None: READ.get(Path(path).name))
    monkeypatch.setattr(backend_mod.switch_content, "read_manifest", lambda: {})
    b._auto_sync = SimpleNamespace(
        switch_add_on_state=lambda name: None,
        switch_rom_dir=lambda: switch,
        switch_addon_mode=lambda: 'extcontent',
        switch_add_ons_for_rom=lambda g, library=None: [],
    )
    b._available_games = []
    b._eden_calls = []
    monkeypatch.setattr(backend_mod.eden_config, "add_ons_enabled",
                        lambda base_id, update_version=None: {'update': True, 'dlc': True})
    monkeypatch.setattr(backend_mod.eden_config, "mods_for", lambda base_id: [])
    monkeypatch.setattr(backend_mod.eden_config, "set_add_on_enabled",
                        lambda *a, **k: b._eden_calls.append((a, k)) or 'ok')
    return b


async def test_folder_rom_is_read_from_its_base_container(backend):
    state = await backend.switch_add_ons(ROM)
    assert state['kind'] == 'base'
    assert state['base_id'] == BASE
    # The newest update, as that is the one Eden applies.
    assert state['installed_update']['version'] == 393216
    assert [d['title_id'] for d in state['installed_dlc']] == ['0100F43008C45002']


async def test_toggle_reaches_eden_for_a_folder_rom(backend):
    assert await backend.set_switch_add_on_enabled(ROM, 'dlc', False) == {'status': 'ok'}
    (args, kwargs), = backend._eden_calls
    assert args[:3] == (BASE, 'dlc', False)


async def test_the_update_switch_goes_through_the_version_choice(backend, monkeypatch):
    calls = []
    monkeypatch.setattr(backend_mod.eden_config, "set_update_choice",
                        lambda *a: calls.append(a) or 'ok')
    await backend.set_switch_add_on_enabled(ROM, 'update', True)
    await backend.set_switch_add_on_enabled(ROM, 'update', False)
    assert calls == [(BASE, [393216, 262144], 393216), (BASE, [393216, 262144], None)]
    assert backend._eden_calls == []


async def test_not_downloaded_folder_rom_stays_unknown(backend, monkeypatch):
    monkeypatch.setattr(backend, "_games_index", lambda: {ROM: {
        'file_name': 'Pokémon Legends Z-A', 'is_downloaded': False}})
    assert await backend.switch_add_ons(ROM) == {'kind': None}
    assert await backend.set_switch_add_on_enabled(ROM, 'dlc', False) == {'status': 'not-switch'}


async def test_every_update_in_the_folder_is_offered(backend):
    state = await backend.switch_add_ons(ROM)
    assert [u['version'] for u in state['updates']] == [393216, 262144]
    # No config says otherwise, so Eden applies the newest.
    assert state['update_choice'] == 393216
    assert state['enabled']['update'] is True


async def test_choosing_an_update_hands_eden_every_folder_version(backend, monkeypatch):
    calls = []
    monkeypatch.setattr(backend_mod.eden_config, "set_update_choice",
                        lambda *a: calls.append(a) or 'ok')
    assert await backend.set_switch_update(ROM, 262144) == {'status': 'ok'}
    assert await backend.set_switch_update(ROM, None) == {'status': 'ok'}
    assert calls == [(BASE, [393216, 262144], 262144), (BASE, [393216, 262144], None)]


async def test_one_dlc_goes_off_by_renaming_and_comes_back(backend, tmp_path):
    dlc_id = '0100F43008C45002'
    live = tmp_path / 'roms' / 'switch' / 'extcontent' / 'Pokémon Legends Z-A [Mega Dimension].nsp'

    assert await backend.set_switch_dlc(ROM, []) == {'status': 'ok'}
    assert backend._eden_calls[-1][0] == (BASE, 'dlc', False)
    assert not live.exists()
    state = await backend.switch_add_ons(ROM)
    assert [(d['title_id'], d['enabled']) for d in state['installed_dlc']] == [(dlc_id, False)]

    assert await backend.set_switch_dlc(ROM, [dlc_id]) == {'status': 'ok'}
    assert backend._eden_calls[-1][0] == (BASE, 'dlc', True)
    assert live.is_file()
    state = await backend.switch_add_ons(ROM)
    assert [(d['title_id'], d['enabled']) for d in state['installed_dlc']] == [(dlc_id, True)]


async def test_nothing_is_renamed_while_eden_is_open(backend, monkeypatch, tmp_path):
    monkeypatch.setattr(backend_mod.eden_config, "set_add_on_enabled", lambda *a, **k: 'running')
    assert await backend.set_switch_dlc(ROM, []) == {'status': 'running'}
    assert (tmp_path / 'roms' / 'switch' / 'extcontent'
            / 'Pokémon Legends Z-A [Mega Dimension].nsp').is_file()


class StubRomm:
    """The server side of a folder ROM: its files, and download by file id."""
    authenticated = True
    base_url = 'http://romm.test'

    def __init__(self, files):
        self.files = files
        self.downloads = []
        self.paths = []
        stub = self

        class Session:
            def get(self, url, timeout=None, **kw):
                return SimpleNamespace(status_code=200, json=lambda: {'files': stub.files})
        self.session = Session()

    def download_rom(self, rom_id, name, path, progress_callback=None, file_ids=None, **kw):
        self.downloads.append((rom_id, name, file_ids))
        self.paths.append(Path(path))
        # A folder ROM's file lands inside the game folder, as download_rom does.
        target = (Path(path) / name) if file_ids else Path(path)
        target.write_bytes(b'x')
        if progress_callback:
            progress_callback({'progress': 1.0})
        return True, 'ok'


SERVER_FILES = [
    {'id': 1, 'file_name': 'Pokémon Legends Z-A.nsp', 'category': 'game'},
    {'id': 2, 'file_name': 'Pokémon Legends Z-A 1.0.1.nsp', 'category': 'update'},
    {'id': 3, 'file_name': 'Pokémon Legends Z-A 2.0.2.nsp', 'category': 'update'},
    {'id': 4, 'file_name': 'Pokémon Legends Z-A [Mega Dimension].nsp', 'category': 'dlc'},
    {'id': 5, 'file_name': '1.0.0.pchtxt', 'category': 'mod'},
    {'id': 6, 'file_name': 'Pokémon Legends Z-A [Gone].nsp', 'category': 'dlc',
     'missing_from_fs': True},
]
READ['Pokémon Legends Z-A 1.0.1.nsp'] = {'title_id': '0100F43008C44800', 'base_id': BASE,
                                          'kind': 'update', 'version': 65536}


async def test_server_add_ons_not_here_are_offered(backend):
    backend._romm_client = StubRomm(SERVER_FILES)
    state = await backend.switch_add_ons(ROM)
    # 2.0.2 and the DLC are already in the updates folder; the game and the
    # mod are not add-ons, and a file missing on the server cannot download.
    assert [u['file_name'] for u in state['server_updates']] == ['Pokémon Legends Z-A 1.0.1.nsp']
    assert state['server_dlc'] == []


async def test_a_fetched_update_sits_beside_the_installed_one(backend, tmp_path):
    backend._romm_client = StubRomm(SERVER_FILES)
    result = await backend.fetch_switch_add_on(ROM, ROM, 2, 'Pokémon Legends Z-A 1.0.1.nsp')
    assert result == {'status': 'ok', 'kind': 'update',
                      'title_id': '0100F43008C44800', 'version': 65536}
    assert backend._romm_client.downloads == [(ROM, 'Pokémon Legends Z-A 1.0.1.nsp', '2')]
    extcontent = tmp_path / 'roms' / 'switch' / 'extcontent'
    assert (extcontent / 'Pokémon Legends Z-A 1.0.1.nsp').is_file()
    assert (extcontent / 'Pokémon Legends Z-A 2.0.2.nsp').is_file()
    state = await backend.switch_add_ons(ROM)
    assert [u['version'] for u in state['updates']] == [393216, 262144, 65536]
    assert state['server_updates'] == []
    assert await backend.switch_fetch_progress(ROM) == {}


async def test_only_an_offered_file_is_fetched(backend):
    backend._romm_client = StubRomm(SERVER_FILES)
    assert await backend.fetch_switch_add_on(ROM, ROM, 5, '1.0.0.pchtxt') == {'status': 'not-offered'}
    assert await backend.fetch_switch_add_on(ROM, 999, 2, 'Pokémon Legends Z-A 1.0.1.nsp') \
        == {'status': 'not-offered'}
    assert backend._romm_client.downloads == []


async def test_a_manifest_dlc_turned_off_is_listed_once(backend, monkeypatch, tmp_path):
    # Installed by Ludo, so the manifest knows it -- and still names the path
    # the file had before it was renamed out of Eden's sight.
    dlc_id = '0100F43008C45002'
    live = tmp_path / 'roms' / 'switch' / 'extcontent' / 'Pokémon Legends Z-A [Mega Dimension].nsp'
    monkeypatch.setattr(backend_mod.switch_content, "read_manifest", lambda: {dlc_id: {
        'base_id': BASE, 'kind': 'dlc', 'version': 0, 'file_name': live.name,
        'mode': 'extcontent', 'path': str(live)}})
    assert await backend.set_switch_dlc(ROM, []) == {'status': 'ok'}
    state = await backend.switch_add_ons(ROM)
    assert [(d['title_id'], d['enabled']) for d in state['installed_dlc']] == [(dlc_id, False)]
    assert await backend.set_switch_dlc(ROM, [dlc_id]) == {'status': 'ok'}
    state = await backend.switch_add_ons(ROM)
    assert [(d['title_id'], d['enabled']) for d in state['installed_dlc']] == [(dlc_id, True)]


# A game that is not downloaded has no local_path. Path('') is the working
# directory, so the add-on scan used to walk wherever Ludo was started from --
# hiding any server add-on whose name turned up there -- and a fetch landed in
# it. These run from a directory holding exactly such a decoy.
SIBLING_UPDATE = 'Legends Update [0100F43008C44800][v65536].nsp'
READ[SIBLING_UPDATE] = {'title_id': '0100F43008C44800', 'base_id': BASE,
                        'kind': 'update', 'version': 65536}


@pytest.fixture
def not_downloaded(backend, monkeypatch, tmp_path):
    cwd = tmp_path / 'started-here'
    (cwd / 'deep').mkdir(parents=True)
    for name in ('Pokémon Legends Z-A 1.0.1.nsp', SIBLING_UPDATE):
        (cwd / 'deep' / name).write_bytes(b'decoy')
    monkeypatch.chdir(cwd)
    monkeypatch.setattr(backend, "_games_index", lambda: {ROM: {
        'file_name': f'Pokémon Legends Z-A [{BASE}][v0].nsp', 'is_downloaded': False}})
    backend._auto_sync.switch_add_on_state = lambda name: {
        'kind': 'base', 'base_id': BASE, 'title_id': BASE, 'version': 0, 'installed': False}
    backend._auto_sync.switch_add_ons_for_rom = lambda g, library=None: [
        {'rom_id': 77, 'name': 'Update', 'fs_name': SIBLING_UPDATE}]
    backend._auto_sync.install_switch_add_on = lambda path: {'status': 'ok'}
    backend._romm_client = StubRomm(SERVER_FILES)
    return cwd


async def test_not_downloaded_game_ignores_the_working_directory(backend, not_downloaded):
    state = await backend.switch_add_ons(ROM)
    assert [u['file_name'] for u in state['server_updates']] == [
        'Pokémon Legends Z-A 1.0.1.nsp', SIBLING_UPDATE]


async def test_a_folder_file_needs_the_game_downloaded(backend, not_downloaded):
    result = await backend.fetch_switch_add_on(ROM, ROM, 2, 'Pokémon Legends Z-A 1.0.1.nsp')
    assert result == {'status': 'failed', 'message': 'download the game first'}
    assert backend._romm_client.downloads == []


async def test_a_not_downloaded_games_add_on_lands_in_the_switch_folder(
        backend, not_downloaded, tmp_path):
    (not_downloaded / 'deep' / SIBLING_UPDATE).unlink()
    result = await backend.fetch_switch_add_on(ROM, 77, None, SIBLING_UPDATE)
    assert result['status'] == 'ok'
    # Downloaded into the Switch folder, not merely moved out of the working
    # directory afterwards by place_external.
    assert backend._romm_client.paths == [tmp_path / 'roms' / 'switch' / SIBLING_UPDATE]
    assert (tmp_path / 'roms' / 'switch' / 'extcontent' / SIBLING_UPDATE).is_file()
