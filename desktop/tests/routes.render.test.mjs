// Every route draws.
//
// tests/host-shell.test.mjs covers the seam between the shared UI and its
// shell. This covers the other side: that ui/app/index.tsx — 15k lines both
// shells render, and until now the only part of the app nothing exercised —
// actually produces a page.
//
// The bar each route has to clear is deliberately low and deliberately blunt:
// the React tree mounts, it holds real content, it says something recognisable,
// and the console stays silent. That is enough to catch the failures this
// codebase actually produces — a reply shape the page destructures blindly, an
// import that resolves to nothing, an asset that stopped shipping — none of
// which a build or a typecheck can see.
//
// Needs `npm run build` first: this drives dist/, because dist/ is what ships.
import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DIST, PAD, distIsBuilt, launchBrowser, openRoute, renderRoute, startServer,
} from "./support/render-harness.mjs";
import { POPULATED_FIXTURES } from "./support/fixtures.mjs";

// Playwright and its Chromium are heavy and not every checkout will have them.
// Skipping loudly beats failing a whole suite for a missing dev dependency —
// but never skip silently, or the net quietly stops existing.
let playwright = null;
try {
  playwright = await import("playwright");
} catch {
  console.warn("[routes.render] playwright not installed — skipping render tests");
}
const SKIP = !playwright
  ? "playwright is not installed"
  : !distIsBuilt()
    ? `no build at ${DIST} — run \`npm run build\``
    : false;

/**
 * The eleven routes startApp() registers, and a phrase each one owns.
 *
 * The phrase is the assertion that matters. "It mounted" only proves React
 * survived; a page that renders its shell and silently drops its body still
 * mounts. Matching text the page alone produces is what distinguishes a real
 * render from an empty frame.
 */
const ROUTES = [
  { path: "/romm-sync-setup", says: "Welcome to Ludo" },
  { path: "/romm-sync-settings", says: "Settings" },
  { path: "/romm-sync-stats", says: "PLATFORMS" },
  { path: "/romm-sync-cores", says: "Emulator Cores" },
  { path: "/romm-sync-bios", says: "BIOS" },
  { path: "/romm-sync-platforms", says: "Platforms" },
  { path: "/romm-sync-downloads", says: "No active downloads" },
  { path: "/romm-sync-config", says: "RomM Connection Setup" },
  { path: "/romm-sync-library", says: "Collections" },
  // These two take their parameters decoratively — the pages read module-level
  // state the previous screen set, so arriving cold is a legitimate state with
  // its own copy, not a 404. Reaching them populated is what the click-through
  // test below does.
  { path: "/romm-sync-library/test-platform", says: "No group selected" },
  { path: "/romm-sync-game/42", says: "No game selected" },
];

describe("route rendering", { skip: SKIP }, () => {
  let srv, browser;

  before(async () => {
    srv = await startServer();
    browser = await launchBrowser(playwright);
  });
  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  test("the bare path lands somewhere real", async () => {
    // main.tsx resolves "/" from config rather than trampolining through the
    // library — a configured install goes straight to it. A regression here
    // shows up as a flicker loop, which is invisible to every other test.
    const r = await renderRoute(browser, srv.origin, "/");
    assert.deepEqual(r.errors, []);
    assert.equal(r.path, "/romm-sync-library");
  });

  for (const { path, says } of ROUTES) {
    test(`${path} renders`, async () => {
      const r = await renderRoute(browser, srv.origin, path);
      assert.deepEqual(r.errors, [], `console errors on ${path}`);
      assert.equal(r.path, path, "navigated away");
      assert.ok(r.mounted, "no .desk-app — the tree never mounted");
      assert.ok(r.rootChildren > 0, "#root is empty — render threw");
      assert.ok(r.elements > 10, `only ${r.elements} elements — page is a husk`);
      assert.ok(
        r.text.includes(says),
        `expected ${JSON.stringify(says)} in: ${r.text.slice(0, 300)}`,
      );
    });
  }
});

describe("rendering with a populated library", { skip: SKIP }, () => {
  let srv, browser;

  before(async () => {
    srv = await startServer({ fixtures: POPULATED_FIXTURES });
    browser = await launchBrowser(playwright);
  });
  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  test("the library shows what the backend returned", async () => {
    const r = await renderRoute(browser, srv.origin, "/romm-sync-library");
    assert.deepEqual(r.errors, []);
    assert.ok(r.text.includes("Test Platform"), r.text.slice(0, 300));
  });

  // The empty profile only proves these pages survive having nothing; it
  // cannot tell a page that renders its rows from one that silently renders
  // none, because none is the right answer there. These can.
  for (const [path, says] of [
    ["/romm-sync-cores", "snes9x"],
    ["/romm-sync-stats", "Test Platform"],
  ]) {
    test(`${path} renders its rows`, async () => {
      const r = await renderRoute(browser, srv.origin, path);
      assert.deepEqual(r.errors, []);
      assert.ok(r.text.includes(says), `expected ${says} in: ${r.text.slice(0, 300)}`);
    });
  }

  test("library → platform → game detail → every tab", async () => {
    // The whole point of the populated profile. The grid, the detail header and
    // the four metadata tabs are the largest stretch of ui/app/index.tsx and the
    // part with the most branches that only run when there is data; none of it
    // is reachable from an empty library or from a direct navigation.
    const r = await openRoute(browser, srv.origin, "/romm-sync-library");
    try {
      await r.activateText("Platforms");
      await r.activateText("Test Platform");
      let p = await r.probe();
      assert.ok(p.text.includes("Harness Test Game"), `grid: ${p.text.slice(0, 200)}`);

      // Shift+Enter is X — Details. A plain Enter is A, which launches.
      await r.activateText("Harness Test Game", { key: "Shift+Enter" });
      p = await r.probe();
      assert.ok(p.text.includes("Test Platform"), `detail: ${p.text.slice(0, 200)}`);
      assert.ok(p.text.includes("Overview"), "no tab strip on the detail page");

      // R1 cycles the tab strip: Files, Save Data, Metadata, back to Overview.
      for (const says of ["harness.rom", "No server saves", "Hashes", "GENRES"]) {
        await r.pressPad(PAD.BUMPER_RIGHT);
        p = await r.probe();
        assert.ok(p.text.includes(says), `tab: expected ${says} in ${p.text.slice(0, 250)}`);
      }
      assert.deepEqual(r.errors, [], "console errors while walking the library");
    } finally {
      await r.close();
    }
  });
});
