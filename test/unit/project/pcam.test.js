import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8, strFromU8, unzipSync } from '../../../vendor/fflate/fflate.js';
import { createEmptyProject, migrate, SCHEMA_VERSION } from '../../../src/project/schema.js';
import {
  saveProject,
  loadProject,
  addSource,
  isPcamFileName,
  pcamFileName,
  safeSourceName,
  PcamError,
} from '../../../src/project/pcam.js';
import { APP_VERSION } from '../../../src/version.js';
import { assertGolden } from '../../helpers/golden.js';

const NOW = new Date('2026-10-15T00:00:00Z');
const fixture = (name) => new Uint8Array(readFileSync(new URL(`../../fixtures/pcam/${name}`, import.meta.url)));

test('empty project: save → load gives an identical project', () => {
  const p = createEmptyProject({ name: 'empty', now: NOW });
  assert.deepEqual(loadProject(saveProject(p)), p);
});

test('empty project manifest matches the golden file', () => {
  const entries = unzipSync(saveProject(createEmptyProject({ name: 'empty', now: NOW })));
  const manifest = JSON.parse(strFromU8(entries['project.json']));
  assert.equal(manifest.appVersion, APP_VERSION);
  // appVersion changes with every release; the golden file pins the schema shape.
  manifest.appVersion = '<app version>';
  assertGolden('project/empty-project.json', JSON.stringify(manifest, null, 2) + '\n');
  assert.deepEqual(Object.keys(entries).sort(), ['project.json', 'settings/project.json', 'tools.json']);
});

test('saving is deterministic', () => {
  const p = createEmptyProject({ name: 'x', now: NOW });
  assert.deepEqual(saveProject(p), saveProject(p));
});

test('sources stay byte-for-byte identical (CRLF, NUL, non-UTF-8)', () => {
  const bytes = new Uint8Array([0x47, 0x30, 0x34, 0x0d, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
  const p = addSource(createEmptyProject({ now: NOW }), 'top.GTL', bytes, NOW);
  const back = loadProject(saveProject(p));
  assert.equal(back.sources.length, 1);
  assert.equal(back.sources[0].name, 'top.GTL');
  assert.deepEqual(back.sources[0].bytes, bytes);
});

test('re-importing a file with the same name replaces it; the input project is not mutated', () => {
  const p0 = createEmptyProject({ now: NOW });
  const p1 = addSource(p0, 'a.gbr', strToU8('one'), NOW);
  const p2 = addSource(p1, 'a.gbr', strToU8('two'), NOW);
  assert.equal(p0.sources.length, 0);
  assert.equal(p2.sources.length, 1);
  assert.equal(strFromU8(p2.sources[0].bytes), 'two');
});

test('source names never escape sources/', () => {
  assert.equal(safeSourceName('../../etc/passwd'), 'passwd');
  assert.equal(safeSourceName('C:\\boards\\top.gtl'), 'top.gtl');
  assert.throws(() => safeSourceName('..'), PcamError);
  assert.throws(() => safeSourceName('dir/'), PcamError);
});

test('settings, stackup, tools and unknown data survive a round trip', () => {
  const p = createEmptyProject({ now: NOW });
  p.settings = { view: { zoom: 2 } };
  p.stackup = { layers: [] };
  p.tools = { library: [{ id: 'vbit-30', diameterMm: 0.2 }] };
  p.manifest.addedLater = 'keep me';
  p.extra['future/thing.bin'] = new Uint8Array([1, 2, 3]);
  assert.deepEqual(loadProject(saveProject(p)), p);
});

test('fixture v1-empty.pcam loads', () => {
  const p = loadProject(fixture('v1-empty.pcam'));
  assert.equal(p.manifest.schemaVersion, 1);
  assert.equal(p.manifest.name, 'empty');
  assert.equal(p.manifest.units, 'mm');
  assert.deepEqual(p.sources, []);
});

test('fixture v1-with-source.pcam loads, and unknown fields/entries survive load → save → load', () => {
  const p = loadProject(fixture('v1-with-source.pcam'));
  assert.equal(p.sources[0].name, 'board-F_Cu.gbr');
  assert.match(strFromU8(p.sources[0].bytes), /\r\n%MOMM\*%\r\n/);
  assert.deepEqual(p.manifest.futureField, { kept: true });
  assert.deepEqual(p.settings, { view: { side: 'top' } });
  assert.equal(strFromU8(p.extra['future/notes.txt']), 'written by a later version\n');
  assert.deepEqual(loadProject(saveProject(p)), p);
});

test('every .pcam fixture loads and migrates to the current schema', () => {
  for (const name of ['v1-empty.pcam', 'v1-with-source.pcam']) {
    assert.equal(loadProject(fixture(name)).manifest.schemaVersion, SCHEMA_VERSION, name);
  }
});

test('migrate() steps through every version and keeps unknown data', () => {
  const migrations = {
    1: (raw) => ({ ...raw, manifest: { ...raw.manifest, schemaVersion: 2, step1: true } }),
    2: (raw) => ({ ...raw, manifest: { ...raw.manifest, schemaVersion: 3, step2: true } }),
  };
  const out = migrate({ manifest: { schemaVersion: 1, other: 'x' }, entries: { a: new Uint8Array() } }, migrations, 3);
  assert.deepEqual(out.manifest, { schemaVersion: 3, other: 'x', step1: true, step2: true });
  assert.ok('a' in out.entries);
  assert.throws(
    () => migrate({ manifest: { schemaVersion: 1 }, entries: {} }, {}, 2),
    /No migration from .pcam schema 1/,
  );
});

const zip = (files) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])));

test('bad files give a clear error, never a crash', () => {
  const cases = [
    [strToU8('not a zip at all'), /not a ZIP file/],
    [new Uint8Array(), /not a ZIP file|project.json is missing/],
    [zip({ 'other.txt': 'x' }), /project.json is missing/],
    [zip({ 'project.json': '{oops' }), /not valid JSON/],
    [zip({ 'project.json': '{"schemaVersion":1}' }), /format tag/],
    [zip({ 'project.json': '{"format":"pcam","schemaVersion":"1"}' }), /bad schemaVersion/],
    [zip({ 'project.json': '{"format":"pcam","schemaVersion":99}' }), /newer version/],
    [zip({ 'project.json': '{"format":"pcam","schemaVersion":1}', '../evil': 'x' }), /unsafe entry path/],
    [zip({ 'project.json': '{"format":"pcam","schemaVersion":1}', 'tools.json': '[' }), /tools.json is not valid JSON/],
  ];
  for (const [bytes, message] of cases)
    assert.throws(
      () => loadProject(bytes),
      (e) => e instanceof PcamError && message.test(e.message),
    );
});

test('file names: .pcam in any case; download name is sanitised', () => {
  assert.ok(isPcamFileName('board.pcam'));
  assert.ok(isPcamFileName('BOARD.PCAM'));
  assert.ok(!isPcamFileName('board.pcam.zip'));
  assert.ok(!isPcamFileName('board.gbr'));
  const p = createEmptyProject({ name: 'my/board: v2', now: NOW });
  assert.equal(pcamFileName(p), 'my_board_ v2.pcam');
  assert.equal(pcamFileName(createEmptyProject({ name: '  ', now: NOW })), 'untitled.pcam');
});
