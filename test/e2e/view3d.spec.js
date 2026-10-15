// 3D view: stackup in real colours, orbit/pan/zoom, explode slider, saved in the .pcam.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, loadBoard, boardFiles, ROOT } from './viewer-helpers.js';
import { loadProject } from '../../src/project/pcam.js';
import { MISC } from '../../src/model/materials.js';

test.use({ viewport: { width: 1400, height: 850 } });

const TEST_BOARD = boardFiles(`${ROOT}/samples/test-board`).filter((f) => !f.endsWith('.md'));

const state3d = (page) => page.evaluate(() => window.__pcam.app.viewer3d.state());

async function open3d(page) {
  await page.locator('[data-testid=view-3d]').click();
  await page.waitForFunction(() => {
    const s = window.__pcam.app.viewer3d.state();
    return s.ready && s.renders > 0;
  });
}

/** Pixel of the 3D canvas at a fraction of its size (drawing buffer is preserved). */
async function pixel3d(page, fx, fy) {
  return page.evaluate(
    ([fx, fy]) => {
      const src = document.querySelector('[data-testid=board-3d]');
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(src, 0, 0);
      const d = ctx.getImageData(Math.round(src.width * fx), Math.round(src.height * fy), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [fx, fy],
  );
}

test('3D: shows the stackup in physical order with plated and non-plated holes', async ({ page }) => {
  const { external, errors } = await openApp(page);
  await loadBoard(page, TEST_BOARD);
  await expect(page.locator('[data-testid=explode]')).toBeHidden();
  await open3d(page);
  await expect(page.locator('[data-testid=board-3d]')).toBeVisible();
  await expect(page.locator('[data-testid=board]')).toBeHidden();
  await expect(page.locator('[data-testid=explode]')).toBeVisible();
  await expect(page.locator('[data-testid=mode-debug]')).toBeDisabled();

  const s = await state3d(page);
  const types = s.items.map((i) => `${i.type}:${i.side}`);
  expect(types).toEqual([
    'legend:top',
    'soldermask:top',
    'copper:top',
    'dielectric:inner', // bottom face
    'dielectric:inner', // top face
    'copper:bottom',
    'soldermask:bottom',
  ]);
  expect(s.holes.plated).toBeGreaterThan(0);
  expect(s.holes.npth).toBeGreaterThan(0);

  // the board fills the middle of the view; the corners show the background
  const bg = MISC.background.rgb;
  const centre = await pixel3d(page, 0.5, 0.5);
  const corner = await pixel3d(page, 0.02, 0.02);
  expect(corner.every((v, i) => Math.abs(v - bg[i]) <= 3)).toBe(true);
  expect(centre.some((v, i) => Math.abs(v - bg[i]) > 20)).toBe(true);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('3D: explode slider spreads the layers out from the core and is saved', async ({ page }) => {
  await openApp(page);
  await loadBoard(page, TEST_BOARD);
  await open3d(page);
  const z = (s) => Object.fromEntries(s.items.map((i) => [`${i.type}:${i.side}`, i.z]));
  const before = z(await state3d(page));
  await page.locator('[data-testid=explode]').fill('1');
  await page.waitForFunction(() => window.__pcam.app.viewer3d.state().explode === 1);
  const after = z(await state3d(page));
  expect(after['dielectric:inner']).toBeCloseTo(before['dielectric:inner'], 6);
  expect(after['copper:top']).toBeGreaterThan(before['copper:top'] + 1);
  expect(after['soldermask:top']).toBeGreaterThan(after['copper:top'] + 1);
  expect(after['legend:top']).toBeGreaterThan(after['soldermask:top'] + 1);
  expect(after['copper:bottom']).toBeLessThan(before['copper:bottom'] - 1);
  expect(after['soldermask:bottom']).toBeLessThan(after['copper:bottom'] - 1);
  const view = await page.evaluate(() => window.__pcam.state().project.settings.view);
  expect(view.explode).toBe(1);
  expect(view.view3d).toBe(true);
});

test('3D: drag orbits, right-drag pans, wheel zooms', async ({ page }) => {
  await openApp(page);
  await loadBoard(page, TEST_BOARD);
  await open3d(page);
  const box = await page.locator('[data-testid=board-3d]').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const cam = async () => (await state3d(page)).camera;
  const dist = (c) => Math.hypot(...c.position.map((v, i) => v - c.target[i]));

  const c0 = await cam();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 40, { steps: 6 });
  await page.mouse.up();
  const c1 = await cam();
  expect(c1.position).not.toEqual(c0.position);
  expect(c1.target).toEqual(c0.target); // orbit keeps the target
  expect(dist(c1)).toBeCloseTo(dist(c0), 3);

  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 100, cy, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  const c2 = await cam();
  expect(c2.target).not.toEqual(c1.target); // pan moves the target

  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(100);
  const c3 = await cam();
  expect(dist(c3)).toBeLessThan(dist(c2)); // zoomed in

  // Bottom looks from below; Fit frames the board again
  await page.locator('[data-testid=view-bottom]').click();
  expect((await cam()).position[2]).toBeLessThan(0);
  await page.locator('[data-testid=view-top]').click();
  expect((await cam()).position[2]).toBeGreaterThan(0);
});

test('3D: view, explode and camera are restored from the saved .pcam', async ({ page }, testInfo) => {
  await openApp(page);
  await loadBoard(page, TEST_BOARD);
  await open3d(page);
  await page.locator('[data-testid=explode]').fill('0.4');
  await page.locator('[data-testid=view-bottom]').click();
  const camera = (await state3d(page)).camera;
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#save').click()]);
  const path = testInfo.outputPath('3d.pcam');
  await download.saveAs(path);
  const project = loadProject(new Uint8Array(readFileSync(path)));
  expect(project.settings.view).toMatchObject({ view3d: true, explode: 0.4, side: 'bottom', camera3d: camera });

  const fresh = await page.context().newPage();
  await openApp(fresh);
  await fresh.locator('#open-input').setInputFiles(path);
  await fresh.waitForFunction(() => {
    const s = window.__pcam.app.viewer3d.state();
    return s.ready && s.renders > 0;
  });
  await expect(fresh.locator('[data-testid=board-3d]')).toBeVisible();
  await expect(fresh.locator('[data-testid=explode]')).toHaveValue('0.4');
  const s = await state3d(fresh);
  expect(s.explode).toBe(0.4);
  expect(s.camera).toEqual(camera);

  await fresh.locator('[data-testid=view-2d]').click();
  await expect(fresh.locator('[data-testid=board]')).toBeVisible();
  await expect(fresh.locator('[data-testid=board-3d]')).toBeHidden();
});
