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

// Text that looks like a URL but is never fetched, in the vendored three.js (dist/app.js):
// the XHTML namespace name passed to createElementNS, and a paper cited in a GLSL comment.
const NOT_FETCHED = new Set(['http://www.w3.org/1999/xhtml', 'https://jcgt.org/published/0007/04/01/']);

test('shipped files contain no network URLs', () => {
  for (const file of shipped) {
    const text = readFileSync(join(root, file), 'utf8');
    const urls = (text.match(/\b(?:https?|wss?|ftp):\/\/[^\s'"`)<>]+/gi) ?? []).filter((u) => !NOT_FETCHED.has(u));
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
