// Property / fuzz tests: random and mutated input never crashes or hangs the parsers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { SYNTH, FIXTURES } from '../../helpers.js';
import { loadFile } from '../../../src/model/load-file.js';
import { rasterizeImage } from '../../../src/render/raster.js';
import { hitTest } from '../../../src/model/hit-test.js';

const KINDS = ['gerber', 'excellon', 'gbrjob'];
const SEEDS = [
  join(SYNTH, 'board/synthetic-board-F_Cu.gbr'),
  join(SYNTH, 'gerber-valid/macro-variables-expressions.gbr'),
  join(SYNTH, 'gerber-valid/aperture-blocks-nested.gbr'),
  join(SYNTH, 'gerber-valid/regions-complex.gbr'),
  join(SYNTH, 'board/synthetic-board-PTH.drl'),
  join(SYNTH, 'drill-valid/routed-slots-m15-m16.drl'),
  join(SYNTH, 'board/synthetic-board-job.gbrjob'),
  join(FIXTURES, 'gerber/transforms.gbr'),
].map((p) => readFileSync(p, 'latin1'));

function exercise(text, kind) {
  const r = loadFile('fuzz', new TextEncoder().encode(text), { kind, maxObjects: 20000 });
  assert.ok(r.diagnostics, 'returns diagnostics');
  if (r.image && r.image.bounds) {
    const b = r.image.bounds;
    // render small, and probe a hit test: neither may throw
    rasterizeImage(r.image, { pxPerMm: 2, maxPixels: 40000 });
    hitTest(r.image, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 0.1);
  }
}

test('random strings never crash any parser', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 400 }), fc.constantFrom(...KINDS), (s, kind) => exercise(s, kind)),
    { numRuns: 400, seed: 1 },
  );
});

test('random Gerber-alphabet soup never crashes', () => {
  const alphabet = 'XYIJD0123456789-+.*%GMADFSLMOCRPTABN,\n';
  fc.assert(
    fc.property(fc.stringOf(fc.constantFrom(...alphabet), { maxLength: 600 }), (s) => exercise(s, 'gerber')),
    { numRuns: 400, seed: 2 },
  );
});

test('mutated valid files never crash (insert / delete / replace characters)', () => {
  const mutation = fc.record({
    seed: fc.nat(SEEDS.length - 1),
    ops: fc.array(fc.tuple(fc.nat(), fc.constantFrom('del', 'ins', 'rep', 'dup'), fc.string({ maxLength: 4 })), {
      minLength: 1,
      maxLength: 8,
    }),
  });
  fc.assert(
    fc.property(mutation, ({ seed, ops }) => {
      let s = SEEDS[seed];
      for (const [pos, op, str] of ops) {
        const i = pos % (s.length + 1);
        if (op === 'del') s = s.slice(0, i) + s.slice(i + 1 + (pos % 7));
        else if (op === 'ins') s = s.slice(0, i) + str + s.slice(i);
        else if (op === 'rep') s = s.slice(0, i) + str + s.slice(i + str.length);
        else s = s.slice(0, i) + s.slice(i, i + 40) + s.slice(i);
      }
      for (const kind of KINDS) exercise(s, kind);
    }),
    { numRuns: 300, seed: 3 },
  );
});

test('random bytes never crash', () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 512 }), (b) => {
      for (const kind of KINDS) loadFile('fuzz', b, { kind });
    }),
    { numRuns: 200, seed: 4 },
  );
});
