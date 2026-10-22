// Selection queries for the editor (DOM-free): which objects of an image a box or lasso picks,
// which objects have the same shape as some others, and which objects touch them (connected).
// All geometry is the drawn outline of each object (src/model/polygons.js objectContours), so
// what is picked is what the viewer shows. Coordinates in mm.

import { objectContours } from '../model/polygons.js';
import { winding } from '../model/hit-test.js';

/** Outline tolerance for selection tests: well under any feature a person can click. */
const TOL_MM = 0.002;
const EPS = 1e-9;

/** Box and lasso modes: 'enclose' picks objects entirely inside, 'touch' anything they touch. */
export const SELECT_MODES = ['enclose', 'touch'];

const cache = new WeakMap(); // image → per-object contours (an image is rebuilt after edits)

/**
 * Drawn contours of object i, cached per image. Objects that draw no area (zero-size
 * apertures, often used for outlines) are their centre line or point instead, so they can
 * still be picked.
 */
export function contoursOf(image, i) {
  let c = cache.get(image);
  if (!c) cache.set(image, (c = []));
  if (!c[i]) {
    const o = image.objects[i];
    const cs = objectContours(o, TOL_MM);
    c[i] = cs.length ? cs : centreLine(o);
  }
  return c[i];
}

function centreLine(o) {
  switch (o.k) {
    case 'F':
      return [[o.x, o.y]];
    case 'L':
      return [[o.x1, o.y1, o.x2, o.y2]];
    case 'A': {
      const n = Math.max(2, Math.ceil(Math.abs(o.sw) / (Math.PI / 32)));
      const pts = [];
      for (let k = 0; k <= n; k++) {
        const a = o.a0 + (o.sw * k) / n;
        pts.push(o.cx + o.r * Math.cos(a), o.cy + o.r * Math.sin(a));
      }
      // there and back: a closed contour that covers no area
      for (let k = pts.length - 4; k >= 2; k -= 2) pts.push(pts[k], pts[k + 1]);
      return [pts];
    }
  }
  return [];
}

/** Flat polygon [x0, y0, x1, y1, ...] of an axis-aligned box given by two corners. */
export function boxPolygon([ax, ay], [bx, by]) {
  return [ax, ay, bx, ay, bx, by, ax, by];
}

/**
 * Objects a selection polygon picks.
 * @param {object} image
 * @param {number[]} poly closed polygon, flat mm (a box: boxPolygon; a lasso: its points)
 * @param {'enclose'|'touch'} mode enclose: the whole object is inside; touch: any part is
 * @returns {number[]} object indices in drawing order
 */
export function objectsInPolygon(image, poly, mode = 'enclose') {
  if (poly.length < 6) return [];
  const pb = bounds(poly);
  const ob = image.objBounds;
  const out = [];
  for (let i = 0; i < image.objects.length; i++) {
    const b = [ob[i * 4], ob[i * 4 + 1], ob[i * 4 + 2], ob[i * 4 + 3]];
    if (mode === 'enclose') {
      if (b[0] < pb[0] || b[1] < pb[1] || b[2] > pb[2] || b[3] > pb[3]) continue;
      if (enclosed(contoursOf(image, i), poly)) out.push(i);
    } else {
      if (!overlap(b, pb)) continue;
      if (touches(contoursOf(image, i), [poly])) out.push(i);
    }
  }
  return out;
}

/**
 * A key that is equal for apertures of the same geometry (whatever their D-code or tool
 * number): standard apertures by template and sizes, macros by name and parameters.
 */
export function apertureKey(ap) {
  if (!ap) return null;
  if (ap.kind === 'block') return `block:${ap.code}`;
  const p = (ap.mm ?? ap.params ?? []).map((v) => (typeof v === 'number' ? r6(v) : v));
  return `${ap.kind}:${ap.template}:${p.join(',')}`;
}

/**
 * A key that is equal for objects of the same shape: same aperture and transform for flashes,
 * same aperture and the same vector for straight draws (either direction), same aperture,
 * radius and sweep for arcs, and the same outline up to a move for regions.
 */
