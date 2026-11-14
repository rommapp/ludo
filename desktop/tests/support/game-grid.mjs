import assert from "node:assert/strict";
import { POPULATED_FIXTURES } from "./fixtures.mjs";
import { openRoute, startServer } from "./render-harness.mjs";

export const GAMES = Array.from({ length: 5203 }, (_, i) => ({
  rom_id: i + 1,
  name: `${String.fromCharCode(65 + Math.floor(i * 26 / 5203))} Grid Game ${String(i).padStart(5, "0")}`,
  platform: "Grid Platform", platform_slug: "test", is_downloaded: true, has_cover: true,
}));
export const GROUPS = ["Grid Platform", "Other Platform"].map((key) => ({ key, label: key, count: GAMES.length, downloaded: GAMES.length }));
const COVER = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="90" height="120"><rect width="90" height="120" fill="purple"/></svg>');

export function gridServer() {
  return startServer({ fixtures: { ...POPULATED_FIXTURES,
    get_library_groups: { success: true, groups: GROUPS },
    get_library_games: { success: true, games: GAMES },
    search_games: { success: true, games: GAMES },
    get_home_data: { success: true, continue_playing: [], recently_added: [], collections: [], platforms: GROUPS },
    get_game_cover: { success: true, data_uri: COVER },
  } });
}

export async function openGrid(browser, origin, { search = false, noIO = false, collection = false } = {}) {
  const r = await openRoute(browser, origin, "/romm-sync-library");
  await r.page.route("**/api/get_game_detail", (route) => {
    const { args } = route.request().postDataJSON();
    const game = GAMES.find((g) => g.rom_id === Number(args[0]));
    return route.fulfill({ json: { result: { ...POPULATED_FIXTURES.get_game_detail, ...game } } });
  });
  if (noIO) {
    await r.page.addInitScript(() => { window.IntersectionObserver = undefined; });
    await r.page.reload();
    await r.page.waitForTimeout(1200);
  }
  await r.activateText(search ? "Search" : collection ? "Collections" : "Platforms");
  if (search) {
    await r.page.locator("input:visible").first().fill("grid");
  } else await r.activateText(GROUPS[0].label);
  await r.page.locator(".romm-gt-wrap:visible").first().waitFor();
  await r.page.waitForTimeout(700);
  return r;
}

export async function direction(page, dir) {
  await page.evaluate((d) => {
    if (!window.__rommGamepad) throw new Error("missing controller bridge");
    window.__rommGamepad.direction(d);
    window.__rommGamepad.direction(null);
  }, dir);
  await page.waitForTimeout(60);
}

export function focused(page) {
  return page.evaluate(() => document.activeElement?.closest(".romm-gt-wrap")?.textContent.match(/[A-Z] Grid Game \d{5}/)?.[0] ?? null);
}

// Releasing the pad stops repeats, not its scroll spring; snapshot only at rest.
export async function settleGridScroll(page) {
  await page.evaluate(() => new Promise((resolve, reject) => {
    const tile = [...document.querySelectorAll(".romm-gt-wrap")].find((el) => el.getBoundingClientRect().width);
    const scroller = tile.closest(".romm-ui");
    const deadline = performance.now() + 3000;
    let previous = scroller.scrollTop;
    let stable = 0;
    function frame(now) {
      const current = scroller.scrollTop;
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      if (stable >= 4) resolve();
      else if (now >= deadline) reject(new Error("game grid scroll did not settle"));
      else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }));
}

export async function scrollState(page) {
  return page.evaluate(() => {
    const tile = [...document.querySelectorAll(".romm-gt-wrap")].find((el) => el.getBoundingClientRect().width);
    const scroller = tile?.closest(".romm-ui");
    return { scroll: scroller?.scrollTop, cards: document.querySelectorAll(".romm-gt-wrap").length, elements: document.querySelectorAll("*").length };
  });
}

export async function bounded(page) {
  const state = await scrollState(page);
  assert.ok(state.cards > 0 && state.cards < 200, `unbounded cards: ${JSON.stringify(state)}`);
  return state;
}

// Same wheel input, dataset and viewport for HEAD and candidate. No timing gate:
// shared CI hosts are noisy; retained raw intervals make the measurement auditable.
export async function longScroll(page, steps = 24) {
  await page.mouse.move(900, 600);
  await page.evaluate(() => {
    window.__gridFrames = [];
    window.__gridMeasuring = true;
    let prev;
    function frame(t) {
      if (!window.__gridMeasuring) return;
      if (prev !== undefined) window.__gridFrames.push(t - prev);
      prev = t; requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  const samples = [];
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(60);
    samples.push(await scrollState(page));
  }
  const frames = await page.evaluate(() => { window.__gridMeasuring = false; return window.__gridFrames; });
  const sorted = [...frames].sort((a, b) => a - b);
  return { samples, frames, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], max: Math.max(...frames) };
}
