#!/usr/bin/env python3
"""
BIOS Manager for the RomM sync engine
Handles BIOS detection, verification, and synchronization
"""

from pathlib import Path
import hashlib
import logging
import threading
import time

# ─── Platforms whose firmware belongs in a subfolder of the system dir ───────
# Most cores read the system directory flat, but a few insist on their own
# subfolder and report "no BIOS" for a file sitting one level up. Flycast is the
# well-known case: "all bios files need to be in a directory named 'dc' in
# RetroArch's system directory" — which is also why RetroDECK ships bios/dc/
# while its ROM folder is called dreamcast.
#
# Keyed by canonical platform name (what this module works in) rather than by
# core, so only platforms where every core Ludo would pick agrees on the folder
# belong here. Deliberately absent:
#   - Saturn: Beetle Saturn reads flat, Kronos wants kronos/ — core-dependent,
#     and Beetle Saturn is the default, so flat is the better single answer.
#   - DS: melonDS DS *prefers* melonDS DS/ but reads flat, and DeSmuME/melonDS
#     only read flat.
#   - Neo Geo/arcade: FBNeo searches fbneo/ then the flat dir, so flat works.
# Everything else checked (Beetle PSX, Opera/3DO, Genesis Plus GX, mGBA, Stella,
# ProSystem, Handy, PUAE) takes firmware flat. Paths verified against the
# libretro core docs, August 2026 — the omissions are checked facts, not gaps.
BIOS_SUBDIR_BY_PLATFORM = {
    'Sega - Dreamcast': 'dc',            # flycast; Naomi/Atomiswave zips too
    'Sony - PlayStation 2': 'pcsx2/bios',  # lrps2; both components lowercase
}


