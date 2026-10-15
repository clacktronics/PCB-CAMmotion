import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStack3d,
  jobThicknesses,
  explodeOffsets,
  explodeGapMm,
  drillHoles,
  edgeWalls,
  DEFAULT_THICKNESS_MM,
} from '../../../src/model/stack3d.js';
import { near } from '../../helpers.js';

const img = { objects: [] };
const L = (id, type, side, extra = {}) => ({ id, role: { type, side, ...extra }, image: img });
const twoLayer = [
  L('F_Cu', 'copper', 'top'),
  L('B_Cu', 'copper', 'bottom'),
  L('F_Mask', 'soldermask', 'top'),
  L('B_Mask', 'soldermask', 'bottom'),
  L('F_Silk', 'legend', 'top'),
  L('F_Paste', 'paste', 'top'),
  L('Edge', 'profile', 'all'),
  L('PTH', 'drill', 'all', { plated: true }),
];
const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));

test('two-layer board: physical order top to bottom, centred on z = 0, board thickness kept', () => {
  const { items, boardThicknessMm } = buildStack3d(twoLayer, { boardThicknessMm: 1.6 });
  assert.deepEqual(
    items.map((i) => i.id),
    ['F_Silk', 'F_Mask', 'F_Cu', 'dielectric-1', 'B_Cu', 'B_Mask'],
  );
  for (let k = 1; k < items.length; k++) assert.ok(near(items[k].z1Mm, items[k - 1].z0Mm, 1e-9), 'touching');
  const s = byId(items);
  assert.ok(near(s.F_Cu.z1Mm - s.B_Cu.z0Mm, 1.6, 1e-9), 'copper to copper = board thickness');
  assert.ok(near(boardThicknessMm, 1.6, 1e-9));
  assert.ok(near(s.F_Silk.z1Mm, -s.B_Mask.z0Mm, 1e-9), 'centred');
  assert.ok(near(s.F_Cu.z1Mm - s.F_Cu.z0Mm, DEFAULT_THICKNESS_MM.copper, 1e-12));
  assert.equal(
    items.find((i) => i.type === 'profile' || i.type === 'drill'),
    undefined,
  );
});

test('paste is only in the stack when shown', () => {
  const ids = buildStack3d(twoLayer, {}, { showPaste: true }).items.map((i) => i.id);
  assert.equal(ids[0], 'F_Paste');
});

test('inner layers sit between dielectric cores, ordered by index', () => {
  const layers = [
    L('F_Cu', 'copper', 'top'),
    L('In2', 'copper', 'inner', { index: 2 }),
    L('In1', 'copper', 'inner', { index: 1 }),
    L('B_Cu', 'copper', 'bottom'),
  ];
  const { items } = buildStack3d(layers, { boardThicknessMm: 1.6 });
  assert.deepEqual(
    items.map((i) => i.id),
    ['F_Cu', 'dielectric-1', 'In1', 'dielectric-2', 'In2', 'dielectric-3', 'B_Cu'],
  );
  const d = items.filter((i) => i.type === 'dielectric').map((i) => i.z1Mm - i.z0Mm);
  assert.ok(
    d.every((t) => near(t, d[0], 1e-9)),
    'equal cores',
  );
});

test('a missing bottom copper file still leaves the copper plane and dielectric in place', () => {
  const { items } = buildStack3d([L('F_Cu', 'copper', 'top')], { boardThicknessMm: 1 });
  assert.deepEqual(
    items.map((i) => i.id),
    ['F_Cu', 'dielectric-1'],
  );
  assert.ok(near(items[1].z1Mm - items[1].z0Mm, 1 - 2 * DEFAULT_THICKNESS_MM.copper, 1e-9));
});

