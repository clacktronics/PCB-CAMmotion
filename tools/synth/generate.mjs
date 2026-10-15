#!/usr/bin/env node
// Generates the "synthetic Gerbers": deterministic Gerber, Excellon and .gbrjob fixtures
// for testing parsers, rendering, analysis, DRC, CAM and resource limits.
//
//   node tools/synth/generate.mjs            write all fixtures to test/fixtures/synthetic/
//   node tools/synth/generate.mjs --out DIR  write somewhere else
//   node tools/synth/generate.mjs --if-stale skip if the output was made by this exact script
//
// The output is NOT committed (it is ~50 MB and gitignored): tests generate it on demand
// (`npm test` runs this with --if-stale first). Output is byte-for-byte reproducible
// (seeded PRNG, fixed dates). Never hand-edit the generated files: change this script. manifest.json describes every file
// and what a correct implementation should do with it.

import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1';
const DATE = '2026-10-15T00:00:00+00:00';
const here = dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : join(here, '../../test/fixtures/synthetic');
const STAMP = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
if (process.argv.includes('--if-stale')) {
  let old = '';
  try {
    old = readFileSync(join(OUT, '.stamp'), 'utf8').trim();
  } catch {}
  if (old === STAMP) {
    console.log(`synthetic fixtures up to date in ${OUT}`);
    process.exit(0);
  }
}

// ---------- helpers ----------

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fixtures = [];
/**
 * Register a fixture.
 * expect: 'ok'        valid, must parse with no errors
 *         'warning'   must parse, but should report a warning (deprecated / suspicious)
 *         'error'     must be rejected with a clear error (line number where given)
 *         'limit'     resource stress: must not crash/hang/run out of memory; either
 *                     handle it or refuse it gracefully with a clear message
 * errorToken: text whose first occurrence marks the offending line (-> errorLine)
 */
function add(path, type, expect, category, description, content, extra = {}) {
  fixtures.push({ path, type, expect, category, description, content, ...extra });
}

// Gerber writer. Geometry is always given in mm; the writer converts to the file's units.
class Gerber {
  constructor({
    unit = 'MM',
    int = 4,
    dec = 6,
    fn,
    polarity = 'Positive',
    offset = [0, 0],
    comment = 'CAMmotion synthetic fixture',
    attrs = true,
  } = {}) {
    Object.assign(this, { unit, int, dec, offset });
    this.l = [`G04 ${comment}*`];
    if (attrs) {
      this.l.push(`%TF.GenerationSoftware,CAMmotion,synth,${VERSION}*%`);
      this.l.push(`%TF.CreationDate,${DATE}*%`);
      if (fn) this.l.push(`%TF.FileFunction,${fn}*%`, `%TF.FilePolarity,${polarity}*%`);
    }
    this.l.push(`%FSLAX${int}${dec}Y${int}${dec}*%`, `%MO${unit}*%`, '%LPD*%');
  }
  k(mm) {
    return this.unit === 'IN' ? mm / 25.4 : mm;
  }
  n(mm, axis = 0) {
    return String(Math.round(this.k(mm + this.offset[axis]) * 10 ** this.dec));
  }
  s(mm) {
    // aperture size in file units
    return +this.k(mm).toFixed(this.dec);
  }
  xy(x, y) {
    return `X${this.n(x, 0)}Y${this.n(y, 1)}`;
  }
  ij(i, j) {
    return `I${String(Math.round(this.k(i) * 10 ** this.dec))}J${String(Math.round(this.k(j) * 10 ** this.dec))}`;
  }
  raw(...lines) {
    this.l.push(...lines);
    return this;
  }
  ad(code, shape, ...mm) {
    this.l.push(`%ADD${code}${shape},${mm.map((v) => this.s(v)).join('X')}*%`);
    return this;
  }
  d(code) {
    this.l.push(`D${code}*`);
    return this;
  }
  move(x, y) {
    this.l.push(`${this.xy(x, y)}D02*`);
    return this;
  }
  draw(x, y) {
    this.l.push(`${this.xy(x, y)}D01*`);
    return this;
  }
  flash(x, y) {
    this.l.push(`${this.xy(x, y)}D03*`);
    return this;
  }
  line(x1, y1, x2, y2) {
    return this.move(x1, y1).draw(x2, y2);
  }
  polyline(pts) {
    this.move(...pts[0]);
    for (const p of pts.slice(1)) this.draw(...p);
    return this;
  }
  rect(x1, y1, x2, y2) {
    return this.polyline([[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]);
  }
  region(pts) {
    this.l.push('G36*');
    this.polyline([...pts, pts[0]]);
    this.l.push('G37*');
    return this;
  }
  // arc from current point (sx,sy) to (x,y) around centre (cx,cy); dir 'cw' | 'ccw'
  arc(sx, sy, x, y, cx, cy, dir = 'ccw') {
    if (!this.g75) this.l.push('G75*');
    this.g75 = true;
    this.l.push(`${dir === 'cw' ? 'G02' : 'G03'}${this.xy(x, y)}${this.ij(cx - sx, cy - sy)}D01*`);
    this.l.push('G01*');
    return this;
  }
  pol(p) {
    this.l.push(`%LP${p}*%`);
    return this;
  }
  end(eol = '\n') {
    return [...this.l, 'M02*'].join(eol) + eol;
  }
}

// Excellon writer (KiCad-style decimal coordinates by default)
class Drill {
  constructor({ plated = true, unit = 'METRIC', header = [] } = {}) {
    this.unit = unit;
    this.h = [
      'M48',
      `; DRILL file {CAMmotion synth ${VERSION}} date ${DATE}`,
      '; FORMAT={-:-/ absolute / metric / decimal}',
      `; #@! TF.CreationDate,${DATE}`,
      `; #@! TF.GenerationSoftware,CAMmotion,synth,${VERSION}`,
      `; #@! TF.FileFunction,${plated ? 'Plated,1,2,PTH' : 'NonPlated,1,2,NPTH'}`,
      'FMAT,2',
      unit,
      ...header,
    ];
    this.tools = [];
    this.b = ['%', 'G90', 'G05'];
  }
  tool(n, diaMm) {
    this.tools.push(`T${n}C${this.v(diaMm)}`);
    return this;
  }
  v(mm) {
    return this.unit === 'INCH' ? (mm / 25.4).toFixed(4) : mm.toFixed(3);
  }
  sel(n) {
    this.b.push(`T${n}`);
    return this;
  }
  hole(x, y) {
    this.b.push(`X${this.v(x)}Y${this.v(y)}`);
    return this;
  }
  raw(...l) {
    this.b.push(...l);
    return this;
  }
  end(eol = '\n') {
    return [...this.h, ...this.tools, ...this.b, 'T0', 'M30'].join(eol) + eol;
  }
}

// ============================================================================
// 1. Coherent synthetic board set (mm, 100 x 80 mm) — DRC/CAM/3D/stackup fixture
// ============================================================================

const BOARD = { w: 100, h: 80 };
const TRACE_WIDTHS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.8, 1.0];
const GAPS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5];
const DRILLS = [0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0];
const ANNULAR = 0.3; // radial annular ring for normal pads
const THIN_RING = { drill: 1.0, pad: 1.1, x: 90, y: 20 }; // deliberately 0.05 mm ring
const MOUNT = [[4, 4], [96, 4], [96, 76], [4, 76]];
const SMD_ROW = { y: 50, x0: 10, pitch: 0.5, padW: 0.25, padH: 1.0, n: 16 };

function boardCopper(side, opts = {}) {
  const top = side === 'Top';
  const g = new Gerber({ fn: `Copper,L${top ? 1 : 2},${top ? 'Top' : 'Bot'}`, ...opts });
  g.raw('%TA.AperFunction,Conductor*%');
  TRACE_WIDTHS.forEach((w, i) => g.ad(10 + i, 'C', w));
  g.raw('%TA.AperFunction,ComponentPad*%');
  DRILLS.forEach((d, i) => g.ad(30 + i, 'C', d + 2 * ANNULAR));
  g.ad(50, 'C', THIN_RING.pad);
  g.raw('%TA.AperFunction,SMDPad,CuDef*%');
  g.ad(51, 'R', SMD_ROW.padW, SMD_ROW.padH);
  g.ad(52, 'R', 1.0, 1.25); // 0805-style pads
  g.ad(53, 'O', 1.6, 2.4);
  g.raw('%TD*%');

  if (top) {
    // trace width ladder: horizontal traces, 20 mm long
    TRACE_WIDTHS.forEach((w, i) => {
      g.raw(`%TO.N,W${String(w).replace('.', '_')}*%`).d(10 + i).line(5, 74 - i * 2.5, 25, 74 - i * 2.5);
    });
    g.raw('%TD*%');
    // gap ladder: pairs of 0.3 mm traces separated by an edge-to-edge gap
    GAPS.forEach((gap, i) => {
      const x = 32 + i * 5;
      g.d(14).raw(`%TO.N,GAPA${i}*%`).line(x, 52, x, 74);
      g.raw(`%TO.N,GAPB${i}*%`).line(x + 0.3 + gap, 52, x + 0.3 + gap, 74);
    });
    g.raw('%TD*%');
    // fine-pitch SMD row (gap = pitch - padW = 0.25 mm)
    g.d(51);
    for (let i = 0; i < SMD_ROW.n; i++) g.flash(SMD_ROW.x0 + i * SMD_ROW.pitch, SMD_ROW.y);
    // 0805 pads
    g.d(52).flash(30, 40).flash(32, 40).d(53).flash(40, 40).flash(44, 40);
    // traces with arcs: a quarter and a half arc
    g.d(15).move(50, 40).arc(50, 40, 55, 45, 50, 45, 'ccw').draw(60, 45);
    g.move(60, 40).arc(60, 40, 60, 30, 60, 35, 'cw');
  }
  // through-hole pads on both sides (drill ladder)
  DRILLS.forEach((d, i) => g.d(30 + i).flash(8 + i * 7, 20));
  g.d(50).flash(THIN_RING.x, THIN_RING.y);
  // copper pour with clearances (LPC) around pads and a thermal-relief macro
  const pour = top
    ? [[66, 30], [96, 30], [96, 60], [66, 60]]
    : [[5, 5], [95, 5], [95, 12], [5, 12]];
  g.raw('%TO.N,GND*%').region(pour).raw('%TD*%');
  g.pol('C');
  g.ad(60, 'C', 2.0).d(60);
  if (top) g.flash(75, 45).flash(85, 45);
  else g.flash(20, 8.5).flash(50, 8.5);
  g.pol('D');
  g.raw('%AMTHERMAL*', '7,0,0,$1,$2,$3,45*%');
  g.raw(`%ADD61THERMAL,${g.s(1.8)}X${g.s(1.2)}X${g.s(0.3)}*%`).d(61);
  if (top) g.flash(75, 45).flash(85, 45);
  else g.flash(20, 8.5).flash(50, 8.5);
  return g;
}

