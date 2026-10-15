#!/usr/bin/env node
// Generates the CAMmotion test board (samples/test-board/): a 2-layer calibration coupon for
// milling, drilling and UV exposure, and a DRC fixture. See samples/test-board/README.md.
//
//   node tools/testboard/generate.mjs           write samples/test-board/
//   node tools/testboard/generate.mjs --out DIR write somewhere else
//
// Unlike the synthetic Gerbers these files ARE committed: they are what gets cut on the
// machines and measured (docs/qa/), so they must not change by accident. Output is
// deterministic; test/unit/samples/test-board.test.js fails if the committed files differ.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REVISION = '1';
const DATE = '2026-10-15T00:00:00+00:00';
const NAME = 'cammotion-test-board';
const here = dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : join(here, '../../samples/test-board');

// ---------- design (all mm, origin = board lower-left) ----------

const BOARD = { w: 80, h: 60 };
const TRACE_WIDTHS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0];
const TRACE_LADDER = { x1: 8, x2: 34, y0: 48, pitch: 3.5, endPad: 1.6 };
const GAPS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6];
const GAP_LADDER = { x0: 41, y1: 34, y2: 46, width: 0.8, spacing: 2.5 };
const DRILLS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0];
const DRILL_LADDER = { x0: 6, y: 8, pitch: 5.5, ringMm: 0.4 };
const ALIGNMENT_HOLES = {
  diaMm: 3.0,
  at: [
    [3, 30],
    [77, 30],
  ],
};
const SMD_ROWS = [
  { x0: 42, y: 15, pitch: 0.5, padW: 0.25, padH: 1.2, n: 12 },
  { x0: 52, y: 15, pitch: 0.65, padW: 0.35, padH: 1.2, n: 8 },
  { x0: 62, y: 15, pitch: 0.8, padW: 0.45, padH: 1.2, n: 8 },
];
const TEXT = [
  { str: 'CAMMOTION', x: 8, y: 52, h: 2.0, stroke: 0.2 },
  { str: 'CAMMOTION', x: 29, y: 52, h: 1.2, stroke: 0.15 },
  { str: 'CAMMOTION', x: 42, y: 52, h: 0.8, stroke: 0.1 },
];
const MASK_EXPANSION = 0.05;

// Stroke font: 4 × 6 unit glyphs, advance 6 units (= text height).
const GLYPHS = {
  A: [
    [
      [0, 0],
      [0, 4],
      [2, 6],
      [4, 4],
      [4, 0],
    ],
    [
      [0, 3],
      [4, 3],
    ],
  ],
  B: [
    [
      [0, 0],
      [0, 6],
      [3, 6],
      [4, 5],
      [4, 4],
      [3, 3],
      [0, 3],
    ],
    [
      [3, 3],
      [4, 2],
      [4, 1],
      [3, 0],
      [0, 0],
    ],
  ],
  C: [
    [
      [4, 5],
      [3, 6],
      [1, 6],
      [0, 5],
      [0, 1],
      [1, 0],
      [3, 0],
      [4, 1],
    ],
  ],
  E: [
    [
      [4, 6],
      [0, 6],
      [0, 0],
      [4, 0],
    ],
    [
      [0, 3],
      [3, 3],
    ],
  ],
  I: [
    [
      [1, 6],
      [3, 6],
    ],
    [
      [2, 6],
      [2, 0],
    ],
    [
      [1, 0],
      [3, 0],
    ],
  ],
  M: [
    [
      [0, 0],
      [0, 6],
      [2, 3],
      [4, 6],
      [4, 0],
    ],
  ],
  N: [
    [
      [0, 0],
      [0, 6],
      [4, 0],
      [4, 6],
    ],
  ],
  O: [
    [
      [1, 0],
      [0, 1],
      [0, 5],
      [1, 6],
      [3, 6],
      [4, 5],
      [4, 1],
      [3, 0],
      [1, 0],
    ],
  ],
  S: [
    [
      [4, 5],
      [3, 6],
      [1, 6],
      [0, 5],
      [0, 4],
      [1, 3],
      [3, 3],
      [4, 2],
      [4, 1],
      [3, 0],
      [1, 0],
      [0, 1],
    ],
  ],
  T: [
    [
      [0, 6],
      [4, 6],
    ],
    [
      [2, 6],
      [2, 0],
    ],
  ],
  ' ': [],
};

