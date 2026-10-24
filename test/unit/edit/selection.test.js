import { test } from 'node:test';
import assert from 'node:assert/strict';
import { g, gerber, drill } from '../../helpers.js';
import {
  objectsInPolygon,
  boxPolygon,
  sameShape,
  sameAperture,
  connected,
  apertureKey,
  pickLayers,
  PICK_FROM,
} from '../../../src/edit/selection.js';

// 0 pad D10 at (0,0); 1, 2 a track (0,0)→(2,0)→(2,1); 3 pad D12 (same circle as D10) at (2,1);
// 4 rectangle pad at (5,5); 5 pad D10 at (8,0); 6, 7 unit-square regions at (3,3) and (6,3);
// 8 track (10,0)→(12,0) (same vector as 1); 9 diagonal track (0,8)→(4,12)
const BOARD = gerber(
  g(
    '%ADD10C,0.5*%',
    '%ADD11R,1X0.6*%',
    '%ADD12C,0.5*%',
    'D10*',
    'X0Y0D03*',
    'X2000000Y0D01*',
    'Y1000000D01*',
    'D12*',
    'X2000000Y1000000D03*',
    'D11*',
    'X5000000Y5000000D03*',
    'D10*',
    'X8000000Y0D03*',
    'G36*',
    'X3000000Y3000000D02*',
    'X4000000Y3000000D01*',
    'X4000000Y4000000D01*',
    'X3000000Y4000000D01*',
    'X3000000Y3000000D01*',
    'G37*',
    'G36*',
    'X6000000Y3000000D02*',
    'X7000000Y3000000D01*',
    'X7000000Y4000000D01*',
    'X6000000Y4000000D01*',
    'X6000000Y3000000D01*',
    'G37*',
    'X10000000Y0D02*',
    'X12000000Y0D01*',
    'X0Y8000000D02*',
    'X4000000Y12000000D01*',
  ),
).image;

test('fixture: ten objects in the documented order', () => {
  assert.deepEqual(
    BOARD.objects.map((o) => o.k),
    ['F', 'L', 'L', 'F', 'F', 'F', 'R', 'R', 'L', 'L'],
  );
});

test('box, enclose mode: only objects entirely inside', () => {
  assert.deepEqual(objectsInPolygon(BOARD, boxPolygon([-0.3, -0.3], [0.3, 0.3]), 'enclose'), [0]);
  assert.deepEqual(objectsInPolygon(BOARD, boxPolygon([2.9, 2.9], [7.1, 6]), 'enclose'), [4, 6, 7]);
  // a box that only cuts the track picks nothing
  assert.deepEqual(objectsInPolygon(BOARD, boxPolygon([1, 0.1], [1.1, 0.2]), 'enclose'), []);
  // corners given either way round
  assert.deepEqual(objectsInPolygon(BOARD, boxPolygon([7.1, 6], [2.9, 2.9]), 'enclose'), [4, 6, 7]);
});

test('box, touch mode: anything the box touches, by the drawn outline not the bounding box', () => {
  assert.deepEqual(objectsInPolygon(BOARD, boxPolygon([1, 0.1], [1.1, 0.2]), 'touch'), [1]);
  // inside the diagonal track's bounding box but clear of the track itself
  assert.deepEqual(objectsInPolygon(BOARD, boxPolygon([0, 11], [1, 12]), 'touch'), []);
  assert.deepEqual(objectsInPolygon(BOARD, boxPolygon([1.5, 9], [2.5, 10.5]), 'touch'), [9]);
  // a box entirely inside a region touches it
  assert.deepEqual(objectsInPolygon(BOARD, boxPolygon([3.4, 3.4], [3.6, 3.6]), 'touch'), [6]);
  // the pad at (0,0) and both tracks meet at the origin; the pad of radius 0.25 reaches x = 0.25
  assert.deepEqual(objectsInPolygon(BOARD, boxPolygon([-1, -1], [0.1, 0.1]), 'touch'), [0, 1]);
});

test('lasso: a concave outline encloses what lies inside it, not what is in its notch', () => {
  // a U shape around both regions with the rectangle pad at (5,5) in its notch: the pad is
  // neither enclosed nor touched; a narrower notch cuts through the pad, which it then touches
  const u = [2.5, 2.5, 7.5, 2.5, 7.5, 6, 5.6, 6, 5.6, 4.5, 4.4, 4.5, 4.4, 6, 2.5, 6];
  assert.deepEqual(objectsInPolygon(BOARD, u, 'enclose'), [6, 7]);
  const notch = [2.5, 2.5, 7.5, 2.5, 7.5, 6, 5.2, 6, 5.2, 4.5, 4.8, 4.5, 4.8, 6, 2.5, 6];
  assert.deepEqual(objectsInPolygon(BOARD, notch, 'enclose'), [6, 7]);
  assert.deepEqual(objectsInPolygon(BOARD, notch, 'touch'), [4, 6, 7]);
  assert.deepEqual(objectsInPolygon(BOARD, [0, 0, 1, 1], 'touch'), [], 'two points are no polygon');
});

test('same shape: equal geometry whatever the D-code; draws by width and vector', () => {
  assert.deepEqual(sameShape(BOARD, [0]), [0, 3, 5]);
  assert.deepEqual(sameShape(BOARD, [1]), [1, 8]);
  assert.deepEqual(sameShape(BOARD, [6]), [6, 7]);
  assert.deepEqual(sameShape(BOARD, [4, 9]), [4, 9]);
});

