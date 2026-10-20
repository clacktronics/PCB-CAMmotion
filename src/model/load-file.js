// Load one source file into its parsed command list and interpreted image. When the project
// has edits for the file (src/edit/session.js), they are replayed and the layer shows the
// edited commands and image; the source bytes are never changed.

import { parseGerber } from '../parse/gerber.js';
import { parseExcellon } from '../parse/excellon.js';
import { parseGbrjob } from '../parse/gbrjob.js';
import { md5Hex } from '../parse/md5.js';
import { interpretGerber } from './gerber-image.js';
import { interpretExcellon } from './drill-image.js';
import { detectFileKind } from './layers.js';
import { LayerEditor, EditError, cloneDiagnostics } from '../edit/session.js';

/**
 * @param {string} name
 * @param {Uint8Array} bytes
 * @param {{kind?: string, maxObjects?: number, edits?: {base?: string, ops?: object[], redo?: object[]}}} [opts]
 * @returns {{name, kind, commands?, image?, diagnostics, parsed?, editor?, job?}} parsed: the
 *   parser output with its own diagnostics only (to start an editor from); editor: set when
 *   edits were replayed
 */
export function loadFile(name, bytes, opts = {}) {
  const kind = opts.kind || detectFileKind(name, bytes);
  if (kind === 'gerber' || kind === 'excellon') {
    const parsed = kind === 'gerber' ? parseGerber(bytes) : parseExcellon(bytes);
    const parseOnly = { ...parsed, diagnostics: cloneDiagnostics(parsed.diagnostics) };
    const rec = opts.edits;
    let editError = null;
    if (rec && (rec.ops?.length || rec.redo?.length)) {
      if (rec.base && rec.base !== md5Hex(bytes)) {
        editError = 'The saved edits were made on a different version of this file; they are not applied';
      } else {
        try {
          const editor = new LayerEditor(kind, parseOnly, { opts });
          editor.load(rec);
          return {
            name,
            kind,
            commands: editor.commands,
            image: editor.image,
            diagnostics: editor.diagnostics,
            parsed: parseOnly,
            editor,
          };
        } catch (e) {
          if (!(e instanceof EditError)) throw e;
          editError = `The saved edits could not be replayed (${e.message}); they are not applied`;
        }
      }
    }
    const image = kind === 'gerber' ? interpretGerber(parsed, opts) : interpretExcellon(parsed);
    if (editError) parsed.diagnostics.error('EDITS_NOT_APPLIED', editError);
    return { name, kind, commands: parsed.commands, image, diagnostics: parsed.diagnostics, parsed: parseOnly };
  }
  if (kind === 'gbrjob') {
    const parsed = parseGbrjob(bytes);
    return { name, kind, job: parsed, diagnostics: parsed.diagnostics };
  }
  return { name, kind, diagnostics: null };
}
