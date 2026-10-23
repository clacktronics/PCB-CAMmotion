// Node editing of regions (G36/G37, spec 4.10): the corners of a region's contours, and the
// ops that move, insert and delete them.
//
// Ops (plain JSON in model/edits.json, applied by applyGerberOp like the others):
//   { type: 'moveVertex',   target, vertices, dxMm, dyMm }  move corners
//   { type: 'insertVertex', target, segment, xMm, yMm }     new corner on an edge
//   { type: 'deleteVertex', target, vertices }              remove corners
// target is the region's G37 command index (at the time the op runs), as for the other ops.
// Corners (vertices) and edges (segment) are numbered by the D operations between G36 and
// G37, from 0, with an explicit start: when the first contour starts at the current point (a
// D01 straight after G36), that start counts as operation 0. A corner is a contour's D02
// start or the end point of one of its D01s; the closing D01 that comes back to the start is
// not a corner of its own and moves with the start. An edge is numbered by the D01 that
// draws it.
//
// Arc edges (G02/G03) keep their sweep angle when an end moves: the centre (I, J) is worked
// out again for the new chord, so a quarter circle stays a quarter circle. A corner inserted
// on an arc splits it into two arcs of half the sweep each (exact at the arc's midpoint,
// where the editor offers it). Region contours are not transformed by LM/LR/LS (those apply
// to apertures, spec 4.9), so corners are plain file coordinates.

import { EditError, targetInfo, scanState, dependsOnCurrentPoint, pointBefore, spliceMany } from './gerber-ops.js';
import { fileUnit, mmPerCount } from './gerber-normalize.js';

const TAU = Math.PI * 2;

export const NODE_OPS = ['moveVertex', 'insertVertex', 'deleteVertex'];

/**
 * The D operations of a region (explicit start first) and its contours.
 * ops[k]: { ci (command index, -1 for an implicit start), op, x, y, i, j, interp, quadrant }
 * contours: { start, segs (D01 numbers), closing (the D01 back to the start, or -1), nodes }
 */
function readRegion(commands, target) {
  const t = targetInfo(commands, target);
  if (t.kind !== 'region') throw new EditError('Only regions have corners to edit');
  const st = scanState(commands, t.start);
  let interp = st.interp;
  let quadrant = st.quadrant;
  const ops = [];
  for (let ci = t.start + 1; ci < t.ci; ci++) {
    const c = commands[ci];
    if (c.type === 'G') {
      if (c.code <= 3) interp = c.code;
      else if (c.code === 74) quadrant = 'single';
      else if (c.code === 75) quadrant = 'multi';
      continue;
    }
    if (c.type !== 'D') continue;
    if (c.op === 3) throw new EditError('This region has a flash (D03) inside it');
    if (!ops.length && c.op === 1) {
      const [x, y] = pointBefore(commands, t.start);
      ops.push({ ci: -1, op: 2, x, y, line: c.line });
    }
    ops.push({ ci, op: c.op, x: c.x, y: c.y, i: c.i, j: c.j, interp, quadrant, line: c.line });
  }
  const contours = [];
  let cur = null;
  ops.forEach((o, k) => {
    if (o.op === 2) {
      cur = { start: k, segs: [] };
      contours.push(cur);
    } else cur.segs.push(k);
  });
  const out = contours.filter((c) => c.segs.length); // a D02 with no D01 after it draws nothing
  const owner = new Map(); // corner or closing D01 number → [contour, corner number]
  for (const c of out) {
    const last = c.segs.at(-1);
    c.closing = samePt(ops[last], ops[c.start]) ? last : -1;
    c.nodes = [c.start, ...c.segs.filter((k) => k !== c.closing)];
    for (const k of c.nodes) owner.set(k, [c, k]);
    if (c.closing >= 0) owner.set(c.closing, [c, c.start]);
  }
  return { t, ops, contours: out, owner };
}

const samePt = (a, b) => a.x === b.x && a.y === b.y;