/** Stroke polylines for a string; `mirror` flips it for reading from the bottom side. */
function textStrokes({ str, x, y, h }, mirror = false) {
  const u = h / 6;
  const width = (str.length * 6 - 2) * u;
  const out = [];
  [...str].forEach((ch, i) => {
    for (const stroke of GLYPHS[ch]) {
      out.push(
        stroke.map(([gx, gy]) => {
          const px = x + (i * 6 + gx) * u;
          return [mirror ? 2 * x + width - px : px, y + gy * u];
        }),
      );
    }
  });
  return out;
}

// Pads are data, so copper and mask openings come from the same list.
const pads = []; // { side: 'Top'|'Bot'|'Both', ap: [shape, ...sizes], x, y }
DRILLS.forEach((d, i) => {
  pads.push({
    side: 'Both',
    ap: ['C', d + 2 * DRILL_LADDER.ringMm],
    x: DRILL_LADDER.x0 + i * DRILL_LADDER.pitch,
    y: DRILL_LADDER.y,
  });
});
TRACE_WIDTHS.forEach((_, i) => {
  const y = TRACE_LADDER.y0 - i * TRACE_LADDER.pitch;
  pads.push({ side: 'Top', ap: ['C', TRACE_LADDER.endPad], x: TRACE_LADDER.x1, y });
  pads.push({ side: 'Top', ap: ['C', TRACE_LADDER.endPad], x: TRACE_LADDER.x2, y });
});
for (const r of SMD_ROWS) {
  for (let i = 0; i < r.n; i++) pads.push({ side: 'Top', ap: ['R', r.padW, r.padH], x: r.x0 + i * r.pitch, y: r.y });
}
// One pad of every standard aperture type (Gerber spec 4.4) plus a macro (4.5).
const APERTURE_PADS = [
  { ap: ['C', 2.0], x: 43 },
  { ap: ['R', 2.0, 1.2], x: 49 },
  { ap: ['O', 2.4, 1.2], x: 55 },
  { ap: ['P', 2.2, 6], x: 61 },
  { ap: ['RRECT', 2.4, 1.6, 0.4], x: 67 },
];
for (const p of APERTURE_PADS) pads.push({ side: 'Top', ap: p.ap, x: p.x, y: 26 });

const gapPairs = GAPS.map((gap, i) => {
  const prev = GAPS.slice(0, i).reduce((a, g) => a + 2 * GAP_LADDER.width + g + GAP_LADDER.spacing, 0);
  const xa = GAP_LADDER.x0 + prev;
  return { gap, xa, xb: xa + GAP_LADDER.width + gap };
});

// ---------- writers ----------

const n6 = (mm) => String(Math.round(mm * 1e6));
const xy = (x, y) => `X${n6(x)}Y${n6(y)}`;
const num = (v) => String(+v.toFixed(6));

function gerberHeader(fileFunction, polarity = 'Positive') {
  return [
    `G04 ${NAME} rev ${REVISION} - generated by tools/testboard/generate.mjs*`,
    `%TF.GenerationSoftware,CAMmotion,testboard,${REVISION}*%`,
    `%TF.CreationDate,${DATE}*%`,
    `%TF.ProjectId,${NAME},636d7469-6f6e-7465-7374-626f61726401,${REVISION}*%`,
    `%TF.FileFunction,${fileFunction}*%`,
    `%TF.FilePolarity,${polarity}*%`,
    '%FSLAX46Y46*%',
    '%MOMM*%',
    '%LPD*%',
  ];
}

