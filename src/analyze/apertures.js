// Aperture table and shape statistics for one layer image (Gerber or Excellon). Pure functions
// over the image model (src/model/gerber-image.js, drill-image.js); all sizes in mm.
//
// Usage is counted over the image objects, so step and repeat copies count once per copy.
// Aperture blocks (%AB%, spec 4.11) are expanded into their contents when flashed: their
// objects carry the apertures used inside the block, and the block's own row counts the
// D03 flashes of the block in the command list.

import { Raster } from '../render/raster.js';
import { drawImage } from '../render/draw-image.js';
import { drawRadius } from '../model/gerber-image.js';
import { signedArea } from '../model/path.js';

const SHAPE_NAME = { C: 'circle', R: 'rectangle', O: 'obround', P: 'polygon', macro: 'macro', block: 'block' };

/** Human description of an aperture (or drill tool): "circle ⌀0.5 mm", "rectangle 1 × 2 mm". */
export function describeAperture(ap) {
  const mm = ap.mm || [];
  const hole = (i) => (mm[i] > 0 ? `, hole ⌀${fmtMm(mm[i])}` : '');
  switch (ap.kind) {
    case 'C':
      return `circle ⌀${fmtMm(ap.dia)} mm${hole(1)}`;
    case 'R':
    case 'O':
      return `${SHAPE_NAME[ap.kind]} ${fmtMm(ap.w)} × ${fmtMm(ap.h)} mm${hole(2)}`;
    case 'P':
      return `polygon ${mm[1]}-gon ⌀${fmtMm(mm[0])} mm${mm[2] ? `, rotated ${mm[2]}°` : ''}${hole(3)}`;
    case 'macro':
      return `macro ${ap.template}(${ap.params.join(', ')})`;
    case 'block':
      return `block of ${ap.objects.length} object${ap.objects.length === 1 ? '' : 's'}`;
  }
  return `${ap.template} ${ap.params.join(' × ')}`;
}

/**
 * A short description in lines for small spaces (the shape gallery): what it is, then its size.
 * ["obround", "2.3 × 1.4 mm"], ["circle", "⌀1 mm", "hole ⌀0.4"], ["RoundRect", "1.2 × 0.6 mm"].
 */
export function apertureLines(ap) {
  const mm = ap.mm || [];
  const hole = (i) => (mm[i] > 0 ? [`hole ⌀${fmtMm(mm[i])}`] : []);
  switch (ap.kind) {
    case 'C':
      return ['circle', `⌀${fmtMm(ap.dia)} mm`, ...hole(1)];
    case 'R':
    case 'O':
      return [SHAPE_NAME[ap.kind], `${fmtMm(ap.w)} × ${fmtMm(ap.h)} mm`, ...hole(2)];
    case 'P':
      return [`${mm[1]}-gon${mm[2] ? ` ${mm[2]}°` : ''}`, `⌀${fmtMm(mm[0])} mm`, ...hole(3)];
    case 'macro': {
      const b = ap.shape.bbox;
      return [ap.template, `${fmtMm(b[2] - b[0])} × ${fmtMm(b[3] - b[1])} mm`];
    }
    case 'block':
      return ['block', `${ap.objects.length} object${ap.objects.length === 1 ? '' : 's'}`];
  }
  return [ap.template];
}

/**
 * Dark area of an aperture in mm². Standard apertures are exact (spec 4.4); macros and blocks
 * are measured on a fine raster (exact: false).
 * @returns {{areaMm2: number, exact: boolean}}
 */
export function apertureArea(ap) {
  if (ap._area) return ap._area;
  let r = null;
  const mm = ap.mm;
  if (mm && !ap.shape?.deprecatedRectHole) {
    const holeArea = (d) => (d > 0 ? (Math.PI * d * d) / 4 : 0);
    if (ap.kind === 'C') r = (Math.PI * ap.dia * ap.dia) / 4 - holeArea(mm[1]);
    else if (ap.kind === 'R') r = ap.w * ap.h - holeArea(mm[2]);
    else if (ap.kind === 'O') {
      const rad = Math.min(ap.w, ap.h) / 2;
      r = ap.w * ap.h - (4 - Math.PI) * rad * rad - holeArea(mm[2]);
    } else if (ap.kind === 'P') {
      const n = mm[1];
      const rad = mm[0] / 2;
      r = (n / 2) * rad * rad * Math.sin((2 * Math.PI) / n) - holeArea(mm[3]);
    }
  }
  ap._area = r !== null ? { areaMm2: r, exact: true } : { areaMm2: rasterArea(apertureImage(ap)), exact: false };
  return ap._area;
}

/** A one-flash image of an aperture (block: its contents) for measuring and thumbnails. */
export function apertureImage(ap) {
  const objects = ap.kind === 'block' ? ap.objects : [{ k: 'F', dark: true, ap, x: 0, y: 0, m: null, ln: ap.line }];
  const b = ap.kind === 'block' ? ap.bbox : ap.shape.bbox;
  return { objects, objBounds: null, negative: false, bounds: b[0] <= b[2] ? b : null };
}

function rasterArea(image, pixels = 600) {
  const b = image.bounds;
  if (!b) return 0;
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  if (!(w > 0 && h > 0)) return 0;
  const s = pixels / Math.max(w, h);
  const r = new Raster(Math.ceil(w * s) + 2, Math.ceil(h * s) + 2, { x0: b[0] - 1 / s, y0: b[1] - 1 / s, pxPerMm: s });
  drawImage(image, r);
  return r.areaMm2();
}