/** Centre and signed sweep of the arc D01 `o` from point p (spec 4.7.2), or null if invalid. */
export function arcOf(p, o) {
  const ccw = o.interp === 3;
  const i = o.i ?? 0;
  const j = o.j ?? 0;
  const single = o.quadrant === 'single';
  // G75 (and no mode, as the interpreter assumes): signed offsets; G74: unsigned, at most 90°
  const centres = single
    ? [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ].map(([a, b]) => [p.x + a * Math.abs(i), p.y + b * Math.abs(j)])
    : [[p.x + i, p.y + j]];
  let best = null;
  for (const [cx, cy] of centres) {
    const r1 = Math.hypot(p.x - cx, p.y - cy);
    const r2 = Math.hypot(o.x - cx, o.y - cy);
    if (r1 === 0 && r2 === 0) continue;
    const a0 = Math.atan2(p.y - cy, p.x - cx);
    let sw = Math.atan2(o.y - cy, o.x - cx) - a0;
    if (single) {
      if (ccw && sw < 0) sw += TAU;
      if (!ccw && sw > 0) sw -= TAU;
      if (Math.abs(sw) > Math.PI / 2 + 1e-6) continue;
    } else if (samePt(p, o)) sw = ccw ? TAU : -TAU;
    else {
      if (ccw && sw <= 0) sw += TAU;
      if (!ccw && sw >= 0) sw -= TAU;
    }
    const err = Math.abs(r1 - r2);
    if (!best || err < best.err) best = { err, cx, cy, r: (r1 + r2) / 2, a0, sw };
  }
  return best;
}

/**
 * Centre of the arc from p to q with signed sweep sw (radians, positive = anticlockwise), or
 * null when p and q are the same point (a full circle keeps its centre, nothing else fits).
 */
export function arcCentre(p, q, sw) {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  // the centre is on the chord's perpendicular bisector, left of p→q for a short
  // anticlockwise arc; tan(sw / 2) carries the side and the distance
  const d = len / 2 / Math.tan(sw / 2);
  return { x: (p.x + q.x) / 2 - (dy / len) * d, y: (p.y + q.y) / 2 + (dx / len) * d };
}

/** I and J (counts) of an arc from p to q with sweep sw in the given quadrant mode. */
function arcIJ(p, q, sw, quadrant, keep) {
  const c = arcCentre(p, q, sw);
  if (!c) {
    if (Math.abs(sw) >= TAU - 1e-9 && keep) return keep; // full circle: the centre moves with its point
    throw new EditError('The two ends of an arc cannot be at the same point');
  }
  const i = Math.round(c.x - p.x);
  const j = Math.round(c.y - p.y);
  return quadrant === 'single' ? { i: Math.abs(i), j: Math.abs(j) } : { i, j };
}

/**
 * The region's commands again with corners moved (pos: D number → [x, y] counts), D operations
 * dropped and new D01s inserted (before: D number → [{x, y, sw}] drawn just before it); arcs
 * whose ends changed keep their sweep (or take sweep: D number → sweep).
 */