function boardMask(side) {
  const top = side === 'Top';
  const g = new Gerber({ fn: `Soldermask,${top ? 'Top' : 'Bot'}`, polarity: 'Negative' });
  const ex = 0.05; // mask expansion
  DRILLS.forEach((d, i) => g.ad(30 + i, 'C', d + 2 * ANNULAR + 2 * ex));
  g.ad(50, 'C', THIN_RING.pad + 2 * ex);
  g.ad(51, 'R', SMD_ROW.padW + 2 * ex, SMD_ROW.padH + 2 * ex);
  g.ad(52, 'R', 1.0 + 2 * ex, 1.25 + 2 * ex);
  g.ad(53, 'O', 1.6 + 2 * ex, 2.4 + 2 * ex);
  DRILLS.forEach((d, i) => g.d(30 + i).flash(8 + i * 7, 20));
  g.d(50).flash(THIN_RING.x, THIN_RING.y);
  if (top) {
    g.d(51);
    for (let i = 0; i < SMD_ROW.n; i++) g.flash(SMD_ROW.x0 + i * SMD_ROW.pitch, SMD_ROW.y);
    g.d(52).flash(30, 40).flash(32, 40).d(53).flash(40, 40).flash(44, 40);
  }
  return g;
}

function boardSilk(side) {
  const top = side === 'Top';
  const g = new Gerber({ fn: `Legend,${top ? 'Top' : 'Bot'}` });
  g.ad(10, 'C', 0.15);
  g.d(10);
  if (top) {
    g.rect(9.5, 48.8, 10 + (SMD_ROW.n - 1) * SMD_ROW.pitch + 0.5, 51.2);
    g.rect(29, 38.9, 33, 41.1);
    g.rect(38.5, 38.5, 45.5, 41.5);
    // ladder tick marks (a stand-in for text)
    TRACE_WIDTHS.forEach((_, i) => g.line(3, 74 - i * 2.5, 4, 74 - i * 2.5));
    GAPS.forEach((_, i) => g.line(32 + i * 5, 76, 32 + i * 5, 77));
  } else {
    g.rect(30, 60, 70, 70);
    g.line(30, 60, 70, 70);
  }
  return g;
}

function boardPaste() {
  const g = new Gerber({ fn: 'Paste,Top' });
  g.ad(51, 'R', SMD_ROW.padW, SMD_ROW.padH).ad(52, 'R', 1.0, 1.25);
  g.d(51);
  for (let i = 0; i < SMD_ROW.n; i++) g.flash(SMD_ROW.x0 + i * SMD_ROW.pitch, SMD_ROW.y);
  g.d(52).flash(30, 40).flash(32, 40);
  return g;
}

function boardEdge() {
  const g = new Gerber({ fn: 'Profile,NP' });
  g.raw('%TA.AperFunction,Profile*%').ad(10, 'C', 0.1).raw('%TD*%').d(10);
  // outline with rounded corners (r = 3 mm)
  const r = 3, { w, h } = BOARD;
  g.move(r, 0).draw(w - r, 0).arc(w - r, 0, w, r, w - r, r, 'ccw');
  g.draw(w, h - r).arc(w, h - r, w - r, h, w - r, h - r, 'ccw');
  g.draw(r, h).arc(r, h, 0, h - r, r, h - r, 'ccw');
  g.draw(0, r).arc(0, r, r, 0, r, r, 'ccw');
  // internal cut-out slot
  g.rect(45, 24, 55, 27);
  return g;
}

function boardPTH() {
  const d = new Drill({ plated: true });
  DRILLS.forEach((dia, i) => d.tool(i + 1, dia));
  d.tool(DRILLS.length + 1, THIN_RING.drill);
  d.tool(DRILLS.length + 2, 0.8); // slot tool
  DRILLS.forEach((_, i) => d.sel(i + 1).hole(8 + i * 7, 20));
  d.sel(DRILLS.length + 1).hole(THIN_RING.x, THIN_RING.y);
  // plated slot (routed, KiCad style)
  d.sel(DRILLS.length + 2).raw('G00X40.000Y30.000', 'M15', 'G01X44.000Y30.000', 'M16', 'G05');
  return d;
}

function boardNPTH() {
  const d = new Drill({ plated: false });
  d.tool(1, 3.2).sel(1);
  MOUNT.forEach(([x, y]) => d.hole(x, y));
  return d;
}

const BOARD_FILES = {
  'synthetic-board-F_Cu.gbr': ['Copper,L1,Top', boardCopper('Top')],
  'synthetic-board-B_Cu.gbr': ['Copper,L2,Bot', boardCopper('Bot')],
  'synthetic-board-F_Mask.gbr': ['Soldermask,Top', boardMask('Top')],
  'synthetic-board-B_Mask.gbr': ['Soldermask,Bot', boardMask('Bot')],
  'synthetic-board-F_Silkscreen.gbr': ['Legend,Top', boardSilk('Top')],
  'synthetic-board-B_Silkscreen.gbr': ['Legend,Bot', boardSilk('Bot')],
  'synthetic-board-F_Paste.gbr': ['Paste,Top', boardPaste()],
  'synthetic-board-Edge_Cuts.gbr': ['Profile,NP', boardEdge()],
};
const boardFacts = {
  boardSizeMm: [BOARD.w, BOARD.h],
  traceWidthsMm: TRACE_WIDTHS,
  traceLadder: 'top copper, horizontal traces x 5..25 mm, y = 74 - i*2.5 mm',
  gapsMm: GAPS,
  gapLadder: 'top copper, pairs of 0.3 mm vertical traces at x = 32 + i*5 mm, edge-to-edge gap = gapsMm[i]',
  drillsMm: DRILLS,
  drillLadder: 'PTH at y = 20 mm, x = 8 + i*7 mm, pad = drill + 0.6 mm (0.3 mm annular ring)',
  thinAnnularRing: { ...THIN_RING, ringMm: (THIN_RING.pad - THIN_RING.drill) / 2 },
  fineSmdRow: { ...SMD_ROW, gapMm: SMD_ROW.pitch - SMD_ROW.padW },
  mountingHolesNPTH: { diaMm: 3.2, at: MOUNT },
  platedSlot: { widthMm: 0.8, from: [40, 30], to: [44, 30] },
  internalCutout: [45, 24, 55, 27],
  layers: 2,
  thicknessMm: 1.6,
  finish: 'ENIG',
  mask: 'Green',
  silk: 'White',
};
for (const [name, [, g]] of Object.entries(BOARD_FILES)) {
  add(`board/${name}`, 'gerber', 'ok', 'board', `Synthetic 2-layer board: ${name.replace('synthetic-board-', '').replace('.gbr', '')}`, g.end());
}
add('board/synthetic-board-PTH.drl', 'drill', 'ok', 'board', 'Synthetic board plated holes: drill ladder, thin-ring hole, routed plated slot', boardPTH().end(), {
  facts: { holes: DRILLS.length + 1, slots: 1, tools: DRILLS.length + 2 },
});
add('board/synthetic-board-NPTH.drl', 'drill', 'ok', 'board', 'Synthetic board non-plated mounting holes', boardNPTH().end(), {
  facts: { holes: 4, toolDiaMm: 3.2 },
});

const job = (files, specs, stack, extra = {}) =>
  JSON.stringify(
    {
      Header: {
        GenerationSoftware: { Vendor: 'CAMmotion', Application: 'synth', Version: VERSION },
        CreationDate: DATE,
      },
      GeneralSpecs: {
        ProjectId: { Name: 'synthetic-board', GUID: '73796e74-6865-7469-632d-626f61726400', Revision: '1' },
        ...specs,
      },
      DesignRules: [{ Layers: 'Outer', PadToPad: 0.2, PadToTrack: 0.2, TrackToTrack: 0.2, MinLineWidth: 0.1, TrackToRegion: 0.3, RegionToRegion: 0.3 }],
      FilesAttributes: files,
      MaterialStackup: stack,
      ...extra,
    },
    null,
    2,
  ) + '\n';

