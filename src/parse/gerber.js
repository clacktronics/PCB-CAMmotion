// Gerber (RS-274X / X2) parser: bytes -> command list with source line numbers.
// Spec references are to the Ucamco "Gerber Layer Format Specification" (2023.08).
//
// The parser is purely syntactic plus coordinate decoding (which needs the %FS% format).
// Graphics state (apertures, current point, regions, blocks ...) is handled by
// src/model/gerber-image.js, which turns the command list into graphical objects.

import { Diagnostics } from './diagnostics.js';
import { decodeText } from './text.js';
import { compileExpr, MacroExprError } from './macro-expr.js';
import { md5Hex } from './md5.js';

/**
 * @typedef {object} GerberCommand
 * @property {string} type
 * @property {number} line 1-based source line where the word starts
 */

const PRIMITIVES = new Set([1, 2, 4, 5, 6, 7, 20, 21, 22]);
const DEPRECATED_PRIMITIVES = { 2: 'vector line 2 (use 20)', 22: 'lower-left line 22', 6: 'moiré 6' };
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const COORD_RE = /^(?:X([+-]?\d+))?(?:Y([+-]?\d+))?(?:I([+-]?\d+))?(?:J([+-]?\d+))?(?:D0*([123]))?$/;

/**
 * Parse a Gerber file.
 * @param {Uint8Array|string} input
 * @returns {{commands: GerberCommand[], diagnostics: Diagnostics, text: string|null}}
 */
export function parseGerber(input) {
  const diag = new Diagnostics();
  const commands = [];
  const text = decodeText(input, diag);
  if (text === null) return { commands, diagnostics: diag, text };
  if (!text.trim()) {
    diag.error('EMPTY', text.length ? 'File contains only whitespace' : 'File is empty', 1);
    return { commands, diagnostics: diag, text };
  }
  if (/^\s*M48\b/.test(text)) {
    diag.error('WRONG_FORMAT', 'This looks like an Excellon drill file, not a Gerber file', 1);
    return { commands, diagnostics: diag, text };
  }
  const p = new Parser(text, commands, diag);
  p.run();
  if (!p.seenEnd && !diag.hasErrors) diag.warn('NO_M02', 'File does not end with M02 (truncated?)', p.lastLine);
  if (p.md5) checkMd5(text, input, p.md5, diag);
  return { commands, diagnostics: diag, text };
}

class Parser {
  constructor(text, commands, diag) {
    this.text = text;
    this.commands = commands;
    this.diag = diag;
    this.fs = null; // { zero:'L'|'T', notation:'A'|'I', int, dec }
    this.fsDefaulted = false;
    this.seenEnd = false;
    this.lastLine = 1;
    this.md5 = null;
  }

