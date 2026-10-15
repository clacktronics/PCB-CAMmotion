import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYNTH, FIXTURES, bytes } from '../../helpers.js';
import { createProject, addSourceFile, buildLayers, SCHEMA_VERSION } from '../../../src/project/project.js';
import { savePcam, loadPcam, PcamError, isPcamName } from '../../../src/project/pcam.js';
import { zipSync, unzipSync, strToU8, strFromU8 } from '../../../vendor/fflate/fflate.js';

const NOW = '2026-10-15T12:00:00.000Z';

function boardProject() {
  const p = createProject('synthetic-board', NOW);
  const sources = new Map();
  const dir = join(SYNTH, 'board');
  for (const f of readdirSync(dir).sort()) addSourceFile(p, sources, f, bytes(join(dir, f)), NOW);
  return { p, sources };
}

test('empty project saves and reloads', () => {
  const p = createProject('empty', NOW);
  const back = loadPcam(savePcam(p, new Map()));
  assert.deepEqual(back.project, p);
  assert.equal(back.sources.size, 0);
});

test('save → load gives an identical project with byte-identical sources', () => {
  const { p, sources } = boardProject();
  buildLayers(p, sources);
  // settings the user changed
  const first = p.sources[0].id;
  p.layers[first].visible = false;
  p.layers[first].opacity = 0.4;
  p.layers[p.sources[1].id].role = { type: 'copper', side: 'bottom' };
  Object.assign(p.view, { side: 'bottom', mode: 'debug', showPaste: true, cx: 12.5, cy: -3, scale: 42 });
  p.stackup.mask = { top: 'Red', bottom: 'Blue' };
  p.stackup.source = 'user';
  const back = loadPcam(savePcam(p, sources));
  assert.deepEqual(back.project, JSON.parse(JSON.stringify(p)));
  assert.equal(back.sources.size, sources.size);
  for (const [id, b] of sources) assert.deepEqual(back.sources.get(id), b, `source ${id} byte-for-byte`);
  // and the rebuilt layers honour the saved settings
  const { layers } = buildLayers(back.project, back.sources);
  const l = layers.find((x) => x.id === p.sources[1].id);
  assert.deepEqual([l.role.type, l.role.side, l.role.source], ['copper', 'bottom', 'user']);
  assert.equal(layers.find((x) => x.id === first).visible, false);
});

test('saving twice gives identical bytes (deterministic)', () => {
  const { p, sources } = boardProject();
  assert.deepEqual(savePcam(p, sources), savePcam(p, sources));
});

test('unknown fields and unknown ZIP entries are kept', () => {
  const { p, sources } = boardProject();
  const z = unzipSync(savePcam(p, sources));
  const manifest = JSON.parse(strFromU8(z['project.json']));
  manifest.futureFeature = { answer: 42 };
  z['project.json'] = strToU8(JSON.stringify(manifest));
  z['cam/future-toolpaths.json'] = strToU8('{"paths":[]}');
  const back = loadPcam(zipSync(z));
  assert.deepEqual(back.project.futureFeature, { answer: 42 });
  const again = unzipSync(savePcam(back.project, back.sources));
  assert.equal(strFromU8(again['cam/future-toolpaths.json']), '{"paths":[]}');
  assert.deepEqual(JSON.parse(strFromU8(again['project.json'])).futureFeature, { answer: 42 });
});

test('layout of the .pcam container', () => {
  const { p, sources } = boardProject();
  const z = unzipSync(savePcam(p, sources));
  for (const f of ['project.json', 'settings/layers.json', 'settings/view.json', 'stackup.json']) assert.ok(z[f], f);
  assert.ok(z['sources/synthetic-board-F_Cu.gbr']);
  assert.equal(JSON.parse(strFromU8(z['project.json'])).schemaVersion, SCHEMA_VERSION);
});

test('schema v1 fixture still loads', () => {
  const { project, sources, migratedFrom } = loadPcam(bytes(join(FIXTURES, 'pcam/schema-v1.pcam')));
  assert.equal(migratedFrom, null);
  assert.equal(project.schemaVersion, 1);
  assert.equal(sources.size, project.sources.length);
  const { layers } = buildLayers(project, sources);
  assert.ok(layers.length >= 3);
});

test('bad files give clear errors', () => {
  assert.throws(() => loadPcam(new Uint8Array([1, 2, 3])), PcamError);
  assert.throws(() => loadPcam(zipSync({ 'a.txt': strToU8('x') })), /project\.json is missing/);
  assert.throws(() => loadPcam(zipSync({ 'project.json': strToU8('{"schemaVersion": 999}') })), /newer version/);
  assert.throws(() => loadPcam(zipSync({ 'project.json': strToU8('{oops') })), /not valid JSON/);
  const missing = {
    'project.json': strToU8(
      JSON.stringify({
        ...createProject('x'),
        layers: undefined,
        sources: [{ id: 's1', name: 'a.gbr', path: 'sources/a.gbr' }],
      }),
    ),
  };
  assert.throws(() => loadPcam(zipSync(missing)), /missing/);
});

test('.pcam names in any case', () => {
  assert.ok(isPcamName('board.pcam') && isPcamName('BOARD.PCAM') && isPcamName('x.PCam'));
  assert.ok(!isPcamName('board.pcam.zip'));
});

test('ZIP archives of Gerbers are expanded into sources; junk is skipped', () => {
  const p = createProject('zip', NOW);
  const sources = new Map();
  const zip = zipSync({
    'gerbers/a-F_Cu.gbr': readFileSync(join(SYNTH, 'board/synthetic-board-F_Cu.gbr')),
    'gerbers/a.drl': readFileSync(join(SYNTH, 'board/synthetic-board-PTH.drl')),
    '__MACOSX/._a-F_Cu.gbr': strToU8('junk'),
    'readme.txt': strToU8('hello'),
  });
  const r = addSourceFile(p, sources, 'board.zip', zip, NOW);
  assert.deepEqual(r.added.map((s) => s.name).sort(), ['a-F_Cu.gbr', 'a.drl']);
  assert.equal(r.skipped.length, 1);
  // duplicate names get a suffix rather than overwriting
  addSourceFile(p, sources, 'a.drl', readFileSync(join(SYNTH, 'board/synthetic-board-PTH.drl')), NOW);
  assert.ok(p.sources.some((s) => s.name === 'a (2).drl'));
});
