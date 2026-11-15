// Run against a fresh desktop build, like the other render tests.
import test from "node:test";
import assert from "node:assert/strict";

import { distIsBuilt, launchBrowser, openRoute, startServer } from "./support/render-harness.mjs";

let playwright = null;
try {
  playwright = await import("playwright");
} catch {
  console.warn("[bios-keys.render] playwright not installed — skipping");
}
const SKIP = !playwright ? "playwright is not installed"
  : !distIsBuilt() ? "no build — run `npm run build`" : false;

const FIXTURES = {
  get_bios_inventory: {
    success: true, connected: true, platforms: [{
      slug: "switch", platform_name: "Nintendo Switch", missing_count: 1,
      missing_label: "title.keys", files: [
        { name: "prod.keys", size: 14000, present: true },
        { name: "title.keys", size: 100, present: false },
      ],
    }],
  },
  switch_firmware_status: {
    available: false, file_name: "Firmware.22.5.0.zip", keys_installed: true,
    installed_version: "22.5.0",
  },
  install_switch_firmware: { success: true },
  get_switch_firmware_progress: { active: false, status: "installed", keys: 1 },
};

test("current firmware and prod.keys still install missing title.keys without confirmation", { skip: SKIP }, async () => {
  const srv = await startServer({ fixtures: FIXTURES });
  let browser, r;
  try {
    browser = await launchBrowser(playwright);
    r = await openRoute(browser, srv.origin, "/romm-sync-bios");
    await r.activateText("Nintendo Switch");
    const progress = r.page.waitForResponse((response) =>
      response.url().endsWith("/api/get_switch_firmware_progress"));
    await r.activateText("Install firmware into Eden", { settleMs: 0 });
    await progress;
    assert.ok(srv.calls.includes("install_switch_firmware"), `calls: ${srv.calls.join(", ")}`);
    assert.ok(srv.calls.includes("get_switch_firmware_progress"), `calls: ${srv.calls.join(", ")}`);
    assert.equal(await r.page.getByText("Install Switch firmware?", { exact: true }).count(), 0);
    assert.equal(await r.page.getByText("Install firmware 22.5.0?", { exact: true }).count(), 0);
    assert.deepEqual(r.errors, []);
  } finally {
    await r?.close();
    await browser?.close();
    await srv.close();
  }
});
