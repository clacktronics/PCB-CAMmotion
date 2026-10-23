// Copper layer strip on the right of the board: T, inner 1…n, B; click selects, shift+click solos.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openApp, loadBoard, boardFiles, ROOT } from './viewer-helpers.js';

test.use({ viewport: { width: 1400, height: 850 } });

const INNER = join(ROOT, 'test/fixtures/gerber/inner-copper-In1_Cu.gbr');
const strip = (page) => page.locator('[data-testid=layer-strip]');
const btn = (page, label) => page.locator(`[data-testid=layer-strip-${label}]`);
const active = (page) => page.evaluate(() => window.__pcam.app.activeLayerId);

/** The board plus two inner layers (the second is the first one renamed to layer 3). */
function fourLayerFiles() {
  const in1 = readFileSync(INNER);
  const in2 = Buffer.from(in1.toString('latin1').replace('Copper,L2,Inr', 'Copper,L3,Inr'), 'latin1');
  const file = (path) => ({ name: basename(path), mimeType: 'application/octet-stream', buffer: readFileSync(path) });
  return [
    ...boardFiles().map(file),
    { name: basename(INNER), mimeType: 'application/octet-stream', buffer: in1 },
    { name: 'inner-copper-In2_Cu.gbr', mimeType: 'application/octet-stream', buffer: in2 },
  ];
}

test('no layers, no strip; a two-layer board shows T and B', async ({ page }) => {
  const { errors } = await openApp(page);
  await expect(strip(page)).toBeHidden();
  await loadBoard(page);
  await expect(strip(page)).toBeVisible();
  await expect(strip(page).locator('button')).toHaveText(['T', 'B']);
  expect(errors).toEqual([]);
});

test('inner layers are numbered 1, 2 between T and B, and the strip sits right of the board', async ({ page }) => {
  await openApp(page);
  await loadBoard(page, fourLayerFiles());
  await expect(strip(page).locator('button')).toHaveText(['T', '1', '2', 'B']);
  await expect(btn(page, '1')).toHaveAttribute('data-layer', 'inner-copper-In1_Cu.gbr');
  await expect(btn(page, '2')).toHaveAttribute('data-layer', 'inner-copper-In2_Cu.gbr');
  const board = await page.locator('main.main').boundingBox();
  const box = await strip(page).boundingBox();
  expect(box.x + box.width).toBeGreaterThan(board.x + board.width - 20);
  expect(box.x).toBeGreaterThan(board.x + board.width / 2);
});

test('click selects the layer (and its row); shift+click solos it', async ({ page }) => {
  await openApp(page);
  await loadBoard(page, fourLayerFiles());
  await btn(page, '2').click();
  expect(await active(page)).toBe('inner-copper-In2_Cu.gbr');
  await expect(btn(page, '2')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.source-row.active')).toHaveAttribute('data-name', 'inner-copper-In2_Cu.gbr');

  await btn(page, 'B').click();
  expect(await active(page)).toBe('synthetic-board-B_Cu.gbr');
  await expect(btn(page, '2')).toHaveAttribute('aria-pressed', 'false');

  await btn(page, '1').click({ modifiers: ['Shift'] });
  expect(await page.evaluate(() => window.__pcam.app.view.solo)).toEqual(['inner-copper-In1_Cu.gbr']);
  await expect(btn(page, '1')).toHaveClass(/soloed/);
  await expect(btn(page, 'T')).toHaveClass(/muted/);
  // with one layer soloed, selecting another moves the solo (as in the layer list)
  await btn(page, 'T').click();
  expect(await page.evaluate(() => window.__pcam.app.view.solo)).toEqual(['synthetic-board-F_Cu.gbr']);
  await btn(page, 'T').click({ modifiers: ['Shift'] });
  expect(await page.evaluate(() => window.__pcam.app.view.solo)).toEqual([]);
});

test('in edit mode the strip picks the edited layer', async ({ page }) => {
  await openApp(page);
  await loadBoard(page, fourLayerFiles());
  await page.locator('[data-testid=edit-toggle]').click();
  await btn(page, '1').click();
  expect(await page.evaluate(() => window.__pcam.app.viewer.settings.pickLayerId)).toBe('inner-copper-In1_Cu.gbr');
});
