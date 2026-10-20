// A layer being edited: the normalised commands of its source file, the list of edit ops
// applied to them (and the ops undone, for redo). The ops are what the .pcam stores
// (model/edits.json); the edited commands and image are rebuilt from the source by replaying
// them, so the original file in sources/ is never touched (AGENTS.md).
//
// Edit record, per source file:  { base: md5 of the source bytes, ops: [...], redo: [...] }

import { normalizeGerber } from './gerber-normalize.js';
import { writeGerber } from './gerber-writer.js';
import { normalizeExcellon, writeExcellon } from './excellon.js';
import { applyGerberOp, gerberTarget, EditError } from './gerber-ops.js';
import { applyExcellonOp, excellonTarget } from './excellon-ops.js';
import { interpretGerber } from '../model/gerber-image.js';
import { interpretExcellon } from '../model/drill-image.js';
import { Diagnostics } from '../parse/diagnostics.js';
import { md5Hex } from '../parse/md5.js';

export { EditError };

/** Recent states kept in memory so undo does not replay everything (older ones are replayed). */
const KEEP_STATES = 40;

export class LayerEditor {
  /**
   * @param {'gerber'|'excellon'} kind
   * @param {object} parsed parser output (commands, diagnostics; Excellon also units/attributes)
   * @param {{opts?: object}} [options] interpreter options (maxObjects)
   */
  constructor(kind, parsed, options = {}) {
    this.kind = kind;
    this.opts = options.opts || {};
    this.parseDiagnostics = cloneDiagnostics(parsed.diagnostics);
    this.attributes = parsed.attributes || {};
    if (kind === 'gerber') {
      const n = normalizeGerber(parsed.commands);
      this.base = n.commands;
      this.problems = n.problems;
    } else {
      const n = normalizeExcellon(parsed);
      this.base = n.commands;
      this.units = n.units;
      this.problems = n.problems;
    }
    this.ops = [];
    this.redoOps = [];
    this.states = new Map([[0, this.base]]); // ops applied -> commands
    this.selectAfter = [];
    this.#interpret();
  }

  get commands() {
    return this.states.get(this.ops.length);
  }

  get editable() {
    return this.problems.length === 0;
  }

  get canUndo() {
    return this.ops.length > 0;
  }

  get canRedo() {
    return this.redoOps.length > 0;
  }

  /** Object index -> edit target, or { error }. */
  target(oi) {
    return this.kind === 'gerber'
      ? gerberTarget(this.commands, this.image, oi)
      : excellonTarget(this.commands, this.image, oi);
  }

  /** Object indices drawn by the given target commands (for selecting what an op made). */
  objectsOf(targets) {
    const ends = this.image.commandEnds;
    const out = [];
    for (const ci of targets) for (let i = ci > 0 ? ends[ci - 1] : 0; i < ends[ci]; i++) out.push(i);
    return out;
  }

  /**
   * Apply an op (throws EditError and changes nothing when it cannot be done).
   * @returns {number[]} objects the op made or moved
   */
  apply(op) {
    if (!this.editable) throw new EditError(`This file cannot be edited: ${this.problems.join('; ')}`);
    const r = this.#run(this.commands, op, this.image);
    this.ops.push(op);
    this.redoOps = [];
    this.#store(r.commands);
    this.#interpret();
    return this.objectsOf(r.select);
  }

  undo() {
    if (!this.canUndo) return false;
    this.redoOps.push(this.ops.pop());
    this.#rebuildCurrent();
    return true;
  }

  redo() {
    if (!this.canRedo) return [];
    const op = this.redoOps.pop();
    const r = this.#run(this.commands, op, this.image);
    this.ops.push(op);
    this.#store(r.commands);
    this.#interpret();
    return this.objectsOf(r.select);
  }

  /** Replay a stored record (throws EditError if an op no longer applies). */
  load(record) {
    const ops = Array.isArray(record?.ops) ? record.ops : [];
    for (const op of ops) {
      const r = this.#run(this.commands, op, this.image);
      this.ops.push(op);
      this.#store(r.commands);
      this.#interpret();
    }
    this.redoOps = Array.isArray(record?.redo) ? [...record.redo] : [];
  }

  /** The record to store in the project. */
  record(sourceBytes) {
    return { base: md5Hex(sourceBytes), ops: [...this.ops], redo: [...this.redoOps] };
  }

  /** The edited file as text, ready to save. */
  write() {
    const comment = this.ops.length ? 'Edited with PCB-CAMmotion' : undefined;
    return this.kind === 'gerber'
      ? writeGerber(this.commands, { comment })
      : writeExcellon(this.commands, this.units, { comment });
  }

  #run(commands, op, image) {
    return this.kind === 'gerber'
      ? applyGerberOp(commands, op, { image })
      : applyExcellonOp(commands, op, { units: this.units });
  }

  #store(commands) {
    this.states.set(this.ops.length, commands);
    for (const k of [...this.states.keys()]) if (k > this.ops.length) this.states.delete(k);
    const keys = [...this.states.keys()].filter((k) => k !== 0).sort((a, b) => a - b);
    while (keys.length > KEEP_STATES) this.states.delete(keys.shift());
  }

  #rebuildCurrent() {
    const n = this.ops.length;
    if (!this.states.has(n)) {
      let k = Math.max(...[...this.states.keys()].filter((x) => x <= n));
      let cmds = this.states.get(k);
      while (k < n) {
        const img = this.#image(cmds);
        cmds = this.#run(cmds, this.ops[k], img).commands;
        k++;
      }
      this.states.set(n, cmds);
    }
    for (const k of [...this.states.keys()]) if (k > n) this.states.delete(k);
    this.#interpret();
  }

  #image(commands) {
    const diag = cloneDiagnostics(this.parseDiagnostics);
    return this.kind === 'gerber'
      ? interpretGerber({ commands, diagnostics: diag }, this.opts)
      : interpretExcellon({ commands, diagnostics: diag, attributes: this.attributes, units: this.units });
  }

  #interpret() {
    this.image = this.#image(this.commands);
    this.diagnostics = this.image.diagnostics;
  }
}

/** Diagnostics are mutable (interpreting adds to them): copy before each interpretation. */
export function cloneDiagnostics(d) {
  const c = new Diagnostics();
  if (!d) return c;
  for (const e of d.list) {
    const copy = { ...e };
    c.list.push(copy);
    if (e.severity !== 'error') c.byCode.set(`${e.severity}:${e.code}`, copy);
  }
  c.errorCount = d.errorCount;
  return c;
}
