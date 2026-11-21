"""Profile RPCs (#78): what the switcher sees and what each action does."""
import json

import pytest

from romm_sync_engine import paths, profiles


@pytest.fixture
def backend(monkeypatch, tmp_path):
    from ludo_app.backend import LudoBackend
    from ludo_app.host import HostProfile
    monkeypatch.setenv('HOME', str(tmp_path))
    for key in ('SteamAppUser', 'SteamUser', 'SteamClientLaunch'):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(paths, '_profile', profiles.DEFAULT)
    b = LudoBackend(host=HostProfile('test', '-x86_64.AppImage', tmp_path / 'runtime', 'desktop'))
    steam = tmp_path / '.local/share/Steam/config'
    steam.mkdir(parents=True)
    (steam / 'loginusers.vdf').write_text(
        '"users"\n{\n\t"76561197960265740"\n\t{\n\t\t"AccountName"\t\t"mia.plays"\n\t}\n}\n')
    monkeypatch.setattr(profiles, 'launch', {'id': profiles.DEFAULT, 'steam': '12', 'ask': True})
    yield b


async def test_single_profile_shell_reports_unsupported(backend, monkeypatch):
    monkeypatch.setattr(profiles, 'launch', None)
    assert await backend.get_profiles() == {'supported': False}
    assert (await backend.switch_profile('default'))['status'] == 'unsupported'
    assert (await backend.create_profile('Mia'))['status'] == 'unsupported'


async def test_list_shows_steam_user_and_asks(backend):
    data = await backend.get_profiles()
    assert data['supported'] and data['ask'] and data['current'] == 'default'
    assert data['steam'] == {'id': '12', 'name': 'mia.plays'}
    [only] = data['profiles']
    assert only['current'] and not only['removable'] and only['name'] == 'New profile'


async def test_create_opens_the_new_profile_and_links_steam(backend):
    created = await backend.create_profile('Mia')
    assert created['status'] == 'reload' and created['id']
    stored = json.loads((paths.machine_dir() / 'profiles.json').read_text())
    assert stored['next'] == created['id'] and stored['steam'] == {'12': created['id']}
    data = await backend.get_profiles()
    assert not data['ask']
    mia = next(p for p in data['profiles'] if p['id'] == created['id'])
    assert mia['name'] == 'Mia' and mia['steam'] == ['mia.plays'] and not mia['signed_in']
    assert mia['removable']


async def test_choosing_the_open_profile_needs_no_restart(backend):
    assert await backend.switch_profile('default') == {'status': 'ok'}
    stored = json.loads((paths.machine_dir() / 'profiles.json').read_text())
    assert 'next' not in stored and stored['steam'] == {'12': 'default'}
    assert (await backend.switch_profile('nope'))['status'] == 'error'


async def test_rename_unlink_and_remove(backend):
    created = (await backend.create_profile(''))['id']
    assert (await backend.rename_profile(created, '  Leo  '))['status'] == 'ok'
    assert (await backend.unlink_profile_steam(created))['status'] == 'ok'
    data = await backend.get_profiles()
    leo = next(p for p in data['profiles'] if p['id'] == created)
    assert leo['name'] == 'Leo' and leo['custom_name'] and leo['steam'] == []
    assert (await backend.remove_profile('default'))['status'] == 'error'
    assert (await backend.remove_profile(created))['status'] == 'ok'
    assert [p['id'] for p in (await backend.get_profiles())['profiles']] == ['default']


async def test_signed_in_identity_and_avatar_are_cached_for_the_picker(backend):
    backend._store_account_user({'username': 'covin', 'role': 'admin'})
    backend._remember_profile_avatar('data:image/png;base64,AAAA')
    [me] = (await backend.get_profiles())['profiles']
    assert me['username'] == 'covin' and me['role'] == 'admin'
    assert me['avatar'] == 'data:image/png;base64,AAAA'


async def test_an_account_without_an_avatar_drops_the_old_face(backend):
    # A profile that switched to an account with no avatar must not keep the
    # previous account's picture in the picker.
    backend._remember_profile_avatar('data:image/png;base64,AAAA')

    class Client:
        authenticated = True
        def get_current_user(self):
            return {'id': 6, 'username': 'ludo-test', 'avatar_path': ''}

    backend._romm_client = Client()
    backend._screenshot_mode = lambda: False
    assert (await backend.get_avatar())['data_uri'] is None
    [me] = (await backend.get_profiles())['profiles']
    assert me['avatar'] is None


async def test_link_from_manage_without_a_steam_launch(backend, monkeypatch):
    monkeypatch.setattr(profiles, 'launch', {'id': profiles.DEFAULT, 'steam': None, 'ask': False})
    created = (await backend.create_profile('Leo'))['id']
    data = await backend.get_profiles()
    assert data['steam'] is None
    assert data['steam_accounts'] == [{'id': '12', 'name': 'mia.plays', 'linked_to': None}]
    assert (await backend.link_profile_steam(created, '12'))['status'] == 'ok'
    data = await backend.get_profiles()
    assert data['steam_accounts'][0]['linked_to'] == created
    assert next(p for p in data['profiles'] if p['id'] == created)['steam'] == ['mia.plays']
    assert (await backend.link_profile_steam(created, '999'))['status'] == 'error'
