// Editor tool strip: select box (dragged rightwards: inside only; leftwards: touching), lasso,
// hand, double-click to select connected, 45° tracks, and the right-click menu (same shape,
// same aperture, connected; edit from outside edit mode).

import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { openApp, loadBoard, boardFiles, clientAt, ROOT } from './viewer-helpers.js';
import { clickMenu } from './helpers.js';
import { synthGerber, gerber, drill, bytes } from '../helpers.js';
import { objectsInPolygon, boxPolygon, sameShape, connected } from '../../src/edit/selection.js';
import { hitTest } from '../../src/model/hit-test.js';

test.use({ viewport: { width: 1400, height: 900 } });

const FCU = 'synthetic-board-F_Cu.gbr';
const image = synthGerber(`board/${FCU}`).image;

const selection = (page) => page.evaluate(() => window.__pcam.app.editor.sel);

async function startEditing(page) {
  await loadBoard(page);
  await page.locator(`[data-testid=layer][data-name="${FCU}"]`).click();
  await clickMenu(page, '[data-testid=edit-toggle]');
  await expect(page.locator('[data-testid=tool-strip]')).toBeVisible();
}

async function dragMm(page, from, to, steps = 6) {
  const [ax, ay] = await clientAt(page, ...from);
  const [bx, by] = await clientAt(page, ...to);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(bx, by, { steps });
  await page.mouse.up();
}

/** A long horizontal track: a box across its middle touches it without enclosing it. */
function longTrack() {
  const i = image.objects.findIndex((o) => o.k === 'L' && o.y1 === o.y2 && Math.abs(o.x2 - o.x1) > 6);
  const o = image.objects[i];
  const xm = (o.x1 + o.x2) / 2;
  return {
    index: i,
    box: [
      [xm - 1, o.y1 - 0.6],
      [xm + 1, o.y1 + 0.6],
    ],
  };
}

