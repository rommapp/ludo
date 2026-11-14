// LUDO_DIST=/absolute/dist LUDO_CHROMIUM=/path/chromium node tests/support/game-grid-benchmark.mjs
import { launchBrowser } from "./render-harness.mjs";
import { gridServer, longScroll, openGrid, scrollState } from "./game-grid.mjs";
import * as playwright from "playwright";
const srv = await gridServer();
const browser = await launchBrowser(playwright);
try {
  const results = {};
  for (const search of [false, true]) {
    const r = await openGrid(browser, srv.origin, { search });
    results[search ? "search" : "platform"] = { initial: await scrollState(r.page), ...await longScroll(r.page, 120), errors: r.errors };
    await r.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); await srv.close(); }
