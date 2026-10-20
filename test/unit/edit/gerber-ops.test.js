import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { g, near, bytes, SAMPLES } from '../../helpers.js';
import { assertSameImage, xorCount } from '../../helpers/images.js';
import { gerberEditor, assertWritesBack } from './helpers.js';
import { EditError } from '../../../src/edit/session.js';
import { contoursArea, imageContours } from '../../../src/model/polygons.js';

// pad at (0,0), a two-segment track from (1,0) via (2,0) to (2,1), a region, a pad at (5,5)
const BOARD = g(
  '%ADD10C,0.5*%',
  '%ADD11R,1X0.6*%',
  'D10*',
  'X0Y0D03*',
  'X1000000Y0D02*',
  'X2000000Y0D01*',
  'Y1000000D01*',
  'G36*',
  'X3000000Y0D02*',
  'X4000000Y0D01*',
  'X4000000Y1000000D01*',
  'X3000000Y1000000D01*',
  'X3000000Y0D01*',
  'G37*',
  'D11*',
  'X5000000Y5000000D03*',
);

/**
 * Same covered area: the polygon areas agree and the rasters differ only along edges
 * (the rasteriser flattens arcs within 0.2 px, region arcs are flattened within 0.5 µm).
 */
function assertSameArea(a, b, rel = 1e-5) {
  const aa = contoursArea(imageContours(a));
  const ab = contoursArea(imageContours(b));
  assert.ok(Math.abs(aa - ab) <= rel * aa + 1e-6, `area ${aa} vs ${ab}`);
  const bb = a.bounds;
  const size = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
  const { diff, set } = xorCount(a, b, Math.min(400, Math.max(20, 2000 / size)));
  assert.ok(diff <= set * 0.01, `${diff} of ${set} pixels differ`);
}

const targetOf = (ed, oi) => {
  const t = ed.target(oi);
  assert.ok(!t.error, t.error);
  return t.ci;
};

test('targets: flashes, draws and regions map to their commands', () => {
  const ed = gerberEditor(BOARD);
  const kinds = ed.image.objects.map((_, i) => ed.target(i).kind);
  assert.deepEqual(kinds, ['flash', 'draw', 'draw', 'region', 'flash']);
});

test('delete a flash: the other objects do not change', () => {
  const ed = gerberEditor(BOARD);
  const before = ed.image.objects.slice(1);
  ed.apply({ type: 'delete', targets: [targetOf(ed, 0)] });
  assert.equal(ed.image.objects.length, 4);
  assertSameImage({ objects: before }, ed.image, 'after delete');
  assertWritesBack(ed);
});

test('delete the first segment of a track: the second still starts where it did', () => {
  const ed = gerberEditor(BOARD);
  ed.apply({ type: 'delete', targets: [targetOf(ed, 1)] });
  const o = ed.image.objects[1];
  assert.equal(o.k, 'L');
  assert.deepEqual([o.x1, o.y1, o.x2, o.y2], [2, 0, 2, 1]);
  assertWritesBack(ed);
});

test('delete a region and several objects at once', () => {
  const ed = gerberEditor(BOARD);
  ed.apply({ type: 'delete', targets: [targetOf(ed, 3), targetOf(ed, 0), targetOf(ed, 2)] });
  assert.deepEqual(
    ed.image.objects.map((o) => o.k),
    ['L', 'F'],
  );
  assert.deepEqual([ed.image.objects[1].x, ed.image.objects[1].y], [5, 5]);
  assertWritesBack(ed);
});

test('move a flash, a draw and a region; nothing else moves', () => {
  const ed = gerberEditor(BOARD);
  const sel = ed.apply({
    type: 'move',
    targets: [targetOf(ed, 0), targetOf(ed, 1), targetOf(ed, 3)],
    dxMm: 0.5,
    dyMm: -0.25,
  });
  assert.deepEqual(sel, [0, 1, 3]);
  const [f, l1, l2, r, f2] = ed.image.objects;
  assert.deepEqual([f.x, f.y], [0.5, -0.25]);
  assert.deepEqual([l1.x1, l1.y1, l1.x2, l1.y2], [1.5, -0.25, 2.5, -0.25]);
  assert.deepEqual([l2.x1, l2.y1, l2.x2, l2.y2], [2, 0, 2, 1], 'second segment unchanged');
  assert.deepEqual(r.contours[0].slice(0, 2), [3.5, -0.25]);
  assert.deepEqual([f2.x, f2.y], [5, 5]);
  assertWritesBack(ed);
});

