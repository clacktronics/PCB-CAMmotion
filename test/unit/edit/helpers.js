// Helpers for edit tests: an editor for Gerber or drill text, and a write → re-read check.
import assert from 'node:assert/strict';
import { parseGerber } from '../../../src/parse/gerber.js';
import { parseExcellon } from '../../../src/parse/excellon.js';
import { LayerEditor } from '../../../src/edit/session.js';
import { gerber, drill } from '../../helpers.js';
import { assertSameImage } from '../../helpers/images.js';

export function gerberEditor(text) {
  return new LayerEditor('gerber', parseGerber(text));
}

export function drillEditor(text) {
  return new LayerEditor('excellon', parseExcellon(text));
}

/** The edited file, written and parsed again, has exactly the editor's image and no errors. */
export function assertWritesBack(ed, label = 'edited') {
  const text = ed.write();
  const back = ed.kind === 'gerber' ? gerber(text) : drill(text);
  assert.deepEqual(
    back.diag.errors.map((d) => d.message),
    [],
    `${label}: errors in written file`,
  );
  assertSameImage(ed.image, back.image, label, ed.kind === 'gerber' ? 1e-7 : 1e-6);
  return { text, back };
}
