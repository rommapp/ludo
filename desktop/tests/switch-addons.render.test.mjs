// The Updates & DLC section on a Switch game's Files tab (rommapp/ludo#35, #40).
//
// Eden applies one update of the several it may see, and has one switch for
// all of a game's DLC, so the page offers a choice of update and a DLC list
// that turns single ones off by renaming their files. This walks to the Files tab with a Switch
// game that has both installed, checks the rows say what Eden applies, and
// that the update picker and the DLC list each ask the backend to change it.
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
    extcontent_dir: "/home/deck/Ludo/roms/switch/extcontent",
    kind: "base",
    base_id: "0100152000022000",
    title_id: "0100152000022000",
    installed_update: { title_id: "0100152000022800", version: 393216, mode: "extcontent",
                        file_name: "Mario Kart 8 Deluxe [0100152000022800][v393216].nsp" },
    updates: [
      { title_id: "0100152000022800", version: 393216, mode: "extcontent",
        file_name: "Mario Kart 8 Deluxe [0100152000022800][v393216].nsp" },
      { title_id: "0100152000022800", version: 327680, mode: "extcontent",
        file_name: "Mario Kart 8 Deluxe [0100152000022800][v327680].nsp" },
    ],
    update_choice: 393216,
    installed_dlc: [
      { title_id: "0100152000023001", mode: "extcontent", enabled: true, toggleable: true,
        file_name: "Booster Course Pass [0100152000023001].nsp" },
      { title_id: "0100152000023002", mode: "extcontent", enabled: false, toggleable: true,
        file_name: "Booster Course Pass Wave 2 [0100152000023002].nsp" },
    ],
    available: [],
    server_updates: [
      { rom_id: 42, file_id: 7, size: 1073741824,
        file_name: "Mario Kart 8 Deluxe [0100152000022800][v262144].nsp" },
    ],
    server_dlc: [
      { rom_id: 42, file_id: 8, size: 2048,
        file_name: "Booster Course Pass Wave 3 [0100152000023003].nsp" },
    ],
    enabled: { update: true, dlc: true },
    mods: [{ name: "CTGP", enabled: true }, { name: "60fps", enabled: false }],
  },
  set_switch_add_on_enabled: { status: "ok" },
  set_switch_update: { status: "ok" },
  set_switch_dlc: { status: "ok" },
  fetch_switch_add_on: { status: "ok", kind: "dlc", title_id: "0100152000023003", version: 0 },
  switch_fetch_progress: {},
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

  test("the Files tab offers the update and DLC choices", async () => {
    const r = await openRoute(browser, srv.origin, "/romm-sync-library");
    try {
      await r.activateText("Platforms");
      await r.activateText("Test Platform");
      await r.activateText("Harness Test Game", { key: "Shift+Enter" });
      await r.pressPad(PAD.BUMPER_RIGHT);  // Overview → Files

      const p = await r.probe();
      assert.ok(p.text.toUpperCase().includes("UPDATES & DLC"), `no section: ${p.text.slice(0, 300)}`);
      assert.ok(p.text.includes("[v393216] · applied by Eden"), "chosen update not named");
      if (!LIVE) assert.ok(p.text.includes("1 of 2 DLC active in Eden · 1 more on RomM"), "DLC count wrong");
      assert.ok(p.text.includes("CTGP") && p.text.includes("Mod · active in Eden"), "no CTGP row");
      if (!LIVE) assert.ok(p.text.includes("Mod · turned off in Eden"), "disabled mod shown on");

      // The installed files start folded away behind a count.
      assert.ok(p.text.includes("Installed") && p.text.includes("Show 3"), "no Installed group");
      assert.ok(!p.text.includes("Booster Course Pass ["), "installed rows shown while folded");

      const heading = r.page.getByText("Updates & DLC", { exact: true });
      await heading.scrollIntoViewIfNeeded();
      const shot = async (suffix, target = heading.locator("xpath=../..")) => {
        if (!process.env.LUDO_SCREENSHOT) return;
        await target.screenshot({
          path: process.env.LUDO_SCREENSHOT.replace(/\.png$/, `${suffix}.png`) });
      };
      await shot("-closed");

      await r.page.getByText("Installed", { exact: true }).dispatchEvent("click");
      await r.page.waitForTimeout(300);
      const opened = await r.probe();
      assert.ok(opened.text.includes("Booster Course Pass Wave 2"), "Installed did not open");
      await shot("-open");

      // The update row opens a choice of version, and the game as released.
      await r.page.getByText("Update", { exact: true }).dispatchEvent("click");
      await r.page.waitForTimeout(400);
      const picker = await r.probe();
      assert.ok(picker.text.toUpperCase().includes("UPDATE EDEN APPLIES"), "no update picker");
      assert.ok(picker.text.includes("[v327680]"), "older update not offered");
      assert.ok(picker.text.includes("[v262144] · download 1.0 GB"), "update on RomM not offered");
      await shot("-update", r.page.getByText("Update Eden applies", { exact: true }).locator("xpath=.."));
      await r.page.getByText("Original version (no update)", { exact: true }).dispatchEvent("click");
      await r.page.waitForTimeout(400);
      assert.ok(srv.calls.includes("set_switch_update"), `calls: ${srv.calls.join(", ")}`);

      // The DLC row opens one switch per DLC, under one for all of them.
      await r.page.getByText("DLC", { exact: true }).dispatchEvent("click");
      await r.page.waitForTimeout(400);
      const list = await r.probe();
      assert.ok(list.text.includes("All DLC"), "no DLC list");
      await shot("-dlc", r.page.getByText("DLC Eden loads", { exact: true }).locator("xpath=.."));
      await r.page.getByText("Booster Course Pass Wave 2 [0100152000023002]", { exact: true })
        .last().dispatchEvent("click");
      await r.page.waitForTimeout(400);
      assert.ok(srv.calls.includes("set_switch_dlc"), `calls: ${srv.calls.join(", ")}`);

      // A DLC still on RomM downloads when turned on, then joins the list on.
      const fetched = srv.calls.filter((c) => c === "set_switch_dlc").length;
      assert.ok(list.text.includes("On RomM"), "DLC on RomM not offered");
      await r.page.getByText("Booster Course Pass Wave 3 [0100152000023003]", { exact: true })
        .last().dispatchEvent("click");
      await r.page.waitForTimeout(600);
      assert.ok(srv.calls.includes("fetch_switch_add_on"), `calls: ${srv.calls.join(", ")}`);
      assert.equal(srv.calls.filter((c) => c === "set_switch_dlc").length, fetched + 1,
                   "fetched DLC was not turned on");
      await r.pressPad(PAD.CANCEL);
      await r.page.waitForTimeout(300);

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
