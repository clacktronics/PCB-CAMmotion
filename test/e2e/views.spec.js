// Analysis views: classic, XOR, outline, invert, solo + flip-through, background.

import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { openApp, loadBoard, pixelAt, waitRendered, boardFiles, ROOT } from './viewer-helpers.js';
import { CLASSIC, CLASSIC_BACKGROUND, MISC, SUBSTRATE, FINISH } from '../../src/model/materials.js';

test.use({ viewport: { width: 1400, height: 850 } });

const SYN = join(ROOT, 'test/fixtures/synthetic');
const F_CU = join(SYN, 'board/synthetic-board-F_Cu.gbr');
const near = (a, b, tol = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const row = (page, name) => page.locator(`.source-row[data-name="${name}"]`);

async function mode(page, m) {
  await page.locator(`[data-testid=mode-${m}]`).click();
  await waitRendered(page);
}

/** Brightest pixel in a small square around a board position (outlines are 1 px wide). */
async function maxAround(page, x, y, rMm = 0.3) {
  let best = [0, 0, 0];
  for (let dx = -rMm; dx <= rMm; dx += 0.05)
    for (let dy = -rMm; dy <= rMm; dy += 0.05) {
      const p = await pixelAt(page, x + dx, y + dy);
      if (p[0] + p[1] + p[2] > best[0] + best[1] + best[2]) best = p;
    }
  return best;
}

test('classic view: black background and the palette colour per file', async ({ page }) => {
  await openApp(page);
  await loadBoard(page);
  await mode(page, 'classic');
  const state = await page.evaluate(() => window.__pcam.state());
  const i = state.layers.findIndex((l) => l.name === 'synthetic-board-NPTH.drl');
  expect(near(await pixelAt(page, 0.2, -5), CLASSIC_BACKGROUND.rgb, 0)).toBe(true);
  // mounting hole: only the NPTH drill layer covers it, drawn at 85 % over black
  const want = CLASSIC[i].rgb.map((c) => Math.round(c * 0.85));
  expect(near(await pixelAt(page, 4, 4), want)).toBe(true);
});

test('XOR: identical layers in the same colour cancel; a 0.2 mm shift shows only the difference', async ({ page }) => {
  await openApp(page);
  await loadBoard(page, [F_CU, join(SYN, 'board-variants/F_Cu-crlf.gbr')]);
  await mode(page, 'xor');
  for (const c of await page.locator('[data-testid=layer-colour]').all()) await c.fill('#ff8000');
  await waitRendered(page);
  expect(near(await pixelAt(page, 80, 35), [0, 0, 0], 0)).toBe(true); // copper pour cancels
  expect(near(await pixelAt(page, 15, 74), [0, 0, 0], 0)).toBe(true); // trace cancels

  page.once('dialog', (d) => d.accept()); // "discard unsaved changes?"
  await page.locator('#new').click();
  await expect(page.locator('.source-row')).toHaveCount(0);
  await loadBoard(page, [F_CU, join(SYN, 'board-variants/F_Cu-misaligned-0.2mm.gbr')]);
  await mode(page, 'xor'); // New resets the view to realistic
  for (const c of await page.locator('[data-testid=layer-colour]').all()) await c.fill('#ff8000');
  await waitRendered(page);
  expect(near(await pixelAt(page, 80, 45), [0, 0, 0], 0)).toBe(true); // both cover: cancels
  expect(near(await pixelAt(page, 66.08, 45), [255, 128, 0], 0)).toBe(true); // only the original
  expect(near(await pixelAt(page, 96.12, 45), [255, 128, 0], 0)).toBe(true); // only the shifted one
});

test('outline view draws edges, not fills', async ({ page }) => {
  await openApp(page);
  await loadBoard(page, [F_CU]);
  await mode(page, 'outline');
  expect(near(await pixelAt(page, 80, 35), MISC.background.rgb, 2)).toBe(true); // inside the pour
  const edge = await maxAround(page, 66, 45);
  expect(edge[0]).toBeGreaterThan(150); // top copper is red
});

test('invert + solo shows the solder mask material; arrows flip through the layers', async ({ page }) => {
  await openApp(page);
  await loadBoard(page);
  await mode(page, 'debug');
  await row(page, 'synthetic-board-F_Mask.gbr').locator('.name').click();
  await row(page, 'synthetic-board-F_Mask.gbr').locator('[data-testid=invert]').check();
  await page.keyboard.press('s'); // focus is on the checkbox: shortcuts must still work
  await waitRendered(page);
  let state = await page.evaluate(() => window.__pcam.state());
  expect(state.project.settings.view.solo).toBe(true);
  expect(state.project.settings.view.mode).toBe('debug');
  const roles = state.layers.find((l) => l.name === 'synthetic-board-F_Mask.gbr').role;
  expect([roles.type, roles.side]).toEqual(['soldermask', 'top']);
  const masked = await pixelAt(page, 60, 10); // bare board area: covered by mask material
  expect(near(masked, MISC.background.rgb, 10)).toBe(false);
  expect(near(await pixelAt(page, 30, 40.3), MISC.background.rgb, 2)).toBe(true); // pad opening
  expect(near(await pixelAt(page, 0.2, 0.2), MISC.background.rgb, 2)).toBe(true); // outside the board

  await page.keyboard.press('ArrowDown');
  await waitRendered(page);
  state = await page.evaluate(() => window.__pcam.state());
  expect(state.project.settings.view.activeLayer).toBe('synthetic-board-F_Cu.gbr');
  expect(near(await pixelAt(page, 60, 10), MISC.background.rgb, 2)).toBe(true); // mask no longer shown
  expect(near(await pixelAt(page, 80, 35), MISC.background.rgb, 10)).toBe(false); // copper pour shown
});

test('light background, and every view setting survives save and reopen', async ({ page, browser }) => {
  await openApp(page);
  await loadBoard(page);
  await mode(page, 'classic');
  await page.locator('[data-testid=background]').click();
  await waitRendered(page);
  expect(near(await pixelAt(page, 0.2, -5), MISC.backgroundLight.rgb, 0)).toBe(true);
  await row(page, 'synthetic-board-F_Cu.gbr').locator('[data-testid=layer-colour]').fill('#00ff00');
  await row(page, 'synthetic-board-B_Mask.gbr').locator('[data-testid=invert]').check();
  const before = await page.evaluate(() => window.__pcam.state().project.settings);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#save').click()]);
  const path = test.info().outputPath('views.pcam');
  await download.saveAs(path);
  const page2 = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  await openApp(page2);
  await page2.locator('#open-input').setInputFiles(path);
  await expect(page2.locator('.source-row')).toHaveCount(11);
  const after = await page2.evaluate(() => window.__pcam.state().project.settings);
  expect(after).toEqual(before);
  expect(after.view).toMatchObject({ mode: 'classic', background: 'light' });
  expect(after.layers['synthetic-board-F_Cu.gbr'].colour).toBe('#00ff00');
  expect(after.layers['synthetic-board-B_Mask.gbr'].invert).toBe(true);
  await expect(page2.locator('[data-testid=mode-classic]')).toHaveClass(/on/);
  await page2.close();
});

test('all views render the sample boards without errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openApp(page);
  await loadBoard(page, boardFiles(join(ROOT, 'samples/clockblock')));
  for (const m of ['debug', 'classic', 'xor', 'outline', 'realistic']) await mode(page, m);
  expect(errors).toEqual([]);
});

