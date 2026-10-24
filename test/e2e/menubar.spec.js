// Top bar: File, View and Edit drop-down menus keep the toolbar to one short row.

import { test, expect } from '@playwright/test';
import { openApp, loadBoard } from './viewer-helpers.js';
import { clickMenu } from './helpers.js';

test('File and View menus open, close and hold the toolbar controls', async ({ page }) => {
  await openApp(page);
  await loadBoard(page);
  const file = page.locator('[data-testid=menu-file-panel]');
  const view = page.locator('[data-testid=menu-view-panel]');
  // closed by default: file and view controls are tucked away
  await expect(file).toBeHidden();
  await expect(view).toBeHidden();
  for (const sel of ['#new', '#open', '#add', '#save', '#project-name']) {
    await expect(file.locator(sel)).toHaveCount(1);
  }
  for (const id of ['fit', 'view-2d', 'view-3d', 'mode-realistic', 'mode-classic', 'mode-xor', 'mode-outline']) {
    await expect(view.locator(`[data-testid=${id}]`)).toHaveCount(1);
  }
  await expect(view.locator('[data-testid=background]')).toHaveCount(1);
  await expect(view.locator('[data-testid=analyser-toggle]')).toHaveCount(1);
  // the editor is always on, so there is no Edit switch
  await expect(view.locator('[data-testid=edit-toggle]')).toHaveCount(0);
  // one row of toolbar
  expect((await page.locator('header.toolbar').boundingBox()).height).toBeLessThan(48);

  await page.locator('[data-testid=menu-file]').click();
  await expect(file).toBeVisible();
  await expect(page.locator('[data-testid=menu-file]')).toHaveAttribute('aria-expanded', 'true');
  // hovering the other title switches menus while one is open
  await page.locator('[data-testid=menu-view]').hover();
  await expect(view).toBeVisible();
  await expect(file).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(view).toBeHidden();
  // a click elsewhere closes it
  await page.locator('[data-testid=menu-file]').click();
  await page.locator('[data-testid=layers]').click({ position: { x: 5, y: 5 } });
  await expect(file).toBeHidden();

  // typing the project name keeps the menu open; a pick closes it
  await page.locator('[data-testid=menu-file]').click();
  await page.locator('#project-name').fill('my board');
  await expect(file).toBeVisible();
  expect(await page.evaluate(() => window.__pcam.app.project.manifest.name)).toBe('my board');
  await page.keyboard.press('Escape');

  // toggles in the View menu show their state and close the menu
  await clickMenu(page, '[data-testid=mode-classic]');
  await expect(view).toBeHidden();
  await expect(page.locator('[data-testid=mode-classic]')).toHaveClass(/\bon\b/);
  // explode stays on the bar itself in 3D, outside the menus
  await clickMenu(page, '[data-testid=view-3d]');
  await expect(page.locator('header.toolbar > .explode')).toBeVisible();
});
