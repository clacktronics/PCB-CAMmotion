import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYNTH, FIXTURES, SAMPLES, bytes } from '../../helpers.js';
import {
  createProject,
  addSourceFile,
  buildLayers,
  removeSource,
  ensureSettings,
  normaliseSolo,
} from '../../../src/project/project.js';
import { saveProject, loadProject } from '../../../src/project/pcam.js';
import { zipSync, unzipSync, strToU8, strFromU8 } from '../../../vendor/fflate/fflate.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');

function load(dir, filter = () => true) {
  const p = createProject('t', NOW);
  for (const f of readdirSync(dir).filter(filter).sort()) addSourceFile(p, f, bytes(join(dir, f)), NOW);
  return { p, ...buildLayers(p) };
}

test('synthetic board: every layer identified from the .gbrjob and the stackup applied', () => {
  const { layers, p, job } = load(join(SYNTH, 'board'));
  assert.equal(layers.length, 10);
  assert.ok(layers.every((l) => l.role.source === 'gbrjob'));
  assert.deepEqual(
    layers.map((l) => `${l.role.type}:${l.role.side}`),
    [
      'legend:top',
      'paste:top',
      'soldermask:top',
      'copper:top',
      'copper:bottom',
      'soldermask:bottom',
      'legend:bottom',
      'profile:all',
      'drill:all',
      'drill:all',
    ],
  );
  assert.deepEqual(job.diagnostics.list, []);
  assert.equal(p.stackup.finish, 'ENIG');
  assert.equal(p.stackup.source, 'gbrjob');
  assert.equal(layers.find((l) => l.role.type === 'profile').outline.loops.length, 2);
  assert.equal(layers.find((l) => l.name.includes('NPTH')).role.plated, false);
});

test('without the job file, X2 attributes identify the layers', () => {
  const { layers } = load(join(SYNTH, 'board'), (f) => !f.endsWith('.gbrjob'));
  assert.ok(
    layers.every((l) => l.role.source === 'x2'),
    layers.map((l) => `${l.name}:${l.role.source}`).join(),
  );
});

test('a user edit to the stackup is not overwritten by the job file', () => {
  const { p } = load(join(SYNTH, 'board'));
  p.stackup = { ...p.stackup, mask: { top: 'Red', bottom: 'Red' }, source: 'user' };
  buildLayers(p);
  assert.equal(p.stackup.mask.top, 'Red');
});

test('removing a source removes its settings', () => {
  const { p } = load(join(SYNTH, 'board'));
  const name = p.sources[0].name;
  removeSource(p, name);
  assert.ok(!p.settings.layers[name] && !p.sources.find((s) => s.name === name));
});

test('viewer settings and layer overrides survive save → load (in settings/project.json)', () => {
  const { p } = load(join(SYNTH, 'board'));
  const first = p.sources[0].name;
  p.settings.layers[first].opacity = 0.4;
  p.settings.layers[p.sources[1].name].role = { type: 'copper', side: 'bottom' };
  Object.assign(p.settings.view, {
    side: 'bottom',
    mode: 'xor',
    background: 'light',
    solo: [first],
    activeLayer: first,
    show: { legend: false, soldermask: true, paste: true, copper: true, drill: false },
    cx: 12.5,
    cy: -3,
    scale: 42,
    view3d: true,
    explode: 0.35,
    explodeStyle: 'layers',
    camera3d: { position: [10, -60, 80], target: [40, 30, 0] },
    autoSelectLayer: false,
  });
  p.settings.analyze = {
    open: false,
    tab: 'commands',
    highlight: { layer: first, code: 10 },
    playback: { layer: first, step: 7, by: 'object', speed: 100 },
  };
  p.settings.layers[first].colour = '#123456';
  p.settings.layers[first].invert = true;
  p.stackup = { ...p.stackup, mask: { top: 'Red', bottom: 'Blue' }, source: 'user' };
  const z = unzipSync(saveProject(p));
  assert.ok(JSON.parse(strFromU8(z['settings/project.json'])).view.mode === 'xor');
  const back = ensureSettings(loadProject(saveProject(p)));
  assert.deepEqual(back.settings, p.settings);
  assert.deepEqual(back.stackup, p.stackup);
  for (const s of p.sources)
    assert.deepEqual(back.sources.find((b) => b.name === s.name).bytes, s.bytes, `${s.name} byte-for-byte`);
  const { layers } = buildLayers(back);
  const l = layers.find((x) => x.id === p.sources[1].name);
  assert.deepEqual([l.role.type, l.role.side, l.role.source], ['copper', 'bottom', 'user']);
  const f = layers.find((x) => x.id === first);
  assert.deepEqual([f.visible, f.colour, f.invert], [true, '#123456', true]);
});

test('layer group toggles: defaults for older files; the old showPaste flag becomes show.paste', () => {
  const p = ensureSettings(loadProject(bytes(join(FIXTURES, 'pcam', 'v1-with-source.pcam'))));
  assert.deepEqual(p.settings.view.show, { legend: true, soldermask: true, paste: false, copper: true, drill: true });
  p.settings.view.show = undefined;
  p.settings.view.showPaste = true;
  ensureSettings(p);
  assert.equal(p.settings.view.show.paste, true);
  assert.ok(!('showPaste' in p.settings.view), 'old flag removed');
  const back = ensureSettings(loadProject(saveProject(p)));
  assert.deepEqual(back.settings.view.show, p.settings.view.show);
});

