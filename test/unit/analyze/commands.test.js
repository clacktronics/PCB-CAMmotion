import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { gerber, drill, bytes, FIXTURES, SYNTH, manifest } from '../../helpers.js';
import {
  commandObjectRange,
  objectCommand,
  commandsAtLine,
  coordinateContext,
  describeCommand,
} from '../../../src/analyze/commands.js';

const fx = (name) => gerber(bytes(join(FIXTURES, 'gerber', name)));
const layerOf = ({ parsed, image }, kind = 'gerber') => ({ kind, commands: parsed.commands, image });

/**
 * Every object links to the command that produced it, and that command explains its source
 * line: the same line, or the command that completes a multi-command construct (G37 for a
 * region started at G36, %SR*% / M02 for step and repeat copies, D03 for aperture block contents).
 */
function checkLinks(name, { parsed, image }) {
  const cmds = parsed.commands;
  const ends = image.commandEnds;
  assert.equal(ends.length, cmds.length, name);
  for (let i = 1; i < ends.length; i++) assert.ok(ends[i] >= ends[i - 1], `${name}: ends not monotonic at ${i}`);
  if (cmds.length) assert.equal(ends[ends.length - 1], image.objects.length, name);
  for (let oi = 0; oi < image.objects.length; oi++) {
    const o = image.objects[oi];
    const ci = objectCommand(image, oi);
    assert.ok(ci >= 0, `${name}: object ${oi} has no command`);
    const [a, b] = commandObjectRange(image, ci);
    assert.ok(oi >= a && oi < b, `${name}: object ${oi} outside its command range`);
    const c = cmds[ci];
    const ok =
      c.line === o.ln ||
      (o.k === 'R' && c.type === 'G' && c.code === 37) ||
      c.type === 'SR' ||
      c.type === 'M02' ||
      ci === cmds.length - 1 ||
      (c.type === 'D' && c.op === 3);
    assert.ok(ok, `${name}: object ${oi} (line ${o.ln}) produced by ${c.type} on line ${c.line}`);
  }
}

test('source-line linking: every spec-feature fixture', () => {
  for (const f of readdirSync(join(FIXTURES, 'gerber'))) checkLinks(f, fx(f));
});

test('source-line linking: every valid synthetic Gerber and drill file', () => {
  const files = manifest().fixtures.filter(
    (f) => f.expect !== 'error' && f.expect !== 'limit' && /^(gerber-valid|drill-valid|board)\//.test(f.path),
  );
  assert.ok(files.length > 10);
  for (const f of files) {
    const b = bytes(join(SYNTH, f.path));
    checkLinks(f.path, f.path.endsWith('.drl') ? drill(b) : gerber(b));
  }
});

test('simple objects are produced by the command on their own source line', () => {
  const r = fx('analyser-apertures.gbr');
  const { image, parsed } = r;
  for (let oi = 0; oi < image.objects.length; oi++) {
    const o = image.objects[oi];
    const c = parsed.commands[objectCommand(image, oi)];
    if (o.k === 'R') assert.equal(c.type === 'G' && c.code, 37);
    else assert.equal(c.line, o.ln);
  }
  // a line's commands can be found from the line (G03X…D01* is two commands on line 18)
  const at18 = commandsAtLine(parsed.commands, 18);
  assert.deepEqual(
    at18.map((i) => parsed.commands[i].type),
    ['G', 'D'],
  );
  assert.deepEqual(commandsAtLine(parsed.commands, 9999), []);
});

test('step and repeat: all copies come from the closing %SR*%', () => {
  const { image, parsed } = fx('step-repeat-3x2.gbr');
  const close = parsed.commands.findIndex((c) => c.type === 'SR' && c.close);
  assert.deepEqual(commandObjectRange(image, close), [0, 6]);
  for (let oi = 0; oi < 6; oi++) assert.equal(objectCommand(image, oi), close);
  // the flash inside the block produced nothing yet
  const flash = parsed.commands.findIndex((c) => c.type === 'D' && c.op === 3);
  assert.deepEqual(commandObjectRange(image, flash), [0, 0]);
});

