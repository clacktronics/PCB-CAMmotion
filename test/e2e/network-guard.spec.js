// The no-network assertion in app.spec.js is only meaningful if the guard really sees
// outgoing requests. Prove it on a page without the app's Content-Security-Policy.
import { test, expect } from '@playwright/test';
import { guardNetwork } from './helpers.js';

test('the network guard detects and blocks external requests', async ({ page, baseURL }) => {
  const external = await guardNetwork(page, baseURL);
  await page.goto(new URL('/no-such-page', baseURL).href); // plain-text 404: same origin, no CSP
  await page.evaluate(() => fetch('https://example.invalid/x').catch(() => {}));
  await expect.poll(() => external).toEqual(['https://example.invalid/x']);
});

test('the app declares a Content-Security-Policy that forbids network connections', async ({ page, baseURL }) => {
  await page.goto(baseURL);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("default-src 'self'");
});