test('.gbrjob thicknesses are used when the copper count matches, ignored otherwise', () => {
  const job = [
    { type: 'Legend', thicknessMm: 0.01 },
    { type: 'SolderMask', thicknessMm: 0.03 },
    { type: 'Copper', thicknessMm: 0.07 },
    { type: 'Dielectric', thicknessMm: 0.5 },
    { type: 'Dielectric', thicknessMm: 0.6 },
    { type: 'Copper', thicknessMm: 0.035 },
    { type: 'SolderMask', thicknessMm: 0.025 },
  ];
  const t = jobThicknesses(job, 2);
  assert.deepEqual(t.copper, [0.07, 0.035]);
  assert.ok(near(t.dielectric[0], 1.1, 1e-12));
  assert.deepEqual(t.outer, { top: { legend: 0.01, soldermask: 0.03 }, bottom: { soldermask: 0.025 } });
  assert.equal(jobThicknesses(job, 4), null);
  assert.equal(jobThicknesses([], 2), null);

  const s = byId(buildStack3d(twoLayer, { layers: job }).items);
  assert.ok(near(s.F_Cu.z1Mm - s.F_Cu.z0Mm, 0.07, 1e-12));
  assert.ok(near(s['dielectric-1'].z1Mm - s['dielectric-1'].z0Mm, 1.1, 1e-12));
  assert.ok(near(s.F_Mask.z1Mm - s.F_Mask.z0Mm, 0.03, 1e-12));
});

test('explode: levels spread symmetrically from the middle; 0 keeps the board assembled', () => {
  const { items } = buildStack3d(twoLayer);
  assert.deepEqual(
    items.map((i) => i.level),
    [2.5, 1.5, 0.5, -0.5, -1.5, -2.5].map((v) => v + 0),
  );
  const none = explodeOffsets(items, 0, 10);
  assert.ok([...none.values()].every((v) => v === 0));
  const full = explodeOffsets(items, 1, 10);
  assert.equal(full.get('F_Silk'), 25);
  assert.equal(full.get('B_Mask'), -25);
  assert.equal(explodeOffsets(items, 7, 10).get('F_Silk'), 25, 'clamped to 1');
  // order is kept for any amount
  const half = explodeOffsets(items, 0.5, 4);
  const zs = items.map((i) => i.z1Mm + half.get(i.id));
  for (let k = 1; k < zs.length; k++) assert.ok(zs[k] < zs[k - 1]);
});

test('files sharing a role share a level', () => {
  const { items } = buildStack3d([...twoLayer, L('F_Cu_2', 'copper', 'top')]);
  const s = byId(items);
  assert.equal(s.F_Cu.level, s.F_Cu_2.level);
});

test('explode gap scales with the board and is bounded', () => {
  assert.equal(explodeGapMm(100, 50), 8);
  assert.equal(explodeGapMm(1, 1), 1.5);
  assert.equal(explodeGapMm(1000, 10), 25);
});

test('drill holes: round flashes with plating from the role; slots left out', () => {
  const ap = { kind: 'C', dia: 0.8 };
  const layers = [
    {
      role: { type: 'drill', plated: null },
      image: {
        objects: [
          { k: 'F', dark: true, ap, x: 1, y: 2 },
          { k: 'L', dark: true, ap, x1: 0, y1: 0, x2: 1, y2: 0 },
        ],
      },
    },
    { role: { type: 'drill', plated: false }, image: { objects: [{ k: 'F', dark: true, ap, x: 5, y: 6 }] } },
    { role: { type: 'copper' }, image: { objects: [{ k: 'F', dark: true, ap, x: 9, y: 9 }] } },
  ];
  assert.deepEqual(drillHoles(layers), [
    { x: 1, y: 2, diaMm: 0.8, plated: true },
    { x: 5, y: 6, diaMm: 0.8, plated: false },
  ]);
});

test('edge walls: two triangles per outline segment, normals pointing out of a CCW loop', () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  const { positions, normals } = edgeWalls([square], -0.8, 0.8);
  assert.equal(positions.length, 4 * 6 * 3);
  // first segment runs along y = 0: outward is -y
  assert.deepEqual([...normals.slice(0, 3)], [0, -1, 0]);
  const zs = new Set();
  for (let i = 2; i < positions.length; i += 3) zs.add(Math.round(positions[i] * 10) / 10);
  assert.deepEqual([...zs].sort(), [-0.8, 0.8]);
});