test('moves snap to the file grid (1 nm) and keep arcs intact', () => {
  const ed = gerberEditor(
    g('%ADD10C,0.2*%', 'D10*', 'G75*', 'X1000000Y0D02*', 'G03X0Y1000000I-1000000J0D01*', 'G01*', 'X3000000Y0D01*'),
  );
  ed.apply({ type: 'move', targets: [targetOf(ed, 0)], dxMm: 1.0000004, dyMm: 0 });
  const a = ed.image.objects[0];
  assert.equal(a.k, 'A');
  assert.ok(near(a.cx, 1) && near(a.r, 1) && near(a.sw, Math.PI / 2, 1e-9));
  // the following straight segment still starts at the old arc end
  assert.deepEqual([ed.image.objects[1].x1, ed.image.objects[1].y1], [0, 1]);
  assertWritesBack(ed);
});

test('a region whose contour starts at the current point moves completely', () => {
  const ed = gerberEditor(g('X0Y0D02*', 'G36*', 'X1000000Y0D01*', 'Y1000000D01*', 'X0D01*', 'Y0D01*', 'G37*'));
  ed.apply({ type: 'move', targets: [targetOf(ed, 0)], dxMm: 2, dyMm: 3 });
  assert.deepEqual(ed.image.objects[0].contours[0], [2, 3, 3, 3, 3, 4, 2, 4]);
  assertWritesBack(ed);
});

test('add a pad with an existing or a new aperture, a track and a region', () => {
  const ed = gerberEditor(g('%ADD10C,0.5*%', '%LPC*%', '%LR45*%', 'D10*', 'X0Y0D03*'));
  let sel = ed.apply({ type: 'addFlash', aperture: { code: 10 }, xMm: 1, yMm: 2 });
  let o = ed.image.objects[sel[0]];
  assert.equal(o.dark, true, 'new objects are dark even after %LPC%');
  assert.equal(o.m, null, 'and not rotated by an earlier %LR%');
  assert.deepEqual([o.x, o.y, o.ap.code], [1, 2, 10]);
  sel = ed.apply({ type: 'addFlash', aperture: { template: 'R', paramsMm: [1.5, 0.8] }, xMm: 3, yMm: 3 });
  o = ed.image.objects[sel[0]];
  assert.equal(o.ap.code, 11);
  assert.deepEqual([o.ap.w, o.ap.h], [1.5, 0.8]);
  // the same aperture again reuses D11
  sel = ed.apply({ type: 'addFlash', aperture: { template: 'R', paramsMm: [1.5, 0.8] }, xMm: 4, yMm: 3 });
  assert.equal(ed.image.objects[sel[0]].ap.code, 11);
  sel = ed.apply({ type: 'addTrack', aperture: { template: 'C', paramsMm: [0.25] }, pointsMm: [0, 0, 1, 0, 1, 1] });
  assert.deepEqual(
    sel.map((i) => ed.image.objects[i].k),
    ['L', 'L'],
  );
  sel = ed.apply({ type: 'addRegion', pointsMm: [5, 5, 6, 5, 6, 6] });
  assert.equal(ed.image.objects[sel[0]].k, 'R');
  assert.ok(near(contoursArea(ed.image.objects[sel[0]].contours), 0.5));
  assertWritesBack(ed);
});

test('added objects in inch files land at the mm position', () => {
  const ed = gerberEditor('%FSLAX24Y24*%\n%MOIN*%\n%ADD10C,0.01*%\nD10*\nX10000Y10000D03*\nM02*');
  const sel = ed.apply({ type: 'addFlash', aperture: { template: 'C', paramsMm: [0.254] }, xMm: 25.4, yMm: 12.7 });
  const o = ed.image.objects[sel[0]];
  assert.ok(near(o.x, 25.4) && near(o.y, 12.7) && near(o.ap.dia, 0.254));
  assert.equal(o.ap.code, 10, 'the identical existing aperture is reused');
  assertWritesBack(ed);
});

