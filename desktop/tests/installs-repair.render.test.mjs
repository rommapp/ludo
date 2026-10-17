// The "Pair again" banner for installs that sync as an older device record.
//
// RomM 5.4 pushes "Install on device" only to the device a sign-in is bound
// to. When the backend reports install_not_bound, the library offers to pair
// again; activating the button opens the connection page.
//
// Needs `npm run build` first. LUDO_SCREENSHOT=<file.png> keeps a picture.
import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";

import { distIsBuilt, launchBrowser, openRoute, startServer } from "./support/render-harness.mjs";
import { POPULATED_FIXTURES } from "./support/fixtures.mjs";

let playwright = null;
try {
  playwright = await import("playwright");
} catch {
  console.warn("[installs-repair.render] playwright not installed — skipping");
}
const SKIP = !playwright ? "playwright is not installed"
  : !distIsBuilt() ? "no build — run `npm run build`" : false;

const FIXTURES = {
  ...POPULATED_FIXTURES,
  get_service_status: {
    ...POPULATED_FIXTURES.get_service_status,
    connection: "online", install_not_bound: true,
  },
};

describe("Pair again to receive installs", { skip: SKIP }, () => {
  let srv, browser;
  before(async () => {
    srv = await startServer({ fixtures: FIXTURES });
    browser = await launchBrowser(playwright);
  });
  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  test("the library offers to pair again, and the button opens pairing", async () => {
    const r = await openRoute(browser, srv.origin, "/romm-sync-library");
    try {
      await r.page.getByText("Pair again", { exact: true }).waitFor({ timeout: 5000 });
      const p = await r.probe();
      assert.ok(p.text.includes("Install games from RomM's website"), "no banner");
      if (process.env.LUDO_SCREENSHOT) {
        await r.page.screenshot({ path: process.env.LUDO_SCREENSHOT });
      }
      await r.page.getByText("Pair again", { exact: true }).dispatchEvent("click");
      await r.page.waitForTimeout(400);
      assert.equal((await r.probe()).path, "/romm-sync-config");
    } finally {
      await r.close();
    }
  });
});
