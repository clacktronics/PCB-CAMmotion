// Gerber writer: (normalised, possibly edited) command list -> RS-274X text.
// Input is the output of normalizeGerber (src/edit/gerber-normalize.js): absolute
// coordinates as integer counts, explicit D-codes. Every command type the parser produces is
// written back; the result parses to the same image (round-trip tests in test/unit/edit/).
//
// Not written: %TF.MD5% (the checksum no longer matches once the text changes, spec 5.6.12)
// and macros the parser rejected (writing their remaining body would make apertures appear
// that the original file never drew).

const MAX_INT_DIGITS = 6;

export class GerberWriteError extends Error {}

/**
 * @param {object[]} commands normalised commands
 * @param {{comment?: string}} [opts] comment: a G04 line written first
 * @returns {string}
 */
export function writeGerber(commands, opts = {}) {
  const intDigits = requiredIntDigits(commands);
  const out = opts.comment ? [`G04 ${safeComment(opts.comment)}*`] : [];
  for (const c of commands) {
    const s = writeCommand(c, intDigits);
    if (s !== null) out.push(s);
  }
  return out.join('\n') + '\n';
}

/** Integer digits each %FS% needs so every following coordinate fits (spec 4.2.2). */
function requiredIntDigits(commands) {
  const need = new Map(); // FS command -> digits
  let fs = null;
  let max = 0;
  const flush = () => {
    if (!fs) return;
    const intPart = Math.floor(max / 10 ** fs.dec);
    const digits = Math.max(fs.int, intPart > 0 ? String(intPart).length : 1);
    if (digits > MAX_INT_DIGITS || digits + fs.dec > 12)
      throw new GerberWriteError('A coordinate is too large for the Gerber coordinate format');
    need.set(fs, digits);
  };
  for (const c of commands) {
    if (c.type === 'FS') {
      flush();
      fs = c;
      max = 0;
    } else if (c.type === 'D') {
      for (const ax of ['x', 'y', 'i', 'j']) {
        const v = c[ax];
        if (v === undefined) continue;
        if (!Number.isInteger(v))
          throw new GerberWriteError(`Coordinate ${ax.toUpperCase()}=${v} is not an integer count`);
        if (Math.abs(v) > max) max = Math.abs(v);
      }
    }
  }
  flush();
  return need;
}

function writeCommand(c, intDigits) {
  switch (c.type) {
    case 'FS': {
      const n = intDigits.get(c) ?? c.int;
      return `%FS${c.zero === 'T' ? 'T' : 'L'}${c.notation}X${n}${c.dec}Y${n}${c.dec}*%`;
    }
    case 'MO':
      return `%MO${c.unit}*%`;
    case 'NOTATION':
      return c.notation === 'I' ? 'G91*' : 'G90*';
    case 'AD':
      return `%ADD${c.code}${c.template}${c.params.length ? ',' + c.params.map(num).join('X') : ''}*%`;
    case 'AM':
      if (!c.ok) return null;
      return `%AM${c.name}*\n${c.body.map((b) => (b.kind === 'comment' ? `0 ${b.text}` : b.text) + '*').join('\n')}%`;
    case 'Dnn':
      return `D${c.code}*`;
    case 'D': {
      let s = '';
      if (c.x !== undefined) s += `X${c.x}`;
      if (c.y !== undefined) s += `Y${c.y}`;
      if (c.i !== undefined) s += `I${c.i}`;
      if (c.j !== undefined) s += `J${c.j}`;
      return `${s}D0${c.op || 1}*`;
    }
    case 'G':
      return `G${String(c.code).padStart(2, '0')}*`;
    case 'G04':
      return c.text ? `G04 ${safeComment(c.text)}*` : 'G04*';
    case 'LP':
      return `%LP${c.polarity}*%`;
    case 'LM':
      return `%LM${c.mirror}*%`;
    case 'LR':
      return `%LR${num(c.deg)}*%`;
    case 'LS':
      return `%LS${num(c.scale)}*%`;
    case 'AB':
      return c.close ? '%AB*%' : `%ABD${c.code}*%`;
    case 'SR':
      return c.close ? '%SR*%' : `%SRX${c.x}Y${c.y}I${num(c.i)}J${num(c.j)}*%`;
    case 'TF':
    case 'TA':
    case 'TO':
      if (c.type === 'TF' && c.name === '.MD5') return null;
      return `%${c.type}${[c.name, ...c.values].map(escapeAttr).join(',')}*%`;
    case 'TD':
      return `%TD${c.name ?? ''}*%`;
    case 'IP':
      return `%IP${c.negative ? 'NEG' : 'POS'}*%`;
    case 'IN':
    case 'LN':
      return `%${c.type}${c.name}*%`;
    case 'AS':
    case 'OF':
    case 'SF':
    case 'MI':
    case 'IR':
      return `%${c.type}${c.value}*%`;
    case 'M02':
      return 'M02*';
    default:
      throw new GerberWriteError(`Cannot write command type ${c.type}`);
  }
}

/** A decimal number without exponent notation (AD parameters, SR steps, LR/LS). */
export function num(v) {
  if (!Number.isFinite(v)) throw new GerberWriteError(`Invalid number ${v}`);
  let s = String(v);
  if (/e/i.test(s)) s = v.toFixed(15).replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** Attribute fields: characters the syntax reserves are written as \uXXXX (spec 5.2). */
function escapeAttr(s) {
  return String(s).replace(
    /[%*,\\\u0000-\u001f\u007f]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

function safeComment(t) {
  return String(t).replace(/[%*\r\n]/g, ' ');
}
