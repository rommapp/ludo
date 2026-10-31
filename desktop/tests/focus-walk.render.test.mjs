// Walk every list with the d-pad and with the arrow keys, and check that only
// one thing looks focused at a time.
//
// The mouse and the pad light rows through different paths: hover leaves on
// mouseleave, focus leaves on blur. A row that overrides onBlur and forgets the
// highlight's own handler stays lit after the pad moves on, and nothing that
// clicks can see it. So each step here compares every row the walk has already
// left against how it looked before it was ever focused.
//
// Needs `npm run build` first, like the other render tests.
import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PAD, delayRpc, distIsBuilt, endTrace, launchBrowser, openRoute, startServer, startTrace } from "./support/render-harness.mjs";
import { POPULATED_FIXTURES } from "./support/fixtures.mjs";

let playwright = null;
try { playwright = await import("playwright"); } catch {
  console.warn("[focus-walk.render] playwright not installed — skipping");
}
const SKIP = !playwright ? "playwright is not installed" : !distIsBuilt() ? "no build — run `npm run build`" : false;

const PLAY_TIME = JSON.parse(readFileSync(new URL("./support/play-time.fixture.json", import.meta.url)));
const RECAP = JSON.parse(readFileSync(new URL("./support/recap.fixture.json", import.meta.url)));
const FIXTURES = { ...POPULATED_FIXTURES, get_play_time: PLAY_TIME, get_monthly_recap: RECAP };

// The d-pad is not a button here: the native shell calls direction(), as
// electron/preload.cjs does for a real pad, then releases it with null.
async function padDirection(r, dir) {
  const ok = await r.page.evaluate((d) => {
    const gp = window.__rommGamepad;
    if (!gp) return false;
    gp.direction(d); gp.direction(null);
    return true;
  }, dir);
  if (!ok) throw new Error("window.__rommGamepad is not installed");
  await r.page.waitForTimeout(350);
}

// [label, path, label of the row to open first (or null)]
const WALKS = [
  ["settings", "/romm-sync-settings", null],
  ["stats", "/romm-sync-stats", null],
  ["play time", "/romm-sync-playtime", null],
  ["play time › top games", "/romm-sync-playtime", "Top games"],
  ["play time › by platform", "/romm-sync-playtime", "By platform"],
  ["play time › monthly recap", "/romm-sync-playtime", "September 2026"],
  ["emulators", "/romm-sync-emulators", null],
  ["cores", "/romm-sync-cores", null],
  ["bios", "/romm-sync-bios", null],
  ["platforms", "/romm-sync-platforms", null],
  ["library", "/romm-sync-library", null],
];
const INPUTS = {
  pad: padDirection,
  keyboard: async (r, dir) => { await r.page.keyboard.press(dir === "down" ? "ArrowDown" : "ArrowUp"); await r.page.waitForTimeout(350); },
};
const STEPS = 10;

// Open something and come back: Back has to land on the row you left.
// These come in the way a user does, through the library's Start menu, so the
// pages sit in the library's view stack as they do in the app.
// [label, Start-menu entry, row to open first (or null), the row to walk to]
const ROUND_TRIPS = [
  ["play time → top games", "Play time", null, "Top games"],
  ["play time → last month", "Play time", null, "September 2026"],
  ["play time › top games → game page", "Play time", "Top games", "Biker Mice"],
  ["settings → play time", "Settings", null, "Play time"],
  ["settings → emulators", "Settings", null, "Emulators"],
];
const PRESS = {
  pad: { ok: (r) => r.pressPad(PAD.OK, { settleMs: 900 }), back: (r) => r.pressPad(PAD.CANCEL, { settleMs: 1200 }) },
  keyboard: {
    ok: async (r) => { await r.page.keyboard.press("Enter"); await r.page.waitForTimeout(900); },
    back: async (r) => { await r.page.keyboard.press("Escape"); await r.page.waitForTimeout(1200); },
  },
};
const focusedText = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return el && el !== document.body ? (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60) : "<nothing>";
});

