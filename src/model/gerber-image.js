// Gerber interpreter: command list -> image of graphical objects (spec chapter 4).
// All geometry in the image is in mm. Objects keep their source line (`ln`).
//
// Object kinds:
//   F  flash   { x, y }                         aperture `ap` replicated at the point
//   L  draw    { x1, y1, x2, y2 }               aperture `ap` swept along a line
//   A  arc     { x1, y1, x2, y2, cx, cy, r, a0, sw }   circular draw; sw = signed sweep (ccw > 0)
//   R  region  { contours: number[][] }         filled contours (flattened, counter-clockwise)
// Common: dark (polarity), ln (line), at (index into image.objectAttributes), m (2x2 linear
// aperture transform [a,b,c,d] from LM/LR/LS or aperture blocks, or null).
//
// image.commandEnds (Int32Array, one per command): number of image objects after that command
// ran, so command i produced objects [commandEnds[i-1], commandEnds[i]). Objects inside a step
// and repeat block appear when the block is closed; aperture block contents when flashed.

import { Diagnostics } from '../parse/diagnostics.js';
import { standardShape, macroShape, ApertureError } from './aperture.js';
import { arcSegments, signedArea, grow, arcBounds } from './path.js';

const TAU = Math.PI * 2;
export const DEFAULT_MAX_OBJECTS = 5_000_000;
const REGION_ARC_TOL_MM = 0.0005;

/**
 * @param {{commands: any[], diagnostics: Diagnostics}} parsed result of parseGerber
 * @param {{maxObjects?: number}} [opts]
 */
export function interpretGerber(parsed, opts = {}) {
  const it = new Interpreter(parsed.diagnostics || new Diagnostics(), opts);
  it.run(parsed.commands);
  return it.image;
}

class LimitExceeded extends Error {}

class Interpreter {
  constructor(diag, opts) {
    this.diag = diag;
    this.maxObjects = opts.maxObjects ?? DEFAULT_MAX_OBJECTS;
    this.objectCount = 0;
    this.image = {
      format: 'gerber',
      fileUnits: null,
      apertures: new Map(),
      macros: new Map(),
      objects: [],
      fileAttributes: {},
      objectAttributes: [null],
      negative: false,
      truncated: false,
      bounds: null,
      stats: { flashes: 0, draws: 0, arcs: 0, regions: 0 },
      diagnostics: diag,
    };
    this.fs = null;
    this.unit = null; // 'MM' | 'IN'
    this.unitAssumed = false;
    this.notation = 'A';
    this.x = 0;
    this.y = 0;
    this.interp = 1;
    this.quadrant = null;
    this.dark = true;
    this.mirror = 'N';
    this.rotDeg = 0;
    this.scale = 1;
    this.ap = null;
    this.region = null;
    this.blocks = []; // stack of { code, objects, line }
    this.sr = null;
    this.apAttrs = {};
    this.objAttrs = {};
    this.attrIndex = 0;
    this.attrDirty = false;
    this.pendingUnitAps = [];
    this.failedAps = new Set();
    this.warnedMo = false;
  }

  get mmPerUnit() {
    return this.unit === 'IN' ? 25.4 : 1;
  }

  run(commands) {
    const n = commands.length;
    const ends = new Int32Array(n);
    const objs = this.image.objects;
    let i = 0;
    try {
      for (; i < n; i++) {
        this.cmd(commands[i]);
        ends[i] = objs.length;
      }
    } catch (e) {
      if (!(e instanceof LimitExceeded)) throw e;
      this.image.truncated = true;
    }
    this.finish(n ? commands[n - 1].line : 1, false);
    // an SR block closed by the end of file belongs to the last command
    ends.fill(objs.length, Math.min(i, Math.max(0, n - 1)));
    this.image.commandEnds = ends;
    computeBounds(this.image);
  }