test('tool strip: tools by click and key; a box drag picks inside only or touching by direction', async ({ page }) => {
  const { errors } = await openApp(page);
  await startEditing(page);
  const strip = page.locator('[data-testid=tool-strip]');
  for (const t of ['select', 'lasso', 'hand', 'pad', 'track', 'region'])
    await expect(strip.locator(`[data-testid=tool-${t}]`)).toBeVisible();
  // no mode toggle: the drag direction picks the mode
  await expect(page.locator('[data-testid=select-mode]')).toHaveCount(0);
  await expect(page.locator('[data-testid^=select-mode-]')).toHaveCount(0);
  await page.locator('[data-testid=tool-lasso]').click();
  await expect(page.locator('[data-testid=tool-lasso]')).toHaveClass(/on/);
  await page.keyboard.press('v');
  await expect(page.locator('[data-testid=tool-select]')).toHaveClass(/on/);

  const t = longTrack();
  const [a, b] = t.box;
  const overlayMode = () => page.evaluate(() => window.__pcam.app.editor.drag?.mode);
  // left to right: entirely inside (green box while dragging)
  const [ax, ay] = await clientAt(page, ...a);
  const [bx, by] = await clientAt(page, ...b);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(bx, by, { steps: 6 });
  expect(await overlayMode()).toBe('enclose');
  await page.mouse.up();
  const enclosed = await selection(page);
  expect(enclosed).toEqual(objectsInPolygon(image, boxPolygon(a, b), 'enclose'));
  expect(enclosed).not.toContain(t.index);

  // right to left over the same box: anything touched (red box while dragging)
  await page.mouse.move(bx, ay);
  await page.mouse.down();
  await page.mouse.move(ax, by, { steps: 6 });
  expect(await overlayMode()).toBe('touch');
  await page.mouse.up();
  const touched = await selection(page);
  expect(touched).toEqual(objectsInPolygon(image, boxPolygon(a, b), 'touch'));
  expect(touched).toContain(t.index);

  // G no longer switches anything; Alt takes away what the box picks
  await page.keyboard.press('g');
  await page.keyboard.down('Alt');
  await dragMm(page, [b[0], a[1]], [a[0], b[1]]);
  await page.keyboard.up('Alt');
  expect(await selection(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('double-click a shape selects everything connected to it', async ({ page }) => {
  const { errors } = await openApp(page);
  await startEditing(page);
  const onTop = (o, i) => hitTest(image, o.x ?? o.x1, o.y ?? o.y1) === i;
  const net = image.objects.findIndex(
    (o, i) => o.dark && o.k !== 'R' && onTop(o, i) && connected(image, [i]).length > 1,
  );
  expect(net).toBeGreaterThanOrEqual(0);
  const q = image.objects[net];
  const [nx, ny] = await clientAt(page, q.x ?? q.x1, q.y ?? q.y1);
  await page.mouse.dblclick(nx, ny);
  expect(await selection(page)).toEqual(connected(image, [net]));
  await expect(page.locator('[data-testid=status]')).toContainText('connected');
  expect(errors).toEqual([]);
});

test('lasso selects what it is drawn round; hand and Space pan instead of selecting', async ({ page }) => {
  const { errors } = await openApp(page);
  await startEditing(page);
  const t = longTrack();
  const o = image.objects[t.index];
  // a diamond round the whole track
  const [x0, x1, y] = [Math.min(o.x1, o.x2) - 1, Math.max(o.x1, o.x2) + 1, o.y1];
  const xm = (x0 + x1) / 2;
  const pts = [
    [x0, y],
    [xm, y + 1],
    [x1, y],
    [xm, y - 1],
  ];
  await page.keyboard.press('l');
  const px = [];
  for (const p of pts) px.push(await clientAt(page, ...p));
  await page.mouse.move(...px[0]);
  await page.mouse.down();
  for (const p of [...px.slice(1), px[0]]) await page.mouse.move(...p, { steps: 8 });
  await page.mouse.up();
  const sel = await selection(page);
  expect(sel).toContain(t.index);

  const view = () => page.evaluate(() => ({ ...window.__pcam.app.viewer.view }));
  await page.keyboard.press('h');
  let before = await view();
  await dragMm(page, [xm, y + 5], [xm + 3, y + 5]);
  expect((await view()).cx).not.toBe(before.cx);
  expect(await selection(page)).toEqual(sel);

  await page.keyboard.press('v');
  before = await view();
  await page.keyboard.down(' ');
  await dragMm(page, [xm, y + 5], [xm + 3, y + 5]);
  await page.keyboard.up(' ');
  expect((await view()).cx).not.toBe(before.cx);
  expect(await selection(page)).toEqual(sel);
  expect(errors).toEqual([]);
});

test('track tool: Shift keeps segments to 45°', async ({ page }) => {
  const { errors } = await openApp(page);
  await startEditing(page);
  const b = image.bounds;
  const [x, y] = [b[2] + 2, b[1] + 2];
  await page.keyboard.press('t');
  const click = async (p, opts) => {
    const [cx, cy] = await clientAt(page, ...p);
    await page.mouse.click(cx, cy, opts);
  };
  await click([x, y]);
  await page.keyboard.down('Shift');
  await click([x + 3, y + 2.6]);
  await page.keyboard.up('Shift');
  await page.keyboard.press('Enter');
  const o = await page.evaluate((n) => {
    const t = window.__pcam.app.layerById(n).image.objects.at(-1);
    return { k: t.k, dx: t.x2 - t.x1, dy: t.y2 - t.y1 };
  }, FCU);
  expect(o.k).toBe('L');
  expect(o.dx).toBeCloseTo(o.dy, 6);
  expect(o.dx).toBeGreaterThan(2);
  expect(errors).toEqual([]);
});

test('right-click: select same shape, same aperture and connected', async ({ page }) => {
  const { errors } = await openApp(page);
  await startEditing(page);
  // a pad with twins, on top where it is drawn; and an object (on top) of a connected group
  const onTop = (o, i) => hitTest(image, o.x ?? o.x1, o.y ?? o.y1) === i;
  const pad = image.objects.findIndex(
    (o, i) => o.k === 'F' && o.dark && onTop(o, i) && sameShape(image, [i]).length > 1,
  );
  const net = image.objects.findIndex(
    (o, i) => o.dark && o.k !== 'R' && onTop(o, i) && connected(image, [i]).length > 1,
  );
  expect(pad).toBeGreaterThanOrEqual(0);
  expect(net).toBeGreaterThanOrEqual(0);
  const p = image.objects[pad];
  const [cx, cy] = await clientAt(page, p.x, p.y);
  const q = image.objects[net];
  const [nx, ny] = await clientAt(page, q.x ?? q.x1, q.y ?? q.y1);
  const menu = page.locator('[data-testid=context-menu]');

  await page.mouse.click(cx, cy, { button: 'right' });
  await expect(menu).toBeVisible();
  expect(await selection(page)).toEqual([pad]);
  await expect(menu.locator('[data-testid=ctx-same-aperture]')).toContainText(`D${p.ap.code}`);
  await menu.locator('[data-testid=ctx-same-shape]').click();
  await expect(menu).toBeHidden();
  expect(await selection(page)).toEqual(sameShape(image, [pad]));
  await expect(page.locator('[data-testid=status]')).toContainText('with the same shape');

  // right-click on an object outside the selection selects it first
  await page.mouse.click(nx, ny, { button: 'right' });
  expect(await selection(page)).toEqual([net]);
  await menu.locator('[data-testid=ctx-connected]').click();
  const group = connected(image, [net]);
  expect(await selection(page)).toEqual(group);

  // right-click on a selected object keeps the selection; Escape closes the menu only
  await page.mouse.click(nx, ny, { button: 'right' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  expect(await selection(page)).toEqual(group);
  await page.mouse.click(nx, ny, { button: 'right' });
  await menu.locator('[data-testid=ctx-invert]').click();
  expect((await selection(page)).length).toBe(image.objects.length - group.length);
  expect(errors).toEqual([]);
});

test('right-click outside edit mode: edit the object, or select alike, on its layer', async ({ page }) => {
  const { errors } = await openApp(page);
  await loadBoard(page);
  await page.locator(`[data-testid=layer][data-name="${FCU}"]`).click();
  const pad = image.objects.findIndex((o, i) => o.k === 'F' && o.dark && sameShape(image, [i]).length > 2);
  const p = image.objects[pad];
  const [cx, cy] = await clientAt(page, p.x, p.y);
  await page.mouse.click(cx, cy, { button: 'right' });
  const menu = page.locator('[data-testid=context-menu]');
  await expect(menu.locator('[data-testid=ctx-edit]')).toBeVisible();
  // which layer it offers depends on what is on top there; pick same shape on that layer
  const layerName = await page.evaluate(([x, y]) => window.__pcam.app.viewer.pick(x, y)?.layerId, [cx, cy]);
  await menu.locator('[data-testid=ctx-same-shape]').click();
  await expect(page.locator('[data-testid=editor]')).toBeVisible();
  expect(await page.evaluate(() => window.__pcam.app.activeLayerId)).toBe(layerName);
  expect((await selection(page)).length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('right-click outside edit mode: select connected uses the copper under a hole or legend', async ({ page }) => {
  const { errors } = await openApp(page);
  const dir = join(ROOT, 'samples/clockblock');
  await loadBoard(page, boardFiles(dir));
  const name = 'clockblock-F_Cu.gbr';
  const cu = gerber(bytes(join(dir, name))).image;
  const holes = drill(bytes(join(dir, 'clockblock.drl'))).image.objects;
  // a plated pad with a track leaving it and a hole drawn on top of it
  const pad = cu.objects.findIndex(
    (o, i) =>
      o.k === 'F' &&
      o.dark &&
      holes.some((h) => Math.hypot(h.x - o.x, h.y - o.y) < 1e-3) &&
      connected(cu, [i]).length > 2,
  );
  expect(pad).toBeGreaterThanOrEqual(0);
  const p = cu.objects[pad];
  const [cx, cy] = await clientAt(page, p.x, p.y);
  // the bug: the hole on top stood in for the pad, so "connected" found only the hole
  expect(await page.evaluate(([x, y]) => window.__pcam.app.viewer.pick(x, y)?.layerId, [cx, cy])).toBe(
    'clockblock.drl',
  );
  await page.mouse.click(cx, cy, { button: 'right' });
  await page.locator('[data-testid=context-menu] [data-testid=ctx-connected]').click();
  await expect(page.locator('[data-testid=editor]')).toBeVisible();
  expect(await page.evaluate(() => window.__pcam.app.activeLayerId)).toBe(name);
  const sel = await selection(page);
  expect(sel).toEqual(connected(cu, [hitTest(cu, p.x, p.y)]));
  expect(sel).toContain(pad);
  expect(errors).toEqual([]);
});
