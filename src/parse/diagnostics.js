// Diagnostics collected while parsing and interpreting a file.
// Every finding carries a severity, a stable code and (where known) the 1-based source line.

export const ERROR = 'error';
export const WARNING = 'warning';
export const INFO = 'info';

const MAX_ERRORS = 100;

export class Diagnostics {
  constructor() {
    /** @type {{severity:string, code:string, message:string, line?:number, count?:number}[]} */
    this.list = [];
    this.byCode = new Map(); // warning/info dedupe: one entry per code, with a count
    this.errorCount = 0;
  }

  error(code, message, line) {
    this.errorCount++;
    if (this.errorCount > MAX_ERRORS) return;
    if (this.errorCount === MAX_ERRORS) {
      this.list.push({
        severity: ERROR,
        code: 'TOO_MANY_ERRORS',
        message: 'Too many errors; further errors suppressed',
        line,
      });
      return;
    }
    this.list.push({ severity: ERROR, code, message, ...(line ? { line } : {}) });
  }

  /** Warnings with the same code are reported once (first line) with a count. */
  warn(code, message, line) {
    this.#dedupe(WARNING, code, message, line);
  }

  info(code, message, line) {
    this.#dedupe(INFO, code, message, line);
  }

  #dedupe(severity, code, message, line) {
    const key = `${severity}:${code}`;
    const prev = this.byCode.get(key);
    if (prev) {
      prev.count = (prev.count || 1) + 1;
      return;
    }
    const d = { severity, code, message, ...(line ? { line } : {}) };
    this.byCode.set(key, d);
    this.list.push(d);
  }

  get hasErrors() {
    return this.errorCount > 0;
  }

  get errors() {
    return this.list.filter((d) => d.severity === ERROR);
  }

  get warnings() {
    return this.list.filter((d) => d.severity === WARNING);
  }
}
