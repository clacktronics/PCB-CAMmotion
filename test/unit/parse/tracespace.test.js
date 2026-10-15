// tracespace's spec-feature fixtures (MIT, test/fixtures/tracespace): every file must load
// without errors, except the one that is genuinely invalid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, bytes } from '../../helpers.js';
import { loadFile } from '../../../src/model/load-file.js';

const ROOT = join(FIXTURES, 'tracespace');
// region-with-lines.gbr: its contour starts at X200 but ends at X2000 — not closed (spec 4.10.3)
const KNOWN_INVALID = { 'regions/region-with-lines.gbr': 'CONTOUR_NOT_CLOSED' };

for (const dir of readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  for (const f of readdirSync(join(ROOT, dir.name))) {
    const rel = `${dir.name}/${f}`;
    test(rel, () => {
      const r = loadFile(f, bytes(join(ROOT, rel)));
      assert.ok(r.kind === 'gerber' || r.kind === 'excellon', `kind ${r.kind}`);
      const errs = r.diagnostics.errors.map((e) => e.code);
      if (KNOWN_INVALID[rel]) assert.deepEqual(errs, [KNOWN_INVALID[rel]]);
      else assert.deepEqual(errs, [], r.diagnostics.errors.map((e) => e.message).join('\n'));
      assert.ok(r.image.objects.length > 0, 'draws something');
    });
  }
}
