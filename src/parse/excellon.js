// Excellon / IPC-NC-349 drill file parser: bytes -> command list with source line numbers.
// Coordinates are decoded (format, zero suppression, units) here because those settings are
// modal and may change mid-file; every command keeps its raw text for round-tripping.
// Values in commands are in mm.

import { Diagnostics } from './diagnostics.js';
import { decodeText } from './text.js';

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const INT_RE = /^[+-]?\d+$/;

/**
 * @param {Uint8Array|string} input
 * @returns {{commands: any[], diagnostics: Diagnostics, attributes: Record<string,string[]>, units: string|null}}
 */
export function parseExcellon(input) {
  const diag = new Diagnostics();
  const commands = [];
  const out = { commands, diagnostics: diag, attributes: {}, units: null, format: null };
  const text = decodeText(input, diag);
  if (text === null) return out;
  if (!text.trim()) {
    diag.error('EMPTY', 'File is empty', 1);
    return out;
  }
  new ExcellonParser(text, out).run();
  return out;
}

class ExcellonParser {
  constructor(text, out) {
    this.lines = text.split('\n');
    this.out = out;
    this.diag = out.diagnostics;
    this.cmds = out.commands;
    this.inHeader = false;
    this.seenHeader = false;
    this.units = null; // 'METRIC' | 'INCH'
    this.unitsGuessed = false;
    this.zeros = null; // 'LZ' (leading zeros kept) | 'TZ' (trailing zeros kept)
    this.format = null; // { int, dec, explicit }
    this.formatWarned = false;
    this.incremental = false;
    this.x = 0;
    this.y = 0;
    this.ended = false;
    this.toolDefs = new Map();
  }

