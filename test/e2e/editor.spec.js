// Editor (milestone 4): select, move, delete and add objects; undo/redo; regions; edits saved
// in the .pcam and exported as files that parse to the edited layer.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, loadBoard, clientAt, waitRendered } from './viewer-helpers.js';
import { clickMenu } from './helpers.js';
import { loadProject } from '../../src/project/pcam.js';
import { SCHEMA_VERSION } from '../../src/project/schema.js';
import { parseGerber } from '../../src/parse/gerber.js';
import { interpretGerber } from '../../src/model/gerber-image.js';

test.use({ viewport: { width: 1400, height: 900 } });

const FCU = 'synthetic-board-F_Cu.gbr';

async function selectLayer(page, name) {
  await page.locator(`[data-testid=layer][data-name="${name}"]`).click();
}

/** Objects of a layer as plain data: kind and position. */
const objects = (page, name = FCU) =>
  page.evaluate(
    (n) =>
      window.__pcam.app.layerById(n).image.objects.map((o) => ({
        k: o.k,
        x: o.x ?? o.x1 ?? o.contours[0][0],
        y: o.y ?? o.y1 ?? o.contours[0][1],
        code: o.ap?.code ?? null,
      })),
    name,
  );

/** A flash with nothing else within 1 mm (safe to click at any zoom). */
async function lonePad(page, name = FCU) {
  return page.evaluate((n) => {
    const img = window.__pcam.app.layerById(n).image;
    const ob = img.objBounds;
    for (let i = 0; i < img.objects.length; i++) {
      const o = img.objects[i];
      if (o.k !== 'F' || !o.dark) continue;
      let alone = true;
      for (let j = 0; j < img.objects.length && alone; j++) {
        if (j === i) continue;
        const m = 1;
        if (
          ob[j * 4] <= ob[i * 4 + 2] + m &&
          ob[j * 4 + 2] >= ob[i * 4] - m &&
          ob[j * 4 + 1] <= ob[i * 4 + 3] + m &&
          ob[j * 4 + 3] >= ob[i * 4 + 1] - m
        )
          alone = false;
      }
      if (alone) return { index: i, x: o.x, y: o.y };
    }
    return null;
  }, name);
}

async function clickMm(page, x, y, opts) {
  const [cx, cy] = await clientAt(page, x, y);
  await page.mouse.click(cx, cy, opts);
}

async function startEditing(page) {
  await loadBoard(page);
  await selectLayer(page, FCU);
  await expect(page.locator('[data-testid=editor]')).toBeVisible();
}

test('select a pad, delete it, undo and redo', async ({ page }) => {
  const { external, errors } = await openApp(page);
  await startEditing(page);
  const before = await objects(page);
  const pad = await lonePad(page);
  await clickMm(page, pad.x, pad.y);
  await expect(page.locator('[data-testid=edit-selection]')).toHaveText('1 selected');
  await expect(page.locator('[data-testid=inspector]')).toContainText('Flash (D03)');
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await objects(page)).length).toBe(before.length - 1);
  await expect(page.locator(`[data-testid=layer][data-name="${FCU}"] [data-testid=edited]`)).toHaveText('✎1');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => objects(page)).toEqual(before);
  await clickMenu(page, '[data-testid=edit-redo]');
  await expect.poll(async () => (await objects(page)).length).toBe(before.length - 1);
  // the editor is always on: no Edit switch in the View menu, and E does not leave it
  await expect(page.locator('[data-testid=edit-toggle]')).toHaveCount(0);
  await page.keyboard.press('e');
  await expect(page.locator('[data-testid=editor]')).toBeVisible();
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('a locked layer is shown but not picked or edited; the lock is saved in the project', async ({ page }) => {
  const { errors } = await openApp(page);
  await startEditing(page);
  const before = await objects(page);
  const pad = await lonePad(page);
  await clickMm(page, pad.x, pad.y);
  await expect(page.locator('[data-testid=edit-selection]')).toHaveText('1 selected');
  const lock = page.locator(`[data-testid=layer][data-name="${FCU}"] [data-testid=lock]`);
  await expect(lock).toHaveAttribute('aria-pressed', 'false');
  await lock.click();
  await expect(lock).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-testid=edit-locked]')).toHaveText(`${FCU} is locked`);
  // locking drops the selection; Delete and clicks on the board do nothing
  await page.keyboard.press('Delete');
  await clickMm(page, pad.x, pad.y);
  await page.keyboard.press('Delete');
  expect(await objects(page)).toEqual(before);
  const saved = await page.evaluate((n) => window.__pcam.state().project.settings.layers[n].locked, FCU);
  expect(saved).toBe(true);
  // unlocked, it edits again
  await lock.click();
  await clickMm(page, pad.x, pad.y);
  await expect(page.locator('[data-testid=edit-selection]')).toHaveText('1 selected');
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await objects(page)).length).toBe(before.length - 1);
  expect(errors).toEqual([]);
});

