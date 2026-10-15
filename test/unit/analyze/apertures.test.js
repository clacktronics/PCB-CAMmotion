import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { gerber, drill, bytes, FIXTURES, SYNTH, g, near } from '../../helpers.js';
import {
  apertureTable,
  apertureArea,
  imageStats,
  objectsWithAperture,
  describeAperture,
  apertureLines,
} from '../../../src/analyze/apertures.js';

const fx = (name) => gerber(bytes(join(FIXTURES, 'gerber', name)));
const row = (rows, code) => rows.find((r) => r.code === code);

test('aperture table: shapes, sizes and exact areas of the standard apertures', () => {
  const { image, parsed } = fx('analyser-apertures.gbr');
  const rows = apertureTable(image, parsed.commands);
  assert.deepEqual(
    rows.map((r) => r.label),
    ['D10', 'D11', 'D12', 'D13', 'D14', 'D15', 'D16'],
  );
  const expectArea = {
    10: Math.PI * 0.25 ** 2,
    11: 2,
    12: 2 - (4 - Math.PI) * 0.25,
    13: 3 * Math.sin(Math.PI / 3), // hexagon, circumradius 1
    14: Math.PI * (0.25 - 0.04),
    16: Math.PI * 0.125 ** 2,
  };
  for (const [code, area] of Object.entries(expectArea)) {
    const r = row(rows, Number(code));
    assert.ok(near(r.areaMm2, area, 1e-12), `D${code}: ${r.areaMm2} vs ${area}`);
    assert.equal(r.areaExact, true);
  }
  // the macro is measured on a raster: a 2 × 2 mm square
  const macro = row(rows, 15);
  assert.equal(macro.areaExact, false);
  assert.ok(Math.abs(macro.areaMm2 - 4) < 0.02, String(macro.areaMm2));
  assert.equal(macro.kind, 'macro');
  assert.deepEqual([row(rows, 11).widthMm, row(rows, 11).heightMm], [1, 2]);
  assert.ok(near(row(rows, 13).heightMm, Math.sqrt(3), 1e-9));
  assert.equal(row(rows, 11).description, 'rectangle 1 × 2 mm');
  assert.equal(row(rows, 14).description, 'circle ⌀1 mm, hole ⌀0.4');
  assert.equal(row(rows, 13).description, 'polygon 6-gon ⌀2 mm');
  assert.equal(row(rows, 15).line, 11);
});

test('aperture table: flashes, draws, arcs, clear uses and drawn length', () => {
  const { image, parsed } = fx('analyser-apertures.gbr');
  const rows = apertureTable(image, parsed.commands);
  const d10 = row(rows, 10);
  assert.deepEqual([d10.flashes, d10.draws, d10.arcs, d10.uses], [0, 2, 1, 3]);
  // two lines (10 + 5 mm) and a quarter circle of radius 5
  assert.ok(near(d10.lengthMm, 15 + (5 * Math.PI) / 2, 1e-9));
  assert.equal(d10.firstUseLine, 15);
  const d11 = row(rows, 11);
  assert.deepEqual([d11.flashes, d11.uses, d11.clear], [3, 3, 1]);
  for (const c of [12, 13, 14, 15]) assert.equal(row(rows, c).flashes, 1, `D${c}`);
  const unused = row(rows, 16);
  assert.equal(unused.uses, 0);
  assert.equal(unused.firstUseLine, null);
  assert.deepEqual(objectsWithAperture(image, 11).length, 3);
  assert.deepEqual(objectsWithAperture(image, null).length, 1); // the region
});