class BiosManager:
    """Manages BIOS files for RetroArch cores"""

    def __init__(self, retroarch_interface, romm_client=None, log_callback=None, settings=None):
        self.retroarch = retroarch_interface
        self.romm_client = romm_client
        self.log = log_callback or print
        self.settings = settings  # Use passed settings instead of creating new one
        
        # Find system directory
        self.system_dir = self.find_system_directory()
        
        # Cache for installed BIOS files
        self.installed_bios = {}
        self.scan_installed_bios()

        # /api/platforms response, cached — see _fetch_platforms.
        self._platforms_cache = None
        self._platforms_cache_at = 0.0
        self._platforms_lock = threading.Lock()
        
        # Platform name normalization map
        self.platform_aliases = {
            'playstation': 'Sony - PlayStation',
            'ps1': 'Sony - PlayStation',
            'psx': 'Sony - PlayStation',
            'playstation-2': 'Sony - PlayStation 2',
            'ps2': 'Sony - PlayStation 2',
            'sega-saturn': 'Sega - Saturn',
            'saturn': 'Sega - Saturn',
            'sega-cd': 'Sega - Mega-CD - Sega CD',
            'mega-cd': 'Sega - Mega-CD - Sega CD',
            'segacd': 'Sega - Mega-CD - Sega CD',
            'dreamcast': 'Sega - Dreamcast',
            'dc': 'Sega - Dreamcast',
            'neo-geo': 'SNK - Neo Geo',
            'neogeo': 'SNK - Neo Geo',
            'nintendo-ds': 'Nintendo - Nintendo DS',
            'nds': 'Nintendo - Nintendo DS',
            'game-boy-advance': 'Nintendo - Game Boy Advance',
            'gba': 'Nintendo - Game Boy Advance',
            'game-boy': 'Nintendo - Game Boy',
            'gb': 'Nintendo - Game Boy',
            'game-boy-color': 'Nintendo - Game Boy Color',
            'gbc': 'Nintendo - Game Boy Color',
            'pc-engine': 'NEC - PC Engine - TurboGrafx 16',
            'turbografx': 'NEC - PC Engine - TurboGrafx 16',
            'turbografx-16': 'NEC - PC Engine - TurboGrafx 16',
            'pce': 'NEC - PC Engine - TurboGrafx 16',
            'atari-7800': 'Atari - 7800',
            'atari-lynx': 'Atari - Lynx',
            'lynx': 'Atari - Lynx',
            '3do': '3DO',
            'msx': 'Microsoft - MSX',
            'msx2': 'Microsoft - MSX',
            'amiga': 'Commodore - Amiga',
            'psp': 'Sony - PlayStation Portable',
            'playstation-portable': 'Sony - PlayStation Portable',
            '3ds': 'Nintendo - Nintendo 3DS',
            'nintendo-3ds': 'Nintendo - Nintendo 3DS',
        }

    def refresh_system_directory(self):
        """Refresh system directory path (useful when settings change)"""
        self.system_dir = self.find_system_directory()
        if self.system_dir:
            self.scan_installed_bios()
            self.log(f"📁 BIOS directory refreshed: {self.system_dir}")
        else:
            self.log("⚠️ No BIOS directory found after refresh")

    def find_system_directory(self):
        """Find RetroArch system/BIOS directory"""
        # Check for custom BIOS path override first
        dead = getattr(self.retroarch, 'is_dead_install_path', lambda p: False)
        if self.settings:
            custom_bios_path = self.settings.get('BIOS', 'custom_path', '').strip()
            # A custom path inside an emulator that's gone is worse than no
            # setting at all: the branch below would recreate that directory and
            # keep downloading BIOS files into a tree nothing reads. Ignore it and
            # auto-detect instead; the UI offers to clear the setting.
            if custom_bios_path and dead(Path(custom_bios_path)):
                self.log(f"⚠️ Ignoring BIOS path from an uninstalled emulator: "
                         f"{custom_bios_path}")
                custom_bios_path = ''
            if custom_bios_path:  # Only use if not empty
                custom_dir = Path(custom_bios_path)
                if custom_dir.exists():
                    self.log(f"📁 Using custom BIOS directory: {custom_dir}")
                    return custom_dir
                else:
                    # Try to create it
                    try:
                        custom_dir.mkdir(parents=True, exist_ok=True)
                        self.log(f"📁 Created custom BIOS directory: {custom_dir}")
                        return custom_dir
                    except Exception as e:
                        self.log(f"❌ Failed to create custom BIOS directory: {e}")
                        self.log("⚠️ Falling back to auto-detection")

        possible_dirs = [
            # RetroDECK
            Path.home() / 'retrodeck' / 'bios',
            Path.home() / '.var/app/net.retrodeck.retrodeck/config/retroarch/system',
            
            # Flatpak RetroArch
            Path.home() / '.var/app/org.libretro.RetroArch/config/retroarch/system',
            
            # Native installations
            Path.home() / '.config/retroarch/system',
            Path.home() / '.retroarch/system',
            
            # Steam installations
            Path.home() / '.steam/steam/steamapps/common/RetroArch/system',
            Path.home() / '.local/share/Steam/steamapps/common/RetroArch/system',
            Path.home() / '.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/RetroArch/system',
            
            # Snap
            Path.home() / 'snap/retroarch/current/.config/retroarch/system',
            
            # AppImage
            Path.home() / '.retroarch-appimage/system',
        ]
        
        # Check for custom RetroArch path override
        if hasattr(self.retroarch, 'settings'):
            custom_path = self.retroarch.settings.get('RetroArch', 'custom_path', '').strip()
            if custom_path:
                custom_dir = Path(custom_path).parent
                possible_dirs.insert(0, custom_dir / 'system')
                possible_dirs.insert(0, custom_dir / 'bios')  # RetroDECK style
        
        # Skip BIOS dirs belonging to an uninstalled emulator — ~/retrodeck/bios
        # and ~/.var/app/<id>/... both outlive the app they came with.
        for system_dir in (d for d in possible_dirs if not dead(d)):
            if system_dir.exists():
                self.log(f"📁 Found system/BIOS directory: {system_dir}")
                return system_dir
        
        # Create RetroDECK's bios directory, but only when RetroDECK is really
        # there. The test used to be `if Path.home() / 'retrodeck' / 'roms'`,
        # which is a Path object and therefore always truthy — so every install
        # with no BIOS dir grew a phantom ~/retrodeck/bios, and that stray
        # directory then fed the ~/retrodeck-based RetroDECK heuristics elsewhere.
        retrodeck_bios = Path.home() / 'retrodeck' / 'bios'
        is_retrodeck = (Path.home() / 'retrodeck' / 'roms').exists()
        if hasattr(self.retroarch, 'is_retrodeck_installation'):
            is_retrodeck = self.retroarch.is_retrodeck_installation()
        if is_retrodeck and not retrodeck_bios.exists():
            try:
                retrodeck_bios.mkdir(parents=True, exist_ok=True)
                self.log(f"📁 Created RetroDECK BIOS directory: {retrodeck_bios}")
                return retrodeck_bios
            except Exception as e:
                self.log(f"Failed to create RetroDECK BIOS directory: {e}")
        
        self.log("⚠️ No RetroArch system/BIOS directory found")
        return None
    
    def calculate_md5(self, file_path):
        """Calculate MD5 hash of a file"""
        md5 = hashlib.md5()
        try:
            with open(file_path, 'rb') as f:
                for chunk in iter(lambda: f.read(8192), b''):
                    md5.update(chunk)
            return md5.hexdigest()
        except Exception as e:
            self.log(f"Error calculating MD5 for {file_path}: {e}")
            return None
    
    def scan_installed_bios(self):
        """Scan for installed BIOS files"""
        self.installed_bios = {}
        
        if not self.system_dir:
            return
        
        try:
            # Scan all files in system directory
            for file_path in self.system_dir.rglob('*'):
                if file_path.is_file():
                    # Skip very large files (likely not BIOS)
                    if file_path.stat().st_size > 50 * 1024 * 1024:  # 50MB
                        continue
                    
                    relative_path = file_path.relative_to(self.system_dir)
                    entry = {
                        'path': str(file_path),
                        'size': file_path.stat().st_size,
                        'modified': file_path.stat().st_mtime,
                        'md5': None  # Calculate on demand to speed up scanning
                    }
                    self.installed_bios[str(relative_path)] = entry
                    # Also key by bare filename. The scan is recursive but the
                    # server only ever names files ("dc_boot.bin"), so keying on
                    # the relative path alone meant a RetroDECK install that
                    # already ships bios/dc/dc_boot.bin was reported as missing
                    # and the file was re-downloaded flat, where flycast does not
                    # read it. First hit wins: a flat file outranks a nested one
                    # only by scan order, and either satisfies the requirement.
                    self.installed_bios.setdefault(file_path.name, entry)

        except Exception as e:
            self.log(f"Error scanning BIOS directory: {e}")
    
    def bios_target_path(self, platform_name, bios_filename):
        """Where a firmware file for this platform must be written.

        The core's subfolder when it needs one (system/dc/dc_boot.bin), else the
        system directory itself. Creates the folder — a subfolder that does not
        exist yet is the normal case on a fresh RetroArch install.
        """
        subdir = BIOS_SUBDIR_BY_PLATFORM.get(
            self.normalize_platform_name(platform_name) or '')
        target_dir = self.system_dir / subdir if subdir else self.system_dir
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            self.log(f"⚠️ Could not create BIOS folder {target_dir}: {e}")
            return self.system_dir / bios_filename
        return target_dir / bios_filename

    def normalize_platform_name(self, platform_name):
        """Normalize platform name using aliases"""
        if not platform_name:
            return None

        # Callers pass display names ('Game Boy Advance') as well as slugs
        # ('game-boy-advance'); the alias table is keyed by slug, so fold
        # spaces and underscores alike before looking one up. Without the
        # space case every display name missed the table entirely.
        platform_lower = platform_name.lower().replace('_', '-').replace(' ', '-')
        while '--' in platform_lower:
            platform_lower = platform_lower.replace('--', '-')

        # Check aliases
        if platform_lower in self.platform_aliases:
            return self.platform_aliases[platform_lower]

        return platform_name  # Return original if no match found

    # The platform list is small, changes only when someone edits the server's
    # library, and every BIOS question here is answered from the same payload.
    # A scan asks it once per platform, so without this a 12-platform scan is 12
    # identical /api/platforms requests — each of which makes RomM build every
    # platform's firmware list. Long enough to collapse a scan into one request,
    # short enough that firmware uploaded on the server shows up promptly.
    _PLATFORMS_TTL = 60.0

    def _fetch_platforms(self, force=False):
        """The server's platform list (with embedded firmware), or None.

        Cached for _PLATFORMS_TTL. Locked so the platforms in a scan queue on
        one in-flight request instead of each firing their own.
        """
        if not self.romm_client or not self.romm_client.authenticated:
            logging.debug("[BIOS] No RomM client or not authenticated")
            return None
        with self._platforms_lock:
            if (not force and self._platforms_cache is not None
                    and (time.time() - self._platforms_cache_at) < self._PLATFORMS_TTL):
                return self._platforms_cache
            try:
                from urllib.parse import urljoin
                logging.debug("[BIOS] Fetching /api/platforms")
                response = self.romm_client.session.get(
                    urljoin(self.romm_client.base_url, '/api/platforms'),
                    timeout=10
                )
                if response.status_code != 200:
                    logging.debug(f"[BIOS] Server returned status {response.status_code}")
                    return None
                platforms = response.json()
            except Exception as e:
                logging.warning(f"[BIOS] Error fetching platforms: {e}")
                return None
            logging.debug(f"[BIOS] Got {len(platforms)} platforms from server")
            self._platforms_cache = platforms
            self._platforms_cache_at = time.time()
            return platforms

    def invalidate_platforms_cache(self):
        """Drop the cached platform list — call after changing server firmware."""
        with self._platforms_lock:
            self._platforms_cache = None
            self._platforms_cache_at = 0.0

    def get_server_firmware_for_platform(self, platform_name):
        """Query RomM server for available firmware files for a platform

        Args:
            platform_name: The platform name to query

        Returns:
            List of firmware file dictionaries with 'file_name' and 'id' fields,
            or None if server unavailable or platform not found
        """
        try:
            logging.debug(f"[BIOS] Resolving firmware for platform: {platform_name}")
            platforms = self._fetch_platforms()
            if platforms is None:
                return None

            # Platform name variations for matching
            # Keyed by the canonical name normalize_platform_name() returns,
            # not by whatever the caller passed in.
            platform_mappings = {
                'Sony - PlayStation': ['PlayStation', 'Sony PlayStation', 'PS1', 'PSX'],
                'Sony - PlayStation 2': ['PlayStation 2', 'Sony PlayStation 2', 'PS2'],
                'Nintendo - Game Boy Advance': ['Game Boy Advance', 'GBA', 'Nintendo Game Boy Advance'],
                'Nintendo - Game Boy': ['Game Boy', 'GB', 'Nintendo Game Boy'],
                'Nintendo - Game Boy Color': ['Game Boy Color', 'GBC', 'Nintendo Game Boy Color'],
                'Nintendo - Nintendo DS': ['Nintendo DS', 'DS', 'NDS'],
                'Nintendo - Nintendo 3DS': ['Nintendo 3DS', '3DS', 'N3DS'],
                'Sega - Saturn': ['Sega Saturn', 'Saturn', 'SS'],
                'Sega - Dreamcast': ['Sega Dreamcast', 'Dreamcast', 'DC'],
                'Sega - Mega-CD - Sega CD': ['Sega CD', 'Mega CD', 'Mega-CD'],
                'SNK - Neo Geo': ['Neo Geo', 'NeoGeo', 'Neo-Geo'],
                'NEC - PC Engine - TurboGrafx 16': ['PC Engine', 'TurboGrafx', 'TurboGrafx-16', 'TG-16', 'PCE'],
                'Atari - 7800': ['Atari 7800', '7800'],
                'Atari - Lynx': ['Atari Lynx', 'Lynx']
            }

            possible_names = platform_mappings.get(platform_name, [platform_name])
            logging.debug(f"[BIOS] Searching for matches: {possible_names}")

            def _found(platform, name_check):
                firmware_list = platform.get('firmware', [])
                logging.debug(f"[BIOS] Found platform '{name_check}' with {len(firmware_list)} firmware files")
                if firmware_list:
                    logging.debug(f"[BIOS] Firmware files: {[f.get('file_name') for f in firmware_list]}")
                return firmware_list

            # Exact first, substring only as a fallback. A plain substring test
            # is not safe here because platform names nest: 'Game Boy' is inside
            # 'Game Boy Color', and 'PlayStation' inside 'PlayStation 2'. Taking
            # the first substring hit meant GBC/GBA resolved to Game Boy's
            # firmware and PS1 could inherit PS2's -- marking a platform ready
            # while its real BIOS was missing. Longest candidate first so the
            # most specific alias wins whatever order the server returns.
            wanted = {name.strip().lower() for name in possible_names if name}

            for platform in platforms:
                platform_name_check = platform.get('name', '')
                if platform_name_check.strip().lower() in wanted:
                    return _found(platform, platform_name_check)

            for platform in sorted(platforms,
                                   key=lambda p: len(p.get('name', '')),
                                   reverse=True):
                platform_name_check = platform.get('name', '')
                if not platform_name_check:
                    continue
                check = platform_name_check.strip().lower()
                if any(name in check or check in name for name in wanted):
                    logging.debug(
                        f"[BIOS] '{platform_name}' matched server platform "
                        f"'{platform_name_check}' by substring, not exactly")
                    return _found(platform, platform_name_check)

            logging.debug(f"[BIOS] Platform '{platform_name}' not found on server")
            return None  # Platform not found

        except Exception as e:
            logging.warning(f"[BIOS] Error querying server firmware: {e}")
            import traceback
            logging.debug(traceback.format_exc())
            return None

    def check_platform_bios(self, platform_name):
        """Check BIOS status for a platform by querying RomM server"""
        platform_name = self.normalize_platform_name(platform_name)
        present = []
        missing = []

        # Query server for firmware list
        server_firmware = self.get_server_firmware_for_platform(platform_name)

        if server_firmware:
            # Check each firmware file from server against local files
            for firmware in server_firmware:
                file_name = firmware.get('file_name', '')

                if not file_name:
                    continue

                if file_name in self.installed_bios:
                    present.append({
                        'file': file_name,
                        'status': 'present'
                    })
                else:
                    # Anything the server holds for the platform is treated as
                    # required: it was uploaded deliberately, and we have no
                    # per-file opt flag from RomM to say otherwise.
                    #
                    # BOTH keys, because callers disagree about which one to
                    # read. auto_download_missing_bios filters on `optional`
                    # while BiosTrackingManager filters on `required` — and for
                    # as long as only `optional` was written, every
                    # BiosTrackingManager filter matched nothing, so the
                    # post-download BIOS fetch and the library scan both decided
                    # there was nothing to do and quietly downloaded no firmware
                    # at all. Writing one key and reading another fails silently
                    # in exactly the direction that looks like success.
                    missing.append({
                        'file': file_name,
                        'status': 'missing',
                        'optional': False,
                        'required': True,
                    })

        return present, missing
    
    def get_all_platforms_status(self):
        """Get BIOS status for all platforms by querying RomM server"""
        status = {}

        if not self.romm_client or not self.romm_client.authenticated:
            return status

        try:
            platforms = self._fetch_platforms()
            if platforms is None:
                return status

            # Check BIOS status for each platform that has firmware
            for platform in platforms:
                platform_name = platform.get('name', '')
                firmware_list = platform.get('firmware', [])

                if not firmware_list:
                    continue  # Skip platforms with no firmware

                present, missing = self.check_platform_bios(platform_name)

                # Only include platforms that have BIOS files
                if present or missing:
                    status[platform_name] = {
                        'present': present,
                        'missing': missing,
                        'complete': len(missing) == 0,
                        'required_count': len([b for b in missing if not b.get('optional', False)])
                    }

        except Exception as e:
            self.log(f"⚠️ Error getting platforms status: {e}")

        return status
    
    def download_bios_from_romm(self, platform_name, bios_filename):
            """Download a specific BIOS file from RomM's firmware API"""
            if not self.romm_client or not self.romm_client.authenticated:
                self.log("❌ Not connected to RomM")
                return False
            
            if not self.system_dir:
                self.log("❌ No system directory found")
                return False
            
            try:
                from urllib.parse import urljoin

                platforms = self._fetch_platforms()
                if platforms is None:
                    self.log("❌ Failed to get platforms list from RomM.")
                    return False

                platform_mappings = {
                    'Sony - PlayStation': ['PlayStation', 'Sony PlayStation', 'PS1', 'PSX'],
                    'Sony - PlayStation 2': ['PlayStation 2', 'Sony PlayStation 2', 'PS2'],
                    'Nintendo - Game Boy Advance': ['Game Boy Advance', 'GBA', 'Nintendo Game Boy Advance'],
                    'Nintendo - Game Boy': ['Game Boy', 'GB', 'Nintendo Game Boy'],
                    'Nintendo - Game Boy Color': ['Game Boy Color', 'GBC', 'Nintendo Game Boy Color'],
                    'Nintendo - Nintendo DS': ['Nintendo DS', 'DS', 'NDS'],
                    'Nintendo - Nintendo 3DS': ['Nintendo 3DS', '3DS', 'N3DS'],
                    'Sega - Saturn': ['Sega Saturn', 'Saturn', 'SS'],
                    'Sega - Dreamcast': ['Sega Dreamcast', 'Dreamcast', 'DC'],
                    'Sega - Mega-CD - Sega CD': ['Sega CD', 'Mega CD', 'Mega-CD'],
                    'SNK - Neo Geo': ['Neo Geo', 'NeoGeo', 'Neo-Geo'],
                    'NEC - PC Engine - TurboGrafx 16': ['PC Engine', 'TurboGrafx', 'TurboGrafx-16', 'TG-16', 'PCE'],
                    'Atari - 7800': ['Atari 7800', '7800'],
                    'Atari - Lynx': ['Atari Lynx', 'Lynx']
                }
                
                possible_names = platform_mappings.get(platform_name, [platform_name])
                
                for platform in platforms:
                    platform_name_check = platform.get('name', '')
                    
                    if any(name.lower() in platform_name_check.lower() or 
                        platform_name_check.lower() in name.lower() 
                        for name in possible_names):
                        
                        logging.debug(f"[BIOS] Found platform: {platform_name_check}")
                        firmware_list = platform.get('firmware', [])

                        for firmware in firmware_list:
                            if firmware.get('file_name') == bios_filename:
                                firmware_id = firmware.get('id')
                                logging.debug(f"[BIOS] Found BIOS: {bios_filename} (ID: {firmware_id})")

                                # Construct the download URL using the firmware ID and filename
                                download_url = f'/api/firmware/{firmware_id}/content/{bios_filename}'

                                # STEP 1: Download the file from the constructed URL
                                file_response = self.romm_client.session.get(
                                    urljoin(self.romm_client.base_url, download_url),
                                    stream=True,
                                    timeout=60  # Increased timeout for larger files
                                )

                                # STEP 2: Check for a successful response and write the file
                                if file_response.status_code == 200:
                                    download_path = self.bios_target_path(
                                        platform_name, bios_filename)

                                    with open(download_path, 'wb') as f:
                                        for chunk in file_response.iter_content(chunk_size=8192):
                                            f.write(chunk)

                                    logging.debug(f"[BIOS] Downloaded {bios_filename}")
                                    return True
                                else:
                                    logging.warning(f"[BIOS] Download failed with status code: {file_response.status_code}")
                                    return False
                        
                        self.log(f"❌ {bios_filename} not found in {platform_name_check} firmware list on server.")
                        break # Stop searching after finding the correct platform
                
                self.log(f"❌ Platform matching '{platform_name}' not found on server.")
                return False
                
            except Exception as e:
                self.log(f"❌ Download error: {e}")
                import traceback
                self.log(traceback.format_exc()) # More detailed error for debugging
                return False
    
    def find_firmware_entry(self, platform_slug, file_name=None):
        """The server's firmware record for a platform, or None.

        Matched on SLUG rather than on the display name the BIOS paths above
        use. Those names exist because RetroArch cores want a canonical
        "Sony - PlayStation"; a slug is what RomM actually keys on, and it is
        unambiguous. ``file_name`` picks one when a platform has several;
        without it the largest wins, which for a firmware set is the complete
        archive rather than a stray loose file beside it.
        """
        platforms = self._fetch_platforms()
        if platforms is None:
            return None
        for platform in platforms:
            if (platform.get('slug') or '').lower() != platform_slug.lower():
                continue
            firmware = platform.get('firmware') or []
            if file_name:
                for entry in firmware:
                    if entry.get('file_name') == file_name:
                        return entry
                return None
            if not firmware:
                return None
            return max(firmware, key=lambda f: f.get('file_size_bytes') or 0)
        return None

    def download_firmware_entry(self, entry, destination, progress=None):
        """Download a firmware file, resuming and verifying. Returns the path.

        Firmware is the largest thing this engine transfers — a Switch set is
        ~324 MB against a BIOS file's ~512 KB — so the two things the existing
        BIOS download can skip, this cannot:

          * Resume. RomM answers Range requests (Accept-Ranges: bytes), so an
            interrupted transfer continues rather than restarting. A server
            that ignores the range and replies 200 is handled by starting over,
            because appending to a full body would corrupt the file.
          * Verification. RomM records md5/sha1/crc per firmware. A truncated
            or corrupted archive that we then extract into an emulator's system
            directory is a much worse failure than a failed download, and the
            hash is right there.

        Returns None on failure, having left no partial file behind.
        """
        from urllib.parse import urljoin

        if not self.romm_client or not self.romm_client.authenticated:
            self.log("❌ Not connected to RomM")
            return None

        firmware_id = entry.get('id')
        file_name = entry.get('file_name')
        expected_size = entry.get('file_size_bytes') or 0
        expected_md5 = (entry.get('md5_hash') or '').lower()
        if not firmware_id or not file_name:
            self.log("❌ Firmware record is missing an id or file name")
            return None

        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)

        # Already here and intact — re-downloading 324 MB to confirm what the
        # hash can confirm for free is the wrong trade.
        if destination.is_file() and expected_md5:
            if self.calculate_md5(destination) == expected_md5:
                logging.debug(f"[BIOS] {file_name} already downloaded and verified")
                return destination

        partial = destination.with_name(destination.name + '.part')
        have = partial.stat().st_size if partial.is_file() else 0
        if expected_size and have > expected_size:
            # A stale part from a different version of the file.
            partial.unlink()
            have = 0

        url = urljoin(self.romm_client.base_url,
                      f'/api/firmware/{firmware_id}/content/{file_name}')
        headers = {'Range': f'bytes={have}-'} if have else {}
        try:
            response = self.romm_client.session.get(
                url, headers=headers, stream=True, timeout=120)
            if response.status_code not in (200, 206):
                self.log(f"❌ Firmware download failed: HTTP {response.status_code}")
                return None
            # Asked to resume but served the whole file: start over rather than
            # appending a second copy onto what we already had.
            mode = 'ab'
            if have and response.status_code == 200:
                logging.debug("[BIOS] server ignored the range request; restarting")
                have = 0
                mode = 'wb'

            with open(partial, mode) as sink:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    sink.write(chunk)
                    have += len(chunk)
                    if progress and expected_size:
                        progress(have, expected_size)
        except Exception as e:
            self.log(f"❌ Firmware download error: {e}")
            return None

        if expected_size and partial.stat().st_size != expected_size:
            self.log(f"❌ {file_name} is {partial.stat().st_size} bytes, "
                     f"expected {expected_size}")
            partial.unlink(missing_ok=True)
            return None

        if expected_md5:
            actual = self.calculate_md5(partial)
            if actual != expected_md5:
                self.log(f"❌ {file_name} failed its checksum "
                         f"({actual} != {expected_md5})")
                partial.unlink(missing_ok=True)
                return None

        partial.replace(destination)
        logging.debug(f"[BIOS] {file_name} downloaded and verified")
        return destination

    def search_romm_for_bios(self, bios_filename):
        """Search RomM for a BIOS file"""
        if not self.romm_client:
            return None
        
        try:
            # Try searching via API
            search_endpoints = [
                f'/api/search?q={bios_filename}',
                f'/api/search?q={bios_filename}&type=resource',
                f'/api/search?q={bios_filename}&type=firmware',
                f'/api/resources?search={bios_filename}',
            ]
            
            for endpoint in search_endpoints:
                try:
                    response = self.romm_client.session.get(
                        urljoin(self.romm_client.base_url, endpoint),
                        timeout=10
                    )
                    
                    if response.status_code == 200:
                        results = response.json()
                        
                        if isinstance(results, list):
                            for result in results:
                                if isinstance(result, dict):
                                    filename = result.get('filename', result.get('name', ''))
                                    if filename.lower() == bios_filename.lower():
                                        return result
                        elif isinstance(results, dict):
                            items = results.get('items', results.get('results', []))
                            for item in items:
                                filename = item.get('filename', item.get('name', ''))
                                if filename.lower() == bios_filename.lower():
                                    return item
                                    
                except:
                    continue
                    
        except Exception as e:
            self.log(f"Search error: {e}")
        
        return None
    
    def download_romm_resource(self, resource_info):
        """Download a resource from RomM based on search result"""
        if not self.romm_client or not resource_info:
            return False
        
        try:
            # Extract download URL from resource info
            download_url = None
            
            if 'download_url' in resource_info:
                download_url = resource_info['download_url']
            elif 'url' in resource_info:
                download_url = resource_info['url']
            elif 'path' in resource_info:
                download_url = f"/api/resources/{resource_info['id']}/download"
            elif 'id' in resource_info:
                download_url = f"/api/resources/{resource_info['id']}/content"
            
            if download_url:
                response = self.romm_client.session.get(
                    urljoin(self.romm_client.base_url, download_url),
                    stream=True,
                    timeout=30
                )
                
                if response.status_code == 200:
                    filename = resource_info.get('filename', resource_info.get('name', 'unknown.bin'))
                    download_path = self.system_dir / filename
                    
                    with open(download_path, 'wb') as f:
                        for chunk in response.iter_content(chunk_size=8192):
                            if chunk:
                                f.write(chunk)
                    
                    self.log(f"✅ Downloaded {filename}")
                    return True
                    
        except Exception as e:
            self.log(f"Resource download error: {e}")
        
        return False

    def auto_download_missing_bios(self, platform_name):
        """Download missing BIOS for a specific platform"""
        # Rescan to get current state
        self.scan_installed_bios()
        
        present, missing = self.check_platform_bios(platform_name)
        
        # Only download required files that are missing
        required_missing = [b for b in missing if not b.get('optional', False)]
        
        if not required_missing:
            self.log(f"✅ All required BIOS present for {platform_name}")
            return True
        
        success_count = 0
        for bios_info in required_missing:
            bios_file = bios_info['file']
            
            # Double-check if file exists before downloading — in the core's
            # subfolder, flat, or anywhere else under the system dir (the scan
            # indexes bare filenames for exactly this).
            if bios_file in self.installed_bios:
                self.log(f"⏭️ {bios_file} already exists, skipping")
                success_count += 1
                continue
                
            if self.download_bios_from_romm(platform_name, bios_file):
                success_count += 1
        
        # Rescan after downloads
        self.scan_installed_bios()
        
        if success_count == len(required_missing):
            logging.debug(f"[BIOS] Downloaded all {success_count} BIOS files for {platform_name}")
            return True
        elif success_count > 0:
            logging.warning(f"[BIOS] Downloaded {success_count}/{len(required_missing)} BIOS files for {platform_name}")
            return True
        else:
            logging.warning(f"[BIOS] Could not download any BIOS files for {platform_name}")
            return False