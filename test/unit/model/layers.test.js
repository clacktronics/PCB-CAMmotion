import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, SAMPLES, bytes, SYNTH } from '../../helpers.js';
import { identifyLayer, roleFromFileFunction, roleFromFilename, detectFileKind } from '../../../src/model/layers.js';
import { loadFile } from '../../../src/model/load-file.js';
import { parseGbrjob } from '../../../src/parse/gbrjob.js';

// tracespace names: silkscreen/solderpaste/outline -> our Gerber-spec terms
const TYPE = {
  copper: 'copper',
  soldermask: 'soldermask',
  silkscreen: 'legend',
  solderpaste: 'paste',
  outline: 'profile',
  drill: 'drill',
  drawing: 'other',
};

// Deliberate differences from tracespace's expectations, with the reason
const EXCEPTIONS = {
  'board.fab.gbr': 'gEDA fab drawing is a Gerber drawing, not drill data: identified as other',
  'board.DRD': 'OrCAD drill drawing (a Gerber), not the board outline: identified as other',
};

test('file names from KiCad, Eagle, Altium, OrCAD, gEDA, DipTrace, OSH Park, PCB:NG', () => {
  const table = JSON.parse(readFileSync(join(FIXTURES, 'tracespace/gerber-filenames.json'), 'utf8'));
  let n = 0;
  for (const { cad, files } of table) {
    for (const f of files) {
      if (EXCEPTIONS[f.name]) continue;
      // .pos/.csv/.gpi are not Gerber: content detection makes them 'unknown'
      const kind = f.type === 'drill' ? 'excellon' : f.type && f.type !== 'drawing' ? 'gerber' : 'unknown';
      const r = roleFromFilename(f.name, kind);
      const want = f.type ? TYPE[f.type] : 'other';
      assert.equal(r.type, want, `${cad}: ${f.name} type`);
      if (f.side && want !== 'other') assert.equal(r.side, f.side, `${cad}: ${f.name} side`);
      n++;
    }
  }
  assert.ok(n > 130);
});

test('real sample boards: every layer identified as tracespace expects', () => {
  const boards = readdirSync(SAMPLES, { withFileTypes: true }).filter(
    (d) => d.isDirectory() && existsSync(join(SAMPLES, d.name, 'tracespace-layers.json')),
  );
  assert.ok(boards.length >= 8);
  for (const board of boards) {
    const dir = join(SAMPLES, board.name);
    const expected = JSON.parse(readFileSync(join(dir, 'tracespace-layers.json'), 'utf8')).layers;
    for (const e of expected) {
      const r = loadFile(e.name, bytes(join(dir, e.name)));
      const role = identifyLayer({
        name: e.name,
        kind: r.kind,
        fileFunction: r.image?.fileAttributes['.FileFunction'],
      });
      assert.equal(role.type, TYPE[e.type], `${board.name}/${e.name}`);
      assert.equal(role.side, e.side, `${board.name}/${e.name} side`);
    }
  }
});

test('X2 .FileFunction mapping', () => {
  assert.deepEqual(roleFromFileFunction('Copper,L2,Inr'), {
    type: 'copper',
    side: 'inner',
    index: 2,
    polarity: 'positive',
  });
  assert.equal(roleFromFileFunction(['Soldermask', 'Bot']).polarity, 'negative');
  assert.deepEqual(roleFromFileFunction('NonPlated,1,2,NPTH'), {
    type: 'drill',
    side: 'all',
    plated: false,
    polarity: 'positive',
  });
  assert.equal(roleFromFileFunction('Profile,NP').type, 'profile');
  assert.equal(roleFromFileFunction('AssemblyDrawing,Top').type, 'other');
});

test('priority: .gbrjob, then X2 attribute, then file name', () => {
  const job = parseGbrjob(bytes(join(SYNTH, 'board/synthetic-board-job.gbrjob')));
  const name = 'synthetic-board-F_Mask.gbr';
  assert.equal(identifyLayer({ name, kind: 'gerber' }, job.files).source, 'gbrjob');
  assert.equal(identifyLayer({ name: 'x.gbr', kind: 'gerber', fileFunction: ['Copper', 'L1', 'Top'] }).source, 'x2');
  assert.equal(identifyLayer({ name: 'x.gtl', kind: 'gerber' }).source, 'filename');
  // a file named like a top layer but with an X2 attribute saying bottom follows the attribute
  const r = identifyLayer({ name: 'board-F_Cu.gbr', kind: 'gerber', fileFunction: ['Copper', 'L2', 'Bot'] });
  assert.deepEqual([r.type, r.side], ['copper', 'bottom']);
});

test('file kind detection by content, not only extension', () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.equal(detectFileKind('board.txt', enc('M48\nINCH\nT1C0.03\n%\nT1\nX1Y1\nM30\n')), 'excellon');
  assert.equal(detectFileKind('board.txt', enc('G04 hi*\n%FSLAX46Y46*%\n')), 'gerber');
  assert.equal(detectFileKind('job.gbrjob', enc('{}')), 'gbrjob');
  assert.equal(detectFileKind('README.txt', enc('hello')), 'unknown');
  assert.equal(detectFileKind('p.PCAM', enc('PK')), 'pcam');
  assert.equal(detectFileKind('x.zip', new Uint8Array([0x50, 0x4b, 3, 4])), 'zip');
});