test('same aperture: every flash and draw made with that aperture geometry', () => {
  assert.deepEqual(sameAperture(BOARD, [3]), [0, 1, 2, 3, 5, 8, 9]);
  assert.deepEqual(sameAperture(BOARD, [6]), [], 'regions have no aperture');
  assert.equal(apertureKey(BOARD.objects[0].ap), apertureKey(BOARD.objects[3].ap));
  assert.notEqual(apertureKey(BOARD.objects[0].ap), apertureKey(BOARD.objects[4].ap));
});

test('connected: follows touching dark objects from object to object', () => {
  assert.deepEqual(connected(BOARD, [0]), [0, 1, 2, 3]);
  assert.deepEqual(connected(BOARD, [3]), [0, 1, 2, 3]);
  assert.deepEqual(connected(BOARD, [4]), [4]);
  assert.deepEqual(connected(BOARD, [4, 9]), [4, 9]);
});

test('connected: regions joined by a track; clear objects are not followed', () => {
  const img = gerber(
    g(
      '%ADD10C,0.2*%',
      'G36*',
      'X0Y0D02*',
      'X1000000Y0D01*',
      'X1000000Y1000000D01*',
      'X0Y1000000D01*',
      'X0Y0D01*',
      'G37*',
      'D10*',
      'X1000000Y500000D02*',
      'X3000000Y500000D01*',
      'G36*',
      'X3000000Y0D02*',
      'X4000000Y0D01*',
      'X4000000Y1000000D01*',
      'X3000000Y1000000D01*',
      'X3000000Y0D01*',
      'G37*',
      '%LPC*%',
      'X500000Y500000D03*',
      '%LPD*%',
      'X10000000Y0D03*',
    ),
  ).image;
  assert.deepEqual(connected(img, [0]), [0, 1, 2]);
  assert.deepEqual(connected(img, [3]), [3], 'a clear seed reaches nothing');
});

test('drill: holes of the same diameter are the same shape across tools', () => {
  const img = drill(
    [
      'M48',
      'METRIC',
      'T1C0.8',
      'T2C1.0',
      'T3C0.8',
      '%',
      'T1',
      'X1.0Y1.0',
      'T2',
      'X2.0Y1.0',
      'T3',
      'X3.0Y1.0',
      'M30',
      '',
    ].join('\n'),
  ).image;
  assert.equal(img.objects.length, 3);
  assert.deepEqual(sameShape(img, [0]), [0, 2]);
  assert.deepEqual(objectsInPolygon(img, boxPolygon([0, 0], [2.6, 2]), 'enclose'), [0, 1]);
});

test('zero-width draws (outlines) are picked by their centre line and connect end to end', () => {
  const img = gerber(
    g(
      '%ADD10C,0*%',
      'D10*',
      'X0Y0D02*',
      'X2000000Y0D01*',
      'X2000000Y2000000D01*',
      'G75*',
      'G03X0Y2000000I-1000000J0D01*',
      'G01*',
      'X5000000Y5000000D02*',
      'X6000000Y5000000D01*',
    ),
  ).image;
  assert.deepEqual(
    img.objects.map((o) => o.k),
    ['L', 'L', 'A', 'L'],
  );
  assert.deepEqual(objectsInPolygon(img, boxPolygon([1, -0.1], [1.1, 0.1]), 'touch'), [0]);
  assert.deepEqual(objectsInPolygon(img, boxPolygon([-0.1, -0.1], [2.1, 3.1]), 'enclose'), [0, 1, 2]);
  // the arc bulges up to y = 3
  assert.deepEqual(objectsInPolygon(img, boxPolygon([-0.1, -0.1], [2.1, 2.9]), 'enclose'), [0, 1]);
  assert.deepEqual(connected(img, [0]), [0, 1, 2]);
});

test('pickLayers: a box or lasso picks from the edited layer, every shown layer, or the soloed ones', () => {
  const img = { objects: [] };
  const L = (id, kind = 'gerber') => ({ id, kind, image: img });
  const layers = [L('a'), L('b', 'excellon'), L('c'), { id: 'job', kind: 'gbrjob', image: null }, L('e')];
  const ids = (from, activeId, solo = []) => pickLayers(layers, { from, activeId, solo }).map((l) => l.id);
  assert.deepEqual(PICK_FROM, ['layer', 'all', 'solo']);
  assert.deepEqual(ids('layer', 'c'), ['c']);
  assert.deepEqual(ids('layer', 'c', ['a']), ['c']);
  // every Gerber and drill layer shown; other files are not editable
  assert.deepEqual(ids('all', 'c'), ['a', 'b', 'c', 'e']);
  assert.deepEqual(ids('solo', 'c', ['a', 'e']), ['a', 'e']);
  // nothing soloed: just the edited layer
  assert.deepEqual(ids('solo', 'c'), ['c']);
  assert.deepEqual(ids('layer', null), []);
  assert.deepEqual(ids('nonsense', 'c'), ['c']);
});

test('pickLayers: locked layers are never picked', () => {
  const img = { objects: [] };
  const layers = [
    { id: 'a', kind: 'gerber', image: img },
    { id: 'b', kind: 'gerber', image: img, locked: true },
    { id: 'c', kind: 'excellon', image: img },
  ];
  const ids = (from, activeId, solo = []) => pickLayers(layers, { from, activeId, solo }).map((l) => l.id);
  assert.deepEqual(ids('all', 'a'), ['a', 'c']);
  assert.deepEqual(ids('solo', 'a', ['b', 'c']), ['c']);
  assert.deepEqual(ids('layer', 'b'), []);
});
