// Brush geometry for the editor's rubber and paint tools (DOM-free). A brush stroke is the
// path the pointer dragged (points in mm) swept by a round brush of radius rMm: the union of
// a capsule per segment (a disc for a single dab).
//   rubber: the stroke is cut out of every object it touches (strokeHits, strokeContours →
//           a cutOut op); holes cannot be partly drilled, so they are deleted whole
//   paint:  the stroke's outline becomes one filled region, unified with the objects it
//           touches (paintContour, strokeHits → a paint op)
// Arcs of the brush are flattened to straight segments within tolMm (chord error), inside the
// true circle, so a painted blob never reaches further than the brush.

import { booleanOp, nestPolygons } from '../model/polygons.js';
import { joinHoles, validContour } from './cut-ins.js';
import { objectsInPolygon } from './selection.js';
import { EditError } from './gerber-ops.js';

/** Chord error of the brush outline: fine enough to look round, coarse enough to stay small. */
export function brushTol(rMm) {
  return Math.max(0.0005, rMm * 0.005);
}

/** Segments in a full circle of radius r flattened within tol (at least 8). */
function circleSteps(r, tol) {
  if (tol >= r) return 8;
  return Math.max(8, Math.ceil(Math.PI / Math.acos(1 - tol / r)));
}

/** A disc of radius r round (x, y) as a CCW polygon, flat [x0, y0, ...] mm. */
export function discPolygon(x, y, r, tol = brushTol(r)) {
  const n = circleSteps(r, tol);
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = (Math.PI * 2 * k) / n;
    out.push(x + r * Math.cos(a), y + r * Math.sin(a));
  }
  return out;
}

/** The segment a→b swept by a disc of radius r: a CCW capsule polygon (a disc if a = b). */
export function capsulePolygon(a, b, r, tol = brushTol(r)) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (Math.hypot(dx, dy) < 1e-9) return discPolygon(a[0], a[1], r, tol);
  const n = Math.ceil(circleSteps(r, tol) / 2);
  const t = Math.atan2(dy, dx);
  const out = [];
  // half circle round a (its back), then round b (its front): counter-clockwise
  for (let k = 0; k <= n; k++) {
    const u = t + Math.PI / 2 + (Math.PI * k) / n;
    out.push(a[0] + r * Math.cos(u), a[1] + r * Math.sin(u));
  }
  for (let k = 0; k <= n; k++) {
    const u = t - Math.PI / 2 + (Math.PI * k) / n;
    out.push(b[0] + r * Math.cos(u), b[1] + r * Math.sin(u));
  }
  return out;
}

/** The stroke as polygons: one capsule per segment, or a disc for a single point. */
export function strokePolygons(points, rMm, tol = brushTol(rMm)) {
  if (!points.length) return [];
  if (points.length === 1) return [discPolygon(points[0][0], points[0][1], rMm, tol)];
  const out = [];
  for (let i = 1; i < points.length; i++) out.push(capsulePolygon(points[i - 1], points[i], rMm, tol));
  return out;
}

/**
 * Objects of an image the stroke touches (rubber), in drawing order.
 * @param {object} image
 * @param {number[][]} points stroke points [[x, y], ...] mm
 * @param {number} rMm brush radius
 */
export function strokeHits(image, points, rMm) {
  const hit = new Set();
  for (const poly of strokePolygons(points, rMm)) for (const i of objectsInPolygon(image, poly, 'touch')) hit.add(i);
  return [...hit].sort((a, b) => a - b);
}

const nm = (v) => Math.round(v * 1e6) / 1e6 || 0;

/** The stroke's outline as contours (outer CCW, holes CW), flat mm rounded to the nm. */
export function strokeContours(points, rMm) {
  if (!(rMm > 0) || !Number.isFinite(rMm)) throw new EditError('The brush size must be positive');
  if (!points.length) throw new EditError('Nothing under the brush');
  return booleanOp('union', strokePolygons(points, rMm), []).map((c) => c.map(nm));
}

/**
 * The painted shape of a stroke as one region contour (flat mm, CCW): the union of the
 * stroke's capsules, any holes (a stroke that loops round) joined to the outline by cut-ins.
 * Coordinates are rounded to the nm.
 */
export function paintContour(points, rMm) {
  const polys = nestPolygons(strokeContours(points, rMm));
  // a stroke is one connected shape: one outline (with holes where it loops)
  if (polys.length !== 1) throw new EditError('Could not outline the brush stroke');
  const { outer, holes } = polys[0];
  const c = holes.length ? joinHoles(outer, holes) : outer;
  if (holes.length && !validContour(c)) throw new EditError('Could not join a hole to its outline');
  return c.map(nm);
}