test('step and repeat copies cannot be edited one by one', () => {
  const ed = gerberEditor(g('%ADD10C,0.5*%', 'D10*', '%SRX2Y1I5J0*%', 'X0Y0D03*', '%SR*%'));
  assert.match(ed.target(0).error, /step and repeat/);
  assert.throws(() => ed.apply({ type: 'delete', targets: [3] }), EditError);
});

test('a failed op changes nothing', () => {
  const ed = gerberEditor(BOARD);
  const before = ed.commands;
  assert.throws(() => ed.apply({ type: 'addFlash', aperture: { code: 99 }, xMm: 0, yMm: 0 }), /not defined/);
  assert.equal(ed.commands, before);
  assert.equal(ed.ops.length, 0);
});

test('undo and redo step through the edits', () => {
  const ed = gerberEditor(BOARD);
  const orig = ed.image;
  ed.apply({ type: 'delete', targets: [targetOf(ed, 0)] });
  const afterDelete = ed.image;
  ed.apply({ type: 'move', targets: [targetOf(ed, 0)], dxMm: 1, dyMm: 1 });
  const afterMove = ed.image;
  assert.ok(ed.undo());
  assertSameImage(afterDelete, ed.image, 'undo move');
  assert.ok(ed.undo());
  assertSameImage(orig, ed.image, 'undo delete');
  assert.equal(ed.undo(), false);
  ed.redo();
  ed.redo();
  assertSameImage(afterMove, ed.image, 'redo both');
  // a new edit clears the redo list
  ed.undo();
  ed.apply({ type: 'addFlash', aperture: { code: 10 }, xMm: 9, yMm: 9 });
  assert.equal(ed.canRedo, false);
});

test('undo works past the states kept in memory', () => {
  const ed = gerberEditor(BOARD);
  const orig = ed.image;
  for (let k = 0; k < 60; k++) ed.apply({ type: 'move', targets: [targetOf(ed, 0)], dxMm: 0.01, dyMm: 0 });
  assert.ok(near(ed.image.objects[0].x, 0.6));
  for (let k = 0; k < 59; k++) ed.undo();
  assert.ok(near(ed.image.objects[0].x, 0.01));
  ed.undo();
  assertSameImage(orig, ed.image, 'all undone');
});

test('replaying stored ops rebuilds the same file', () => {
  const ed = gerberEditor(BOARD);
  ed.apply({ type: 'move', targets: [targetOf(ed, 4)], dxMm: -1, dyMm: 0 });
  ed.apply({ type: 'addTrack', aperture: { code: 10 }, pointsMm: [0, 0, 0, 3] });
  ed.apply({ type: 'delete', targets: [targetOf(ed, 0)] });
  ed.undo();
  const rec = JSON.parse(JSON.stringify(ed.record(new Uint8Array([1]))));
  const again = gerberEditor(BOARD);
  again.load(rec);
  assert.equal(again.write(), ed.write());
  assert.equal(again.redoOps.length, 1);
});

// ---------------------------------------------------------------- regions

test('a round pad becomes an exact circular region (arcs kept)', () => {
  const ed = gerberEditor(g('%ADD10C,1*%', 'D10*', 'X0Y0D03*'));
  const orig = ed.image;
  const sel = ed.apply({ type: 'toRegion', targets: [targetOf(ed, 0)] });
  const r = ed.image.objects[sel[0]];
  assert.equal(r.k, 'R');
  assert.equal(ed.image.objects.length, 1);
  // the interpreter flattens region arcs within 0.5 µm
  assert.ok(Math.abs(contoursArea(r.contours) - Math.PI * 0.25) < 2e-3);
  const { text } = assertWritesBack(ed);
  assert.match(text, /G75\*/);
  assert.match(text, /G03\*/);
  assertSameArea(orig, ed.image);
});

test('round and rectangular tracks and arcs become regions that cover the same area', () => {
  const ed = gerberEditor(
    g(
      '%ADD10C,0.3*%',
      '%ADD11R,0.4X0.2*%',
      '%ADD12O,1X0.5*%',
      'D10*',
      'X0Y0D02*',
      'X3000000Y1000000D01*',
      'G75*',
      'X6000000Y0D02*',
      'G03X4000000Y0I-1000000J0D01*',
      'G01*',
      'D11*',
      'X0Y3000000D02*',
      'X2000000Y4000000D01*',
      'D12*',
      'X5000000Y4000000D03*',
    ),
  );
  const orig = ed.image;
  const targets = ed.image.objects.map((_, i) => targetOf(ed, i));
  ed.apply({ type: 'toRegion', targets });
  assert.deepEqual(
    ed.image.objects.map((o) => o.k),
    ['R', 'R', 'R', 'R'],
  );
  assertSameArea(orig, ed.image);
  assertWritesBack(ed);
});

