import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SYNTH, bytes } from '../../helpers.js';
import { createProject, addSourceFile, buildLayers, removeSource } from '../../../src/project/project.js';

function load(dir, filter = () => true) {
  const p = createProject('t');
  const sources = new Map();
  for (const f of readdirSync(dir).filter(filter).sort()) addSourceFile(p, sources, f, bytes(join(dir, f)));
  return { p, sources, ...buildLayers(p, sources) };
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
  const profile = layers.find((l) => l.role.type === 'profile');
  assert.equal(profile.outline.loops.length, 2);
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
  const { p, sources } = load(join(SYNTH, 'board'));
  p.stackup.mask = { top: 'Red', bottom: 'Red' };
  p.stackup.source = 'user';
  buildLayers(p, sources);
  assert.equal(p.stackup.mask.top, 'Red');
});

test('removing a source removes its settings', () => {
  const { p, sources } = load(join(SYNTH, 'board'));
  const id = p.sources[0].id;
  removeSource(p, sources, id);
  assert.ok(!p.layers[id] && !sources.has(id) && !p.sources.find((s) => s.id === id));
});
