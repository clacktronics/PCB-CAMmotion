import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  openApp,
  loadBoard,
  pixelAt,
  clientAt,
  waitRendered,
  boardFiles,
  viewFromSide,
  ROOT,
} from './viewer-helpers.js';

test.use({ viewport: { width: 1400, height: 850 } });
import { MISC, FINISH } from '../../src/model/materials.js';

test('opens from file:// with no network requests and no errors', async ({ page }) => {
  const { external, errors } = await openApp(page);
  await expect(page.getByText('Drop Gerber, Excellon')).toBeVisible();
  await loadBoard(page);
  await page.locator('[data-testid=mode-debug]').click();
  await viewFromSide(page, 'bottom');
  await waitRendered(page);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('loads the synthetic board and identifies every layer', async ({ page }) => {
  await openApp(page);
  await loadBoard(page);
  const rows = page.locator('[data-testid=layer]');
  await expect(rows).toHaveCount(10);
  const roles = await rows.evaluateAll((els) => els.map((e) => `${e.dataset.name}=${e.dataset.role}`));
  expect(roles).toContain('synthetic-board-F_Cu.gbr=copper:top');
  expect(roles).toContain('synthetic-board-B_Mask.gbr=soldermask:bottom');
  expect(roles).toContain('synthetic-board-Edge_Cuts.gbr=profile:all');
  expect(roles).toContain('synthetic-board-NPTH.drl=drill:all');
  await expect(page.locator('[data-testid=status]')).toContainText('Loaded 11 files');
  await expect(page.locator('[data-testid=stack-finish]')).toHaveValue('enig');
});

test('realistic view: holes see-through, mask green, exposed pads in the ENIG finish', async ({ page }) => {
  await openApp(page);
  await loadBoard(page);
  const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  // mounting hole (NPTH ⌀3.2 at 4,4) shows the background
  expect(near(await pixelAt(page, 4, 4), MISC.background.rgb)).toBe(true);
  // outside the board outline (rounded corner) is background too
  expect(near(await pixelAt(page, 0.3, 0.3), MISC.background.rgb)).toBe(true);
  // bare board under the mask is green
  const [r, g, b] = await pixelAt(page, 60, 10);
  expect(g).toBeGreaterThan(r + 20);
  expect(g).toBeGreaterThan(b + 20);
  // 0805 pad at (30,40) is exposed ENIG (gold: red well above blue)
  const pad = await pixelAt(page, 30, 40.3);
  expect(pad[0]).toBeGreaterThan(pad[2] + 60);
  expect(Math.abs(pad[0] - FINISH.enig.rgb[0])).toBeLessThan(60);
});

test('debug colours and bottom view change the picture', async ({ page }) => {
  await openApp(page);
  await loadBoard(page);
  const before = await pixelAt(page, 30, 40.3);
  await page.locator('[data-testid=mode-debug]').click();
  await waitRendered(page);
  const debug = await pixelAt(page, 30, 40.3);
  expect(debug).not.toEqual(before);
  await viewFromSide(page, 'bottom');
  await waitRendered(page);
  const state = await page.evaluate(() => window.__pcam.state());
  expect(state.view.side).toBe('bottom');
  // the bottom pour (5..95 x 5..12) is in front when viewed from below
  const bottomPour = await pixelAt(page, 30, 8);
  expect(bottomPour[2]).toBeGreaterThan(bottomPour[0]); // bottom copper debug colour is blue
});

test('clicking a hole and a trace shows aperture/tool and the source line', async ({ page }) => {
  await openApp(page);
  await loadBoard(page);
  let [x, y] = await clientAt(page, 8, 20);
  await page.mouse.click(x, y);
  const insp = page.locator('[data-testid=inspector]');
  await expect(insp).toContainText('synthetic-board-PTH.drl');
  await expect(insp).toContainText('T1');
  await expect(page.locator('[data-testid=source-line]')).toContainText('X8.000Y20.000');
  [x, y] = await clientAt(page, 15, 74);
  await page.mouse.click(x, y);
  await expect(insp).toContainText('synthetic-board-F_Cu.gbr');
  await expect(insp).toContainText('D10');
  await expect(page.locator('[data-testid=source-line]')).toContainText('D01*');
  const sel = await page.evaluate(() => window.__pcam.state().selection);
  expect(sel.line).toBeGreaterThan(1);
});

test('zoom with the wheel and pan by dragging', async ({ page }) => {
  await openApp(page);
  await loadBoard(page);
  const v0 = (await page.evaluate(() => window.__pcam.state())).view;
  const box = await page.locator('[data-testid=board]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(200);
  const v1 = (await page.evaluate(() => window.__pcam.state())).view;
  expect(v1.scale).toBeGreaterThan(v0.scale * 1.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 50, { steps: 5 });
  await page.mouse.up();
  const v2 = (await page.evaluate(() => window.__pcam.state())).view;
  expect(v2.cx).toBeLessThan(v1.cx);
  expect(v2.cy).toBeGreaterThan(v1.cy);
  await page.locator('[data-testid=fit]').click();
  const v3 = (await page.evaluate(() => window.__pcam.state())).view;
  expect(Math.abs(v3.scale - v0.scale)).toBeLessThan(1e-6);
});

test('drag and drop of files loads them', async ({ page }) => {
  await openApp(page);
  const files = boardFiles().map((p) => ({ name: p.split('/').pop(), b64: readFileSync(p).toString('base64') }));
  await page.evaluate((files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name));
    const main = document.querySelector('main');
    main.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    main.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  }, files);
  await expect(page.locator('[data-testid=layer]')).toHaveCount(10);
});

test('save a .pcam, reopen it in a fresh page: same layers, settings and view', async ({ page, browser }) => {
  await openApp(page);
  await loadBoard(page);
  await page.locator('[data-testid=mode-debug]').click();
  await viewFromSide(page, 'bottom');
  await page.locator('[data-testid=layer] [data-testid=solo]').first().click();
  await page.locator('[data-testid=stack-mask-top-]').selectOption('red');
  const before = await page.evaluate(() => window.__pcam.state());
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-testid=save]').click()]);
  expect(download.suggestedFilename()).toBe('synthetic-board.pcam');
  const path = test.info().outputPath('saved.pcam');
  await download.saveAs(path);

  const page2 = await browser.newPage();
  await openApp(page2);
  await page2.locator('[data-testid=pcam-input]').setInputFiles(path);
  await expect(page2.locator('[data-testid=layer]')).toHaveCount(10);
  const after = await page2.evaluate(() => window.__pcam.state());
  expect(after.project.settings.view.mode).toBe('debug');
  expect(after.project.settings.view.side).toBe('bottom');
  expect(after.project.stackup.mask.top).toBe('red');
  expect(after.layers.map((l) => [l.name, l.role])).toEqual(before.layers.map((l) => [l.name, l.role]));
  expect(after.project.settings.layers).toEqual(before.project.settings.layers);
  await expect(page2.locator('[data-testid=layer] [data-testid=solo]').first()).toHaveAttribute('aria-pressed', 'true');
  expect(after.project.settings.view.solo).toEqual(before.project.settings.view.solo);
  await page2.close();
});

test('autosave offers to recover the project after a reload', async ({ page }) => {
  await openApp(page);
  await loadBoard(page);
  await page.waitForTimeout(2200);
  await page.reload();
  const recover = page.getByRole('button', { name: 'Recover' });
  await expect(recover).toBeVisible();
  await recover.click();
  await expect(page.locator('[data-testid=layer]')).toHaveCount(10);
});

test('a real-world Eagle board loads without errors', async ({ page }) => {
  await openApp(page);
  await loadBoard(page, boardFiles(join(ROOT, 'samples/arduino-uno')));
  const state = await page.evaluate(() => window.__pcam.state());
  expect(state.layers).toHaveLength(7);
  expect(state.layers.every((l) => l.errors === 0)).toBe(true);
});