  finish(line, atM02) {
    if (this.finished) return;
    this.finished = true;
    if (this.region) this.diag.error('REGION_NOT_CLOSED', 'Region (G36) never closed with G37', line);
    if (this.blocks.length) {
      this.diag.error(
        'AB_NOT_CLOSED',
        `Aperture block D${this.blocks[this.blocks.length - 1].code} never closed with %AB*%`,
        line,
      );
    }
    if (this.sr) {
      // older spec revisions let M02 close the last SR block; current spec requires %SR*%
      this.diag.warn(
        'SR_CLOSED_BY_M02',
        'Step and repeat block not closed with %SR*% (closed by end of file; deprecated)',
        line,
      );
      if (!this.image.truncated) {
        try {
          this.closeSr(line);
        } catch (e) {
          if (!(e instanceof LimitExceeded)) throw e;
          this.image.truncated = true;
        }
      }
    }
    if (!atM02) return;
  }

  // -------- object output --------

  target() {
    if (this.blocks.length) return this.blocks[this.blocks.length - 1].objects;
    if (this.sr) return this.sr.objects;
    return this.image.objects;
  }

  count(n, line) {
    this.objectCount += n;
    if (this.objectCount > this.maxObjects) {
      this.diag.error(
        'LIMIT',
        `Too many graphical objects (more than ${this.maxObjects.toLocaleString('en')}): the file was only partly loaded`,
        line,
      );
      throw new LimitExceeded();
    }
  }

  add(o) {
    this.count(1, o.ln);
    if (this.attrDirty) {
      this.image.objectAttributes.push(Object.keys(this.objAttrs).length ? Object.freeze({ ...this.objAttrs }) : null);
      this.attrIndex = this.image.objectAttributes.length - 1;
      this.attrDirty = false;
    }
    o.at = this.attrIndex;
    this.target().push(o);
  }

  matrix() {
    if (this.mirror === 'N' && this.rotDeg === 0 && this.scale === 1) return null;
    const mx = this.mirror.includes('X') ? -1 : 1;
    const my = this.mirror.includes('Y') ? -1 : 1;
    const c = Math.cos((this.rotDeg * Math.PI) / 180) * this.scale;
    const s = Math.sin((this.rotDeg * Math.PI) / 180) * this.scale;
    // scale * rotate * mirror (spec 4.9: mirroring first, then rotation, then scaling)
    return [c * mx, -s * my, s * mx, c * my];
  }

  // -------- commands --------

  cmd(c) {
    switch (c.type) {
      case 'FS':
        this.fs = c;
        this.notation = c.notation;
        return;
      case 'MO':
        if (this.unit && this.unit !== c.unit && !this.unitAssumed) {
          this.diag.warn(
            'UNITS_CHANGED',
            `Units changed from ${this.unit} to ${c.unit} in the middle of the file`,
            c.line,
          );
        }
        if (this.unitAssumed && this.unit !== c.unit) this.rescalePending(c.unit);
        this.unitAssumed = false;
        this.unit = c.unit;
        if (!this.image.fileUnits) this.image.fileUnits = c.unit;
        return;
      case 'NOTATION':
        this.notation = c.notation;
        return;
      case 'AD':
        return this.defineAperture(c);
      case 'AM':
        if (this.image.macros.has(c.name)) this.diag.warn('MACRO_REDEFINED', `Macro ${c.name} defined twice`, c.line);
        this.image.macros.set(c.name, c);
        return;
      case 'Dnn':
        return this.select(c);
      case 'D':
        return this.operation(c);
      case 'G':
        return this.gcode(c);
      case 'LP':
        this.dark = c.polarity === 'D';
        return;
      case 'LM':
        this.mirror = c.mirror;
        return;
      case 'LR':
        this.rotDeg = c.deg;
        return;
      case 'LS':
        this.scale = c.scale;
        return;
      case 'AB':
        return c.close ? this.closeBlock(c) : this.openBlock(c);
      case 'SR':
        if (this.sr) this.closeSr(c.line);
        if (!c.close && (c.x > 1 || c.y > 1)) {
          if (this.blocks.length) this.diag.error('SR_IN_BLOCK', 'Step and repeat inside an aperture block', c.line);
          const k = this.unitScale(c.line);
          this.sr = { x: c.x, y: c.y, i: c.i * k, j: c.j * k, objects: [], line: c.line };
        }
        return;
      case 'TF':
        this.image.fileAttributes[c.name] = c.values;
        return;
      case 'TA':
        this.apAttrs[c.name] = c.values;
        return;
      case 'TO':
        this.objAttrs[c.name] = c.values;
        this.attrDirty = true;
        return;
      case 'TD':
        if (c.name === null) {
          this.apAttrs = {};
          this.objAttrs = {};
        } else {
          delete this.apAttrs[c.name];
          delete this.objAttrs[c.name];
        }
        this.attrDirty = true;
        return;
      case 'IP':
        this.image.negative = c.negative;
        return;
      case 'M02':
        this.finish(c.line, true);
        return;
      default:
        return; // comments, IN/LN and deprecated image commands carry no geometry
    }
  }

