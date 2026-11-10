"""RomM file-category MOD packages, using the existing authenticated client."""
import tempfile
from pathlib import Path
from urllib.parse import quote, urljoin

from romm_sync_engine import eden_config, emulator_saves, paths, switch_mods


def pending():
    return (paths.config_dir() / 'switch-mod-packages/pending.json').exists()


def recover():
    if emulator_saves.eden_is_running():
        return {'status': 'running'}
    return installer().recover()


def recover_before_launch():
    if not pending():
        return None
    try:
        result = recover()
        return ('Close Eden and recover the interrupted mod install from Files → Mod packages.'
                if result['status'] != 'ok' else None)
    except Exception as e:
        return 'Recover the interrupted mod install before playing: ' + str(e)


def installer():
    data = emulator_saves.eden_data_dirs()
    if not data:
        raise switch_mods.ModError('Open Eden once before installing mods')
    if len(data) > 1:
        raise switch_mods.ModError('Multiple Eden data folders found; the target installation is ambiguous')
    known = dict(zip((Path(p).expanduser().resolve() for p in emulator_saves.EDEN_DATA_DIRS),
                     (Path(p).expanduser() for p in eden_config.EDEN_CONFIG_DIRS)))
    config = known.get(data[0].resolve())
    if config is None or eden_config.config_path(config) is None:
        raise switch_mods.ModError('A matching native or Flatpak Eden configuration was not found')
    load = eden_config.mod_load_root(config)
    sdmc = eden_config.mod_sdmc_root(config)
    if not load or not sdmc:
        raise switch_mods.ModError('Eden folders could not be located')
    for path, key in ((load, 'load_directory'), (sdmc, 'sdmc_directory')):
        if not path.is_absolute():
            raise switch_mods.ModError('Relative Eden folders are unsupported')
        if eden_config._setting('[Data%20Storage]', key, config) and not path.is_dir():
            raise switch_mods.ModError('Configured Eden folder is unavailable: ' + str(path))
    return switch_mods.Installer(paths.config_dir() / 'switch-mod-packages', load, sdmc,
                                 emulator_saves.eden_is_running)


def server_files(client, rom_id):
    if not client or not client.authenticated:
        raise switch_mods.ModError('Connect to RomM to list mod packages')
    response = client.session.get(urljoin(client.base_url, f'/api/roms/{rom_id}'), timeout=15)
    response.raise_for_status()
    detail = response.json()
    packages = []
    for file in detail.get('files') or []:
        name = file.get('file_name') or file.get('fs_name') or ''
        if (str(file.get('category') or '').lower() == 'mod'
                and not file.get('missing_from_fs') and file.get('id')
                and Path(name).suffix.lower() == '.zip'):
            packages.append({'file_id': file['id'], 'file_name': name,
                             'package_id': f'{rom_id}:{file["id"]}'})
    return detail, packages


def state(client, rom_id, title_id):
    result = {'title_id': title_id, 'server': [], 'installed': [], 'message': '', 'recovery_required': pending()}
    try:
        result['installed'] = installer().installed(title_id)
    except switch_mods.ModError as e:
        result['message'] = str(e)
    try:
        _, result['server'] = server_files(client, rom_id)
    except Exception as e:
        result['message'] = str(e)
    return result


def install(client, rom_id, title_id, file_id, progress, profile='original'):
    target = installer()
    if emulator_saves.eden_is_running():
        return {'status': 'running'}
    detail, offered = server_files(client, rom_id)
    entry = next((e for e in offered if e['file_id'] == file_id), None)
    if not entry:
        return {'status': 'not-offered'}
    name = detail.get('fs_name')
    if not name:
        raise switch_mods.ModError('RomM did not return the game folder name')
    # A single file ID streams the ZIP itself, even for a folder ROM. Do not
    # use download_rom here: its folder handling can extract the downloaded ZIP.
    url = urljoin(client.base_url, f'/api/roms/{rom_id}/content/{quote(name, safe="")}')
    with tempfile.TemporaryDirectory(prefix='ludo-mod-download-') as directory:
        archive = Path(directory) / 'package.zip'
        with client.session.get(url, params={'file_ids': str(file_id)}, stream=True,
                                timeout=(15, 60)) as response:
            response.raise_for_status()
            size = int(response.headers.get('content-length') or 0)
            if size > switch_mods.MAX_TOTAL_BYTES:
                raise switch_mods.ModError('Package download exceeds the size limit')
            total = 0
            with archive.open('wb') as sink:
                for block in response.iter_content(1024 * 1024):
                    total += len(block)
                    if total > switch_mods.MAX_TOTAL_BYTES:
                        raise switch_mods.ModError('Package download exceeds the size limit')
                    sink.write(block)
                    progress['percent'] = min(100, int(100 * total / size)) if size else 0
        progress['state'] = 'installing'
        if emulator_saves.eden_is_running():
            return {'status': 'running'}
        return target.install(archive, title_id, entry['package_id'], entry['file_name'], profile)


def remove(title_id, package_id):
    if emulator_saves.eden_is_running():
        return {'status': 'running'}
    return installer().remove(package_id, title_id)
