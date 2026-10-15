import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const FILE_URL = pathToFileURL(`${ROOT}index.html`).href;
export const TEST_BOARD = `${ROOT}samples/test-board/`;

/** The ways the app must work: from a static server and opened straight from disk. */
export const MODES = [
  { name: 'http', url: '/' },
  { name: 'file://', url: FILE_URL },
];

/**
 * Record every request the page makes and block any that leave the app's own origin.
 * Returns the list of offending URLs (expected to stay empty).
 */
export async function guardNetwork(page, appUrl) {
  const origin = appUrl.startsWith('file:') ? 'file://' : new URL(appUrl).origin + '/';
  const external = [];
  const isLocal = (url) => url.startsWith(origin) || url.startsWith('blob:') || url.startsWith('data:');
  page.on('request', (req) => {
    if (!isLocal(req.url())) external.push(req.url());
  });
  page.on('websocket', (ws) => external.push(ws.url()));
  await page.route(/^(https?|wss?):/, (route) =>
    isLocal(route.request().url()) ? route.continue() : route.abort('blockedbyclient'),
  );
  return external;
}

/** Fail the test on any console error or uncaught exception. */
export function failOnErrors(page) {
  const errors = [];
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

/** Absolute URL of the app for a mode; `baseURL` comes from the Playwright fixture. */
export const appUrl = (mode, baseURL) => new URL(mode.url, baseURL).href;

export async function openApp(page, url) {
  await page.goto(url);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
}

/** Simulate dropping files onto the window (as from the OS file manager). */
export async function dropFiles(page, paths) {
  const files = paths.map((p) => ({ name: p.split('/').pop(), data: [...readFileSync(p)] }));
  await page.evaluate((files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([new Uint8Array(f.data)], f.name));
    for (const type of ['dragenter', 'dragover', 'drop']) {
      document.body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
  }, files);
}
