import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { bytes, SYNTH, codes, synthFixture } from '../../helpers.js';
import { parseGbrjob, resolveJobFiles } from '../../../src/parse/gbrjob.js';

const job = (p) => parseGbrjob(bytes(join(SYNTH, p)));

test('synthetic board job: specs, stackup and file functions', () => {
  const j = job('board/synthetic-board-job.gbrjob');
  const facts = synthFixture('board/synthetic-board-job.gbrjob').facts;
  assert.deepEqual(j.diagnostics.list, []);
  assert.deepEqual(j.stackup.sizeMm, facts.boardSizeMm);
  assert.equal(j.stackup.boardThicknessMm, facts.thicknessMm);
  assert.equal(j.stackup.finish, facts.finish);
  assert.equal(j.stackup.mask.top, facts.mask);
  assert.equal(j.stackup.silk.bottom, facts.silk);
  assert.equal(j.stackup.substrate, 'FR4');
  assert.equal(j.stackup.layers.filter((l) => l.type === 'Copper').length, facts.layers);
  assert.equal(j.files.find((f) => f.path.endsWith('F_Mask.gbr')).filePolarity, 'Negative');
});

test('four-layer stackup with black mask and yellow silk', () => {
  const j = job('gbrjob/four-layer-black-yellow-enig.gbrjob');
  assert.equal(j.stackup.layers.filter((l) => l.type === 'Copper').length, 4);
  assert.equal(j.stackup.mask.top, 'Black');
  assert.equal(j.stackup.mask.bottom, 'Black');
  assert.equal(j.stackup.silk.top, 'Yellow');
  assert.deepEqual(codes(j.diagnostics), [], 'the stackup itself is clean');
  assert.deepEqual(resolveJobFiles(j, []), [
    'four-layer-1.gbr',
    'four-layer-2.gbr',
    'four-layer-3.gbr',
    'four-layer-4.gbr',
  ]);
});

test('unknown colours and materials fall back with warnings that point at the layer', () => {
  const j = job('gbrjob/unknown-colours-materials.gbrjob');
  assert.deepEqual(codes(j.diagnostics), ['UNKNOWN_COLOUR', 'UNKNOWN_MATERIAL']);
  assert.ok(j.diagnostics.list.every((d) => d.line > 1));
});

test('zero and negative thickness are errors', () => {
  const j = job('gbrjob/zero-negative-thickness.gbrjob');
  assert.equal(j.diagnostics.errors.length, 3);
});

test('broken JSON reports a line', () => {
  const j = job('gbrjob/broken-json.gbrjob');
  assert.equal(j.job, null);
  assert.ok(j.diagnostics.errors[0].line > 1);
});

test('missing stackup warns and keeps general specs', () => {
  const j = job('gbrjob/no-stackup.gbrjob');
  assert.deepEqual(codes(j.diagnostics), ['JOB_NO_STACKUP']);
  assert.equal(j.stackup.finish, 'ENIG');
});