const boardFileAttrs = [
  ...Object.entries(BOARD_FILES).map(([Path, [FileFunction]]) => ({
    Path,
    FileFunction,
    FilePolarity: FileFunction.startsWith('Soldermask') ? 'Negative' : 'Positive',
  })),
  { Path: 'synthetic-board-PTH.drl', FileFunction: 'Plated,1,2,PTH', FilePolarity: 'Positive' },
  { Path: 'synthetic-board-NPTH.drl', FileFunction: 'NonPlated,1,2,NPTH', FilePolarity: 'Positive' },
];
const stack2 = [
  { Type: 'Legend', Color: 'White', Name: 'Top Silk Screen' },
  { Type: 'SolderPaste', Name: 'Top Solder Paste' },
  { Type: 'SolderMask', Color: 'Green', Thickness: 0.01, Name: 'Top Solder Resist' },
  { Type: 'Copper', Thickness: 0.035, Name: 'F.Cu' },
  { Type: 'Dielectric', Thickness: 1.51, Material: 'FR4', Name: 'F.Cu/B.Cu', Notes: 'Type: dielectric layer 1 (from F.Cu to B.Cu)' },
  { Type: 'Copper', Thickness: 0.035, Name: 'B.Cu' },
  { Type: 'SolderMask', Color: 'Green', Thickness: 0.01, Name: 'Bottom Solder Resist' },
  { Type: 'Legend', Color: 'White', Name: 'Bottom Silk Screen' },
];
const specs2 = { Size: { X: BOARD.w, Y: BOARD.h }, LayerNumber: 2, BoardThickness: 1.6, Finish: 'ENIG' };
add('board/synthetic-board-job.gbrjob', 'gbrjob', 'ok', 'board', 'KiCad-style job file for the synthetic board (2 layers, green mask, white silk, ENIG)', job(boardFileAttrs, specs2, stack2), { facts: boardFacts });

// Variants of the board for registration / unit-mixing tests
add('board-variants/F_Cu-misaligned-0.2mm.gbr', 'gerber', 'ok', 'board-variant', 'Top copper shifted +0.2 mm X and Y relative to drills: registration / DRC test (geometry valid, alignment wrong)', boardCopper('Top', { offset: [0.2, 0.2] }).end(), { facts: { offsetMm: [0.2, 0.2] } });
add('board-variants/B_Cu-in-inches.gbr', 'gerber', 'ok', 'board-variant', 'Bottom copper written in inches (FS 2.6) — same geometry as the mm file; mixed-unit project test', boardCopper('Bot', { unit: 'IN', int: 2, dec: 6 }).end(), { facts: { sameGeometryAs: 'board/synthetic-board-B_Cu.gbr', toleranceMm: 0.0001 } });
add('board-variants/F_Cu-crlf.gbr', 'gerber', 'ok', 'board-variant', 'Top copper with CRLF line endings — identical geometry to the LF file', boardCopper('Top').end('\r\n'), { facts: { sameGeometryAs: 'board/synthetic-board-F_Cu.gbr' } });

// ============================================================================
// 2. Valid Gerber feature / stress fixtures
// ============================================================================

{
  const g = new Gerber({ attrs: false });
  g.ad(10, 'C', 0.2).d(10).line(0, 0, 10, 0);
  add('gerber-valid/minimal.gbr', 'gerber', 'ok', 'basic', 'Smallest useful valid file: one aperture, one draw', g.end(), { facts: { apertures: 1, draws: 1 } });
}
add('gerber-valid/empty-image.gbr', 'gerber', 'ok', 'basic', 'Valid header and M02 but no graphical objects (empty layer)', new Gerber({ fn: 'Copper,L1,Top' }).end(), { facts: { objects: 0 } });

