// Polygon geometry of image objects, and polygon booleans (union / difference) through the
// vendored Clipper library (vendor/clipper, Vatti clipping on an integer grid).
//
// Object outlines come from the renderer's own emitObject (src/render/draw-image.js, DOM-free),
// so the polygons are exactly what the viewer draws: capsules for round-aperture draws,
// hulls for rectangular ones, annular sectors for arcs, aperture paths for flashes.
// Arcs are flattened to straight segments within tolMm (chord error).
//
// Polygons are lists of contours; a contour is a flat [x0, y0, x1, y1, ...] array in mm.
// Outer contours are counter-clockwise, holes clockwise (Y up), as everywhere in the model.

import ClipperLib from '../../vendor/clipper/clipper.cjs';
import { emitObject, transformedParts } from '../render/draw-image.js';
import { arcSegments, emitPath, signedArea } from './path.js';

/** Clipper works on integers: 1 unit = 10 nm (boards up to ±470 mm stay on its fast path). */
const SCALE = 1e5;
const TAU = Math.PI * 2;
export const DEFAULT_TOL_MM = 0.0005;

/**
 * A render-target-like sink that records contours, flattening arcs (canvas arc semantics:
 * arc() first draws a line from the current point to the arc start; anticlockwise = false
 * means the angle increases, Y up).
 */
export class FlattenSink {
  constructor(tolMm = DEFAULT_TOL_MM) {
    this.tol = tolMm;
    this.contours = [];
    this.cur = null;
  }
  moveTo(x, y) {
    this.closePath();
    this.cur = [x, y];
  }
  lineTo(x, y) {
    if (!this.cur) this.cur = [];
    this.cur.push(x, y);
  }
  arc(cx, cy, r, a0, a1, anticlockwise) {
    let sw = a1 - a0;
    if (!anticlockwise) {
      if (sw < 0) sw += TAU * Math.ceil(-sw / TAU);
      if (sw > TAU) sw = TAU;
    } else {
      if (sw > 0) sw -= TAU * Math.ceil(sw / TAU);
      if (sw < -TAU) sw = -TAU;
    }
    const n = arcSegments(r, sw, this.tol);
    for (let k = 0; k <= n; k++) {
      const a = a0 + (sw * k) / n;
      this.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
  }
  closePath() {
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    const n = c.length;
    if (n >= 4 && Math.abs(c[0] - c[n - 2]) < 1e-12 && Math.abs(c[1] - c[n - 1]) < 1e-12) c.length = n - 2;
    if (c.length >= 6) this.contours.push(c);
  }
  // render target methods the renderer may call
  begin() {}
  fill() {}
}

/** Contours (mm) of one object, as drawn. Flashes of non-simple macros resolve their parts. */
export function objectContours(o, tolMm = DEFAULT_TOL_MM) {
  if (o.k === 'F' && o.ap.shape && !o.ap.shape.simple) {
    let acc = [];
    for (const p of transformedParts(o.ap, o.m)) {
      const s = new FlattenSink(tolMm);
      emitPath(s, p.path, o.x, o.y);
      s.closePath();
      acc = p.dark ? booleanOp('union', [...acc, ...s.contours], []) : booleanOp('difference', acc, s.contours);
    }
    return acc;
  }
  const s = new FlattenSink(tolMm);
  emitObject(o, s, 0);
  s.closePath();
  return s.contours;
}

const toPath = (c) => {
  const p = new Array(c.length / 2);
  for (let i = 0; i < c.length; i += 2) p[i / 2] = { X: Math.round(c[i] * SCALE), Y: Math.round(c[i + 1] * SCALE) };
  return p;
};
const fromPath = (p) => {
  const c = new Array(p.length * 2);
  for (let i = 0; i < p.length; i++) {
    c[i * 2] = p[i].X / SCALE;
    c[i * 2 + 1] = p[i].Y / SCALE;
  }
  return c;
};

/**
 * Boolean operation on contour lists, non-zero fill (as the renderer fills).
 * @param {'union'|'difference'|'intersection'} op
 * @returns {number[][]} contours, outers CCW and holes CW
 */
export function booleanOp(op, subject, clip) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject.map(toPath), ClipperLib.PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(clip.map(toPath), ClipperLib.PolyType.ptClip, true);
  const out = [];
  const type = { union: 'ctUnion', difference: 'ctDifference', intersection: 'ctIntersection' }[op];
  const nz = ClipperLib.PolyFillType.pftNonZero;
  c.Execute(ClipperLib.ClipType[type], out, nz, nz);
  return out.map(fromPath).filter((p) => p.length >= 6);
}

/**
 * Nest contours into polygons: [{ outer, holes }] (outer CCW, holes CW). Islands inside
 * holes are polygons of their own.
 */
export function nestPolygons(contours) {
  const c = new ClipperLib.Clipper();
  c.StrictlySimple = true;
  c.AddPaths(contours.map(toPath), ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  const nz = ClipperLib.PolyFillType.pftNonZero;
  c.Execute(ClipperLib.ClipType.ctUnion, tree, nz, nz);
  const polys = [];
  const visit = (node) => {
    for (const ch of node.Childs()) {
      if (ch.IsHole()) {
        visit(ch);
        continue;
      }
      const outer = ccw(fromPath(ch.Contour()), true);
      if (outer.length < 6) continue;
      const holes = [];
      for (const h of ch.Childs()) {
        const hc = ccw(fromPath(h.Contour()), false);
        if (hc.length >= 6) holes.push(hc);
        visit(h); // islands inside the hole
      }
      polys.push({ outer, holes });
    }
  };
  visit(tree);
  return polys;
}

function ccw(c, wantCcw) {
  if (signedArea(c) > 0 === wantCcw) return c;
  const out = new Array(c.length);
  for (let i = 0, j = c.length - 2; j >= 0; j -= 2, i += 2) {
    out[i] = c[j];
    out[i + 1] = c[j + 1];
  }
  return out;
}

/**
 * The final shape of some objects of an image, polarity applied in drawing order (spec 4.3.2:
 * clear objects erase what was drawn before them).
 * @param {object} image
 * @param {number[]} [indices] objects to use (default: all), in drawing order
 * @returns {number[][]} contours
 */
export function imageContours(image, indices, tolMm = DEFAULT_TOL_MM) {
  const objs = image.objects;
  const list = indices ?? objs.map((_, i) => i);
  let acc = [];
  let batch = [];
  let batchDark = null;
  const flush = () => {
    if (!batch.length) return;
    acc = batchDark ? booleanOp('union', [...acc, ...batch], []) : booleanOp('difference', acc, batch);
    batch = [];
  };
  for (const i of list) {
    const o = objs[i];
    if (o.dark !== batchDark) {
      flush();
      batchDark = o.dark;
    }
    for (const c of objectContours(o, tolMm)) batch.push(c);
  }
  flush();
  return acc;
}

/** Total area (mm²) of contours (holes negative). */
export function contoursArea(contours) {
  return contours.reduce((s, c) => s + signedArea(c), 0);
}
