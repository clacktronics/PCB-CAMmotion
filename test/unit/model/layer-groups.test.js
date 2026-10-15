import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYER_GROUPS, DEFAULT_SHOW, groupOf, normaliseShow, shownLayers } from '../../../src/model/layer-groups.js';

const L = (id, type) => ({ id, role: { type } });
const layers = [
  L('silk', 'legend'),
  L('mask', 'soldermask'),
  L('paste', 'paste'),
  L('cu', 'copper'),
  L('pth', 'drill'),
  L('edge', 'profile'),
  L('fab', 'other'),
];

test('every toggle group has a default and a label', () => {
  assert.deepEqual(
    LAYER_GROUPS.map((g) => g.key),
    Object.keys(DEFAULT_SHOW),
  );
  assert.equal(DEFAULT_SHOW.paste, false);
  for (const g of LAYER_GROUPS) assert.ok(g.label);
});

test('groupOf: role type to toggle group; outline and other layers belong to none', () => {
  assert.equal(groupOf({ type: 'legend' }), 'legend');
  assert.equal(groupOf({ type: 'drill' }), 'drill');
  assert.equal(groupOf({ type: 'profile' }), null);
  assert.equal(groupOf(undefined), null);
});

test('shownLayers drops switched-off groups only, keeping list order', () => {
  assert.deepEqual(
    shownLayers(layers, DEFAULT_SHOW).map((l) => l.id),
    ['silk', 'mask', 'cu', 'pth', 'edge', 'fab'],
  );
  const off = { legend: false, soldermask: false, paste: true, copper: false, drill: false };
  assert.deepEqual(
    shownLayers(layers, off).map((l) => l.id),
    ['paste', 'edge', 'fab'],
  );
});

test('normaliseShow: defaults, keeps booleans, ignores junk, takes the old showPaste flag', () => {
  assert.deepEqual(normaliseShow(undefined), DEFAULT_SHOW);
  assert.deepEqual(normaliseShow({ copper: false, legend: 'no', bogus: true }), { ...DEFAULT_SHOW, copper: false });
  assert.equal(normaliseShow(undefined, true).paste, true);
  assert.equal(normaliseShow({ paste: false }, true).paste, false, 'show.paste wins');
});
