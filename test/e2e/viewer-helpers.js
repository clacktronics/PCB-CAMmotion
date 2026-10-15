import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const APP_URL = pathToFileURL(join(ROOT, 'index.html')).href;
export const BOARD_DIR = join(ROOT, 'test/fixtures/synthetic/board');

export function boardFiles(dir = BOARD_DIR) {
  return readdirSync(dir)
    .filter((f) => !/LICENSE|README|\.json$/.test(f))
    .map((f) => join(dir, f));
}

/** Open the app from file:// and fail on any request that is not file:/blob:/data:. */
export async function openApp(page) {
  const external = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (/^(file|blob|data):/.test(url)) return route.continue();
    external.push(url);
    return route.abort();
  });
  await page.goto(APP_URL);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('[data-testid=board]')).toBeVisible();
  return { external, errors };
}

export async function loadBoard(page, files = boardFiles()) {
  await page.locator('[data-testid=file-input]').setInputFiles(files);
  await expect(page.locator('[data-testid=layer]').first()).toBeVisible();
  await waitRendered(page);
}

export async function waitRendered(page) {
  await page.waitForFunction(() => {
    const v = window.__pcam.app.viewer;
    return v.renderCount > 0 && !v.pending_active;
  });
  await page.waitForTimeout(150);
}

/** Device pixel colour of the board canvas at a board position (mm). */
export async function pixelAt(page, xMm, yMm) {
  return page.evaluate(
    ([x, y]) => {
      const v = window.__pcam.app.viewer;
      const m = v.map();
      const px = Math.round(m.ox + (m.mirror ? -m.s : m.s) * x);
      const py = Math.round(m.oy - m.s * y);
      const d = v.ctx.getImageData(px, py, 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [xMm, yMm],
  );
}

/** Client (CSS) coordinates of a board position, for mouse clicks. */
export async function clientAt(page, xMm, yMm) {
  return page.evaluate(
    ([x, y]) => {
      const v = window.__pcam.app.viewer;
      const m = v.map();
      const r = v.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      return [r.left + (m.ox + (m.mirror ? -m.s : m.s) * x) / dpr, r.top + (m.oy - m.s * y) / dpr];
    },
    [xMm, yMm],
  );
}
