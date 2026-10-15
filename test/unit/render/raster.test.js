// The pure-JS rasteriser runs the same drawImage code as the browser canvas.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthGerber, gerber, g } from '../../helpers.js';
import { rasterizeImage, Raster } from '../../../src/render/raster.js';
import { drawImage } from '../../../src/render/draw-image.js';

function xorDiff(a, b) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
  return n;
}

function render(image, bounds, pxPerMm) {
  const r = new Raster(Math.ceil((bounds[2] - bounds[0]) * pxPerMm), Math.ceil((bounds[3] - bounds[1]) * pxPerMm), {
    x0: bounds[0],
    y0: bounds[1],
    pxPerMm,
  });
  drawImage(image, r);
  return r;
}

test('single draw: area of a stadium', () => {
  const { image } = gerber(g('%ADD10C,0.2*%', 'D10*', 'X0Y0D02*', 'X10000000Y0D01*'));
  const r = rasterizeImage(image, { pxPerMm: 100 });
  const want = 10 * 0.2 + Math.PI * 0.01;
  assert.ok(Math.abs(r.areaMm2() - want) / want < 0.01, `${r.areaMm2()}`);
});

test('200 alternating polarity levels', () => {
  const { image } = synthGerber('gerber-valid/polarity-200-levels.gbr');
  let want = 0;
  for (let i = 0; i < 200; i += 2) {
    const s0 = 50 - i * 0.24;
    const s1 = 50 - (i + 1) * 0.24;
    want += s0 * s0 - s1 * s1;
  }
  want += Math.PI * 0.25 * 0.25; // final dark ⌀0.5 flash inside the clear centre
  const r = rasterizeImage(image, { pxPerMm: 20 });
  assert.ok(Math.abs(r.areaMm2() - want) / want < 0.005, `${r.areaMm2()} vs ${want}`);
});

test('mm and inch versions of a board rasterise identically', () => {
  const a = synthGerber('board/synthetic-board-B_Cu.gbr').image;
  const b = synthGerber('board-variants/B_Cu-in-inches.gbr').image;
  const bounds = [0, 0, 100, 80];
  const diff = xorDiff(render(a, bounds, 20), render(b, bounds, 20));
  assert.ok(diff <= 20, `${diff} differing pixels`);
});

test('CRLF variant rasterises identically; misaligned variant differs', () => {
  const bounds = [0, 0, 100, 80];
  const lf = render(synthGerber('board/synthetic-board-F_Cu.gbr').image, bounds, 10);
  const crlf = render(synthGerber('board-variants/F_Cu-crlf.gbr').image, bounds, 10);
  const mis = render(synthGerber('board-variants/F_Cu-misaligned-0.2mm.gbr').image, bounds, 10);
  assert.equal(xorDiff(lf, crlf), 0);
  assert.ok(xorDiff(lf, mis) > 1000);
});

test('standard aperture holes are see-through, not clearing', () => {
  const { image } = gerber(g('%ADD10R,4X4*%', '%ADD11C,3X1*%', 'D10*', 'X0Y0D03*', 'D11*', 'X0Y0D03*'));
  const r = rasterizeImage(image, { pxPerMm: 50 });
  assert.equal(r.at(0, 0), 1, 'square below shows through the hole');
  const { image: alone } = gerber(g('%ADD11C,3X1*%', 'D11*', 'X0Y0D03*'));
  assert.equal(rasterizeImage(alone, { pxPerMm: 50 }).at(0, 0), 0, 'hole is empty on its own');
});

test('regions-complex: arc edge, cut-in hole, 100 contours, touching squares', () => {
  const { image } = synthGerber('gerber-valid/regions-complex.gbr');
  const r = rasterizeImage(image, { pxPerMm: 20 });
  assert.equal(r.at(14.5, 5), 1, 'inside the arc bulge');
  assert.equal(r.at(25, 5), 0, 'cut-in hole');
  assert.equal(r.at(40.7, 0.7), 1, 'first of 100 contours');
  assert.equal(r.at(41.7, 0.7), 0, 'gap between contours');
  assert.equal(r.at(72, 2), 1);
  assert.equal(r.at(77, 7), 1);
});

test('step and repeat panel renders 400 copies', () => {
  const { image } = synthGerber('gerber-valid/step-repeat-panel.gbr');
  const r = rasterizeImage(image, { pxPerMm: 20 });
  // one copy: a 0.3 mm line from (0,0) to (2,1) and a 1×0.5 pad at (1,0.5)
  const one = rasterizeImage(synthGerber('gerber-valid/step-repeat-panel.gbr').image, {
    pxPerMm: 20,
    bounds: [-0.6, -0.6, 2.4, 1.4],
    marginMm: 0,
  });
  assert.ok(Math.abs(r.count() - 400 * one.count()) / r.count() < 0.01);
});

test('huge and tiny coordinates stay finite', () => {
  for (const p of [
    'gerber-valid/physically-huge-1m.gbr',
    'gerber-valid/far-from-origin-negative.gbr',
    'gerber-valid/zero-and-tiny-features.gbr',
  ]) {
    const r = rasterizeImage(synthGerber(p).image, { pxPerMm: 2, maxPixels: 4e6 });
    assert.ok(r.count() >= 0);
  }
});
