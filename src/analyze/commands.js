// Command inspector: describe each parsed command, and link commands and image objects both
// ways (which objects did a command produce? which command produced an object?).
// Pure functions over the parser output and image.commandEnds (src/model/gerber-image.js).

import { describeAperture, fmtMm } from './apertures.js';

/** Objects command `ci` produced: indices [start, end) into image.objects. */
export function commandObjectRange(image, ci) {
  const ends = image.commandEnds;
  if (!ends || ci < 0 || ci >= ends.length) return [0, 0];
  return [ci > 0 ? ends[ci - 1] : 0, ends[ci]];
}

/** Index of the command that produced object `oi` (binary search), or -1. */
export function objectCommand(image, oi) {
  const ends = image.commandEnds;
  if (!ends || oi < 0 || oi >= image.objects.length) return -1;
  let lo = 0;
  let hi = ends.length - 1;
  if (hi < 0 || ends[hi] <= oi) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ends[mid] > oi) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Commands whose source line is `line` (a line can hold several commands, e.g. G01X…D01*). */
export function commandsAtLine(commands, line) {
  // commands are in source order: binary search the first one at or after `line`
  let lo = 0;
  let hi = commands.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (commands[mid].line < line) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < commands.length && commands[i].line === line; i++) out.push(i);
  return out;
}

/**
 * Coordinate context for decoding Gerber coordinates to mm: the %FS% and %MO% in force at
 * each command. Built once per command list; `scaleAt(i)` is the mm per coordinate count.
 */
