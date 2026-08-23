// Canned backend replies for the render harness.
//
// The real backend is Python (ludo_app.backend.LudoBackend over
// backend/server.py). Booting it here would drag in RomM credentials, a
// RetroArch install and the filesystem watchdog — none of which say anything
// about whether a page renders. So every RPC is answered from this table
// instead.
//
// The shapes matter, and they are the point of the file. A page that does
// `const { events } = await drainNotifications()` throws on `null`, and the
// throw is indistinguishable from a real render bug. Each entry here is the
// *empty* answer of the right shape — "connected, configured, nothing in it" —
// so a route that fails is failing on its own markup rather than on a stub.
//
// Anything not listed answers `null`, which is what the untyped `any` call
// sites already tolerate.

const EVENTS = { events: [] };

export const RPC_FIXTURES = {
  // ── Lifecycle / status ────────────────────────────────────────────────
  get_config: {
    configured: true,
    romm_url: "https://romm.example",
    username: "tester",
    roms_dir: "/home/tester/roms",
    saves_dir: "/home/tester/saves",
    states_dir: "/home/tester/states",
  },
  get_service_status: {
    connected: true,
    syncing: false,
    online: true,
    last_sync: 0,
    message: "",
  },
  drain_notifications: EVENTS,
  get_recent_activity: EVENTS,
  notify_network_state: { ok: true },

  // ── Account ───────────────────────────────────────────────────────────
  get_account_username: { success: true, username: "tester" },
  get_avatar: { success: false },
  // Flat, and with no `success` key at all — see LudoBackend.get_plugin_stats.
  get_plugin_stats: {
    games_total: 0, games_downloaded: 0, size_on_disk: 0, platforms: 0,
    collections_total: 0, collections_synced: 0, platforms_breakdown: [],
  },

  // ── Settings toggles ──────────────────────────────────────────────────
  get_logging_enabled: false,
  set_logging_enabled: false,
  get_retrodeck_button_enabled: false,
  set_retrodeck_button_enabled: false,
  get_retrodeck_logo: { success: false },
  get_steam_tile_status: { success: true, present: false },

  // ── Updates ───────────────────────────────────────────────────────────
  get_plugin_version: "1.0.0-test",
  get_update_channel: "stable",
  get_check_on_startup: false,
  check_for_update: {
    success: true,
    available: false,
    current: "1.0.0-test",
    latest: "1.0.0-test",
    channel: "stable",
  },
  // `mappings` is a LIST, and the key is `available_cores`. Getting this
  // wrong is how the harness earned its keep on its first run: CoresPage
  // does `r.mappings.map(...)`, so an object here threw during render and
  // left a blank page — the exact failure this suite exists to notice.
  get_core_mappings: { success: true, mappings: [], available_cores: [] },

  // ── Library ───────────────────────────────────────────────────────────
  get_library_groups: { success: true, groups: [] },
  get_library_games: { success: true, games: [] },
  get_home_data: {
    success: true,
    continue_playing: [],
    recently_added: [],
    collections: [],
    platforms: [],
  },
  search_games: { success: true, games: [] },
  get_game_cover: { success: false },
  get_romm_logo: { success: false },
  get_image: { success: false },

  // ── Game detail ───────────────────────────────────────────────────────
  // Flat, not nested under a `game` key — see LudoBackend.get_game_detail.
  get_game_detail: { success: false, message: "no game" },
  get_ra_earned: { success: true, earned: [] },
  get_local_discs: { success: true, discs: [] },
  get_local_siblings: { success: true, siblings: [] },
  get_download_progress: { success: true, progress: null },

  // ── Save data ─────────────────────────────────────────────────────────
  get_save_history: { success: true, saves: [], states: [] },
  get_pending_uploads: { success: true, uploads: [] },
  get_save_screenshot: { success: false },
};

// ── The populated profile ───────────────────────────────────────────────
//
// The empty table above proves a page survives having nothing to show. It says
// nothing about the branches that only run when there IS something — the grid,
// the detail header, the metadata tabs — which is most of the code and all of
// the interesting part of a future split.
//
// It also unlocks the two routes that cannot be tested by navigating to them.
// `/romm-sync-library/:key` and `/romm-sync-game/:romId` take their parameters
// decoratively: the pages read module-level state the previous screen set (see
// the note in src/host/router.tsx), so a direct navigation lands on "No group
// selected". Reaching them for real means clicking through from the library,
// and clicking through needs something to click.
const PLATFORM = { key: "Test Platform", label: "Test Platform", count: 1, downloaded: 1 };

const GAME = {
  rom_id: 42,
  name: "Harness Test Game",
  platform: "Test Platform",
  platform_slug: "test",
  is_downloaded: true,
  has_cover: false,
};

export const POPULATED_FIXTURES = {
  get_core_mappings: {
    success: true,
    available_cores: ["genesis_plus_gx", "snes9x"],
    mappings: [{
      slug: "test", platform_name: "Test Platform",
      resolved_core: "snes9x", source: "override", override: "snes9x",
      retrodeck_default: null, retrodeck_choices: ["snes9x"],
    }],
  },
  get_plugin_stats: {
    games_total: 1, games_downloaded: 1, size_on_disk: 1024, platforms: 1,
    collections_total: 0, collections_synced: 0,
    platforms_breakdown: [{
      slug: "test", fs_slug: "test", name: "Test Platform",
      rom_count: 1, downloaded: 1, fs_size_bytes: 1024,
    }],
  },
  get_library_groups: { success: true, mode: "platform", groups: [PLATFORM] },
  get_library_games: { success: true, games: [GAME] },
  get_home_data: {
    success: true,
    continue_playing: [],
    recently_added: [GAME],
    collections: [],
    platforms: [PLATFORM],
  },
  get_game_detail: {
    success: true,
    rom_id: 42,
    name: "Harness Test Game",
    fs_name: "harness.rom",
    platform: "Test Platform",
    summary: "A game that exists only to be rendered.",
    genres: ["Test"],
    franchises: [],
    companies: ["Ludo"],
    release_date: 1704153600000,
    rating: 90,
    regions: ["USA"],
    languages: ["English"],
    tags: [],
    collections: [],
    user_collections: [],
    player_count: 1,
    last_played: null,
    verified: true,
    hltb: null,
    age_ratings: [],
    related: { expansions: [], dlcs: [], remakes: [], remasters: [], similar: [] },
    providers: { igdb_id: 1, moby_id: null, ss_id: null, ra_id: null, sgdb_id: null,
                 launchbox_id: null, hasheous_id: null, flashpoint_id: null, hltb_id: null },
    hashes: { crc: "deadbeef", md5: null, sha1: null, ra: null },
    verifications: [{ label: "No-Intro", match: true }],
    files: [{ name: "harness.rom", size: 1024 }],
    screenshots: [],
    achievements: [],
    ra_id: null,
    fs_size_bytes: 1024,
    is_downloaded: true,
    has_cover: false,
  },
};

/**
 * The reply the fake server sends for `method`.
 *
 * `extra` is the populated profile when a test asked for one; unlisted methods
 * fall through to the empty table and then to `null`, which is what the
 * untyped `any` call sites already tolerate.
 */
export function fixtureFor(method, extra = null) {
  if (extra && Object.prototype.hasOwnProperty.call(extra, method)) return extra[method];
  return Object.prototype.hasOwnProperty.call(RPC_FIXTURES, method)
    ? RPC_FIXTURES[method]
    : null;
}
