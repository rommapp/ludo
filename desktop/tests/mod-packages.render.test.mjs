import test from 'node:test';
import assert from 'node:assert/strict';
import * as playwright from 'playwright';
import { PAD, openRoute, launchBrowser, startServer } from './support/render-harness.mjs';
import { POPULATED_FIXTURES } from './support/fixtures.mjs';

for (const modality of ['controller', 'pointer']) {
  test(`mod packages: install preset and remove through ${modality}`, async () => {
    const game = { ...POPULATED_FIXTURES.get_library_games.games[0], platform_slug: 'switch' };
    const fixtures = {
      ...POPULATED_FIXTURES,
      get_library_games: { success: true, games: [game] },
      switch_add_ons: { kind: 'base', base_id: '0100F2C0115B6000', mods: [] },
    };
    const server = await startServer({ fixtures });
    const browser = await launchBrowser(playwright);
    let r;
    try {
      r = await openRoute(browser, server.origin, '/romm-sync-library');
      const entry = { package_id: '42:7', file_id: 7, file_name: 'Example-mods.zip' };
      let installed = false;
      const installs = [], removals = [];
      await r.page.route('**/api/switch_mod_packages', route => route.fulfill({
        contentType: 'application/json', body: JSON.stringify({ result: {
          title_id: '0100F2C0115B6000', server: [entry],
          installed: installed ? [{ package_id: entry.package_id, name: entry.file_name, profile: 'handheld720' }] : [],
        } }),
      }));
      await r.page.route('**/api/install_switch_mod_package', route => {
        installs.push(route.request().postDataJSON().args);
        installed = true;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { status: 'ok' } }) });
      });
      await r.page.route('**/api/remove_switch_mod_package', route => {
        removals.push(route.request().postDataJSON().args);
        installed = false;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { status: 'ok' } }) });
      });
      await r.activateText('Platforms');
      await r.activateText('Test Platform');
      await r.activateText('Harness Test Game', { key: 'Shift+Enter' });
      await r.pressPad(PAD.BUMPER_RIGHT);
      assert.match((await r.probe()).text, /Mod packages/i);
      const activate = async text => {
        if (modality === 'pointer') {
          await r.page.mouse.move(30, 30);
          await r.page.mouse.move(90, 90);
          await r.page.getByText(text, { exact: true }).click();
          await r.page.waitForTimeout(300);
        } else {
          // Focus the same existing row primitive used throughout Ludo, then
          // send the confirm button through the real host's pad entry point.
          const found = await r.page.evaluate(text => {
            const all = [...document.querySelectorAll('.desk-focusable[tabindex="0"]')];
            const row = all.filter(e => e.innerText.includes(text))
              .sort((a, b) => a.innerText.length - b.innerText.length)[0];
            row?.focus();
            return !!row;
          }, text);
          assert.ok(found, `no controller row for ${text}`);
          await r.pressPad(PAD.OK, { settleMs: 400 });
        }
      };
      await activate('Example-mods.zip');
      await activate('Install · UltraCam 720p, 16:9, up to 60 FPS');
      assert.deepEqual(installs, [[42, 7, 'handheld720']]);
      await activate('Installed · UltraCam handheld preset · select to remove');
      await activate('Remove package');
      assert.deepEqual(removals, [[42, '42:7']]);
      assert.equal(installed, false);
      assert.deepEqual(r.errors, []);
    } finally {
      await r?.close();
      await browser.close();
      await server.close();
    }
  });
}
