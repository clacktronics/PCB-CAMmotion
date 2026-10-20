import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { joinHoles, validContour } from '../../../src/edit/cut-ins.js';
import { booleanOp, nestPolygons, contoursArea } from '../../../src/model/polygons.js';
import { signedArea } from '../../../src/model/path.js';

const rect = (x0, y0, x1, y1, ccw = true) =>
  ccw ? [x0, y0, x1, y0, x1, y1, x0, y1] : [x0, y0, x0, y1, x1, y1, x1, y0];

test('a square with two holes becomes one valid contour with the same area', () => {
  const outer = rect(0, 0, 10, 10);
  const holes = [rect(2, 2, 4, 4, false), rect(6, 5, 8, 8, false)];
  const c = joinHoles(outer, holes);
  assert.ok(validContour(c));
  assert.ok(Math.abs(signedArea(c) - (100 - 4 - 6)) < 1e-9);
});

test('random grids of holes always join into valid contours (property)', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(fc.integer({ min: 0, max: 8 }), fc.integer({ min: 0, max: 8 }), fc.integer({ min: 0, max: 3 })),
        {
          minLength: 1,
          maxLength: 25,
        },
      ),
      (cells) => {
        // holes: small squares and diamonds on a grid inside a 20 × 20 square
        const holes = cells.map(([i, j, kind]) => {
          const x = 1 + i * 2;
          const y = 1 + j * 2;
          return kind === 0
            ? [x + 0.5, y, x, y + 0.5, x + 0.5, y + 1, x + 1, y + 0.5]
            : rect(x, y, x + 1, y + 1, false);
        });
        const polys = nestPolygons(booleanOp('difference', [rect(0, 0, 20, 20)], holes));
        for (const { outer, holes: hs } of polys) {
          const c = hs.length ? joinHoles(outer, hs) : outer;
          assert.ok(validContour(c));
          assert.ok(Math.abs(signedArea(c) - contoursArea([outer, ...hs])) < 1e-6);
        }
      },
    ),
    { numRuns: 200 },
  );
});
