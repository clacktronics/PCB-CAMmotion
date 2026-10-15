import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGcode, tokenizeLine } from '../../../src/check/gcode-safety.js';

const LIMITS = {
  safeZMm: 5,
  minZMm: -2,
  envelope: { xMm: [0, 300], yMm: [0, 200], zMm: [-5, 50] },
  maxFeedMmMin: 1000,
  spindleRpm: [5000, 24000],
  tools: [1, 2, 3],
};

// A minimal program that does everything right: header, tool change, cut, arc, drill, footer.
const GOOD = `%
(PCB-CAMmotion test program)
G21 G90 G94 G17
G0 Z10
T1 M6
S12000 M3
G0 X10 Y10
G0 Z5
G1 Z-0.1 F100
G1 X20 Y10 F300
G2 X30 Y20 I0 J10
G0 Z10
G99 G81 X40 Y40 Z-1.8 R5 F200
X45 Y40
G80
G0 Z10
M5
T2 M6
S10000 M3
G1 Z-0.05 F100 ; plunge in place at X45 Y40
G0 Z10
M5
M30
%`;

const rules = (result) => result.findings.map((f) => f.rule);
const withLine = (lineNo, replacement) => {
  const lines = GOOD.split('\n');
  lines[lineNo - 1] = replacement;
  return lines.join('\n');
};
const lineOf = (needle) => GOOD.split('\n').indexOf(needle) + 1;

test('a correct program passes with no findings', () => {
  const r = checkGcode(GOOD, LIMITS);
  assert.deepEqual(r.findings, []);
  assert.equal(r.ok, true);
});

test('tokenizer drops comments and line numbers, rejects junk', () => {
  assert.deepEqual(tokenizeLine('N10 G1 X1.5 (comment) Y-.5 ; tail'), [
    { letter: 'N', value: 10 },
    { letter: 'G', value: 1 },
    { letter: 'X', value: 1.5 },
    { letter: 'Y', value: -0.5 },
  ]);
  assert.deepEqual(tokenizeLine('%'), []);
  assert.deepEqual(tokenizeLine('   '), []);
  assert.equal(tokenizeLine('G1 X1 (unclosed'), null);
  assert.equal(tokenizeLine('G1 X'), null);
});

test('rapid XY move below safe Z is an error', () => {
  const r = checkGcode(withLine(lineOf('G0 Z10'), 'G0 Z1'), LIMITS);
  assert.equal(r.ok, false);
  assert.ok(rules(r).includes('rapid-below-safe-z'));
});

test('rapid plunge below safe Z is an error', () => {
  const r = checkGcode(withLine(lineOf('G0 Z5'), 'G0 Z0.5'), LIMITS);
  assert.ok(rules(r).includes('rapid-below-safe-z'));
  assert.equal(r.findings.find((f) => f.rule === 'rapid-below-safe-z').line, lineOf('G0 Z5'));
});

test('rapid XY move before Z is known is an error', () => {
  const r = checkGcode('G21 G90\nG0 X10 Y10\nM30', LIMITS);
  assert.ok(rules(r).includes('rapid-z-unknown'));
});

test('rapid from below safe Z with simultaneous Z rise is an error (axes move together)', () => {
  const prog = 'G21 G90\nG0 Z10\nT1 M6\nS10000 M3\nG1 Z-0.1 F100\nG0 X5 Y5 Z10\nM5\nM30';
  assert.ok(rules(checkGcode(prog, LIMITS)).includes('rapid-below-safe-z'));
});

test('cutting with the spindle off is an error', () => {
  const r = checkGcode(withLine(lineOf('S12000 M3'), 'S12000'), LIMITS);
  assert.ok(rules(r).includes('cut-spindle-off'));
});

test('feed moves without a feed rate are an error', () => {
  const prog = 'G21 G90\nG0 Z10\nT1 M6\nS10000 M3\nG1 Z-0.1\nG0 Z10\nM5\nM30';
  assert.ok(rules(checkGcode(prog, LIMITS)).includes('feed-missing'));
});

test('feed above the machine limit is an error, also in inches', () => {
  assert.ok(
    rules(checkGcode(withLine(lineOf('G1 X20 Y10 F300'), 'G1 X20 Y10 F5000'), LIMITS)).includes('feed-too-high'),
  );
  // 50 in/min = 1270 mm/min > 1000
  const inch = 'G20 G90\nG0 Z0.4\nG0 X1 Y1\nT1 M6\nS10000 M3\nG1 Z-0.004 F50\nG0 Z0.4\nM5\nM30';
  assert.ok(rules(checkGcode(inch, LIMITS)).includes('feed-too-high'));
  // 30 in/min = 762 mm/min is fine, and safe Z 0.4 in = 10.16 mm passes
  assert.equal(checkGcode(inch.replace('F50', 'F30'), LIMITS).ok, true);
});

test('cutting deeper than the limit is an error', () => {
  const r = checkGcode(withLine(lineOf('G1 Z-0.1 F100'), 'G1 Z-2.5 F100'), LIMITS);
  assert.ok(rules(r).includes('too-deep'));
});

