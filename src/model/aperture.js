// Aperture shapes: standard apertures C/R/O/P (spec 4.4) and aperture macros (spec 4.5),
// evaluated into paths in aperture-local mm coordinates.
//
// A shape is { parts: [{ dark, path }], simple, bbox }. Parts are applied in order: dark parts
// add, clear parts (macro exposure off) erase *only within this aperture*. `simple` means all
// parts are dark, so the shape is just the union of its paths.

import { evalExpr, MacroExprError } from '../parse/macro-expr.js';
import {
  circlePath,
  rectPath,
  obroundPath,
  polygonPath,
  transformPath,
  signedArea,
  pathBounds,
  M,
  A,
  L,
  Z,
} from './path.js';

const DEG = Math.PI / 180;

export class ApertureError extends Error {
  constructor(message, line) {
    super(message);
    this.line = line;
  }
}

/**
 * Build a standard aperture. Sizes are already in mm. Throws ApertureError on invalid params.
 * @param {'C'|'R'|'O'|'P'} kind
 * @param {number[]} p parameters in mm (polygon vertex count and rotation are unitless)
 */
export function standardShape(kind, params) {
  let p = params;
  const need = { C: [1, 2], R: [2, 3], O: [2, 3], P: [2, 4] }[kind];
  if (p.length < need[0] || p.length > need[1] + 1) {
    throw new ApertureError(`Aperture ${kind} takes ${need[0]}–${need[1]} parameters, got ${p.length}`);
  }
  // deprecated (pre-2016 spec): a rectangular hole given as two extra parameters X and Y
  const rectHole = p.length === need[1] + 1 ? [p[need[1] - 1], p[need[1]]] : null;
  if (rectHole) p = p.slice(0, need[1] - 1);
  const sizes = kind === 'P' ? [p[0], p[3] ?? 0] : p;
  if (sizes.some((v) => v < 0)) throw new ApertureError(`Aperture ${kind} has a negative size`);
  let path;
  let hole = 0;
  let minDim;
  if (kind === 'C') {
    path = circlePath(0, 0, p[0] / 2);
    hole = p[1] ?? 0;
    minDim = p[0];
  } else if (kind === 'R' || kind === 'O') {
    path = kind === 'R' ? rectPath(0, 0, p[0], p[1]) : obroundPath(0, 0, p[0], p[1]);
    hole = p[2] ?? 0;
    minDim = Math.min(p[0], p[1]);
  } else {
    const n = p[1];
    if (!Number.isInteger(n) || n < 3 || n > 12) {
      throw new ApertureError(`Polygon aperture must have 3–12 vertices, got ${n}`);
    }
    const rot = (p[2] ?? 0) * DEG;
    const r = p[0] / 2;
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = rot + (k * 2 * Math.PI) / n;
      pts.push(r * Math.cos(a), r * Math.sin(a));
    }
    path = r > 0 ? polygonPath(pts) : [];
    hole = p[3] ?? 0;
    // the polygon's inscribed circle must contain the hole
    minDim = 2 * r * Math.cos(Math.PI / n);
  }
  if (rectHole) {
    const [hx, hy] = rectHole;
    if (hx < 0 || hy < 0 || Math.max(hx, hy) >= minDim) {
      throw new ApertureError(`Aperture rectangular hole (${hx} × ${hy} mm) does not fit inside the aperture`);
    }
    if (hx > 0 && hy > 0) path = path.concat(reverseRing(rectPath(0, 0, hx, hy)));
    return { ...finish([{ dark: true, path }]), deprecatedRectHole: true };
  }
  if (hole > 0) {
    if (hole >= minDim)
      throw new ApertureError(`Aperture hole (${hole} mm) is not smaller than the aperture (${minDim} mm)`);
    path = path.concat(circlePath(0, 0, hole / 2, false));
  }
  return finish([{ dark: true, path }]);
}

function finish(parts) {
  // merge consecutive dark parts; a single path filled non-zero is their union
  const merged = [];
  for (const part of parts) {
    if (!part.path.length) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.dark === part.dark && part.dark) prev.path = prev.path.concat(part.path);
    else merged.push({ dark: part.dark, path: part.path });
  }
  // leading clear parts erase nothing
  while (merged.length && !merged[0].dark) merged.shift();
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const part of merged) if (part.dark) pathBounds(part.path, bbox);
  if (!merged.length) bbox.splice(0, 4, 0, 0, 0, 0);
  return { parts: merged, simple: merged.every((pt) => pt.dark), bbox };
}

