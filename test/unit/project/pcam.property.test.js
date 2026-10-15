import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createEmptyProject } from '../../../src/project/schema.js';
import { saveProject, loadProject, addSource, PcamError } from '../../../src/project/pcam.js';

const NOW = new Date('2026-10-15T00:00:00Z');

test('random bytes never crash the loader: only PcamError', () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 2048 }), (bytes) => {
      try {
        loadProject(bytes);
      } catch (e) {
        if (!(e instanceof PcamError)) throw e;
      }
    }),
    { numRuns: 500 },
  );
});

test('corrupting a saved project never crashes the loader', () => {
  const good = saveProject(addSource(createEmptyProject({ now: NOW }), 'a.gbr', new Uint8Array([1, 2, 3]), NOW));
  fc.assert(
    fc.property(fc.nat(good.length - 1), fc.integer({ min: 0, max: 255 }), (at, value) => {
      const bytes = good.slice();
      bytes[at] = value;
      try {
        loadProject(bytes);
      } catch (e) {
        if (!(e instanceof PcamError)) throw e;
      }
    }),
    { numRuns: 500 },
  );
});

test('any set of sources and settings round-trips', () => {
  const name = fc.stringMatching(/^[A-Za-z0-9_. -]{1,20}$/).filter((s) => s !== '.' && s !== '..');
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.tuple(name, fc.uint8Array({ maxLength: 256 })), { selector: ([n]) => n, maxLength: 5 }),
      fc.jsonValue(),
      (files, settings) => {
        let p = createEmptyProject({ name: 'prop', now: NOW });
        for (const [n, bytes] of files) p = addSource(p, n, bytes, NOW);
        p.settings = { value: settings };
        const back = loadProject(saveProject(p));
        assert.deepEqual(back.sources, p.sources);
        assert.deepEqual(back.settings, JSON.parse(JSON.stringify(p.settings)));
      },
    ),
    { numRuns: 200 },
  );
});