/** Length of the path a draw/arc object sweeps its aperture along (mm). */
export function objectLength(o) {
  if (o.k === 'L') return Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
  if (o.k === 'A') return Math.abs(o.sw) * o.r;
  return 0;
}

/**
 * The aperture table: one row per defined aperture (or drill tool) with its size and use.
 * @param {object} image
 * @param {object[]} [commands] the parsed command list (needed to count aperture block flashes)
 */
export function apertureTable(image, commands = []) {
  const drill = image.format === 'excellon';
  const rows = new Map();
  for (const ap of image.apertures.values()) {
    const b = ap.kind === 'block' ? ap.bbox : ap.shape.bbox;
    const area = apertureArea(ap);
    rows.set(ap.code, {
      code: ap.code,
      label: `${drill ? 'T' : 'D'}${ap.code}`,
      kind: ap.kind,
      shape: SHAPE_NAME[ap.kind] || ap.template,
      template: ap.template,
      description: describeAperture(ap),
      widthMm: b[2] - b[0],
      heightMm: b[3] - b[1],
      areaMm2: area.areaMm2,
      areaExact: area.exact,
      function: ap.attributes?.['.AperFunction']?.join(',') || '',
      line: ap.line,
      flashes: 0,
      draws: 0,
      arcs: 0,
      uses: 0,
      clear: 0,
      lengthMm: 0,
      firstUseLine: null,
    });
  }
  for (const o of image.objects) {
    if (!o.ap) continue;
    const r = rows.get(o.ap.code);
    if (!r) continue;
    if (o.k === 'F') r.flashes++;
    else if (o.k === 'L') r.draws++;
    else if (o.k === 'A') r.arcs++;
    r.uses++;
    if (!o.dark) r.clear++;
    r.lengthMm += objectLength(o);
    if (r.firstUseLine === null || o.ln < r.firstUseLine) r.firstUseLine = o.ln;
  }
  if (!drill) countBlockFlashes(commands, rows);
  return [...rows.values()].sort((a, b) => a.code - b.code);
}

/** Aperture blocks are expanded when flashed: count their D03 flashes in the command list. */
function countBlockFlashes(commands, rows) {
  let cur = null;
  for (const c of commands) {
    if (c.type === 'Dnn') cur = rows.get(c.code);
    else if (c.type === 'D' && c.op === 3 && cur?.kind === 'block') {
      cur.flashes++;
      cur.uses++;
      if (cur.firstUseLine === null) cur.firstUseLine = c.line;
    }
  }
}

/** Indices of the objects drawn with aperture (tool) `code`; `null` = regions. */
export function objectsWithAperture(image, code) {
  const out = [];
  const objs = image.objects;
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    if (code === null ? o.k === 'R' : o.ap?.code === code) out.push(i);
  }
  return out;
}

/**
 * Shape statistics of a layer image: objects by kind and polarity, total draw length, regions,
 * the smallest drawn width and flashed feature, and aperture use.
 */
export function imageStats(image) {
  const s = {
    objects: image.objects.length,
    flashes: 0,
    draws: 0,
    arcs: 0,
    regions: 0,
    dark: 0,
    clear: 0,
    drawLengthMm: 0,
    regionContours: 0,
    regionVertices: 0,
    regionAreaMm2: 0,
    minDrawWidthMm: null,
    maxDrawWidthMm: null,
    minFlashMm: null,
    maxFlashMm: null,
    aperturesDefined: image.apertures.size,
    aperturesUsed: 0,
    bounds: image.bounds,
  };
  const used = new Set();
  const widths = new Map(); // ap -> width (per transform-free aperture; cached per object kind)
  for (const o of image.objects) {
    if (o.dark) s.dark++;
    else s.clear++;
    if (o.k === 'R') {
      s.regions++;
      s.regionContours += o.contours.length;
      for (const c of o.contours) {
        s.regionVertices += c.length / 2;
        s.regionAreaMm2 += signedArea(c);
      }
      continue;
    }
    used.add(o.ap);
    if (o.k === 'F') {
      s.flashes++;
      const b = o.ap.shape?.bbox;
      if (!b) continue;
      const k = o.m ? Math.sqrt(Math.abs(o.m[0] * o.m[3] - o.m[1] * o.m[2])) : 1;
      const d = Math.min(b[2] - b[0], b[3] - b[1]) * k;
      const D = Math.max(b[2] - b[0], b[3] - b[1]) * k;
      if (s.minFlashMm === null || d < s.minFlashMm) s.minFlashMm = d;
      if (s.maxFlashMm === null || D > s.maxFlashMm) s.maxFlashMm = D;
      continue;
    }
    if (o.k === 'L') s.draws++;
    else s.arcs++;
    s.drawLengthMm += objectLength(o);
    let w = o.m ? null : widths.get(o.ap);
    if (w === undefined || w === null) {
      w = drawWidth(o.ap, o.m);
      if (!o.m) widths.set(o.ap, w);
    }
    if (s.minDrawWidthMm === null || w < s.minDrawWidthMm) s.minDrawWidthMm = w;
    if (s.maxDrawWidthMm === null || w > s.maxDrawWidthMm) s.maxDrawWidthMm = w;
  }
  s.aperturesUsed = used.size;
  return s;
}

/** Width of the track an aperture draws: the diameter for circles, else the narrowest side. */
function drawWidth(ap, m) {
  if (ap.kind === 'C') return 2 * drawRadius(ap, m);
  const b = ap.shape.bbox;
  const k = m ? Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) : 1;
  return Math.min(b[2] - b[0], b[3] - b[1]) * k;
}

export function fmtMm(v) {
  if (!Number.isFinite(v)) return '—';
  return Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(4).replace(/\.?0+$/, '') || '0';
}