test('realistic + solo shows any layer as a slice: inner copper on substrate', async ({ page }) => {
  const inner = join(ROOT, 'test/fixtures/gerber/inner-copper-In1_Cu.gbr');
  await openApp(page);
  await loadBoard(page, [...boardFiles(join(SYN, 'board')), inner]);
  await expect(row(page, 'inner-copper-In1_Cu.gbr')).toHaveAttribute('data-role', 'copper:inner');
  await row(page, 'inner-copper-In1_Cu.gbr').locator('.name').click();
  await page.keyboard.press('s');
  await waitRendered(page);
  const state = await page.evaluate(() => window.__pcam.state());
  expect(state.project.settings.view).toMatchObject({ mode: 'realistic', solo: true });
  const copper = await pixelAt(page, 30, 60); // inner 1 mm trace
  expect(copper[0]).toBeGreaterThan(copper[2] + 60); // copper: red well above blue
  const fr4 = await pixelAt(page, 30, 70); // substrate between features
  expect(near(fr4, SUBSTRATE.fr4.rgb, 12)).toBe(true);
  // the top copper pour (66..96 × 30..60) is not part of this slice
  expect(near(await pixelAt(page, 80, 40), SUBSTRATE.fr4.rgb, 12)).toBe(true);
  // the inner plane is copper, the mounting hole is cut through
  expect((await pixelAt(page, 70, 10))[0]).toBeGreaterThan(150);
  expect(near(await pixelAt(page, 4, 4), MISC.background.rgb, 6)).toBe(true);

  // flip up to the top copper: its pour now shows as copper
  await page.keyboard.press('ArrowUp');
  await waitRendered(page);
  expect((await page.evaluate(() => window.__pcam.state())).project.settings.view.activeLayer).toBe(
    'synthetic-board-F_Cu.gbr',
  );
  expect((await pixelAt(page, 80, 40))[0]).toBeGreaterThan(150);
  // and the top mask slice shows mask material with the pad openings
  await row(page, 'synthetic-board-F_Mask.gbr').locator('.name').click();
  await waitRendered(page);
  const maskPx = await pixelAt(page, 60, 10);
  expect(maskPx[1]).toBeGreaterThan(maskPx[0] + 20); // green mask
  expect(near(await pixelAt(page, 30, 40.3), SUBSTRATE.fr4.rgb, 12)).toBe(true); // opening shows substrate
});

test('each layer row takes its layer colour, and follows the colour picker', async ({ page }) => {
  await openApp(page);
  await loadBoard(page);
  const bar = (name) =>
    row(page, name)
      .locator('.colour-bar')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
  const finish = (await page.evaluate(() => window.__pcam.state().project.stackup.finish)).toLowerCase();
  expect(finish).toBe('enig');
  // realistic: material colours (copper shows its ENIG finish, paste grey)
  expect(await bar('synthetic-board-F_Cu.gbr')).toBe(`rgb(${FINISH.enig.rgb.join(', ')})`);
  expect(await bar('synthetic-board-F_Paste.gbr')).toBe(`rgb(${MISC.paste.rgb.join(', ')})`);
  // classic: the palette colour for the row, also as a tint of the whole row
  await mode(page, 'classic');
  const state = await page.evaluate(() => window.__pcam.state());
  const i = state.layers.findIndex((l) => l.name === 'synthetic-board-F_Cu.gbr');
  const rgb = CLASSIC[i].rgb.join(', ');
  const style = await row(page, 'synthetic-board-F_Cu.gbr').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(style).toBe(`rgba(${rgb}, 0.26)`);
  // picking a colour recolours the row and the board
  await row(page, 'synthetic-board-F_Cu.gbr').locator('[data-testid=layer-colour]').fill('#00ff00');
  await expect.poll(() => bar('synthetic-board-F_Cu.gbr')).toBe('rgb(0, 255, 0)');
});
