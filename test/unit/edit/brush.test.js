import { test } from 'node:test';
import assert from 'node:assert/strict';
import { g } from '../../helpers.js';
import { gerberEditor, drillEditor, assertWritesBack } from './helpers.js';
import {
  capsulePolygon,
  discPolygon,
  strokePolygons,
  strokeHits,
  paintContour,
  strokeContours,
  brushTol,
} from '../../../src/edit/brush.js';
import { EditError } from '../../../src/edit/session.js';
import { signedArea } from '../../../src/model/path.js';
import { contoursArea, imageContours, booleanOp } from '../../../src/model/polygons.js';

// 0 pad at (0,0); 1 track (2,0)→(4,0); 2 unit-square region at (6,0); 3 pad at (10,10)
const BOARD = g(
  '%ADD10C,0.5*%',
  'D10*',
  'X0Y0D03*',
  'X2000000Y0D02*',
  'X4000000Y0D01*',
  'G36*',
  'X6000000Y0D02*',
  'X7000000Y0D01*',
  'X7000000Y1000000D01*',
  'X6000000Y1000000D01*',
  'X6000000Y0D01*',
  'G37*',
  'X10000000Y10000000D03*',
);

const dist = (c, i, x, y) => Math.hypot(c[i] - x, c[i + 1] - y);

test('brush polygons: discs and capsules are CCW and within the brush, chord error within tol', () => {
  const r = 0.5;
  const tol = brushTol(r);
  const d = discPolygon(1, 2, r);
  assert.ok(signedArea(d) > 0);
  for (let i = 0; i < d.length; i += 2) assert.ok(Math.abs(dist(d, i, 1, 2) - r) < 1e-12);
  assert.ok(Math.PI * r * r - signedArea(d) < 2 * Math.PI * r * tol);
  const c = capsulePolygon([0, 0], [3, 4], r);
  assert.ok(signedArea(c) > 0);
  const exact = 2 * r * 5 + Math.PI * r * r;
  assert.ok(exact - signedArea(c) > 0 && exact - signedArea(c) < 2 * Math.PI * r * tol);
  // a zero-length segment is a disc
  assert.deepEqual(capsulePolygon([1, 1], [1, 1], r), discPolygon(1, 1, r));
  assert.equal(strokePolygons([], r).length, 0);
  assert.equal(strokePolygons([[0, 0]], r).length, 1);
  assert.equal(
    strokePolygons(
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      r,
    ).length,
    2,
  );
});

test('rubber: a stroke picks every object it touches, whole', () => {
  const { image } = gerberEditor(BOARD);
  // past the pad's edge (0.25) by the brush radius: just touching
  assert.deepEqual(strokeHits(image, [[0.6, 0]], 0.4), [0]);
  assert.deepEqual(strokeHits(image, [[0.7, 0]], 0.4), []);
  // a stroke across the track's middle and on into the region
  assert.deepEqual(
    strokeHits(
      image,
      [
        [3, 1],
        [3, -1],
        [6.5, -1],
        [6.5, 0.5],
      ],
      0.1,
    ),
    [1, 2],
  );
  assert.deepEqual(strokeHits(image, [[10, 10]], 0.01), [3]);
});

test('rubber on a Gerber layer: deleting what a stroke touches writes back', () => {
  const ed = gerberEditor(BOARD);
  const hits = strokeHits(
    ed.image,
    [
      [-1, 0],
      [3, 0],
    ],
    0.2,
  );
  assert.deepEqual(hits, [0, 1]);
  ed.apply({ type: 'delete', targets: hits.map((i) => ed.target(i).ci) });
  assert.deepEqual(
    ed.image.objects.map((o) => o.k),
    ['R', 'F'],
  );
  assertWritesBack(ed, 'rubbed');
});

test('rubber on a drill layer deletes the holes it touches', () => {
  const ed = drillEditor(['M48', 'METRIC', 'T1C0.8', '%', 'T1', 'X1.0Y1.0', 'X5.0Y1.0', 'M30'].join('\n'));
  const hits = strokeHits(ed.image, [[1.5, 1]], 0.2);
  assert.deepEqual(hits, [0]);
  ed.apply({ type: 'delete', targets: hits.map((i) => ed.target(i).ci) });
  assert.equal(ed.image.objects.length, 1);
  assertWritesBack(ed, 'rubbed drill');
});

