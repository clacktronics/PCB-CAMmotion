// Gerber edit operations on a normalised command list (src/edit/gerber-normalize.js).
//
// An op is plain JSON, stored in the .pcam (model/edits.json) and replayed on load:
//   { type: 'delete',  targets }                       remove objects
//   { type: 'move',    targets, dxMm, dyMm }           translate objects
//   { type: 'addFlash', aperture, xMm, yMm }           flash (pad) at a point
//   { type: 'addTrack', aperture, pointsMm }           connected draws through the points
//   { type: 'addRegion', pointsMm }                    filled polygon (G36/G37)
//   { type: 'toRegion', targets, tolMm }               turn objects into regions; objects
//                                                      that overlap are unified into one outline
//   { type: 'unifyLayer', tolMm }                      the whole layer as non-overlapping regions
//   { type: 'paint', targets, pointsMm, tolMm }       a filled outline (the paint brush) unified
//                                                      with the objects it touches: they become
//                                                      regions of the union, drawn last (no
//                                                      targets: the same as addRegion)
//   { type: 'cutOut', targets, clipMm, tolMm }         cut a shape out of objects (the rubber):
//                                                      each becomes regions of what is left of
//                                                      it, drawn where it was (nothing left:
//                                                      removed); clipMm is a list of contours
//   { type: 'moveVertex' | 'insertVertex' | 'deleteVertex', target, ... }
//                                                      edit a region's corners (src/edit/region-nodes.js)
// targets are command indices (at the time the op runs) of the commands that produced the
// objects: the D01/D03 of a draw or flash, the G37 of a region. aperture is { code } (an
// existing aperture) or { template: 'C'|'R'|'O', paramsMm } (reused if an identical one exists).
// pointsMm is a flat [x0, y0, x1, y1, ...] list.
//
// Commands are only ever replaced, inserted or removed; nothing else in the file changes.
// Because coordinates are absolute, a command's only dependency on its neighbours is the
// current point (a D01 draws from it, spec 4.7): wherever an edit changes where the current
// point ends up, a D02 move restores it for the commands that follow.

import { objectCommand, commandObjectRange } from '../analyze/commands.js';
import { fileUnit, mmPerCount } from './gerber-normalize.js';
import { imageContours, nestPolygons, booleanOp, contoursArea, DEFAULT_TOL_MM } from '../model/polygons.js';
import { joinHoles, validContour } from './cut-ins.js';
import { emitObject } from '../render/draw-image.js';
import { applyNodeOp, NODE_OPS } from './region-nodes.js';

const TAU = Math.PI * 2;

export class EditError extends Error {}

/**
 * Which command an object belongs to, for editing.
 * @returns {{ci:number, kind:'flash'|'draw'|'region', objects:[number, number]}|{error:string}}
 */
export function gerberTarget(commands, image, oi) {
  const ci = objectCommand(image, oi);
  if (ci < 0) return { error: 'This object is not linked to a command' };
  const info = targetInfo(commands, ci, false);
  if (info.error) return info;
  return { ...info, objects: commandObjectRange(image, ci) };
}

/** The command `ci` as an edit target: { ci, kind, start? } (throws EditError, or with strict false returns { error }). */
export function targetInfo(commands, ci, strict = true) {
  const c = commands[ci];
  let r;
  if (c?.type === 'D' && c.op === 3) r = { ci, kind: 'flash' };
  else if (c?.type === 'D' && c.op === 1) r = { ci, kind: 'draw' };
  else if (c?.type === 'G' && c.code === 37) {
    let s = ci - 1;
    while (s >= 0 && !(commands[s].type === 'G' && commands[s].code === 36)) s--;
    r = s < 0 ? { error: 'Region without G36' } : { ci, kind: 'region', start: s };
  } else if (c?.type === 'SR' || c?.type === 'M02')
    r = { error: 'Objects made by step and repeat can only be edited all together (not yet supported)' };
  else r = { error: 'This object cannot be edited' };
  if (!r.error) {
    const st = scanState(commands, r.kind === 'region' ? r.start : ci);
    if (st.srOpen) r = { error: 'Objects inside a step and repeat block cannot be edited one by one' };
    else if (st.blockDepth) r = { error: 'Objects inside an aperture block definition cannot be edited' };
  }
  if (strict && r.error) throw new EditError(r.error);
  return r;
}