test('overlapping pads and tracks are unified into one outline', () => {
  const ed = gerberEditor(
    g('%ADD10C,1*%', '%ADD11C,0.3*%', 'D10*', 'X0Y0D03*', 'X3000000Y0D03*', 'D11*', 'X0Y0D02*', 'X3000000Y0D01*'),
  );
  const orig = ed.image;
  const sel = ed.apply({ type: 'toRegion', targets: ed.image.objects.map((_, i) => targetOf(ed, i)) });
  assert.equal(ed.image.objects.length, 1);
  assert.equal(sel.length, 1);
  assertSameArea(orig, ed.image);
  assertWritesBack(ed);
});

test('a ring of tracks becomes one region with a cut-in hole; objects inside the hole stay', () => {
  const ed = gerberEditor(
    g(
      '%ADD10C,0.2*%',
      'D10*',
      'X2500000Y2500000D03*', // stays: inside the hole
      'X0Y0D02*',
      'X5000000Y0D01*',
      'X5000000Y5000000D01*',
      'X0Y5000000D01*',
      'X0Y0D01*',
    ),
  );
  const orig = ed.image;
  ed.apply({ type: 'toRegion', targets: [1, 2, 3, 4].map((i) => targetOf(ed, i)) });
  assert.deepEqual(
    ed.image.objects.map((o) => o.k),
    ['F', 'R'],
  );
  const r = ed.image.objects[1];
  assert.equal(r.contours.length, 1, 'hole joined by a cut-in');
  assertSameArea(orig, ed.image);
  assertWritesBack(ed);
});

test('converting is refused when a clear object between the selection would erase differently', () => {
  const ed = gerberEditor(g('%ADD10C,1*%', 'D10*', 'X0Y0D03*', '%LPC*%', 'X0Y0D03*', '%LPD*%', 'X500000Y0D03*'));
  assert.throws(() => ed.apply({ type: 'toRegion', targets: [targetOf(ed, 0), targetOf(ed, 2)] }), /clear/);
  assert.throws(() => ed.apply({ type: 'toRegion', targets: [targetOf(ed, 1)] }), /Clear/);
});

test('unify layer: the whole image as regions, clear polarity resolved', () => {
  const ed = gerberEditor(
    g(
      '%TF.FileFunction,Copper,L1,Top*%',
      '%ADD10C,1*%',
      '%ADD11C,0.4*%',
      '%AMTHERM*7,0,0,1.6,1.0,0.3,0*%',
      '%ADD12THERM*%',
      'D10*',
      'X0Y0D03*',
      'X800000Y0D03*',
      '%LPC*%',
      'D11*',
      'X0Y0D03*',
      '%LPD*%',
      'D12*',
      'X5000000Y0D03*',
      '%SRX1Y3I0J3*%',
      'D11*',
      'X0Y6000000D03*',
      '%SR*%',
    ),
  );
  const orig = ed.image;
  ed.apply({ type: 'unifyLayer' });
  assert.ok(ed.image.objects.every((o) => o.k === 'R' && o.dark));
  assert.ok(ed.image.objects.length >= 4 + 3); // pads, 4 thermal spokes, 3 copies
  assert.deepEqual(ed.image.fileAttributes['.FileFunction'], ['Copper', 'L1', 'Top']);
  assertSameArea(orig, ed.image);
  const { text } = assertWritesBack(ed);
  assert.doesNotMatch(text, /%AD|%LPC/);
  ed.undo();
  assertSameImage(orig, ed.image, 'undo unify');
});

test('unify a real board layer', () => {
  const ed = gerberEditor(bytes(join(SAMPLES, 'arduino-uno/arduino-uno.cmp')));
  const orig = ed.image;
  ed.apply({ type: 'unifyLayer' });
  assert.ok(ed.image.objects.every((o) => o.k === 'R'));
  assertSameArea(orig, ed.image, 1e-4);
  assertWritesBack(ed);
});