test('shape statistics: objects by kind and polarity, smallest features, region area', () => {
  const { image } = fx('analyser-apertures.gbr');
  const s = imageStats(image);
  assert.equal(s.objects, 11);
  assert.deepEqual([s.flashes, s.draws, s.arcs, s.regions], [7, 2, 1, 1]);
  assert.deepEqual([s.dark, s.clear], [10, 1]);
  assert.ok(near(s.drawLengthMm, 15 + (5 * Math.PI) / 2, 1e-9));
  assert.equal(s.minDrawWidthMm, 0.5);
  assert.equal(s.maxDrawWidthMm, 0.5);
  assert.equal(s.minFlashMm, 1);
  assert.equal(s.maxFlashMm, 2);
  assert.deepEqual([s.regionContours, s.regionVertices], [1, 4]);
  assert.ok(near(s.regionAreaMm2, 12, 1e-9));
  assert.deepEqual([s.aperturesDefined, s.aperturesUsed], [7, 6]);
});

test('step and repeat copies count once per copy', () => {
  const { image, parsed } = fx('step-repeat-3x2.gbr');
  const [d10] = apertureTable(image, parsed.commands);
  assert.equal(d10.flashes, 6);
  assert.equal(imageStats(image).flashes, 6);
});

test('aperture blocks: block row counts its flashes, contents count their apertures', () => {
  const { image, parsed } = fx('block-clear-polarity.gbr');
  const rows = apertureTable(image, parsed.commands);
  const block = row(rows, 100);
  assert.equal(block.kind, 'block');
  assert.equal(block.flashes, 1);
  assert.equal(block.description, 'block of 2 objects');
  assert.equal(row(rows, 11).flashes, 2); // the two flashes inside the block
  assert.equal(row(rows, 10).flashes, 1);
  // block area: two 2 × 2 squares, one of them clear (it erases nothing under it)
  assert.ok(Math.abs(apertureArea(image.apertures.get(100)).areaMm2 - 4) < 0.03);
});

test('inch apertures are reported in mm', () => {
  const { image } = gerber(['%FSLAX25Y25*%', '%MOIN*%', '%ADD10C,0.1*%', 'D10*', 'X0Y0D03*', 'M02*'].join('\n'));
  const [d10] = apertureTable(image);
  assert.ok(near(d10.widthMm, 2.54, 1e-12));
  assert.equal(describeAperture(image.apertures.get(10)), 'circle ⌀2.54 mm');
});

test('drill tools: holes, slots and routed length per tool', () => {
  const { image, parsed } = drill(bytes(join(SYNTH, 'drill-valid/slots-g85.drl')));
  const rows = apertureTable(image, parsed.commands);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.label.startsWith('T') && r.kind === 'C'));
  const holes = rows.reduce((a, r) => a + r.flashes, 0);
  const slots = rows.reduce((a, r) => a + r.draws + r.arcs, 0);
  assert.equal(holes, image.stats.holes);
  assert.equal(slots, image.stats.slots);
  assert.ok(rows.some((r) => r.lengthMm > 0));
});

test('empty and drawing-only images give sensible statistics', () => {
  const { image } = gerber(g('%ADD10C,0.1*%'));
  const s = imageStats(image);
  assert.equal(s.objects, 0);
  assert.equal(s.minDrawWidthMm, null);
  assert.equal(s.minFlashMm, null);
  assert.equal(apertureTable(image)[0].uses, 0);
});

test('short gallery labels: what it is, then its size, each line short', () => {
  const { image } = fx('analyser-apertures.gbr');
  const lines = (code) => apertureLines(image.apertures.get(code));
  assert.deepEqual(lines(10), ['circle', '⌀0.5 mm']);
  assert.deepEqual(lines(11), ['rectangle', '1 × 2 mm']);
  assert.deepEqual(lines(12), ['obround', '1 × 2 mm']);
  assert.deepEqual(lines(13), ['6-gon', '⌀2 mm']);
  assert.deepEqual(lines(14), ['circle', '⌀1 mm', 'hole ⌀0.4']);
  assert.deepEqual(lines(15), ['SQUARE2', '2 × 2 mm']);
  const { image: blk } = fx('block-clear-polarity.gbr');
  assert.deepEqual(apertureLines(blk.apertures.get(100)), ['block', '2 objects']);
});