{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  const shapes = ['C', 'R', 'O', 'P'];
  const N = 10000;
  for (let i = 0; i < N; i++) {
    const sz = 0.1 + (i % 50) * 0.01;
    const s = shapes[i % 4];
    if (s === 'C') g.ad(10 + i, 'C', sz);
    else if (s === 'R') g.ad(10 + i, 'R', sz, sz * 0.6);
    else if (s === 'O') g.ad(10 + i, 'O', sz * 0.6, sz);
    else g.raw(`%ADD${10 + i}P,${sz.toFixed(3)}X${3 + (i % 10)}X${(i % 360).toFixed(1)}*%`);
  }
  for (let i = 0; i < N; i++) g.d(10 + i).flash((i % 100) * 1.0, Math.floor(i / 100) * 1.0);
  add('gerber-valid/many-apertures-10k.gbr', 'gerber', 'ok', 'apertures', 'Too many apertures: 10,000 distinct apertures (C/R/O/P), each flashed once on a 1 mm grid', g.end(), { facts: { apertures: N, flashes: N } });
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  const codes = [10, 11, 99, 100, 999, 1000, 65535, 65536, 999999, 2147483647];
  codes.forEach((c, i) => g.ad(c, 'C', 0.2 + i * 0.05));
  codes.forEach((c, i) => g.d(c).flash(i * 2, 0));
  add('gerber-valid/huge-dcode-numbers.gbr', 'gerber', 'ok', 'apertures', 'Sparse, very large D-code numbers up to 2^31-1', g.end(), { facts: { apertures: codes.length, dcodes: codes } });
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  let c = 10, x = 0;
  const f = () => g.d(c++).flash((x += 3), 0);
  g.ad(c, 'C', 1.0); f();
  g.ad(c, 'C', 1.0, 0.4); f(); // with hole
  g.ad(c, 'R', 1.5, 0.8); f();
  g.ad(c, 'R', 1.5, 0.8, 0.3); f();
  g.ad(c, 'O', 2.0, 0.8); f();
  g.ad(c, 'O', 0.8, 2.0, 0.3); f();
  g.ad(c, 'O', 1.0, 1.0); f(); // obround degenerate to circle
  for (let v = 3; v <= 12; v++) {
    g.raw(`%ADD${c}P,1.500X${v}X${(v * 7.5).toFixed(1)}X0.400*%`);
    f();
  }
  add('gerber-valid/standard-apertures-all.gbr', 'gerber', 'ok', 'apertures', 'Every standard aperture: C, R, O, P (3–12 vertices), with and without holes, rotated polygons', g.end(), { facts: { apertures: c - 10 } });
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  g.raw(
    '%AMALLPRIMS*',
    '0 every non-deprecated macro primitive*',
    '1,1,1.5,0,0,0*',
    '20,1,0.3,-2,-2,2,-2,0*',
    '21,1,1.0,0.5,0,2,30*',
    '4,1,4,-1,-1,1,-1,1,1,-1,1,-1,-1,15*',
    '5,1,6,0,-3,1.2,0*',
    '7,3,3,1.2,0.8,0.2,0*',
    '1,0,0.4,0,0*%',
  );
  g.raw('%ADD10ALLPRIMS*%').d(10).flash(0, 0).flash(10, 0);
  add('gerber-valid/macro-all-primitives.gbr', 'gerber', 'ok', 'macros', 'Aperture macro using every current primitive (0,1,20,21,4,5,7) incl. exposure off and rotation', g.end());
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  g.raw(
    '%AMVARS*',
    '$4=$1x0.5*',
    '$5=($2+$3)/2*',
    '$6=-$4+$5x2-(1-$3)/4*',
    '1,1,$1,0,0*',
    '1,0,$4,0,0*',
    '21,1,$5,$3,$6,0,$2x10*',
    '20,1,0.1,-$1,0,$1,0,0*%',
  );
  g.raw('%ADD10VARS,2.0X0.6X0.4*%', '%ADD11VARS,1.0X1.0X1.0*%');
  g.d(10).flash(0, 0).d(11).flash(5, 0);
  add('gerber-valid/macro-variables-expressions.gbr', 'gerber', 'ok', 'macros', 'Macro variables, definitions ($4=…), precedence, unary minus, parentheses, division', g.end(), {
    facts: { note: 'D10: $1=2 $2=0.6 $3=0.4 -> $4=1 $5=0.5 $6=-1+1-(0.6)/4=-0.15' },
  });
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  g.ad(10, 'C', 0.5).ad(11, 'R', 1, 1);
  for (let i = 0; i < 200; i++) {
    g.pol(i % 2 ? 'C' : 'D');
    const s = 50 - i * 0.24;
    g.region([[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]]);
  }
  g.pol('C').d(11).flash(0, 0).pol('D').d(10).flash(0, 0);
  add('gerber-valid/polarity-200-levels.gbr', 'gerber', 'ok', 'polarity', '200 alternating dark/clear nested squares, then clear+dark flashes — polarity ordering and compositing', g.end(), { facts: { nestedSquares: 200 } });
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  // region with arc segments
  g.raw('G75*', 'G36*').move(0, 0).draw(10, 0).arc(10, 0, 10, 10, 10, 5, 'ccw').draw(0, 10).draw(0, 0).raw('G37*');
  // square with a square hole via a cut-in (fully coincident cut-in lines)
  g.raw('G36*').polyline([[20, 0], [30, 0], [30, 10], [20, 10], [20, 5], [23, 5], [23, 7], [27, 7], [27, 3], [23, 3], [23, 5], [20, 5], [20, 0]]).raw('G37*');
  // many contours inside one G36/G37
  g.raw('G36*');
  for (let i = 0; i < 100; i++) {
    const x = 40 + (i % 10) * 2, y = (Math.floor(i / 10)) * 2;
    g.polyline([[x, y], [x + 1.5, y], [x + 1.5, y + 1.5], [x, y + 1.5], [x, y]]);
  }
  g.raw('G37*');
  // two squares touching at one vertex (valid: touching allowed, not crossing)
  g.region([[70, 0], [75, 0], [75, 5], [70, 5]]).region([[75, 5], [80, 5], [80, 10], [75, 10]]);
  // region with a zero-length segment (duplicate vertex)
  g.raw('G36*').polyline([[85, 0], [90, 0], [90, 0], [90, 5], [85, 5], [85, 0]]).raw('G37*');
  add('gerber-valid/regions-complex.gbr', 'gerber', 'ok', 'regions', 'Regions: arc edges, cut-in hole, 100 contours in one G36, vertex-touching regions, duplicate vertex', g.end());
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  g.ad(10, 'C', 0.2).d(10).raw('G75*');
  g.move(5, 0).raw(`G03${g.xy(5, 0)}${g.ij(-5, 0)}D01*`, 'G01*'); // full circle CCW
  g.move(20, 0).raw(`G02${g.xy(20, 0)}${g.ij(-5, 0)}D01*`, 'G01*'); // full circle CW
  g.move(30, 0).arc(30, 0, 30.001, 0.0001, 30, 1, 'ccw'); // tiny arc
  const a = (359.9 * Math.PI) / 180;
  g.move(45, 0).arc(45, 0, 40 + 5 * Math.cos(a), 5 * Math.sin(a), 40, 0, 'ccw'); // nearly 360
  g.move(55, 0).arc(55, 0, 55, 0.000001, 50, 0, 'cw'); // nearly 360 the other way
  g.move(60, 0).arc(60, 0, 70, 0, 65, 0, 'ccw'); // exact half
  g.move(80, 0).arc(80, 0, 80, 1000, 80, 500, 'ccw'); // huge radius semicircle (500 mm)
  add('gerber-valid/arcs.gbr', 'gerber', 'ok', 'arcs', 'G75 arcs: full circles both directions, tiny arc, ~360° arcs, half circle, 500 mm radius arc', g.end());
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  g.ad(10, 'C', 0.3).ad(11, 'R', 1, 0.5);
  g.raw('%SRX20Y20I3.0J2.0*%').d(10).line(0, 0, 2, 1).d(11).flash(1, 0.5).raw('%SR*%');
  add('gerber-valid/step-repeat-panel.gbr', 'gerber', 'ok', 'step-repeat', 'Step and repeat 20 x 20 panel (400 copies)', g.end(), { facts: { copies: 400 } });
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  g.ad(10, 'C', 0.3).ad(11, 'R', 0.5, 0.5);
  g.raw('%ABD100*%').d(10).line(0, 0, 1, 0).d(11).flash(0, 0.5);
  g.raw('%ABD101*%').d(10).line(0, 0, 0, 1).raw('%AB*%');
  g.d(101).flash(2, 0);
  g.raw('%AB*%');
  g.raw('%ABD102*%').d(100).flash(0, 0).d(100).flash(4, 0).raw('%AB*%');
  g.d(102).flash(0, 0).raw('%LR90*%').flash(0, 10).raw('%LR0*%', '%LMX*%').flash(10, 10).raw('%LMN*%', '%LS2.0*%').flash(20, 10).raw('%LS1.0*%');
  add('gerber-valid/aperture-blocks-nested.gbr', 'gerber', 'ok', 'blocks', 'Nested aperture blocks (AB) flashed plain, rotated, mirrored and scaled', g.end());
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  g.raw('%AMARROW*', '4,1,3,0,0,2,0,0,1,0,0,0*%').raw('%ADD10ARROW*%', '%ADD11R,2.0X0.5*%');
  const ops = ['%LMN*%', '%LMX*%', '%LMY*%', '%LMXY*%'];
  ops.forEach((m, i) => {
    g.raw(m);
    [0, 30, 90, 180, 270].forEach((r, j) => {
      g.raw(`%LR${r}.0*%`);
      [0.5, 1.0, 1.5].forEach((s, k) => g.raw(`%LS${s}*%`).d(10).flash(i * 30 + k * 8, j * 8));
    });
  });
  g.raw('%LMN*%', '%LR0*%', '%LS1*%').d(11).flash(0, -10);
  add('gerber-valid/transforms-lm-lr-ls.gbr', 'gerber', 'ok', 'transforms', 'All LM mirror modes × LR rotations × LS scales applied to an asymmetric macro', g.end(), { facts: { flashes: 61 } });
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  g.raw(
    '%TF.Part,Single*%',
    '%TF.ProjectId,synthetic,73796e74-6865-7469-632d-626f61726400,rev\\u00B5*%',
    '%TF.SameCoordinates,Original*%',
    '%TF.CustomVendorField,with\\u002Ccomma*%',
    '%TA.AperFunction,SMDPad,CuDef*%',
    '%TA.DrillTolerance,0.01,0.02*%',
    '%TA.Custom,anything*%',
  );
  g.ad(10, 'R', 1, 0.6).raw('%TD.DrillTolerance*%', '%TD.Custom*%');
  g.raw('%TA.AperFunction,Conductor*%').ad(11, 'C', 0.25).raw('%TD*%');
  g.raw('%TO.N,GND*%', '%TO.C,U1*%', '%TO.P,U1,1,VCC*%', '%TO.CRot,90*%', '%TO.CMfr,Acme*%', '%TO.CVal,10µF*%');
  g.d(10).flash(0, 0);
  g.raw('%TD.P*%', '%TO.N,Net-(U1-Pad2)/µ—ünicode*%').flash(2, 0);
  g.raw('%TD*%', '%TO.N,N/C*%').d(11).line(0, 0, 2, 0).raw('%TD*%');
  add('gerber-valid/x2-attributes-full.gbr', 'gerber', 'ok', 'attributes', 'X2 attributes: TF/TA/TO/TD incl. component, pin, net, rotation, custom, UTF-8 and \\u escapes', g.end());
}
{
  const g = new Gerber({ attrs: false, unit: 'IN', int: 2, dec: 4 });
  g.ad(10, 'C', 0.254).d(10).rect(0, 0, 25.4, 12.7).flash(12.7, 6.35);
  add('gerber-valid/inch-legacy-2-4.gbr', 'gerber', 'ok', 'units', 'Legacy inch, FS 2.4 with leading zeros omitted (no X2 attributes)', g.end(), { facts: { outlineMm: [0, 0, 25.4, 12.7] } });
}
{
  const g = new Gerber({ attrs: false });
  g.ad(10, 'C', 0.2).d(10);
  g.line(0, 0, 9999.999999, 0).line(0, 0, 0, 9999.999999);
  add('gerber-valid/format-max-4-6.gbr', 'gerber', 'ok', 'coordinates', 'Coordinates at the FS 4.6 maximum (9999.999999 mm)', g.end(), { facts: { pathBoundsMm: [0, 0, 9999.999999, 9999.999999] } });
}
{
  const lines = [
    'G04 Trailing zero omission, FS T 2.5 inch (deprecated)*',
    '%FSTAX25Y25*%', '%MOIN*%', '%ADD10C,0.010*%', 'D10*',
    'X0Y0D02*', 'X001Y0D01*', 'X001Y0005D01*', 'X0Y0005D01*', 'X0Y0D01*', 'M02*', '',
  ];
  add('gerber-valid/trailing-zero-omission.gbr', 'gerber', 'warning', 'deprecated', 'Deprecated trailing-zero omission (FST): X001 = 0.1 in, Y0005 = 0.05 in', lines.join('\n'), { facts: { boundsIn: [0, 0, 0.1, 0.05] } });
}
{
  const lines = [
    'G04 Incremental coordinates (deprecated)*',
    '%FSLIX46Y46*%', '%MOMM*%', '%ADD10C,0.2*%', 'D10*',
    'X0Y0D02*', 'X10000000Y0D01*', 'X0Y10000000D01*', 'X-10000000Y0D01*', 'X0Y-10000000D01*', 'M02*', '',
  ];
  add('gerber-valid/incremental-coordinates.gbr', 'gerber', 'warning', 'deprecated', 'Deprecated incremental notation (FSLI): draws a 10 mm square', lines.join('\n'), { facts: { boundsMm: [0, 0, 10, 10] } });
}
{
  const lines = [
    'G04 Deprecated commands that real-world files still contain*',
    '%INSYNTH*%', '%LNLAYER1*%', '%IPPOS*%', '%ASAXBY*%', '%OFA0B0*%', '%SFA1.0B1.0*%', '%MIA0B0*%',
    '%FSLAX46Y46*%', '%MOMM*%', 'G71*', 'G90*',
    '%ADD10C,0.2*%', '%ADD11R,1X1*%',
    'G54D10*', 'X0Y0D02*', 'G01X5000000Y0D01*',
    'G54D11*', 'G55X10000000Y0D03*',
    '%AMOLDPRIMS*', '2,1,0.2,0,0,2,0,0*', '22,1,1,0.5,0,1,0*', '6,0,0,2,0.1,0.1,3,0.05,2.5,0*%', '%ADD12OLDPRIMS*%',
    'D12*', 'X20000000Y0D03*',
    'G74*', 'D10*', 'X30000000Y0D02*', 'G02X35000000Y5000000I5000000J0D01*', 'G01*', 'G75*',
    'M00*',
  ];
  add('gerber-valid/deprecated-commands.gbr', 'gerber', 'warning', 'deprecated', 'IN, LN, IP, AS, OF, SF, MI, G71, G90, G54, G55, primitives 2/22/6 (moiré), G74 single-quadrant arc, M00 end', lines.join('\n') + '\n');
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  g.ad(10, 'C', 0.2).d(10);
  g.raw('G75*');
  g.raw(`${g.xy(0, 0)}D02*`, `X${g.n(10)}D01*`, `Y${g.n(10)}D01*`, `X${g.n(0)}D01*`, `Y${g.n(0)}D01*`);
  g.raw('G01X20000000Y0D02*', 'G01X25000000Y0D01*', `G03X30000000Y0I2500000J0D01*`, 'G01*');
  g.raw('X40000000Y0D02*', 'X45000000Y0D01*', 'X45000000Y5000000*'); // deprecated: coordinate w/o D-code reuses D01
  add('gerber-valid/modal-coordinates.gbr', 'gerber', 'warning', 'coordinates', 'Omitted X or Y (modal), G-code combined with coordinates, coordinate without D-code (deprecated modal D01)', g.end());
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  g.ad(10, 'C', 0.2).d(10).rect(0, 0, 10, 10).flash(5, 5);
  add('gerber-valid/no-newlines.gbr', 'gerber', 'ok', 'whitespace', 'Entire file on one line (newlines are optional in Gerber)', g.end('').replace(/\n/g, '') + '\n');
  add('gerber-valid/crlf-bom-blank-lines.gbr', 'gerber', 'warning', 'whitespace', 'UTF-8 BOM, CRLF endings, blank lines and trailing spaces between commands', '﻿' + g.l.concat('M02*').join(' \r\n\r\n') + '\r\n');
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  for (let i = 0; i < 2000; i++) g.raw(`G04 comment ${i}: µ Ω ✓ 日本語 — "quotes" 'apos' percent? no — <tags> & ampersand*`);
  g.ad(10, 'C', 0.2).d(10).line(0, 0, 1, 1);
  add('gerber-valid/comments-unicode.gbr', 'gerber', 'ok', 'whitespace', '2,000 G04 comments with UTF-8 and special characters', g.end());
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  g.ad(10, 'C', 0).ad(11, 'C', 0.000001).ad(12, 'R', 0.000001, 5).ad(13, 'C', 0.2);
  g.d(10).line(0, 0, 10, 0).flash(5, 5);
  g.d(11).line(0, 1, 10, 1).flash(5, 6);
  g.d(12).flash(12, 0);
  g.d(13).line(20, 0, 20, 0).line(21, 0, 21.000001, 0).flash(22, 0).flash(22, 0);
  add('gerber-valid/zero-and-tiny-features.gbr', 'gerber', 'ok', 'geometry', 'Zero-size aperture (allowed), 1 nm features, zero-length draws, duplicate flashes', g.end());
}
{
  const g = new Gerber({ fn: 'Profile,NP' });
  g.ad(10, 'C', 0.5).d(10).rect(0, 0, 1000, 1000);
  g.ad(11, 'C', 2).d(11).flash(1, 1).flash(999, 1).flash(999, 999).flash(1, 999).flash(500, 500);
  add('gerber-valid/physically-huge-1m.gbr', 'gerber', 'ok', 'size', 'Physically huge board: 1000 × 1000 mm outline with five pads', g.end(), { facts: { outlineMm: [0, 0, 1000, 1000] } });
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top', offset: [-5000, -3000] });
  g.ad(10, 'C', 0.2).d(10).rect(0, 0, 50, 30).flash(25, 15);
  add('gerber-valid/far-from-origin-negative.gbr', 'gerber', 'ok', 'coordinates', 'Small 50 × 30 mm board located at (-5000, -3000) mm — negative, far from origin', g.end(), { facts: { outlineMm: [-5000, -3000, -4950, -2970] } });
}

