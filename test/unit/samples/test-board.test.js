// The committed test board must be exactly what tools/testboard/generate.mjs produces, so
// boards cut on the machines (docs/qa/) can always be traced back to the generator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const committed = join(root, 'samples/test-board');

test('samples/test-board matches its generator', () => {
  const out = mkdtempSync(join(tmpdir(), 'testboard-'));
  try {
    execFileSync(process.execPath, [join(root, 'tools/testboard/generate.mjs'), '--out', out]);
    const generated = readdirSync(out).sort();
    for (const name of generated) {
      assert.ok(
        readFileSync(join(out, name)).equals(readFileSync(join(committed, name))),
        `samples/test-board/${name} differs from the generator: run node tools/testboard/generate.mjs and review the diff`,
      );
    }
    const extra = readdirSync(committed).filter((n) => n !== 'README.md' && !generated.includes(n));
    assert.deepEqual(extra, [], 'files in samples/test-board/ that the generator does not produce');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the job file lists every board file, and every Gerber is plain ASCII', () => {
  const job = JSON.parse(readFileSync(join(committed, 'cammotion-test-board-job.gbrjob'), 'utf8'));
  const files = readdirSync(committed).filter((n) => /\.(gbr|drl)$/.test(n));
  assert.deepEqual(job.FilesAttributes.map((f) => f.Path).sort(), files.sort());
  for (const name of files) {
    const bytes = readFileSync(join(committed, name));
    assert.ok(bytes.every((b) => b === 0x0a || (b >= 0x20 && b < 0x7f)), `${name} has non-ASCII bytes`);
  }
});

test('features.json ladders cover the ranges the plan asks for', () => {
  const f = JSON.parse(readFileSync(join(committed, 'features.json'), 'utf8'));
  assert.equal(f.units, 'mm');
  assert.ok(f.traceLadder.some((t) => t.width <= 0.1) && f.traceLadder.some((t) => t.width >= 1));
  assert.ok(f.gapLadder.some((g) => g.gap <= 0.1));
  assert.ok(f.drillLadder.length >= 10);
  assert.deepEqual(
    f.aperturePads.map((p) => p.aperture[0]),
    ['C', 'R', 'O', 'P', 'RRECT'],
  );
});
