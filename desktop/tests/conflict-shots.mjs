// Render the save-conflict prompt at real window sizes. Electron zooms to
// height/800, which is the same as an 800-px-tall CSS viewport at DPR=zoom.
import { launchBrowser, startServer } from "./support/render-harness.mjs";
import { POPULATED_FIXTURES } from "./support/fixtures.mjs";
const playwright = await import("playwright");
const OUT = process.argv[2];
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const srv = await startServer({ fixtures: { ...POPULATED_FIXTURES, get_save_conflicts: [{
  id: "c1", rom_id: 1, game: "The Legend of Zelda: A Link to the Past", file_name: "Zelda (USA).srm", prompt: true,
  local: { updated_at: ago(26 * 60), size_bytes: 8192 },
  server: { updated_at: ago(42), size_bytes: 8192, device: "Living room PC" } }] } });
const browser = await launchBrowser(playwright);
const SIZES = process.env.ONLY ? [["1440p", 2560, 1440, 1]] : [
  ["deck-1280x800", 1280, 800, 1],
  ["1080p", 1920, 1080, 1],
  ["1440p-hidpi150", 2560 / 1.5, 1440 / 1.5, 1.5],
  ["4k-hidpi200", 1920, 1080, 2],
  ["small-1024x640", 1024, 640, 1],
];
for (const [name, w, h, os] of SIZES) {
  const zoom = Math.max(0.5, h / 800);
  const page = await browser.newPage({ viewport: { width: Math.round(w / zoom), height: Math.round(h / zoom) },
    deviceScaleFactor: zoom * os });
  await page.goto(srv.origin + "/romm-sync-library", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(10000);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  await page.close();
}
await browser.close(); await srv.close();