// ---------- data-size stress (kept well under GitHub's 50 MB warning / 100 MB limit) ----------
{
  const rnd = mulberry32(42);
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  for (let i = 0; i < 8; i++) g.ad(10 + i, 'C', 0.1 + i * 0.05);
  const target = 30 * 1024 * 1024;
  let bytes = 0, draws = 0, x = 150, y = 150;
  while (bytes < target) {
    g.d(10 + Math.floor(rnd() * 8));
    x = 150 + (rnd() - 0.5) * 290; y = 150 + (rnd() - 0.5) * 290;
    g.move(x, y);
    for (let s = 0; s < 200; s++) {
      x = Math.min(299, Math.max(1, x + (rnd() - 0.5) * 4));
      y = Math.min(299, Math.max(1, y + (rnd() - 0.5) * 4));
      g.draw(x, y);
      draws++;
      bytes += 24;
    }
  }
  add('gerber-large/large-dense-traces-30MB.gbr', 'gerber', 'limit', 'data-size', '~30 MB, ~1.3 million random-walk draws in a 300 × 300 mm area: parse/render performance', g.end(), { facts: { draws } });
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  const N = 100000;
  const pts = Array.from({ length: N }, (_, i) => {
    const a = (i / N) * 2 * Math.PI;
    const r = 100 + 2 * Math.sin(a * 997);
    return [150 + r * Math.cos(a), 150 + r * Math.sin(a)];
  });
  g.region(pts);
  add('gerber-large/region-100k-vertices.gbr', 'gerber', 'limit', 'data-size', 'One simple region with 100,000 vertices (wavy circle, r ≈ 100 mm): triangulation / offsetting stress', g.end(), { facts: { vertices: N } });
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  g.raw('%AMTHERMAL*', '7,0,0,$1,$2,$3,45*%', '%ADD10THERMAL,1.0X0.6X0.2*%').d(10);
  let n = 0;
  for (let i = 0; i < 450; i++) for (let j = 0; j < 450; j++) { g.flash(i * 1.27, j * 1.27); n++; }
  add('gerber-large/macro-flash-grid-200k.gbr', 'gerber', 'limit', 'data-size', '202,500 thermal-macro flashes on a 1.27 mm grid', g.end(), { facts: { flashes: n } });
}
{
  const g = new Gerber({ fn: 'Copper,L1,Top' });
  g.ad(10, 'C', 1).d(10);
  for (let i = 0; i < 20000; i++) g.flash(5, 5);
  add('gerber-large/identical-flashes-20k.gbr', 'gerber', 'limit', 'data-size', '20,000 identical flashes at the same point (dedupe / overdraw)', g.end(), { facts: { flashes: 20000, uniqueFlashes: 1 } });
}

// ============================================================================
// 3. Broken / hostile Gerber fixtures
// ============================================================================

const base = () => new Gerber({ fn: 'Copper,L1,Top' }).ad(10, 'C', 0.2).d(10);
const bad = (name, desc, content, errorToken, expect = 'error', extra = {}) =>
  add(`gerber-broken/${name}`, 'gerber', expect, 'broken', desc, content, { errorToken, ...extra });