/**
 * Evaluate an aperture macro (spec 4.5) into a shape.
 * @param {{name:string, body:any[]}} macro parsed AM command
 * @param {number[]} args the AD parameters ($1, $2, ...), in file units
 * @param {number} mmPerUnit 25.4 for inch files, 1 for mm
 * @param {(code:string, msg:string, line:number)=>void} warn
 */
export function macroShape(macro, args, mmPerUnit, warn) {
  const vars = new Map();
  args.forEach((v, i) => vars.set(i + 1, v));
  const parts = [];
  const k = mmPerUnit;
  for (const item of macro.body) {
    if (item.kind === 'comment') continue;
    const undefinedVar = (n) =>
      warn('MACRO_UNDEFINED_VAR', `Macro ${macro.name}: variable $${n} is not defined (using 0)`, item.line);
    try {
      if (item.kind === 'var') {
        vars.set(item.n, evalExpr(item.expr, vars, undefinedVar));
        continue;
      }
      const v = item.exprs.map((e) => evalExpr(e, vars, undefinedVar));
      const part = primitive(item.code, v, k, item, macro.name, warn);
      if (part) parts.push(...part);
    } catch (e) {
      if (e instanceof MacroExprError) throw new ApertureError(`Macro ${macro.name}: ${e.message}`, item.line);
      throw e;
    }
  }
  return finish(parts);
}

function need(v, n, code, item, name) {
  if (v.length < n)
    throw new ApertureError(`Macro ${name}: primitive ${code} needs ${n} parameters, got ${v.length}`, item.line);
}

function exposure(v, item, name, warn) {
  const e = v[0];
  if (e === 0) return false;
  if (e === 1) return true;
  if (e === 2) {
    warn('DEPRECATED_EXPOSURE', `Macro ${name}: exposure toggle (2) is deprecated; treated as on`, item.line);
    return true;
  }
  throw new ApertureError(`Macro ${name}: invalid exposure ${e} (must be 0 or 1)`, item.line);
}

function rotated(path, deg) {
  if (!deg) return path;
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return transformPath(path, [c, -s, s, c, 0, 0]);
}