function rebuild(commands, r, { pos = new Map(), drop = new Set(), before = new Map(), sweep = new Map() }) {
  const { t, ops } = r;
  const kOf = new Map(ops.map((o, k) => [o.ci, k]));
  const at = (k) => {
    const p = pos.get(k);
    return p ? { x: p[0], y: p[1] } : { x: ops[k].x, y: ops[k].y };
  };
  const out = [commands[t.start]];
  let prev = null;
  const emit = (c, k) => {
    const o = ops[k];
    for (const n of before.get(k) || []) {
      const extra = o.interp === 1 ? {} : arcIJ(prev, n, n.sw, o.quadrant);
      out.push({ type: 'D', op: 1, x: n.x, y: n.y, line: o.line, ...extra });
      prev = { x: n.x, y: n.y };
    }
    if (drop.has(k)) return;
    const p = at(k);
    const next = { ...c, x: p.x, y: p.y };
    if (o.op === 1 && o.interp !== 1) {
      const from = ops[k - 1];
      const moved = !samePt(prev, from) || !samePt(p, o) || sweep.has(k);
      if (moved) {
        const arc = arcOf(from, o);
        if (!arc) throw new EditError('This region has an arc whose centre does not fit its ends');
        Object.assign(next, arcIJ(prev, p, sweep.get(k) ?? arc.sw, o.quadrant, { i: o.i, j: o.j }));
      }
    }
    out.push(next);
    prev = p;
  };
  if (ops[0]?.ci === -1) emit({ type: 'D', op: 2, line: ops[0].line }, 0);
  for (let ci = t.start + 1; ci < t.ci; ci++) {
    const c = commands[ci];
    if (c.type === 'D') emit(c, kOf.get(ci));
    else out.push(c);
  }
  const select = out.length;
  out.push(commands[t.ci]);
  const last = ops.at(-1);
  if (last && prev && !samePt(prev, last) && dependsOnCurrentPoint(commands, t.ci + 1))
    out.push({ type: 'D', op: 2, x: last.x, y: last.y, line: last.line });
  return spliceMany(commands, [{ at: t.start, remove: t.ci - t.start + 1, insert: out, select: [select] }]);
}

/** The corner numbers named by an op (a closing D01 stands for its contour's start). */
function corners(r, vertices) {
  if (!Array.isArray(vertices) || !vertices.length) throw new EditError('No corner selected');
  const out = new Set();
  for (const k of vertices) {
    const o = r.owner.get(k);
    if (!o) throw new EditError(`Corner ${k} is not part of this region`);
    out.add(o[1]);
  }
  return [...out];
}

/**
 * Apply a node op (moveVertex, insertVertex, deleteVertex) to a normalised command list.
 * @returns {{commands: object[], select: number[]}} select: the region's G37 index
 */
export function applyNodeOp(commands, op) {
  const k = mmPerCount(fileUnit(commands));
  const count = (mm) => {
    if (!Number.isFinite(mm)) throw new EditError('Invalid coordinate');
    return Math.round(mm / k);
  };
  const r = readRegion(commands, op.target);
  switch (op.type) {
    case 'moveVertex': {
      const dx = count(op.dxMm);
      const dy = count(op.dyMm);
      const pos = new Map();
      for (const v of corners(r, op.vertices)) {
        const [c] = r.owner.get(v);
        const p = [r.ops[v].x + dx, r.ops[v].y + dy];
        pos.set(v, p);
        if (v === c.start && c.closing >= 0) pos.set(c.closing, p);
      }
      return rebuild(commands, r, { pos });
    }
    case 'insertVertex': {
      const s = op.segment;
      const c = r.contours.find((x) => x.segs.includes(s));
      if (!c) throw new EditError(`Edge ${s} is not part of this region`);
      const n = { x: count(op.xMm), y: count(op.yMm) };
      const o = r.ops[s];
      if (samePt(n, r.ops[s - 1]) || samePt(n, o)) throw new EditError('There is already a corner there');
      if (o.interp === 1) return rebuild(commands, r, { before: new Map([[s, [n]]]) });
      const arc = arcOf(r.ops[s - 1], o);
      if (!arc) throw new EditError('This region has an arc whose centre does not fit its ends');
      const half = arc.sw / 2;
      return rebuild(commands, r, { before: new Map([[s, [{ ...n, sw: half }]]]), sweep: new Map([[s, half]]) });
    }
    case 'deleteVertex': {
      const del = new Set(corners(r, op.vertices));
      const pos = new Map();
      const drop = new Set();
      for (const c of r.contours) {
        if (!c.nodes.some((v) => del.has(v))) continue;
        const kept = c.nodes.filter((v) => !del.has(v));
        if (kept.length < 3) throw new EditError('A region outline needs at least 3 corners');
        for (const v of c.nodes) if (del.has(v) && v !== c.start) drop.add(v);
        if (del.has(c.start)) {
          // the next corner kept becomes the contour's start; the edge that led to it goes
          const n = kept[0];
          const p = [r.ops[n].x, r.ops[n].y];
          pos.set(c.start, p);
          drop.add(n);
          if (c.closing >= 0) pos.set(c.closing, p);
        }
      }
      return rebuild(commands, r, { pos, drop });
    }
    default:
      throw new EditError(`Unknown edit ${op.type}`);
  }
}

