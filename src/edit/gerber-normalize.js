// Gerber command list -> editable command list (milestone 4).
//
// Editing works on the parsed command model (AGENTS.md: edit/ operates on the command model).
// To make single commands safe to move, delete or insert, the list is first made explicit:
//   - every D01/D02/D03 carries absolute X and Y (modal and incremental coordinates resolved,
//     deprecated modal D01 "coordinate only" words given their D-code, spec 4.2 / 8.1)
//   - interpolation set in a D word (G01X…D01) becomes its own G command, so deleting the
//     draw does not lose the mode change
//   - coordinates are rescaled to 6 decimals (exact integer multiplication), so edits can
//     place points at 1 nm (mm files) or 1 µin (inch files) whatever the original format
//   - G90/G91 (deprecated notation) are dropped: everything is absolute
// The geometry is unchanged: interpreting the normalised list gives the same image
// (tested in test/unit/edit/gerber-roundtrip.test.js).
//
// Coordinates stay integer counts of 10^-6 file units; `line` keeps the source line.

export const EDIT_DEC = 6;

/**
 * @param {object[]} commands from parseGerber
 * @returns {{commands: object[], problems: string[]}} problems: why the file cannot be
 *   edited safely (empty when it can)
 */
export function normalizeGerber(commands) {
  const out = [];
  const problems = [];
  let dec = null; // decimals of the current %FS%
  let notation = 'A';
  let x = 0;
  let y = 0;
  let lastOp = 0;
  let fsCount = 0;
  const units = new Set();
  const scale = () => 10 ** (EDIT_DEC - (dec ?? 6));
  for (const c of commands) {
    switch (c.type) {
      case 'FS':
        fsCount++;
        dec = c.dec;
        notation = c.notation;
        out.push({ type: 'FS', zero: 'L', notation: 'A', int: c.int, dec: EDIT_DEC, line: c.line });
        break;
      case 'NOTATION':
        notation = c.notation;
        break;
      case 'MO':
        units.add(c.unit);
        out.push({ type: 'MO', unit: c.unit, line: c.line });
        break;
      case 'D': {
        if (dec === null && !out.some((o) => o.type === 'FS')) {
          // the parser assumed FSLAX46Y46 for coordinates before any %FS% (MISSING_FS)
          out.unshift({ type: 'FS', zero: 'L', notation: 'A', int: 4, dec: EDIT_DEC, line: c.line });
          dec = 6;
        }
        if (c.g) out.push({ type: 'G', code: c.g, line: c.line });
        let op = c.op;
        if (op === 0) op = lastOp || 1; // same rule as the interpreter
        lastOp = op;
        const k = scale();
        if (notation === 'I') {
          if (c.x !== undefined) x += c.x * k;
          if (c.y !== undefined) y += c.y * k;
        } else {
          if (c.x !== undefined) x = c.x * k;
          if (c.y !== undefined) y = c.y * k;
        }
        const d = { type: 'D', op, x, y, line: c.line };
        if (c.i !== undefined) d.i = c.i * k;
        if (c.j !== undefined) d.j = c.j * k;
        out.push(d);
        break;
      }
      default:
        out.push(c);
    }
  }
  if (fsCount > 1) problems.push('the coordinate format (%FS%) changes in the middle of the file');
  if (units.size > 1) problems.push('the units (%MO%) change in the middle of the file');
  return { commands: out, problems };
}

/** mm per coordinate count in a normalised list (EDIT_DEC decimals) for a file unit. */
export function mmPerCount(unit) {
  return (unit === 'IN' ? 25.4 : 1) / 10 ** EDIT_DEC;
}

/** The file unit of a normalised command list ('MM' when none is given, as the interpreter assumes). */
export function fileUnit(commands) {
  return commands.find((c) => c.type === 'MO')?.unit ?? 'MM';
}