  run() {
    const lines = this.lines;
    let first = true;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].replace(/\r$/, '');
      const s = raw.trim();
      const line = i + 1;
      if (!s) continue;
      if (first) {
        first = false;
        if (/^(G04|%FS|%MO|%TF|%AD)/.test(s)) {
          this.diag.error('WRONG_FORMAT', 'This looks like a Gerber file, not an Excellon drill file', line);
          return;
        }
      }
      if (s === 'M48' && !this.ended) {
        // Eagle writes "INCH,TZ" and "%" before M48: a header may start anywhere
        this.inHeader = true;
        this.seenHeader = true;
        this.cmds.push({ type: 'M48', line, raw });
        continue;
      }
      if (this.ended) {
        if (s[0] !== ';') this.diag.warn('DATA_AFTER_END', 'Data after M30 end of program ignored', line);
        continue;
      }
      if (s[0] === ';') {
        this.comment(s.slice(1).trim(), line, raw);
        continue;
      }
      if (this.inHeader) this.header(s.toUpperCase(), line, raw);
      else this.body(s.toUpperCase(), line, raw);
    }
    if (!this.seenHeader) this.diag.warn('NO_HEADER', 'Drill file has no M48 header', 1);
    if (this.inHeader) this.diag.error('HEADER_NOT_TERMINATED', 'Header (M48) never terminated with % or M95', 1);
    if (!this.ended) this.diag.warn('NO_M30', 'Drill file does not end with M30 (truncated?)', lines.length);
    if (!this.units) this.guessUnits();
    this.out.units = this.units;
    this.out.format = this.format;
  }

  guessUnits() {
    // No METRIC/INCH: guess from tool sizes (inch tools are rarely above 0.25)
    let max = 0;
    for (const t of this.toolDefs.values()) max = Math.max(max, t.raw);
    this.units = max > 0 && max < 0.25 ? 'INCH' : 'METRIC';
    this.unitsGuessed = true;
    this.diag.warn(
      'UNITS_GUESSED',
      `No METRIC/INCH declaration: assuming ${this.units === 'INCH' ? 'inches' : 'millimetres'}`,
      1,
    );
    // tool sizes were provisionally stored in mm: rescale if inch
    if (this.units === 'INCH') for (const c of this.cmds) if (c.type === 'TOOL_DEF') c.diaMm = c.rawDia * 25.4;
  }

  comment(text, line, raw) {
    const attr = /^#@!\s*(T[FAO])\.([^,]+)(?:,(.*))?$/.exec(text);
    if (attr) {
      const values = attr[3] !== undefined ? attr[3].split(',') : [];
      this.out.attributes['.' + attr[2]] = values;
      this.cmds.push({ type: 'ATTR', name: '.' + attr[2], values, line, raw });
      return;
    }
    const ff = /FILE_FORMAT\s*=\s*(\d):(\d)/i.exec(text);
    if (ff) this.format = { int: Number(ff[1]), dec: Number(ff[2]), explicit: true };
    this.cmds.push({ type: 'COMMENT', text, line, raw });
  }

  get mmPerUnit() {
    return this.units === 'INCH' ? 25.4 : 1;
  }

  setUnits(u, line) {
    if (this.units && this.units !== u && !this.inHeader) {
      this.diag.warn('UNITS_CHANGED', `Units changed to ${u} in the middle of the file`, line);
    }
    this.units = u;
  }

  header(s, line, raw) {
    if (s === '%' || s === 'M95') {
      this.inHeader = false;
      this.cmds.push({ type: 'HEADER_END', line, raw });
      return;
    }
    const u = /^(METRIC|INCH)(?:,(.*))?$/.exec(s);
    if (u) {
      this.setUnits(u[1], line);
      for (const opt of (u[2] || '').split(',')) {
        if (opt === 'LZ' || opt === 'TZ') this.zeros = opt;
        const f = /^(0*)\.(0*)$/.exec(opt);
        if (f) this.format = { int: f[1].length, dec: f[2].length, explicit: true };
      }
      this.cmds.push({ type: 'UNITS', units: u[1], zeros: this.zeros, line, raw });
      return;
    }
    if (s === 'M71' || s === 'M72') {
      this.setUnits(s === 'M71' ? 'METRIC' : 'INCH', line);
      this.cmds.push({ type: 'UNITS', units: this.units, line, raw });
      return;
    }
    const t = /^T(\d+)(.*)$/.exec(s);
    if (t) {
      if (!/C/.test(t[2])) {
        // a bare tool select in the header: the header was probably not terminated
        this.pendingTool = { n: Number(t[1]), line };
        return;
      }
      return this.toolDef(Number(t[1]), t[2], line, raw);
    }
    if (/^[XYR]/.test(s) || /^G0[0-5]/.test(s)) {
      this.diag.error(
        'HEADER_NOT_TERMINATED',
        'Drill data inside the header: M48 header not terminated with % or M95',
        line,
      );
      this.inHeader = false;
      if (this.pendingTool) this.select(this.pendingTool.n, this.pendingTool.line, '');
      return this.body(s, line, raw);
    }
    if (
      /^(FMAT|VER|DETECT|ATC|OFF|ON|AFS|BLKD|CCW|CP|DN|DTMDIST|DTMDIST|EXDA|FSB|HPCK|NCSL|OM48|OSTOP|OTCLMP|PCKPARAM|PF|PPR|PVS|R,|RC|RD|RO|RT|SBK|SG|SIXM|TCST|UP|LOG)/.test(
        s,
      )
    ) {
      this.cmds.push({ type: 'HEADER', text: s, line, raw });
      return;
    }
    if (/^ICI,ON/.test(s)) {
      this.incremental = true;
      this.diag.warn('INCREMENTAL', 'Incremental input (ICI,ON) is rarely used; check the result', line);
      this.cmds.push({ type: 'HEADER', text: s, line, raw });
      return;
    }
    if (/^ICI/.test(s) || s === 'G90' || s === 'G91') {
      if (s === 'G91') this.incremental = true;
      this.cmds.push({ type: 'HEADER', text: s, line, raw });
      return;
    }
    this.diag.warn('UNKNOWN_HEADER', `Unknown header command "${trunc(s)}" ignored`, line);
  }

  toolDef(n, params, line, raw) {
    const m = /C([+-]?[\d.]+)/.exec(params);
    const dia = m && NUM_RE.test(m[1]) ? Number(m[1]) : NaN;
    if (!Number.isFinite(dia)) {
      this.diag.error('BAD_TOOL', `Tool T${n} has an invalid diameter`, line);
      return;
    }
    if (dia <= 0) {
      this.diag.error('BAD_TOOL', `Tool T${n} has a ${dia === 0 ? 'zero' : 'negative'} diameter`, line);
      return;
    }
    const prev = this.toolDefs.get(n);
    if (prev && prev.raw !== dia) {
      this.diag.warn('TOOL_REDEFINED', `Tool T${n} redefined (${prev.raw} → ${dia}); using the last definition`, line);
    }
    this.toolDefs.set(n, { raw: dia, line });
    const unitsKnown = !!this.units;
    this.cmds.push({
      type: 'TOOL_DEF',
      tool: n,
      rawDia: dia,
      diaMm: dia * (unitsKnown ? this.mmPerUnit : 1),
      params,
      line,
      raw,
    });
  }

  select(n, line, raw) {
    this.cmds.push({ type: 'TOOL', tool: n, line, raw });
  }

  body(s, line, raw) {
    if (s === 'M30' || s === 'M00') {
      this.ended = true;
      this.cmds.push({ type: 'END', line, raw });
      return;
    }
    if (s === '%') return; // rewind stop
    if (/^(METRIC|INCH)(,|$)/.test(s)) return this.header(s, line, raw);
    if (s === 'M71' || s === 'M72') {
      this.setUnits(s === 'M71' ? 'METRIC' : 'INCH', line);
      this.cmds.push({ type: 'UNITS', units: this.units, line, raw });
      return;
    }
    let m = /^T(\d+)(.*)$/.exec(s);
    if (m) {
      const n = Number(m[1]);
      if (/C/.test(m[2])) {
        this.diag.warn('TOOL_IN_BODY', `Tool T${n} defined in the body instead of the header`, line);
        this.toolDef(n, m[2], line, raw);
      }
      this.select(n, line, raw);
      return;
    }
    if (s === 'G90' || s === 'G91') {
      this.incremental = s === 'G91';
      if (this.incremental)
        this.diag.warn('INCREMENTAL', 'Incremental coordinates (G91) are rarely used; check the result', line);
      this.cmds.push({ type: 'MODE', text: s, line, raw });
      return;
    }
    if (s === 'G05' || s === 'G81') return this.cmds.push({ type: 'DRILL_MODE', line, raw });
    if (s === 'M15') return this.cmds.push({ type: 'PLUNGE', line, raw });
    if (s === 'M16' || s === 'M17') return this.cmds.push({ type: 'RETRACT', line, raw });
    if (
      /^M(47|97|98|25|01|02|06|08|09|50|51|52|60)\b/.test(s) ||
      /^G(93|32|33|34|35|36|37|38|39|40|41|42|45|46|47|48|82|83|84|87|90|91)\b/.test(s)
    ) {
      this.diag.warn('UNSUPPORTED', `Unsupported Excellon command "${trunc(s)}" ignored`, line);
      return;
    }
    m = /^R(\d+)(.*)$/.exec(s);
    if (m) {
      this.diag.warn('REPEAT_CODE', 'R repeat codes are rarely supported by other tools; check the hole pattern', line);
      const c = this.coords(m[2], line, true);
      if (!c) return;
      this.cmds.push({ type: 'REPEAT', count: Number(m[1]), dx: c.x ?? 0, dy: c.y ?? 0, line, raw });
      return;
    }
    m = /^G0?([0-3])(.*)$/.exec(s);
    if (m) {
      const g = Number(m[1]);
      const c = this.coords(m[2], line);
      if (!c) return;
      this.cmds.push({ type: g === 0 ? 'ROUTE_MOVE' : 'ROUTE', g, ...c, line, raw });
      return;
    }
    if (/^[XY]/.test(s)) {
      const g85 = s.indexOf('G85');
      if (g85 >= 0) {
        const a = this.coords(s.slice(0, g85), line);
        if (!a) return;
        const b = this.coords(s.slice(g85 + 3), line);
        if (!b) return;
        this.cmds.push({ type: 'SLOT', x1: a.x, y1: a.y, x2: b.x, y2: b.y, line, raw });
        return;
      }
      const c = this.coords(s, line);
      if (!c) return;
      this.cmds.push({ type: 'HIT', ...c, line, raw });
      return;
    }
    this.diag.error('UNKNOWN_COMMAND', `Unknown drill command "${trunc(s)}"`, line);
  }

  /** Parse X/Y/A/I/J words. Missing axes stay undefined (modal). Returns null on error. */
  coords(s, line, relative = false) {
    const m = /^(?:X([^XYAIJ]*))?(?:Y([^XYAIJ]*))?(?:A([^XYAIJ]*))?(?:I([^XYAIJ]*))?(?:J([^XYAIJ]*))?$/.exec(s);
    if (!m) {
      this.diag.error('BAD_COORDINATE', `Malformed coordinates "${trunc(s)}"`, line);
      return null;
    }
    const res = {};
    const keys = ['x', 'y', 'a', 'i', 'j'];
    for (let k = 0; k < 5; k++) {
      if (m[k + 1] === undefined) continue;
      const v = this.num(m[k + 1], line);
      if (v === null) return null;
      res[keys[k]] = v;
    }
    if (!relative && this.incremental) {
      if (res.x !== undefined) res.x += this.x;
      if (res.y !== undefined) res.y += this.y;
    }
    if (!relative) {
      if (res.x !== undefined) this.x = res.x;
      if (res.y !== undefined) this.y = res.y;
    }
    return res;
  }

  num(t, line) {
    if (!this.units) this.guessUnitsEarly(line);
    if (t.includes('.')) {
      if (!NUM_RE.test(t)) {
        this.diag.error('BAD_COORDINATE', `Invalid number "${trunc(t)}"`, line);
        return null;
      }
      return Number(t) * this.mmPerUnit;
    }
    if (!INT_RE.test(t)) {
      this.diag.error('BAD_COORDINATE', `Invalid number "${trunc(t)}"`, line);
      return null;
    }
    // implied decimal point (spec: IPC-NC-349 number format)
    let fmt = this.format;
    if (!fmt || !fmt.explicit) {
      fmt = this.units === 'INCH' ? { int: 2, dec: 4 } : { int: 3, dec: 3 };
      if (!this.formatWarned) {
        this.formatWarned = true;
        this.diag.warn(
          'FORMAT_ASSUMED',
          `Coordinates without decimal point and no explicit number format: assuming ${fmt.int}.${fmt.dec}${this.zeros ? ` ${this.zeros}` : ''}`,
          line,
        );
      }
    }
    const neg = t[0] === '-';
    let digits = t.replace(/^[+-]/, '');
    let zeros = this.zeros;
    if (!zeros) {
      zeros = 'TZ';
      if (!this.zerosWarned) {
        this.zerosWarned = true;
        this.diag.warn('ZEROS_ASSUMED', 'No LZ/TZ zero suppression given: assuming leading zeros are omitted', line);
      }
    }
    if (zeros === 'LZ' && digits.length < fmt.int + fmt.dec) digits = digits.padEnd(fmt.int + fmt.dec, '0');
    const v = Number(digits) / 10 ** fmt.dec;
    return (neg ? -v : v) * this.mmPerUnit;
  }

  guessUnitsEarly(line) {
    void line;
    this.guessUnits();
  }
}

function trunc(s) {
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}
