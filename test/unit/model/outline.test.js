import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthGerber, gerber, bytes, SAMPLES } from '../../helpers.js';
import { extractOutline } from '../../../src/model/outline.js';
import { signedArea } from '../../../src/model/path.js';
import { join } from 'node:path';

test('synthetic board outline: rounded rectangle plus the internal cut-out', () => {
  const { loops, openChains } = extractOutline(synthGerber('board/synthetic-board-Edge_Cuts.gbr').image);
  assert.equal(openChains, 0);
  assert.equal(loops.length, 2);
  const areas = loops.map((l) => Math.abs(signedArea(l))).sort((a, b) => b - a);
  const r = 3;
  // arcs are flattened to 2 µm chords, which loses a little area at the corners
  assert.ok(Math.abs(areas[0] - (100 * 80 - (4 - Math.PI) * r * r)) < 0.05, `outer ${areas[0]}`);
  assert.ok(Math.abs(areas[1] - 30) < 1e-6, `cut-out ${areas[1]}`);
});

test('segments drawn in any order and direction still chain into a loop', () => {
  const { image } = gerber(
    [
      '%FSLAX46Y46*%',
      '%MOMM*%',
      '%ADD10C,0.1*%',
      'D10*',
      'X0Y0D02*',
      'X10000000Y0D01*',
      'X0Y10000000D02*',
      'X0Y0D01*',
      'X10000000Y10000000D02*',
      'X10000000Y0D01*',
      'X10000000Y10000000D02*',
      'X0Y10000000D01*',
      'M02*',
    ].join('\n'),
  );
  const { loops } = extractOutline(image);
  assert.equal(loops.length, 1);
  assert.ok(Math.abs(Math.abs(signedArea(loops[0])) - 100) < 1e-9);
});

test('real board outline (clockblock, with arcs) closes', () => {
  const { image } = gerber(bytes(join(SAMPLES, 'clockblock/clockblock-Edge_Cuts.gbr')));
  const { loops } = extractOutline(image);
  assert.ok(loops.length >= 1);
});
