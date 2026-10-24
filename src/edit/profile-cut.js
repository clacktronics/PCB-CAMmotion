// Rubbing out part of a board profile (Edge.Cuts) without breaking it (DOM-free).
//
// A profile layer is a set of outline loops drawn as lines and arcs; the board is what they
// enclose (even-odd, src/model/outline.js). Rubbing a shape out of the board leaves the board
// minus the shape, whose outline is
//   (the old outline outside the shape) + (the shape's outline inside the old board):
// each outline line or arc the shape's outline crosses is split where it crosses and the
// pieces inside the shape are dropped, and the shape's outline is split at the same points
// and the pieces inside the board are added as new edges. Both sides use the same crossing
// points, so the new edges join the kept pieces exactly and every loop stays closed.
// Lines and arcs keep their kind (a piece of an arc is an arc of the same circle).

const TAU = Math.PI * 2;
const EPS = 1e-12;
// corners of the shape closer than this (in x and in y) are merged: the outline is chained by
// matching ends on a 0.01 mm grid (src/model/outline.js), so shorter new edges could be left over
const MIN_STEP_MM = 0.0101;

/** Contours without corners closer than MIN_STEP_MM to the one before (polygon booleans leave such specks). */
export function sparseContours(contours) {
  const out = [];
  for (const c of contours) {
    const kept = [];
    for (let i = 0; i < c.length; i += 2) {
      const n = kept.length;
      if (n && Math.max(Math.abs(c[i] - kept[n - 2]), Math.abs(c[i + 1] - kept[n - 1])) < MIN_STEP_MM) continue;
      kept.push(c[i], c[i + 1]);
    }
    while (kept.length >= 6 && Math.max(Math.abs(kept[0] - kept.at(-2)), Math.abs(kept[1] - kept.at(-1))) < MIN_STEP_MM)
      kept.length -= 2;
    if (kept.length >= 6) out.push(kept);
  }
  return out;
}