  unitScale(line) {
    if (!this.unit) {
      if (!this.warnedMo) {
        this.diag.warn('MISSING_MO', 'No %MO…% unit statement before coordinates: assuming millimetres', line);
        this.warnedMo = true;
      }
      this.unit = 'MM';
      this.unitAssumed = true;
    }
    return this.mmPerUnit;
  }

  coordScale(line) {
    const fs = this.fs || { dec: 6 };
    return this.unitScale(line) / 10 ** fs.dec;
  }

  // -------- apertures --------

  defineAperture(c) {
    const apMap = this.image.apertures;
    if (apMap.has(c.code)) {
      this.diag.error('APERTURE_REDEFINED', `Aperture D${c.code} is defined more than once`, c.line);
      return;
    }
    const ap = { code: c.code, template: c.template, params: c.params, line: c.line, attributes: { ...this.apAttrs } };
    if (!this.unit) {
      // the unit statement may follow; remember to rescale if it differs from the assumption
      this.pendingUnitAps.push(ap);
    }
    if (!this.buildShape(ap, this.unit === 'IN' ? 25.4 : 1)) {
      this.failedAps.add(c.code); // already reported: don't report every use as undefined
      return;
    }
    apMap.set(c.code, ap);
  }

  buildShape(ap, k) {
    const t = ap.template;
    try {
      if (t === 'C' || t === 'R' || t === 'O' || t === 'P') {
        const p = ap.params.map((v, i) => (t === 'P' && (i === 1 || i === 2) ? v : v * k));
        ap.kind = t;
        ap.mm = p; // parameters in mm (polygon vertex count and rotation are unitless)
        ap.shape = standardShape(t, p);
        if (ap.shape.deprecatedRectHole) {
          this.diag.warn('DEPRECATED_RECT_HOLE', `D${ap.code}: rectangular aperture holes are deprecated`, ap.line);
        }
        if (t === 'C') ap.dia = p[0];
        if (t === 'R' || t === 'O') {
          ap.w = p[0];
          ap.h = p[1];
        }
      } else {
        const macro = this.image.macros.get(t);
        if (!macro) {
          this.diag.error('MACRO_UNDEFINED', `Aperture D${ap.code} uses macro "${t}" which is not defined`, ap.line);
          return false;
        }
        if (!macro.ok) return false; // already reported
        ap.kind = 'macro';
        ap.shape = macroShape(macro, ap.params, k, (code, msg, line) => this.diag.warn(code, msg, line));
      }
    } catch (e) {
      if (!(e instanceof ApertureError)) throw e;
      this.diag.error('BAD_APERTURE', `D${ap.code}: ${e.message}`, e.line || ap.line);
      return false;
    }
    return true;
  }

  rescalePending(unit) {
    for (const ap of this.pendingUnitAps) this.buildShape(ap, unit === 'IN' ? 25.4 : 1);
    this.pendingUnitAps = [];
  }

  select(c) {
    if (this.region) {
      this.diag.error('SELECT_IN_REGION', `Aperture selection D${c.code} inside a region statement (G36/G37)`, c.line);
      return;
    }
    const open = this.blocks.find((b) => b.code === c.code);
    if (open) {
      this.diag.error(
        'AB_SELF_REFERENCE',
        `Aperture block D${c.code} selects itself (on line ${c.line}): infinite recursion`,
        open.line,
      );
      this.ap = null;
      return;
    }
    const ap = this.image.apertures.get(c.code);
    if (!ap) {
      if (!this.failedAps.has(c.code))
        this.diag.error('APERTURE_UNDEFINED', `Aperture D${c.code} is selected but never defined`, c.line);
      this.ap = null;
      this.apMissing = c.code;
      return;
    }
    this.ap = ap;
    this.apMissing = null;
  }

