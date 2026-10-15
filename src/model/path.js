// Compact 2D path representation shared by apertures, renderers and hit testing.
// Units: mm. Y axis points up (Gerber convention).
//
// A path is a flat number array of commands:
//   M x y                    (opcode 0)  start a contour
//   L x y                    (opcode 1)  straight segment
//   A cx cy r a0 a1 ccw      (opcode 2)  circular arc from angle a0 to a1 (radians), ccw = 1|0
//   Z                        (opcode 3)  close contour
// Outer contours are counter-clockwise and holes clockwise, so that filling any number of
// paths with the non-zero winding rule gives their union with holes intact.

export const M = 0;
export const L = 1;
export const A = 2;
export const Z = 3;
const TAU = Math.PI * 2;

export function circlePath(cx, cy, r, ccw = true, out = []) {
  if (r <= 0) return out;
  out.push(M, cx + r, cy, A, cx, cy, r, 0, ccw ? TAU : -TAU, ccw ? 1 : 0, Z);
  return out;
}

/** Closed polygon from flat [x0,y0,x1,y1,...] (not repeating the first point). */
export function polygonPath(pts, out = []) {
  if (pts.length < 6) return out;
  out.push(M, pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) out.push(L, pts[i], pts[i + 1]);
  out.push(Z);
  return out;
}

export function rectPath(cx, cy, w, h, out = []) {
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  const x1 = cx + w / 2;
  const y1 = cy + h / 2;
  if (w <= 0 || h <= 0) return out;
  out.push(M, x0, y0, L, x1, y0, L, x1, y1, L, x0, y1, Z);
  return out;
}

/** Obround (stadium) centred at cx,cy, CCW. */
export function obroundPath(cx, cy, w, h, out = []) {
  if (w <= 0 || h <= 0) return out;
  if (Math.abs(w - h) < 1e-12) return circlePath(cx, cy, w / 2, true, out);
  if (w > h) {
    const r = h / 2;
    const d = w / 2 - r;
    out.push(M, cx - d, cy - r, L, cx + d, cy - r);
    out.push(A, cx + d, cy, r, -Math.PI / 2, Math.PI / 2, 1, L, cx - d, cy + r);
    out.push(A, cx - d, cy, r, Math.PI / 2, (3 * Math.PI) / 2, 1, Z);
  } else {
    const r = w / 2;
    const d = h / 2 - r;
    out.push(M, cx + r, cy - d, L, cx + r, cy + d);
    out.push(A, cx, cy + d, r, 0, Math.PI, 1, L, cx - r, cy - d);
    out.push(A, cx, cy - d, r, Math.PI, TAU, 1, Z);
  }
  return out;
}

/** Signed area of a flat point list (positive = CCW). */
export function signedArea(pts) {
  let a = 0;
  const n = pts.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) a += pts[j] * pts[i + 1] - pts[i] * pts[j + 1];
  return a / 2;
}

/**
 * Apply an affine similarity transform [a, b, c, d, e, f]:
 *   x' = a x + b y + e,   y' = c x + d y + f
 * The linear part must be a similarity (rotation, uniform scale, optional reflection) so circles
 * stay circles. A reflection reverses orientation; pass fixOrientation to reverse it back.
 */
export function transformPath(p, t, fixOrientation = true) {
  const [a, b, c, d, e, f] = t;
  const det = a * d - b * c;
  const s = Math.sqrt(Math.abs(det));
  const phi = Math.atan2(c, a);
  const refl = det < 0;
  const out = new Array(p.length);
  for (let i = 0; i < p.length;) {
    const op = p[i];
    out[i] = op;
    if (op === M || op === L) {
      const x = p[i + 1];
      const y = p[i + 2];
      out[i + 1] = a * x + b * y + e;
      out[i + 2] = c * x + d * y + f;
      i += 3;
    } else if (op === A) {
      const x = p[i + 1];
      const y = p[i + 2];
      out[i + 1] = a * x + b * y + e;
      out[i + 2] = c * x + d * y + f;
      out[i + 3] = p[i + 3] * s;
      if (refl) {
        out[i + 4] = phi - p[i + 4];
        out[i + 5] = phi - p[i + 5];
        out[i + 6] = p[i + 6] ? 0 : 1;
      } else {
        out[i + 4] = p[i + 4] + phi;
        out[i + 5] = p[i + 5] + phi;
        out[i + 6] = p[i + 6];
      }
      i += 7;
    } else i += 1;
  }
  return refl && fixOrientation ? reversePath(out) : out;
}

/** Reverse the direction of every contour (keeps contour order). */
export function reversePath(p) {
  const out = [];
  for (const c of splitContours(p)) {
    // c: { start:[x,y], segs:[{op, x, y, arc?}] } where x,y is the segment end point
    const pts = [c.start];
    for (const s of c.segs) pts.push([s.x, s.y]);
    const last = pts[pts.length - 1];
    out.push(M, last[0], last[1]);
    for (let k = c.segs.length - 1; k >= 0; k--) {
      const s = c.segs[k];
      const to = pts[k];
      if (s.op === A) out.push(A, s.cx, s.cy, s.r, s.a1, s.a0, s.ccw ? 0 : 1);
      else out.push(L, to[0], to[1]);
    }
    if (c.closed) out.push(Z);
  }
  return out;
}

