// Compare two interpreted images object by object (round-trip tests: "never silently change
// geometry"). Stronger than a raster XOR: every coordinate must match within epsMm.
import assert from 'node:assert/strict';
import { rasterizeImage } from '../../src/render/raster.js';

const KEYS = { F: ['x', 'y'], L: ['x1', 'y1', 'x2', 'y2'], A: ['x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'a0', 'sw'] };

export function assertSameImage(a, b, label = '', epsMm = 1e-7) {
  assert.equal(b.objects.length, a.objects.length, `${label}: object count`);
  assert.equal(!!b.negative, !!a.negative, `${label}: image polarity`);
  for (let i = 0; i < a.objects.length; i++) {
    const p = a.objects[i];
    const q = b.objects[i];
    const where = `${label}: object ${i} (line ${p.ln})`;
    assert.equal(q.k, p.k, `${where}: kind`);
    assert.equal(q.dark, p.dark, `${where}: polarity`);
    for (const k of KEYS[p.k] || []) {
      const d = k === 'a0' ? angleDiff(p[k], q[k]) : Math.abs(p[k] - q[k]);
      assert.ok(d <= epsMm, `${where}: ${k} ${p[k]} vs ${q[k]}`);
    }
    if (p.k === 'R') {
      assert.equal(q.contours.length, p.contours.length, `${where}: contours`);
      p.contours.forEach((c, ci) => {
        assert.equal(q.contours[ci].length, c.length, `${where}: contour ${ci} vertices`);
        for (let j = 0; j < c.length; j++) assert.ok(Math.abs(c[j] - q.contours[ci][j]) <= epsMm, `${where}: vertex`);
      });
    } else {
      assert.deepEqual(roundM(q.m), roundM(p.m), `${where}: transform`);
      sameShape(p.ap, q.ap, where, epsMm);
    }
  }
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
}

function roundM(m) {
  return m ? m.map((v) => Math.round(v * 1e9) / 1e9) : null;
}

function sameShape(a, b, where, eps) {
  assert.equal(b.kind, a.kind, `${where}: aperture kind`);
  if (a.kind === 'block') return;
  assert.equal(b.shape.parts.length, a.shape.parts.length, `${where}: aperture parts`);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(a.shape.bbox[i] - b.shape.bbox[i]) <= eps, `${where}: aperture bbox`);
  a.shape.parts.forEach((p, i) => {
    const q = b.shape.parts[i];
    assert.equal(q.dark, p.dark, `${where}: part polarity`);
    assert.equal(q.path.length, p.path.length, `${where}: part path`);
    for (let j = 0; j < p.path.length; j++) assert.ok(Math.abs(p.path[j] - q.path[j]) <= eps, `${where}: path value`);
  });
}

/** Pixels that differ between two images rasterised over the same area (bounds of `a`). */
export function xorCount(a, b, pxPerMm = 40) {
  const bounds = a.bounds || b.bounds || [0, 0, 1, 1];
  const ra = rasterizeImage(a, { bounds, pxPerMm, maxPixels: 4e6 });
  const rb = rasterizeImage(b, { bounds, pxPerMm, maxPixels: 4e6 });
  let diff = 0;
  let set = 0;
  for (let i = 0; i < ra.data.length; i++) {
    if (ra.data[i]) set++;
    if (!!ra.data[i] !== !!rb.data[i]) diff++;
  }
  return { diff, set, pxPerMm: ra.s };
}
