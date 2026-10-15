// Every parser against every synthetic fixture (tools/synth/generate.mjs -> manifest.json).
// ok: no errors and no warnings. warning: loads, at least one warning (at errorLine if given).
// error: at least one error (at errorLine if given). limit: completes within budget, no crash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { manifest, bytes, SYNTH } from '../../helpers.js';
import { loadFile } from '../../../src/model/load-file.js';
import { resolveJobFiles } from '../../../src/parse/gbrjob.js';

const KIND = { gerber: 'gerber', drill: 'excellon', gbrjob: 'gbrjob' };
const LIMIT_BUDGET_MS = 20000;

for (const f of manifest().fixtures) {
  test(`${f.expect}: ${f.path}`, () => {
    const t0 = performance.now();
    const r = loadFile(f.path, bytes(join(SYNTH, f.path)), { kind: KIND[f.type] });
    if (r.kind === 'gbrjob' && r.job.job) resolveJobFiles(r.job, readdirSync(join(SYNTH, dirname(f.path))));
    const ms = performance.now() - t0;
    const d = r.diagnostics.list;
    const errors = d.filter((x) => x.severity === 'error');
    const warnings = d.filter((x) => x.severity === 'warning');
    const show = () => d.map((x) => `${x.severity} ${x.code} line ${x.line}: ${x.message}`).join('\n') || '(none)';
    for (const x of d) assert.ok(x.message && x.code, 'every diagnostic has a code and a message');
    switch (f.expect) {
      case 'ok':
        assert.equal(errors.length + warnings.length, 0, `expected a clean parse, got:\n${show()}`);
        break;
      case 'warning':
        assert.equal(errors.length, 0, `expected no errors, got:\n${show()}`);
        assert.ok(warnings.length > 0, 'expected a warning');
        if (f.errorLine)
          assert.ok(
            warnings.some((w) => w.line === f.errorLine),
            `expected a warning on line ${f.errorLine}, got:\n${show()}`,
          );
        break;
      case 'error':
        assert.ok(errors.length > 0, `expected an error, got:\n${show()}`);
        if (f.errorLine)
          assert.ok(
            errors.some((e) => e.line === f.errorLine),
            `expected an error on line ${f.errorLine}, got:\n${show()}`,
          );
        break;
      case 'limit':
        assert.ok(ms < LIMIT_BUDGET_MS, `took ${ms.toFixed(0)} ms`);
        for (const e of errors) assert.ok(e.message.length > 10, 'refusals must explain themselves');
        break;
      default:
        assert.fail(`unknown expectation ${f.expect}`);
    }
    checkFacts(f, r);
  });
}

/** Generic facts from the manifest that every parser must reproduce. */
function checkFacts(f, r) {
  const facts = f.facts || {};
  const img = r.image;
  if (!img) return;
  if (facts.apertures !== undefined) assert.equal(img.apertures.size, facts.apertures, 'aperture count');
  if (facts.flashes !== undefined)
    assert.equal(img.objects.filter((o) => o.k === 'F').length, facts.flashes, 'flash count');
  if (facts.draws !== undefined && f.expect !== 'limit') assert.equal(img.stats.draws, facts.draws, 'draw count');
  if (facts.draws !== undefined && f.expect === 'limit' && !img.truncated)
    assert.equal(img.stats.draws, facts.draws, 'draw count');
  if (facts.objects === 0) assert.equal(img.objects.length, 0);
  if (facts.copies !== undefined && !img.truncated) assert.equal(img.objects.length, facts.copies * 2);
  if (facts.dcodes) assert.deepEqual([...img.apertures.keys()], facts.dcodes);
  if (facts.vertices) assert.equal(img.objects[0].contours[0].length / 2, facts.vertices);
  if (facts.holes !== undefined) assert.equal(img.stats.holes, facts.holes, 'hole count');
  if (facts.tools !== undefined) assert.equal(img.apertures.size, facts.tools, 'tool count');
  if (facts.slots !== undefined) assert.equal(img.stats.slots, facts.slots, 'slot count');
  if (facts.routes !== undefined) assert.equal(img.stats.routes, facts.routes, 'route count');
  const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);
  const pathBounds = () => {
    // centre-line bounds of draws (excluding aperture size)
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const o of img.objects) {
      const pts =
        o.k === 'F'
          ? [[o.x, o.y]]
          : o.k === 'R'
            ? []
            : [
                [o.x1, o.y1],
                [o.x2, o.y2],
              ];
      for (const [x, y] of pts) {
        b[0] = Math.min(b[0], x);
        b[1] = Math.min(b[1], y);
        b[2] = Math.max(b[2], x);
        b[3] = Math.max(b[3], y);
      }
    }
    return b;
  };
  for (const key of ['outlineMm', 'pathBoundsMm', 'boundsMm']) {
    if (!facts[key]) continue;
    const b = pathBounds();
    facts[key].forEach((v, i) => close(b[i], v, key));
  }
  if (facts.boundsIn) {
    const b = pathBounds();
    facts.boundsIn.forEach((v, i) => close(b[i], v * 25.4, 'boundsIn'));
  }
  if (facts.holesMm || facts.holesIn) {
    const k = facts.holesIn ? 25.4 : 1;
    const want = (facts.holesMm || facts.holesIn).map(([x, y]) => [x * k, y * k]);
    const got = img.objects.filter((o) => o.k === 'F').map((o) => [o.x, o.y]);
    assert.equal(got.length, want.length, 'hole count');
    want.forEach(([x, y], i) => {
      close(got[i][0], x, `hole ${i} x`);
      close(got[i][1], y, `hole ${i} y`);
    });
  }
}
