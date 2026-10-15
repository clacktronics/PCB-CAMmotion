import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOLDER_MASK,
  SILKSCREEN,
  FINISH,
  SUBSTRATE,
  DEBUG,
  COPPER,
  MISC,
  SURFACE,
  lookupMaterial,
  rgba,
} from '../../../src/model/materials.js';

test('every table entry is a valid colour', () => {
  for (const table of [SOLDER_MASK, SILKSCREEN, FINISH, SUBSTRATE, DEBUG, MISC, { COPPER }]) {
    for (const [k, v] of Object.entries(table)) {
      assert.equal(v.rgb.length, 3, k);
      for (const c of v.rgb) assert.ok(Number.isInteger(c) && c >= 0 && c <= 255, k);
      if ('opacity' in v) assert.ok(v.opacity > 0 && v.opacity <= 1, k);
    }
  }
});

test('KiCad colour, finish and material names resolve; unknown ones fall back', () => {
  for (const n of ['Green', 'Red', 'Blue', 'Black', 'White', 'Yellow', 'Purple', 'Matte Black'])
    assert.ok(lookupMaterial('mask', n).known, n);
  for (const n of ['White', 'Black', 'Yellow']) assert.ok(lookupMaterial('silk', n).known, n);
  for (const n of ['ENIG', 'HASL', 'HASL lead-free', 'OSP', 'Immersion silver', 'Immersion tin', 'None'])
    assert.ok(lookupMaterial('finish', n).known, n);
  for (const n of ['FR4', 'FR4-TG170', 'Polyimide', 'Aluminum', 'PTFE'])
    assert.ok(lookupMaterial('substrate', n).known, n);
  const odd = lookupMaterial('mask', 'Sparkly Teal');
  assert.equal(odd.known, false);
  assert.equal(odd.value, SOLDER_MASK.green);
  assert.deepEqual(lookupMaterial('mask', '#336699').value.rgb, [0x33, 0x66, 0x99]);
});

test('rgba formatting', () => {
  assert.equal(rgba({ rgb: [1, 2, 3], opacity: 0.5 }), 'rgba(1,2,3,0.5)');
  assert.equal(rgba({ rgb: [1, 2, 3] }), 'rgba(1,2,3,1)');
});

test('3D surfaces: copper is a polished metal, the rest are dielectrics; values in range', () => {
  assert.equal(SURFACE.copper.metalness, 1);
  assert.ok(SURFACE.copper.roughness < 0.3);
  assert.ok(SURFACE.copper.envMapIntensity > SURFACE.soldermask.envMapIntensity);
  for (const k of ['soldermask', 'legend', 'substrate', 'holeWall', 'other']) assert.equal(SURFACE[k].metalness, 0, k);
  for (const [k, v] of Object.entries(SURFACE))
    for (const p of ['metalness', 'roughness']) assert.ok(v[p] >= 0 && v[p] <= 1, `${k}.${p}`);
});
