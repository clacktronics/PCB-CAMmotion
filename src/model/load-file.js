// Load one source file into its parsed command list and interpreted image.

import { parseGerber } from '../parse/gerber.js';
import { parseExcellon } from '../parse/excellon.js';
import { parseGbrjob } from '../parse/gbrjob.js';
import { interpretGerber } from './gerber-image.js';
import { interpretExcellon } from './drill-image.js';
import { detectFileKind } from './layers.js';

/**
 * @param {string} name
 * @param {Uint8Array} bytes
 * @param {{kind?: string, maxObjects?: number}} [opts]
 */
export function loadFile(name, bytes, opts = {}) {
  const kind = opts.kind || detectFileKind(name, bytes);
  if (kind === 'gerber') {
    const parsed = parseGerber(bytes);
    const image = interpretGerber(parsed, opts);
    return { name, kind, commands: parsed.commands, image, diagnostics: parsed.diagnostics };
  }
  if (kind === 'excellon') {
    const parsed = parseExcellon(bytes);
    const image = interpretExcellon(parsed);
    return { name, kind, commands: parsed.commands, image, diagnostics: parsed.diagnostics };
  }
  if (kind === 'gbrjob') {
    const parsed = parseGbrjob(bytes);
    return { name, kind, job: parsed, diagnostics: parsed.diagnostics };
  }
  return { name, kind, diagnostics: null };
}
