// Hit testing: which graphical object is at a point? Geometry-based (no pixels), so it works for
// selection in the viewer and later for editing. Uses a lazily built uniform grid over the
// per-object bounding boxes.

import { flattenPath } from './path.js';
import { drawRadius } from './gerber-image.js';

const MAX_CELLS = 1 << 18;

function buildGrid(image) {
  const ob = image.objBounds;
  const n = image.objects.length;
  const b = image.bounds;
  if (!b || !n) return null;
  const w = Math.max(b[2] - b[0], 1e-6);
  const h = Math.max(b[3] - b[1], 1e-6);
  const cells = Math.min(MAX_CELLS, Math.max(1, n * 2));
  const cell = Math.max(Math.sqrt((w * h) / cells), 1e-3);
  const cols = Math.max(1, Math.ceil(w / cell));
  const rows = Math.max(1, Math.ceil(h / cell));
  const grid = new Map();
  const big = [];
  for (let i = 0; i < n; i++) {
    const c0 = Math.floor((ob[i * 4] - b[0]) / cell);
    const c1 = Math.floor((ob[i * 4 + 2] - b[0]) / cell);
    const r0 = Math.floor((ob[i * 4 + 1] - b[1]) / cell);
    const r1 = Math.floor((ob[i * 4 + 3] - b[1]) / cell);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > 64) {
      big.push(i);
      continue;
    }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = r * cols + c;
        let l = grid.get(k);
        if (!l) grid.set(k, (l = []));
        l.push(i);
      }
    }
  }
  return { grid, big, cell, cols, rows, x0: b[0], y0: b[1] };
}

/** Indices of objects whose bbox contains (x, y) ± tol, in drawing order. */
export function candidates(image, x, y, tol = 0) {
  image._grid ??= buildGrid(image);
  const g = image._grid;
  if (!g) return [];
  const ob = image.objBounds;
  const out = new Set();
  const c0 = Math.floor((x - tol - g.x0) / g.cell);
  const c1 = Math.floor((x + tol - g.x0) / g.cell);
  const r0 = Math.floor((y - tol - g.y0) / g.cell);
  const r1 = Math.floor((y + tol - g.y0) / g.cell);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
      for (const i of g.grid.get(r * g.cols + c) || []) out.add(i);
    }
  }
  for (const i of g.big) out.add(i);
  return [...out]
    .filter(
      (i) => x >= ob[i * 4] - tol && x <= ob[i * 4 + 2] + tol && y >= ob[i * 4 + 1] - tol && y <= ob[i * 4 + 3] + tol,
    )
    .sort((a, b) => a - b);
}

/**
 * Topmost object at (x, y) within tolerance, or -1.
 * @param {object} image
 * @param {number} x mm
 * @param {number} y mm
 * @param {number} [tol] mm
 */
export function hitTest(image, x, y, tol = 0) {
  const cand = candidates(image, x, y, tol);
  for (let q = cand.length - 1; q >= 0; q--) {
    if (objectContains(image.objects[cand[q]], x, y, tol)) return cand[q];
  }
  return -1;
}

export function objectContains(o, x, y, tol = 0) {
  switch (o.k) {
    case 'F': {
      let lx = x - o.x;
      let ly = y - o.y;
      if (o.m) {
        const [a, b, c, d] = o.m;
        const det = a * d - b * c;
        const ix = (d * lx - b * ly) / det;
        const iy = (-c * lx + a * ly) / det;
        lx = ix;
        ly = iy;
      }
      const ap = o.ap;
      if (ap.kind === 'block') return false;
      if (inShape(ap, lx, ly)) return true;
      if (tol > 0) {
        const bb = ap.shape.bbox;
        const s = o.m ? Math.sqrt(Math.abs(o.m[0] * o.m[3] - o.m[1] * o.m[2])) : 1;
        const tl = tol / s;
        // small apertures: accept near misses so tiny pads stay clickable
        if (bb[2] - bb[0] < 4 * tl && lx >= bb[0] - tl && lx <= bb[2] + tl && ly >= bb[1] - tl && ly <= bb[3] + tl)
          return true;
      }
      return false;
    }
    case 'L': {
      const r = o.ap.kind === 'C' ? drawRadius(o.ap, o.m) : drawRadius(o.ap, o.m) / Math.SQRT2;
      return distToSegment(x, y, o.x1, o.y1, o.x2, o.y2) <= r + tol;
    }
    case 'A': {
      const h = drawRadius(o.ap, o.m);
      return distToArc(x, y, o) <= h + tol;
    }
    case 'R': {
      let w = 0;
      for (const c of o.contours) w += winding(c, x, y);
      return w !== 0;
    }
  }
  return false;
}

function inShape(ap, x, y) {
  ap._flat ??= ap.shape.parts.map((p) => ({ dark: p.dark, contours: flattenPath(p.path, 0.001) }));
  let inside = false;
  for (const p of ap._flat) {
    let w = 0;
    for (const c of p.contours) w += winding(c, x, y);
    if (w !== 0) inside = p.dark;
  }
  return inside;
}

/** Winding number of a closed flat contour around (x, y). */
export function winding(c, x, y) {
  let w = 0;
  const n = c.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const x0 = c[j];
    const y0 = c[j + 1];
    const x1 = c[i];
    const y1 = c[i + 1];
    if (y0 <= y) {
      if (y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0) w++;
    } else if (y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) w--;
  }
  return w;
}

export function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function distToArc(px, py, o) {
  const a = Math.atan2(py - o.cy, px - o.cx);
  let rel = o.sw >= 0 ? a - o.a0 : o.a0 - a;
  rel = ((rel % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (rel <= Math.abs(o.sw)) return Math.abs(Math.hypot(px - o.cx, py - o.cy) - o.r);
  return Math.min(Math.hypot(px - o.x1, py - o.y1), Math.hypot(px - o.x2, py - o.y2));
}