/** Assigns D-codes (from D10, spec 4.3.1) to apertures in first-use order. */
function apertureTable(lines) {
  const codes = new Map();
  let needMacro = false;
  return {
    code(ap, expand = 0) {
      const [shape, ...s] = ap;
      let def;
      if (shape === 'C') def = `C,${num(s[0] + 2 * expand)}`;
      else if (shape === 'R' || shape === 'O') def = `${shape},${num(s[0] + 2 * expand)}X${num(s[1] + 2 * expand)}`;
      else if (shape === 'P') def = `P,${num(s[0] + 2 * expand)}X${s[1]}`;
      else if (shape === 'RRECT') {
        needMacro = true;
        def = `RRECT,${num(s[0] + 2 * expand)}X${num(s[1] + 2 * expand)}X${num(s[2] + expand)}`;
      } else throw new Error(`unknown aperture ${shape}`);
      if (!codes.has(def)) codes.set(def, 10 + codes.size);
      return codes.get(def);
    },
    // Rounded rectangle macro: $1 width, $2 height, $3 corner radius (spec 4.5.1).
    header() {
      const macro = needMacro
        ? [
            '%AMRRECT*',
            '21,1,$1,$2-$3-$3,0,0,0*',
            '21,1,$1-$3-$3,$2,0,0,0*',
            '1,1,$3+$3,$1/2-$3,$2/2-$3*',
            '1,1,$3+$3,-$1/2+$3,$2/2-$3*',
            '1,1,$3+$3,-$1/2+$3,-$2/2+$3*',
            '1,1,$3+$3,$1/2-$3,-$2/2+$3*%',
          ]
        : [];
      return [...macro, ...[...codes].map(([def, code]) => `%ADD${code}${def}*%`)];
    },
    lines,
  };
}

function gerber(fileFunction, draw, polarity) {
  const body = [];
  const apt = apertureTable(body);
  let current = null;
  const use = (ap, expand) => {
    const c = apt.code(ap, expand);
    if (c !== current) body.push(`D${c}*`);
    current = c;
  };
  const api = {
    flash(ap, x, y, expand = 0) {
      use(ap, expand);
      body.push(`${xy(x, y)}D03*`);
    },
    polyline(widthMm, pts) {
      use(['C', widthMm]);
      body.push(`${xy(...pts[0])}D02*`);
      for (const p of pts.slice(1)) body.push(`${xy(...p)}D01*`);
    },
    region(pts) {
      body.push('G36*', `${xy(...pts[0])}D02*`, ...[...pts.slice(1), pts[0]].map((p) => `${xy(...p)}D01*`), 'G37*');
    },
    arc(widthMm, [sx, sy], [ex, ey], [cx, cy]) {
      use(['C', widthMm]);
      body.push('G75*', `${xy(sx, sy)}D02*`, `G03${xy(ex, ey)}I${n6(cx - sx)}J${n6(cy - sy)}D01*`, 'G01*');
    },
  };
  draw(api);
  return [...gerberHeader(fileFunction, polarity), ...apt.header(), ...body, 'M02*'].join('\n') + '\n';
}

const onSide = (side) => pads.filter((p) => p.side === side || p.side === 'Both');