/** Returns parts for one primitive. All rotations are about the macro origin (spec 4.5.1). */
function primitive(code, v, k, item, name, warn) {
  switch (code) {
    case 1: {
      need(v, 4, code, item, name);
      const dark = exposure(v, item, name, warn);
      if (v[1] < 0) throw new ApertureError(`Macro ${name}: negative circle diameter`, item.line);
      return [{ dark, path: rotated(circlePath(v[2] * k, v[3] * k, (v[1] * k) / 2), v[4] || 0) }];
    }
    case 2:
    case 20: {
      need(v, 7, code, item, name);
      const dark = exposure(v, item, name, warn);
      const w = v[1] * k;
      const [sx, sy, ex, ey] = [v[2] * k, v[3] * k, v[4] * k, v[5] * k];
      const len = Math.hypot(ex - sx, ey - sy);
      if (len === 0 || w <= 0) return [];
      const nx = (-(ey - sy) / len) * (w / 2);
      const ny = ((ex - sx) / len) * (w / 2);
      const path = polygonPath([sx - nx, sy - ny, ex - nx, ey - ny, ex + nx, ey + ny, sx + nx, sy + ny]);
      return [{ dark, path: rotated(path, v[6]) }];
    }
    case 21:
    case 22: {
      need(v, 6, code, item, name);
      const dark = exposure(v, item, name, warn);
      const w = v[1] * k;
      const h = v[2] * k;
      if (w < 0 || h < 0) throw new ApertureError(`Macro ${name}: negative line size`, item.line);
      const cx = code === 21 ? v[3] * k : v[3] * k + w / 2;
      const cy = code === 21 ? v[4] * k : v[4] * k + h / 2;
      return [{ dark, path: rotated(rectPath(cx, cy, w, h), v[5]) }];
    }
    case 4: {
      need(v, 2, code, item, name);
      const dark = exposure(v, item, name, warn);
      const n = v[1];
      if (!Number.isInteger(n) || n < 3) {
        throw new ApertureError(`Macro ${name}: outline needs at least 3 vertices, got ${n}`, item.line);
      }
      const count = 2 * (n + 1) + 3;
      if (v.length !== count) {
        throw new ApertureError(
          `Macro ${name}: outline with ${n} vertices needs ${count} parameters, got ${v.length}`,
          item.line,
        );
      }
      const pts = v.slice(2, 2 + 2 * (n + 1)).map((x) => x * k);
      const m = pts.length;
      if (Math.abs(pts[0] - pts[m - 2]) > 1e-9 || Math.abs(pts[1] - pts[m - 1]) > 1e-9) {
        throw new ApertureError(`Macro ${name}: outline is not closed (last vertex must equal the first)`, item.line);
      }
      let ring = pts.slice(0, m - 2);
      if (signedArea(ring) < 0) ring = reverseFlat(ring);
      return [{ dark, path: rotated(polygonPath(ring), v[count - 1]) }];
    }
    case 5: {
      need(v, 6, code, item, name);
      const dark = exposure(v, item, name, warn);
      const n = v[1];
      if (!Number.isInteger(n) || n < 3 || n > 12) {
        throw new ApertureError(`Macro ${name}: polygon needs 3–12 vertices, got ${n}`, item.line);
      }
      const [cx, cy, r] = [v[2] * k, v[3] * k, (v[4] * k) / 2];
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = (i * 2 * Math.PI) / n;
        pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
      return [{ dark, path: rotated(polygonPath(pts), v[5]) }];
    }
    case 6: {
      need(v, 9, code, item, name);
      const [cx, cy, od, th, gap] = [v[0] * k, v[1] * k, v[2] * k, v[3] * k, v[4] * k];
      const rings = v[5];
      const [cth, clen] = [v[6] * k, v[7] * k];
      const path = [];
      let outer = od / 2;
      for (let i = 0; i < rings && outer > 0; i++) {
        const inner = outer - th;
        circlePath(cx, cy, outer, true, path);
        if (inner > 0) circlePath(cx, cy, inner, false, path);
        outer = inner - gap;
      }
      rectPath(cx, cy, clen, cth, path);
      rectPath(cx, cy, cth, clen, path);
      return [{ dark: true, path: rotated(path, v[8]) }];
    }
    case 7: {
      need(v, 6, code, item, name);
      const [cx, cy, od, id, gap] = [v[0] * k, v[1] * k, v[2] * k, v[3] * k, v[4] * k];
      if (!(od > id) || id < 0 || gap < 0) {
        throw new ApertureError(`Macro ${name}: thermal needs outer > inner ≥ 0 and gap ≥ 0`, item.line);
      }
      if (gap >= od / Math.SQRT2) return [];
      return [{ dark: true, path: rotated(thermalPath(cx, cy, od / 2, id / 2, gap / 2), v[5]) }];
    }
    default:
      throw new ApertureError(`Macro ${name}: unknown primitive ${code}`, item.line);
  }
}

/** Reverse a single-contour polygon path (M L L L Z). */
function reverseRing(path) {
  const pts = [];
  for (let i = 0; i < path.length; i++) if (path[i] === M || path[i] === L) pts.push(path[i + 1], path[i + 2]);
  return polygonPath(reverseFlat(pts));
}

function reverseFlat(pts) {
  const out = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
  return out;
}

/** Thermal: ring ro..ri with a cross-shaped gap of half-width g removed (four CCW pieces). */
function thermalPath(cx, cy, ro, ri, g) {
  const path = [];
  const ao = Math.asin(Math.min(1, g / ro));
  const innerArc = ri > g * Math.SQRT2 ? Math.asin(g / ri) : null;
  for (let q = 0; q < 4; q++) {
    const base = (q * Math.PI) / 2;
    const c = Math.cos(base);
    const s = Math.sin(base);
    const rot = (x, y) => [cx + c * x - s * y, cy + s * x + c * y];
    const p0 = rot(ro * Math.cos(ao), ro * Math.sin(ao));
    path.push(M, p0[0], p0[1], A, cx, cy, ro, base + ao, base + Math.PI / 2 - ao, 1);
    if (innerArc !== null) {
      const p1 = rot(ri * Math.cos(Math.PI / 2 - innerArc), ri * Math.sin(Math.PI / 2 - innerArc));
      path.push(L, p1[0], p1[1], A, cx, cy, ri, base + Math.PI / 2 - innerArc, base + innerArc, 0);
    } else {
      const p1 = rot(g, g);
      path.push(L, p1[0], p1[1]);
    }
    path.push(Z);
  }
  return path;
}