/** Graphics state before command `upTo` (only what edits need). */
export function scanState(commands, upTo) {
  const st = {
    dark: true,
    mirror: 'N',
    rot: 0,
    scale: 1,
    ap: null,
    interp: 1,
    quadrant: null,
    regionStart: -1,
    srOpen: false,
    blockDepth: 0,
    attrs: false,
    x: 0,
    y: 0,
  };
  for (let i = 0; i < upTo && i < commands.length; i++) {
    const c = commands[i];
    switch (c.type) {
      case 'LP':
        st.dark = c.polarity === 'D';
        break;
      case 'LM':
        st.mirror = c.mirror;
        break;
      case 'LR':
        st.rot = c.deg;
        break;
      case 'LS':
        st.scale = c.scale;
        break;
      case 'Dnn':
        st.ap = c.code;
        break;
      case 'G':
        if (c.code <= 3) st.interp = c.code;
        else if (c.code === 74) st.quadrant = 'single';
        else if (c.code === 75) st.quadrant = 'multi';
        else if (c.code === 36) st.regionStart = i;
        else if (c.code === 37) st.regionStart = -1;
        break;
      case 'SR':
        st.srOpen = !c.close && (c.x > 1 || c.y > 1);
        break;
      case 'AB':
        st.blockDepth += c.close ? -1 : 1;
        break;
      case 'TA':
      case 'TO':
        st.attrs = true;
        break;
      case 'TD':
        if (c.name === null) st.attrs = false;
        break;
      case 'D':
        st.x = c.x;
        st.y = c.y;
        break;
    }
  }
  return st;
}

/** Does the command at `from` (or the next drawing command after it) draw from the current point? */
export function dependsOnCurrentPoint(commands, from) {
  for (let i = from; i < commands.length; i++) {
    const c = commands[i];
    if (c.type === 'D') return c.op === 1;
    if (c.type === 'M02') return false;
  }
  return false;
}

/** The current point before command ci (counts). */
export function pointBefore(commands, ci) {
  for (let i = ci - 1; i >= 0; i--) if (commands[i].type === 'D') return [commands[i].x, commands[i].y];
  return [0, 0];
}

const D = (op, x, y, line, extra) => ({ type: 'D', op, x, y, line, ...extra });

/**
 * Replace several non-overlapping ranges at once.
 * @param {{at:number, remove:number, insert:object[], select?:number[]}[]} edits
 * @returns {{commands: object[], select: number[]}} select: indices in the new list
 */
export function spliceMany(commands, edits) {
  const list = [...edits].sort((a, b) => a.at - b.at);
  for (let i = 1; i < list.length; i++)
    if (list[i].at < list[i - 1].at + list[i - 1].remove) throw new EditError('Overlapping edits');
  const out = [];
  const select = [];
  let pos = 0;
  for (const e of list) {
    for (let i = pos; i < e.at; i++) out.push(commands[i]);
    for (const off of e.select || []) select.push(out.length + off);
    for (const c of e.insert) out.push(c);
    pos = e.at + e.remove;
  }
  for (let i = pos; i < commands.length; i++) out.push(commands[i]);
  return { commands: out, select };
}

function uniqueTargets(commands, targets) {
  if (!Array.isArray(targets) || !targets.length) throw new EditError('Nothing selected');
  return [...new Set(targets)].map((ci) => targetInfo(commands, ci));
}

