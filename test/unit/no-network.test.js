// Local only (AGENTS.md): the shipped files must not reference anything on the network.
// The e2e tests check behaviour; this catches URLs before they ever load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shipped = [
  'index.html',
  'dist/app.js',
  ...readdirSync(join(root, 'src/ui'))
    .filter((f) => f.endsWith('.css'))
    .map((f) => `src/ui/${f}`),
];

test('shipped files contain no network URLs', () => {
  for (const file of shipped) {
    const text = readFileSync(join(root, file), 'utf8');
    const urls = text.match(/\b(?:https?|wss?|ftp):\/\/[^\s'"`)<>]+/gi) ?? [];
    assert.deepEqual(urls, [], `${file} references the network`);
    assert.doesNotMatch(text, /@import\s+url\(|src=["']\/\//, `${file} loads a remote resource`);
  }
});

test('index.html loads only local scripts and styles', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert.ok(!/^[a-z]+:|^\/\//i.test(ref), `non-local reference ${ref}`);
  }
});