test('paint: a stroke becomes one region the shape of the brush swept along it', () => {
  const r = 0.25;
  const pts = [
    [20, 0],
    [22, 0],
    [22, 2],
  ];
  const c = paintContour(pts, r);
  // two 2 mm bands (overlapping in an r × r square at the bend), half discs at the ends and
  // the quarter of the bend's disc outside both bands
  const exact = 2 * r * 4 - r * r + Math.PI * r * r + (Math.PI * r * r) / 4;
  assert.ok(Math.abs(signedArea(c) - exact) < 0.01, `area ${signedArea(c)} vs ${exact}`);
  const ed = gerberEditor(BOARD);
  const sel = ed.apply({ type: 'addRegion', pointsMm: c });
  assert.equal(ed.image.objects.length, 5);
  assert.equal(ed.image.objects[sel[0]].k, 'R');
  const area = contoursArea(imageContours(ed.image, [sel[0]]));
  assert.ok(Math.abs(area - signedArea(c)) < 1e-4);
  assertWritesBack(ed, 'painted');
});

test('paint: a dab is a disc; a stroke that loops round keeps its hole (joined by a cut-in)', () => {
  const dab = paintContour([[1, 1]], 0.5);
  assert.ok(Math.abs(signedArea(dab) - Math.PI * 0.25) < 0.01);
  const ring = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
    [0, 0],
  ];
  const c = paintContour(ring, 0.5);
  // outer square 5×5 with rounded corners, minus the 3×3 hole
  const area = signedArea(c);
  assert.ok(area > 25 - 1 - 9 && area < 25 - 9, `area ${area}`);
  const ed = gerberEditor(BOARD);
  const [oi] = ed.apply({ type: 'addRegion', pointsMm: c });
  // the middle of the loop stays empty
  assert.ok(Math.abs(contoursArea(imageContours(ed.image, [oi])) - area) < 1e-3);
  assertWritesBack(ed, 'painted ring');
});

test('paint: a brush of no size is refused', () => {
  assert.throws(() => paintContour([[0, 0]], 0), EditError);
  assert.throws(() => paintContour([], 1), EditError);
});

/** Area (mm²) an editor's image covers. */
const covered = (ed, indices) => contoursArea(imageContours(ed.image, indices));
const cut = (ed, indices, points, r) => ({
  type: 'cutOut',
  targets: indices.map((i) => ed.target(i).ci),
  clipMm: strokeContours(points, r),
});

test('rubber cuts its stroke out of a track: the parts left are regions, drawn where it was', () => {
  const ed = gerberEditor(BOARD);
  const total = covered(ed);
  const stroke = [
    [3, 1],
    [3, -1],
  ];
  const clip = strokeContours(stroke, 0.2);
  const sel = ed.apply(cut(ed, [1], stroke, 0.2));
  assert.deepEqual(
    ed.image.objects.map((o) => o.k),
    ['F', 'R', 'R', 'R', 'F'],
  );
  assert.deepEqual(sel, [1, 2]);
  // the track is 0.5 wide and the stroke's straight sides 0.4 apart: a 0.5 × 0.4 band goes
  const removed = total - covered(ed);
  assert.ok(Math.abs(removed - 0.2) < 1e-6, `removed ${removed}`);
  // what is left lies outside the stroke
  const left = imageContours(ed.image, [1, 2]);
  assert.ok(Math.abs(contoursArea(left) - contoursArea(booleanOp('difference', left, clip))) < 1e-6);
  assertWritesBack(ed, 'cut track');
});

test('rubber: a pad it covers is removed, one it misses is left alone; regions keep their holes', () => {
  const ed = gerberEditor(BOARD);
  ed.apply(cut(ed, [0, 3], [[0, 0]], 1));
  assert.deepEqual(
    ed.image.objects.map((o) => o.k),
    ['L', 'R', 'F'],
  );
  assert.throws(() => ed.apply(cut(ed, [2], [[0, 0]], 1)), /does not overlap/);
  // a dab in the middle of the unit square leaves a square with a round hole
  const area0 = covered(ed, [1]);
  ed.apply(cut(ed, [1], [[6.5, 0.5]], 0.2));
  assert.equal(ed.image.objects[1].k, 'R');
  assert.ok(Math.abs(area0 - covered(ed, [1]) - Math.PI * 0.04) < 0.002);
  assertWritesBack(ed, 'cut region');
  // the edits replay from the stored record
  const again = gerberEditor(BOARD);
  again.load({ ops: ed.ops });
  assert.equal(again.write(), ed.write());
});

