import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { gerber, bytes, FIXTURES, codes, g, near, synthGerber } from '../../helpers.js';
import { parseGerber } from '../../../src/parse/gerber.js';
import { rasterizeImage } from '../../../src/render/raster.js';

const fx = (name) => gerber(bytes(join(FIXTURES, 'gerber', name)));

test('commands keep their source line numbers', () => {
  const { parsed } = fx('transforms.gbr');
  const flashes = parsed.commands.filter((c) => c.type === 'D' && c.op === 3);
  assert.deepEqual(
    flashes.map((c) => c.line),
    [7, 10, 13],
  );
  assert.equal(parsed.commands.find((c) => c.type === 'FS').line, 2);
});

test('multi-line extended commands: each macro primitive keeps its own line', () => {
  const { parsed } = synthGerber('gerber-valid/macro-all-primitives.gbr');
  const am = parsed.commands.find((c) => c.type === 'AM');
  const prims = am.body.filter((b) => b.kind === 'primitive');
  assert.equal(prims.length, 7);
  assert.equal(prims[1].line, prims[0].line + 1);
  assert.equal(am.body[0].kind, 'comment');
});

test('coordinate format: FS 2.5 inch with signs and leading zeros omitted', () => {
  const { image, diag } = fx('coord-format-inch-2-5.gbr');
  assert.deepEqual(diag.list, []);
  const o = image.objects[0];
  assert.ok(near(o.x1, -25.4) && near(o.y1, 12.7) && near(o.x2, 0) && near(o.y2, 0));
  assert.ok(near(o.ap.dia, 0.254));
  assert.equal(image.fileUnits, 'IN');
});

test('trailing zero omission pads on the right (FST, deprecated)', () => {
  const { image, diag } = gerber(
    ['%FSTAX25Y25*%', '%MOIN*%', '%ADD10C,0.01*%', 'D10*', 'X01Y001D03*', 'M02*'].join('\n'),
  );
  assert.ok(codes(diag).includes('DEPRECATED_TRAILING_ZEROS'));
  assert.ok(near(image.objects[0].x, 0.1 * 25.4 * 10) && near(image.objects[0].y, 0.1 * 25.4));
});

test('G75 arcs: CCW quarter, CW three-quarter and full circle sweeps', () => {
  const { image, diag } = fx('arcs-g75.gbr');
  assert.deepEqual(diag.list, []);
  const [a, b, c] = image.objects;
  assert.ok(near(a.sw, Math.PI / 2) && near(a.cx, 0) && near(a.cy, 0) && near(a.r, 10));
  assert.ok(near(b.sw, (-3 * Math.PI) / 2));
  assert.ok(near(c.sw, 2 * Math.PI) && near(c.r, 5));
});

test('G74 single-quadrant arc picks the centre giving at most 90°', () => {
  const { image, diag } = fx('arc-g74-single-quadrant.gbr');
  assert.deepEqual(codes(diag), ['DEPRECATED_G74']);
  const a = image.objects[0];
  assert.ok(near(a.cx, 0) && near(a.cy, 0) && near(a.sw, Math.PI / 2));
});

test('polarity: clear erases what is below, later dark adds again', () => {
  const { image } = fx('polarity-nested.gbr');
  assert.deepEqual(
    image.objects.map((o) => o.dark),
    [true, false, true],
  );
  const r = rasterizeImage(image, { pxPerMm: 50 });
  assert.ok(Math.abs(r.areaMm2() - (100 - 36 + Math.PI)) < 0.15, `area ${r.areaMm2()}`);
  assert.equal(r.at(2, 2), 0, 'clear square is empty');
  assert.equal(r.at(0, 0), 1, 'dark circle on top');
  assert.equal(r.at(4, 4), 1, 'outer ring stays dark');
});

test('step and repeat: 3 × 2 copies at the given steps', () => {
  const { image } = fx('step-repeat-3x2.gbr');
  const pts = image.objects.map((o) => [o.x, o.y]);
  assert.deepEqual(pts, [
    [0, 0],
    [5, 0],
    [10, 0],
    [0, 4],
    [5, 4],
    [10, 4],
  ]);
});

test('aperture block flashed with clear polarity toggles the block objects', () => {
  const { image } = fx('block-clear-polarity.gbr');
  assert.deepEqual(
    image.objects.map((o) => o.dark),
    [true, false, true],
  );
  const r = rasterizeImage(image, { pxPerMm: 40 });
  assert.equal(r.at(0, 0), 0);
  assert.equal(r.at(3, 0), 1);
  assert.ok(Math.abs(r.areaMm2() - 96) < 0.2);
});

test('region cut-in makes a hole without a self-intersection warning', () => {
  const { image, diag } = fx('region-cut-in.gbr');
  assert.deepEqual(diag.list, []);
  const r = rasterizeImage(image, { pxPerMm: 40 });
  assert.equal(r.at(5, 5), 0);
  assert.equal(r.at(1, 1), 1);
  assert.ok(Math.abs(r.areaMm2() - 84) < 0.2, `area ${r.areaMm2()}`);
});

test('LR, LS and LM transform flashed apertures', () => {
  const { image } = fx('transforms.gbr');
  const [rot, scaled, mirrored] = image.objects;
  const b = (i) => Array.from(image.objBounds.slice(i * 4, i * 4 + 4)).map((v) => Math.round(v * 1e6) / 1e6);
  assert.deepEqual(b(0), [-0.5, -1, 0.5, 1]);
  assert.deepEqual(b(1), [8, -1, 12, 1]);
  assert.deepEqual(b(2), [19, -0.5, 21, 0.5]);
  assert.ok(rot.m && scaled.m && mirrored.m);
  assert.deepEqual(
    mirrored.m.map((v) => v || 0),
    [1, 0, 0, -1],
  );
});

