import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER_GROUPS,
  DEFAULT_SHOW,
  groupOf,
  normaliseShow,
  shownLayers,
  copperSheets,
} from '../../../src/model/layer-groups.js';

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

test('copperSheets: top, inner layers numbered 1… in stack order, bottom; nothing else', () => {
  const cu = (id, side, index) => ({ id, name: `${id}.gbr`, role: { type: 'copper', side, index } });
  const sheets = copperSheets([
    { id: 'silk', name: 'silk', role: { type: 'legend', side: 'top' } },
    cu('F_Cu', 'top'),
    cu('In2_Cu', 'inner', 3),
    cu('In1_Cu', 'inner', 2),
    cu('B_Cu', 'bottom'),
    { id: 'drl', name: 'drl', role: { type: 'drill', side: 'all' } },
  ]);
  assert.deepEqual(
    sheets.map((s) => [s.label, s.id, s.side]),
    [
      ['T', 'F_Cu', 'top'],
      ['1', 'In1_Cu', 'inner'],
      ['2', 'In2_Cu', 'inner'],
      ['B', 'B_Cu', 'bottom'],
    ],
  );
  assert.equal(sheets[1].title, 'Inner copper 1: In1_Cu.gbr');
  assert.deepEqual(copperSheets(layers.filter((l) => l.role.type !== 'copper')), []);
});