test('tool options sit in the top bar past the divider over the layer panel; Edit menu reverts one layer or all', async ({
  page,
}) => {
  const { errors } = await openApp(page);
  await startEditing(page);
  const options = page.locator('header.toolbar [data-testid=editor]');
  await expect(options).toBeVisible();
  await expect(page.locator('aside.panel [data-testid=editor]')).toHaveCount(0);
  const bar = await page.locator('header.toolbar').boundingBox();
  const menus = await page.locator('header.toolbar .menubar').boundingBox();
  const box = await options.boundingBox();
  expect(box.x).toBeGreaterThan(menus.x + menus.width);
  expect(box.x + box.width).toBeGreaterThan(bar.x + bar.width - 20);
  // the bar's divider carries on the layer panel's right edge
  const panel = await page.locator('aside.panel.left').boundingBox();
  const divider = await page.locator('header.toolbar .toolbar-menus').boundingBox();
  expect(divider.x + divider.width).toBe(panel.x + panel.width);
  expect(box.x).toBeGreaterThan(panel.x + panel.width);
  expect(box.x).toBeLessThan(panel.x + panel.width + 20);
  // general actions live in the menus, not on the bar
  for (const id of ['edit-undo', 'edit-redo', 'edit-unify', 'edit-revert', 'edit-revert-all']) {
    await expect(page.locator(`[data-testid=menu-edit-panel] [data-testid=${id}]`)).toHaveCount(1);
  }
  await expect(page.locator('[data-testid=menu-file-panel] [data-testid=edit-export]')).toHaveCount(1);
  for (const id of ['edit-delete', 'edit-move', 'move-dx'])
    await expect(page.locator(`[data-testid=${id}]`)).toHaveCount(0);

  const fcu0 = await objects(page);
  let pad = await lonePad(page);
  await clickMm(page, pad.x, pad.y);
  await page.keyboard.press('Delete');
  const other = await page.evaluate(
    (n) => window.__pcam.app.layers.find((l) => l.kind === 'gerber' && l.name !== n && l.role?.type === 'copper').name,
    FCU,
  );
  await selectLayer(page, other);
  const other0 = await objects(page, other);
  pad = await lonePad(page, other);
  await clickMm(page, pad.x, pad.y);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await objects(page, other)).length).toBe(other0.length - 1);

  // revert the current layer only
  page.once('dialog', (d) => d.accept());
  await clickMenu(page, '[data-testid=edit-revert]');
  await expect.poll(async () => objects(page, other)).toEqual(other0);
  expect((await objects(page)).length).toBe(fcu0.length - 1);
  await page.locator('[data-testid=menu-edit]').click();
  await expect(page.locator('[data-testid=edit-revert]')).toBeDisabled();
  await page.keyboard.press('Escape');

  // revert every layer
  page.once('dialog', (d) => d.accept());
  await clickMenu(page, '[data-testid=edit-revert-all]');
  await expect.poll(async () => objects(page)).toEqual(fcu0);
  await page.locator('[data-testid=menu-edit]').click();
  await expect(page.locator('[data-testid=edit-revert-all]')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('drag a pad to move it on the grid; arrows nudge; move by numbers', async ({ page }) => {
  const { errors } = await openApp(page);
  await startEditing(page);
  const pad = await lonePad(page);
  const [cx, cy] = await clientAt(page, pad.x, pad.y);
  const [tx, ty] = await clientAt(page, pad.x + 1.02, pad.y - 0.49);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move((cx + tx) / 2, (cy + ty) / 2, { steps: 4 });
  await page.mouse.move(tx, ty, { steps: 4 });
  await page.mouse.up();
  let o = (await objects(page))[pad.index];
  // grid 0.05 mm
  expect(o.x).toBeCloseTo(pad.x + 1.0, 6);
  expect(o.y).toBeCloseTo(pad.y - 0.5, 6);
  await expect(page.locator('[data-testid=edit-selection]')).toHaveText('1 selected');
  await page.keyboard.press('ArrowRight');
  o = (await objects(page))[pad.index];
  expect(o.x).toBeCloseTo(pad.x + 1.05, 6);
  // right-click › Move by… asks for X, Y
  page.once('dialog', (d) => d.accept('-1.05, 0.5'));
  await clickMm(page, pad.x + 1.05, pad.y - 0.5, { button: 'right' });
  await page.locator('[data-testid=ctx-move]').click();
  await expect.poll(async () => (await objects(page))[pad.index].y).toBeCloseTo(pad.y, 6);
  o = (await objects(page))[pad.index];
  expect(o.x).toBeCloseTo(pad.x, 6);
  expect(o.y).toBeCloseTo(pad.y, 6);
  expect(errors).toEqual([]);
});

test('add a pad, a track and a region; turn the pad into a region', async ({ page }) => {
  const { errors } = await openApp(page);
  await startEditing(page);
  const n0 = (await objects(page)).length;
  const b = await page.evaluate((n) => window.__pcam.app.layerById(n).image.bounds, FCU);
  const x = b[2] + 2;
  const y = b[1] + 1;
  await page.locator('[data-testid=tool-pad]').click();
  await page.locator('[data-testid=edit-aperture]').selectOption('new');
  await page.locator('[data-testid=edit-size-w]').fill('1.2');
  await page.locator('[data-testid=edit-size-w]').dispatchEvent('change');
  await clickMm(page, x, y);
  let objs = await objects(page);
  expect(objs.length).toBe(n0 + 1);
  expect(objs[n0]).toMatchObject({ k: 'F' });
  expect(objs[n0].x).toBeCloseTo(x, 6);
  const pad = await page.evaluate((n) => {
    const l = window.__pcam.app.layerById(n);
    return l.image.objects[l.image.objects.length - 1].ap.dia;
  }, FCU);
  expect(pad).toBeCloseTo(1.2, 9);

  await page.locator('[data-testid=tool-track]').click();
  await clickMm(page, x, y + 3);
  await clickMm(page, x + 3, y + 3);
  await clickMm(page, x + 3, y + 5);
  await page.keyboard.press('Enter');
  objs = await objects(page);
  expect(objs.slice(n0 + 1).map((o) => o.k)).toEqual(['L', 'L']);

  await page.locator('[data-testid=tool-region]').click();
  await clickMm(page, x, y + 7);
  await clickMm(page, x + 2, y + 7);
  await clickMm(page, x + 2, y + 9);
  await clickMm(page, x, y + 7); // back on the first point closes it
  objs = await objects(page);
  expect(objs.at(-1).k).toBe('R');

  await page.locator('[data-testid=tool-select]').click();
  await clickMm(page, x, y);
  await clickMenu(page, '[data-testid=edit-to-region]');
  // the region takes the pad's place in the drawing order
  await expect.poll(async () => (await objects(page))[n0].k).toBe('R');
  const area = await page.evaluate(
    ([n, i]) => {
      const l = window.__pcam.app.layerById(n);
      const c = l.image.objects[i].contours[0];
      let a = 0;
      for (let i = 0, j = c.length - 2; i < c.length; j = i, i += 2) a += c[j] * c[i + 1] - c[i] * c[j + 1];
      return a / 2;
    },
    [FCU, n0],
  );
  expect(area).toBeCloseTo(Math.PI * 0.36, 2);
  expect(errors).toEqual([]);
});

test('unify the layer into regions; edits survive save and reopen; export parses back', async ({ page }, testInfo) => {
  const { errors } = await openApp(page);
  await startEditing(page);
  const pad = await lonePad(page);
  await clickMm(page, pad.x, pad.y);
  await page.keyboard.press('Delete');
  await clickMenu(page, '[data-testid=edit-unify]');
  await expect(page.locator('[data-testid=status]')).toContainText('unified into');
  const unified = await objects(page);
  expect(unified.every((o) => o.k === 'R')).toBe(true);

  const exported = page.waitForEvent('download');
  await clickMenu(page, '[data-testid=edit-export]');
  const dl = await exported;
  expect(dl.suggestedFilename()).toBe(FCU);
  const gbrPath = testInfo.outputPath(FCU);
  await dl.saveAs(gbrPath);
  const parsed = parseGerber(readFileSync(gbrPath));
  expect(parsed.diagnostics.errors).toEqual([]);
  expect(interpretGerber(parsed).objects.length).toBe(unified.length);

  const saving = page.waitForEvent('download');
  await clickMenu(page, '[data-testid=save]');
  const pcamPath = testInfo.outputPath('edited.pcam');
  await (await saving).saveAs(pcamPath);
  const project = loadProject(new Uint8Array(readFileSync(pcamPath)));
  expect(project.manifest.schemaVersion).toBe(SCHEMA_VERSION);
  expect(project.edits[FCU].ops.map((o) => o.type)).toEqual(['delete', 'unifyLayer']);

  await clickMenu(page, '#new');
  page.once('dialog', (d) => d.accept());
  await page.locator('#open-input').setInputFiles(pcamPath);
  await expect(page.locator(`[data-testid=layer][data-name="${FCU}"] [data-testid=edited]`)).toHaveText('✎2');
  await waitRendered(page);
  expect((await objects(page)).length).toBe(unified.length);
  // the editor is still on and undo goes back through the replayed edits
  await expect(page.locator('[data-testid=editor]')).toBeVisible();
  await selectLayer(page, FCU);
  await clickMenu(page, '[data-testid=edit-undo]');
  await expect.poll(async () => (await objects(page)).some((o) => o.k === 'F')).toBe(true);
  expect(errors).toEqual([]);
});

test('drill layer: add a hole with a new tool, shift+drag box selects holes', async ({ page }) => {
  const { errors } = await openApp(page);
  await loadBoard(page);
  const drl = await page.evaluate(() => window.__pcam.app.layers.find((l) => l.kind === 'excellon').name);
  await selectLayer(page, drl);
  await expect(page.locator('[data-testid=tool-track]')).toHaveCount(0);
  const n0 = (await objects(page, drl)).length;
  await page.locator('[data-testid=tool-pad]').click();
  await page.locator('[data-testid=hole-dia]').fill('2.2');
  await page.locator('[data-testid=hole-dia]').dispatchEvent('change');
  const b = await page.evaluate((n) => window.__pcam.app.layerById(n).image.bounds, drl);
  await clickMm(page, b[2] + 3, b[3]);
  const objs = await objects(page, drl);
  expect(objs.length).toBe(n0 + 1);
  const dia = await page.evaluate((n) => window.__pcam.app.layerById(n).image.objects.at(-1).ap.dia, drl);
  expect(dia).toBeCloseTo(2.2, 6);

  await page.locator('[data-testid=tool-select]').click();
  await page.keyboard.press('Escape'); // the new hole was selected
  const [ax, ay] = await clientAt(page, b[0] - 1, b[3] + 1);
  const [bx, by] = await clientAt(page, b[2] + 1, b[1] - 1);
  await page.keyboard.down('Shift');
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(bx, by, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(page.locator('[data-testid=edit-selection]')).toHaveText(`${n0} selected`);
  expect(errors).toEqual([]);
});

/** An F.Cu flash that is the topmost object under its centre (no silkscreen or hole on it). */
const topPad = (page) =>
  page.evaluate((n) => {
    const v = window.__pcam.app.viewer;
    const objs = window.__pcam.app.layerById(n).image.objects;
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      if (o.k !== 'F' || !o.dark) continue;
      const hit = v.pickAt(o.x, o.y, null, null);
      if (hit?.layerId === n && hit.index === i) return { index: i, x: o.x, y: o.y };
    }
    return null;
  }, FCU);

test('auto select layer: a select tool option; clicking a shape edits its layer, switched off the layer stays', async ({
  page,
}) => {
  const { errors } = await openApp(page);
  await loadBoard(page);
  const BCU = 'synthetic-board-B_Cu.gbr';
  const active = () => page.locator('[data-testid=layer].active');
  const toggle = page.locator('header.toolbar [data-testid=editor] [data-testid=auto-select-layer]');
  const pad = await topPad(page);
  expect(pad).not.toBeNull();
  // on by default, in the select tool's options in the top bar (not the layer panel)
  await selectLayer(page, BCU);
  await expect(toggle).toBeChecked();
  await expect(page.locator('aside.panel [data-testid=auto-select-layer]')).toHaveCount(0);
  // a click on an F.Cu pad switches the edited layer and selects the shape there
  await clickMm(page, pad.x, pad.y);
  await expect(active()).toHaveAttribute('data-name', FCU);
  await expect(page.locator('[data-testid=edit-selection]')).toHaveText('1 selected');
  await expect(page.locator('[data-testid=inspector]')).toContainText('Flash (D03)');
  // only the tools that pick by clicking show it
  await page.locator('[data-testid=tool-pad]').click();
  await expect(toggle).toHaveCount(0);
  await page.locator('[data-testid=tool-select]').click();
  // off: only the edited layer can be picked
  await toggle.uncheck();
  await selectLayer(page, BCU);
  await clickMm(page, pad.x, pad.y);
  await expect(active()).toHaveAttribute('data-name', BCU);
  await expect(page.locator('[data-testid=edit-selection]')).not.toHaveText('1 selected');
  expect(await page.evaluate(() => window.__pcam.app.project.settings.view.autoSelectLayer)).toBe(false);
  expect(errors).toEqual([]);
});
