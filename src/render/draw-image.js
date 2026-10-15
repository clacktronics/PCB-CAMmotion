// Draw a layer image (Gerber or drill) into a render target. No DOM: the same code drives the
// browser canvas (render/canvas-target.js) and the pure-JS rasteriser used in Node tests
// (render/raster.js), so what the tests check is what the viewer draws.
//
// Polarity (spec 4.3.2): objects are drawn in file order; dark objects add, clear objects
// erase everything drawn before them. Consecutive objects of the same polarity are filled
// together with the non-zero rule (their union). Apertures whose macro has exposure-off
// primitives are drawn in an isolated group so they only erase inside the aperture.
//
// Target interface (all coordinates in mm, Y up):
//   begin()                                   start a new batch
//   moveTo(x,y) lineTo(x,y) arc(cx,cy,r,a0,a1,anticlockwise) closePath()
//   fill(dark)                                fill the batch: dark adds, clear erases
//   stroke(dark, widthMm)        (optional)   stroke the batch with round caps and joins
//   group(bbox) -> sub-target                 isolated target covering bbox (mm)
//   endGroup(sub, dark)                       composite the group's result with this polarity
//   pixelMm (number)                          size of one pixel in mm (level of detail)

import { emitPath, transformPath, flattenPath, pathBounds } from '../model/path.js';
import { drawRadius } from '../model/gerber-image.js';

// Chromium fills paths with many curved sub-paths superlinearly slower: keep fill batches small
const BATCH_LIMIT = 64;
const STROKE_BATCH_LIMIT = 20000;

/**
 * @param {object} image  from interpretGerber / interpretExcellon
 * @param {object} target see above
 * @param {{view?: number[]|null, only?: number[], inflateMm?: number}} [opts]
 *   view = [minx,miny,maxx,maxy] cull rect (mm); only = object indices to draw;
 *   inflateMm grows circular apertures (used to draw plated hole walls around drills)
 */
export function drawImage(image, target, opts = {}) {
  const view = opts.view || null;
  const inflate = opts.inflateMm || 0;
  const objs = image.objects;
  const ob = image.objBounds;
  const neg = !!image.negative;
  if (neg && image.bounds) {
    // deprecated %IPNEG%: the image area starts dark and every object's polarity is inverted
    const [x0, y0, x1, y1] = image.bounds;
    target.begin();
    target.moveTo(x0, y0);
    target.lineTo(x1, y0);
    target.lineTo(x1, y1);
    target.lineTo(x0, y1);
    target.closePath();
    target.fill(true);
  }
  // A batch is either a union fill (any shapes) or, on targets that can stroke, a stroke of
  // connected line draws with one round aperture: round caps + round joins sweep exactly the
  // same area as filled stadiums, and canvas strokes are far faster than thousands of fills.
  const canStroke = typeof target.stroke === 'function';
  let batchDark = null;
  let batchWidth = 0; // 0 = fill batch, > 0 = stroke batch of this width (mm)
  let inBatch = 0;
  let px = NaN;
  let py = NaN;
  const flush = () => {
    if (inBatch) {
      if (batchWidth) target.stroke(batchDark, batchWidth);
      else target.fill(batchDark);
    }
    inBatch = 0;
    batchDark = null;
    batchWidth = 0;
    px = py = NaN;
  };
  const list = opts.only || null;
  const n = list ? list.length : objs.length;
  for (let q = 0; q < n; q++) {
    const i = list ? list[q] : q;
    if (view && ob) {
      const b = i * 4;
      if (ob[b] > view[2] || ob[b + 2] < view[0] || ob[b + 1] > view[3] || ob[b + 3] < view[1]) continue;
    }
    const o = objs[i];
    const dark = neg ? !o.dark : o.dark;
    if (o.k === 'F' && o.ap.shape && !o.ap.shape.simple) {
      flush();
      drawGroupFlash(o, dark, target);
      continue;
    }
    // plain round flashes (no hole) are dots: a round-capped stroke of (almost) zero length
    const dot = canStroke && o.k === 'F' && o.ap.kind === 'C' && o.ap.shape.parts.length === 1 && isPlainCircle(o.ap);
    if (dot || (canStroke && o.k === 'L' && o.ap.kind === 'C' && (o.x1 !== o.x2 || o.y1 !== o.y2))) {
      const w = 2 * (drawRadius(o.ap, o.m) + inflate);
      if (w > 0 && dot) {
        if (dark !== batchDark || w !== batchWidth || inBatch >= STROKE_BATCH_LIMIT) {
          flush();
          batchDark = dark;
          batchWidth = w;
          target.begin();
        }
        target.moveTo(o.x, o.y);
        target.lineTo(o.x + w * DOT_EPS, o.y);
        px = py = NaN;
        inBatch++;
        continue;
      }
      if (w > 0 && !dot) {
        if (dark !== batchDark || w !== batchWidth || inBatch >= STROKE_BATCH_LIMIT) {
          flush();
          batchDark = dark;
          batchWidth = w;
          target.begin();
        }
        if (o.x1 !== px || o.y1 !== py) target.moveTo(o.x1, o.y1);
        target.lineTo(o.x2, o.y2);
        px = o.x2;
        py = o.y2;
        inBatch++;
        continue;
      }
    }
    if (dark !== batchDark || batchWidth || inBatch >= BATCH_LIMIT) {
      flush();
      batchDark = dark;
      target.begin();
    }
    emitObject(o, target, target.pixelMm || 0, inflate);
    inBatch++;
  }
  flush();
}

