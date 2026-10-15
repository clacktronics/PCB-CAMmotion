import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerColour, xorLayer, parseHex, toHex, backgroundColour, VIEW_MODES } from '../../../src/model/view-modes.js';
import { CLASSIC, DEBUG, MISC } from '../../../src/model/materials.js';

const copperTop = { role: { type: 'copper', side: 'top' } };

test('layer colours: own colour, classic palette by position, else by function', () => {
  assert.deepEqual(layerColour({ ...copperTop, colour: '#102030' }, 'classic', 0), [16, 32, 48]);
  assert.deepEqual(layerColour(copperTop, 'classic', 1), CLASSIC[1].rgb);
  assert.deepEqual(layerColour(copperTop, 'xor', CLASSIC.length + 2), CLASSIC[2].rgb, 'palette wraps');
  assert.deepEqual(layerColour(copperTop, 'debug', 5), DEBUG.copper_top.rgb);
  assert.deepEqual(layerColour({ role: { type: 'drill', side: 'all' } }, 'outline', 0), DEBUG.drill.rgb);
  assert.deepEqual(layerColour({ ...copperTop, colour: 'nonsense' }, 'debug', 0), DEBUG.copper_top.rgb);
});

test('hex round trip', () => {
  assert.equal(toHex([1, 171, 255]), '#01abff');
  assert.deepEqual(parseHex('#01ABFF'), [1, 171, 255]);
  assert.equal(parseHex('#fff'), null);
});

test('XOR: one layer shows its colour, two identical layers cancel, different ones mix', () => {
  const px = () => new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
  const cov = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]); // first pixel covered only
  const a = xorLayer(px(), cov, [200, 100, 50]);
  assert.deepEqual([...a], [200, 100, 50, 255, 0, 0, 0, 255]);
  xorLayer(a, cov, [200, 100, 50]);
  assert.deepEqual([...a], [0, 0, 0, 255, 0, 0, 0, 255]);
  const b = xorLayer(xorLayer(px(), cov, [255, 0, 0]), cov, [0, 0, 255]);
  assert.deepEqual([...b.slice(0, 3)], [255, 0, 255]);
  const half = new Uint8ClampedArray([0, 0, 0, 100, 0, 0, 0, 0]);
  assert.deepEqual([...xorLayer(px(), half, [9, 9, 9]).slice(0, 3)], [0, 0, 0], 'anti-aliased fringe < 50 % ignored');
});

test('backgrounds and modes', () => {
  assert.deepEqual(backgroundColour('classic', 'dark'), [0, 0, 0]);
  assert.deepEqual(backgroundColour('realistic', 'dark'), MISC.background.rgb);
  assert.deepEqual(backgroundColour('xor', 'light'), MISC.backgroundLight.rgb);
  assert.deepEqual(VIEW_MODES, ['realistic', 'debug', 'classic', 'xor', 'outline']);
});
