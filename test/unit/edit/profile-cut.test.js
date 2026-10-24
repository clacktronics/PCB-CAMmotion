import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { g, SYNTH } from '../../helpers.js';
import { join } from 'node:path';
import { gerberEditor, assertWritesBack } from './helpers.js';
import { strokeContours } from '../../../src/edit/brush.js';
import { cutProfile, insideContours } from '../../../src/edit/profile-cut.js';
import { EditError } from '../../../src/edit/session.js';
import { extractOutline } from '../../../src/model/outline.js';
import { signedArea } from '../../../src/model/path.js';

// a 10 x 10 mm board outline drawn as four lines
const SQUARE = g(
  '%ADD10C,0.1*%',
  'D10*',
  'X0Y0D02*',
  'X10000000Y0D01*',
  'X10000000Y10000000D01*',
  'X0Y10000000D01*',
  'X0Y0D01*',
);

// the same board with a rounded corner: (10,8) → (8,10) arc round (8,8), then a round 2 mm
// cut-out at (5,5) drawn as one full-circle arc
const ROUNDED = g(
  '%ADD10C,0.1*%',
  'D10*',
  'G75*',
  'X0Y0D02*',
  'G01*',
  'X10000000Y0D01*',
  'X10000000Y8000000D01*',
  'G03*',
  'X8000000Y10000000I-2000000J0D01*',
  'G01*',
  'X0Y10000000D01*',
  'X0Y0D01*',
  'X6000000Y5000000D02*',
  'G03*',
  'X6000000Y5000000I-1000000J0D01*',
);

/** The board area: the outline loops filled even-odd (outer CCW or CW, cut-outs inside). */
function boardArea(ed) {
  const o = extractOutline(ed.image);
  assert.equal(o.openChains, 0, 'every outline chain is closed');
  // loops nest at most one deep in these fixtures: the biggest is the edge, the others holes
  // or separate boards, told apart by whether the biggest holds them
  const [outer, ...rest] = o.loops.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
  let area = Math.abs(signedArea(outer));
  for (const l of rest)
    area += insideContours([outer], l[0], l[1]) ? -Math.abs(signedArea(l)) : Math.abs(signedArea(l));
  return { area, loops: o.loops.length };
}

const rub = (points, rMm) => ({ type: 'cutProfile', clipMm: strokeContours(points, rMm) });

test('profile: a dab on the edge bites a notch and the outline stays closed', () => {
  const ed = gerberEditor(SQUARE);
  ed.apply(rub([[5, 10]], 1));
  const { area, loops } = boardArea(ed);
  assert.equal(loops, 1);
  // half the brush disc is gone (the brush is flattened inside the true circle)
  assert.ok(Math.abs(100 - area - Math.PI / 2) < 0.02, `area ${area}`);
  // the top edge is two lines either side of the dab; the others are untouched
  const tops = ed.image.objects.filter((o) => o.k === 'L' && o.y1 === 10 && o.y2 === 10);
  assert.deepEqual(
    tops.map((o) => [o.x1, o.x2]),
    [
      [10, 6],
      [4, 0],
    ],
  );
  assert.equal(ed.image.objects.filter((o) => o.ln > 0).length, 5);
  assertWritesBack(ed, 'notch');
});

test('profile: a stroke off the corner rounds it away; a stroke across the board splits it in two', () => {
  const ed = gerberEditor(SQUARE);
  ed.apply(rub([[10, 0]], 1));
  let b = boardArea(ed);
  assert.equal(b.loops, 1);
  assert.ok(Math.abs(100 - b.area - Math.PI / 4) < 0.01, `area ${b.area}`);
  // right across the middle, top to bottom: two boards, each closed
  ed.apply(
    rub(
      [
        [5, -1],
        [5, 11],
      ],
      0.5,
    ),
  );
  b = boardArea(ed);
  assert.equal(b.loops, 2);
  assert.ok(Math.abs(100 - b.area - Math.PI / 4 - 10) < 0.01, `area ${b.area}`);
  assertWritesBack(ed, 'split');
  // the edits replay from the stored record
  const again = gerberEditor(SQUARE);
  again.load({ ops: ed.ops });
  assert.equal(again.write(), ed.write());
});

test('profile: arcs it crosses stay arcs of the same circle; a cut-out it covers is merged', () => {
  const ed = gerberEditor(ROUNDED);
  const a0 = boardArea(ed).area;
  // the rounded corner's middle
  const mid = [8 + 2 * Math.SQRT1_2, 8 + 2 * Math.SQRT1_2];
  ed.apply(rub([mid], 0.5));
  const corner = ed.image.objects.filter((o) => o.k === 'A' && Math.abs(o.r - 2) < 1e-6);
  assert.equal(corner.length, 2);
  for (const o of corner) assert.ok(Math.abs(o.cx - 8) < 1e-6 && Math.abs(o.cy - 8) < 1e-6);
  let b = boardArea(ed);
  assert.equal(b.loops, 2);
  assert.ok(a0 - b.area > 0.3 && a0 - b.area < Math.PI * 0.25, `area ${a0 - b.area}`);
  // a stroke right over the round cut-out: the cut-out grows to the brush's outline
  ed.apply(rub([[5, 5]], 1.5));
  b = boardArea(ed);
  assert.equal(b.loops, 2);
  assert.equal(ed.image.objects.filter((o) => o.k === 'A' && Math.abs(o.r - 1) < 1e-6).length, 0);
  assertWritesBack(ed, 'arcs');
});

test('profile: a shape that does not cross the outline is refused', () => {
  const ed = gerberEditor(SQUARE);
  assert.throws(() => ed.apply(rub([[20, 20]], 1)), EditError);
  assert.throws(() => ed.apply({ type: 'cutProfile', clipMm: [] }), EditError);
});

test('profile cut geometry: a shape all inside the board becomes a cut-out', () => {
  const objs = [
    { k: 'L', x1: 0, y1: 0, x2: 4, y2: 0 },
    { k: 'L', x1: 4, y1: 0, x2: 4, y2: 4 },
    { k: 'L', x1: 4, y1: 4, x2: 0, y2: 4 },
    { k: 'L', x1: 0, y1: 4, x2: 0, y2: 0 },
  ];
  const loops = [[0, 0, 4, 0, 4, 4, 0, 4]];
  const r = cutProfile(objs, [[1, 1, 2, 1, 2, 2, 1, 2]], loops);
  assert.deepEqual(r.pieces, [null, null, null, null]);
  assert.equal(r.bridges.length, 1);
  assert.equal(r.bridges[0].length, 5);
  // outside the board: nothing
  assert.equal(cutProfile(objs, [[5, 5, 6, 5, 6, 6]], loops).changed, false);
});

test('profile: specks in a stroke outline where it crosses the edge leave no stray bits of outline', () => {
  // a real rubber stroke from the browser: its outline has corners ~50 nm apart where it
  // crosses the board's bottom edge, which made new edges too short to chain
  const { clipMm } = JSON.parse(
    readFileSync(new URL('../../fixtures/edit/rubber-stroke-across-edge.json', import.meta.url)),
  );
  const text = readFileSync(join(SYNTH, 'board/synthetic-board-Edge_Cuts.gbr'), 'utf8');
  const ed = gerberEditor(text);
  ed.apply({ type: 'cutProfile', clipMm });
  const o = extractOutline(ed.image);
  assert.equal(o.openChains, 0);
  // the outline, the slot, and a sliver of board left between the stroke's legs
  assert.equal(o.loops.length, 3);
  assertWritesBack(ed, 'specks');
});