  openBlock(c) {
    if (this.image.apertures.has(c.code)) {
      this.diag.error('APERTURE_REDEFINED', `Aperture D${c.code} is defined more than once`, c.line);
    }
    this.blocks.push({ code: c.code, objects: [], line: c.line, x: this.x, y: this.y });
  }

  closeBlock(c) {
    const b = this.blocks.pop();
    if (!b) {
      this.diag.error('AB_UNMATCHED', '%AB*% without an open aperture block', c.line);
      return;
    }
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const o of b.objects) objectBoundsInto(o, bbox);
    if (!b.objects.length) bbox.splice(0, 4, 0, 0, 0, 0);
    this.image.apertures.set(b.code, {
      code: b.code,
      kind: 'block',
      objects: b.objects,
      line: b.line,
      bbox,
      attributes: {},
    });
  }

  closeSr(line) {
    const sr = this.sr;
    this.sr = null;
    const copies = sr.x * sr.y;
    const n = sr.objects.length;
    this.objectCount -= n; // they were counted when created; count all copies now
    if (copies * n + this.objectCount > this.maxObjects) {
      this.diag.error(
        'LIMIT',
        `Step and repeat ${sr.x} × ${sr.y} of ${n} objects would create ${(copies * n).toExponential(2)} objects (limit ${this.maxObjects.toLocaleString('en')}): only the first copy is shown`,
        sr.line,
      );
      this.image.truncated = true;
      this.objectCount += n;
      for (const o of sr.objects) this.target().push(o);
      return;
    }
    this.count(copies * n, line);
    const out = this.target();
    for (let iy = 0; iy < sr.y; iy++) {
      for (let ix = 0; ix < sr.x; ix++) {
        const dx = ix * sr.i;
        const dy = iy * sr.j;
        for (const o of sr.objects) out.push(dx || dy ? translated(o, dx, dy) : o);
      }
    }
  }

  // -------- operations --------

  gcode(c) {
    switch (c.code) {
      case 1:
      case 2:
      case 3:
        this.interp = c.code;
        return;
      case 74:
        this.quadrant = 'single';
        this.diag.warn('DEPRECATED_G74', 'Single-quadrant arc mode (G74) is deprecated', c.line);
        return;
      case 75:
        this.quadrant = 'multi';
        return;
      case 36:
        if (this.region) {
          this.diag.error('REGION_NESTED', 'G36 inside a region statement', c.line);
          return;
        }
        this.region = { contours: [], cur: null, line: c.line };
        return;
      case 37:
        if (!this.region) {
          this.diag.error('G37_WITHOUT_G36', 'G37 without a preceding G36', c.line);
          return;
        }
        this.endContour(c.line);
        this.emitRegion(c.line);
        this.region = null;
        return;
    }
  }

  operation(c) {
    if (c.g) this.interp = c.g;
    let op = c.op;
    if (op === 0) {
      this.diag.warn('DEPRECATED_MODAL_D', 'Coordinates without a D-code (modal D01) are deprecated', c.line);
      op = this.lastOp || 1;
    }
    this.lastOp = op;
    const k = this.coordScale(c.line);
    let x = this.x;
    let y = this.y;
    if (this.notation === 'I') {
      if (c.x !== undefined) x += c.x * k;
      if (c.y !== undefined) y += c.y * k;
    } else {
      if (c.x !== undefined) x = c.x * k;
      if (c.y !== undefined) y = c.y * k;
    }
    const i = (c.i ?? 0) * k;
    const j = (c.j ?? 0) * k;
    if (op === 2) {
      if (this.region) this.endContour(c.line);
      this.x = x;
      this.y = y;
      return;
    }
    if (op === 3) {
      if (this.region) {
        this.diag.error('FLASH_IN_REGION', 'D03 flash inside a region statement (G36/G37)', c.line);
      } else this.flash(x, y, c.line);
      this.x = x;
      this.y = y;
      return;
    }
    // D01
    if (this.region) this.regionDraw(x, y, i, j, c);
    else this.draw(x, y, i, j, c);
    this.x = x;
    this.y = y;
  }

  needAperture(line, what) {
    if (this.ap) return true;
    if (this.apMissing) return false; // undefined aperture was already reported
    this.diag.error('NO_APERTURE', `${what} before any aperture is selected`, line);
    this.apMissing = -1;
    return false;
  }

  flash(x, y, line) {
    if (!this.needAperture(line, 'Flash (D03)')) return;
    const ap = this.ap;
    if (ap.kind === 'block') return this.flashBlock(ap, x, y, line);
    this.image.stats.flashes++;
    this.add({ k: 'F', dark: this.dark, ap, x, y, m: this.matrix(), ln: line });
  }

  flashBlock(ap, x, y, line) {
    const m = this.matrix();
    const toggle = !this.dark;
    this.count(ap.objects.length, line);
    this.objectCount -= ap.objects.length; // add() counts each one again below
    for (const o of ap.objects) {
      const t = transformObject(o, m, x, y);
      if (toggle) t.dark = !t.dark;
      t.ln = o.ln;
      this.add(t);
    }
  }

  draw(x, y, i, j, c) {
    if (!this.needAperture(c.line, 'Draw (D01)')) return;
    const ap = this.ap;
    if (ap.kind === 'block') {
      this.diag.error('DRAW_WITH_BLOCK', `Aperture block D${ap.code} cannot be used to draw`, c.line);
      return;
    }
    const m = this.matrix();
    if (this.interp === 1) {
      this.image.stats.draws++;
      this.add({ k: 'L', dark: this.dark, ap, x1: this.x, y1: this.y, x2: x, y2: y, m, ln: c.line });
      return;
    }
    const arc = this.arc(x, y, i, j, c.line);
    if (!arc) return;
    if (ap.kind !== 'C') {
      this.diag.warn('ARC_NON_CIRCULAR', `Arc drawn with non-circular aperture D${ap.code}`, c.line);
    }
    this.image.stats.arcs++;
    this.add({ k: 'A', dark: this.dark, ap, ...arc, m, ln: c.line });
  }

  /** Compute an arc from the current point to (x,y); returns null (and reports) if invalid. */
  arc(x, y, i, j, line) {
    const ccw = this.interp === 3;
    const x1 = this.x;
    const y1 = this.y;
    let mode = this.quadrant;
    if (!mode) {
      this.diag.warn(
        'ARC_NO_QUADRANT_MODE',
        'Arc without G75 (or G74) quadrant mode: assuming G75 multi-quadrant',
        line,
      );
      mode = 'multi';
    }
    let cx;
    let cy;
    let sw;
    const tol = (r) => Math.max(0.005, r * 0.001);
    if (mode === 'multi') {
      cx = x1 + i;
      cy = y1 + j;
      const r1 = Math.hypot(x1 - cx, y1 - cy);
      const r2 = Math.hypot(x - cx, y - cy);
      if (r1 < 1e-9 && r2 < 1e-9) {
        this.diag.error('ARC_ZERO_RADIUS', 'Arc with zero radius', line);
        return null;
      }
      if (Math.abs(r1 - r2) > tol(Math.max(r1, r2))) {
        this.diag.error(
          'ARC_BAD_CENTER',
          `Arc centre is not equidistant from start and end (radius ${r1.toFixed(4)} vs ${r2.toFixed(4)} mm)`,
          line,
        );
        return null;
      }
      const a0 = Math.atan2(y1 - cy, x1 - cx);
      const a1 = Math.atan2(y - cy, x - cx);
      const same = Math.abs(x - x1) < 1e-9 && Math.abs(y - y1) < 1e-9;
      if (same) sw = ccw ? TAU : -TAU;
      else {
        sw = a1 - a0;
        if (ccw && sw <= 0) sw += TAU;
        if (!ccw && sw >= 0) sw -= TAU;
      }
      return { x1, y1, x2: x, y2: y, cx, cy, r: (r1 + r2) / 2, a0, sw };
    }
    // single quadrant (G74): I and J are unsigned; pick the centre giving an arc of at most 90°
    let best = null;
    for (const [si, sj] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const ccx = x1 + si * Math.abs(i);
      const ccy = y1 + sj * Math.abs(j);
      const r1 = Math.hypot(x1 - ccx, y1 - ccy);
      const r2 = Math.hypot(x - ccx, y - ccy);
      const a0 = Math.atan2(y1 - ccy, x1 - ccx);
      const a1 = Math.atan2(y - ccy, x - ccx);
      let s = a1 - a0;
      if (ccw && s < 0) s += TAU;
      if (!ccw && s > 0) s -= TAU;
      if (Math.abs(s) > Math.PI / 2 + 1e-6) continue;
      const err = Math.abs(r1 - r2);
      if (!best || err < best.err) best = { err, cx: ccx, cy: ccy, r: (r1 + r2) / 2, a0, sw: s };
    }
    if (!best || best.err > tol(best.r)) {
      this.diag.error('ARC_BAD_CENTER', 'No valid single-quadrant (G74) arc centre for this arc', line);
      return null;
    }
    return { x1, y1, x2: x, y2: y, cx: best.cx, cy: best.cy, r: best.r, a0: best.a0, sw: best.sw };
  }

  // -------- regions (spec 4.10) --------

  regionDraw(x, y, i, j, c) {
    const r = this.region;
    if (!r.cur) r.cur = { pts: [this.x, this.y], line: c.line };
    if (this.interp === 1) {
      r.cur.pts.push(x, y);
      return;
    }
    const arc = this.arc(x, y, i, j, c.line);
    if (!arc) return;
    const n = arcSegments(arc.r, arc.sw, REGION_ARC_TOL_MM);
    for (let k = 1; k <= n; k++) {
      const a = arc.a0 + (arc.sw * k) / n;
      if (k === n) r.cur.pts.push(x, y);
      else r.cur.pts.push(arc.cx + arc.r * Math.cos(a), arc.cy + arc.r * Math.sin(a));
    }
  }

  endContour(line) {
    const r = this.region;
    const cur = r.cur;
    r.cur = null;
    if (!cur || cur.pts.length < 4) return;
    const p = cur.pts;
    const n = p.length;
    if (Math.abs(p[0] - p[n - 2]) > 1e-6 || Math.abs(p[1] - p[n - 1]) > 1e-6) {
      this.diag.error(
        'CONTOUR_NOT_CLOSED',
        `Region contour is not closed: ends at (${p[n - 2].toFixed(4)}, ${p[n - 1].toFixed(4)}) instead of its start (${p[0].toFixed(4)}, ${p[1].toFixed(4)})`,
        line,
      );
      // still drawn (closed with a straight edge) so the problem is visible in the viewer
    } else p.length = n - 2;
    if (p.length < 6) return; // degenerate (zero area)
    r.contours.push(p);
  }

  emitRegion(line) {
    const r = this.region;
    if (!r.contours.length) return;
    const contours = [];
    for (const c of r.contours) {
      if (selfIntersects(c)) {
        this.diag.warn(
          'REGION_SELF_INTERSECTS',
          'Region contour intersects itself (invalid; rendered with non-zero fill)',
          r.line,
        );
      }
      contours.push(signedArea(c) < 0 ? reverseFlat(c) : c);
    }
    this.image.stats.regions++;
    this.add({ k: 'R', dark: this.dark, contours, m: null, ln: r.line });
    void line;
  }
}

