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
  DIST, PAD, delayRpc, distIsBuilt, endTrace, launchBrowser, openRoute, renderRoute, startServer, startTrace,
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
  { path: "/romm-sync-emulators", says: "Emulators" },
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

  test("Settings ▸ Emulators: rows match, and Back lands on the row it left", async () => {
    // The Emulators page is a view stacked on Settings, and a view comes back
    // rebuilt — so without remembering where focus was, Back dropped the user on
    // Settings' first row. The row text is the check: every emulator reads the
    // same way (name, where it lives, how it was found).
    const r = await openRoute(browser, srv.origin, "/romm-sync-library");
    try {
      // The account pill is the focusable right after the Search tab.
      await r.page.evaluate(() => {
        const els = [...document.querySelectorAll(".desk-focusable[tabindex]")];
        els[els.findIndex((e) => (e.innerText || "").trim() === "Search") + 1]?.click();
      });
      await r.page.waitForTimeout(800);
      await r.activateText("Settings");
      await r.activateText("Emulators");
      const p = await r.probe();
      for (const says of ["RetroDECK", "243 cores", "Eden", "Cemu", "detected automatically"]) {
        assert.ok(p.text.includes(says), `emulators page: expected ${says} in ${p.text.slice(0, 300)}`);
      }
      // Slow the activity list, as a real backend is: Settings then rebuilds
      // with rows missing above the one to land on. Record EVERY focus change on
      // the way back, not just where it ends — landing on the wrong row first
      // and correcting itself is the bug, and an end-state check passes it.
      await r.page.route("**/api/get_recent_activity", async (route) => {
        await new Promise((ok) => setTimeout(ok, 500));
        route.continue();
      });
      await r.page.evaluate(() => {
        window.__focusLog = [];
        // Where the row sits on screen, frame by frame: a page that rebuilds at
        // the top and then scrolls, or fills in above the row, makes it move.
        window.__rowY = [];
        setInterval(() => {
          const row = [...document.querySelectorAll(".desk-focusable[tabindex]")]
            .find((e) => (e.innerText || "").trim().startsWith("Emulators") && e.getBoundingClientRect().width < window.innerWidth);
          if (row) window.__rowY.push(Math.round(row.getBoundingClientRect().top));
        }, 10);
        setInterval(() => {
          const el = document.activeElement;
          const text = (el?.innerText || "").replace(/\s+/g, " ").trim();
          // The page-wide container takes focus for a frame with no highlight;
          // a row is anything narrower than the window.
          if (!el || el.getBoundingClientRect().width >= window.innerWidth) return;
          const log = window.__focusLog;
          if (!log.length || log[log.length - 1] !== text) log.push(text);
        }, 10);
      });
      await r.pressPad(PAD.CANCEL, { settleMs: 1800 });
      const seen = await r.page.evaluate(() => window.__focusLog);
      assert.ok(seen.length > 0, "focus never landed on a row");
      const ys = await r.page.evaluate(() => window.__rowY);
      assert.ok(ys.length > 0 && new Set(ys).size === 1,
        `the Emulators row moved while the page came back: ${JSON.stringify([...new Set(ys)])}`);
      assert.ok(seen.every((t) => t.startsWith("Emulators")),
        `focus visited other rows on the way back: ${JSON.stringify(seen)}`);
      assert.deepEqual(r.errors, []);
    } finally {
      await r.close();
    }
  });

  // ── Transitions ─────────────────────────────────────────────────────────
  //
  // A page that is right once it has settled can still be wrong on the way
  // there: rows that appear late and shove the ones below, a list that empties
  // and refills, focus visiting the wrong row first. These run each hop against
  // a backend that takes its time and look at every frame, not the last one.
  // Add one for each new page or stacked view.
  const SLOW = ["get_platform_sync", "get_game_detail", "get_library_games", "get_library_groups",
    "get_recent_activity", "get_ra_earned", "get_local_discs", "get_local_siblings", "get_save_history"];

  async function openSettings(r) {
    await r.page.evaluate(() => {
      const els = [...document.querySelectorAll(".desk-focusable[tabindex]")];
      els[els.findIndex((e) => (e.innerText || "").trim() === "Search") + 1]?.click();
    });
    await r.page.waitForTimeout(800);
    await r.activateText("Settings");
  }

  test("Settings ▸ Platforms: reopening shows the list at once, and Back lands on the row", async () => {
    const r = await openRoute(browser, srv.origin, "/romm-sync-library");
    try {
      await openSettings(r);
      // First visit has to ask. Let it finish so there is an answer to remember.
      await r.activateText("Choose which platforms");
      await r.pressPad(PAD.CANCEL, { settleMs: 800 });
      for (const m of SLOW) await delayRpc(r.page, m, 500);

      await startTrace(r.page, { watch: ["Reading your platforms"] });
      await r.activateText("Choose which platforms", { settleMs: 1200 });
      const enter = await endTrace(r.page);
      assert.deepEqual(enter.seen, [], "the platform list emptied and refilled on reopen");

      await startTrace(r.page, { row: "Platforms Choose" });
      await r.pressPad(PAD.CANCEL, { settleMs: 1500 });
      const back = await endTrace(r.page);
      assert.ok(back.focus.length > 0 && back.focus.every((t) => t.startsWith("Platforms Choose")),
        `focus visited other rows on the way back: ${JSON.stringify(back.focus)}`);
      assert.equal(new Set(back.rowY).size, 1, `the row moved on the way back: ${JSON.stringify([...new Set(back.rowY)])}`);
      assert.deepEqual(r.errors, []);
    } finally {
      await r.close();
    }
  });

  test("game detail: nothing under the title moves while the detail arrives", async () => {
    const r = await openRoute(browser, srv.origin, "/romm-sync-library");
    try {
      await r.activateText("Platforms");
      await r.activateText("Test Platform");
      for (const m of SLOW) await delayRpc(r.page, m, 400);
      await startTrace(r.page, { row: "Play" });
      await r.activateText("Harness Test Game", { key: "Shift+Enter", settleMs: 1500 });
      const t = await endTrace(r.page);
      assert.ok(t.rowY.length > 0, "the Play button never showed");
      // The date, region and language chips come with the detail; the actions
      // below them have to be where they will stay from the first frame.
      assert.equal(new Set(t.rowY).size, 1,
        `Play moved while the detail loaded: ${JSON.stringify([...new Set(t.rowY)])}`);
      assert.deepEqual(r.errors, []);
    } finally {
      await r.close();
    }
  });

  test("game detail: a game seen before opens with its details, not a loader", async () => {
    const r = await openRoute(browser, srv.origin, "/romm-sync-library");
    try {
      await r.activateText("Platforms");
      await r.activateText("Test Platform");
      await r.activateText("Harness Test Game", { key: "Shift+Enter" });
      await r.pressPad(PAD.CANCEL, { settleMs: 800 });
      for (const m of SLOW) await delayRpc(r.page, m, 500);
      await startTrace(r.page, { watch: ["Loading details"] });
      await r.activateText("Harness Test Game", { key: "Shift+Enter", settleMs: 1200 });
      const t = await endTrace(r.page);
      assert.deepEqual(t.seen, [], "the detail page showed its loader for a game it already knew");
      assert.deepEqual(r.errors, []);
    } finally {
      await r.close();
    }
  });

  test("game detail: warming up on focus waits for a pause and never piles up", async () => {
    const r = await openRoute(browser, srv.origin, "/romm-sync-library");
    try {
      const games = [1, 2, 3, 4, 5].map((i) => ({
        rom_id: 100 + i, name: `Warm Game ${i}`, platform: "Test Platform",
        platform_slug: "test", is_downloaded: true, has_cover: false,
      }));
      await r.page.route("**/api/get_library_games", (route) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { success: true, games } }) }));
      await r.activateText("Platforms");
      await r.activateText("Test Platform", { settleMs: 1200 });
      const asked = [];
      r.page.on("request", (q) => {
        if (q.url().endsWith("/api/get_game_detail")) asked.push(q.postData());
      });
      // Sweep every tile faster than the dwell: nothing may be asked.
      await r.page.evaluate(async () => {
        const tiles = [...document.querySelectorAll(".desk-focusable[tabindex]")]
          .filter((e) => e.offsetParent && /Warm Game/.test(e.innerText) && !e.innerText.includes("\n\n"));
        const seen = new Set();
        for (const t of tiles) {
          const key = t.innerText.trim();
          if (seen.has(key)) continue;
          seen.add(key);
          t.focus();
          await new Promise((ok) => setTimeout(ok, 60));
        }
      });
      await r.page.waitForTimeout(150);
      assert.equal(asked.length, 0, `asked for details while moving quickly: ${asked.join(" ")}`);
      // Rest on one: after the dwell, exactly one request for it.
      await r.page.evaluate(() => [...document.querySelectorAll(".desk-focusable[tabindex]")]
        .findLast((e) => e.offsetParent && /Warm Game 4/.test(e.innerText))?.focus());
      await r.page.waitForTimeout(900);
      assert.equal(asked.length, 1, `expected one warm-up request, saw ${asked.length}`);
      assert.match(asked[0], /104/);
      assert.deepEqual(r.errors, []);
    } finally {
      await r.close();
    }
  });

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
