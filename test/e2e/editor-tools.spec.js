// Editor tool strip: select box (dragged rightwards: inside only; leftwards: touching), lasso,
// hand, double-click to select connected, 45° tracks, and the right-click menu (same shape,
// same aperture, connected; auto select layer).

import { test, expect } from '@playwright/test';
import { openApp, loadBoard, clientAt } from './viewer-helpers.js';
import { synthGerber } from '../helpers.js';
import { objectsInPolygon, boxPolygon, sameShape, connected } from '../../src/edit/selection.js';
import { hitTest } from '../../src/model/hit-test.js';

test.use({ viewport: { width: 1400, height: 900 } });

const FCU = 'synthetic-board-F_Cu.gbr';
const image = synthGerber(`board/${FCU}`).image;

const selection = (page) => page.evaluate(() => window.__pcam.app.editor.sel);

async function startEditing(page) {
  await loadBoard(page);
  await page.locator(`[data-testid=layer][data-name="${FCU}"]`).click();
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
  for (const t of ['select', 'lasso', 'node', 'hand', 'pad', 'track', 'region'])
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

const selectedLayers = (page) => page.evaluate(() => Object.fromEntries(window.__pcam.app.editor.selected));
const opCounts = (page) =>
  page.evaluate(() => Object.fromEntries(window.__pcam.app.layers.map((l) => [l.id, l.editor?.ops.length ?? 0])));

test('pick from this layer, all layers or the soloed layers; a selection on several layers moves and undoes as one', async ({
  page,
}) => {
  const { errors } = await openApp(page);
  await startEditing(page);
  const a = [10, 20];
  const b = [36, 40];
  const touching = objectsInPolygon(image, boxPolygon(a, b), 'touch');
  // with Shift a drag from an unselected object boxes instead of moving it
  const box = async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.down('Shift');
    await dragMm(page, [b[0], a[1]], [a[0], b[1]]);
    await page.keyboard.up('Shift');
  };
  const pickFrom = page.locator('[data-testid=pick-from]');
  await expect(pickFrom).toHaveValue('layer');

  // this layer (the default): only the edited layer
  await box();
  expect(await selectedLayers(page)).toEqual({ [FCU]: touching });

  // all layers: every shown Gerber and drill layer (paste is hidden by default)
  await pickFrom.selectOption('all');
  expect(await page.evaluate(() => window.__pcam.app.project.settings.edit.pickFrom)).toBe('all');
  await box();
  let picked = await selectedLayers(page);
  const names = Object.keys(picked);
  expect(names.length).toBeGreaterThan(2);
  expect(picked[FCU]).toEqual(touching);
  expect(names).not.toContain('synthetic-board-F_Paste.gbr');
  await expect(page.locator('[data-testid=edit-selection]')).toContainText(`on ${names.length} layers`);

  // an arrow moves the selection on every layer; one undo takes it all back
  const before = await opCounts(page);

  // all or nothing: a routed slot on the drill layer cannot be moved yet, so nothing moves
  await page.keyboard.press('Escape');
  await page.keyboard.down('Shift');
  await dragMm(page, [45, 25], [38, 35]);
  await page.keyboard.up('Shift');
  expect(Object.keys(await selectedLayers(page))).toContain('synthetic-board-PTH.drl');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-testid=status]')).toHaveText(
    'synthetic-board-PTH.drl: Routed paths cannot be edited yet',
  );
  expect(await opCounts(page)).toEqual(before);
  await box();

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-testid=status]')).toContainText(`on ${names.length} layers`);
  let after = await opCounts(page);
  for (const n of names) expect(after[n]).toBe(before[n] + 1);
  expect(Object.keys(await selectedLayers(page)).sort()).toEqual([...names].sort());
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-testid=status]')).toContainText(`Undone on ${names.length} layers`);
  expect(await opCounts(page)).toEqual(before);
  await page.keyboard.press('Control+y');
  await expect(page.locator('[data-testid=status]')).toContainText(`Redone on ${names.length} layers`);
  after = await opCounts(page);
  for (const n of names) expect(after[n]).toBe(before[n] + 1);
  await page.keyboard.press('Control+z');
  expect(await opCounts(page)).toEqual(before);

  // soloed layers: just those, whichever layer is edited
  await pickFrom.selectOption('solo');
  const MASK = 'synthetic-board-F_Mask.gbr';
  const PTH = 'synthetic-board-PTH.drl';
  for (const n of [MASK, PTH]) await page.locator(`[data-testid=layer][data-name="${n}"] [data-testid=solo]`).click();
  await box();
  picked = await selectedLayers(page);
  expect(Object.keys(picked).sort()).toEqual([MASK, PTH]);
  // Escape clears the selection on every layer
  await page.keyboard.press('Escape');
  expect(await selectedLayers(page)).toEqual({});
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