bad('empty-file.gbr', 'Zero-byte file', '');
bad('whitespace-only.gbr', 'Only whitespace and newlines', '\n\n   \r\n\t\n');
bad('missing-m02.gbr', 'Truncated: no M02 end-of-file', base().line(0, 0, 10, 0).l.join('\n') + '\n', null, 'warning');
{
  const s = base().line(0, 0, 10, 0).end();
  bad('truncated-mid-command.gbr', 'Truncated in the middle of a coordinate', s.slice(0, s.lastIndexOf('D01') - 4), null);
}
bad('truncated-mid-extended.gbr', 'Truncated inside an extended %AD…% command', base().l.join('\n') + '\n%ADD11R,1.0X', '%ADD11R');
bad('undefined-aperture.gbr', 'Selects D999 which is never defined', base().raw('D999*').line(0, 0, 1, 0).end(), 'D999*');
bad('draw-before-aperture.gbr', 'D01 draw before any aperture is selected', new Gerber({ fn: 'Copper,L1,Top' }).ad(10, 'C', 0.2).line(0, 0, 1, 0).end(), 'D01*');
bad('missing-fs.gbr', 'No %FS…% format statement before coordinates', ['%MOMM*%', '%ADD10C,0.2*%', 'D10*', 'X0Y0D02*', 'X1000000Y0D01*', 'M02*', ''].join('\n'), 'X0Y0D02*');
bad('missing-mo.gbr', 'No %MO…% unit statement (many tools default to inch — must be reported)', ['%FSLAX46Y46*%', '%ADD10C,0.2*%', 'D10*', 'X0Y0D02*', 'X1000000Y0D01*', 'M02*', ''].join('\n'), 'X0Y0D02*', 'warning');
bad('invalid-fs-digits.gbr', 'FS with 9.9 digits (max is 6 integer / 6 decimal)', ['%FSLAX99Y99*%', '%MOMM*%', 'M02*', ''].join('\n'), '%FSLAX99Y99*%');
bad('fs-x-y-mismatch.gbr', 'FS with different X and Y formats (not allowed)', ['%FSLAX46Y35*%', '%MOMM*%', 'M02*', ''].join('\n'), '%FSLAX46Y35*%');
bad('region-unclosed-contour.gbr', 'Region contour whose last point is not the first point', base().raw('G36*').polyline([[0, 0], [10, 0], [10, 10], [0, 10]]).raw('G37*').end(), 'G37*');
bad('region-missing-g37.gbr', 'G36 region never closed with G37', base().raw('G36*').polyline([[0, 0], [10, 0], [10, 10], [0, 0]]).end(), 'M02*');
bad('flash-in-region.gbr', 'D03 flash inside a region statement (not allowed)', base().raw('G36*').move(0, 0).draw(10, 0).flash(5, 5).draw(0, 0).raw('G37*').end(), 'D03*');
bad('aperture-select-in-region.gbr', 'Dnn aperture selection inside a region (not allowed)', base().ad(11, 'C', 0.3).raw('G36*').move(0, 0).draw(10, 0).d(11).draw(10, 10).draw(0, 0).raw('G37*').end(), 'D11*');
{
  const g = base().raw('G75*').move(0, 0);
  g.raw(`G03${g.xy(10, 0)}${g.ij(1, 7)}D01*`);
  bad('arc-bad-center.gbr', 'Arc whose centre is not equidistant from start and end (r 7.07 vs 11.4)', g.end(), 'G03');
}
{
  const g = base().move(5, 0);
  g.raw(`G03${g.xy(0, 5)}${g.ij(-5, 0)}D01*`);
  bad('arc-without-g75.gbr', 'Arc with no G75/G74 quadrant mode set', g.end(), 'G03', 'warning');
}
{
  const g = base().raw('G75*').move(0, 0);
  g.raw(`G03${g.xy(0, 0)}${g.ij(0, 0)}D01*`);
  bad('arc-zero-radius.gbr', 'Arc with zero radius (I0J0, start = end)', g.end(), 'G03');
}
bad('aperture-redefined.gbr', 'D10 defined twice with different sizes', base().ad(10, 'C', 1.0).line(0, 0, 1, 0).end(), '%ADD10C,1*%');
bad('aperture-code-below-10.gbr', 'Aperture defined as D05 (codes < 10 are reserved)', new Gerber({ fn: 'Copper,L1,Top' }).raw('%ADD05C,0.2*%', 'D05*').line(0, 0, 1, 0).end(), '%ADD05');
bad('macro-divide-by-zero.gbr', 'Macro expression divides by zero', new Gerber({ fn: 'Copper,L1,Top' }).raw('%AMDIV*', '1,1,$1/0,0,0*%', '%ADD10DIV,1*%', 'D10*').flash(0, 0).end(), '1,1,$1/0');
bad('macro-undefined-variable.gbr', 'Macro uses $7 which is never given or defined', new Gerber({ fn: 'Copper,L1,Top' }).raw('%AMUND*', '1,1,$7,0,0*%', '%ADD10UND,1*%', 'D10*').flash(0, 0).end(), '1,1,$7', 'warning', { note: 'Spec: undefined variables are 0 — must warn, not crash' });
bad('macro-unknown-primitive.gbr', 'Macro with primitive code 9 (does not exist)', new Gerber({ fn: 'Copper,L1,Top' }).raw('%AMUNK*', '9,1,1,0,0*%', '%ADD10UNK*%', 'D10*').flash(0, 0).end(), '9,1,1');
bad('macro-undefined.gbr', 'AD references macro NOPE that was never defined', new Gerber({ fn: 'Copper,L1,Top' }).raw('%ADD10NOPE,1*%', 'D10*').flash(0, 0).end(), '%ADD10NOPE');
bad('macro-outline-not-closed.gbr', 'Outline primitive whose last vertex differs from the first', new Gerber({ fn: 'Copper,L1,Top' }).raw('%AMOPEN*', '4,1,3,0,0,1,0,1,1,0,1,0*%', '%ADD10OPEN*%', 'D10*').flash(0, 0).end(), '4,1,3');
bad('negative-aperture-size.gbr', 'Circle aperture with negative diameter', new Gerber({ fn: 'Copper,L1,Top' }).raw('%ADD10C,-0.5*%', 'D10*').flash(0, 0).end(), '%ADD10C,-0.5*%');
bad('polygon-2-vertices.gbr', 'Polygon aperture with 2 vertices (must be 3–12)', new Gerber({ fn: 'Copper,L1,Top' }).raw('%ADD10P,1X2*%', 'D10*').flash(0, 0).end(), '%ADD10P');
bad('polygon-13-vertices.gbr', 'Polygon aperture with 13 vertices (must be 3–12)', new Gerber({ fn: 'Copper,L1,Top' }).raw('%ADD10P,1X13*%', 'D10*').flash(0, 0).end(), '%ADD10P');
bad('hole-larger-than-aperture.gbr', 'Circle aperture whose hole is larger than the aperture', new Gerber({ fn: 'Copper,L1,Top' }).raw('%ADD10C,0.5X1.0*%', 'D10*').flash(0, 0).end(), '%ADD10C');
bad('invalid-polarity.gbr', '%LPX*% is not a valid polarity', base().raw('%LPX*%').flash(0, 0).end(), '%LPX*%');
bad('sr-unclosed.gbr', 'Step-and-repeat block never closed', base().raw('%SRX2Y2I1J1*%').flash(0, 0).end(), 'M02*');
bad('ab-unclosed.gbr', 'Aperture block never closed', base().raw('%ABD100*%').flash(0, 0).end(), 'M02*');
bad('ab-self-reference.gbr', 'Aperture block that flashes itself (infinite recursion)', base().raw('%ABD100*%').raw('D100*').flash(0, 0).raw('%AB*%').raw('D100*').flash(0, 0).end(), 'D100*');
bad('unknown-commands.gbr', 'Unknown G-code G99, M-code M99 and extended %XX% command', base().raw('G99*', 'M99*', '%XXHELLO*%').flash(0, 0).end(), 'G99*');
bad('missing-asterisk.gbr', 'Word missing its terminating *', base().raw('X0Y0D02', 'X1000000Y0D01*').end(), 'X0Y0D02');
bad('unterminated-percent.gbr', 'Extended command missing its closing %', base().raw('%ADD11C,0.3*').d(11).flash(0, 0).end(), '%ADD11C');
bad('mixed-units-midfile.gbr', 'MOMM then MOIN later in the file', base().line(0, 0, 1, 0).raw('%MOIN*%').line(0, 0, 1, 0).end(), '%MOIN*%', 'warning');
bad('nan-and-exponent-values.gbr', 'NaN, Infinity and exponent notation in numbers', new Gerber({ fn: 'Copper,L1,Top' }).raw('%ADD10C,NaN*%', '%ADD11C,1e-3*%', '%ADD12C,Infinity*%', 'D11*', 'X1e6Y0D03*').end(), '%ADD10C,NaN*%');
bad('attribute-malformed.gbr', 'Attributes with no name / missing values', base().raw('%TF*%', '%TA.*%', '%TO.N*%').flash(0, 0).end(), '%TF*%', 'warning');
bad('md5-mismatch.gbr', '%TF.MD5% present but deliberately wrong', base().raw('%TF.MD5,00000000000000000000000000000000*%').flash(0, 0).end(), '%TF.MD5', 'warning');
bad('self-intersecting-region.gbr', 'Figure-8 (bow-tie) region — self-intersecting contours are invalid', base().region([[0, 0], [10, 10], [10, 0], [0, 10]]).end(), 'G36*', 'warning');
bad('coordinate-overflow.gbr', 'Coordinate with 26 digits (far beyond FS 4.6 and float precision)', base().raw('X99999999999999999999999999Y0D03*').end(), 'X999');
bad('wrong-file-type-excellon.gbr', 'Excellon drill data inside a .gbr file', 'M48\nMETRIC,TZ\nT1C0.8\n%\nT1\nX10.0Y10.0\nM30\n', 'M48');
{
  const rnd = mulberry32(7);
  const buf = Buffer.alloc(64 * 1024);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(rnd() * 256);
  bad('binary-garbage.bin.gbr', '64 KB of random bytes', buf, null);
}
{
  const s = base().line(0, 0, 10, 0).end();
  const mid = s.indexOf('X0Y0D02*');
  bad('nul-bytes.gbr', 'Otherwise valid file with NUL bytes inserted', s.slice(0, mid) + '\0\0\0' + s.slice(mid), null);
}
{
  const s = new Gerber({ fn: 'Copper,L1,Top' }).ad(10, 'C', 0.2).d(10).line(0, 0, 10, 0).end();
  bad('utf16-encoded.gbr', 'Valid content but UTF-16LE encoded (with BOM)', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]), null);
}

// resource / hostile inputs
const limit = (name, desc, content, facts) =>
  add(`gerber-hostile/${name}`, 'gerber', 'limit', 'hostile', desc, content, { facts });