/**
 * Corners and edges of a region for the node editor, in mm.
 * @param {object[]} commands normalised commands
 * @param {number} target the region's G37 command index
 * @returns {{contours: {nodes: number[], closed: boolean,
 *   path: {k:number, x:number, y:number, sw:number|null, c?:number[]}[]}[],
 *   points: Map<number, [number, number]>}} path: each contour's start then every D01 in
 *   order (sw and c: the arc's sweep and centre, sw null for straight edges); points:
 *   corner number → [x, y]
 */
export function regionNodes(commands, target) {
  const r = readRegion(commands, target);
  const mm = mmPerCount(fileUnit(commands));
  const points = new Map();
  const contours = r.contours.map((c) => {
    for (const k of c.nodes) points.set(k, [r.ops[k].x * mm, r.ops[k].y * mm]);
    const path = [c.start, ...c.segs].map((k) => {
      const o = r.ops[k];
      const e = { k, x: o.x * mm, y: o.y * mm, sw: null };
      const arc = o.op === 1 && o.interp !== 1 ? arcOf(r.ops[k - 1], o) : null;
      if (arc) Object.assign(e, { sw: arc.sw, c: [arc.cx * mm, arc.cy * mm] });
      return e;
    });
    return { nodes: c.nodes, closing: c.closing, closed: c.closing >= 0, path };
  });
  return { contours, points };
}

/**
 * Outline of a contour from regionNodes as a flat list of points (mm), with corners moved
 * (pos: corner number → [x, y]; a moved start also moves the closing point) and optionally
 * a new corner inserted on an edge, as the ops would make it. For previews while dragging.
 * @param {{path: object[], closing: number}} contour
 * @param {{pos?: Map<number, number[]>, insert?: {segment:number, x:number, y:number}}} [change]
 * @param {number} [tolMm] how closely arcs are followed
 */
export function contourPoints(contour, { pos = new Map(), insert = null } = {}, tolMm = 0.005) {
  const path = contour.path;
  const startPos = pos.get(path[0].k);
  const at = (e) => {
    const p = pos.get(e.k) ?? (e.k === contour.closing ? startPos : null);
    return p ? { x: p[0], y: p[1] } : { x: e.x, y: e.y };
  };
  let prev = at(path[0]);
  const out = [prev.x, prev.y];
  const to = (p, sw, e) => {
    if (sw !== null) {
      // a full circle has no chord to place its centre by: the centre moves with its point
      const c = arcCentre(prev, p, sw) ?? (e.c && { x: e.c[0] + p.x - e.x, y: e.c[1] + p.y - e.y });
      if (c) {
        const r = Math.hypot(prev.x - c.x, prev.y - c.y);
        const a0 = Math.atan2(prev.y - c.y, prev.x - c.x);
        const step = 2 * Math.acos(Math.max(-1, 1 - tolMm / Math.max(r, tolMm)));
        const n = Math.max(2, Math.ceil(Math.abs(sw) / step));
        for (let s = 1; s < n; s++)
          out.push(c.x + r * Math.cos(a0 + (sw * s) / n), c.y + r * Math.sin(a0 + (sw * s) / n));
      }
    }
    out.push(p.x, p.y);
    prev = p;
  };
  for (const e of path.slice(1)) {
    const split = insert && insert.segment === e.k;
    const sw = e.sw === null ? null : split ? e.sw / 2 : e.sw;
    if (split) to({ x: insert.x, y: insert.y }, sw, e);
    to(at(e), sw, e);
  }
  return out;
}
