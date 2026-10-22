// Edits persisted in the .pcam (milestone 4): saved, replayed on load, never touching sources/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { strToU8 } from '../../../vendor/fflate/fflate.js';
import {
  createProject,
  addSourceFile,
  buildLayers,
  removeSource,
  layerEditor,
  commitEdit,
  revertEdits,
  normaliseEdit,
} from '../../../src/project/project.js';
import { saveProject, loadProject } from '../../../src/project/pcam.js';
import { g } from '../../helpers.js';
import { assertSameImage } from '../../helpers/images.js';

const NOW = new Date('2026-10-20T00:00:00Z');
const SRC = strToU8(g('%ADD10C,0.5*%', 'D10*', 'X0Y0D03*', 'X1000000Y0D03*', 'X2000000Y0D03*'));
const DRL = strToU8(['M48', 'METRIC', 'T1C0.8', '%', 'T1', 'X1.0Y1.0', 'X2.0Y1.0', 'M30', ''].join('\n'));

function project() {
  const p = createProject('e', NOW);
  addSourceFile(p, 'top.gbr', SRC, NOW);
  addSourceFile(p, 'holes.drl', DRL, NOW);
  return p;
}

const layer = (layers, name) => layers.find((l) => l.name === name);

test('edits are stored per source, saved in the .pcam and replayed on load', () => {
  const p = project();
  const { layers } = buildLayers(p);
  const top = layer(layers, 'top.gbr');
  const ed = layerEditor(top);
  ed.apply({ type: 'delete', targets: [ed.target(1).ci] });
  ed.apply({ type: 'move', targets: [ed.target(0).ci], dxMm: 0, dyMm: 1 });
  commitEdit(p, top, NOW);
  assert.equal(top.image.objects.length, 2);
  const drl = layer(layers, 'holes.drl');
  const de = layerEditor(drl);
  de.apply({ type: 'addHit', diaMm: 1.2, xMm: 5, yMm: 5 });
  commitEdit(p, drl, NOW);

  const back = loadProject(saveProject(p));
  assert.deepEqual(back.sources.find((s) => s.name === 'top.gbr').bytes, SRC, 'original kept byte for byte');
  const rebuilt = buildLayers(back).layers;
  assertSameImage(top.image, layer(rebuilt, 'top.gbr').image, 'gerber edits replayed');
  assertSameImage(drl.image, layer(rebuilt, 'holes.drl').image, 'drill edits replayed', 1e-9);
  assert.equal(layer(rebuilt, 'holes.drl').image.apertures.get(2).dia, 1.2);
  assert.equal(layer(rebuilt, 'top.gbr').editor.ops.length, 2);
});

test('undoing every edit leaves no record; revert drops the edits', () => {
  const p = project();
  const top = layer(buildLayers(p).layers, 'top.gbr');
  const ed = layerEditor(top);
  ed.apply({ type: 'delete', targets: [ed.target(0).ci] });
  commitEdit(p, top, NOW);
  assert.ok(p.edits['top.gbr']);
  ed.undo();
  commitEdit(p, top, NOW);
  assert.equal(p.edits['top.gbr'].redo.length, 1, 'redo still possible');
  revertEdits(p, top, NOW);
  assert.deepEqual(p.edits, {});
  assert.equal(top.image.objects.length, 3);
});

test('re-importing or removing a file drops its edits; edits on a different file are not applied', () => {
  const p = project();
  const top = layer(buildLayers(p).layers, 'top.gbr');
  const ed = layerEditor(top);
  ed.apply({ type: 'delete', targets: [ed.target(0).ci] });
  commitEdit(p, top, NOW);
  const stale = structuredClone(p.edits['top.gbr']);
  const r = addSourceFile(p, 'top.gbr', SRC, NOW);
  assert.match(r.notes[0], /edits were discarded/);
  assert.deepEqual(p.edits, {});
  // a record whose source checksum does not match is reported, not applied
  p.edits['top.gbr'] = { ...stale, base: '0'.repeat(32) };
  const l = layer(buildLayers(p).layers, 'top.gbr');
  assert.equal(l.image.objects.length, 3);
  assert.ok(l.diagnostics.list.some((d) => d.code === 'EDITS_NOT_APPLIED'));
  removeSource(p, 'top.gbr', NOW);
  assert.deepEqual(p.edits, {});
});

test('the v2 fixture rebuilds with its edits applied', () => {
  const bytes = new Uint8Array(readFileSync(new URL('../../fixtures/pcam/v2-with-edits.pcam', import.meta.url)));
  const l = buildLayers(loadProject(bytes)).layers[0];
  assert.deepEqual(
    l.image.objects.map((o) => [o.k, o.x ?? o.x1, o.y ?? o.y1]),
    [
      ['F', 0.5, 0.5],
      ['F', 5, 0],
      ['F', 2, 2],
    ],
  );
  assert.equal(l.editor.redoOps.length, 1);
});

test('editor settings: defaults filled in, nonsense replaced, saved in the project', () => {
  const p = createProject('s', NOW);
  assert.deepEqual(p.settings.edit, {
    on: false,
    tool: 'select',
    selectMode: 'enclose',
    gridMm: 0.05,
    aperture: { code: null, template: 'C', sizesMm: [0.25, 0.25] },
    holeDiaMm: 0.8,
  });
  assert.deepEqual(
    normaliseEdit({
      on: true,
      tool: 'brush',
      selectMode: 'greedy',
      gridMm: -1,
      aperture: { code: 12, template: 'X', sizesMm: [0, 2] },
      keep: 1,
    }),
    {
      on: true,
      tool: 'select',
      selectMode: 'enclose',
      gridMm: 0.05,
      aperture: { code: 12, template: 'C', sizesMm: [0.25, 2] },
      holeDiaMm: 0.8,
      keep: 1,
    },
  );
  p.settings.edit = normaliseEdit({ on: true, tool: 'track', gridMm: 0 });
  assert.deepEqual(loadProject(saveProject(p)).settings.edit, p.settings.edit);
  // the toolbar's tools and the box/lasso mode
  p.settings.edit = normaliseEdit({ on: true, tool: 'lasso', selectMode: 'touch' });
  assert.equal(p.settings.edit.tool, 'lasso');
  assert.equal(p.settings.edit.selectMode, 'touch');
  assert.deepEqual(loadProject(saveProject(p)).settings.edit, p.settings.edit);
});
