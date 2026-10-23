// Copper layer strip on the right of the board: All, T, inner 1…n, B; click shows that layer alone
// (T/B also turn the board), shift+click adds to the layers shown, All shows everything.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openApp, loadBoard, boardFiles, ROOT } from './viewer-helpers.js';
import { clickMenu } from './helpers.js';

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

const view = (page) => page.evaluate(() => ({ solo: window.__pcam.app.view.solo, side: window.__pcam.app.view.side }));

test('no layers, no strip; a two-layer board shows All, T and B; Top/Bottom left the toolbar', async ({ page }) => {
  const { errors } = await openApp(page);
  await expect(strip(page)).toBeHidden();
  await loadBoard(page);
  await expect(strip(page)).toBeVisible();
  await expect(strip(page).locator('button')).toHaveText(['All', 'T', 'B']);
  await expect(btn(page, 'all')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-testid=view-top], [data-testid=view-bottom]')).toHaveCount(0);
  await expect(page.locator('header.toolbar button', { hasText: /^(Top|Bottom)$/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('inner layers are numbered 1, 2 between T and B, and the strip sits right of the board', async ({ page }) => {
  await openApp(page);
  await loadBoard(page, fourLayerFiles());
  await expect(strip(page).locator('button')).toHaveText(['All', 'T', '1', '2', 'B']);
  await expect(btn(page, '1')).toHaveAttribute('data-layer', 'inner-copper-In1_Cu.gbr');
  await expect(btn(page, '2')).toHaveAttribute('data-layer', 'inner-copper-In2_Cu.gbr');
  const board = await page.locator('main.main').boundingBox();
  const box = await strip(page).boundingBox();
  expect(box.x + box.width).toBeGreaterThan(board.x + board.width - 20);
  expect(box.x).toBeGreaterThan(board.x + board.width / 2);
});

test('click shows only that layer (solo) and selects it; T and B turn the board; All shows everything', async ({
  page,
}) => {
  await openApp(page);
  await loadBoard(page, fourLayerFiles());
  await btn(page, '2').click();
  expect(await active(page)).toBe('inner-copper-In2_Cu.gbr');
  expect(await view(page)).toEqual({ solo: ['inner-copper-In2_Cu.gbr'], side: 'top' });
  await expect(btn(page, '2')).toHaveAttribute('aria-pressed', 'true');
  await expect(btn(page, 'all')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.source-row.active')).toHaveAttribute('data-name', 'inner-copper-In2_Cu.gbr');
  await expect(page.locator('.source-row.soloed')).toHaveCount(1);

  await btn(page, 'B').click();
  expect(await active(page)).toBe('synthetic-board-B_Cu.gbr');
  expect(await view(page)).toEqual({ solo: ['synthetic-board-B_Cu.gbr'], side: 'bottom' });
  await expect(btn(page, 'B')).toHaveClass(/facing/);
  await expect(btn(page, '2')).toHaveAttribute('aria-pressed', 'false');

  // shift+click adds a layer to the ones shown, and takes it out again
  await btn(page, '1').click({ modifiers: ['Shift'] });
  expect((await view(page)).solo).toEqual(['synthetic-board-B_Cu.gbr', 'inner-copper-In1_Cu.gbr']);
  await btn(page, '1').click({ modifiers: ['Shift'] });
  expect((await view(page)).solo).toEqual(['synthetic-board-B_Cu.gbr']);

  // All: the whole board, still from below
  await btn(page, 'all').click();
  expect(await view(page)).toEqual({ solo: [], side: 'bottom' });
  await expect(btn(page, 'all')).toHaveAttribute('aria-pressed', 'true');
  await btn(page, 'T').click();
  expect(await view(page)).toEqual({ solo: ['synthetic-board-F_Cu.gbr'], side: 'top' });
});

test('in edit mode the strip picks the edited layer', async ({ page }) => {
  await openApp(page);
  await loadBoard(page, fourLayerFiles());
  await clickMenu(page, '[data-testid=edit-toggle]');
  await btn(page, '1').click();
  expect(await page.evaluate(() => window.__pcam.app.viewer.settings.pickLayerId)).toBe('inner-copper-In1_Cu.gbr');
});