/** Commands that remove one target and keep the current point where it was. */
function removal(commands, t) {
  if (t.kind !== 'region') {
    const c = commands[t.ci];
    return {
      at: t.ci,
      remove: 1,
      insert: dependsOnCurrentPoint(commands, t.ci + 1) ? [D(2, c.x, c.y, c.line)] : [],
    };
  }
  const span = commands.slice(t.start + 1, t.ci);
  const kept = span.filter((c) => c.type !== 'D');
  const last = [...span].reverse().find((c) => c.type === 'D');
  if (last && dependsOnCurrentPoint(commands, t.ci + 1)) kept.push(D(2, last.x, last.y, last.line));
  return { at: t.start, remove: t.ci - t.start + 1, insert: kept };
}

function moved(commands, t, dx, dy) {
  const c = commands[t.ci];
  const restore = dependsOnCurrentPoint(commands, t.ci + 1);
  if (t.kind === 'flash') {
    const insert = [D(3, c.x + dx, c.y + dy, c.line)];
    if (restore) insert.push(D(2, c.x, c.y, c.line));
    return { at: t.ci, remove: 1, insert, select: [0] };
  }
  if (t.kind === 'draw') {
    const [px, py] = pointBefore(commands, t.ci);
    const extra = {};
    if (c.i !== undefined) extra.i = c.i;
    if (c.j !== undefined) extra.j = c.j;
    const insert = [D(2, px + dx, py + dy, c.line), D(1, c.x + dx, c.y + dy, c.line, extra)];
    if (restore) insert.push(D(2, c.x, c.y, c.line));
    return { at: t.ci, remove: 1, insert, select: [1] };
  }
  // region: every contour point moves; a first contour that starts at the current point
  // before G36 gets an explicit start
  const span = commands.slice(t.start, t.ci + 1);
  const insert = [span[0]];
  const firstD = span.find((x) => x.type === 'D');
  if (firstD && firstD.op === 1) {
    const [px, py] = pointBefore(commands, t.start);
    insert.push(D(2, px + dx, py + dy, span[0].line));
  }
  let last = null;
  for (const x of span.slice(1)) {
    if (x.type === 'D') {
      last = x;
      insert.push({ ...x, x: x.x + dx, y: x.y + dy });
    } else insert.push(x);
  }
  const sel = insert.length - 1;
  if (restore && last) insert.push(D(2, last.x, last.y, last.line));
  return { at: t.start, remove: t.ci - t.start + 1, insert, select: [sel] };
}

/**
 * Apply one op.
 * @param {object[]} commands normalised commands (not mutated)
 * @param {object} op
 * @param {{image: object}} ctx the image interpreted from `commands`
 * @returns {{commands: object[], select: number[]}} select: target indices of the objects
 *   the op made or moved, in the new list
 */
export function applyGerberOp(commands, op, ctx) {
  const k = mmPerCount(fileUnit(commands));
  const count = (mm) => {
    if (!Number.isFinite(mm)) throw new EditError('Invalid coordinate');
    return Math.round(mm / k);
  };
  switch (op.type) {
    case 'delete':
      return spliceMany(
        commands,
        uniqueTargets(commands, op.targets).map((t) => removal(commands, t)),
      );
    case 'move': {
      const dx = count(op.dxMm);
      const dy = count(op.dyMm);
      return spliceMany(
        commands,
        uniqueTargets(commands, op.targets).map((t) => moved(commands, t, dx, dy)),
      );
    }
    case 'addFlash':
    case 'addTrack':
    case 'addRegion':
      return add(commands, op, ctx, count);
    case 'toRegion':
      return toRegion(commands, op, ctx, count);
    case 'unifyLayer':
      return unifyLayer(commands, op, ctx, count);
    case 'cutOut':
      return cutOut(commands, op, ctx, count);
    case 'paint':
      return paint(commands, op, ctx, count);
    default:
      if (NODE_OPS.includes(op.type)) return applyNodeOp(commands, op);
      throw new EditError(`Unknown edit ${op.type}`);
  }
}

