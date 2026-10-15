// Golden-file assertions. `npm run golden:update` sets UPDATE_GOLDEN=1 to rewrite them;
// review the diff and say why in the commit message (AGENTS.md → Testing).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '../golden');

/** Compare `actual` (string) with test/golden/<name>, or rewrite it when UPDATE_GOLDEN=1. */
export function assertGolden(name, actual) {
  const path = join(GOLDEN_DIR, name);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  let expected;
  try {
    expected = readFileSync(path, 'utf8');
  } catch {
    assert.fail(`Golden file test/golden/${name} is missing: run npm run golden:update and review it`);
  }
  assert.equal(actual, expected, `Output differs from test/golden/${name} (npm run golden:update to accept)`);
}
