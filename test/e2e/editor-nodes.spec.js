// Node tool: a region's corners on the board, dragged, added at edge midpoints, deleted,
// nudged with the arrow keys and typed in; every change is one undo step and saved in the .pcam.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, loadBoard, clientAt } from './viewer-helpers.js';
import { clickMenu } from './helpers.js';
import { loadProject } from '../../src/project/pcam.js';

test.use({ viewport: { width: 1400, height: 900 } });

const FCU = 'synthetic-board-F_Cu.gbr';

async function clickMm(page, x, y, opts) {
  const [cx, cy] = await clientAt(page, x, y);
  await page.mouse.click(cx, cy, opts);
}

async function dragMm(page, from, to) {
  const [ax, ay] = await clientAt(page, ...from);
  const [bx, by] = await clientAt(page, ...to);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(bx, by, { steps: 8 });
  await page.mouse.up();
}

/** Corners of the last region on the layer, sorted, rounded to µm. */
const lastRegion = (page) =>
  page.evaluate((n) => {
    const objs = window.__pcam.app.layerById(n).image.objects;
    const o = objs[objs.length - 1];
    if (o.k !== 'R') return null;
    const c = o.contours[0];
    const pts = [];
    for (let i = 0; i < c.length; i += 2) pts.push([+c[i].toFixed(3), +c[i + 1].toFixed(3)]);
    return pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }, FCU);

test('node tool: drag, add, delete, nudge and type corners of a region; undo; saved in the .pcam', async ({
  page,
}, testInfo) => {
  const { errors } = await openApp(page);
  await loadBoard(page);
  await page.locator(`[data-testid=layer][data-name="${FCU}"]`).click();
  await expect(page.locator('[data-testid=tool-node]')).toBeVisible();

  // an empty spot right of the board, zoomed in so the handles are far apart, in the left
  // half of the view (the inspector floats over the top right)
  const b = await page.evaluate((n) => window.__pcam.app.layerById(n).image.bounds, FCU);
  const x0 = Math.ceil(b[2]) + 4;
  const y0 = Math.round(b[1]) + 2;
  await page.evaluate(([cx, cy]) => window.__pcam.app.viewer.setView({ cx, cy, scale: 40 }), [x0 + 7, y0 + 3]);
  await page.locator('[data-testid=grid]').fill('0.5');
  await page.locator('[data-testid=grid]').dispatchEvent('change');

  // a 4 × 4 mm square with the region tool
  await page.locator('[data-testid=tool-region]').click();
  for (const [x, y] of [
    [x0, y0],
    [x0 + 4, y0],
    [x0 + 4, y0 + 4],
    [x0, y0 + 4],
    [x0, y0],
  ])
    await clickMm(page, x, y);
  expect(await lastRegion(page)).toEqual([
    [x0, y0],
    [x0, y0 + 4],
    [x0 + 4, y0],
    [x0 + 4, y0 + 4],
  ]);

  // node tool by key; the new region is still selected, so its corners show at once
  await page.keyboard.press('a');
  await expect(page.locator('[data-testid=tool-node]')).toHaveClass(/on/);
  await expect(page.locator('[data-testid=node-info]')).toHaveText('4 corners');

  // drag the top-right corner out by (1, 1) mm
  await dragMm(page, [x0 + 4, y0 + 4], [x0 + 5.05, y0 + 4.95]);
  expect(await lastRegion(page)).toEqual([
    [x0, y0],
    [x0, y0 + 4],
    [x0 + 4, y0],
    [x0 + 5, y0 + 5],
  ]);
  await expect(page.locator('[data-testid=node-x]')).toHaveValue(String(x0 + 5));

  // click the bottom edge's midpoint handle: a new corner there
  await clickMm(page, x0 + 2, y0);
  await expect(page.locator('[data-testid=node-info]')).toHaveText('5 corners');
  // pull it down with the arrow key (grid 0.5 mm)
  await page.keyboard.press('ArrowDown');
  expect(await lastRegion(page)).toContainEqual([x0 + 2, y0 - 0.5]);

  // type the corner's position
  await page.locator('[data-testid=node-y]').fill(String(y0 - 1));
  await page.locator('[data-testid=node-y]').dispatchEvent('change');
  expect(await lastRegion(page)).toContainEqual([x0 + 2, y0 - 1]);

  // select the dragged corner and delete it
  await clickMm(page, x0 + 5, y0 + 5);
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-testid=node-info]')).toHaveText('4 corners');
  expect(await lastRegion(page)).toEqual([
    [x0, y0],
    [x0, y0 + 4],
    [x0 + 2, y0 - 1],
    [x0 + 4, y0],
  ]);

  // a box selects two corners; deleting them would leave 2: refused, nothing changes
  await dragMm(page, [x0 - 0.5, y0 - 0.5], [x0 + 0.5, y0 + 4.5]);
  await expect(page.locator('[data-testid=node-info]')).toContainText('2 selected');
  await page.keyboard.press('Delete');
  await expect(page.locator('#status')).toContainText('at least 3 corners');
  expect((await lastRegion(page)).length).toBe(4);

  // undo the delete: the dragged corner is back, and the region is still being edited
  await page.keyboard.press('Control+z');
  expect(await lastRegion(page)).toContainEqual([x0 + 5, y0 + 5]);
  await expect(page.locator('[data-testid=node-info]')).toHaveText('5 corners');

  const saving = page.waitForEvent('download');
  await clickMenu(page, '[data-testid=save]');
  const pcamPath = testInfo.outputPath('nodes.pcam');
  await (await saving).saveAs(pcamPath);
  const project = loadProject(new Uint8Array(readFileSync(pcamPath)));
  expect(project.edits[FCU].ops.map((o) => o.type)).toEqual([
    'addRegion',
    'moveVertex',
    'insertVertex',
    'moveVertex',
    'moveVertex',
  ]);
  expect(project.edits[FCU].redo.map((o) => o.type)).toEqual(['deleteVertex']);
  expect(errors).toEqual([]);
});

test('node tool: clicking a pad explains that only regions have corners', async ({ page }) => {
  const { errors } = await openApp(page);
  await loadBoard(page);
  await page.locator(`[data-testid=layer][data-name="${FCU}"]`).click();
  await page.locator('[data-testid=tool-node]').click();
  await expect(page.locator('[data-testid=node-info]')).toHaveText('Click a region to edit its corners');
  const pad = await page.evaluate((n) => {
    const img = window.__pcam.app.layerById(n).image;
    const i = img.objects.findIndex((o) => o.k === 'F' && o.dark);
    return { x: img.objects[i].x, y: img.objects[i].y };
  }, FCU);
  await page.evaluate(([cx, cy]) => window.__pcam.app.viewer.setView({ cx, cy, scale: 80 }), [pad.x, pad.y]);
  await clickMm(page, pad.x, pad.y);
  await expect(page.locator('#status')).toContainText('Only regions have corners');
  await expect(page.locator('[data-testid=node-info]')).toHaveText('Click a region to edit its corners');
  expect(errors).toEqual([]);
});
