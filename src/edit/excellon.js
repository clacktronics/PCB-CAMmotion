// Excellon editing support: normalise the parsed command list and write it back.
//
// Normalising (as for Gerber, see gerber-normalize.js): every hit, slot and route move gets
// absolute X and Y in mm (modal axes filled in, R repeat codes expanded into the hits they
// make), so single commands can be moved, deleted or inserted. Interpreting the normalised
// list gives the same image.
//
// Writing: a fresh file in the original units with explicit decimal points (no zero
// suppression or implied format to get wrong), in command order: header (M48, units, tool
// definitions with their original parameters, other header settings), body, M30.

const DECIMALS = 6;

/**
 * @param {ReturnType<import('../parse/excellon.js').parseExcellon>} parsed
 * @returns {{commands: object[], units: 'METRIC'|'INCH', problems: string[]}}
 */
export function normalizeExcellon(parsed) {
  const out = [];
  const problems = [];
  const unitsSeen = new Set();
  let x = 0;
  let y = 0;
  for (const c of parsed.commands) {
    switch (c.type) {
      case 'UNITS':
        unitsSeen.add(c.units);
        out.push(c);
        break;
      case 'HIT':
        x = c.x ?? x;
        y = c.y ?? y;
        out.push({ type: 'HIT', x, y, line: c.line });
        break;
      case 'REPEAT':
        for (let k = 0; k < c.count; k++) {
          x += c.dx;
          y += c.dy;
          out.push({ type: 'HIT', x, y, line: c.line });
        }
        break;
      case 'SLOT': {
        const x1 = c.x1 ?? x;
        const y1 = c.y1 ?? y;
        const x2 = c.x2 ?? x1;
        const y2 = c.y2 ?? y1;
        x = x2;
        y = y2;
        out.push({ type: 'SLOT', x1, y1, x2, y2, line: c.line });
        break;
      }
      case 'ROUTE_MOVE':
      case 'ROUTE': {
        x = c.x ?? x;
        y = c.y ?? y;
        const r = { type: c.type, g: c.g, x, y, line: c.line };
        for (const k of ['a', 'i', 'j']) if (c[k] !== undefined) r[k] = c[k];
        out.push(r);
        break;
      }
      case 'MODE':
        break; // G90/G91: written as absolute
      case 'HEADER':
        if (/^ICI/.test(c.text) || c.text === 'G90' || c.text === 'G91') break;
        out.push(c);
        break;
      default:
        out.push(c);
    }
  }
  if (unitsSeen.size > 1) problems.push('the units change in the middle of the file');
  return { commands: out, units: parsed.units === 'INCH' ? 'INCH' : 'METRIC', problems };
}

/**
 * @param {object[]} commands normalised (possibly edited) commands
 * @param {'METRIC'|'INCH'} units
 * @param {{comment?: string}} [opts]
 */
export function writeExcellon(commands, units, opts = {}) {
  const k = units === 'INCH' ? 1 / 25.4 : 1;
  const n = (mm) => fmt(mm * k);
  const xy = (cx, cy) => `X${n(cx)}Y${n(cy)}`;
  const out = [];
  const hasHeader = commands.some((c) => c.type === 'M48');
  if (!hasHeader) out.push('M48', units, '%');
  let unitsWritten = !hasHeader;
  let inHeader = false;
  const writeUnits = () => {
    if (!unitsWritten) out.push(units);
    unitsWritten = true;
  };
  for (const c of commands) {
    switch (c.type) {
      case 'M48':
        out.push('M48');
        if (opts.comment) out.push(`; ${opts.comment}`);
        inHeader = true;
        break;
      case 'HEADER_END':
        writeUnits();
        out.push('%');
        inHeader = false;
        break;
      case 'UNITS':
        writeUnits();
        break;
      case 'COMMENT':
        if (/FILE_FORMAT\s*=/i.test(c.text)) break; // decimal points are written: no format
        out.push(c.text ? `; ${c.text}` : ';');
        break;
      case 'ATTR':
        out.push(`; #@! TF${c.name}${c.values.length ? ',' + c.values.join(',') : ''}`);
        break;
      case 'HEADER':
        out.push(c.text);
        break;
      case 'TOOL_DEF':
        if (inHeader) writeUnits();
        out.push(c.params !== undefined ? `T${c.tool}${c.params}` : `T${c.tool}C${fmt(c.diaMm * k)}`);
        break;
      case 'TOOL':
        out.push(`T${c.tool}`);
        break;
      case 'HIT':
        out.push(xy(c.x, c.y));
        break;
      case 'SLOT':
        out.push(`${xy(c.x1, c.y1)}G85${xy(c.x2, c.y2)}`);
        break;
      case 'ROUTE_MOVE':
        out.push(`G00${xy(c.x, c.y)}`);
        break;
      case 'ROUTE': {
        let s = `G0${c.g}${xy(c.x, c.y)}`;
        if (c.a !== undefined) s += `A${n(c.a)}`;
        if (c.i !== undefined) s += `I${n(c.i)}`;
        if (c.j !== undefined) s += `J${n(c.j)}`;
        out.push(s);
        break;
      }
      case 'PLUNGE':
        out.push('M15');
        break;
      case 'RETRACT':
        out.push('M16');
        break;
      case 'DRILL_MODE':
        out.push('G05');
        break;
      case 'END':
        out.push('M30');
        break;
      default:
        throw new Error(`Cannot write drill command ${c.type}`);
    }
  }
  return out.join('\n') + '\n';
}

function fmt(v) {
  const s = v.toFixed(DECIMALS).replace(/0+$/, '').replace(/\.$/, '.0');
  return s === '-0.0' ? '0.0' : s;
}