test('moves outside the machine envelope are an error, including arc bulges', () => {
  assert.ok(rules(checkGcode(withLine(lineOf('G0 X10 Y10'), 'G0 X310 Y10'), LIMITS)).includes('outside-envelope'));
  // Semicircle from (10,10) to (10,30) centred at (10,20), clockwise: bulges to x = 20 (inside).
  // Centred at (5,20) (radius 11.18) the clockwise arc reaches x = -6.18.
  const arc = (line) => `G21 G90\nG0 Z10\nT1 M6\nS10000 M3\nG0 X10 Y10\nG0 Z5\nG1 Z-0.1 F100\n${line}\nG0 Z10\nM5\nM30`;
  assert.equal(checkGcode(arc('G2 X10 Y30 I0 J10 F300'), LIMITS).ok, true);
  assert.ok(rules(checkGcode(arc('G2 X10 Y30 I-5 J10 F300'), LIMITS)).includes('outside-envelope'));
});

test('arcs with mismatched radii are an error', () => {
  const r = checkGcode(withLine(lineOf('G2 X30 Y20 I0 J10'), 'G2 X30 Y20 I0 J5'), LIMITS);
  assert.ok(rules(r).includes('arc-radius'));
});

test('tool change rules: spindle on, low Z, unknown tool, missing T', () => {
  assert.ok(rules(checkGcode(withLine(lineOf('M5'), 'G0 Z10'), LIMITS)).includes('toolchange-spindle-on'));
  assert.ok(rules(checkGcode(withLine(lineOf('T2 M6'), 'T9 M6'), LIMITS)).includes('toolchange-unknown-tool'));
  assert.ok(rules(checkGcode('G21 G90\nG0 Z10\nM6\nM30', LIMITS)).includes('toolchange-no-tool'));
  assert.ok(rules(checkGcode('G21 G90\nG0 Z2\nT1 M6\nM30', LIMITS)).includes('toolchange-low-z'));
});

test('spindle speed must be set and within range', () => {
  assert.ok(rules(checkGcode(withLine(lineOf('S12000 M3'), 'S30000 M3'), LIMITS)).includes('spindle-speed'));
  assert.ok(rules(checkGcode(withLine(lineOf('S12000 M3'), 'M3'), LIMITS)).includes('spindle-speed'));
});

test('program must end with spindle off, Z up and M2/M30', () => {
  const lines = GOOD.split('\n');
  const noM5 = lines.filter((l, i) => i !== lines.lastIndexOf('M5')).join('\n');
  assert.ok(rules(checkGcode(noM5, LIMITS)).includes('end-spindle-on'));
  assert.ok(rules(checkGcode(GOOD.replace('M30', ''), LIMITS)).includes('no-end'));
  const lowEnd = 'G21 G90\nG0 Z10\nT1 M6\nS10000 M3\nG1 Z-0.1 F100\nM5\nM30';
  assert.ok(rules(checkGcode(lowEnd, LIMITS)).includes('end-low-z'));
  assert.ok(rules(checkGcode(GOOD.replace('M30\n%', 'M30\nG0 X0'), LIMITS)).includes('after-end'));
});

test('units must be declared before coordinates', () => {
  assert.ok(rules(checkGcode(GOOD.replace('G21 G90 G94 G17', 'G90 G94 G17'), LIMITS)).includes('units-missing'));
});

test('codes the checker does not understand are errors, never ignored', () => {
  for (const line of ['G28', 'G53 G0 Z0', 'M98 P100', 'G2 X30 Y20 R10', 'A10']) {
    const r = checkGcode(withLine(lineOf('G2 X30 Y20 I0 J10'), line), LIMITS);
    assert.ok(rules(r).includes('unsupported'), line);
  }
  assert.ok(rules(checkGcode(withLine(3, 'G21 G90 #1=5'), LIMITS)).includes('syntax'));
});

test('drill cycle rules: depth, R plane, G99 retract below safe Z, spindle', () => {
  const at = lineOf('G99 G81 X40 Y40 Z-1.8 R5 F200');
  assert.ok(rules(checkGcode(withLine(at, 'G99 G81 X40 Y40 Z-3 R5 F200'), LIMITS)).includes('too-deep'));
  assert.ok(rules(checkGcode(withLine(at, 'G99 G81 X40 Y40 Z-1.8 R1 F200'), LIMITS)).includes('rapid-below-safe-z'));
  // G98 returns to the start height (Z10), so a low R plane is fine there.
  assert.equal(checkGcode(withLine(at, 'G98 G81 X40 Y40 Z-1.8 R1 F200'), LIMITS).ok, true);
  assert.ok(rules(checkGcode(withLine(at, 'G99 G81 X40 Y40 Z-1.8 F200'), LIMITS)).includes('drill-cycle-incomplete'));
  assert.ok(
    rules(checkGcode(withLine(at, 'G98 G81 X40 Y40 Z-1.8 R12 F200'), LIMITS)).includes('drill-cycle-r-above-start'),
  );
});

test('findings carry the source line', () => {
  const r = checkGcode(withLine(lineOf('G1 X20 Y10 F300'), 'G1 X20 Y10 F5000'), LIMITS);
  const f = r.findings.find((x) => x.rule === 'feed-too-high');
  assert.equal(f.line, lineOf('G1 X20 Y10 F300'));
  assert.equal(f.severity, 'error');
});

test('CRLF line endings are handled', () => {
  assert.equal(checkGcode(GOOD.replace(/\n/g, '\r\n'), LIMITS).ok, true);
});