export function shapeKey(o) {
  const m = o.m ? `|${o.m.map(r6).join(',')}` : '';
  const pol = o.dark ? '' : '|clear';
  switch (o.k) {
    case 'F':
      return `F|${apertureKey(o.ap)}${m}${pol}`;
    case 'L': {
      let dx = r6(o.x2 - o.x1);
      let dy = r6(o.y2 - o.y1);
      if (dx < 0 || (dx === 0 && dy < 0)) [dx, dy] = [-dx, -dy];
      return `L|${apertureKey(o.ap)}|${dx},${dy}${m}${pol}`;
    }
    case 'A':
      return `A|${apertureKey(o.ap)}|${r6(o.r)},${r6(o.a0)},${r6(o.sw)}${m}${pol}`;
    case 'R': {
      let x0 = Infinity;
      let y0 = Infinity;
      for (const c of o.contours)
        for (let i = 0; i < c.length; i += 2) {
          x0 = Math.min(x0, c[i]);
          y0 = Math.min(y0, c[i + 1]);
        }
      const rel = o.contours.map((c) => c.map((v, i) => r6(v - (i % 2 ? y0 : x0))).join(','));
      return `R|${rel.join(';')}${pol}`;
    }
  }
  return null;
}

/** Every object with the same shape (shapeKey) as one of the seed objects. */
export function sameShape(image, seeds) {
  const keys = new Set(seeds.map((i) => shapeKey(image.objects[i])));
  const out = [];
  image.objects.forEach((o, i) => keys.has(shapeKey(o)) && out.push(i));
  return out;
}

/** Every flash and draw made with the same aperture geometry (apertureKey) as a seed object. */
export function sameAperture(image, seeds) {
  const keys = new Set(seeds.map((i) => apertureKey(image.objects[i].ap)).filter(Boolean));
  const out = [];
  image.objects.forEach((o, i) => o.ap && keys.has(apertureKey(o.ap)) && out.push(i));
  return out;
}

/**
 * Objects connected to the seeds: dark objects that overlap or touch, followed on from object
 * to object (a net's pads, tracks and pours on this layer). Clear objects are not followed —
 * a clear object that cuts a track in two does not split it here.
 */
export function connected(image, seeds) {
  const objs = image.objects;
  const ob = image.objBounds;
  const grid = boundsGrid(image);
  const seen = new Set(seeds);
  const queue = seeds.filter((i) => objs[i]?.dark);
  while (queue.length) {
    const i = queue.pop();
    const b = [ob[i * 4], ob[i * 4 + 1], ob[i * 4 + 2], ob[i * 4 + 3]];
    const ci = contoursOf(image, i);
    for (const j of grid.query(b)) {
      if (seen.has(j) || !objs[j].dark) continue;
      if (!touches(contoursOf(image, j), ci)) continue;
      seen.add(j);
      queue.push(j);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/** Uniform grid over the object bounding boxes, for "which boxes overlap this one". */
function boundsGrid(image) {
  const ob = image.objBounds;
  const n = image.objects.length;
  const b = image.bounds ?? [0, 0, 1, 1];
  const w = Math.max(b[2] - b[0], 1e-6);
  const h = Math.max(b[3] - b[1], 1e-6);
  const cell = Math.max(Math.sqrt((w * h) / Math.max(1, n)), 1e-3);
  const cols = Math.max(1, Math.ceil(w / cell));
  const rows = Math.max(1, Math.ceil(h / cell));
  const cells = new Map();
  const big = [];
  const range = (i0, i1, j0, j1) => [
    Math.max(0, Math.floor((i0 - b[0]) / cell)),
    Math.min(cols - 1, Math.floor((i1 - b[0]) / cell)),
    Math.max(0, Math.floor((j0 - b[1]) / cell)),
    Math.min(rows - 1, Math.floor((j1 - b[1]) / cell)),
  ];
  for (let i = 0; i < n; i++) {
    const [c0, c1, r0, r1] = range(ob[i * 4], ob[i * 4 + 2], ob[i * 4 + 1], ob[i * 4 + 3]);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > 64) {
      big.push(i);
      continue;
    }
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const k = r * cols + c;
        let l = cells.get(k);
        if (!l) cells.set(k, (l = []));
        l.push(i);
      }
  }
  return {
    query(q) {
      const out = new Set(big);
      const [c0, c1, r0, r1] = range(q[0] - EPS, q[2] + EPS, q[1] - EPS, q[3] + EPS);
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) for (const i of cells.get(r * cols + c) ?? []) out.add(i);
      return [...out].filter((i) => overlap([ob[i * 4], ob[i * 4 + 1], ob[i * 4 + 2], ob[i * 4 + 3]], q));
    },
  };
}