test('right-click with auto select layer: an object of another layer switches to editing it', async ({ page }) => {
  const { errors } = await openApp(page);
  await loadBoard(page);
  const BCU = 'synthetic-board-B_Cu.gbr';
  await page.locator(`[data-testid=layer][data-name="${BCU}"]`).click();
  // an F.Cu pad that is the topmost object under its centre, with nothing of B.Cu there
  const pad = await page.evaluate(
    ([f, b]) => {
      const v = window.__pcam.app.viewer;
      const objs = window.__pcam.app.layerById(f).image.objects;
      for (let i = 0; i < objs.length; i++) {
        const o = objs[i];
        if (o.k !== 'F' || !o.dark || v.pickAt(o.x, o.y, null, b)) continue;
        const hit = v.pickAt(o.x, o.y, null, null);
        if (hit?.layerId === f && hit.index === i) return { index: i, x: o.x, y: o.y };
      }
      return null;
    },
    [FCU, BCU],
  );
  expect(pad).not.toBeNull();
  const [cx, cy] = await clientAt(page, pad.x, pad.y);
  await page.mouse.click(cx, cy, { button: 'right' });
  await page.locator('[data-testid=context-menu] [data-testid=ctx-same-shape]').click();
  expect(await page.evaluate(() => window.__pcam.app.activeLayerId)).toBe(FCU);
  expect(await selection(page)).toEqual(sameShape(image, [pad.index]));
  expect(errors).toEqual([]);
});

