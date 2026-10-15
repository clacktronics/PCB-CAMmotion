import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { drill, bytes, FIXTURES, codes, near, synthDrill } from '../../helpers.js';

const fx = (name) => drill(bytes(join(FIXTURES, 'drill', name)));

test('explicit METRIC,TZ,000.000 format: leading zeros omitted, implied decimals', () => {
  const { image, diag } = fx('metric-tz-implied.drl');
  assert.deepEqual(diag.list, []);
  const h = image.objects.map((o) => [o.x, o.y]);
  assert.ok(near(h[0][0], 10) && near(h[0][1], 20));
  assert.ok(near(h[1][0], -0.005) && near(h[1][1], 0.005));
});

test('inch decimal coordinates and tool sizes convert to mm', () => {
  const { image, diag } = fx('inch-decimal.drl');
  assert.deepEqual(diag.list, []);
  assert.ok(near(image.apertures.get(1).dia, 1.016));
  assert.ok(near(image.objects[1].x, 50.8) && near(image.objects[1].y, 25.4));
});

test('routed slot with a G02 arc given by I/J', () => {
  const { image, diag } = fx('route-arc-ij.drl');
  assert.deepEqual(diag.list, []);
  assert.equal(image.stats.routes, 1);
  const [line, arc] = image.objects;
  assert.equal(line.k, 'L');
  assert.equal(arc.k, 'A');
  assert.ok(near(arc.cx, 15) && near(arc.cy, 0) && near(arc.r, 5) && near(arc.sw, -Math.PI));
});

test('G85 slots and R repeat codes', () => {
  const slots = synthDrill('drill-valid/slots-g85.drl').image;
  assert.deepEqual(
    slots.objects.map((o) => [o.x1, o.y1, o.x2, o.y2]),
    [
      [10, 10, 14, 10],
      [10, 20, 10, 25],
      [20, 10, 24, 14],
    ],
  );
  const rep = synthDrill('drill-valid/repeat-codes.drl').image;
  const xs = rep.objects.slice(0, 10).map((o) => Math.round(o.x * 100) / 100);
  assert.deepEqual(xs, [10, 12.54, 15.08, 17.62, 20.16, 22.7, 25.24, 27.78, 30.32, 32.86]);
});

test('routed slot with A radius picks the minor arc in the given direction', () => {
  const { image } = synthDrill('drill-valid/routed-slots-m15-m16.drl');
  const arc = image.objects.find((o) => o.k === 'A');
  assert.ok(near(arc.cx, 30) && near(arc.cy, 15) && near(arc.sw, Math.PI / 2));
});

test('KiCad X2 attributes in comments give the file function', () => {
  const { image } = synthDrill('board/synthetic-board-NPTH.drl');
  assert.deepEqual(image.fileAttributes['.FileFunction'], ['NonPlated', '1', '2', 'NPTH']);
});

test('Eagle-style files with units before M48 parse without errors', () => {
  const { image, diag } = drill(
    ['INCH,TZ', '%', 'M48', 'M72', 'T01C0.0200', '%', 'T01', 'X7536Y4995', 'M30'].join('\n'),
  );
  assert.deepEqual(codes(diag, 'error'), []);
  assert.ok(near(image.objects[0].x, 0.7536 * 25.4));
});

test('routes without M15/M16 are assumed to cut, with a warning', () => {
  const { image, diag } = drill(['M48', 'METRIC', 'T1C1.0', '%', 'T1', 'G00X0Y0', 'G01X10.0Y0', 'M30'].join('\n'));
  assert.ok(codes(diag).includes('ROUTE_WITHOUT_PLUNGE'));
  assert.equal(image.objects.length, 1);
});

test('hits keep their source line', () => {
  const { image } = fx('metric-tz-implied.drl');
  assert.deepEqual(
    image.objects.map((o) => o.ln),
    [6, 7],
  );
});