// ---------------------------------------------------------------- polygon tests

/** Inside a contour list (non-zero winding: holes, wound the other way, are outside). */
function inside(contours, x, y) {
  let w = 0;
  for (const c of contours) w += winding(c, x, y);
  return w !== 0;
}

/** Every outline point is inside the polygon and no outline edge crosses it. */
function enclosed(contours, poly) {
  if (!contours.length) return false;
  for (const c of contours) for (let i = 0; i < c.length; i += 2) if (!inside([poly], c[i], c[i + 1])) return false;
  return !edgesCross(contours, [poly]);
}

/** Two contour lists (filled, non-zero) share any point. */
function touches(a, b) {
  if (!a.length || !b.length) return false;
  for (const c of a) if (inside(b, c[0], c[1])) return true;
  for (const c of b) if (inside(a, c[0], c[1])) return true;
  return edgesCross(a, b);
}

function edgesCross(a, b) {
  for (const ca of a) {
    const ba = bounds(ca);
    for (const cb of b) {
      if (!overlap(ba, bounds(cb))) continue;
      for (let i = 0, pi = ca.length - 2; i < ca.length; pi = i, i += 2) {
        const sx0 = Math.min(ca[pi], ca[i]);
        const sx1 = Math.max(ca[pi], ca[i]);
        const sy0 = Math.min(ca[pi + 1], ca[i + 1]);
        const sy1 = Math.max(ca[pi + 1], ca[i + 1]);
        for (let j = 0, pj = cb.length - 2; j < cb.length; pj = j, j += 2) {
          if (Math.max(cb[pj], cb[j]) < sx0 - EPS || Math.min(cb[pj], cb[j]) > sx1 + EPS) continue;
          if (Math.max(cb[pj + 1], cb[j + 1]) < sy0 - EPS || Math.min(cb[pj + 1], cb[j + 1]) > sy1 + EPS) continue;
          if (segmentsMeet(ca[pi], ca[pi + 1], ca[i], ca[i + 1], cb[pj], cb[pj + 1], cb[j], cb[j + 1])) return true;
        }
      }
    }
  }
  return false;
}

/** Closed segments p1p2 and p3p4 share a point (touching ends count). */
function segmentsMeet(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d1 = cross(x3, y3, x4, y4, x1, y1);
  const d2 = cross(x3, y3, x4, y4, x2, y2);
  const d3 = cross(x1, y1, x2, y2, x3, y3);
  const d4 = cross(x1, y1, x2, y2, x4, y4);
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS)))
    return true;
  return (
    (Math.abs(d1) <= EPS && onSegment(x3, y3, x4, y4, x1, y1)) ||
    (Math.abs(d2) <= EPS && onSegment(x3, y3, x4, y4, x2, y2)) ||
    (Math.abs(d3) <= EPS && onSegment(x1, y1, x2, y2, x3, y3)) ||
    (Math.abs(d4) <= EPS && onSegment(x1, y1, x2, y2, x4, y4))
  );
}

const cross = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);

function onSegment(ax, ay, bx, by, px, py) {
  return (
    px >= Math.min(ax, bx) - EPS &&
    px <= Math.max(ax, bx) + EPS &&
    py >= Math.min(ay, by) - EPS &&
    py <= Math.max(ay, by) + EPS
  );
}

function bounds(c) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < c.length; i += 2) {
    if (c[i] < b[0]) b[0] = c[i];
    if (c[i] > b[2]) b[2] = c[i];
    if (c[i + 1] < b[1]) b[1] = c[i + 1];
    if (c[i + 1] > b[3]) b[3] = c[i + 1];
  }
  return b;
}

const overlap = (a, b) => a[0] <= b[2] + EPS && a[2] >= b[0] - EPS && a[1] <= b[3] + EPS && a[3] >= b[1] - EPS;

const r6 = (v) => Math.round(v * 1e6) / 1e6 || 0;
