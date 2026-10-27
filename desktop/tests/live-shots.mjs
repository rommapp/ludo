// Render the built UI with the user's real library: read-only RPCs are
// passed to the running Ludo (Decky Loader websocket), the rest come from
// fixtures. Nintendo platforms/games are filtered out for shareable shots.
//   node tests/live-shots.mjs <outdir>
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { DIST, launchBrowser } from "./support/render-harness.mjs";
import { fixtureFor, POPULATED_FIXTURES } from "./support/fixtures.mjs";
const playwright = await import("playwright");
const OUT = process.argv[2];

const READ = new Set(["get_home_data", "get_library_groups", "get_image", "get_game_cover",
  "get_service_status", "get_platform_sync", "get_emulator_status", "get_notification_prefs",
  "get_check_on_startup", "get_resume_state_enabled", "get_sync_indicator",
  "get_retrodeck_button_enabled", "game_running", "get_library_auto_update",
  "get_virtual_collections_visible", "get_update_channel", "get_plugin_version",
  "get_steam_tile_status", "get_logging_enabled", "get_recent_activity"]);
const NIN = /nintendo|game ?boy|switch|wii|gamecube|famicom|\bn64\b|\bnes\b|\bsnes\b|\bnds\b|\b3ds\b|\bgba\b|\bgbc?\b|virtual boy/i;
const scrub = (v) => Array.isArray(v)
  ? v.filter((x) => !(x && typeof x === "object" && NIN.test(`${x.platform ?? ""} ${x.platform_slug ?? ""} ${x.platform_name ?? ""} ${x.slug ?? ""} ${x.name ?? ""}`))).map(scrub)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : v;

const token = await (await fetch("http://127.0.0.1:1337/auth/token")).text();
const ws = new WebSocket(`ws://127.0.0.1:1337/ws?auth=${token}`);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let seq = 1; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } };
const decky = (method, args) => new Promise((ok) => {
  const id = ++seq; waiting.set(id, ok);
  ws.send(JSON.stringify({ type: 0, id, route: "loader/call_plugin_method", args: ["Ludo", method, ...args] }));
  setTimeout(() => { if (waiting.delete(id)) ok({ type: -1 }); }, 20000);
});

const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const EXTRA = {
  get_save_conflicts: [{ id: "c1", prompt: true, rom_id: 1, game: "Castlevania: Symphony of the Night", file_name: "Castlevania - Symphony of the Night (USA).srm",
    local: { updated_at: ago(26 * 60) }, server: { updated_at: ago(42), device: "Living room PC" } }],
};
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
let conflicts = true;
const srv = createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  if (req.method === "POST") {
    const method = decodeURIComponent(path.slice(5));
    let body = ""; for await (const c of req) body += c;
    let result;
    if (method === "get_save_conflicts") result = conflicts ? EXTRA.get_save_conflicts : [];
    else if (READ.has(method)) {
      let args = []; try { const b = JSON.parse(body || "{}"); args = Array.isArray(b) ? b : (b.args ?? []); } catch {}
      const m = await decky(method, args);
      result = m.type === 1 ? scrub(m.result) : fixtureFor(method, { ...POPULATED_FIXTURES, ...EXTRA });
    } else result = fixtureFor(method, { ...POPULATED_FIXTURES, ...EXTRA });
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result })); return;
  }
  const file = join(DIST, path === "/" ? "index.html" : decodeURIComponent(path));
  try { const b = await readFile(file); res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }); res.end(b); }
  catch { res.writeHead(200, { "content-type": "text/html" }); res.end(await readFile(join(DIST, "index.html"))); }
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const origin = `http://127.0.0.1:${srv.address().port}`;

const browser = await launchBrowser(playwright);
// 2560x1440 window: Electron zoom = 1440/800 = 1.8.
const shot = async (name, route, withConflict, after) => {
  conflicts = withConflict;
  const page = await browser.newPage({ viewport: { width: 1422, height: 800 }, deviceScaleFactor: 1.8 });
  await page.goto(origin + route, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1000);
  if (after) await after(page);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  await page.close();
};
// One page: Home loads with your library, then the conflict arrives on the
// next poll the way it would mid-session; then Settings.
await shot("live-conflict-1440p", "/romm-sync-library", false, async (p) => {
  await p.getByText("Continue playing").waitFor({ timeout: 90000 }); await p.waitForTimeout(5000);
  await p.screenshot({ path: `${OUT}/live-home.png` });
  conflicts = true; await p.getByText("Keep mine").waitFor({ timeout: 180000 }); await p.waitForTimeout(800); });
await browser.close(); srv.close(); ws.close();