function reverseFlat(pts) {
  const out = new Array(pts.length);
  for (let i = 0, j = pts.length - 2; j >= 0; j -= 2, i += 2) {
    out[i] = pts[j];
    out[i + 1] = pts[j + 1];
  }
  return out;
}

// ---------- object transforms ----------

function mul(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]];
}

function translated(o, dx, dy) {
  return transformObject(o, null, dx, dy, o.dark);
}

/** Copy of object o transformed by linear m (2x2 or null) then translated by (dx, dy). */
export function transformObject(o, m, dx, dy) {
  const tp = m ? (x, y) => [m[0] * x + m[1] * y + dx, m[2] * x + m[3] * y + dy] : (x, y) => [x + dx, y + dy];
  switch (o.k) {
    case 'F': {
      const [x, y] = tp(o.x, o.y);
      return { k: 'F', dark: o.dark, ap: o.ap, x, y, m: mul(m, o.m), ln: o.ln, at: o.at };
    }
    case 'L': {
      const [x1, y1] = tp(o.x1, o.y1);
      const [x2, y2] = tp(o.x2, o.y2);
      return { k: 'L', dark: o.dark, ap: o.ap, x1, y1, x2, y2, m: mul(m, o.m), ln: o.ln, at: o.at };
    }
    case 'A': {
      const [x1, y1] = tp(o.x1, o.y1);
      const [x2, y2] = tp(o.x2, o.y2);
      const [cx, cy] = tp(o.cx, o.cy);
      let a0 = o.a0;
      let sw = o.sw;
      let r = o.r;
      if (m) {
        const det = m[0] * m[3] - m[1] * m[2];
        const phi = Math.atan2(m[2], m[0]);
        r *= Math.sqrt(Math.abs(det));
        if (det < 0) {
          a0 = phi - a0;
          sw = -sw;
        } else a0 += phi;
      }
      return { k: 'A', dark: o.dark, ap: o.ap, x1, y1, x2, y2, cx, cy, r, a0, sw, m: mul(m, o.m), ln: o.ln, at: o.at };
    }
    case 'R': {
      const det = m ? m[0] * m[3] - m[1] * m[2] : 1;
      const contours = o.contours.map((c) => {
        const out = new Array(c.length);
        for (let i = 0; i < c.length; i += 2) {
          const [x, y] = tp(c[i], c[i + 1]);
          out[i] = x;
          out[i + 1] = y;
        }
        return det < 0 ? reverseFlat(out) : out;
      });
      return { k: 'R', dark: o.dark, contours, m: null, ln: o.ln, at: o.at };
    }
  }
  throw new Error('unknown object kind ' + o.k);
}