  run() {
    const s = this.text;
    const n = s.length;
    let line = 1;
    let wordStart = -1; // index of first non-blank char of the current word
    let wordLine = 1;
    let inExt = false;
    let extLine = 0;
    let extWords = null;
    let strayWs = 0;
    let afterEnd = false;
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      if (c === 10) {
        line++;
        continue;
      }
      if (c === 13) continue;
      if (c === 42) {
        // '*' ends a word
        const word = wordStart < 0 ? '' : clean(s.slice(wordStart, i));
        if (afterEnd && !inExt && word) {
          this.diag.warn('DATA_AFTER_M02', 'Data after M02 end-of-file ignored', wordLine);
        } else if (inExt) extWords.push({ text: word, line: wordStart < 0 ? line : wordLine });
        else if (word) {
          this.word(word, wordLine);
          if (this.seenEnd) afterEnd = true;
        } else this.diag.warn('EMPTY_WORD', 'Empty data block "*"', line);
        wordStart = -1;
        continue;
      }
      if (c === 37) {
        // '%' opens/closes an extended command
        if (inExt) {
          if (wordStart >= 0) {
            const rest = clean(s.slice(wordStart, i));
            if (rest) {
              this.diag.error(
                'MISSING_ASTERISK',
                `Extended command word "${trunc(rest)}" not terminated by "*"`,
                wordLine,
              );
              extWords.push({ text: rest, line: wordLine, bad: true });
            }
          }
          if (!afterEnd) this.extended(extWords, extLine);
          inExt = false;
          wordStart = -1;
        } else {
          if (wordStart >= 0) {
            const w = clean(s.slice(wordStart, i));
            if (w) this.diag.error('MISSING_ASTERISK', `Word "${trunc(w)}" not terminated by "*"`, wordLine);
          }
          inExt = true;
          extLine = line;
          extWords = [];
          wordStart = -1;
        }
        continue;
      }
      if (wordStart < 0) {
        if (c === 32 || c === 9 || c === 12) {
          strayWs++;
          continue;
        }
        wordStart = i;
        wordLine = line;
      }
    }
    this.lastLine = line;
    if (inExt) {
      this.diag.error(
        'UNTERMINATED_EXTENDED',
        `Extended command starting at line ${extLine} is never closed with "%" (file truncated?)`,
        extLine,
      );
    } else if (wordStart >= 0) {
      const w = clean(s.slice(wordStart));
      if (w)
        this.diag.error(
          'TRUNCATED',
          `File ends inside the word "${trunc(w)}" (missing "*"; file truncated?)`,
          wordLine,
        );
    }
    if (strayWs) this.diag.warn('WHITESPACE', 'Spaces or tabs between commands (ignored)', undefined);
  }

  push(cmd) {
    this.commands.push(cmd);
  }

  // ---------- ordinary (function code) words ----------

  word(w, line) {
    const c0 = w.charCodeAt(0);
    if (c0 === 88 || c0 === 89 || c0 === 73 || c0 === 74 || c0 === 68) {
      // X Y I J D
      if (c0 === 68) {
        const m = /^D0*(\d+)$/.exec(w);
        if (m) {
          const code = Number(m[1]);
          if (code >= 10) return this.push({ type: 'Dnn', code, line });
          if (code >= 1 && code <= 3) return this.push({ type: 'D', op: code, line });
          return this.diag.error('UNKNOWN_DCODE', `Invalid D-code "${trunc(w)}" (D04–D09 are reserved)`, line);
        }
      }
      return this.coord(w, line, 0);
    }
    if (c0 === 71) return this.gword(w, line);
    if (c0 === 77) {
      const m = /^M0*(\d+)$/.exec(w);
      const code = m ? Number(m[1]) : -1;
      if (code === 2) {
        this.seenEnd = true;
        return this.push({ type: 'M02', line });
      }
      if (code === 0 || code === 1) {
        this.diag.warn('DEPRECATED_M00', `M0${code} is deprecated; treated as end of file`, line);
        this.seenEnd = true;
        return this.push({ type: 'M02', line, deprecated: `M0${code}` });
      }
      return this.diag.error('UNKNOWN_COMMAND', `Unknown command "${trunc(w)}"`, line);
    }
    if (/^%?(FS|MO|AD|AM)/.test(w)) {
      return this.diag.error('MISSING_PERCENT', `Extended command "${trunc(w)}" outside %…% delimiters`, line);
    }
    return this.diag.error('UNKNOWN_COMMAND', `Unknown command "${trunc(w)}"`, line);
  }

  gword(w, line) {
    if (/^G0*4(?![0-9])/.test(w)) return this.push({ type: 'G04', text: w.replace(/^G0*4 ?/, ''), line });
    const m = /^G0*(\d+)(.*)$/.exec(w);
    if (!m) return this.diag.error('UNKNOWN_COMMAND', `Unknown command "${trunc(w)}"`, line);
    const code = Number(m[1]);
    const rest = m[2];
    switch (code) {
      case 1:
      case 2:
      case 3:
        this.push({ type: 'G', code, line });
        if (rest) this.coord(rest, line, code);
        return;
      case 36:
      case 37:
      case 74:
      case 75:
        if (rest) return this.diag.error('SYNTAX', `Unexpected data after G${code}: "${trunc(rest)}"`, line);
        return this.push({ type: 'G', code, line });
      case 54: {
        this.diag.warn('DEPRECATED_G54', 'G54 before an aperture selection is deprecated', line);
        if (!rest) return;
        return this.word(rest, line);
      }
      case 55:
        this.diag.warn('DEPRECATED_G55', 'G55 (prepare for flash) is deprecated', line);
        if (rest) this.coord(rest, line, 0);
        return;
      case 70:
      case 71:
        this.diag.warn('DEPRECATED_G70_G71', `G${code} (set units) is deprecated; use %MO…%`, line);
        return this.push({ type: 'MO', unit: code === 70 ? 'IN' : 'MM', line, deprecated: true });
      case 90:
      case 91:
        this.diag.warn('DEPRECATED_G90_G91', `G${code} (absolute/incremental) is deprecated; use %FS…%`, line);
        return this.push({ type: 'NOTATION', notation: code === 90 ? 'A' : 'I', line });
      default:
        return this.diag.error('UNKNOWN_COMMAND', `Unknown or unsupported G-code G${code}`, line);
    }
  }

  coord(w, line, gcode) {
    const m = COORD_RE.exec(w);
    if (!m || w === '') {
      if (/[.eE]|NaN|Inf/.test(w))
        return this.diag.error('BAD_NUMBER', `Invalid coordinate number in "${trunc(w)}"`, line);
      return this.diag.error('SYNTAX', `Malformed coordinate data "${trunc(w)}"`, line);
    }
    if (m[1] === undefined && m[2] === undefined && m[3] === undefined && m[4] === undefined && m[5] === undefined) {
      return this.diag.error('SYNTAX', `Malformed data "${trunc(w)}"`, line);
    }
    if (!this.fs) {
      if (!this.fsDefaulted) {
        this.diag.error('MISSING_FS', 'Coordinate data before the %FS…% format statement (assuming FSLAX46Y46)', line);
        this.fsDefaulted = true;
      }
      this.fs = { zero: 'L', notation: 'A', int: 4, dec: 6, defaulted: true };
    }
    const cmd = { type: 'D', op: m[5] ? Number(m[5]) : 0, line };
    if (gcode) cmd.g = gcode;
    if (m[1] !== undefined && (cmd.x = this.num(m[1], line)) === null) return;
    if (m[2] !== undefined && (cmd.y = this.num(m[2], line)) === null) return;
    if (m[3] !== undefined && (cmd.i = this.num(m[3], line)) === null) return;
    if (m[4] !== undefined && (cmd.j = this.num(m[4], line)) === null) return;
    this.push(cmd);
  }

  /** Decode a coordinate number into an integer count of 10^-dec file units (spec 4.2.2). */
  num(s, line) {
    const fs = this.fs;
    let sign = 1;
    let digits = s;
    if (s[0] === '+' || s[0] === '-') {
      if (s[0] === '-') sign = -1;
      digits = s.slice(1);
    }
    const total = fs.int + fs.dec;
    if (digits.length > total) {
      this.diag.error(
        'COORD_OVERFLOW',
        `Coordinate "${trunc(s)}" has more digits than the format allows (${fs.int}.${fs.dec})`,
        line,
      );
      return null;
    }
    if (fs.zero === 'T') digits = digits.padEnd(total, '0');
    return sign * Number(digits);
  }

  // ---------- extended commands %…% ----------

  extended(words, extLine) {
    if (!words.length) return this.diag.warn('EMPTY_EXTENDED', 'Empty %% extended command', extLine);
    if (words[0].text.startsWith('AM')) return this.macro(words);
    for (const w of words) {
      if (w.bad) continue;
      if (!w.text) continue;
      this.ext(w.text, w.line);
    }
  }

  ext(w, line) {
    const code = w.slice(0, 2);
    switch (code) {
      case 'FS':
        return this.fsCmd(w, line);
      case 'MO':
        if (w === 'MOMM' || w === 'MOIN') return this.push({ type: 'MO', unit: w.slice(2), line });
        return this.diag.error('BAD_MO', `Invalid unit "${trunc(w)}" (must be MOMM or MOIN)`, line);
      case 'AD':
        return this.adCmd(w, line);
      case 'AB': {
        if (w === 'AB') return this.push({ type: 'AB', close: true, line });
        const m = /^ABD(\d+)$/.exec(w);
        if (!m) return this.diag.error('SYNTAX', `Malformed aperture block "${trunc(w)}"`, line);
        const c = Number(m[1]);
        if (c < 10)
          return this.diag.error('BAD_DCODE', `Aperture block code D${m[1]} is reserved (must be ≥ 10)`, line);
        return this.push({ type: 'AB', code: c, line });
      }
      case 'SR': {
        if (w === 'SR') return this.push({ type: 'SR', close: true, line });
        const m = /^SR(?:X(\d+))?(?:Y(\d+))?(?:I([^JIXY]+))?(?:J([^JIXY]+))?$/.exec(w);
        if (!m || (m[3] && !NUMBER_RE.test(m[3])) || (m[4] && !NUMBER_RE.test(m[4]))) {
          return this.diag.error('SYNTAX', `Malformed step and repeat "${trunc(w)}"`, line);
        }
        const x = m[1] ? Number(m[1]) : 1;
        const y = m[2] ? Number(m[2]) : 1;
        if (x < 1 || y < 1) return this.diag.error('BAD_SR', 'Step and repeat counts must be ≥ 1', line);
        return this.push({ type: 'SR', x, y, i: m[3] ? Number(m[3]) : 0, j: m[4] ? Number(m[4]) : 0, line });
      }
      case 'LP':
        if (w === 'LPD' || w === 'LPC') return this.push({ type: 'LP', polarity: w[2], line });
        return this.diag.error('BAD_POLARITY', `Invalid polarity "${trunc(w)}" (must be LPD or LPC)`, line);
      case 'LM': {
        const v = w.slice(2);
        if (v === 'N' || v === 'X' || v === 'Y' || v === 'XY') return this.push({ type: 'LM', mirror: v, line });
        return this.diag.error('SYNTAX', `Invalid mirroring "${trunc(w)}"`, line);
      }
      case 'LR':
      case 'LS': {
        const v = w.slice(2);
        if (!NUMBER_RE.test(v)) return this.diag.error('BAD_NUMBER', `Invalid number in "${trunc(w)}"`, line);
        if (code === 'LS' && Number(v) <= 0) return this.diag.error('BAD_SCALE', 'Scale factor must be > 0', line);
        return this.push(code === 'LR' ? { type: 'LR', deg: Number(v), line } : { type: 'LS', scale: Number(v), line });
      }
      case 'TF':
      case 'TA':
      case 'TO':
        return this.attr(code, w.slice(2), line);
      case 'TD': {
        const name = w.slice(2);
        return this.push({ type: 'TD', name: name || null, line });
      }
      case 'IP':
        this.diag.warn('DEPRECATED_IP', '%IP…% (image polarity) is deprecated', line);
        if (w === 'IPPOS' || w === 'IPNEG') return this.push({ type: 'IP', negative: w === 'IPNEG', line });
        return this.diag.error('SYNTAX', `Invalid image polarity "${trunc(w)}"`, line);
      case 'IN':
      case 'LN':
        this.diag.warn('DEPRECATED_' + code, `%${code}…% (image/layer name) is deprecated`, line);
        return this.push({ type: code, name: w.slice(2), line });
      case 'AS':
      case 'OF':
      case 'SF':
      case 'MI':
      case 'IR':
        return this.deprecatedImage(code, w, line);
      default:
        return this.diag.error('UNKNOWN_EXTENDED', `Unknown extended command "%${trunc(w)}*%"`, line);
    }
  }

  deprecatedImage(code, w, line) {
    this.diag.warn('DEPRECATED_' + code, `%${code}…% is deprecated`, line);
    const isDefault =
      (code === 'AS' && w === 'ASAXBY') ||
      (code === 'OF' && /^OF(A[+-]?0*\.?0*)?(B[+-]?0*\.?0*)?$/.test(w)) ||
      (code === 'SF' && /^SF(A0*1(\.0*)?)?(B0*1(\.0*)?)?$/.test(w)) ||
      (code === 'MI' && /^MI(A0)?(B0)?$/.test(w)) ||
      (code === 'IR' && /^IR0*$/.test(w));
    if (!isDefault)
      this.diag.warn(
        'IMAGE_TRANSFORM_IGNORED',
        `Non-default deprecated image transform "%${trunc(w)}*%" is not applied`,
        line,
      );
    this.push({ type: code, value: w.slice(2), line });
  }

  fsCmd(w, line) {
    const m = /^FS([LTD])([AI])(?:N\d)?(?:G\d)?X(\d)(\d)Y(\d)(\d)(?:D\d)?(?:M\d)?$/.exec(w);
    if (!m) return this.diag.error('BAD_FS', `Malformed format statement "%${trunc(w)}*%"`, line);
    const [, zero, notation, xi, xd, yi, yd] = m;
    if (xi !== yi || xd !== yd)
      return this.diag.error('BAD_FS', `X and Y formats differ in "%${w}*%" (not allowed)`, line);
    const int = Number(xi);
    const dec = Number(xd);
    if (int > 6 || dec > 6 || int + dec === 0) {
      return this.diag.error(
        'BAD_FS',
        `Invalid coordinate format ${int}.${dec} (max 6 integer and 6 decimal digits)`,
        line,
      );
    }
    if (zero === 'T')
      this.diag.warn('DEPRECATED_TRAILING_ZEROS', 'Trailing zero omission (%FST…%) is deprecated', line);
    if (notation === 'I')
      this.diag.warn('DEPRECATED_INCREMENTAL', 'Incremental coordinate notation (%FS…I…%) is deprecated', line);
    if (this.fs && !this.fs.defaulted) this.diag.warn('FS_REDEFINED', 'Format statement given more than once', line);
    this.fs = { zero: zero === 'T' ? 'T' : 'L', notation, int, dec };
    this.push({ type: 'FS', zero: this.fs.zero, notation, int, dec, line });
  }

  adCmd(w, line) {
    const m = /^ADD(\d+)([._A-Za-z$][._A-Za-z0-9$-]*)(?:,(.*))?$/.exec(w);
    if (!m) return this.diag.error('BAD_AD', `Malformed aperture definition "%${trunc(w)}*%"`, line);
    const code = Number(m[1]);
    if (code < 10) return this.diag.error('BAD_DCODE', `Aperture code D${m[1]} is reserved (codes must be ≥ 10)`, line);
    const template = m[2];
    const params = [];
    if (m[3] !== undefined) {
      for (const p of m[3].split('X')) {
        if (!NUMBER_RE.test(p)) {
          return this.diag.error('BAD_NUMBER', `Invalid aperture parameter "${trunc(p)}" in D${code}`, line);
        }
        params.push(Number(p));
      }
    }
    this.push({ type: 'AD', code, template, params, line });
  }

  macro(words) {
    const head = words[0];
    const name = head.text.slice(2);
    if (!/^[._A-Za-z$][._A-Za-z0-9$-]*$/.test(name)) {
      return this.diag.error('BAD_AM', `Invalid macro name "${trunc(name)}"`, head.line);
    }
    const body = [];
    let ok = true;
    for (const w of words.slice(1)) {
      const t = w.text;
      if (!t) continue;
      if (w.bad) {
        ok = false;
        continue;
      }
      if (/^0(?![\d.])/.test(t)) {
        body.push({ kind: 'comment', text: t.replace(/^0 ?/, ''), line: w.line });
        continue;
      }
      try {
        const v = /^\$(\d+)\s*=(.*)$/.exec(t);
        if (v) {
          body.push({ kind: 'var', n: Number(v[1]), expr: compileExpr(v[2]), line: w.line, text: t });
          continue;
        }
        const parts = t.split(',');
        if (!/^\d+$/.test(parts[0].trim())) throw new MacroExprError(`Invalid primitive "${trunc(t)}"`);
        const code = Number(parts[0]);
        if (!PRIMITIVES.has(code)) {
          ok = false;
          this.diag.error('BAD_PRIMITIVE', `Unknown macro primitive code ${code} in macro ${name}`, w.line);
          continue;
        }
        if (DEPRECATED_PRIMITIVES[code]) {
          this.diag.warn('DEPRECATED_PRIMITIVE', `Deprecated macro primitive ${DEPRECATED_PRIMITIVES[code]}`, w.line);
        }
        body.push({ kind: 'primitive', code, exprs: parts.slice(1).map((e) => compileExpr(e)), line: w.line, text: t });
      } catch (e) {
        if (!(e instanceof MacroExprError)) throw e;
        ok = false;
        this.diag.error('BAD_MACRO_EXPR', `Macro ${name}: ${e.message}`, w.line);
      }
    }
    this.push({ type: 'AM', name, body, ok, line: head.line });
  }

  attr(kind, rest, line) {
    const parts = splitAttr(rest);
    const name = parts[0];
    if (!name || !/^[._A-Za-z$][._A-Za-z0-9$]*$/.test(name) || name === '.') {
      this.diag.warn('BAD_ATTRIBUTE', `Malformed attribute "%${kind}${trunc(rest)}*%" ignored`, line);
      return;
    }
    const values = parts.slice(1);
    if (['.N', '.P', '.C', '.FileFunction', '.AperFunction', '.Part'].includes(name) && !values.length) {
      this.diag.warn('BAD_ATTRIBUTE', `Attribute ${name} has no value`, line);
    }
    if (kind === 'TF' && name === '.MD5') this.md5 = { value: values[0] || '', line };
    this.push({ type: kind, name, values, line });
  }
}

/** Split attribute fields on commas and decode \uXXXX escapes (spec 5.2). */
function splitAttr(s) {
  return s.split(',').map((f) => f.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
}

function clean(w) {
  // line breaks are not part of words; leading/trailing blanks are stray whitespace
  return (w.indexOf('\n') >= 0 || w.indexOf('\r') >= 0 ? w.replace(/[\r\n]/g, '') : w).trim();
}

function trunc(s) {
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

function checkMd5(text, input, md5, diag) {
  // Spec 5.6.12: MD5 over the file up to the .MD5 attribute, with CR and LF removed.
  const idx = text.indexOf('%TF.MD5');
  if (idx < 0) return;
  const bytes = new TextEncoder().encode(text.slice(0, idx).replace(/[\r\n]/g, ''));
  if (md5Hex(bytes) !== md5.value.toLowerCase()) {
    diag.warn(
      'MD5_MISMATCH',
      'File MD5 checksum (%TF.MD5%) does not match the file contents (file modified or corrupted?)',
      md5.line,
    );
  }
}