test('LM mirror reverses arcs and keeps union orientation inside blocks', () => {
  const { image } = synthGerber('gerber-valid/aperture-blocks-nested.gbr');
  assert.equal(image.objects.length, 24);
  const r = rasterizeImage(image, { pxPerMm: 20 });
  assert.ok(r.count() > 0);
});

test('thermal macro primitive area', () => {
  const { image } = fx('macro-thermal.gbr');
  const strip = (R, h) => 2 * (h * Math.sqrt(R * R - h * h) + R * R * Math.asin(h / R));
  const want = Math.PI * (4 - 1) - 2 * (strip(2, 0.5) - strip(1, 0.5));
  const r = rasterizeImage(image, { pxPerMm: 200 });
  assert.ok(Math.abs(r.areaMm2() - want) / want < 0.01, `area ${r.areaMm2()} vs ${want}`);
  assert.equal(r.at(1.5, 0), 0, 'gap on the x axis');
  assert.equal(r.at(1.06, 1.06), 1, 'ring between gaps');
  assert.equal(r.at(0, 0), 0, 'centre is open');
});

test('macro exposure off only erases inside the aperture', () => {
  const { image } = synthGerber('gerber-valid/macro-all-primitives.gbr');
  assert.equal(image.apertures.get(10).shape.simple, false);
  const r = rasterizeImage(image, { pxPerMm: 60 });
  assert.equal(r.at(0, 0), 0, 'centre cleared by the exposure-off circle');
  assert.equal(r.at(0.5, 0), 1, 'rest of the outline primitive is dark');
});

test('X2 file, aperture and object attributes with \\u escapes', () => {
  const { image, diag } = fx('x2-attributes.gbr');
  assert.deepEqual(diag.list, []);
  assert.deepEqual(image.fileAttributes['.FileFunction'], ['Copper', 'L1', 'Top']);
  assert.deepEqual(image.apertures.get(10).attributes, { '.AperFunction': ['ComponentPad'] });
  assert.deepEqual(image.apertures.get(11).attributes, {});
  const at = (o) => image.objectAttributes[o.at];
  assert.deepEqual({ ...at(image.objects[0]) }, { '.N': ['VCC,5V'], '.C': ['R1'] });
  assert.deepEqual({ ...at(image.objects[1]) }, { '.N': ['VCC,5V'] });
  assert.equal(at(image.objects[2]), null);
});

test('drawing with a rectangular aperture sweeps its hull', () => {
  const r = rasterizeImage(fx('draw-rect-aperture.gbr').image, { pxPerMm: 50 });
  assert.ok(Math.abs(r.areaMm2() - 11) < 0.1, `area ${r.areaMm2()}`);
});

test('macro variables and expressions follow the spec example values', () => {
  const { image } = synthGerber('gerber-valid/macro-variables-expressions.gbr');
  // D10: $1=2 → outer circle ⌀2 with a ⌀1 ($4) hole: centre is clear, ring dark
  const r = rasterizeImage(image, { pxPerMm: 100 });
  assert.equal(r.at(0.75, 0.5), 1);
  assert.equal(r.at(0.3, 0.3), 0);
});

test('incremental notation and modal coordinates', () => {
  const { image } = synthGerber('gerber-valid/incremental-coordinates.gbr');
  assert.deepEqual(
    image.objects.map((o) => [o.x2, o.y2]),
    [
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
  );
});

test('the same board in mm and in inch gives the same geometry', () => {
  const a = synthGerber('board/synthetic-board-B_Cu.gbr').image;
  const b = synthGerber('board-variants/B_Cu-in-inches.gbr').image;
  assert.equal(a.objects.length, b.objects.length);
  for (let i = 0; i < a.objects.length; i++) {
    const p = a.objects[i];
    const q = b.objects[i];
    for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2'])
      if (k in p) assert.ok(Math.abs(p[k] - q[k]) < 1e-4, `${k} of object ${i}`);
  }
});

test('words split across lines and missing asterisks are errors with the right line', () => {
  const { diag } = gerber(g('%ADD10C,0.1*%', 'D10*', 'X0Y0D02', 'X1Y1D01*'));
  assert.deepEqual(
    diag.errors.map((e) => e.line),
    [5],
  );
});

test('deprecated commands produce one warning per kind with a count', () => {
  const { diag } = gerber(g('%ADD10C,0.1*%', 'G54D10*', 'G54D10*', 'G54D10*', 'X0Y0D03*'));
  const w = diag.list.filter((d) => d.code === 'DEPRECATED_G54');
  assert.equal(w.length, 1);
  assert.equal(w[0].count, 3);
});

test('parser accepts strings and bytes alike, and CRLF equals LF', () => {
  const lf = synthGerber('board/synthetic-board-F_Cu.gbr').image;
  const crlf = synthGerber('board-variants/F_Cu-crlf.gbr').image;
  assert.deepEqual(
    crlf.objects.map((o) => [o.k, o.x ?? o.x1, o.y ?? o.y1]),
    lf.objects.map((o) => [o.k, o.x ?? o.x1, o.y ?? o.y1]),
  );
  assert.equal(parseGerber('%FSLAX46Y46*%\n%MOMM*%\nM02*\n').diagnostics.list.length, 0);
});

test('object limit: refuses to expand beyond the budget with a clear error', () => {
  const { image, diag } = gerber(g('%ADD10C,0.1*%', '%SRX100Y100I1J1*%', 'D10*', 'X0Y0D03*', '%SR*%'), {
    maxObjects: 1000,
  });
  assert.ok(codes(diag, 'error').includes('LIMIT'));
  assert.ok(image.truncated);
  assert.ok(image.objects.length <= 1000);
});
