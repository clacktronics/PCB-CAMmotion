// Analyser (milestone 3): aperture table, shape gallery, command inspector, step-through playback.

import { test, expect } from '@playwright/test';
import { openApp, loadBoard, pixelAt, clientAt, waitRendered } from './viewer-helpers.js';
import { clickMenu } from './helpers.js';
import { FINISH } from '../../src/model/materials.js';

test.use({ viewport: { width: 1400, height: 900 } });

const FCU = 'synthetic-board-F_Cu.gbr';

async function selectLayer(page, name) {
  await page.locator(`[data-testid=layer][data-name="${name}"]`).click();
}

const settings = (page) => page.evaluate(() => window.__pcam.state().project.settings.analyze);

test('aperture table lists every aperture with its use; a row highlights its uses', async ({ page }) => {
  const { external, errors } = await openApp(page);
  await loadBoard(page);
  await selectLayer(page, FCU);
  await page.locator('[data-testid=tab-apertures]').click();
  const rows = page.locator('[data-testid=aperture-table] [data-testid=aperture-row]');
  const expected = await page.evaluate((name) => {
    const l = window.__pcam.app.layerById(name);
    return { apertures: l.image.apertures.size, regions: l.image.stats.regions };
  }, FCU);
  await expect(rows).toHaveCount(expected.apertures + (expected.regions ? 1 : 0));
  const d14 = page.locator('[data-testid=aperture-row][data-code="14"]');
  await expect(d14).toContainText('circle ⌀0.3 mm');
  await d14.click();
  await expect(d14).toHaveClass(/\bon\b/);
  const hl = await page.evaluate(() => {
    const v = window.__pcam.app.viewer;
    return { layerId: v.highlight.layerId, n: v.highlight.indices.length };
  });
  expect(hl.layerId).toBe(FCU);
  expect(hl.n).toBe(15);
  await expect(page.locator('[data-testid=status]')).toContainText('D14: 15 uses highlighted');
  expect(await settings(page)).toMatchObject({ highlight: { layer: FCU, code: 14 } });
  // the same row again clears it
  await d14.click();
  expect(await page.evaluate(() => window.__pcam.app.viewer.highlight)).toBe(null);
  // sorting by a column
  await page.locator('[data-testid=aperture-table] th', { hasText: 'Draws' }).click();
  await page.locator('[data-testid=aperture-table] th', { hasText: 'Draws' }).click();
  await expect(rows.first()).toHaveAttribute('data-code', '14');
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('shape gallery: a card per aperture with statistics', async ({ page }) => {
  const { errors } = await openApp(page);
  await loadBoard(page);
  await selectLayer(page, FCU);
  await page.locator('[data-testid=tab-shapes]').click();
  const cards = page.locator('[data-testid=gallery] [data-testid=shape-card]');
  const n = await page.evaluate((name) => window.__pcam.app.layerById(name).image.apertures.size, FCU);
  await expect(cards).toHaveCount(n + 1); // + regions
  await expect(page.locator('[data-testid=shape-stats]')).toContainText('Narrowest draw0.1 mm');
  // thumbnails are drawn
  const inked = await cards
    .first()
    .locator('canvas')
    .evaluate((c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++;
      return n;
    });
  expect(inked).toBeGreaterThan(100);
  // card text fits its card: nothing clipped or running off the side
  const d14 = page.locator('[data-testid=shape-card][data-code="14"]');
  await expect(d14).toContainText('circle');
  await expect(d14).toContainText('⌀0.3 mm');
  const overflowing = await page.locator('[data-testid=shape-card] span').evaluateAll((els) =>
    els
      .filter((e) => {
        const card = e.closest('[data-testid=shape-card]').getBoundingClientRect();
        const r = e.getBoundingClientRect();
        return e.scrollWidth > e.clientWidth + 1 || r.left < card.left - 0.5 || r.right > card.right + 0.5;
      })
      .map((e) => e.textContent),
  );
  expect(overflowing).toEqual([]);
  await page.locator('[data-testid=shape-card][data-code="regions"]').click();
  expect(await settings(page)).toMatchObject({ highlight: { layer: FCU, code: null } });
  expect(errors).toEqual([]);
});

test('click on the board → command list at the command that drew it, and back', async ({ page }) => {
  const { errors } = await openApp(page);
  await loadBoard(page);
  const [x, y] = await clientAt(page, 15, 74);
  await page.mouse.click(x, y);
  const sel = await page.evaluate(() => window.__pcam.state().selection);
  expect(sel.layerId).toBe(FCU);
  await page.locator('[data-testid=show-command]').click();
  await expect(page.locator('[data-testid=tab-commands]')).toHaveClass(/\bon\b/);
  const selected = page.locator('[data-testid=command-list] .cmd-row.sel');
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAttribute('data-line', String(sel.line));
  await expect(selected).toContainText('Interpolate (D01)');
  // clicking another command selects the object it drew
  const other = page.locator('[data-testid=command-row].draws').first();
  const line = Number(await other.getAttribute('data-line'));
  await other.click();
  const sel2 = await page.evaluate(() => window.__pcam.state().selection);
  expect(sel2.line).toBe(line);
  await expect(page.locator('[data-testid=source-line]')).toContainText(`${line}:`);
  expect(errors).toEqual([]);
});

test('hovering a feature shows its aperture, polarity and source line', async ({ page }) => {
  await openApp(page);
  await loadBoard(page);
  const [x, y] = await clientAt(page, 15, 74);
  await page.mouse.move(x, y);
  await expect(page.locator('footer')).toContainText(/D10 circle ⌀0\.1 mm · Draw \(D01, linear\) · dark · line \d+/);
});

test('step-through playback draws the layer command by command and is saved', async ({ page }) => {
  const { errors } = await openApp(page);
  await loadBoard(page);
  await selectLayer(page, FCU);
  const pad = () => pixelAt(page, 30, 40.3); // an exposed 0805 pad (ENIG)
  const full = await pad();
  expect(Math.abs(full[0] - FINISH.enig.rgb[0])).toBeLessThan(60);
  await page.locator('[data-testid=pb-rewind]').click();
  await waitRendered(page);
  const empty = await pad(); // no copper yet: the bare substrate in the mask opening
  expect(Math.abs(empty[0] - full[0]) + Math.abs(empty[1] - full[1]) + Math.abs(empty[2] - full[2])).toBeGreaterThan(
    30,
  );
  const total = await page.evaluate((n) => window.__pcam.app.layerById(n).commands.length, FCU);
  await expect(page.locator('[data-testid=pb-pos]')).toContainText(`step 0 / ${total}`);
  // step by object: every step draws something
  await page.locator('[data-testid=pb-by]').selectOption('object');
  await page.locator('[data-testid=pb-forward]').click();
  let st = await page.evaluate((n) => {
    const a = window.__pcam.app.project.settings.analyze.playback;
    return { ...a, limit: window.__pcam.app.layerById(n).limit };
  }, FCU);
  expect(st.layer).toBe(FCU);
  expect(st.limit).toBe(1);
  await expect(page.locator('[data-testid=pb-pos]')).toContainText('1 object');
  // keyboard: "." steps forward, "," back
  await page.keyboard.press('.');
  await page.keyboard.press('.');
  await page.keyboard.press(',');
  st = await page.evaluate((n) => window.__pcam.app.layerById(n).limit, FCU);
  expect(st).toBe(2);
  // the slider jumps anywhere; at the end the pad is back
  await page.locator('[data-testid=pb-slider]').fill(String(total));
  await waitRendered(page);
  expect(await pad()).toEqual(full);
  // play from the start at full speed until the end
  await page.locator('[data-testid=pb-speed]').selectOption('1000');
  await page.locator('[data-testid=pb-play]').click();
  await expect(page.locator('[data-testid=pb-play]')).toHaveText('▶', { timeout: 10_000 });
  expect((await settings(page)).playback.step).toBe(total);
  // the playback state is project data
  await page.locator('[data-testid=pb-back]').click();
  const saved = await settings(page);
  expect(saved.playback).toEqual({ layer: FCU, step: total - 1, by: 'object', speed: 1000 });
  // end playback: whole layer again
  await page.locator('[data-testid=pb-end]').click();
  expect((await settings(page)).playback).toMatchObject({ layer: null, step: null });
  expect(await page.evaluate((n) => window.__pcam.app.layerById(n).limit, FCU)).toBeUndefined();
  expect(errors).toEqual([]);
});

test('analyser state survives save and reopen', async ({ page, browser }) => {
  await openApp(page);
  await loadBoard(page);
  await selectLayer(page, FCU);
  await page.locator('[data-testid=aperture-row][data-code="14"]').click();
  await page.locator('[data-testid=tab-commands]').click();
  for (let i = 0; i < 5; i++) await page.locator('[data-testid=pb-forward]').click();
  const before = await settings(page);
  const [download] = await Promise.all([page.waitForEvent('download'), clickMenu(page, '[data-testid=save]')]);
  const path = test.info().outputPath('analyser.pcam');
  await download.saveAs(path);
  const page2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await openApp(page2);
  await page2.locator('[data-testid=pcam-input]').setInputFiles(path);
  await expect(page2.locator('[data-testid=layer]')).toHaveCount(10);
  expect(await settings(page2)).toEqual(before);
  await expect(page2.locator('[data-testid=tab-commands]')).toHaveClass(/\bon\b/);
  const restored = await page2.evaluate((n) => {
    const app = window.__pcam.app;
    return { limit: app.layerById(n).limit, highlight: app.viewer.highlight?.indices.length };
  }, FCU);
  expect(restored).toEqual({ limit: 0, highlight: 15 });
  await expect(page2.locator('[data-testid=command-list] .cmd-row.cur')).toHaveAttribute('data-index', '4');
  await page2.close();
});

test('the Analyser button turns the dock on and off; the board gets the space back', async ({ page }) => {
  await openApp(page);
  await loadBoard(page);
  await selectLayer(page, FCU);
  const toggle = page.locator('[data-testid=analyser-toggle]');
  const dock = page.locator('section.analyser');
  const boardHeight = async () => (await page.locator('[data-testid=board]').boundingBox()).height;
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(dock).toBeVisible();
  const withDock = await boardHeight();
  // playback and highlight end when the dock is hidden, so the board shows normally
  await page.locator('[data-testid=aperture-row][data-code="14"]').click();
  await page.locator('[data-testid=pb-rewind]').click();
  await clickMenu(page, '[data-testid=analyser-toggle]');
  await expect(dock).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await boardHeight()).toBeGreaterThan(withDock + 100);
  expect(await settings(page)).toMatchObject({ open: false, highlight: null, playback: { layer: null, step: null } });
  expect(await page.evaluate((n) => window.__pcam.app.layerById(n).limit, FCU)).toBeUndefined();
  await clickMenu(page, '[data-testid=analyser-toggle]');
  await expect(dock).toBeVisible();
  // the ✕ in the dock and the A key do the same
  await page.locator('[data-testid=dock-toggle]').click();
  await expect(dock).toBeHidden();
  await page.keyboard.press('a');
  await expect(dock).toBeVisible();
  expect((await settings(page)).open).toBe(true);
});

test('drill files: tools in the table, holes in the gallery', async ({ page }) => {
  const { errors } = await openApp(page);
  await loadBoard(page);
  await selectLayer(page, 'synthetic-board-PTH.drl');
  await page.locator('[data-testid=tab-apertures]').click();
  await expect(page.locator('[data-testid=aperture-table] th').first()).toHaveText(/Tool/);
  await expect(page.locator('[data-testid=aperture-row]').first()).toContainText('T1');
  await page.locator('[data-testid=tab-commands]').click();
  await expect(page.locator('[data-testid=command-row]').first()).toBeVisible();
  await page.locator('[data-testid=tab-shapes]').click();
  await expect(page.locator('[data-testid=shape-stats]')).toContainText('Smallest hole');
  expect(errors).toEqual([]);
});
