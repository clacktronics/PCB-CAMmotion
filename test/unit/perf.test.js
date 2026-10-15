// Performance budgets for parsing (Node). Generous enough for CI machines, tight enough to
// catch accidental quadratic behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SYNTH, bytes } from '../helpers.js';
import { loadFile } from '../../src/model/load-file.js';
import { apertureTable, imageStats } from '../../src/analyze/apertures.js';

const budget = (name, path, kind, ms) =>
  test(`${name} loads in < ${ms / 1000} s`, () => {
    const b = bytes(join(SYNTH, path));
    const t0 = performance.now();
    const r = loadFile(path, b, { kind });
    const took = performance.now() - t0;
    assert.equal(r.diagnostics.errors.length, 0);
    assert.ok(took < ms, `${took.toFixed(0)} ms`);
  });

budget('30 MB Gerber, 1.3 M draws', 'gerber-large/large-dense-traces-30MB.gbr', 'gerber', 15000);
budget('300 k drill hits', 'drill-large/holes-300k.drl', 'excellon', 4000);
budget('200 k macro flashes', 'gerber-large/macro-flash-grid-200k.gbr', 'gerber', 4000);
budget('100 k-vertex region', 'gerber-large/region-100k-vertices.gbr', 'gerber', 3000);

test('analyser: aperture table + statistics of the 30 MB Gerber in < 3 s', () => {
  const p = 'gerber-large/large-dense-traces-30MB.gbr';
  const r = loadFile(p, bytes(join(SYNTH, p)), { kind: 'gerber' });
  const t0 = performance.now();
  const rows = apertureTable(r.image, r.commands);
  const stats = imageStats(r.image);
  const took = performance.now() - t0;
  assert.equal(
    rows.reduce((a, x) => a + x.uses, 0),
    stats.objects - stats.regions,
  );
  assert.ok(took < 3000, `${took.toFixed(0)} ms`);
});