test('rubber cuts its stroke out of what it touches (one undo step); paint adds a region unified with what it touches', async ({
  page,
}) => {
  const { errors } = await openApp(page);
  await startEditing(page);
  const layerObjects = () =>
    page.evaluate(
      (n) =>
        window.__pcam.app.layerById(n).image.objects.map((o, i, all) => {
          const ob = window.__pcam.app.layerById(n).image.objBounds;
          return { k: o.k, ln: o.ln, box: [...ob.slice(i * 4, i * 4 + 4)], n: all.length };
        }),
      FCU,
    );
  const lastOp = () => page.evaluate((n) => window.__pcam.app.layerById(n).editor.ops.at(-1).type, FCU);
  const n0 = (await layerObjects()).length;

  // rubber: a stroke down across the long track's middle
  await page.keyboard.press('x');
  await expect(page.locator('[data-testid=tool-rubber]')).toHaveClass(/on/);
  await expect(page.locator('[data-testid=edit-tool]')).toHaveText('Rubber');
  await expect(page.locator('[data-testid=pick-from]')).toBeVisible();
  const brush = page.locator('[data-testid=brush-size]');
  await brush.fill('0.2');
  await brush.dispatchEvent('change');
  const t = longTrack();
  const o = image.objects[t.index];
  const xm = (o.x1 + o.x2) / 2;
  const from = [xm, o.y1 + 0.5];
  const to = [xm, o.y1 - 0.5];
  const [ax, ay] = await clientAt(page, ...from);
  const [bx, by] = await clientAt(page, ...to);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(bx, by, { steps: 6 });
  const marked = await page.evaluate(() =>
    Object.fromEntries([...window.__pcam.app.editor.drag.hits].map(([id, s]) => [id, [...s]])),
  );
  expect(marked[FCU]).toEqual([t.index]);
  await page.mouse.up();
  // the track is cut in two: two regions from its line, either side of the stroke
  const after = await layerObjects();
  expect(after.length).toBe(n0 + 1);
  expect(await lastOp()).toBe('cutOut');
  const halves = after.filter((x) => x.ln === o.ln && x.k === 'R');
  expect(halves.length).toBe(2);
  const [left, right] = halves.sort((p, q) => p.box[0] - q.box[0]);
  expect(left.box[2]).toBeLessThan(xm);
  expect(right.box[0]).toBeGreaterThan(xm);
  await page.keyboard.press('Control+z');
  expect((await layerObjects()).length).toBe(n0);

  // paint: a stroke off the board becomes one region
  await page.keyboard.press('b');
  await expect(page.locator('[data-testid=tool-paint]')).toHaveClass(/on/);
  await brush.fill('1');
  await brush.dispatchEvent('change');
  const b = image.bounds;
  await dragMm(page, [b[2] + 2, b[1] + 2], [b[2] + 4, b[1] + 3]);
  const painted = await layerObjects();
  expect(painted.length).toBe(n0 + 1);
  expect(painted.at(-1).k).toBe('R');
  expect(await lastOp()).toBe('paint');
  const area = await page.evaluate((n) => {
    const ob = window.__pcam.app.layerById(n).image.objBounds;
    const i = ob.length / 4 - 1;
    return [ob[i * 4 + 2] - ob[i * 4], ob[i * 4 + 3] - ob[i * 4 + 1]];
  }, FCU);
  // about the 2 × 1 mm stroke plus the 1 mm brush
  expect(area[0]).toBeGreaterThan(2.5);
  expect(area[1]).toBeGreaterThan(1.5);
  expect(await page.evaluate(() => window.__pcam.app.project.settings.edit.brushMm)).toBe(1);
  expect(await selection(page)).toEqual([]);

  // paint over the long track's end: the track and the stroke become one region
  await brush.fill('0.4');
  await brush.dispatchEvent('change');
  const [x2, y2] = [Math.max(o.x1, o.x2), o.y1];
  const before = (await layerObjects()).length;
  await dragMm(page, [x2 - 0.2, y2], [x2 + 1.5, y2 + 1]);
  const merged = await layerObjects();
  expect(await lastOp()).toBe('paint');
  expect(merged.length).toBeLessThanOrEqual(before);
  expect(merged.some((x) => x.k === 'L' && x.ln === o.ln)).toBe(false);
  const blob = merged.at(-1);
  expect(blob.k).toBe('R');
  expect(blob.box[0]).toBeLessThanOrEqual(Math.min(o.x1, o.x2));
  expect(blob.box[2]).toBeGreaterThan(x2 + 1.5);
  expect(errors).toEqual([]);
});

test('drill layer: the rubber deletes holes, there is no paint', async ({ page }) => {
  const { errors } = await openApp(page);
  await loadBoard(page);
  const drl = await page.evaluate(() => window.__pcam.app.layers.find((l) => l.kind === 'excellon').name);
  await page.locator(`[data-testid=layer][data-name="${drl}"]`).click();
  await expect(page.locator('[data-testid=tool-paint]')).toHaveCount(0);
  await page.locator('[data-testid=tool-rubber]').click();
  const hole = await page.evaluate((n) => {
    const v = window.__pcam.app.viewer;
    const objs = window.__pcam.app.layerById(n).image.objects;
    const i = objs.findIndex((o, k) => o.k === 'F' && v.pickAt(o.x, o.y)?.index === k);
    return { n: objs.length, x: objs[i].x, y: objs[i].y };
  }, drl);
  const [cx, cy] = await clientAt(page, hole.x, hole.y);
  await page.mouse.click(cx, cy);
  const n = await page.evaluate((l) => window.__pcam.app.layerById(l).image.objects.length, drl);
  expect(n).toBeLessThan(hole.n);
  expect(errors).toEqual([]);
});
