// The backend surface, in one place.
//
// Every one of these is a method on ludo_app.backend.LudoBackend, reached
// through whichever transport the host provides: Decky's IPC on the Deck,
// POST /api/<method> to backend/server.py on the desktop. `callable` comes
// from @ludo/host precisely so this file does not care which.
//
// They live here rather than in index.tsx so that the feature modules that
// actually call them can import what they need without dragging the page
// tree along with it.
import { callable } from "@ludo/host";

// Call backend methods
export const getServiceStatus = callable<[], any>("get_service_status");
export const timeColdFetch = callable<[], any>("time_cold_fetch");
// LUDO_DEBUG=1 in the plugin's environment. Gates developer-only Settings rows.
export const isDebugMode = callable<[], boolean>("is_debug_mode");
export const getFetchBenchmark = callable<[], any>("get_fetch_benchmark");
export const ackLibraryAnnouncement = callable<[], any>("ack_library_announcement");
export const notifyNetworkState = callable<[boolean], any>("notify_network_state");
// rom_id/has_cover are set on events about one specific game (save/state
// uploads) and absent on collection-wide ones.
export const drainNotifications = callable<[], { events: Array<{ kind: string, title: string, body: string, timestamp: number, rom_id?: number | null, has_cover?: boolean }> }>("drain_notifications");
export const refreshFromRomm = callable<[boolean], any>("refresh_from_romm");
export const rebuildLibrary = callable<[], any>("rebuild_library");
// Re-reads one platform and reconciles that slice. Takes a slug (what the
// platform groups are keyed by) or a numeric id.
export const resyncPlatform = callable<[string], any>("resync_platform");
export const checkLibraryStale = callable<[], any>("check_library_stale");
export const getLibraryAutoUpdate = callable<[], any>("get_library_auto_update");
export const setLibraryAutoUpdate = callable<[boolean], any>("set_library_auto_update");
// Games the RomM server stopped returning but that still have local data.
// Each can be deleted (files + saves, to trash) — never automatically.
export const getOrphanGames = callable<[], any>("get_orphan_games");
export const deleteOrphanGame = callable<[number], any>("delete_orphan_game");
export const getVirtualCollectionsVisible = callable<[], any>("get_virtual_collections_visible");
export const setVirtualCollectionsVisibleRpc = callable<[boolean], any>("set_virtual_collections_visible");
// Standalone emulator builds (Eden stable vs nightly). `selected` is '' for
// automatic; each build's `current` marks what automatic resolves to now.
export type EmulatorBuild = { path: string; label: string; kind: string; current: boolean };
export const listEmulatorBuilds = callable<[string], {
  success: boolean; key?: string; name?: string; builds: EmulatorBuild[];
  selected: string; shares_state?: boolean;
}>("list_emulator_builds");
export const setEmulatorBuild = callable<[string, string], any>("set_emulator_build");
export const getSyncIndicator = callable<[], any>("get_sync_indicator");
export const setSyncIndicatorRpc = callable<[boolean], any>("set_sync_indicator");
// `rom_id` is present only on entries that name a single rom (downloads), and
// only on entries written since it was added — older persisted logs lack it.
export const getRecentActivity = callable<[number], { events: Array<{ kind: string, title: string, detail: string, timestamp: number, rom_id?: number }> }>("get_recent_activity");
export const clearRecentActivity = callable<[], any>("clear_recent_activity");
export const getLoggingEnabled = callable<[], boolean>("get_logging_enabled");
export const updateLoggingEnabled = callable<[boolean], boolean>("set_logging_enabled");
export const getRetrodeckButtonEnabled = callable<[], boolean>("get_retrodeck_button_enabled");
export const setRetrodeckButtonEnabled = callable<[boolean], boolean>("set_retrodeck_button_enabled");
export const getRetrodeckLogo = callable<[], any>("get_retrodeck_logo");
export const getSteamTileStatus = callable<[], any>("get_steam_tile_status");
export const setSteamTile = callable<[boolean, string, string, string], any>("set_steam_tile");
export const getCoreMappings = callable<[], any>("get_core_mappings");
export const setCoreOverride = callable<[string, string], any>("set_core_override");
export const downloadCore = callable<[string], any>("download_core");
export const getEmulatorStatus = callable<[boolean?], any>("get_emulator_status");
export const repairEmulatorPaths = callable<[string[]?], any>("repair_emulator_paths");
export const installEmulator = callable<[], any>("install_emulator");
export const emulatorInstallState = callable<[], any>("emulator_install_state");
// Folder-only setter — save_config is the wizard's, and rewrites credentials.
export const setLibraryPaths = callable<[string?, string?, string?, string?], any>("set_library_paths");
export const getDownloadableCores = callable<[boolean], any>("get_downloadable_cores");
export const getConfig = callable<[], any>("get_config");
export const logout = callable<[boolean], any>("logout");
export const getAccountUsername = callable<[], any>("get_account_username");
export const getAvatar = callable<[], any>("get_avatar");
export const getPluginStats = callable<[], any>("get_plugin_stats");
export const saveConfig = callable<[string, string, string, string, string, string, string], any>("save_config");
export const testRommConnection = callable<[string, string, string], any>("test_connection");
export const pairDevice = callable<[string, string], any>("pair_device");
// QR pairing (RomM's device-auth flow). start returns the code + QR matrix,
// poll is driven from the frontend so backing out of the step stops it.
export const startQrPairing = callable<[string], any>("start_qr_pairing");
export const pollQrPairing = callable<[], any>("poll_qr_pairing");
export const cancelQrPairing = callable<[], any>("cancel_qr_pairing");
// Releases the library fetch that pairing deferred, so the walk starts against
// the platform switches the wizard just collected rather than ahead of them.
export const finishOnboarding = callable<[], any>("finish_onboarding");
export const setDeviceNameRpc = callable<[string], any>("set_device_name");
export const getSaveHistory = callable<[number], any>("get_save_history");
export const getPendingUploads = callable<[], any>("get_pending_uploads");
export const getSaveScreenshot = callable<[number, number, string], any>("get_save_screenshot");
export const restoreSaveVersion = callable<[number, number, string, boolean], any>("restore_save_version");
// Game Browser
export const getLibraryGroups = callable<[string], any>("get_library_groups");
export const getLibraryGames = callable<[string, string], any>("get_library_games");
export const getGameCover = callable<[number, boolean], any>("get_game_cover");
export const getImage = callable<[string], any>("get_image");
export const clearCoverCache = callable<[], any>("clear_cover_cache");
export const searchGames = callable<[string], any>("search_games");
export const getGameDetail = callable<[number], any>("get_game_detail");
export const getRaEarned = callable<[number], any>("get_ra_earned");
export const downloadGame = callable<[number], any>("download_game");
export const getSwitchAddOns = callable<[number], any>("switch_add_ons");
export const getSwitchAddonMode = callable<[], any>("get_switch_addon_mode");
export const setSwitchAddonMode = callable<[string], any>("set_switch_addon_mode");
export const toggleCollectionSync = callable<[string, boolean], any>("toggle_collection_sync");
export const deleteCollectionRoms = callable<[string, string], any>("delete_collection_roms");
export const getDownloadProgress = callable<[number], any>("get_download_progress");
export const deleteGame = callable<[number], any>("delete_game");
export const launchGame = callable<[number, (string | null)?, (number | null)?, (boolean)?], any>("launch_game");
// Steam Deck session-host launch: resolves argv + writes a launch-spec; the tile
// is then RunGame'd so the emulator is a child of a Steam-tracked game (overlay).
export const prepareSteamLaunch = callable<[number, (string | null)?, (number | null)?, (boolean)?], any>("prepare_steam_launch");
// Continue playing: resume from the newest save state (opt-in) and the state's
// own screenshot, used as that row's art.
export const getResumeStateEnabled = callable<[], boolean>("get_resume_state_enabled");
export const setResumeStateEnabled = callable<[boolean], boolean>("set_resume_state_enabled");
export const getStateThumbnails = callable<[number[], (boolean)?], any>("get_state_thumbnails");
// BIOS inventory: what RomM holds per platform vs. what's in RetroArch's system
// dir. Distinct from get_bios_status, which reports background download progress.
export const getBiosInventory = callable<[(boolean)?], any>("get_bios_inventory");
export const downloadBios = callable<[string, (string)?], any>("download_bios");
// Switch firmware is an Eden-tree install, not a BIOS-directory drop, so it has
// its own call rather than riding download_bios. See install_switch_firmware.
export const installSwitchFirmware = callable<[], any>("install_switch_firmware");
// Asked before the download, so the prompt can name the size. Firmware is the
// one transfer here big enough that starting it unasked would be rude.
export const switchFirmwareStatus = callable<[], any>("switch_firmware_status");
// Asked before downloading a ROM: is this a Switch game whose firmware or keys
// need attention? {needed:false} for everything else, and no transfer either way.
export const switchPrereqForRom = callable<[number], any>("switch_prereq_for_rom");
// The install runs detached (a ~340 MB transfer cannot occupy Decky's single
// RPC socket), so its progress is polled rather than awaited.
export const getSwitchFirmwareProgress = callable<[], any>("get_switch_firmware_progress");
// Per-platform sync switches. get_ returns every platform with its rom_count and
// whether it's on; set_ takes the whole disabled set, so it's idempotent.
export const getPlatformSync = callable<[], any>("get_platform_sync");
export const setPlatformSync = callable<[string[]], any>("set_platform_sync");
export const getLocalDiscs = callable<[number], any>("get_local_discs");
export const getLocalSiblings = callable<[number], any>("get_local_siblings");
export const getHomeData = callable<[], any>("get_home_data");
export const getSyncEpoch = callable<[], any>("get_sync_epoch");
export const getRommLogo = callable<[], any>("get_romm_logo");
// Auto-update
export const getPluginVersion = callable<[], string>("get_plugin_version");
export const getUpdateChannel = callable<[], string>("get_update_channel");
export const setUpdateChannel = callable<[string], string>("set_update_channel");
export const checkForUpdate = callable<[string], any>("check_for_update");
export const downloadUpdate = callable<[string], any>("download_update");
// Desktop-only: swaps the running AppImage. No-ops on Decky, which
// updates through the loader instead.
export const applyAppImageUpdate = callable<[string], any>("apply_appimage_update");
export const getCheckOnStartup = callable<[], boolean>("get_check_on_startup");
export const setCheckOnStartup = callable<[boolean], boolean>("set_check_on_startup");