test('3D view settings: defaults for older files, explode kept within 0..1', () => {
  const p = ensureSettings(loadProject(bytes(join(FIXTURES, 'pcam', 'v1-with-source.pcam'))));
  assert.deepEqual(
    [p.settings.view.view3d, p.settings.view.explode, p.settings.view.explodeStyle, p.settings.view.camera3d],
    [false, 0, 'sheets', null],
  );
  p.settings.view.explodeStyle = 'sideways';
  assert.equal(ensureSettings(p).settings.view.explodeStyle, 'sheets', 'unknown style falls back');
  for (const [given, want] of [
    [2, 1],
    [-1, 0],
    ['x', 0],
    [0.5, 0.5],
  ]) {
    p.settings.view.explode = given;
    assert.equal(ensureSettings(p).settings.view.explode, want, String(given));
  }
});

test('auto select layer: on for older files, kept as a boolean', () => {
  const p = ensureSettings(loadProject(bytes(join(FIXTURES, 'pcam', 'v1-with-source.pcam'))));
  assert.equal(p.settings.view.autoSelectLayer, true);
  p.settings.view.autoSelectLayer = 'no';
  assert.equal(ensureSettings(p).settings.view.autoSelectLayer, true, 'nonsense falls back to on');
  p.settings.view.autoSelectLayer = false;
  const back = ensureSettings(loadProject(saveProject(p)));
  assert.equal(back.settings.view.autoSelectLayer, false);
});

test('analyser settings: defaults for older files, bad values replaced', () => {
  const p = ensureSettings(loadProject(bytes(join(FIXTURES, 'pcam', 'v1-with-source.pcam'))));
  assert.deepEqual(p.settings.analyze, {
    open: true,
    tab: 'apertures',
    highlight: null,
    playback: { layer: null, step: null, by: 'command', speed: 20 },
  });
  p.settings.analyze = {
    open: 'yes',
    tab: 'nope',
    highlight: { layer: 3, code: 'x' },
    playback: { layer: 'a.gbr', step: -2, by: 'pixel', speed: 7 },
    future: 1,
  };
  const a = ensureSettings(p).settings.analyze;
  assert.deepEqual(a, {
    open: true,
    tab: 'apertures',
    highlight: null,
    playback: { layer: null, step: null, by: 'command', speed: 20 },
    future: 1, // unknown fields are kept
  });
  p.settings.analyze.highlight = { layer: 'a.gbr', code: null }; // regions
  assert.deepEqual(ensureSettings(p).settings.analyze.highlight, { layer: 'a.gbr', code: null });
});

test('removing a source clears its analyser highlight and playback', () => {
  const { p } = load(join(SYNTH, 'board'));
  const name = p.sources[0].name;
  p.settings.analyze.highlight = { layer: name, code: 10 };
  p.settings.analyze.playback = { layer: name, step: 3, by: 'command', speed: 20 };
  removeSource(p, name);
  assert.equal(p.settings.analyze.highlight, null);
  assert.deepEqual([p.settings.analyze.playback.layer, p.settings.analyze.playback.step], [null, null]);
});

test('schema-1 projects from milestone 0 (no viewer settings) load into the viewer', () => {
  for (const f of ['v1-empty.pcam', 'v1-with-source.pcam']) {
    const p = ensureSettings(loadProject(bytes(join(FIXTURES, 'pcam', f))));
    assert.equal(p.settings.view.side, 'top');
    const { layers } = buildLayers(p);
    assert.equal(layers.length, p.sources.length);
  }
});

test('ZIP archives of Gerbers are expanded into sources; junk is skipped; re-import replaces', () => {
  const p = createProject('zip', NOW);
  const zip = zipSync({
    'gerbers/a-F_Cu.gbr': readFileSync(join(SYNTH, 'board/synthetic-board-F_Cu.gbr')),
    'gerbers/a.drl': readFileSync(join(SYNTH, 'board/synthetic-board-PTH.drl')),
    '__MACOSX/._a-F_Cu.gbr': strToU8('junk'),
    'readme.txt': strToU8('hello'),
  });
  const r = addSourceFile(p, 'board.zip', zip, NOW);
  assert.deepEqual(r.added.sort(), ['a-F_Cu.gbr', 'a.drl']);
  assert.equal(r.skipped.length, 1);
  addSourceFile(p, 'a.drl', readFileSync(join(SYNTH, 'board/synthetic-board-NPTH.drl')), NOW);
  assert.equal(p.sources.filter((s) => s.name === 'a.drl').length, 1);
  assert.equal(p.sources.length, 2);
});

test('the CAMmotion test board loads cleanly and every layer is identified from its job file', () => {
  const { layers, job } = load(join(SAMPLES, 'test-board'), (f) => /\.(gbr|drl|gbrjob)$/.test(f));
  assert.ok(layers.length >= 7);
  assert.deepEqual(job.diagnostics.errors, []);
  for (const l of layers) {
    assert.deepEqual(l.diagnostics.errors, [], l.name);
    assert.equal(l.role.source, 'gbrjob', l.name);
    assert.notEqual(l.role.type, 'other', l.name);
  }
});

test('solo: the old single-solo boolean converts to a list; removed sources leave the solo', () => {
  assert.deepEqual(normaliseSolo(true, 'a.gbr'), ['a.gbr']);
  assert.deepEqual(normaliseSolo(false, 'a.gbr'), []);
  assert.deepEqual(normaliseSolo(undefined), []);
  assert.deepEqual(normaliseSolo(['a', 'a', 3, 'b']), ['a', 'b']);
  const { p } = load(join(SYNTH, 'board'));
  p.settings.view.solo = true;
  p.settings.view.activeLayer = p.sources[0].name;
  ensureSettings(p);
  assert.deepEqual(p.settings.view.solo, [p.sources[0].name]);
  removeSource(p, p.sources[0].name);
  assert.deepEqual(p.settings.view.solo, []);
});
