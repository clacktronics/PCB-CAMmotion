import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drillEditor, assertWritesBack } from './helpers.js';
import { assertSameImage } from '../../helpers/images.js';

const DRL = [
  'M48',
  'INCH',
  'T1C0.0315',
  'T2C0.04',
  '%',
  'T1',
  'X0.1Y0.1',
  'X0.2Y0.1',
  'T2',
  'X0.3Y0.1',
  'Y0.2G85X0.4Y0.2',
  'M30',
].join('\n');

test('targets: hits and slots', () => {
  const ed = drillEditor(DRL);
  assert.deepEqual(
    ed.image.objects.map((_, i) => ed.target(i).kind),
    ['hit', 'hit', 'hit', 'slot'],
  );
});

test('move and delete holes and slots in an inch file', () => {
  const ed = drillEditor(DRL);
  ed.apply({ type: 'move', targets: [ed.target(0).ci, ed.target(3).ci], dxMm: 1, dyMm: 0 });
  const [h, , , s] = ed.image.objects;
  assert.ok(Math.abs(h.x - (2.54 + 1)) < 1e-4, 'moved, on the 1 µin grid');
  assert.ok(Math.abs(s.x1 - (7.62 + 1)) < 1e-4 && Math.abs(s.x2 - (10.16 + 1)) < 1e-4);
  ed.apply({ type: 'delete', targets: [ed.target(1).ci] });
  assert.equal(ed.image.objects.length, 3);
  const { text } = assertWritesBack(ed);
  assert.match(text, /^INCH$/m);
});

test('add holes: an existing tool is reused, a new size gets a new tool', () => {
  const ed = drillEditor(DRL);
  let sel = ed.apply({ type: 'addHit', diaMm: 0.8001, xMm: 10, yMm: 10 });
  assert.equal(ed.image.objects[sel[0]].ap.code, 1);
  sel = ed.apply({ type: 'addHit', diaMm: 3, xMm: 12, yMm: 10 });
  const o = ed.image.objects[sel[0]];
  assert.equal(o.ap.code, 3);
  assert.ok(Math.abs(o.ap.dia - 3) < 1e-4 && Math.abs(o.x - 12) < 1e-4);
  assertWritesBack(ed);
});

test('holes that start a routed path cannot be edited yet; undo restores', () => {
  const ed = drillEditor(['M48', 'METRIC', 'T1C1.0', '%', 'T1', 'X1.0Y1.0', 'G01X5.0Y1.0', 'M30'].join('\n'));
  const before = ed.image;
  assert.throws(() => ed.apply({ type: 'delete', targets: [ed.target(0).ci] }), /routed/);
  ed.apply({ type: 'addHit', diaMm: 1, xMm: 0, yMm: 0 });
  ed.undo();
  assertSameImage(before, ed.image, 'undo', 1e-9);
});
