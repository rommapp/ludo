// The Updates & DLC toggles on a Switch game's Files tab (rommapp/ludo#35).
//
// Eden has one switch for a game's update and one for all of its DLC, and the
// page offers exactly those two. This walks to the Files tab with a Switch
// game that has both installed, checks each toggle renders with the state the
// backend reported, and that activating one asks the backend to flip it.
//
// Needs `npm run build` first, like routes.render.test.mjs. Set
// LUDO_SCREENSHOT=<file.png> to keep a picture of the section.
import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { distIsBuilt, launchBrowser, openRoute, startServer, PAD } from "./support/render-harness.mjs";
import { POPULATED_FIXTURES } from "./support/fixtures.mjs";

let playwright = null;
try {
  playwright = await import("playwright");
} catch {
  console.warn("[switch-addons.render] playwright not installed — skipping");
}
const SKIP = !playwright ? "playwright is not installed"
  : !distIsBuilt() ? "no build — run `npm run build`" : false;

// LUDO_SWITCH_LIVE=<json> merges real values over the fixture (e.g. the mods
// eden_config.mods_for finds on this machine), to picture an actual install.
const LIVE = process.env.LUDO_SWITCH_LIVE ? JSON.parse(process.env.LUDO_SWITCH_LIVE) : null;

const FIXTURES = {
  ...POPULATED_FIXTURES,
  switch_add_ons: {
    mode: "extcontent",
    extcontent_dir: "/home/deck/Ludo/roms/switch/updates",
    kind: "base",
    base_id: "0100152000022000",
    title_id: "0100152000022000",
    installed_update: { title_id: "0100152000022800", version: 393216,
                        file_name: "Mario Kart 8 Deluxe [0100152000022800][v393216].nsp" },
    installed_dlc: [
      { title_id: "0100152000023001", file_name: "Booster Course Pass [0100152000023001].nsp" },
      { title_id: "0100152000023002", file_name: "Booster Course Pass Wave 2 [0100152000023002].nsp" },
    ],
    available: [],
    enabled: { update: true, dlc: false },
    mods: [{ name: "CTGP", enabled: true }, { name: "60fps", enabled: false }],
  },
  set_switch_add_on_enabled: { status: "ok" },
};
if (LIVE) Object.assign(FIXTURES.switch_add_ons, LIVE);

describe("Switch updates & DLC toggles", { skip: SKIP }, () => {
  let srv, browser;
  before(async () => {
    srv = await startServer({ fixtures: FIXTURES });
    browser = await launchBrowser(playwright);
  });
  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  test("the Files tab offers the update and DLC toggles", async () => {
    const r = await openRoute(browser, srv.origin, "/romm-sync-library");
    try {
      await r.activateText("Platforms");
      await r.activateText("Test Platform");
      await r.activateText("Harness Test Game", { key: "Shift+Enter" });
      await r.pressPad(PAD.BUMPER_RIGHT);  // Overview → Files

      const p = await r.probe();
      assert.ok(p.text.toUpperCase().includes("UPDATES & DLC"), `no section: ${p.text.slice(0, 300)}`);
      assert.ok(p.text.includes("Use update"), "no update toggle");
      assert.ok(p.text.includes("Eden applies the installed update"), "update shown off");
      if (!LIVE) assert.ok(p.text.includes("2 DLC installed, turned off in Eden"), "DLC shown on");
      assert.ok(p.text.includes("CTGP") && p.text.includes("Mod · active in Eden"), "no CTGP row");
      if (!LIVE) assert.ok(p.text.includes("Mod · turned off in Eden"), "disabled mod shown on");

      // The installed files start folded away behind a count.
      assert.ok(p.text.includes("Installed") && p.text.includes("Show 3"), "no Installed group");
      assert.ok(!p.text.includes("Booster Course Pass ["), "installed rows shown while folded");

      const heading = r.page.getByText("Updates & DLC", { exact: true });
      await heading.scrollIntoViewIfNeeded();
      const shot = async (suffix) => {
        if (!process.env.LUDO_SCREENSHOT) return;
        await heading.locator("xpath=../..").screenshot({
          path: process.env.LUDO_SCREENSHOT.replace(/\.png$/, `${suffix}.png`) });
      };
      await shot("-closed");

      await r.page.getByText("Installed", { exact: true }).dispatchEvent("click");
      await r.page.waitForTimeout(300);
      const opened = await r.probe();
      assert.ok(opened.text.includes("Booster Course Pass Wave 2"), "Installed did not open");
      await shot("-open");

      await r.page.getByText("Use DLC", { exact: true }).dispatchEvent("click");
      await r.page.waitForTimeout(400);
      assert.ok(srv.calls.includes("set_switch_add_on_enabled"), `calls: ${srv.calls.join(", ")}`);

      const before = srv.calls.filter((c) => c === "set_switch_add_on_enabled").length;
      await r.page.getByText("CTGP", { exact: true }).dispatchEvent("click");
      await r.page.waitForTimeout(400);
      assert.equal(srv.calls.filter((c) => c === "set_switch_add_on_enabled").length, before + 1,
                   "mod toggle did not call the backend");
      assert.deepEqual(r.errors, [], "console errors");
    } finally {
      await r.close();
    }
  });
});
