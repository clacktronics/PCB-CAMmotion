// Reference-render consistency: the browser canvas renderer and the pure-JS rasteriser
// (used by the Node tests) run the same drawImage code; their pixels must agree up to
// anti-aliasing at edges.

import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openApp, ROOT } from './helpers.js';
import { loadFile } from '../../src/model/load-file.js';
import { Raster } from '../../src/render/raster.js';
import { drawImage } from '../../src/render/draw-image.js';

const files = [
  ...[
    'polarity-200-levels',
    'macro-all-primitives',
    'macro-variables-expressions',
    'regions-complex',
    'standard-apertures-all',
    'arcs',
    'transforms-lm-lr-ls',
    'aperture-blocks-nested',
    'step-repeat-panel',
  ].map((n) => `test/fixtures/synthetic/gerber-valid/${n}.gbr`),
  'test/fixtures/synthetic/board/synthetic-board-F_Cu.gbr',
  ...['macros', 'macro-primitives', 'pads', 'regions', 'arc-strokes', 'strokes'].flatMap((d) =>
    readdirSync(join(ROOT, 'test/fixtures/tracespace', d)).map((f) => `test/fixtures/tracespace/${d}/${f}`),
  ),
];

test.describe.configure({ mode: 'parallel' });

for (const rel of files) {
  test(`canvas matches the JS rasteriser: ${rel.replace('test/fixtures/', '')}`, async ({ page }) => {
    await openApp(page);
    const text = readFileSync(join(ROOT, rel), 'latin1');
    const { image } = loadFile(rel, new TextEncoder().encode(text));
    const b = image.bounds;
    const margin = 0.5;
    const wMm = b[2] - b[0] + 2 * margin;
    const hMm = b[3] - b[1] + 2 * margin;
    const pxPerMm = Math.min(400 / wMm, 400 / hMm);
    const map = {
      x0: b[0] - margin,
      y0: b[1] - margin,
      pxPerMm,
      width: Math.ceil(wMm * pxPerMm),
      height: Math.ceil(hMm * pxPerMm),
    };
    const r = new Raster(map.width, map.height, map);
    drawImage(image, r);
    const bits = await page.evaluate(([name, t, m]) => window.__pcam.renderMask(name, t, m), [rel, text, map]);
    let diff = 0;
    let dark = 0;
    let edge = 0;
    for (let i = 0; i < bits.length; i++) {
      const c = bits.charCodeAt(i) === 49 ? 1 : 0;
      dark += r.data[i];
      if (c !== r.data[i]) {
        diff++;
        // count disagreements next to an edge of the JS raster (anti-aliasing) separately
        const x = i % map.width;
        const y = (i / map.width) | 0;
        let isEdge = false;
        for (let dy = -1; dy <= 1 && !isEdge; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < map.width && yy < map.height && r.data[yy * map.width + xx] !== r.data[i])
              isEdge = true;
          }
        if (isEdge) edge++;
      }
    }
    const interior = diff - edge;
    expect(interior, `${interior} non-edge pixels differ (${diff} total, ${dark} dark)`).toBeLessThanOrEqual(
      Math.max(4, dark * 0.001),
    );
    // edge pixels may differ (canvas anti-aliases, the JS rasteriser samples pixel centres)
  });
}
