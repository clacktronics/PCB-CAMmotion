// Performance budgets: large files must load and render within set times.

import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { openApp, ROOT } from './helpers.js';

const LARGE = join(ROOT, 'test/fixtures/synthetic/gerber-large/large-dense-traces-30MB.gbr');
const HOLES = join(ROOT, 'test/fixtures/synthetic/drill-large/holes-300k.drl');
const LOAD_BUDGET_MS = 25_000;
const RENDER_BUDGET_MS = 6_000;

test('30 MB Gerber (1.3 M draws) loads and renders within budget', async ({ page }) => {
  await openApp(page);
  const t0 = Date.now();
  await page.locator('[data-testid=file-input]').setInputFiles([LARGE, HOLES]);
  await expect(page.locator('[data-testid=layer]')).toHaveCount(2, { timeout: LOAD_BUDGET_MS });
  await page.waitForFunction(() => window.__pcam.app.viewer.renderCount > 0);
  const loadMs = Date.now() - t0;
  const { lastRenderMs } = await page.evaluate(() => window.__pcam.state());
  test
    .info()
    .annotations.push({ type: 'perf', description: `load ${loadMs} ms, full render ${lastRenderMs.toFixed(0)} ms` });
  expect(loadMs).toBeLessThan(LOAD_BUDGET_MS);
  expect(lastRenderMs).toBeLessThan(RENDER_BUDGET_MS);
  // zoomed-in renders only draw what is visible: much faster
  await page.evaluate(() => window.__pcam.app.viewer.setView({ cx: 150, cy: 150, scale: 200 }));
  await page.waitForTimeout(300);
  const zoomed = await page.evaluate(() => window.__pcam.state().lastRenderMs);
  expect(zoomed).toBeLessThan(RENDER_BUDGET_MS / 2);
});