// ---------- bounds ----------

/** Linear-transformed aperture bbox: [minx,miny,maxx,maxy]. */
export function apertureBounds(ap, m) {
  const b = ap.kind === 'block' ? ap.bbox : ap.shape.bbox;
  if (!m) return b;
  const out = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of [
    [b[0], b[1]],
    [b[2], b[1]],
    [b[2], b[3]],
    [b[0], b[3]],
  ]) {
    grow(out, m[0] * x + m[1] * y, m[2] * x + m[3] * y);
  }
  return out;
}

/** Half the width an aperture sweeps when drawing (radius for circles). */
export function drawRadius(ap, m) {
  const s = m ? Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) : 1;
  if (ap.kind === 'C') return (ap.dia / 2) * s;
  const b = ap.shape ? ap.shape.bbox : ap.bbox;
  return Math.max(Math.abs(b[0]), Math.abs(b[1]), Math.abs(b[2]), Math.abs(b[3])) * Math.SQRT2 * s;
}

export function objectBoundsInto(o, out) {
  switch (o.k) {
    case 'F': {
      const b = apertureBounds(o.ap, o.m);
      grow(out, o.x + b[0], o.y + b[1]);
      grow(out, o.x + b[2], o.y + b[3]);
      return out;
    }
    case 'L': {
      const h = o.ap.kind === 'C' ? drawRadius(o.ap, o.m) : null;
      if (h !== null) {
        grow(out, Math.min(o.x1, o.x2) - h, Math.min(o.y1, o.y2) - h);
        grow(out, Math.max(o.x1, o.x2) + h, Math.max(o.y1, o.y2) + h);
      } else {
        const b = apertureBounds(o.ap, o.m);
        grow(out, Math.min(o.x1, o.x2) + b[0], Math.min(o.y1, o.y2) + b[1]);
        grow(out, Math.max(o.x1, o.x2) + b[2], Math.max(o.y1, o.y2) + b[3]);
      }
      return out;
    }
    case 'A': {
      const h = drawRadius(o.ap, o.m);
      const b = arcBounds(o.cx, o.cy, o.r, o.a0, o.a0 + o.sw, o.sw > 0 ? 1 : 0, [
        Infinity,
        Infinity,
        -Infinity,
        -Infinity,
      ]);
      grow(out, b[0] - h, b[1] - h);
      grow(out, b[2] + h, b[3] + h);
      return out;
    }
    case 'R':
      for (const c of o.contours) for (let i = 0; i < c.length; i += 2) grow(out, c[i], c[i + 1]);
      return out;
  }
  return out;
}