function copper(side) {
  return gerber(side === 'Top' ? 'Copper,L1,Top' : 'Copper,L2,Bot', (g) => {
    for (const p of onSide(side)) g.flash(p.ap, p.x, p.y);
    if (side === 'Top') {
      TRACE_WIDTHS.forEach((w, i) => {
        const y = TRACE_LADDER.y0 - i * TRACE_LADDER.pitch;
        g.polyline(w, [
          [TRACE_LADDER.x1, y],
          [TRACE_LADDER.x2, y],
        ]);
      });
      for (const { xa, xb } of gapPairs) {
        g.polyline(GAP_LADDER.width, [
          [xa, GAP_LADDER.y1],
          [xa, GAP_LADDER.y2],
        ]);
        g.polyline(GAP_LADDER.width, [
          [xb, GAP_LADDER.y1],
          [xb, GAP_LADDER.y2],
        ]);
      }
      for (const t of TEXT) for (const s of textStrokes(t)) g.polyline(t.stroke, s);
      g.region([
        [72, 20],
        [76, 20],
        [76, 24],
        [74, 25.5],
        [72, 24],
      ]); // region (G36) pad
      g.arc(0.3, [44, 20], [40, 20], [42, 20]); // half-circle arc trace (G03)
    } else {
      g.region([
        [40, 34],
        [76, 34],
        [76, 46],
        [40, 46],
      ]); // copper pour under the gap ladder
      for (const s of textStrokes({ str: 'BOTTOM', x: 8, y: 52, h: 2.0 }, true)) g.polyline(0.2, s);
    }
  });
}

// Solder mask files are drawn as openings (FilePolarity Negative, as KiCad writes them).
const mask = (side) =>
  gerber(
    `Soldermask,${side}`,
    (g) => {
      for (const p of onSide(side)) g.flash(p.ap, p.x, p.y, MASK_EXPANSION);
    },
    'Negative',
  );

const silk = () =>
  gerber('Legend,Top', (g) => {
    for (const s of textStrokes({ str: 'TEST', x: 60, y: 51.5, h: 3.0 })) g.polyline(0.25, s);
    g.polyline(0.15, [
      [6, 4.5],
      [70, 4.5],
    ]); // drill ladder baseline
  });

const edge = () =>
  gerber('Profile,NP', (g) => {
    g.polyline(0.1, [
      [0, 0],
      [BOARD.w, 0],
      [BOARD.w, BOARD.h],
      [0, BOARD.h],
      [0, 0],
    ]);
  });

function drill(plated) {
  const fn = plated ? 'Plated,1,2,PTH' : 'NonPlated,1,2,NPTH';
  const lines = [
    'M48',
    `; DRILL file {CAMmotion testboard ${REVISION}} date ${DATE}`,
    '; FORMAT={-:-/ absolute / metric / decimal}',
    `; #@! TF.CreationDate,${DATE}`,
    `; #@! TF.GenerationSoftware,CAMmotion,testboard,${REVISION}`,
    `; #@! TF.FileFunction,${fn}`,
    'FMAT,2',
    'METRIC',
  ];
  const holes = plated
    ? DRILLS.map((d, i) => [d, [[DRILL_LADDER.x0 + i * DRILL_LADDER.pitch, DRILL_LADDER.y]]])
    : [[ALIGNMENT_HOLES.diaMm, ALIGNMENT_HOLES.at]];
  holes.forEach(([d], i) => lines.push(`T${i + 1}C${d.toFixed(3)}`));
  lines.push('%', 'G90', 'G05');
  holes.forEach(([, at], i) => {
    lines.push(`T${i + 1}`);
    for (const [x, y] of at) lines.push(`X${x.toFixed(3)}Y${y.toFixed(3)}`);
  });
  lines.push('T0', 'M30');
  return lines.join('\n') + '\n';
}

const FILES = {
  [`${NAME}-F_Cu.gbr`]: ['Copper,L1,Top', copper('Top')],
  [`${NAME}-B_Cu.gbr`]: ['Copper,L2,Bot', copper('Bot')],
  [`${NAME}-F_Mask.gbr`]: ['Soldermask,Top', mask('Top')],
  [`${NAME}-B_Mask.gbr`]: ['Soldermask,Bot', mask('Bot')],
  [`${NAME}-F_Silkscreen.gbr`]: ['Legend,Top', silk()],
  [`${NAME}-Edge_Cuts.gbr`]: ['Profile,NP', edge()],
  [`${NAME}-PTH.drl`]: ['Plated,1,2,PTH', drill(true)],
  [`${NAME}-NPTH.drl`]: ['NonPlated,1,2,NPTH', drill(false)],
};