// relative length of the stroke used to draw a round flash (zero-length strokes are not drawn)
const DOT_EPS = 1e-6;

function isPlainCircle(ap) {
  // a C aperture without hole is one closed circle: M, A, Z
  return ap._plain ?? (ap._plain = ap.shape.parts[0].path.length === 11);
}

function drawGroupFlash(o, dark, target) {
  const parts = transformedParts(o.ap, o.m);
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of parts) if (p.dark) pathBounds(p.path, bb);
  if (!(bb[0] <= bb[2])) return;
  const box = [bb[0] + o.x, bb[1] + o.y, bb[2] + o.x, bb[3] + o.y];
  const sub = target.group(box);
  if (!sub) return;
  for (const p of parts) {
    sub.begin();
    emitPath(sub, p.path, o.x, o.y);
    sub.fill(p.dark);
  }
  target.endGroup(sub, dark);
}

/** Aperture parts under linear transform m (cached per aperture). Orientation kept CCW. */
export function transformedParts(ap, m) {
  if (!m) return ap.shape.parts;
  const key = m.join(',');
  ap._tcache ??= new Map();
  let parts = ap._tcache.get(key);
  if (!parts) {
    parts = ap.shape.parts.map((p) => ({ dark: p.dark, path: transformPath(p.path, [m[0], m[1], m[2], m[3], 0, 0]) }));
    if (ap._tcache.size < 256) ap._tcache.set(key, parts);
  }
  return parts;
}

/** Hull outline points of a (transformed) aperture, for drawing with non-circular apertures. */
function hullPoints(ap, m) {
  const key = m ? m.join(',') : '';
  ap._hcache ??= new Map();
  let h = ap._hcache.get(key);
  if (!h) {
    const pts = [];
    for (const p of transformedParts(ap, m)) {
      if (!p.dark) continue;
      for (const c of flattenPath(p.path, 0.001)) for (let i = 0; i < c.length; i += 2) pts.push([c[i], c[i + 1]]);
    }
    h = convexHull(pts);
    ap._hcache.set(key, h);
  }
  return h;
}

/** Emit one object's outline as union-ready (CCW) contours. */
export function emitObject(o, sink, pixelMm = 0, inflate = 0) {
  if (inflate && o.ap.kind === 'C') {
    const r = drawRadius(o.ap, o.m) + inflate;
    if (o.k === 'F') return capsule(sink, o.x, o.y, o.x, o.y, r, pixelMm);
    if (o.k === 'L') return capsule(sink, o.x1, o.y1, o.x2, o.y2, r, pixelMm);
    if (o.k === 'A') return arcStroke(sink, o, r, pixelMm);
  }
  switch (o.k) {
    case 'F': {
      if (pixelMm && o.ap.kind === 'C' && !o.m && o.ap.dia < pixelMm * 0.75) {
        // sub-pixel circle: a square of equal area is indistinguishable and much cheaper
        const h = (o.ap.dia * 0.886) / 2;
        if (h > 0) square(sink, o.x, o.y, h);
        return;
      }
      for (const p of transformedParts(o.ap, o.m)) emitPath(sink, p.path, o.x, o.y);
      return;
    }
    case 'L': {
      if (o.ap.kind === 'C') {
        capsule(sink, o.x1, o.y1, o.x2, o.y2, drawRadius(o.ap, o.m), pixelMm);
        return;
      }
      const h = hullPoints(o.ap, o.m);
      if (!h.length) return;
      const pts = [];
      for (const [x, y] of h) pts.push([x + o.x1, y + o.y1], [x + o.x2, y + o.y2]);
      polygon(sink, convexHull(pts));
      return;
    }
    case 'A': {
      const r = o.ap.kind === 'C' ? drawRadius(o.ap, o.m) : minHalfSize(o.ap, o.m);
      arcStroke(sink, o, r, pixelMm);
      return;
    }
    case 'R':
      for (const c of o.contours) {
        sink.moveTo(c[0], c[1]);
        for (let i = 2; i < c.length; i += 2) sink.lineTo(c[i], c[i + 1]);
        sink.closePath();
      }
      return;
  }
}