export function coordinateContext(commands) {
  const changes = []; // [index, mmPerCount, incremental]
  let dec = 6;
  let unit = 1;
  let incremental = false;
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    if (c.type === 'FS') {
      dec = c.dec;
      incremental = c.notation === 'I';
    } else if (c.type === 'MO') unit = c.unit === 'IN' ? 25.4 : 1;
    else if (c.type === 'NOTATION') incremental = c.notation === 'I';
    else continue;
    changes.push([i, unit / 10 ** dec, incremental]);
  }
  const at = (i) => {
    let lo = 0;
    let hi = changes.length - 1;
    let best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (changes[mid][0] <= i) {
        best = changes[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best;
  };
  return {
    scaleAt: (i) => at(i)?.[1] ?? 1e-6,
    incrementalAt: (i) => at(i)?.[2] ?? false,
  };
}

const G_TEXT = {
  1: 'Linear interpolation (G01)',
  2: 'Clockwise circular interpolation (G02)',
  3: 'Counter-clockwise circular interpolation (G03)',
  36: 'Region start (G36)',
  37: 'Region end (G37): fill the contours',
  74: 'Single-quadrant arc mode (G74, deprecated)',
  75: 'Multi-quadrant arc mode (G75)',
};

const KIND_TEXT = { F: 'flash', L: 'line', A: 'arc', R: 'region' };

/**
 * Describe command i of a layer for the inspector.
 * @param {{kind:string, commands:object[], image:object}} layer
 * @param {number} i
 * @param {ReturnType<typeof coordinateContext>} [ctx]
 * @returns {{code: string, text: string, objects: number}} code = the command in file syntax
 *   (rebuilt from the parsed values), text = what it does, objects = how many it produced
 */
export function describeCommand(layer, i, ctx) {
  const c = layer.commands[i];
  const [a, b] = commandObjectRange(layer.image, i);
  const made = b - a;
  const produced = made
    ? ` → ${made === 1 ? `1 ${KIND_TEXT[layer.image.objects[a].k]}` : `${made.toLocaleString('en')} objects`}`
    : '';
  if (layer.kind === 'excellon')
    return { code: c.raw ?? c.type, text: excellonText(c, layer) + produced, objects: made };
  ctx ??= coordinateContext(layer.commands);
  const { code, text } = gerberText(c, i, ctx, layer.image);
  return { code, text: text + produced, objects: made };
}

function gerberText(c, i, ctx, image) {
  switch (c.type) {
    case 'FS':
      return {
        code: `%FS${c.zero}${c.notation}X${c.int}${c.dec}Y${c.int}${c.dec}*%`,
        text: `Format ${c.int}.${c.dec}, ${c.zero === 'T' ? 'trailing' : 'leading'} zeros omitted, ${c.notation === 'I' ? 'incremental' : 'absolute'}`,
      };
    case 'MO':
      return {
        code: c.deprecated ? (c.unit === 'IN' ? 'G70' : 'G71') : `%MO${c.unit}*%`,
        text: `Units: ${c.unit === 'IN' ? 'inches' : 'millimetres'}`,
      };
    case 'NOTATION':
      return {
        code: c.notation === 'A' ? 'G90' : 'G91',
        text: `${c.notation === 'A' ? 'Absolute' : 'Incremental'} coordinates (deprecated)`,
      };
    case 'AD': {
      const ap = image.apertures.get(c.code);
      const params = c.params.length ? `,${c.params.join('X')}` : '';
      return {
        code: `%ADD${c.code}${c.template}${params}*%`,
        text: `Define aperture D${c.code}${ap && ap.line === c.line ? `: ${describeAperture(ap)}` : ''}`,
      };
    }
    case 'AM': {
      const n = c.body.filter((x) => x.kind === 'primitive').length;
      return { code: `%AM${c.name}*…%`, text: `Define macro ${c.name} (${n} primitive${n === 1 ? '' : 's'})` };
    }
    case 'Dnn': {
      const ap = image.apertures.get(c.code);
      return { code: `D${c.code}`, text: `Select aperture D${c.code}${ap ? ` (${describeAperture(ap)})` : ''}` };
    }
    case 'D':
      return dText(c, i, ctx);
    case 'G':
      return { code: `G${String(c.code).padStart(2, '0')}`, text: G_TEXT[c.code] || `G${c.code}` };
    case 'G04':
      return { code: `G04 ${c.text}`, text: 'Comment' };
    case 'LP':
      return {
        code: `%LP${c.polarity}*%`,
        text: `Polarity ${c.polarity === 'D' ? 'dark: objects add' : 'clear: objects erase'}`,
      };
    case 'LM':
      return { code: `%LM${c.mirror}*%`, text: c.mirror === 'N' ? 'No mirroring' : `Mirror aperture in ${c.mirror}` };
    case 'LR':
      return { code: `%LR${c.deg}*%`, text: `Rotate apertures by ${c.deg}°` };
    case 'LS':
      return { code: `%LS${c.scale}*%`, text: `Scale apertures by ${c.scale}` };
    case 'AB':
      return c.close
        ? { code: '%AB*%', text: 'End aperture block' }
        : { code: `%ABD${c.code}*%`, text: `Start aperture block D${c.code}` };
    case 'SR':
      return c.close
        ? { code: '%SR*%', text: 'End step and repeat: place the copies' }
        : {
            code: `%SRX${c.x}Y${c.y}I${c.i}J${c.j}*%`,
            text: c.x * c.y > 1 ? `Step and repeat ${c.x} × ${c.y}, step ${c.i} × ${c.j}` : 'End step and repeat',
          };
    case 'TF':
    case 'TA':
    case 'TO':
      return {
        code: `%${c.type}${c.name}${c.values.length ? ',' + c.values.join(',') : ''}*%`,
        text: `${{ TF: 'File', TA: 'Aperture', TO: 'Object' }[c.type]} attribute ${c.name}`,
      };
    case 'TD':
      return { code: `%TD${c.name ?? ''}*%`, text: c.name ? `Delete attribute ${c.name}` : 'Delete all attributes' };
    case 'IP':
      return {
        code: `%IP${c.negative ? 'NEG' : 'POS'}*%`,
        text: `Image polarity ${c.negative ? 'negative' : 'positive'} (deprecated)`,
      };
    case 'IN':
    case 'LN':
      return { code: `%${c.type}${c.name}*%`, text: `${c.type === 'IN' ? 'Image' : 'Layer'} name (deprecated)` };
    case 'M02':
      return { code: c.deprecated || 'M02', text: 'End of file' };
    default:
      return { code: `%${c.type}${c.value ?? ''}*%`, text: 'Image setting (deprecated)' };
  }
}

function dText(c, i, ctx) {
  const k = ctx.scaleAt(i);
  const inc = ctx.incrementalAt(i);
  const parts = [];
  let code = c.g ? `G${String(c.g).padStart(2, '0')}` : '';
  for (const ax of ['x', 'y', 'i', 'j']) {
    if (c[ax] === undefined) continue;
    code += `${ax.toUpperCase()}${c[ax]}`;
    parts.push(`${ax.toUpperCase()} ${fmtMm(c[ax] * k)}`);
  }
  if (c.op) code += `D0${c.op}`;
  const where = parts.length ? `${inc ? ' by' : ' to'} ${parts.join(' ')} mm` : '';
  const what = { 0: 'Coordinate (modal D01, deprecated)', 1: 'Interpolate (D01)', 2: 'Move (D02)', 3: 'Flash (D03)' }[
    c.op
  ];
  return { code, text: what + where };
}

function excellonText(c, layer) {
  const xy = () =>
    [c.x !== undefined ? `X ${fmtMm(c.x)}` : '', c.y !== undefined ? `Y ${fmtMm(c.y)}` : ''].filter(Boolean).join(' ');
  switch (c.type) {
    case 'M48':
      return 'Header start';
    case 'HEADER_END':
      return 'Header end';
    case 'UNITS':
      return `Units: ${c.units === 'INCH' ? 'inches' : 'millimetres'}`;
    case 'TOOL_DEF':
      return `Define tool T${c.tool}: ⌀${fmtMm(c.diaMm)} mm`;
    case 'TOOL': {
      if (c.tool === 0) return 'Unload tool';
      const t = layer.image.apertures.get(c.tool);
      return `Select tool T${c.tool}${t ? ` (⌀${fmtMm(t.dia)} mm)` : ''}`;
    }
    case 'HIT':
      return `Drill at ${xy()} mm`;
    case 'REPEAT':
      return `Repeat hole ${c.count}× by ${fmtMm(c.dx)}, ${fmtMm(c.dy)} mm`;
    case 'SLOT':
      return 'Slot (G85)';
    case 'ROUTE_MOVE':
      return `Rapid move (G00) to ${xy()} mm`;
    case 'ROUTE':
      return `Route ${c.g === 1 ? 'line' : c.g === 2 ? 'CW arc' : 'CCW arc'} to ${xy()} mm`;
    case 'PLUNGE':
      return 'Tool down (M15)';
    case 'RETRACT':
      return 'Tool up';
    case 'DRILL_MODE':
      return 'Drill mode';
    case 'MODE':
      return 'Mode';
    case 'END':
      return 'End of program';
    case 'COMMENT':
      return 'Comment';
    case 'ATTR':
      return `Attribute ${c.name}`;
    case 'HEADER':
      return 'Header setting';
  }
  return c.type;
}