function splitContours(p) {
  const res = [];
  let cur = null;
  let x = 0;
  let y = 0;
  for (let i = 0; i < p.length;) {
    const op = p[i];
    if (op === M) {
      x = p[i + 1];
      y = p[i + 2];
      cur = { start: [x, y], segs: [], closed: false };
      res.push(cur);
      i += 3;
    } else if (op === L) {
      x = p[i + 1];
      y = p[i + 2];
      cur.segs.push({ op: L, x, y });
      i += 3;
    } else if (op === A) {
      const [cx, cy, r, a0, a1, ccw] = [p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5], p[i + 6]];
      x = cx + r * Math.cos(a1);
      y = cy + r * Math.sin(a1);
      if (cur.segs.length === 0 && !samePt(cur.start, cx + r * Math.cos(a0), cy + r * Math.sin(a0))) {
        // arc does not start at the contour start: implicit line to its start
        cur.segs.push({ op: L, x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) });
      }
      cur.segs.push({ op: A, x, y, cx, cy, r, a0, a1, ccw });
      i += 7;
    } else {
      if (cur) cur.closed = true;
      i += 1;
    }
  }
  return res;
}

function samePt(p, x, y) {
  return Math.abs(p[0] - x) < 1e-9 && Math.abs(p[1] - y) < 1e-9;
}

/**
 * Emit a path into a canvas-like sink (moveTo/lineTo/arc/closePath), with an optional offset.
 * The sink's arc() uses canvas semantics: arc(x, y, r, start, end, counterclockwise) where
 * "counterclockwise" refers to the sink's own coordinate system. We pass our Y-up angles; sinks
 * that flip Y (canvas) must use a transform with negative Y scale so the result is consistent.
 */
export function emitPath(sink, p, dx = 0, dy = 0) {
  for (let i = 0; i < p.length;) {
    const op = p[i];
    if (op === M) {
      sink.moveTo(p[i + 1] + dx, p[i + 2] + dy);
      i += 3;
    } else if (op === L) {
      sink.lineTo(p[i + 1] + dx, p[i + 2] + dy);
      i += 3;
    } else if (op === A) {
      sink.arc(p[i + 1] + dx, p[i + 2] + dy, p[i + 3], p[i + 4], p[i + 5], !p[i + 6]);
      i += 7;
    } else {
      sink.closePath();
      i += 1;
    }
  }
}

/** Conservative bounding box [minx, miny, maxx, maxy] of a path (arcs use exact extents). */
export function pathBounds(p, out = [Infinity, Infinity, -Infinity, -Infinity]) {
  for (let i = 0; i < p.length;) {
    const op = p[i];
    if (op === M || op === L) {
      grow(out, p[i + 1], p[i + 2]);
      i += 3;
    } else if (op === A) {
      arcBounds(p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5], p[i + 6], out);
      i += 7;
    } else i += 1;
  }
  return out;
}

export function grow(b, x, y) {
  if (x < b[0]) b[0] = x;
  if (y < b[1]) b[1] = y;
  if (x > b[2]) b[2] = x;
  if (y > b[3]) b[3] = y;
}

/** Extents of an arc from a0 to a1 (ccw flag gives direction). */
export function arcBounds(cx, cy, r, a0, a1, ccw, out) {
  grow(out, cx + r * Math.cos(a0), cy + r * Math.sin(a0));
  grow(out, cx + r * Math.cos(a1), cy + r * Math.sin(a1));
  let start = ccw ? a0 : a1;
  let sweep = ccw ? a1 - a0 : a0 - a1;
  if (sweep >= TAU - 1e-12) {
    grow(out, cx - r, cy - r);
    grow(out, cx + r, cy + r);
    return out;
  }
  sweep = ((sweep % TAU) + TAU) % TAU;
  start = ((start % TAU) + TAU) % TAU;
  for (let k = 0; k < 8; k++) {
    const q = (k * Math.PI) / 2;
    if (q >= start && q <= start + sweep) grow(out, cx + r * Math.cos(q), cy + r * Math.sin(q));
  }
  return out;
}

/** Number of segments to flatten an arc so the chord error stays below tolMm. */
export function arcSegments(r, sweep, tolMm) {
  if (r <= tolMm) return Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const step = 2 * Math.acos(Math.max(-1, 1 - tolMm / r));
  return Math.min(4096, Math.max(1, Math.ceil(Math.abs(sweep) / step)));
}

/** Flatten a path into closed contours of flat point arrays. */
export function flattenPath(p, tolMm = 0.0005) {
  const contours = [];
  let cur = null;
  for (let i = 0; i < p.length;) {
    const op = p[i];
    if (op === M) {
      cur = [p[i + 1], p[i + 2]];
      contours.push(cur);
      i += 3;
    } else if (op === L) {
      cur.push(p[i + 1], p[i + 2]);
      i += 3;
    } else if (op === A) {
      const [cx, cy, r, a0, a1] = [p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5]];
      const sweep = arcSweep(a0, a1, p[i + 6]);
      const n = arcSegments(r, sweep, tolMm);
      if (!cur) {
        cur = [];
        contours.push(cur);
      }
      for (let k = 0; k <= n; k++) {
        const a = a0 + (sweep * k) / n;
        cur.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
      i += 7;
    } else i += 1;
  }
  return contours.map(dedupeClosing);
}

/** Signed sweep from a0 to a1 in the given direction (ccw positive). Full turns are preserved. */
export function arcSweep(a0, a1, ccw) {
  let s = a1 - a0;
  if (ccw) {
    if (s < 0) s += TAU * Math.ceil(-s / TAU);
  } else if (s > 0) s -= TAU * Math.ceil(s / TAU);
  return s;
}

function dedupeClosing(c) {
  const n = c.length;
  if (n >= 4 && Math.abs(c[0] - c[n - 2]) < 1e-12 && Math.abs(c[1] - c[n - 1]) < 1e-12) c.length = n - 2;
  return c;
}