/** Fill image.bounds and the per-object bbox array image.objBounds (Float64Array, 4 per object). */
export function computeBounds(image) {
  const objs = image.objects;
  const ob = new Float64Array(objs.length * 4);
  const all = [Infinity, Infinity, -Infinity, -Infinity];
  const b = [0, 0, 0, 0];
  for (let i = 0; i < objs.length; i++) {
    b[0] = b[1] = Infinity;
    b[2] = b[3] = -Infinity;
    objectBoundsInto(objs[i], b);
    ob[i * 4] = b[0];
    ob[i * 4 + 1] = b[1];
    ob[i * 4 + 2] = b[2];
    ob[i * 4 + 3] = b[3];
    if (b[0] <= b[2]) {
      if (b[0] < all[0]) all[0] = b[0];
      if (b[1] < all[1]) all[1] = b[1];
      if (b[2] > all[2]) all[2] = b[2];
      if (b[3] > all[3]) all[3] = b[3];
    }
  }
  image.objBounds = ob;
  image.bounds = all[0] <= all[2] ? all : null;
  return image;
}

// ---------- region validation ----------

/**
 * True if a closed contour has a proper crossing between two non-adjacent edges.
 * Collinear overlaps (cut-ins) and touching vertices are allowed (spec 4.10.3).
 * Uses a uniform grid so 100k-vertex contours stay fast.
 */
