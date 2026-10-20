// Round trip (AGENTS.md: never silently change geometry): parse → normalise → write → parse
// must give the same image as the original, for every Gerber we have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, SAMPLES, SYNTH, bytes, gerber, manifest } from '../../helpers.js';
import { assertSameImage, xorCount } from '../../helpers/images.js';
import { normalizeGerber } from '../../../src/edit/gerber-normalize.js';
import { writeGerber } from '../../../src/edit/gerber-writer.js';
import { interpretGerber } from '../../../src/model/gerber-image.js';
import { detectFileKind } from '../../../src/model/layers.js';
import { Diagnostics } from '../../../src/parse/diagnostics.js';

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function gerberFiles() {
  const files = [...walk(join(FIXTURES, 'gerber')), ...walk(join(FIXTURES, 'tracespace')), ...walk(SAMPLES)].filter(
    (p) => detectFileKind(p, bytes(p)) === 'gerber',
  );
  const synth = manifest()
    .fixtures.filter((f) => f.type === 'gerber' && f.expect !== 'limit')
    .map((f) => join(SYNTH, f.path));
  return [...files, ...synth];
}

export function roundTrip(input) {
  const a = gerber(input);
  const norm = normalizeGerber(a.parsed.commands);
  const text = writeGerber(norm.commands);
  const b = gerber(text);
  return { a, b, norm, text };
}

test('normalising does not change the image', () => {
  for (const path of gerberFiles()) {
    const a = gerber(bytes(path));
    const norm = normalizeGerber(a.parsed.commands);
    const img = interpretGerber({ commands: norm.commands, diagnostics: new Diagnostics() });
    assertSameImage(a.image, img, path);
  }
});

test('every Gerber round-trips through the writer with the same image', () => {
  let n = 0;
  for (const path of gerberFiles()) {
    const { a, b, text } = roundTrip(bytes(path));
    assertSameImage(a.image, b.image, path);
    // writing the re-read file again gives the same text
    assert.equal(writeGerber(normalizeGerber(b.parsed.commands).commands), text, `${path}: idempotent`);
    n++;
  }
  assert.ok(n > 100, `only ${n} files`);
});

test('written files have no new parse errors', () => {
  for (const path of gerberFiles()) {
    const { a, b } = roundTrip(bytes(path));
    if (a.diag.hasErrors) continue;
    assert.deepEqual(
      b.diag.list.filter((d) => d.severity === 'error').map((d) => d.code),
      [],
      path,
    );
  }
});

test('round trip XOR: zero differing pixels on real boards', () => {
  for (const dir of ['arduino-uno', 'test-board']) {
    for (const path of walk(join(SAMPLES, dir)).filter((p) => detectFileKind(p, bytes(p)) === 'gerber')) {
      const { a, b } = roundTrip(bytes(path));
      if (!a.image.bounds) continue;
      const { diff, set } = xorCount(a.image, b.image, 20);
      assert.equal(diff, 0, `${path}: ${diff} of ${set} pixels differ`);
    }
  }
});

test('incremental, trailing-zero and modal files are written absolute with explicit D-codes', () => {
  const src = [
    '%FSTIX24Y24*%',
    '%MOIN*%',
    '%ADD10C,0.01*%',
    'D10*',
    'X1Y1D02*',
    'X1D01*',
    'Y1*',
    'G01X-1D01*',
    'M02*',
  ].join('\n');
  const { a, b, text } = roundTrip(src);
  assert.match(text, /^%FSLAX26Y26\*%$/m);
  assert.doesNotMatch(text, /^[XY][^D]*\*$/m);
  assertSameImage(a.image, b.image, 'incremental');
  assert.equal(b.image.objects.length, 3);
});

test('MD5 attribute is dropped; attributes with reserved characters are escaped', () => {
  const src = [
    '%FSLAX46Y46*%',
    '%MOMM*%',
    '%TF.MD5,00000000000000000000000000000000*%',
    '%TO.N,a\\u002Cb*%',
    '%ADD10C,0.1*%',
    'D10*',
    'X0Y0D03*',
    'M02*',
  ].join('\n');
  const { b, text } = roundTrip(src);
  assert.doesNotMatch(text, /MD5/);
  assert.deepEqual(b.image.objectAttributes[b.image.objects[0].at]['.N'], ['a,b']);
});

test('coordinates beyond the format widen the integer digits', () => {
  const { commands } = normalizeGerber(
    gerber('%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.1*%\nD10*\nX10000Y0D03*\nM02*').parsed.commands,
  );
  const d = commands.find((c) => c.type === 'D');
  d.x = 123456 * 1e6; // 123456 mm
  const text = writeGerber(commands);
  assert.match(text, /%FSLAX66Y66\*%/);
  assert.equal(gerber(text).image.objects[0].x, 123456);
});
