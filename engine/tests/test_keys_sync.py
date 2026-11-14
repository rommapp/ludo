"""Independent Switch key uploads/receipts, with synthetic data and no network."""
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from romm_sync_engine import emulator_saves as E
from romm_sync_engine.bios_manager import BiosManager
from romm_sync_engine.sync_core import AutoSyncManager
from test_keys import KEY_TEXT, OTHER_KEY_TEXT, TITLE_KEY_TEXT


def main():
    with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'HOME': tmp}):
        root = Path(tmp)
        data = root / '.local/share/eden'
        registered = data / 'nand/system/Contents/registered'
        registered.mkdir(parents=True)
        prod = {'id': 1, 'file_name': 'prod.keys', 'md5_hash': 'aa',
                'updated_at': '2026-01', 'file_size_bytes': 200}
        title = {'id': 2, 'file_name': 'title.keys', 'md5_hash': 'bb',
                 'updated_at': '2026-02', 'file_size_bytes': 67}
        bundle = {'id': 3, 'file_name': 'keys.zip', 'md5_hash': 'cc',
                  'updated_at': '2025-12', 'file_size_bytes': 300}
        source = root / 'uploads'
        source.mkdir()
        (source / 'prod.keys').write_bytes(KEY_TEXT)
        (source / 'title.keys').write_bytes(TITLE_KEY_TEXT)
        with zipfile.ZipFile(source / 'keys.zip', 'w') as archive:
            archive.writestr('prod.keys', OTHER_KEY_TEXT)
            archive.writestr('title.keys', TITLE_KEY_TEXT)
        bios = BiosManager.__new__(BiosManager)
        entries = [prod, title]
        bios._fetch_platforms = lambda: [{'slug': 'switch', 'firmware': entries}]
        downloads = []
        failing = set()

        def download(entry, *args, **kwargs):
            downloads.append(entry['file_name'])
            return None if entry['file_name'] in failing else source / entry['file_name']

        bios.download_firmware_entry = download
        bios.find_firmware_entry = lambda slug: None
        manager = AutoSyncManager.__new__(AutoSyncManager)
        manager.retroarch = SimpleNamespace(bios_manager=bios)
        manager.log = lambda text: None
        manager.forget_title_ids = lambda: None

        # Latest per kind, not just the latest overall, and ordered for overwrite.
        old_prod = {**prod, 'id': 9, 'updated_at': '2024-01'}
        old_bundle = {**bundle, 'id': 8, 'updated_at': '2024-02'}
        entries[:] = [title, old_bundle, old_prod, prod, bundle]
        assert bios.find_keys_entries('switch') == [bundle, prod, title]
        assert E.key_file_name('prod.keys.zip') is None
        assert E.key_file_name('prod.keys.txt') == 'prod.keys'
        entries[:] = [prod, title]
        assert E.identify_upload(source / 'title.keys') == 'keys'
        assert E.looks_like_keys(TITLE_KEY_TEXT, 'TITLE.KEYS')
        assert not E.looks_like_keys(TITLE_KEY_TEXT)
        for invalid in (b'', b'<html>error</html>', b'0' * 31 + b' = ' + b'1' * 32,
                        b'0' * 32 + b' = ' + b'1' * 33, KEY_TEXT):
            assert not E.looks_like_keys(invalid, 'title.keys')

        result = manager._sync_switch_keys(bios)
        assert result['status'] == 'installed' and result['installed'] == 2, result
        assert downloads == ['prod.keys', 'title.keys'], downloads
        assert (data / 'keys/title.keys').read_bytes() == TITLE_KEY_TEXT
        assert all(E.keys_are_current(e) for e in entries)
        assert set(E.read_keys_marker()['files']) == {'prod.keys', 'title.keys'}
        downloads.clear()
        assert manager._sync_switch_keys(bios)['status'] == 'up-to-date'
        assert downloads == []
        for entry in (title, prod):
            (data / 'keys' / entry['file_name']).unlink()
            assert not E.keys_are_current(entry)
            assert E.keys_are_current(prod if entry is title else title)
            downloads.clear()
            assert manager._sync_switch_keys(bios)['installed'] == 1
            assert downloads == [entry['file_name']], downloads
        prod['md5_hash'] = 'changed'
        downloads.clear()
        assert manager._sync_switch_keys(bios)['installed'] == 1
        assert downloads == ['prod.keys']

        # Newer bundle overrides older bare entries once, then remains current.
        bundle['updated_at'] = '2026-03'
        entries.append(bundle)
        downloads.clear()
        assert manager._sync_switch_keys(bios)['installed'] == 2
        assert downloads == ['keys.zip']
        assert (data / 'keys/prod.keys').read_bytes() == OTHER_KEY_TEXT
        assert manager._sync_switch_keys(bios)['installed'] == 0
        (data / 'keys/title.keys').unlink()
        downloads.clear()
        assert manager._sync_switch_keys(bios)['installed'] == 3
        assert downloads == ['title.keys', 'keys.zip']
        # Changing an older entry must not leave its content over a newer bundle.
        prod['md5_hash'] = 'changed-again'
        downloads.clear()
        assert manager._sync_switch_keys(bios)['installed'] == 3
        assert downloads == ['prod.keys', 'keys.zip']
        assert (data / 'keys/prod.keys').read_bytes() == OTHER_KEY_TEXT

        # A bundle containing only prod records only what it actually installed.
        entries[:] = [bundle]
        bundle['md5_hash'] = 'prod-only'
        with zipfile.ZipFile(source / 'keys.zip', 'w') as archive:
            archive.writestr('prod.keys', KEY_TEXT)
            archive.writestr('title.keys', b'')
        assert manager._sync_switch_keys(bios)['installed'] == 1
        assert E.read_keys_marker()['entries']['keys.zip']['files'] == ['prod.keys']
        (data / 'keys/title.keys').unlink()
        assert E.keys_are_current(bundle)

        # Optional failure does not stop prod; neither install order gates the other.
        entries[:] = [title, prod]
        failing.add('title.keys')
        prod['md5_hash'] = 'new-prod'
        result = manager.sync_switch_firmware()
        assert result['status'] == 'failed' and result['keys'] == 1, result
        assert 'title.keys' in result['message'] and 'retry' in result['message']
        assert E.find_prod_keys() is not None
        fw = {'file_name': 'Firmware.1.0.0.zip', 'md5_hash': 'dd'}
        (registered / 'a.nca').write_bytes(b'N')
        E.write_firmware_marker(fw['file_name'], fw['md5_hash'], 1)
        bios.find_firmware_entry = lambda slug: fw
        assert manager.sync_switch_firmware()['status'] == 'failed'
        availability = manager.switch_firmware_update_available()
        assert not availability['available']
        failing.clear()
        result = manager.sync_switch_firmware()
        assert result['status'] == 'installed' and result['keys'] == 1, result
        (data / 'keys/prod.keys').unlink()
        (data / 'keys/title.keys').unlink()
        failing.add('prod.keys')
        result = manager.sync_switch_firmware()
        assert result['status'] == 'no-keys' and result['keys'] == 1, result
        assert (data / 'keys/title.keys').exists()
        failing.clear()

        # Manual per-file policy, plus lossless migration of old keys.json.
        marker = E._keys_marker_path()
        legacy = {'file_name': 'prod.keys', 'md5': 'legacy', 'extra': 'retain'}
        marker.write_text(json.dumps(legacy))
        (data / 'keys/prod.keys').write_bytes(KEY_TEXT)
        assert E.keys_are_current({**prod, 'md5_hash': 'LEGACY'})
        assert not E.keys_are_current(prod)
        assert E.keys_are_current(title)  # manual title, no title receipt
        E.write_keys_marker('title.keys', 'bb', ['title.keys'])
        migrated = E.read_keys_marker()
        assert migrated['extra'] == 'retain'
        assert migrated['entries']['prod.keys']['md5'] == 'legacy'
        (data / 'keys/title.keys').unlink()
        assert not E.keys_are_current(title)
        marker.unlink()
        assert E.keys_are_current(prod)  # no receipt: manual prod respected
        assert not E.keys_are_current(title)
        entries[:] = [bundle, title]
        bundle['md5_hash'] = 'manual-prod'
        with zipfile.ZipFile(source / 'keys.zip', 'w') as archive:
            archive.writestr('prod.keys', OTHER_KEY_TEXT)
            archive.writestr('title.keys', TITLE_KEY_TEXT)
        # Fetch title independently without ever replacing the manual prod.
        assert manager._sync_switch_keys(bios)['installed'] == 1
        assert (data / 'keys/prod.keys').read_bytes() == KEY_TEXT
        assert E.keys_are_current(prod)

        bios.find_firmware_entry = lambda slug: None
        (data / 'keys/title.keys').unlink()
        (data / 'keys/prod.keys').unlink()
        entries[:] = [title]
        result = manager.sync_switch_firmware()
        assert result['status'] == 'no-firmware' and result['keys'] == 1, result
        assert 'key file' in result['message'] and 'prod.keys;' not in result['message']

        # Keys-only reports both files; firmware install retains their count too.
        entries[:] = [prod, title]
        for name in ('prod.keys', 'title.keys'):
            (data / 'keys' / name).unlink(missing_ok=True)
        result = manager.sync_switch_firmware()
        assert result['status'] == 'installed' and result['keys'] == 2, result
        for name in ('prod.keys', 'title.keys'):
            (data / 'keys' / name).unlink()
        fw['md5_hash'] = 'new-firmware'
        with zipfile.ZipFile(source / fw['file_name'], 'w') as archive:
            archive.writestr('b.nca', b'N')
        bios.find_firmware_entry = lambda slug: fw
        result = manager.sync_switch_firmware()
        assert result['status'] == 'installed' and result['keys'] == 2, result
        assert result['installed'] == 1

        # Stale firmware receipt, but existing NCAs: installed keys still count.
        (data / 'keys/title.keys').unlink()
        fw['md5_hash'] = 'changed-receipt'
        result = manager.sync_switch_firmware()
        assert result['installed'] == 0 and result['keys'] == 1, result
        assert result['status'] == 'installed', result

        # Invalid optional title is not installed and cannot produce false success.
        for invalid in (b'', b'<html>Not found</html>'):
            title['md5_hash'] += 'new'
            prod['md5_hash'] += 'new'
            (source / 'title.keys').write_bytes(invalid)
            result = manager.sync_switch_firmware()
            assert result['status'] == 'failed' and result['keys'] == 1, result
            assert (data / 'keys/title.keys').read_bytes() == TITLE_KEY_TEXT

    print('all independent Switch key sync checks passed')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
