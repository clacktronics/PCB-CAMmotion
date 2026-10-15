// Milestone 0 flow, both from a static server and from file://:
// app loads, files can be dropped, an empty .pcam saves and reloads, no network is used.
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadProject } from '../../src/project/pcam.js';
import { MODES, TEST_BOARD, appUrl, dropFiles, failOnErrors, guardNetwork, openApp } from './helpers.js';

const BOARD_FILES = [
  'cammotion-test-board-F_Cu.gbr',
  'cammotion-test-board-PTH.drl',
  'cammotion-test-board-job.gbrjob',
];

async function saveDownload(page, testInfo, name) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#save').click()]);
  const path = testInfo.outputPath(name);
  await download.saveAs(path);
  return { path, suggested: download.suggestedFilename(), bytes: new Uint8Array(readFileSync(path)) };
}

for (const mode of MODES) {
  test.describe(`served over ${mode.name}`, () => {
    let external;
    let errors;

    test.beforeEach(async ({ page, baseURL }) => {
      const url = appUrl(mode, baseURL);
      external = await guardNetwork(page, url);
      errors = failOnErrors(page);
      await openApp(page, url);
    });

    test.afterEach(() => {
      expect(external, 'the app must never make network requests').toEqual([]);
      expect(errors, 'console errors').toEqual([]);
    });

    test('loads with an empty project', async ({ page }) => {
      await expect(page.locator('#empty')).toBeVisible();
      await expect(page.locator('#project-name')).toHaveValue('untitled');
      await expect(page.locator('#project-info')).toContainText('schema 1');
    });

    test('empty .pcam saves and reloads', async ({ page }, testInfo) => {
      await page.locator('#project-name').fill('empty board');
      const saved = await saveDownload(page, testInfo, 'empty.pcam');
      expect(saved.suggested).toBe('empty board.pcam');
      const project = loadProject(saved.bytes);
      expect(project.manifest.name).toBe('empty board');
      expect(project.sources).toEqual([]);

      await page.locator('#new').click();
      await expect(page.locator('#project-name')).toHaveValue('untitled');
      await page.locator('#open-input').setInputFiles(saved.path);
      await expect(page.locator('#project-name')).toHaveValue('empty board');
      await expect(page.locator('#status')).toContainText('Opened');
    });

    test('dropped files are stored byte-for-byte in the saved .pcam', async ({ page }, testInfo) => {
      await dropFiles(
        page,
        BOARD_FILES.map((f) => TEST_BOARD + f),
      );
      await expect(page.locator('#sources tr')).toHaveCount(BOARD_FILES.length);
      await expect(page.locator('#sources')).toContainText('cammotion-test-board-F_Cu.gbr');

      const saved = await saveDownload(page, testInfo, 'board.pcam');
      const project = loadProject(saved.bytes);
      expect(project.sources.map((s) => s.name).sort()).toEqual([...BOARD_FILES].sort());
      for (const s of project.sources)
        expect(Buffer.from(s.bytes).equals(readFileSync(TEST_BOARD + s.name))).toBe(true);

      // Dropping a .pcam opens it.
      page.on('dialog', (d) => d.accept());
      await page.locator('#new').click();
      await expect(page.locator('#sources tr')).toHaveCount(0);
      await dropFiles(page, [saved.path]);
      await expect(page.locator('#sources tr')).toHaveCount(BOARD_FILES.length);
    });

    test('a broken .pcam gives a clear error and keeps the current project', async ({ page }, testInfo) => {
      const bad = testInfo.outputPath('broken.PCAM');
      writeFileSync(bad, 'this is not a zip');
      await dropFiles(page, [bad]);
      await expect(page.getByRole('alert')).toContainText('not a ZIP file');
      await expect(page.locator('#project-name')).toHaveValue('untitled');
    });
  });
}