function minHalfSize(ap, m) {
  const b = ap.shape.bbox;
  const s = m ? Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) : 1;
  return (Math.min(b[2] - b[0], b[3] - b[1]) / 2) * s;
}

function square(sink, x, y, h) {
  sink.moveTo(x - h, y - h);
  sink.lineTo(x + h, y - h);
  sink.lineTo(x + h, y + h);
  sink.lineTo(x - h, y + h);
  sink.closePath();
}

function polygon(sink, pts) {
  sink.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) sink.lineTo(pts[i][0], pts[i][1]);
  sink.closePath();
}

/** Line swept by a circle of radius r: a CCW stadium. */
export function capsule(sink, x1, y1, x2, y2, r, pixelMm = 0) {
  if (r <= 0) return;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) {
    if (pixelMm && r < pixelMm * 0.4) return square(sink, x1, y1, r * 0.886);
    sink.moveTo(x1 + r, y1);
    sink.arc(x1, y1, r, 0, Math.PI * 2, false);
    sink.closePath();
    return;
  }
  const t = Math.atan2(dy, dx);
  const nx = (-dy / len) * r;
  const ny = (dx / len) * r;
  if (pixelMm && r < pixelMm * 0.4) {
    // thinner than a pixel: a quad is enough
    sink.moveTo(x1 - nx - (dx / len) * r, y1 - ny - (dy / len) * r);
    sink.lineTo(x2 - nx + (dx / len) * r, y2 - ny + (dy / len) * r);
    sink.lineTo(x2 + nx + (dx / len) * r, y2 + ny + (dy / len) * r);
    sink.lineTo(x1 + nx - (dx / len) * r, y1 + ny - (dy / len) * r);
    sink.closePath();
    return;
  }
  sink.moveTo(x1 - nx, y1 - ny);
  sink.lineTo(x2 - nx, y2 - ny);
  sink.arc(x2, y2, r, t - Math.PI / 2, t + Math.PI / 2, false);
  sink.lineTo(x1 + nx, y1 + ny);
  sink.arc(x1, y1, r, t + Math.PI / 2, t + (3 * Math.PI) / 2, false);
  sink.closePath();
}

/** Arc swept by a circle of radius h, as an annular sector with round ends (CCW). */
function arcStroke(sink, o, h, pixelMm) {
  if (h <= 0) return;
  const { cx, cy, r } = o;
  // normalise to a CCW sweep from a0
  let a0 = o.a0;
  let sw = o.sw;
  if (sw < 0) {
    a0 = a0 + sw;
    sw = -sw;
  }
  const full = sw >= Math.PI * 2 - 1e-12;
  if (r - h <= 1e-12 || (pixelMm && h < pixelMm * 0.4)) {
    // stroke wider than the radius (or sub-pixel): chain of capsules along the flattened arc
    const segs = Math.min(
      4096,
      Math.max(2, Math.ceil(sw / (2 * Math.acos(Math.max(-1, 1 - Math.max(pixelMm / 4, 0.0005) / Math.max(r, 1e-9)))))),
    );
    let px = cx + r * Math.cos(a0);
    let py = cy + r * Math.sin(a0);
    for (let k = 1; k <= segs; k++) {
      const a = a0 + (sw * k) / segs;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      capsule(sink, px, py, x, y, h, pixelMm);
      px = x;
      py = y;
    }
    return;
  }
  if (full) {
    sink.moveTo(cx + r + h, cy);
    sink.arc(cx, cy, r + h, 0, Math.PI * 2, false);
    sink.closePath();
    sink.moveTo(cx + r - h, cy);
    sink.arc(cx, cy, r - h, 0, -Math.PI * 2, true);
    sink.closePath();
    return;
  }
  const a1 = a0 + sw;
  const ex = cx + r * Math.cos(a1);
  const ey = cy + r * Math.sin(a1);
  const sx = cx + r * Math.cos(a0);
  const sy = cy + r * Math.sin(a0);
  sink.moveTo(cx + (r + h) * Math.cos(a0), cy + (r + h) * Math.sin(a0));
  sink.arc(cx, cy, r + h, a0, a1, false);
  sink.arc(ex, ey, h, a1, a1 + Math.PI, false);
  sink.arc(cx, cy, r - h, a1, a0, true);
  sink.arc(sx, sy, h, a0 + Math.PI, a0 + Math.PI * 2, false);
  sink.closePath();
}

/** Andrew's monotone chain; returns CCW hull. */
export function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}