// KiCad-style Gerber job file (stackup + file roles).
const job = {
  Header: {
    GenerationSoftware: { Vendor: 'CAMmotion', Application: 'testboard', Version: REVISION },
    CreationDate: DATE,
  },
  GeneralSpecs: {
    ProjectId: { Name: NAME, GUID: '636d7469-6f6e-7465-7374-626f61726401', Revision: REVISION },
    Size: { X: BOARD.w, Y: BOARD.h },
    LayerNumber: 2,
    BoardThickness: 1.6,
    Finish: 'None',
  },
  DesignRules: [{ Layers: 'Outer', PadToPad: 0.1, PadToTrack: 0.1, TrackToTrack: 0.1, MinLineWidth: 0.1 }],
  FilesAttributes: Object.entries(FILES).map(([Path, [FileFunction]]) => ({
    Path,
    FileFunction,
    FilePolarity: FileFunction.startsWith('Soldermask') ? 'Negative' : 'Positive',
  })),
  MaterialStackup: [
    { Type: 'Legend', Color: 'White', Name: 'Top Silk Screen' },
    { Type: 'SolderMask', Color: 'Green', Thickness: 0.01, Name: 'Top Solder Resist' },
    { Type: 'Copper', Thickness: 0.035, Name: 'F.Cu' },
    { Type: 'Dielectric', Thickness: 1.51, Material: 'FR4', Name: 'F.Cu/B.Cu' },
    { Type: 'Copper', Thickness: 0.035, Name: 'B.Cu' },
    { Type: 'SolderMask', Color: 'Green', Thickness: 0.01, Name: 'Bottom Solder Resist' },
  ],
};

// Known feature positions, for DRC tests and for recording measurements (docs/qa/).
const features = {
  board: NAME,
  revision: REVISION,
  units: 'mm',
  boardSize: [BOARD.w, BOARD.h],
  traceLadder: TRACE_WIDTHS.map((width, i) => ({
    width,
    from: [TRACE_LADDER.x1, TRACE_LADDER.y0 - i * TRACE_LADDER.pitch],
    to: [TRACE_LADDER.x2, TRACE_LADDER.y0 - i * TRACE_LADDER.pitch],
    layer: 'F.Cu',
  })),
  gapLadder: gapPairs.map(({ gap, xa, xb }) => ({
    gap,
    traceWidth: GAP_LADDER.width,
    traceX: [+xa.toFixed(6), +xb.toFixed(6)],
    y: [GAP_LADDER.y1, GAP_LADDER.y2],
    layer: 'F.Cu',
  })),
  drillLadder: DRILLS.map((d, i) => ({
    drill: d,
    pad: +(d + 2 * DRILL_LADDER.ringMm).toFixed(6),
    at: [DRILL_LADDER.x0 + i * DRILL_LADDER.pitch, DRILL_LADDER.y],
    plated: true,
  })),
  alignmentHoles: ALIGNMENT_HOLES,
  smdRows: SMD_ROWS.map((r) => ({ ...r, gap: +(r.pitch - r.padW).toFixed(6), layer: 'F.Cu' })),
  aperturePads: APERTURE_PADS.map((p) => ({ aperture: p.ap, at: [p.x, 26], layer: 'F.Cu' })),
  fineText: TEXT.map(({ str, x, y, h, stroke }) => ({ text: str, at: [x, y], height: h, stroke, layer: 'F.Cu' })),
  maskExpansion: MASK_EXPANSION,
};

mkdirSync(OUT, { recursive: true });
for (const [name, [, content]] of Object.entries(FILES)) writeFileSync(join(OUT, name), content);
writeFileSync(join(OUT, `${NAME}-job.gbrjob`), JSON.stringify(job, null, 2) + '\n');
writeFileSync(join(OUT, 'features.json'), JSON.stringify(features, null, 2) + '\n');
console.log(`wrote ${Object.keys(FILES).length + 2} files to ${OUT}`);