/** Even-odd point in flat contours [x0, y0, ...]. */
export function insideContours(contours, x, y) {
  let inside = false;
  for (const c of contours) {
    const n = c.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = c[i * 2];
      const yi = c[i * 2 + 1];
      const xj = c[j * 2];
      const yj = c[j * 2 + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The point at t (0..1) along a line or arc object. */
function pointAt(o, t) {
  if (t === 0) return [o.x1, o.y1];
  if (t === 1) return [o.x2, o.y2];
  if (o.k === 'L') return [o.x1 + (o.x2 - o.x1) * t, o.y1 + (o.y2 - o.y1) * t];
  const a = o.a0 + o.sw * t;
  return [o.cx + o.r * Math.cos(a), o.cy + o.r * Math.sin(a)];
}

/** Where segment p→q crosses a line or arc object: [{ s (on p→q, 0 ≤ s < 1), t (on o), x, y }]. */
function crossings(p, q, o) {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const out = [];
  if (o.k === 'L') {
    const ex = o.x2 - o.x1;
    const ey = o.y2 - o.y1;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < EPS) return out; // parallel
    const fx = o.x1 - p[0];
    const fy = o.y1 - p[1];
    const s = (fx * ey - fy * ex) / den;
    const t = (fx * dy - fy * dx) / den;
    if (s >= 0 && s < 1 && t >= 0 && t <= 1) {
      // at an end of the line: exactly that end, so it still joins its neighbour
      const [x, y] = t === 0 || t === 1 ? pointAt(o, t) : [p[0] + dx * s, p[1] + dy * s];
      out.push({ s, t, x, y });
    }
    return out;
  }
  // arc: the segment against the circle, then the angle against the sweep
  const fx = p[0] - o.cx;
  const fy = p[1] - o.cy;
  const a = dx * dx + dy * dy;
  if (a < EPS) return out;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - o.r * o.r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return out;
  const root = Math.sqrt(disc);
  const sweep = Math.abs(o.sw);
  for (const s of disc === 0 ? [-b / (2 * a)] : [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
    if (!(s >= 0 && s < 1)) continue;
    const x = p[0] + dx * s;
    const y = p[1] + dy * s;
    let u = (Math.atan2(y - o.cy, x - o.cx) - o.a0) * Math.sign(o.sw);
    u = ((u % TAU) + TAU) % TAU;
    if (u > sweep + 1e-9) {
      if (u > TAU - 1e-9)
        u = 0; // just before the start
      else continue;
    }
    const t = Math.min(1, u / sweep);
    const [px, py] = t === 0 || t === 1 ? pointAt(o, t) : [x, y];
    out.push({ s, t, x: px, y: py });
  }
  return out;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The point half way along a polyline [[x, y], ...]. */
function midway(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  let left = len / 2;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (d >= left && d > 0) {
      const k = left / d;
      return {
        len,
        p: [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k],
      };
    }
    left -= d;
  }
  return { len, p: pts[0] };
}

/**
 * Cut a shape out of a board profile.
 * @param {object[]} objs the profile's line ('L') and arc ('A') objects (mm)
 * @param {number[][]} clipMm the shape: flat contours (even-odd); corners closer than 0.0101 mm are merged
 * @param {number[][]} loops the board outline loops before the cut (extractOutline)
 * @returns {{ pieces: (null | {t0:number, t1:number, p0:number[], p1:number[]}[])[], bridges: number[][][], changed: boolean }}
 *   pieces[k]: null if objs[k] is unchanged, else the parts of it that are kept (none: removed);
 *   bridges: new edges, polylines [[x, y], ...] (a closed one repeats its first point)
 */
export function cutProfile(objs, clipMm, loops) {
  const clip = sparseContours(clipMm);
  const hits = objs.map(() => []); // per object: crossings
  const onClip = clip.map(() => []); // per clip contour: { at: edge + s, x, y }
  clip.forEach((c, ci) => {
    const n = c.length / 2;
    for (let e = 0; e < n; e++) {
      const p = [c[e * 2], c[e * 2 + 1]];
      const q = [c[((e + 1) % n) * 2], c[((e + 1) % n) * 2 + 1]];
      objs.forEach((o, k) => {
        for (const h of crossings(p, q, o)) {
          hits[k].push(h);
          onClip[ci].push({ at: e + h.s, x: h.x, y: h.y });
        }
      });
    }
  });

  let changed = false;
  const pieces = objs.map((o, k) => {
    const ts = [...new Set([0, 1, ...hits[k].map((h) => h.t)])].sort((a, b) => a - b);
    const at = new Map(hits[k].map((h) => [h.t, [h.x, h.y]]));
    const kept = [];
    for (let i = 1; i < ts.length; i++) {
      const t0 = ts[i - 1];
      const t1 = ts[i];
      if (t1 - t0 < 1e-12) continue;
      const m = pointAt(o, (t0 + t1) / 2);
      if (!insideContours(clip, m[0], m[1]))
        kept.push({ t0, t1, p0: at.get(t0) ?? pointAt(o, t0), p1: at.get(t1) ?? pointAt(o, t1) });
    }
    if (kept.length === 1 && kept[0].t0 === 0 && kept[0].t1 === 1) return null;
    changed = true;
    return kept;
  });

  const bridges = [];
  clip.forEach((c, ci) => {
    const n = c.length / 2;
    const v = (j) => [c[(j % n) * 2], c[(j % n) * 2 + 1]];
    const xs = onClip[ci].sort((a, b) => a.at - b.at);
    const keep = (pts) => {
      const { len, p } = midway(pts);
      if (len > 1e-9 && insideContours(loops, p[0], p[1])) bridges.push(pts);
    };
    if (!xs.length) {
      // the shape's outline does not cross the profile: all of it is an edge if it is inside the board
      const pts = [];
      for (let j = 0; j <= n; j++) pts.push(v(j));
      keep(pts);
      return;
    }
    for (let i = 0; i < xs.length; i++) {
      const a = xs[i];
      const b = xs[(i + 1) % xs.length];
      const end = i + 1 < xs.length ? b.at : b.at + n;
      const pts = [[a.x, a.y]];
      for (let j = Math.floor(a.at) + 1; j < end; j++) pts.push(v(j));
      // a corner right next to where it crosses would make a speck of an edge
      const near = (p, q) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1])) < MIN_STEP_MM;
      while (pts.length > 1 && near(pts.at(-1), [b.x, b.y])) pts.pop();
      while (pts.length > 1 && near(pts[1], pts[0])) pts.splice(1, 1);
      pts.push([b.x, b.y]);
      keep(pts);
    }
  });
  if (bridges.length) changed = true;
  return { pieces, bridges, changed };
}