test('rubber: modal arcs after the cut object still draw as arcs; the current point is kept', () => {
  const ed = gerberEditor(
    g(
      '%ADD10C,0.2*%',
      'D10*',
      'G75*',
      'X0Y0D02*',
      'G01*',
      'X2000000Y0D01*',
      'G03*',
      'X4000000Y0I1000000J0D01*',
      'X6000000Y0I1000000J0D01*',
      'G01*',
      'X8000000Y0D01*',
    ),
  );
  assert.deepEqual(
    ed.image.objects.map((o) => o.k),
    ['L', 'A', 'A', 'L'],
  );
  ed.apply(cut(ed, [1], [[3, -1]], 0.3));
  assert.deepEqual(
    ed.image.objects.map((o) => o.k),
    ['L', 'R', 'R', 'A', 'L'],
  );
  assertWritesBack(ed, 'cut arc');
});

test('rubber: clear objects and bad shapes are refused', () => {
  const ed = gerberEditor(g('%ADD10C,1*%', 'D10*', 'X0Y0D03*', '%LPC*%', 'X0Y0D03*'));
  assert.throws(() => ed.apply(cut(ed, [1], [[0, 0]], 0.2)), /Clear/);
  assert.throws(() => ed.apply({ type: 'cutOut', targets: [ed.target(0).ci], clipMm: [[0, 0, 1]] }), EditError);
  assert.throws(() => ed.apply({ type: 'cutOut', targets: [ed.target(0).ci], clipMm: [] }), EditError);
  assert.equal(ed.ops.length, 0);
});

const paintOp = (ed, points, r) => {
  const targets = new Set();
  for (const i of strokeHits(ed.image, points, r)) targets.add(ed.target(i).ci);
  return { type: 'paint', targets: [...targets], pointsMm: paintContour(points, r) };
};

test('paint over a track and a region unifies them with the stroke into one region, on top', () => {
  const ed = gerberEditor(BOARD);
  const stroke = [
    [4, 0],
    [6.5, 0.5],
  ];
  const op = paintOp(ed, stroke, 0.2);
  assert.equal(op.targets.length, 2);
  const expected = contoursArea(booleanOp('union', imageContours(ed.image, [1, 2]), [paintContour(stroke, 0.2)]));
  const sel = ed.apply(op);
  assert.deepEqual(
    ed.image.objects.map((o) => o.k),
    ['F', 'F', 'R'],
  );
  assert.deepEqual(sel, [2]);
  assert.ok(Math.abs(covered(ed, [2]) - expected) < 1e-4);
  assertWritesBack(ed, 'painted over');
  // nothing touched: just the blob, like addRegion
  const ed2 = gerberEditor(BOARD);
  const op2 = paintOp(ed2, [[20, 20]], 0.5);
  assert.deepEqual(op2.targets, []);
  ed2.apply(op2);
  assert.equal(ed2.image.objects.length, 5);
});

test('paint does not unify past a clear object it would stop erasing', () => {
  // a pad with a clear hole drawn over it: unified and moved last, the hole would fill in
  const ed = gerberEditor(g('%ADD10C,2*%', '%ADD11C,0.5*%', 'D10*', 'X0Y0D03*', '%LPC*%', 'D11*', 'X0Y0D03*'));
  const area0 = covered(ed);
  ed.apply(paintOp(ed, [[1.2, 0]], 0.3));
  assert.deepEqual(
    ed.image.objects.map((o) => [o.k, o.dark]),
    [
      ['F', true],
      ['F', false],
      ['R', true],
    ],
  );
  assert.ok(covered(ed) > area0 && covered(ed) < area0 + Math.PI * 0.09);
  assertWritesBack(ed, 'painted near a clear hole');
});
