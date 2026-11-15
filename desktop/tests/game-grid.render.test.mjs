import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { distIsBuilt, launchBrowser, PAD } from "./support/render-harness.mjs";
import { GAMES, bounded, direction, focused, gridServer, longScroll, openGrid, scrollState, settleGridScroll } from "./support/game-grid.mjs";

let playwright;
try { playwright = await import("playwright"); } catch {}
describe("bounded built game grids", { skip: !playwright ? "playwright unavailable" : !distIsBuilt() ? "run npm run build first" : false }, () => {
  let browser, srv;
  before(async () => { srv = await gridServer(); browser = await launchBrowser(playwright); });
  after(async () => { await browser?.close(); await srv?.close(); });

  for (const collection of [false, true]) test(`${collection ? "collection" : "platform"}: controller crosses windows, alphabet jumps, detail return and group reset`, async () => {
    const r = await openGrid(browser, srv.origin, { collection });
    try {
      await bounded(r.page);
      await r.page.waitForFunction(() => [...document.querySelectorAll(".romm-gt-wrap img")].some((img) => img.complete && img.naturalWidth > 0));
      const first = await focused(r.page);
      assert.equal(first, GAMES[0].name);
      for (let i = 0; i < 35; i++) await direction(r.page, "down");
      assert.notEqual(await focused(r.page), first);
      assert.ok((await bounded(r.page)).scroll > 1500);
      const beforeJump = await focused(r.page);
      await r.pressPad(8); // TRIGGER_RIGHT, src/host/gamepad-buttons.ts
      const next = await focused(r.page);
      assert.ok(next && next[0] > beforeJump[0], `${beforeJump} -> ${next}`);
      await r.pressPad(7);
      assert.ok((await focused(r.page))[0] < next[0]);
      await settleGridScroll(r.page);
      const name = await focused(r.page);
      const saved = await scrollState(r.page);
      await r.pressPad(PAD.SECONDARY);
      await r.page.waitForTimeout(600);
      await r.pressPad(PAD.CANCEL, { settleMs: 1400 });
      assert.equal(await focused(r.page), name, "return restores identical ROM");
      const returnedScroll = (await scrollState(r.page)).scroll;
      assert.ok(Math.abs(returnedScroll - saved.scroll) <= 2, `return restores pixel scroll: ${saved.scroll} -> ${returnedScroll}`);
      await r.pressPad(PAD.BUMPER_RIGHT, { settleMs: 1200 });
      assert.ok((await bounded(r.page)).scroll < 300, "new group resets viewport");
      await r.page.locator(".romm-gt-wrap:visible").first().evaluate((tile) => {
        const scroller = tile.closest(".romm-ui");
        scroller.scrollTop = scroller.scrollHeight;
      });
      await r.page.waitForTimeout(500);
      assert.ok(await r.page.locator(".romm-gt-wrap:visible").first().evaluate((tile) => {
        const scroller = tile.closest(".romm-ui");
        return Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) <= 2;
      }), "end-row setup reaches scroll bottom");
      await bounded(r.page);
      const last = r.page.locator(".romm-gt-wrap:visible").filter({ hasText: GAMES.at(-1).name });
      await last.focus();
      await direction(r.page, "down");
      assert.equal(await focused(r.page), GAMES.at(-1).name, "short final row stays on last ROM");
      await direction(r.page, "up");
      assert.notEqual(await focused(r.page), GAMES.at(-1).name);
      assert.deepEqual(r.errors, []);
    } finally { await r.close(); }
  });

  test("retained offscreen focus moves to its logical neighbor after mouse scroll and resize", async () => {
    const r = await openGrid(browser, srv.origin);
    try {
      const columns = await r.page.locator(".romm-games-grid:visible").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
      assert.equal(await focused(r.page), GAMES[0].name);
      // Wheel alone must not pick a distant visible tile as the next pad target.
      await r.page.mouse.move(1250, 600);
      await r.page.mouse.wheel(0, 30000);
      await r.page.waitForTimeout(400);
      await bounded(r.page);
      await direction(r.page, "right");
      assert.equal(await focused(r.page), GAMES[1].name);
      await direction(r.page, "down");
      assert.equal(await focused(r.page), GAMES[columns + 1].name);
      await r.page.setViewportSize({ width: 960, height: 720 });
      await r.page.waitForTimeout(300);
      const resizedColumns = await r.page.locator(".romm-games-grid:visible").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
      await r.page.keyboard.press("ArrowDown");
      await r.page.waitForTimeout(60);
      assert.equal(await focused(r.page), GAMES[columns + 1 + resizedColumns].name);
      assert.ok(await r.page.evaluate(() => {
        const rect = document.activeElement.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight;
      }), "logical target must be visible");
      assert.deepEqual(r.errors, []);
    } finally { await r.close(); }
  });

  test("Search: long mouse scroll without IntersectionObserver, replacement and hide/reveal", async () => {
    const r = await openGrid(browser, srv.origin, { search: true, noIO: true });
    try {
      await bounded(r.page);
      const measurement = await longScroll(r.page);
      assert.ok(measurement.samples.at(-1).scroll > 20000);
      for (const state of measurement.samples) assert.ok(state.cards < 200, JSON.stringify(state));
      const tile = r.page.locator(".romm-gt-wrap:visible").first();
      await tile.focus();
      const original = await focused(r.page);
      for (let i = 0; i < 20; i++) await direction(r.page, "down");
      assert.notEqual(await focused(r.page), original, "Search crosses virtual rows using controller");
      await settleGridScroll(r.page);
      const savedName = await focused(r.page);
      const savedScroll = (await scrollState(r.page)).scroll;
      await r.pressPad(PAD.SECONDARY, { settleMs: 1000 });
      await r.pressPad(PAD.CANCEL, { settleMs: 1400 });
      assert.equal(await focused(r.page), savedName, "Search detail return restores ROM");
      const returnedScroll = (await scrollState(r.page)).scroll;
      assert.ok(Math.abs(returnedScroll - savedScroll) <= 2, `Search detail return restores pixel scroll: ${savedScroll} -> ${returnedScroll}`);
      await r.activateText("Platforms");
      await r.activateText("Search");
      await bounded(r.page);
      await r.page.route("**/api/search_games", (route) => route.fulfill({ json: { result: { success: true, games: GAMES.slice(0, 3) } } }));
      const input = r.page.locator("input:visible").first();
      await input.fill("replacement");
      await r.page.waitForTimeout(900);
      assert.equal(await r.page.locator(".romm-gt-wrap:visible").count(), 3);
      assert.ok((await scrollState(r.page)).scroll < 300, "replacement clamps old deep scroll");
      await input.fill("x");
      await r.page.waitForTimeout(400);
      assert.equal(await r.page.locator(".romm-gt-wrap:visible").count(), 0);
      assert.deepEqual(r.errors, []);
    } finally { await r.close(); }
  });

  test("scroll settlement waits for frame-driven motion, not a fixed delay", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<div class="romm-ui" style="height:100px;overflow:auto"><div class="romm-gt-wrap" style="height:2000px">Tile</div></div>');
      const inFlight = await page.evaluate(() => {
        const scroller = document.querySelector(".romm-ui");
        let frame = 0;
        function move() {
          scroller.scrollTop = ++frame * 10;
          if (frame < 12) requestAnimationFrame(move);
        }
        requestAnimationFrame(move);
        return scroller.scrollTop;
      });
      assert.equal(inFlight, 0, "control captures an in-flight scroll");
      await settleGridScroll(page);
      assert.equal((await scrollState(page)).scroll, 120);
    } finally { await page.close(); }
  });
});