// ---------------------------------------------------------------- adding

function insertionPoint(commands) {
  let at = commands.length;
  for (let i = commands.length - 1; i >= 0; i--) {
    if (commands[i].type === 'M02') {
      at = i;
      break;
    }
  }
  return at;
}

/** Commands that bring the graphics state back to its defaults before new objects. */
function resetState(st) {
  if (st.regionStart >= 0 || st.blockDepth) throw new EditError('The file ends inside a region or aperture block');
  const out = [];
  if (st.srOpen) out.push({ type: 'SR', close: true, line: 0 });
  if (st.attrs) out.push({ type: 'TD', name: null, line: 0 });
  if (!st.dark) out.push({ type: 'LP', polarity: 'D', line: 0 });
  if (st.mirror !== 'N') out.push({ type: 'LM', mirror: 'N', line: 0 });
  if (st.rot) out.push({ type: 'LR', deg: 0, line: 0 });
  if (st.scale !== 1) out.push({ type: 'LS', scale: 1, line: 0 });
  return out;
}

function points(op, count, min) {
  const p = op.pointsMm;
  if (!Array.isArray(p) || p.length % 2 || p.length < 2 * min) throw new EditError(`Needs at least ${min} points`);
  const out = [];
  for (let i = 0; i < p.length; i += 2) out.push([count(p[i]), count(p[i + 1])]);
  return out;
}

/** The aperture code to use (an existing one, or a new %AD% to insert). */
function resolveAperture(commands, ref, ctx, unit, kinds) {
  if (ref && Number.isInteger(ref.code)) {
    const ap = ctx.image.apertures.get(ref.code);
    if (!ap || ap.kind === 'block') throw new EditError(`Aperture D${ref.code} is not defined`);
    if (!kinds.includes(ap.kind)) throw new EditError(`Aperture D${ref.code} (${ap.kind}) cannot be used here`);
    return { code: ref.code, define: null };
  }
  if (!ref || !['C', 'R', 'O'].includes(ref.template) || !Array.isArray(ref.paramsMm))
    throw new EditError('No aperture chosen');
  if (!kinds.includes(ref.template)) throw new EditError(`A ${ref.template} aperture cannot be used here`);
  const need = ref.template === 'C' ? 1 : 2;
  if (ref.paramsMm.length !== need || ref.paramsMm.some((v) => !(v > 0) || !Number.isFinite(v)))
    throw new EditError('Aperture sizes must be positive');
  const per = unit === 'IN' ? 25.4 : 1;
  const places = unit === 'IN' ? 1e7 : 1e6;
  const params = ref.paramsMm.map((v) => Math.round((v / per) * places) / places);
  let max = 9;
  for (const c of commands) {
    if ((c.type === 'AD' || (c.type === 'AB' && !c.close)) && c.code > max) max = c.code;
    if (
      c.type === 'AD' &&
      c.template === ref.template &&
      c.params.length === params.length &&
      c.params.every((v, i) => Math.abs(v - params[i]) < 1e-12) &&
      ctx.image.apertures.get(c.code)?.line === c.line
    )
      return { code: c.code, define: null };
  }
  const code = max + 1;
  return { code, define: { type: 'AD', code, template: ref.template, params, line: 0 } };
}

