// Layer panel group toggles: silkscreen, mask, paste, copper and holes on/off in 2D and 3D.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, loadBoard, pixelAt, waitRendered } from './viewer-helpers.js';
import { clickMenu } from './helpers.js';
import { loadProject } from '../../src/project/pcam.js';
import { MISC } from '../../src/model/materials.js';

test.use({ viewport: { width: 1400, height: 850 } });

const near = (a, b, tol = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const drawnTypes = (page) => page.evaluate(() => [...new Set(window.__pcam.app.viewer.layers.map((l) => l.role.type))]);
const toggle = (page, key) => page.locator(`[data-testid=show-${key}]`);

test('toggles sit in the layer panel; Paste starts off and is no longer in the toolbar', async ({ page }) => {
  const { errors } = await openApp(page);
  await loadBoard(page);
  for (const k of ['legend', 'soldermask', 'copper', 'drill'])
    await expect(toggle(page, k)).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle(page, 'paste')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('header.toolbar button', { hasText: /^Paste$/ })).toHaveCount(0);
  expect(await drawnTypes(page)).not.toContain('paste');
  await toggle(page, 'paste').click();
  expect(await drawnTypes(page)).toContain('paste');
  expect(errors).toEqual([]);
});

test('switching a group off hides every layer of it in 2D and greys its rows', async ({ page }) => {
  await openApp(page);
  await loadBoard(page);
  await toggle(page, 'legend').click();
  await toggle(page, 'copper').click();
  await waitRendered(page);
  const types = await drawnTypes(page);
  expect(types).not.toContain('legend');
  expect(types).not.toContain('copper');
  expect(types).toContain('soldermask');
  for (const name of ['synthetic-board-F_Silkscreen.gbr', 'synthetic-board-B_Cu.gbr'])
    await expect(page.locator(`.source-row[data-name="${name}"]`)).toHaveClass(/group-off/);
  await expect(page.locator('.source-row[data-name="synthetic-board-F_Mask.gbr"]')).not.toHaveClass(/group-off/);

  // Holes off: the mounting hole (NPTH at 4,4) is no longer cut, so it is not background
  expect(near(await pixelAt(page, 4, 4), MISC.background.rgb)).toBe(true);
  await toggle(page, 'drill').click();
  await waitRendered(page);
  expect(near(await pixelAt(page, 4, 4), MISC.background.rgb)).toBe(false);
  await toggle(page, 'drill').click();
  await waitRendered(page);
  expect(near(await pixelAt(page, 4, 4), MISC.background.rgb)).toBe(true);
});

test('3D follows the toggles: mask and hole barrels go away', async ({ page }) => {
  await openApp(page);
  await loadBoard(page);
  await clickMenu(page, '[data-testid=view-3d]');
  const state = () => page.evaluate(() => window.__pcam.app.viewer3d.state());
  await page.waitForFunction(() => window.__pcam.app.viewer3d.state().ready);
  let s = await state();
  expect(s.items.some((i) => i.type === 'soldermask')).toBe(true);
  expect(s.holes.plated).toBeGreaterThan(0);
  await toggle(page, 'soldermask').click();
  await toggle(page, 'drill').click();
  s = await state();
  expect(s.items.some((i) => i.type === 'soldermask')).toBe(false);
  expect(s.holes.plated + s.holes.npth).toBe(0);
  expect(s.items.some((i) => i.type === 'copper')).toBe(true);
});

test('toggles are saved in the .pcam and restored', async ({ page }, testInfo) => {
  await openApp(page);
  await loadBoard(page);
  await toggle(page, 'legend').click();
  await toggle(page, 'paste').click();
  const [download] = await Promise.all([page.waitForEvent('download'), clickMenu(page, '#save')]);
  const path = testInfo.outputPath('groups.pcam');
  await download.saveAs(path);
  const project = loadProject(new Uint8Array(readFileSync(path)));
  expect(project.settings.view.show).toEqual({
    legend: false,
    soldermask: true,
    paste: true,
    copper: true,
    drill: true,
  });
  expect(project.settings.view).not.toHaveProperty('showPaste');

  const fresh = await page.context().newPage();
  await openApp(fresh);
  await fresh.locator('#open-input').setInputFiles(path);
  await expect(toggle(fresh, 'legend')).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle(fresh, 'paste')).toHaveAttribute('aria-pressed', 'true');
  const types = await drawnTypes(fresh);
  expect(types).toContain('paste');
  expect(types).not.toContain('legend');
});

test('classic view: a file keeps its palette colour when other groups are switched off', async ({ page }) => {
  await openApp(page);
  await loadBoard(page);
  await clickMenu(page, '[data-testid=mode-classic]');
  await waitRendered(page);
  const hole = await pixelAt(page, 4, 4); // only the NPTH drill layer covers it
  await toggle(page, 'paste').click(); // paste comes before the drills in the list
  await toggle(page, 'legend').click();
  await waitRendered(page);
  expect(near(await pixelAt(page, 4, 4), hole, 2)).toBe(true);
});