// Install in the page: tag every focusable, remember how each one looks at
// rest, and report the ones that left focus but still don't look at rest.
const INSTALL = () => {
  const look = (e) => { const s = getComputedStyle(e); return `${s.backgroundColor}|${s.boxShadow}|${s.outlineStyle}|${s.borderColor}|${s.transform}`; };
  const w = (window.__walk = { rest: new Map(), visited: new Set(), n: 0 });
  w.tag = () => {
    for (const e of document.querySelectorAll(".desk-focusable")) {
      if (!e.dataset.walk) e.dataset.walk = String(++w.n);
      const id = e.dataset.walk;
      const inFocus = e.contains(document.activeElement);
      if (!w.rest.has(id) && !inFocus) w.rest.set(id, look(e));
      if (inFocus) w.visited.add(id);
    }
  };
  w.stale = () => {
    w.tag();
    const out = [];
    for (const id of w.visited) {
      const e = document.querySelector(`[data-walk="${id}"]`);
      if (!e || e.contains(document.activeElement) || !w.rest.has(id)) continue;
      if (look(e) !== w.rest.get(id)) out.push((e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 50) + (window.__walkDebug ? ` [${w.rest.get(id)} → ${look(e)}]` : ""));
    }
    return out;
  };
};

describe("focus walk", { skip: SKIP }, () => {
  let server, browser;
  before(async () => { server = await startServer({ fixtures: FIXTURES }); browser = await launchBrowser(playwright); });
  after(async () => { await browser?.close(); await server?.close(); });

  for (const [label, path, open] of WALKS) {
    for (const [input, move] of Object.entries(INPUTS)) {
      test(`${label} — ${input}: one highlight at a time`, async () => {
        const r = await openRoute(browser, server.origin, path);
        try {
          await r.page.mouse.move(0, 0);   // no hover in play
          if (open) await r.activateText(open, { settleMs: 800 });
          const scrollOf = () => r.page.evaluate(() => {
            const sc = [...document.querySelectorAll(".romm-ui")]
              .filter((e) => e.offsetParent !== null && e.scrollHeight > e.clientHeight).pop();
            return Math.round(sc?.scrollTop ?? document.scrollingElement.scrollTop);
          });
          const opened = await scrollOf();
          await r.page.evaluate(INSTALL); if (process.env.WALK_DEBUG) await r.page.evaluate(() => { window.__walkDebug = 1; });
          await r.page.evaluate(() => window.__walk.tag());
          const problems = [];
          for (const dir of [...Array(STEPS).fill("down"), ...Array(STEPS).fill("up")]) {
            await move(r, dir);
            const stale = await r.page.evaluate(() => window.__walk.stale());
            if (stale.length) problems.push(`${dir}: still lit → ${stale.join(" | ")}`);
          }
          assert.deepEqual(problems, [], `rows kept their focus look after ${input} moved off them`);
          // Up as far as down: the page is back where it opened, not short of it.
          await r.page.waitForTimeout(400);
          assert.equal(await scrollOf(), opened, "walking back up stopped short of the top");
          // And Up keeps going until nothing focusable is left above — the
          // header's Back included.
          for (let i = 0; i < 6; i++) await move(r, "up");
          const above = await r.page.evaluate(() => {
            const a = document.activeElement, ar = a.getBoundingClientRect();
            return [...document.querySelectorAll('.desk-focusable[tabindex="0"], button')]
              .filter((o) => o !== a && !o.contains(a) && !a.contains(o) && o.offsetParent !== null
                && !o.closest('.desk-topbar, nav, [role="tablist"]')
                // Wrappers hold controls but aren't targets themselves.
                && !o.querySelector('.desk-focusable[tabindex="0"], button'))
              .filter((o) => o.getBoundingClientRect().bottom <= ar.top + 1)
              .map((o) => (o.innerText || o.getAttribute('aria-label') || o.className).replace(/\s+/g, ' ').slice(0, 30) + (window.__walkDebug ? ' @' + Math.round(o.getBoundingClientRect().top) + ' active:' + a.outerHTML.slice(0,200) + '@' + Math.round(ar.top) + ' ' + o.outerHTML.slice(0,160) : ''));
          });
          // Arrow keys inside a text field move the caret, not focus: there the
          // keyboard is meant to stop, and only the pad has to get past.
          const inField = await r.page.evaluate(() => document.activeElement?.tagName === "INPUT");
          if (!(input === "keyboard" && inField)) assert.deepEqual(above, [], "Up got stuck below these");
          assert.deepEqual(r.errors, []);
        } finally { await r.close(); }
      });
    }
  }

  for (const [label, path, open, steps] of ROUND_TRIPS) {
    for (const [input, move] of Object.entries(INPUTS)) {
      test(`${label} — ${input}: Back returns to the row you left`, async () => {
        const target = steps;
        const r = await openRoute(browser, server.origin, "/romm-sync-library");
        // A real backend takes a moment: a page that re-fetches on the way back
        // shows whatever it draws in the meantime.
        await delayRpc(r.page, "get_play_time", 400);
        try {
          await r.page.mouse.move(0, 0);
          await r.pressPad(PAD.START, { settleMs: 600 });
          await r.activateText(path, { settleMs: 1200 });
          if (open) await r.activateText(open, { settleMs: 800 });
          let left = await focusedText(r.page);
          for (let i = 0; i < 40 && !left.replace(/^… /, "").startsWith(target); i++) { await move(r, "down"); left = await focusedText(r.page); }
          assert.ok(left.replace(/^… /, "").startsWith(target), `walking down never reached "${target}" (stopped on "${left}")`);
          await PRESS[input].ok(r);
          const away = await focusedText(r.page);
          assert.notEqual(away, left, `A on "${left}" went nowhere — the trip tests nothing`);
          await startTrace(r.page);
          await PRESS[input].back(r);
          await r.page.waitForTimeout(500);
          const trace = await endTrace(r.page);
          assert.equal(await focusedText(r.page), left);
          // And it gets there without a detour: no frame shows the page
          // scrolled anywhere but where it settles (e.g. at the top first).
          const settled = trace.frames[trace.frames.length - 1]?.scroll ?? 0;
          // frames[0] is the page before Back was pressed.
          const detours = trace.frames.slice(1).filter((f) => f.textLen > 200 && Math.abs(f.scroll - settled) > 4);
          assert.deepEqual(detours.map((f) => `${f.ms}ms scroll ${f.scroll}`), [],
            `Back showed the page at another position before settling at ${settled}`);
          assert.deepEqual(r.errors, []);
        } finally { await r.close(); }
      });
    }
  }

  // Changing month in the recap swaps straight to the next month: never a
  // frame of "Putting … together…" in between, even against a slow backend.
  for (const [input, press] of Object.entries({
    pad: (r, b) => r.pressPad(b === "L" ? PAD.BUMPER_LEFT : PAD.BUMPER_RIGHT, { settleMs: 700 }),
  })) {
    test(`recap — ${input}: switching month never shows a loading state`, async () => {
      const r = await openRoute(browser, server.origin, "/romm-sync-library");
      await delayRpc(r.page, "get_monthly_recap", 300);
      try {
        await r.pressPad(PAD.START, { settleMs: 600 });
        await r.activateText("Play time", { settleMs: 1200 });
        await r.activateText("See the recap", { settleMs: 1500 });
        await startTrace(r.page, { watch: ["together…"] });
        for (const b of ["L", "L", "R", "R"]) await press(r, b);
        const trace = await endTrace(r.page);
        assert.deepEqual(trace.seen, [], "a month switch showed the loading line");
        assert.deepEqual(r.errors, []);
      } finally { await r.close(); }
    });
  }
});