function add(commands, op, ctx, count) {
  const at = insertionPoint(commands);
  const st = scanState(commands, at);
  const insert = resetState(st);
  const select = [];
  if (op.type === 'addRegion') {
    const pts = points(op, count, 3);
    if (st.interp !== 1) insert.push({ type: 'G', code: 1, line: 0 });
    insert.push({ type: 'G', code: 36, line: 0 });
    insert.push(D(2, pts[0][0], pts[0][1], 0));
    for (const [x, y] of pts.slice(1)) insert.push(D(1, x, y, 0));
    insert.push(D(1, pts[0][0], pts[0][1], 0));
    select.push(insert.length);
    insert.push({ type: 'G', code: 37, line: 0 });
    return spliceMany(commands, [{ at, remove: 0, insert, select }]);
  }
  const unit = fileUnit(commands);
  const ap = resolveAperture(
    commands,
    op.aperture,
    ctx,
    unit,
    op.type === 'addTrack' ? ['C', 'R'] : ['C', 'R', 'O', 'P', 'macro'],
  );
  if (ap.define) insert.push(ap.define);
  if (ap.define || st.ap !== ap.code) insert.push({ type: 'Dnn', code: ap.code, line: 0 });
  if (op.type === 'addFlash') {
    const x = count(op.xMm);
    const y = count(op.yMm);
    select.push(insert.length);
    insert.push(D(3, x, y, 0));
  } else {
    const pts = points(op, count, 2);
    if (st.interp !== 1) insert.push({ type: 'G', code: 1, line: 0 });
    insert.push(D(2, pts[0][0], pts[0][1], 0));
    for (const [x, y] of pts.slice(1)) {
      select.push(insert.length);
      insert.push(D(1, x, y, 0));
    }
  }
  return spliceMany(commands, [{ at, remove: 0, insert, select }]);
}

// ---------------------------------------------------------------- regions

/**
 * A render-target-like sink recording exact contours: { start, segs: [L | A] }.
 * Canvas arc semantics as in FlattenSink (src/model/polygons.js).
 */
export class RecordSink {
  constructor() {
    this.contours = [];
    this.cur = null;
  }
  moveTo(x, y) {
    this.closePath();
    this.cur = { start: [x, y], segs: [] };
  }
  lineTo(x, y) {
    if (!this.cur) this.cur = { start: [x, y], segs: [] };
    else this.cur.segs.push({ t: 'L', x, y });
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
    if (!this.cur) this.cur = { start: [cx + r * Math.cos(a0), cy + r * Math.sin(a0)], segs: [] };
    this.cur.segs.push({ t: 'A', cx, cy, r, a0, sw });
  }
  closePath() {
    if (this.cur && this.cur.segs.length) this.contours.push(this.cur);
    this.cur = null;
  }
  begin() {}
  fill() {}
}

/** Region contour commands for a recorded contour (lines and arcs), in counts. */
function exactContour(rec, count, line) {
  const out = [];
  let interp = null;
  const g = (code) => {
    if (interp !== code) out.push({ type: 'G', code, line });
    interp = code;
  };
  const pt = (x, y) => [count(x), count(y)];
  const start = pt(...rec.start);
  out.push(D(2, start[0], start[1], line));
  let cur = start;
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  for (const s of rec.segs) {
    if (s.t === 'L') {
      const p = pt(s.x, s.y);
      if (same(p, cur)) continue;
      g(1);
      out.push(D(1, p[0], p[1], line));
      cur = p;
      continue;
    }
    const a1 = s.a0 + s.sw;
    const sp = pt(s.cx + s.r * Math.cos(s.a0), s.cy + s.r * Math.sin(s.a0));
    if (!same(sp, cur)) {
      g(1);
      out.push(D(1, sp[0], sp[1], line));
      cur = sp;
    }
    const ep = pt(s.cx + s.r * Math.cos(a1), s.cy + s.r * Math.sin(a1));
    const full = Math.abs(s.sw) >= TAU - 1e-9;
    if (Math.abs(s.sw) < 1e-12 || (same(ep, cur) && !full)) continue;
    const c = pt(s.cx, s.cy);
    g(s.sw > 0 ? 3 : 2);
    out.push(D(1, ep[0], ep[1], line, { i: c[0] - cur[0], j: c[1] - cur[1] }));
    cur = ep;
  }
  if (!same(cur, start)) {
    g(1);
    out.push(D(1, start[0], start[1], line));
  }
  return { cmds: out, interp, arcs: out.some((c) => c.type === 'G' && c.code !== 1) };
}

