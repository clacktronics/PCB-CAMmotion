import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { checkGcode } from '../../../src/check/gcode-safety.js';

const LIMITS = {
  safeZMm: 5,
  minZMm: -2,
  envelope: { xMm: [0, 300], yMm: [0, 200], zMm: [-5, 50] },
  maxFeedMmMin: 1000,
  spindleRpm: [5000, 24000],
  tools: [1, 2, 3],
};

const word = fc.tuple(fc.constantFrom(...'GMXYZIJRFSTPNQ'), fc.double({ min: -500, max: 500, noNaN: true }));
const line = fc.array(word, { maxLength: 5 }).map((ws) => ws.map(([l, v]) => `${l}${+v.toFixed(3)}`).join(' '));

test('random text never crashes the checker and always yields a verdict', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 400 }), (text) => {
      const r = checkGcode(text, LIMITS);
      assert.equal(typeof r.ok, 'boolean');
    }),
    { numRuns: 500 },
  );
});

test('random G-code-shaped programs: findings are well-formed and ok agrees with them', () => {
  fc.assert(
    fc.property(fc.array(line, { maxLength: 30 }), (lines) => {
      const text = ['G21 G90', 'G0 Z10', ...lines].join('\n');
      const r = checkGcode(text, LIMITS);
      for (const f of r.findings) {
        assert.ok(Number.isInteger(f.line) && f.line >= 1, 'every finding has a line');
        assert.ok(f.rule && f.message);
      }
      assert.equal(r.ok, !r.findings.some((f) => f.severity === 'error'));
    }),
    { numRuns: 500 },
  );
});