export function selfIntersects(pts) {
  const n = pts.length / 2;
  if (n < 4) return false;
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < minx) minx = pts[i];
    if (pts[i] > maxx) maxx = pts[i];
    if (pts[i + 1] < miny) miny = pts[i + 1];
    if (pts[i + 1] > maxy) maxy = pts[i + 1];
  }
  const g = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(n))));
  const cw = (maxx - minx) / g || 1;
  const ch = (maxy - miny) / g || 1;
  const cells = new Map();
  for (let e = 0; e < n; e++) {
    const ax = pts[e * 2];
    const ay = pts[e * 2 + 1];
    const f = (e + 1) % n;
    const bx = pts[f * 2];
    const by = pts[f * 2 + 1];
    const c0 = Math.min(g - 1, Math.floor((Math.min(ax, bx) - minx) / cw));
    const c1 = Math.min(g - 1, Math.floor((Math.max(ax, bx) - minx) / cw));
    const r0 = Math.min(g - 1, Math.floor((Math.min(ay, by) - miny) / ch));
    const r1 = Math.min(g - 1, Math.floor((Math.max(ay, by) - miny) / ch));
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > 4096) continue; // very long edge: skip (heuristic check)
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = r * g + c;
        let list = cells.get(key);
        if (!list) cells.set(key, (list = []));
        for (const o of list) {
          if (o === e || (o + 1) % n === e || (e + 1) % n === o) continue;
          if (segmentsCross(pts, e, o, n)) return true;
        }
        list.push(e);
      }
    }
  }
  return false;
}

function segmentsCross(p, e, o, n) {
  const ax = p[e * 2];
  const ay = p[e * 2 + 1];
  const bx = p[((e + 1) % n) * 2];
  const by = p[((e + 1) % n) * 2 + 1];
  const cx = p[o * 2];
  const cy = p[o * 2 + 1];
  const dx = p[((o + 1) % n) * 2];
  const dy = p[((o + 1) % n) * 2 + 1];
  const d1 = orient(cx, cy, dx, dy, ax, ay);
  const d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy);
  const d4 = orient(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function orient(ax, ay, bx, by, cx, cy) {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const scale = Math.abs(bx - ax) + Math.abs(by - ay) + Math.abs(cx - ax) + Math.abs(cy - ay);
  return Math.abs(v) <= 1e-12 * scale * scale ? 0 : v;
}
