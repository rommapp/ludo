"""The API file ID is revalidated before a mod ZIP can be downloaded."""
import io
import zipfile
from types import SimpleNamespace

import pytest

from ludo_app import mod_packages as M
from romm_sync_engine import switch_mods

TITLE = '0100F2C0115B6000'
MOD = f'load/{TITLE}/Example/exefs/subsdk3'


class Reply:
    headers = {}

    def __init__(self, data=None, blob=b''):
        self.data, self.blob = data, blob

    def json(self):
        return self.data

    def raise_for_status(self):
        pass

    def iter_content(self, _):
        yield self.blob

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


@pytest.fixture
def client(tmp_path, monkeypatch):
    target = switch_mods.Installer(tmp_path / 'state', tmp_path / 'load',
                                   tmp_path / 'sdmc', lambda: False)
    monkeypatch.setattr(M, 'installer', lambda: target)
    monkeypatch.setattr(M.emulator_saves, 'eden_is_running', lambda: False)
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as z:
        z.writestr(MOD, b'example-code')
    c = SimpleNamespace(authenticated=True, base_url='http://romm.test', calls=[])
    detail = {'fs_name': 'Example Game', 'files': [
        {'id': 1, 'file_name': 'Game.nsp', 'category': 'game'},
        {'id': 2, 'file_name': 'mods/backups/Example.zip', 'category': 'mod'},
        {'id': 3, 'file_name': 'gone.zip', 'category': 'mod', 'missing_from_fs': True},
        {'id': 4, 'file_name': 'patch.pchtxt', 'category': 'mod'},
        {'id': 5, 'file_name': 'Other.zip', 'category': 'game'},
    ]}

    def get(url, **kwargs):
        c.calls.append((url, kwargs))
        return Reply(blob=stream.getvalue()) if '/content/' in url else Reply(detail)
    c.session = SimpleNamespace(get=get)
    return c


def test_only_existing_mod_zips_are_offered(client):
    result = M.state(client, 1200, TITLE)
    assert result['server'] == [{'file_id': 2, 'file_name': 'mods/backups/Example.zip',
                                  'package_id': '1200:2'}]
    assert result['installed'] == []


def test_download_is_one_revalidated_file_then_install_and_remove(client, tmp_path):
    assert M.install(client, 1200, TITLE, 2, {})['status'] == 'ok'
    url, args = client.calls[-1]
    assert url.endswith('/api/roms/1200/content/Example%20Game')
    assert args['params'] == {'file_ids': '2'}
    assert (tmp_path / MOD).read_bytes() == b'example-code'
    assert M.state(client, 1200, TITLE)['installed'][0]['package_id'] == '1200:2'
    assert M.remove(TITLE, '1200:2')['status'] == 'ok'
    assert not (tmp_path / MOD).exists()


def test_forged_or_nonmod_file_id_never_downloads(client):
    for file_id in (1, 3, 4, 5, 999):
        assert M.install(client, 1200, TITLE, file_id, {}) == {'status': 'not-offered'}
    assert all('/content/' not in url for url, _ in client.calls)


def test_running_guard_stops_download_and_removal(client, monkeypatch):
    monkeypatch.setattr(M.emulator_saves, 'eden_is_running', lambda: True)
    assert M.install(client, 1200, TITLE, 2, {}) == {'status': 'running'}
    assert M.remove(TITLE, '1200:2') == {'status': 'running'}
    assert client.calls == []


def test_package_size_limit_stops_before_install(client, monkeypatch, tmp_path):
    monkeypatch.setattr(switch_mods, 'MAX_TOTAL_BYTES', 2)
    with pytest.raises(switch_mods.ModError):
        M.install(client, 1200, TITLE, 2, {})
    assert not (tmp_path / MOD).exists()


def test_recovery_before_launch_only_runs_for_a_pending_journal(monkeypatch):
    monkeypatch.setattr(M, 'pending', lambda: False)
    monkeypatch.setattr(M, 'recover', lambda: (_ for _ in ()).throw(AssertionError('unexpected recovery')))
    assert M.recover_before_launch() is None
    monkeypatch.setattr(M, 'pending', lambda: True)
    monkeypatch.setattr(M, 'recover', lambda: {'status': 'running'})
    assert 'Close Eden' in M.recover_before_launch()
    monkeypatch.setattr(M, 'recover', lambda: {'status': 'ok'})
    assert M.recover_before_launch() is None


async def test_both_launch_paths_share_the_mod_recovery_gate(monkeypatch, tmp_path):
    from ludo_app.backend import LudoBackend
    from ludo_app.host import HostProfile
    monkeypatch.setenv('HOME', str(tmp_path))
    backend = LudoBackend(host=HostProfile('test', '-x86_64.AppImage', tmp_path / 'runtime', 'desktop'))
    monkeypatch.setattr(backend, '_platform_slug_for', lambda g: g['platform_slug'])
    monkeypatch.setattr(M, 'recover_before_launch', lambda: 'recovery blocked')
    assert await backend._ready_to_boot({'platform_slug': 'switch'}, '/game.nsp') == (None, 'recovery blocked')
    assert await backend._ready_to_boot({'platform_slug': 'nes'}, '/game.nes') == ('/game.nes', None)
    backend._switch_fetch_state[42] = {'kind': 'mod'}
    path, reason = await backend._ready_to_boot({'platform_slug': 'switch'}, '/game.nsp')
    assert path is None and 'Wait for the mod' in reason
