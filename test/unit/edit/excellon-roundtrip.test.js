// Excellon round trip: parse → normalise → write → parse gives the same holes, slots and routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, SAMPLES, SYNTH, bytes, drill, manifest } from '../../helpers.js';
import { assertSameImage } from '../../helpers/images.js';
import { normalizeExcellon, writeExcellon } from '../../../src/edit/excellon.js';
import { interpretExcellon } from '../../../src/model/drill-image.js';
import { Diagnostics } from '../../../src/parse/diagnostics.js';
import { detectFileKind } from '../../../src/model/layers.js';

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function drillFiles() {
  const files = [...walk(join(FIXTURES, 'drill')), ...walk(join(FIXTURES, 'tracespace')), ...walk(SAMPLES)].filter(
    (p) => detectFileKind(p, bytes(p)) === 'excellon',
  );
  const synth = manifest()
    .fixtures.filter((f) => f.type === 'excellon' && f.expect !== 'limit')
    .map((f) => join(SYNTH, f.path));
  return [...files, ...synth];
}

test('normalising and writing drill files keeps every hole, slot and route', () => {
  const files = drillFiles();
  assert.ok(files.length > 15, `only ${files.length} drill files`);
  for (const path of files) {
    const a = drill(bytes(path));
    const norm = normalizeExcellon(a.parsed);
    const img = interpretExcellon({
      commands: norm.commands,
      diagnostics: new Diagnostics(),
      attributes: a.parsed.attributes,
    });
    assertSameImage(a.image, img, `${path} (normalised)`, 1e-9);
    const text = writeExcellon(norm.commands, norm.units);
    const b = drill(text);
    assertSameImage(a.image, b.image, path, 1e-6);
    assert.equal(b.image.fileUnits, norm.units, `${path}: units kept`);
    if (!a.diag.hasErrors)
      assert.deepEqual(
        b.diag.list.filter((d) => d.severity === 'error').map((d) => d.code),
        [],
        `${path}: errors`,
      );
  }
});

test('repeat codes are expanded into hits and implied decimals become explicit', () => {
  const src = ['M48', 'METRIC,LZ', 'T1C0.8', '%', 'T1', 'X010000Y010000', 'R3X001000', 'M30'].join('\n');
  const a = drill(src);
  const norm = normalizeExcellon(a.parsed);
  const text = writeExcellon(norm.commands, norm.units);
  assert.doesNotMatch(text, /^R/m);
  assert.match(text, /^X13\.0Y10\.0$/m);
  assertSameImage(a.image, drill(text).image, 'repeat', 1e-9);
});
