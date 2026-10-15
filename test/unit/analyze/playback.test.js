import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { gerber, bytes, FIXTURES } from '../../helpers.js';
import { visibleObjects, playbackState, nextStep, stepForObject, clampStep } from '../../../src/analyze/playback.js';
import { Raster, rasterizeImage } from '../../../src/render/raster.js';
import { drawImage } from '../../../src/render/draw-image.js';

const fx = (name) => gerber(bytes(join(FIXTURES, 'gerber', name)));

test('playback: objects appear command by command', () => {
  const { image, parsed } = fx('analyser-apertures.gbr');
  const n = parsed.commands.length;
  assert.equal(visibleObjects(image, 0), 0);
  assert.equal(visibleObjects(image, n), image.objects.length);
  assert.equal(visibleObjects(image, n + 10), image.objects.length);
  let prev = 0;
  for (let s = 0; s <= n; s++) {
    const v = visibleObjects(image, s);
    assert.ok(v >= prev);
    prev = v;
  }
  // the first draw: after it ran, one object, and the plotter head is at its end point
  const firstDraw = parsed.commands.findIndex((c) => c.type === 'D' && c.op === 1);
  const st = playbackState(image, firstDraw + 1);
  assert.equal(st.objects, 1);
  assert.equal(st.command, firstDraw);
  assert.deepEqual(st.current, [0, 1]);
  assert.deepEqual(st.head, [10, 0]);
  assert.deepEqual(playbackState(image, 0).head, null);
  assert.equal(playbackState(image, NaN).step, n);
});

test('stepping by command and by drawn object', () => {
  const { image, parsed } = fx('analyser-apertures.gbr');
  const n = parsed.commands.length;
  assert.equal(nextStep(image, 0, 1), 1);
  assert.equal(nextStep(image, 0, -1), 0);
  assert.equal(nextStep(image, n, 1), n);
  // by object: from the start, jump straight to the first command that draws
  const firstDraw = parsed.commands.findIndex((c) => c.type === 'D' && c.op === 1);
  assert.equal(nextStep(image, 0, 1, 'object'), firstDraw + 1);
  const s2 = nextStep(image, firstDraw + 1, 1, 'object');
  assert.equal(visibleObjects(image, s2), 2);
  assert.equal(nextStep(image, s2, -1, 'object'), firstDraw + 1);
  assert.equal(nextStep(image, firstDraw + 1, -1, 'object'), 0);
  // every object can be reached, and stepForObject lands on it
  for (let oi = 0; oi < image.objects.length; oi++) {
    const s = stepForObject(image, oi);
    assert.ok(visibleObjects(image, s) > oi && visibleObjects(image, s - 1) <= oi);
  }
  assert.equal(clampStep(-5, n), 0);
});

test('drawing in steps gives the same picture as drawing at once (clear polarity included)', () => {
  for (const name of ['polarity-nested.gbr', 'analyser-apertures.gbr', 'block-clear-polarity.gbr']) {
    const { image } = fx(name);
    const whole = rasterizeImage(image, { pxPerMm: 10 });
    const b = image.bounds;
    const map = { x0: b[0] - 0.5, y0: b[1] - 0.5, pxPerMm: whole.s };
    const stepped = new Raster(whole.width, whole.height, map);
    const n = image.objects.length;
    for (let a = 0; a < n; a += 2) drawImage(image, stepped, { from: a, limit: Math.min(n, a + 2) });
    let diff = 0;
    for (let i = 0; i < whole.data.length; i++) if (whole.data[i] !== stepped.data[i]) diff++;
    assert.equal(diff, 0, name);
  }
});