function lineContour(flat, count, line) {
  const out = [];
  const p0 = [count(flat[0]), count(flat[1])];
  out.push(D(2, p0[0], p0[1], line));
  let cur = p0;
  for (let i = 2; i < flat.length; i += 2) {
    const p = [count(flat[i]), count(flat[i + 1])];
    if (p[0] === cur[0] && p[1] === cur[1]) continue;
    out.push(D(1, p[0], p[1], line));
    cur = p;
  }
  if (cur[0] !== p0[0] || cur[1] !== p0[1]) out.push(D(1, p0[0], p0[1], line));
  return out;
}

/** Outline contours of polygons as region contours (holes joined by cut-ins). */
function polygonContours(contours) {
  const out = [];
  for (const { outer, holes } of nestPolygons(contours)) {
    const c = holes.length ? joinHoles(outer, holes) : outer;
    if (holes.length && !validContour(c)) throw new EditError('Could not join a hole to its outline');
    out.push(c);
  }
  return out;
}

function boxesOverlap(ob, i, j) {
  return !(
    ob[i * 4] > ob[j * 4 + 2] ||
    ob[j * 4] > ob[i * 4 + 2] ||
    ob[i * 4 + 1] > ob[j * 4 + 3] ||
    ob[j * 4 + 1] > ob[i * 4 + 3]
  );
}

function toRegion(commands, op, ctx, count) {
  const image = ctx.image;
  const tol = op.tolMm ?? DEFAULT_TOL_MM;
  const targets = uniqueTargets(commands, op.targets);
  const objIndex = new Map();
  for (const t of targets) {
    const [a, b] = commandObjectRange(image, t.ci);
    if (b - a !== 1) throw new EditError('Only single pads, tracks and regions can be turned into regions');
    if (!image.objects[a].dark) throw new EditError('Clear (LPC) objects cannot be turned into regions');
    objIndex.set(t.ci, a);
  }
  const objs = [...objIndex.values()].sort((a, b) => a - b);
  const ob = image.objBounds;
  // a clear object drawn between the selected ones would erase differently once they are one
  const sel = new Set(objs);
  for (let j = objs[0] + 1; j < objs[objs.length - 1]; j++) {
    if (sel.has(j) || image.objects[j].dark) continue;
    if (objs.some((i) => i < j && boxesOverlap(ob, i, j)))
      throw new EditError('A clear (LPC) object between the selected objects overlaps them: unify the layer instead');
  }
  // clusters of overlapping objects become one outline each
  const parent = new Map(objs.map((i) => [i, i]));
  const find = (i) => (parent.get(i) === i ? i : find(parent.get(i)));
  for (let p = 0; p < objs.length; p++)
    for (let q = p + 1; q < objs.length; q++)
      if (boxesOverlap(ob, objs[p], objs[q])) parent.set(find(objs[p]), find(objs[q]));
  const clusters = new Map();
  for (const i of objs) {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(i);
  }
  const last = targets.reduce((a, b) => (a.ci > b.ci ? a : b));
  const st = scanState(commands, last.kind === 'region' ? last.start : last.ci);
  const regions = [];
  let arcs = false;
  let interp = st.interp;
  const lineOf = (i) => image.objects[i].ln;
  for (const list of clusters.values()) {
    const o = image.objects[list[0]];
    if (list.length === 1) {
      const rec = new RecordSink();
      emitExact(o, rec);
      if (rec.contours.length === 1) {
        const r = exactContour(rec.contours[0], count, o.ln);
        if (r.cmds[1]?.type === 'G' && interp === r.cmds[1].code) r.cmds.splice(1, 1);
        regions.push({ type: 'G', code: 36, line: o.ln }, ...r.cmds, { type: 'G', code: 37, line: o.ln });
        if (r.interp !== null) interp = r.interp;
        arcs ||= r.arcs;
        continue;
      }
    }
    for (const c of polygonContours(imageContours(image, list, tol))) {
      if (interp !== 1) regions.push({ type: 'G', code: 1, line: lineOf(list[0]) });
      interp = 1;
      regions.push({ type: 'G', code: 36, line: lineOf(list[0]) }, ...lineContour(c, count, lineOf(list[0])), {
        type: 'G',
        code: 37,
        line: lineOf(list[0]),
      });
    }
  }
  const insert = [];
  if (arcs && st.quadrant !== 'multi') insert.push({ type: 'G', code: 75, line: 0 });
  const select = [];
  for (const c of regions) {
    if (c.type === 'G' && c.code === 37) select.push(insert.length);
    insert.push(c);
  }
  if (arcs && st.quadrant === 'single') insert.push({ type: 'G', code: 74, line: 0 });
  if (interp !== st.interp) insert.push({ type: 'G', code: st.interp, line: 0 });
  const edits = targets.map((t) => removal(commands, t));
  const lastEdit = edits.find((e) => e.at === (last.kind === 'region' ? last.start : last.ci));
  lastEdit.select = select;
  lastEdit.insert = [...insert, ...lastEdit.insert];
  return spliceMany(commands, edits);
}