test('aperture block: its contents appear at the flash of the block', () => {
  const { image, parsed } = fx('block-clear-polarity.gbr');
  const last = parsed.commands.findLastIndex((c) => c.type === 'D' && c.op === 3);
  const [a, b] = commandObjectRange(image, last);
  assert.equal(b - a, 2);
  // the objects keep the source lines of the commands inside the block
  assert.deepEqual(
    image.objects.slice(a, b).map((o) => o.ln),
    [9, 11],
  );
});

test('out-of-range lookups', () => {
  const { image } = fx('step-repeat-3x2.gbr');
  assert.equal(objectCommand(image, -1), -1);
  assert.equal(objectCommand(image, 99), -1);
  assert.deepEqual(commandObjectRange(image, 99), [0, 0]);
});

test('descriptions: Gerber commands in file syntax with mm coordinates', () => {
  const r = fx('analyser-apertures.gbr');
  const layer = layerOf(r);
  const ctx = coordinateContext(layer.commands);
  const d = (pred) => describeCommand(layer, layer.commands.findIndex(pred), ctx);
  assert.deepEqual(
    d((c) => c.type === 'FS'),
    {
      code: '%FSLAX46Y46*%',
      text: 'Format 4.6, leading zeros omitted, absolute',
      objects: 0,
    },
  );
  assert.equal(d((c) => c.type === 'AD' && c.code === 11).code, '%ADD11R,1X2*%');
  assert.equal(d((c) => c.type === 'AD' && c.code === 11).text, 'Define aperture D11: rectangle 1 × 2 mm');
  assert.equal(d((c) => c.type === 'AM').text, 'Define macro SQUARE2 (1 primitive)');
  assert.equal(d((c) => c.type === 'Dnn' && c.code === 13).text, 'Select aperture D13 (polygon 6-gon ⌀2 mm)');
  const draw = d((c) => c.type === 'D' && c.op === 1);
  assert.equal(draw.code, 'X10000000Y0D01');
  assert.equal(draw.text, 'Interpolate (D01) to X 10 Y 0 mm → 1 line');
  const arc = d((c) => c.type === 'D' && c.g === 3);
  assert.equal(arc.code, 'G03X5000000Y10000000I-5000000J0D01');
  assert.match(arc.text, /→ 1 arc$/);
  assert.equal(d((c) => c.type === 'D' && c.op === 3).text, 'Flash (D03) to X 1 Y 1 mm → 1 flash');
  assert.equal(d((c) => c.type === 'G' && c.code === 37).text, 'Region end (G37): fill the contours → 1 region');
  assert.equal(d((c) => c.type === 'LP' && c.polarity === 'C').text, 'Polarity clear: objects erase');
  assert.equal(d((c) => c.type === 'M02').code, 'M02');
});

test('descriptions: inch coordinates are converted to mm', () => {
  const r = gerber(['%FSLAX25Y25*%', '%MOIN*%', '%ADD10C,0.1*%', 'D10*', 'X100000Y-50000D03*', 'M02*'].join('\n'));
  const layer = layerOf(r);
  const i = layer.commands.findIndex((c) => c.type === 'D');
  assert.equal(describeCommand(layer, i).text, 'Flash (D03) to X 25.4 Y -12.7 mm → 1 flash');
});

test('descriptions: Excellon commands show their source text', () => {
  const r = drill(bytes(join(SYNTH, 'drill-valid/kicad-pth-metric.drl')));
  const layer = layerOf(r, 'excellon');
  const def = layer.commands.findIndex((c) => c.type === 'TOOL_DEF');
  const hit = layer.commands.findIndex((c) => c.type === 'HIT');
  assert.match(describeCommand(layer, def).text, /^Define tool T\d+: ⌀[\d.]+ mm$/);
  const h = describeCommand(layer, hit);
  assert.equal(h.code, layer.commands[hit].raw);
  assert.match(h.text, /^Drill at X [\d.-]+ Y [\d.-]+ mm → 1 flash$/);
  assert.equal(h.objects, 1);
});

test('every command of every fixture has a description', () => {
  for (const f of readdirSync(join(FIXTURES, 'gerber'))) {
    const layer = layerOf(fx(f));
    const ctx = coordinateContext(layer.commands);
    for (let i = 0; i < layer.commands.length; i++) {
      const d = describeCommand(layer, i, ctx);
      assert.ok(d.code && d.text && !/undefined|NaN/.test(d.code + d.text), `${f} #${i}: ${d.code} ${d.text}`);
    }
  }
});
