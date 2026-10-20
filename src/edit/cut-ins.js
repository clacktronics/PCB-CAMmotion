// Holes in regions by cut-ins (spec 4.10.3): a Gerber region contour cannot have separate hole
// contours, so each hole is joined to the outline by a zero-width "cut-in": the contour runs
// out along a bridge, round the hole, and back along the same bridge.
//
// The bridge search follows the hole-elimination step of the earcut triangulator (Mapbox,
// ISC licence): holes are taken left to right; from a hole's leftmost vertex a ray goes left
// to the nearest outline edge, and the bridge ends at the outline vertex visible from the hole
// that lies closest to the ray.

import { selfIntersects } from '../model/gerber-image.js';

/**
 * @param {number[]} outer CCW contour (flat mm)
 * @param {number[][]} holes CW contours inside it
 * @returns {number[]} one contour that encloses outer minus holes
 */
export function joinHoles(outer, holes) {
  let ring = toPts(outer);
  const queue = holes
    .map((h) => {
      const pts = toPts(h);
      let li = 0;
      for (let i = 1; i < pts.length; i++)
        if (pts[i][0] < pts[li][0] || (pts[i][0] === pts[li][0] && pts[i][1] < pts[li][1])) li = i;
      return { pts, li };
    })
    .sort((a, b) => a.pts[a.li][0] - b.pts[b.li][0]);
  for (const hole of queue) {
    const hp = hole.pts[hole.li];
    const m = bridgeVertex(ring, hp);
    if (m < 0) throw new Error('Could not join a hole to its outline (cut-in)');
    const rotated = [...hole.pts.slice(hole.li), ...hole.pts.slice(0, hole.li), hp];
    ring = [...ring.slice(0, m + 1), ...rotated, ring[m], ...ring.slice(m + 1)];
  }
  return ring.flat();
}

/** Index of the ring vertex to bridge the hole point h to, or -1. */
function bridgeVertex(ring, h) {
  const [hx, hy] = h;
  const n = ring.length;
  let qx = -Infinity;
  let m = -1;
  // nearest edge crossed by the ray going left; on a CCW outline the edges facing the hole
  // from the left run downwards
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    if (hy <= p[1] && hy >= q[1] && q[1] !== p[1]) {
      const x = p[0] + ((hy - p[1]) * (q[0] - p[0])) / (q[1] - p[1]);
      if (x <= hx && x > qx) {
        qx = x;
        m = p[0] < q[0] ? i : (i + 1) % n;
        if (x === hx) return m; // the hole touches this edge
      }
    }
  }
  if (m < 0) return -1;
  if (hx === qx) return m;
  // a vertex inside the triangle (h, ray hit, m) would block the bridge: take the one with
  // the smallest angle to the ray instead
  const [mx, my] = ring[m];
  let tanMin = Infinity;
  let best = m;
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    if (hx >= p[0] && p[0] >= mx && hx !== p[0]) {
      const inside =
        hy < my
          ? pointInTriangle(hx, hy, mx, my, qx, hy, p[0], p[1])
          : pointInTriangle(qx, hy, mx, my, hx, hy, p[0], p[1]);
      if (!inside) continue;
      const tan = Math.abs(hy - p[1]) / (hx - p[0]);
      if (
        locallyInside(ring, i, h) &&
        (tan < tanMin || (tan === tanMin && (p[0] > ring[best][0] || (p[0] === ring[best][0] && i > best))))
      ) {
        best = i;
        tanMin = tan;
      }
    }
  }
  return best;
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Does the segment from ring vertex i towards b start inside the polygon (CCW ring)? */
function locallyInside(ring, i, b) {
  const n = ring.length;
  const a = ring[i];
  const prev = ring[(i + n - 1) % n];
  const next = ring[(i + 1) % n];
  if (cross(prev, a, next) >= 0) return cross(prev, a, b) >= 0 && cross(a, next, b) >= 0;
  return cross(prev, a, b) >= 0 || cross(a, next, b) >= 0;
}

function pointInTriangle(ax, ay, bx, by, cx, cy, px, py) {
  const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function toPts(c) {
  const pts = [];
  for (let i = 0; i < c.length; i += 2) pts.push([c[i], c[i + 1]]);
  return pts;
}

/** True when a joined contour is a valid Gerber contour (no proper self-crossings). */
export function validContour(c) {
  return !selfIntersects(c);
}