/** Record the exact outline of an object (arcs kept) through the renderer's emitObject. */
function emitExact(o, sink) {
  if (o.k === 'R') return; // already a region (flattened): handled by the polygon path
  if (o.k === 'F' && (!o.ap.shape || !o.ap.shape.simple)) return;
  emitObject(o, sink, 0);
  sink.closePath();
}

function unifyLayer(commands, op, ctx, count) {
  const image = ctx.image;
  if (image.negative) throw new EditError('Negative images (%IPNEG%) cannot be unified');
  const tol = op.tolMm ?? DEFAULT_TOL_MM;
  const contours = polygonContours(imageContours(image, undefined, tol));
  const out = [];
  let geometry = false;
  for (const c of commands) {
    if (c.type === 'FS' || c.type === 'MO' || (c.type === 'TF' && c.name !== '.MD5')) out.push(c);
    else if (c.type === 'G04' && !geometry) out.push(c);
    else if (c.type === 'D' || c.type === 'AD' || c.type === 'AM' || c.type === 'Dnn') geometry = true;
  }
  out.push({ type: 'G04', text: `Unified into regions by PCB-CAMmotion (arcs within ${tol} mm)`, line: 0 });
  out.push({ type: 'G', code: 1, line: 0 });
  const select = [];
  for (const c of contours) {
    out.push({ type: 'G', code: 36, line: 0 }, ...lineContour(c, count, 0));
    select.push(out.length);
    out.push({ type: 'G', code: 37, line: 0 });
  }
  out.push({ type: 'M02', line: 0 });
  return { commands: out, select };
}

// ---------------------------------------------------------------- cutting out

/** The clip shape of a cutOut op: contours of at least 3 finite points. */
function clipContours(clip) {
  if (!Array.isArray(clip) || !clip.length) throw new EditError('Nothing to cut out');
  for (const c of clip)
    if (!Array.isArray(c) || c.length < 6 || c.length % 2 || !c.every(Number.isFinite))
      throw new EditError('Invalid cut-out shape');
  return clip;
}

/**
 * Cut a shape out of objects. Each target is replaced, at its place in the file (so clear
 * objects after it still erase it, spec 4.3.2), by regions of what is left of it; a target
 * the shape covers is removed, one it does not overlap is left as it is.
 */