limit('sr-bomb-10-billion.gbr', 'Tiny file, SR X100000 Y100000: 10^10 copies — must refuse or render lazily, not hang', base().raw('%SRX100000Y100000I0.1J0.1*%').flash(0, 0).raw('%SR*%').end(), { copies: 1e10 });
{
  const g = base().ad(11, 'C', 0.1);
  for (let i = 0; i < 1000; i++) g.raw(`%ABD${100 + i}*%`);
  g.d(11).flash(0, 0);
  for (let i = 0; i < 1000; i++) g.raw('%AB*%');
  g.raw('D100*').flash(0, 0);
  limit('ab-nested-1000-deep.gbr', 'Aperture blocks nested 1000 levels deep (recursion depth)', g.end(), { depth: 1000 });
}
{
  // block i flashes block i-1 twice -> 2^30 objects
  const g = base().ad(11, 'C', 0.1);
  g.raw('%ABD100*%').d(11).flash(0, 0).raw('%AB*%');
  for (let i = 1; i <= 30; i++) g.raw(`%ABD${100 + i}*%`, `D${99 + i}*`).flash(0, 0).flash(0.1, 0).raw('%AB*%');
  g.raw('D130*').flash(0, 0);
  limit('ab-exponential-2pow30.gbr', '30 aperture blocks each flashing the previous twice: 2^30 objects from a 2 KB file', g.end(), { objects: 2 ** 30 });
}
{
  const terms = Array.from({ length: 50000 }, (_, i) => `${(i % 9) + 1}`).join('+');
  limit('macro-expression-50k-terms.gbr', 'Macro expression with 50,000 terms', new Gerber({ fn: 'Copper,L1,Top' }).raw('%AMBIG*', `1,1,(${terms})/250000,0,0*%`, '%ADD10BIG*%', 'D10*').flash(0, 0).end());
  const nest = '('.repeat(5000) + '1' + ')'.repeat(5000);
  limit('macro-nested-parens-5000.gbr', 'Macro expression nested 5,000 parentheses deep (parser recursion)', new Gerber({ fn: 'Copper,L1,Top' }).raw('%AMNEST*', `1,1,${nest},0,0*%`, '%ADD10NEST*%', 'D10*').flash(0, 0).end());
}
limit('very-long-line-2MB.gbr', 'A single 2 MB coordinate word', base().raw(`X${'1'.repeat(2 * 1024 * 1024)}Y0D03*`).end());
limit('very-long-comment-5MB.gbr', 'A single 5 MB G04 comment', base().raw(`G04 ${'A'.repeat(5 * 1024 * 1024)}*`).flash(0, 0).end());
{
  const g = base();
  g.raw('%ADD11R,1000000X1000000*%').d(11).flash(0, 0);
  limit('aperture-1km.gbr', 'Aperture one kilometre wide (rasteriser memory)', g.end());
}

// ============================================================================
// 4. Drill (Excellon) fixtures
// ============================================================================

{
  const d = new Drill();
  d.tool(1, 0.8).tool(2, 1.0).tool(3, 3.2);
  d.sel(1).hole(10, 10).hole(12.54, 10).sel(2).hole(20, 10).sel(3).hole(30, 10);
  add('drill-valid/kicad-pth-metric.drl', 'drill', 'ok', 'drill-basic', 'KiCad-style metric decimal Excellon with X2 attributes', d.end(), { facts: { holes: 4, tools: 3 } });
}
{
  const l = ['M48', ';Legacy inch, leading zeros kept, trailing suppressed, 2.4', 'INCH,LZ', 'T01C0.0315', 'T02C0.0400', '%', 'T01', 'X0125Y01', 'X02Y0045', 'T02', 'X01Y01', 'M30', ''];
  add('drill-valid/inch-lz-2-4.drl', 'drill', 'warning', 'drill-format', 'Legacy INCH,LZ implied decimal (2.4): X0125 = 1.25 in, Y0045 = 0.45 in — format must be assumed', l.join('\n'), { facts: { assumedFormat: '2.4', holesIn: [[1.25, 1.0], [2.0, 0.45], [1.0, 1.0]] } });
}
{
  const l = ['M48', ';Legacy inch, trailing zeros kept, leading suppressed, 2.4', 'INCH,TZ', 'T1C0.0315', '%', 'T1', 'X12500Y10000', 'X20000Y4500', 'X100Y100', 'M30', ''];
  add('drill-valid/inch-tz-2-4.drl', 'drill', 'warning', 'drill-format', 'Legacy INCH,TZ implied decimal (2.4): X12500 = 1.25 in, X100 = 0.01 in', l.join('\n'), { facts: { assumedFormat: '2.4', holesIn: [[1.25, 1.0], [2.0, 0.45], [0.01, 0.01]] } });
}
{
  const l = ['M48', ';Altium-style metric with explicit format', ';FILE_FORMAT=3:3', 'METRIC,LZ,000.000', 'T1F00S00C0.800', 'T2F00S00C1.200', '%', 'T01', 'X0125Y0254', 'X01Y01', 'T02', 'X050Y050', 'M30', ''];
  add('drill-valid/metric-lz-3-3.drl', 'drill', 'ok', 'drill-format', 'METRIC,LZ,000.000 (3.3) with F/S feed/speed in tool defs: X0125 = 12.5 mm', l.join('\n'), { facts: { holesMm: [[12.5, 25.4], [10, 10], [50, 50]] } });
}
{
  const d = new Drill();
  d.tool(1, 0.8).tool(2, 1.2).sel(1).raw('X10.0Y10.0G85X14.0Y10.0', 'X10.0Y20.0G85X10.0Y25.0').sel(2).raw('X20.0Y10.0G85X24.0Y14.0');
  add('drill-valid/slots-g85.drl', 'drill', 'ok', 'drill-slots', 'G85 canned slots (horizontal, vertical, diagonal)', d.end(), { facts: { slots: 3 } });
}
{
  const d = new Drill();
  d.tool(1, 1.0).sel(1).raw('G00X10.0Y10.0', 'M15', 'G01X20.0Y10.0', 'G01X20.0Y15.0', 'M16', 'G05', 'G00X30.0Y10.0', 'M15', 'G03X35.0Y15.0A5.0', 'M16', 'G05');
  add('drill-valid/routed-slots-m15-m16.drl', 'drill', 'ok', 'drill-slots', 'Routed slots: G00/M15/G01/M16/G05, multi-segment and an arc (G03 with A radius)', d.end(), { facts: { routes: 2 } });
}
{
  const d = new Drill();
  d.tool(1, 0.8).sel(1).hole(10, 10).raw('R9X2.54', 'X10.0Y20.0', 'R4Y2.54', 'X40.0Y40.0', 'R3X1.0Y1.0');
  add('drill-valid/repeat-codes.drl', 'drill', 'warning', 'drill-format', 'R repeat codes: R9X2.54 → 10 holes in a row, etc.', d.end(), { facts: { holes: 1 + 9 + 1 + 4 + 1 + 3 } });
}
{
  const d = new Drill();
  const N = 999;
  for (let i = 1; i <= N; i++) d.tool(i, 0.1 + i * 0.005);
  for (let i = 1; i <= N; i++) d.sel(i).hole((i % 40) * 3, Math.floor(i / 40) * 3);
  add('drill-valid/many-tools-999.drl', 'drill', 'limit', 'drill-tools', '999 tools (classic Excellon allows 99): tool library matching stress', d.end(), { facts: { tools: N, holes: N } });
}
{
  const d = new Drill();
  d.tool(1, 0.8).tool(2, 1.0);
  for (let i = 0; i < 500; i++) d.sel((i % 2) + 1).hole(i * 0.5, 0);
  add('drill-valid/tool-ping-pong.drl', 'drill', 'ok', 'drill-tools', 'Alternates between two tools 500 times: tool-change optimisation test', d.end(), { facts: { holes: 500, toolSelections: 500 } });
}
{
  const d = new Drill();
  d.tool(1, 0.8).sel(1).raw('X10.0Y10.0', 'X20.0', 'Y20.0', 'X10.0');
  add('drill-valid/modal-coordinates.drl', 'drill', 'ok', 'drill-format', 'Omitted X or Y reuses the previous value', d.end(), { facts: { holesMm: [[10, 10], [20, 10], [20, 20], [10, 20]] } });
}
{
  const d = new Drill();
  d.tool(1, 0.8).tool(2, 0.8).sel(1).hole(10, 10).hole(10, 10).hole(10.05, 10).sel(2).hole(10, 10);
  add('drill-valid/duplicate-and-overlapping-holes.drl', 'drill', 'ok', 'drill-drc', 'Exact duplicate holes, 0.05 mm-apart holes, two tools of the same size', d.end(), { facts: { holes: 4, uniquePositions: 2 } });
}
{
  const d = new Drill();
  d.tool(1, 0.8).sel(1).hole(0, 0).hole(1000, 0).hole(1000, 1000).hole(0, 1000);
  add('drill-valid/physically-huge-1m.drl', 'drill', 'ok', 'size', 'Holes at the corners of a 1 × 1 m area (matches physically-huge-1m.gbr)', d.end());
}
{
  const d = new Drill();
  d.tool(1, 0.8);
  d.h.push('; comment with unicode µ ✓', ';', '; blank comment above');
  d.sel(1).hole(1, 1);
  add('drill-valid/crlf-comments.drl', 'drill', 'ok', 'drill-format', 'CRLF line endings and assorted comments', d.end('\r\n'));
}
{
  const rnd = mulberry32(99);
  const d = new Drill();
  const sizes = [0.3, 0.4, 0.6, 0.8, 1.0];
  sizes.forEach((s, i) => d.tool(i + 1, s));
  let n = 0;
  sizes.forEach((_, t) => {
    d.sel(t + 1);
    for (let i = 0; i < 60000; i++) { d.hole(rnd() * 400, rnd() * 400); n++; }
  });
  add('drill-large/holes-300k.drl', 'drill', 'limit', 'data-size', '300,000 random holes over 400 × 400 mm in 5 tools: drill-path optimisation and render stress', d.end(), { facts: { holes: n } });
}

