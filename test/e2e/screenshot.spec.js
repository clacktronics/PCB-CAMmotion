// Screenshot baselines of the synthetic board (canvas only, so fonts do not matter).
// Update deliberately with: npx playwright test screenshot --update-snapshots

import { test, expect } from '@playwright/test';
import { openApp, loadBoard, waitRendered } from './viewer-helpers.js';

test.use({ viewport: { width: 1400, height: 850 } });

const views = [
  ['top-realistic', []],
  ['bottom-realistic', ['view-bottom']],
  ['top-debug', ['mode-debug']],
];

for (const [name, clicks] of views) {
  test(`synthetic board: ${name}`, async ({ page }) => {
    await openApp(page);
    await loadBoard(page);
    // Pin the canvas size: toolbar/status heights depend on the system fonts, which differ
    // between machines (CSSOM, so the CSP's style-src 'self' allows it).
    await page.evaluate(() => {
      const main = document.querySelector('main');
      main.style.width = '780px';
      main.style.height = '760px';
      main.style.flex = 'none';
    });
    await page.evaluate(() => window.__pcam.app.viewer.resize());
    await page.locator('[data-testid=fit]').click();
    for (const c of clicks) await page.locator(`[data-testid=${c}]`).click();
    await waitRendered(page);
    await page.mouse.move(0, 0);
    await expect(page.locator('[data-testid=board]')).toHaveScreenshot(`${name}.png`, { maxDiffPixelRatio: 0.002 });
  });
}