function cutOut(commands, op, ctx, count) {
  const image = ctx.image;
  const tol = op.tolMm ?? DEFAULT_TOL_MM;
  const clip = clipContours(op.clipMm);
  const edits = [];
  for (const t of uniqueTargets(commands, op.targets)) {
    const [a, b] = commandObjectRange(image, t.ci);
    if (b - a !== 1) throw new EditError('Only single pads, tracks and regions can be cut');
    const o = image.objects[a];
    if (!o.dark) throw new EditError('Clear (LPC) objects cannot be cut');
    const before = imageContours(image, [a], tol);
    const left = booleanOp('difference', before, clip);
    if (Math.abs(contoursArea(before) - contoursArea(left)) < 1e-9) continue; // not overlapped
    const st = scanState(commands, t.kind === 'region' ? t.start : t.ci);
    const insert = [];
    const select = [];
    const contours = polygonContours(left);
    if (contours.length && st.interp !== 1) insert.push({ type: 'G', code: 1, line: o.ln });
    for (const c of contours) {
      insert.push({ type: 'G', code: 36, line: o.ln }, ...lineContour(c, count, o.ln));
      select.push(insert.length);
      insert.push({ type: 'G', code: 37, line: o.ln });
    }
    if (contours.length && st.interp !== 1) insert.push({ type: 'G', code: st.interp, line: o.ln });
    const e = removal(commands, t);
    edits.push({ ...e, insert: [...insert, ...e.insert], select });
  }
  if (!edits.length) throw new EditError('Nothing to cut out: the shape does not overlap the objects');
  return spliceMany(commands, edits);
}

// ---------------------------------------------------------------- painting

function contoursBounds(contours) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of contours)
    for (let i = 0; i < c.length; i += 2) {
      b[0] = Math.min(b[0], c[i]);
      b[1] = Math.min(b[1], c[i + 1]);
      b[2] = Math.max(b[2], c[i]);
      b[3] = Math.max(b[3], c[i + 1]);
    }
  return b;
}

/**
 * Paint a filled outline unified with the objects it touches. The targets are removed and the
 * union is drawn at the end of the file, on top. A clear object drawn after the first target
 * and overlapping the union would no longer erase what it erased of the targets, so then the
 * outline is only added on top (as addRegion), leaving the targets as they are.
 */
function paint(commands, op, ctx, count) {
  const image = ctx.image;
  const tol = op.tolMm ?? DEFAULT_TOL_MM;
  const [shape] = clipContours([op.pointsMm]);
  const targets = Array.isArray(op.targets) && op.targets.length ? uniqueTargets(commands, op.targets) : [];
  const objs = [];
  for (const t of targets) {
    const [a, b] = commandObjectRange(image, t.ci);
    if (b - a !== 1) throw new EditError('Only single pads, tracks and regions can be painted over');
    if (!image.objects[a].dark) throw new EditError('Clear (LPC) objects cannot be painted over');
    objs.push(a);
  }
  const plain = () => add(commands, { type: 'addRegion', pointsMm: op.pointsMm }, ctx, count);
  if (!objs.length) return plain();
  objs.sort((a, b) => a - b);
  const union = booleanOp('union', imageContours(image, objs, tol), [shape]);
  const ub = contoursBounds(union);
  const ob = image.objBounds;
  for (let j = objs[0] + 1; j < image.objects.length; j++)
    if (
      !image.objects[j].dark &&
      !(ob[j * 4] > ub[2] || ob[j * 4 + 2] < ub[0] || ob[j * 4 + 1] > ub[3] || ob[j * 4 + 3] < ub[1])
    )
      return plain();
  const at = insertionPoint(commands);
  const st = scanState(commands, at);
  const insert = resetState(st);
  if (st.interp !== 1) insert.push({ type: 'G', code: 1, line: 0 });
  const select = [];
  for (const c of polygonContours(union)) {
    insert.push({ type: 'G', code: 36, line: 0 }, ...lineContour(c, count, 0));
    select.push(insert.length);
    insert.push({ type: 'G', code: 37, line: 0 });
  }
  return spliceMany(commands, [...targets.map((t) => removal(commands, t)), { at, remove: 0, insert, select }]);
}