// broken drill
const dbad = (name, desc, content, errorToken, expect = 'error') =>
  add(`drill-broken/${name}`, 'drill', expect, 'broken', desc, content, { errorToken });
dbad('empty-file.drl', 'Zero-byte file', '');
dbad('tool-undefined.drl', 'Selects T5 which is not defined in the header', new Drill().tool(1, 0.8).sel(5).hole(1, 1).end(), 'T5');
dbad('no-header-end.drl', 'Header never terminated with % or M95', 'M48\nMETRIC\nT1C0.8\nT1\nX1.0Y1.0\nM30\n', null);
dbad('missing-m30.drl', 'No M30 end of program', new Drill().tool(1, 0.8).sel(1).hole(1, 1).end().replace('M30\n', ''), null, 'warning');
dbad('zero-and-negative-tool.drl', 'Tools with 0 and negative diameters', 'M48\nMETRIC\nT1C0.000\nT2C-0.800\n%\nT1\nX1.0Y1.0\nT2\nX2.0Y2.0\nM30\n', 'T1C0.000');
dbad('units-change-midfile.drl', 'METRIC header then INCH (M72) in the body', 'M48\nMETRIC\nT1C0.8\n%\nT1\nX10.0Y10.0\nM72\nX1.0Y1.0\nM30\n', 'M72', 'warning');
dbad('no-units.drl', 'No METRIC/INCH declaration — units must be guessed and reported', 'M48\nT1C0.8\n%\nT1\nX10.0Y10.0\nM30\n', null, 'warning');
dbad('garbage-coordinates.drl', 'Unparseable coordinate words', 'M48\nMETRIC\nT1C0.8\n%\nT1\nX1.0.0Y--2\nXY\nX1,5Y2\nM30\n', 'X1.0.0');
dbad('hole-before-tool.drl', 'Hole before any tool is selected', 'M48\nMETRIC\nT1C0.8\n%\nX1.0Y1.0\nT1\nX2.0Y2.0\nM30\n', 'X1.0Y1.0');
dbad('wrong-file-type-gerber.drl', 'Gerber data inside a .drl file', new Gerber().ad(10, 'C', 0.2).d(10).flash(0, 0).end(), 'G04');
dbad('tool-redefined.drl', 'T1 defined twice with different sizes', 'M48\nMETRIC\nT1C0.8\nT1C1.2\n%\nT1\nX1.0Y1.0\nM30\n', 'T1C1.2', 'warning');

// ============================================================================
// 5. Gerber job files
// ============================================================================

{
  const stack4 = [
    { Type: 'Legend', Color: 'Yellow', Name: 'Top Silk Screen' },
    { Type: 'SolderMask', Color: 'Black', Thickness: 0.01, Name: 'Top Solder Resist' },
    { Type: 'Copper', Thickness: 0.035, Name: 'F.Cu' },
    { Type: 'Dielectric', Thickness: 0.2, Material: 'FR4', DielectricConstant: 4.5, LossTangent: 0.02, Name: 'F.Cu/In1.Cu' },
    { Type: 'Copper', Thickness: 0.0175, Name: 'In1.Cu' },
    { Type: 'Dielectric', Thickness: 1.065, Material: 'FR4', Name: 'In1.Cu/In2.Cu' },
    { Type: 'Copper', Thickness: 0.0175, Name: 'In2.Cu' },
    { Type: 'Dielectric', Thickness: 0.2, Material: 'FR4', Name: 'In2.Cu/B.Cu' },
    { Type: 'Copper', Thickness: 0.035, Name: 'B.Cu' },
    { Type: 'SolderMask', Color: 'Black', Thickness: 0.01, Name: 'Bottom Solder Resist' },
    { Type: 'Legend', Color: 'Yellow', Name: 'Bottom Silk Screen' },
  ];
  const files = ['L1,Top', 'L2,Inr', 'L3,Inr', 'L4,Bot'].map((f, i) => ({ Path: `four-layer-${i + 1}.gbr`, FileFunction: `Copper,${f}`, FilePolarity: 'Positive' }));
  add('gbrjob/four-layer-black-yellow-enig.gbrjob', 'gbrjob', 'ok', 'stackup', '4-layer stackup, black mask, yellow silk, ENIG, inner layers (referenced files intentionally absent: stackup-only test)', job(files, { Size: { X: 50, Y: 50 }, LayerNumber: 4, BoardThickness: 1.6, Finish: 'ENIG', ImpedanceControlled: true }, stack4), { facts: { copperLayers: 4, mask: 'Black', silk: 'Yellow' } });
  const stackOdd = stack2.map((l) => (l.Type === 'SolderMask' ? { ...l, Color: 'Sparkly Teal' } : l.Type === 'Dielectric' ? { ...l, Material: 'Unobtainium' } : l));
  add('gbrjob/unknown-colours-materials.gbrjob', 'gbrjob', 'warning', 'stackup', 'Unrecognised mask colour and dielectric material — must fall back to a default and warn', job(boardFileAttrs, specs2, stackOdd));
  const stackZero = stack2.map((l) => (l.Type === 'Dielectric' ? { ...l, Thickness: 0 } : l.Type === 'Copper' ? { ...l, Thickness: -0.035 } : l));
  add('gbrjob/zero-negative-thickness.gbrjob', 'gbrjob', 'error', 'stackup', 'Zero dielectric and negative copper thickness', job(boardFileAttrs, specs2, stackZero));
  add('gbrjob/missing-referenced-files.gbrjob', 'gbrjob', 'warning', 'stackup', 'References Gerber files that do not exist', job([{ Path: 'does-not-exist.gbr', FileFunction: 'Copper,L1,Top', FilePolarity: 'Positive' }], specs2, stack2));
  add('gbrjob/no-stackup.gbrjob', 'gbrjob', 'warning', 'stackup', 'Valid JSON with GeneralSpecs only — no MaterialStackup (use defaults)', JSON.stringify({ Header: { CreationDate: DATE }, GeneralSpecs: specs2, FilesAttributes: boardFileAttrs }, null, 2) + '\n');
  add('gbrjob/broken-json.gbrjob', 'gbrjob', 'error', 'stackup', 'Truncated / invalid JSON', job(boardFileAttrs, specs2, stack2).slice(0, 400));
}

// ============================================================================
// write
// ============================================================================

const lineOf = (content, token) => {
  if (!token) return undefined;
  const s = Buffer.isBuffer(content) ? content.toString('latin1') : content;
  const i = s.indexOf(token);
  return i < 0 ? undefined : s.slice(0, i).split('\n').length;
};

rmSync(OUT, { recursive: true, force: true });
const manifest = [];
for (const f of fixtures) {
  const p = join(OUT, f.path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, f.content);
  const { content, errorToken, ...meta } = f;
  const size = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content);
  const errorLine = lineOf(content, errorToken);
  manifest.push({ ...meta, ...(errorLine ? { errorLine } : {}), bytes: size });
}
writeFileSync(
  join(OUT, 'manifest.json'),
  JSON.stringify({ generator: 'tools/synth/generate.mjs', version: VERSION, fixtures: manifest }, null, 2) + '\n',
);

const mb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);
const rows = manifest.map((m) => `| \`${m.path}\` | ${m.expect} | ${mb(m.bytes)} | ${m.description.replace(/\|/g, '\\|')}${m.errorLine ? ` (line ${m.errorLine})` : ''} |`);
const total = manifest.reduce((a, m) => a + m.bytes, 0);
writeFileSync(
  join(OUT, 'README.md'),
  `# Synthetic Gerbers

Generated by \`tools/synth/generate.mjs\` — **do not edit by hand** and **do not commit** (gitignored).
Change the generator and run \`node tools/synth/generate.mjs\` (\`npm test\` does this automatically). Output is deterministic.

\`manifest.json\` is the machine-readable version of this table: tests iterate over it.

## Expectations

| expect | meaning |
|--------|---------|
| ok | Valid. Must parse with no errors (informational notices are fine). |
| warning | Must load, but report a warning (deprecated syntax, ambiguous format, suspicious data). |
| error | Must be rejected with a clear message (and the line number when \`errorLine\` is given). Never crash. |
| limit | Resource stress. Must not crash, hang or exhaust memory: handle it within budget, or refuse with a clear message. |

\`facts\` in the manifest give known values (counts, bounds, ladders) for exact assertions.

## Files (${manifest.length} files, ${mb(total)} total)

| file | expect | size | description |
|------|--------|------|-------------|
${rows.join('\n')}
`,
);
writeFileSync(join(OUT, '.stamp'), STAMP + '\n');
console.log(`wrote ${manifest.length} fixtures (${mb(total)}) to ${OUT}`);
