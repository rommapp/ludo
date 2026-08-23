// Mount the real built UI in a real browser, one route at a time.
//
// Why this exists: ui/app/index.tsx is a 9k-line file that both shells render
// and that nothing else covers. tests/host-shell.test.mjs exercises the
// *contract* between the UI and its shell; nothing until now proved that a
// page on the other side of that contract actually draws. The gap is not
// theoretical — the bundled artwork stopped shipping with the package that
// serves it, and every symptom was a silent `success: false` that no build,
// typecheck or unit test could see.
//
// So: serve desktop/dist exactly the way backend/server.py serves it (static
// files, SPA fallback, POST /api/<method> answered from fixtures.mjs), point
// headless Chromium at one route, and look at what came out.
//
// Requires `npm run build` first — this deliberately drives the built bundle
// rather than a dev server, because the bundle is what ships.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureFor } from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DIST = process.env.LUDO_DIST
  ? resolve(process.env.LUDO_DIST)
  : resolve(HERE, "../../dist");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** True when `npm run build` has produced something to test. */
export function distIsBuilt() {
  return existsSync(join(DIST, "index.html"));
}

/**
 * Stand-in for backend/server.py. Same two behaviours the UI depends on:
 * POST /api/<method> returns `{result}`, and every unknown GET falls back to
 * index.html so a client-side route survives a direct navigation.
 *
 * Returns `{ origin, calls, close }`; `calls` accumulates every method the
 * page asked for, which is what lets a test assert a page actually talked to
 * the backend rather than rendering an empty husk.
 */
export async function startServer({ fixtures = null } = {}) {
  const calls = [];
  const srv = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    if (req.method === "POST") {
      let method = path.startsWith("/api/") ? decodeURIComponent(path.slice(5)) : "";
      calls.push(method);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: fixtureFor(method, fixtures) }));
      return;
    }

    const rel = decodeURIComponent(path === "/" ? "/index.html" : path);
    let target = resolve(join(DIST, rel));
    if (!target.startsWith(DIST)) target = join(DIST, "index.html");
    try {
      const buf = await readFile(target);
      res.writeHead(200, {
        "content-type": MIME[extname(target)] ?? "application/octet-stream",
      });
      res.end(buf);
    } catch {
      // SPA fallback, exactly as server.py does it: an unknown path is a
      // client-side route, not a missing file.
      try {
        const buf = await readFile(join(DIST, "index.html"));
        res.writeHead(200, { "content-type": "text/html" });
        res.end(buf);
      } catch {
        res.writeHead(404).end();
      }
    }
  });

  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const { port } = srv.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((ok) => srv.close(ok)),
  };
}

// Chromium ships with the container image; PLAYWRIGHT_BROWSERS_PATH points
// Playwright at it. Honour an explicit override so this also runs on a machine
// where the browser lives somewhere else.
const CHROMIUM = process.env.LUDO_CHROMIUM ?? "/opt/pw-browsers/chromium";

export async function launchBrowser(playwright) {
  const opts = existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {};
  return playwright.chromium.launch(opts);
}

// No allowlist of "expected" console noise, deliberately. The fixture server
// answers every RPC and serves every asset, so a clean run really is silent —
// and the moment a pattern gets added here it is a render failure the suite can
// no longer see.
const isBenign = () => false;

/** The subset of src/host/gamepad-buttons.ts the harness needs. */
export const PAD = { OK: 1, CANCEL: 2, SECONDARY: 3, BUMPER_LEFT: 9, BUMPER_RIGHT: 10 };

// What the page looks like, from inside it. Deliberately structural rather
// than pixel-based: a screenshot diff would fail on every legitimate style
// tweak, while "did the tree mount and does it hold content" is the question a
// render suite can actually answer.
const PROBE = () => {
  const root = document.getElementById("root");
  const app = document.querySelector(".desk-app");
  return {
    path: window.location.pathname,
    mounted: !!app,
    // A React tree that threw during render leaves #root empty.
    rootChildren: root ? root.childElementCount : 0,
    elements: app ? app.querySelectorAll("*").length : 0,
    text: document.body.innerText.replace(/\s+/g, " ").trim(),
  };
};

/**
 * Open one route and hand back a live page plus its error log.
 *
 * `settleMs` exists because these pages fetch on mount and the interesting
 * failures (a destructure of a null reply, an unguarded `.map`) happen in the
 * effect after the first paint, not during it. Waiting for network idle alone
 * returns too early.
 *
 * The caller must `close()`. Use this when a test needs to keep interacting;
 * `renderRoute` below is the open-probe-close shorthand.
 */
export async function openRoute(browser, origin, path, { settleMs = 1200 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  const record = (text) => { if (!isBenign(text)) errors.push(text); };

  page.on("console", (m) => m.type() === "error" && record(m.text()));
  page.on("pageerror", (e) => record(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => record(`requestfailed: ${r.url()}`));

  await page.goto(origin + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(settleMs);

  return {
    page,
    errors,
    probe: () => page.evaluate(PROBE),
    /**
     * Activate the thing labelled `needle`, the way a user does.
     *
     * Not a raw click: the label is usually a plain div nested inside the
     * element that actually handles activation, and the tiles animate in, so
     * Playwright's click waits for stability on the wrong node. Instead climb
     * to the nearest `.desk-focusable` — this shell's own notion of "an
     * activatable thing" — focus it, and press a key, which routes through
     * src/host/gamepad.ts exactly as the pad does. `key` picks which face
     * button: Enter is A (confirm/launch), "Shift+Enter" is X (the alternate
     * action, e.g. a game tile's Details) — see the legend table in README.md.
     */
    async activateText(needle, { settleMs: wait = 1200, key = "Enter" } = {}) {
      const ok = await page.evaluate((text) => {
        // Deepest element carrying the text: every ancestor "contains" it too,
        // and only the innermost one is next to the control we want.
        const holders = [...document.querySelectorAll("*")].filter((e) =>
          e.textContent.includes(text),
        );
        const hit = holders.find(
          (e) => !holders.some((o) => o !== e && e.contains(o)),
        );
        const target = hit?.closest('.desk-focusable[tabindex="0"]');
        if (!target) return "no-target";
        target.focus();
        // Not an identity check: focusing a tile re-renders the row, so the
        // node that ends up focused is a fresh instance of the same control.
        // What matters is that focus landed on a focusable at all.
        const now = document.activeElement;
        return now?.classList?.contains("desk-focusable") ? "ok" : "not-focused";
      }, needle);
      if (ok !== "ok") {
        throw new Error(`could not activate "${needle}": ${ok}`);
      }
      await page.keyboard.press(key);
      await page.waitForTimeout(wait);
    },
    /**
     * Press a controller button through `window.__rommGamepad`, the same entry
     * point electron/preload.cjs drives from a real pad.
     *
     * Needed for anything the keyboard cannot reach: the game detail tabs are
     * bumper-driven (the "L1 … R1" hint either side of the tab strip) and are
     * not focusable, so there is no key to send them.
     */
    async pressPad(button, { settleMs: wait = 600 } = {}) {
      const ok = await page.evaluate((b) => {
        const gp = window.__rommGamepad;
        if (!gp) return false;
        gp.button(b, true);
        gp.button(b, false);
        return true;
      }, button);
      if (!ok) throw new Error("window.__rommGamepad is not installed");
      await page.waitForTimeout(wait);
    },
    close: () => page.close(),
  };
}

/** Open a route, probe it once, close it. */
export async function renderRoute(browser, origin, path, opts) {
  const r = await openRoute(browser, origin, path, opts);
  const probe = await r.probe();
  await r.close();
  return { ...probe, errors: r.errors };
}
