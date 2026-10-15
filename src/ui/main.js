// Entry point (bundled to dist/app.js by tools/build.mjs so index.html works from file://).

import { App } from './app.js';
import { drawImage } from '../render/draw-image.js';
import { CanvasTarget } from '../render/canvas-target.js';
import { loadFile } from '../model/load-file.js';

function start() {
  const app = new App(document.getElementById('app'));
  // Test hooks for the Playwright suite (no effect on normal use).
  window.__pcam = {
    app,
    /** Load files given as [{name, base64}] (the e2e tests cannot use OS file dialogs everywhere). */
    async loadBase64(files) {
      await app.loadFiles(
        files.map((f) => ({ name: f.name, bytes: Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)) })),
      );
    },
    state() {
      return {
        project: app.project,
        layers: app.layers.map((l) => ({
          id: l.id,
          name: l.name,
          role: l.role,
          objects: l.image.objects.length,
          bounds: l.image.bounds,
          errors: l.diagnostics.errors.length,
          warnings: l.diagnostics.warnings.length,
        })),
        view: app.viewer.getView(),
        lastRenderMs: app.viewer.lastRenderMs,
        renders: app.viewer.renderCount,
        selection: app.selection
          ? { layerId: app.selection.layerId, index: app.selection.index, line: app.selection.object.ln }
          : null,
      };
    },
    /** Render one file's layer as a 1-bit mask with the canvas renderer (reference-render tests). */
    renderMask(name, text, map) {
      const { image } = loadFile(name, new TextEncoder().encode(text));
      const c = document.createElement('canvas');
      c.width = map.width;
      c.height = map.height;
      const ctx = c.getContext('2d');
      const t = new CanvasTarget(ctx, {
        s: map.pxPerMm,
        ox: -map.x0 * map.pxPerMm,
        oy: map.height + map.y0 * map.pxPerMm,
        mirror: false,
      });
      drawImage(image, t);
      const data = ctx.getImageData(0, 0, map.width, map.height).data;
      const bits = new Array(map.width * map.height);
      for (let i = 0; i < bits.length; i++) bits[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
      return bits.join('');
    },
  };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
